'use strict';
/**
 * 中国移动云视讯（125339）桌面客户端——可行性原型
 *
 * 窗口策略（"常规方法"）：
 *   小登录框 420×560 → 登录成功 → 同一个窗口原地放大到 1280×820 → 载入门户。
 *   不做"新开主窗口 + 关掉登录窗"，避免闪烁、位置跳变、任务栏图标闪现。
 *
 * 登录：https://www.125339.com.cn/auth/SignIn   （全站统一登录页）
 * 门户：https://conf.125339.com.cn/#/portal/    （另一个源）
 *
 * 登录态跨源：先按 Cookie 方案走（能通就什么都不用做）；
 *   若门户判定登录过期，则把 www 源的 localStorage 交给 preload 注入 conf 源，再试一次。
 */

const {
  app, BrowserWindow, session, shell, Menu, Tray, nativeImage,
  screen, ipcMain, safeStorage, dialog, clipboard,
} = require('electron');
const { installDisplayMediaHandler } = require('./display-media');
const { startClipboardWatch: startClipWatch } = require('./clipboard-watch');
const { parseYsxUrl, isYsxUrl } = require('./meeting-url');
const { registerYsxProtocol } = require('./ysx-protocol');
const { boundsFor, animateTo } = require('./window-utils');
const {
  saveCachedToken, readCachedToken, dropCachedToken,
  saveCredential, readCredential, dropCredential, saveState, readState,
} = require('./store');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const {
  IS_WAYLAND, CONF_ORIGIN, WWW_ORIGIN, SHARE_BASE, PORTAL_URL, PORTAL_TEMPLATE,
  LOGIN_URL, LOGIN_FIXED_SIZE, SIZE, LOGIN_PADDING, LOGIN_EXTRA_HEIGHT,
  RESIZE_MS, PARTITION, ALLOWED_SUFFIX, SHOT_DIR, AUTO_ENTER, REMEMBER, DISABLE_TOKEN,
  sleep, isInternal, userDataDir, isWhitelisted,
} = require('./config');
const { teeConsole, installCrashHandlers, logRendererError, getLogPath } = require('./logger');

// 越早越好：先接管未捕获异常（否则 Electron 会弹 GUI 错误框），再把 console 复制进文件
installCrashHandlers();
teeConsole(userDataDir);
if (getLogPath()) console.log('[log] 日志文件:', getLogPath());

// ---------------------------------------------------------------------------
// 运行状态
// ---------------------------------------------------------------------------
let win = null;
let tray = null;
/** 真正退出（托盘菜单/系统退出）时为 true；关窗口只是隐藏到后台 */
let isQuitting = false;
/** 'login' | 'main' */
let phase = 'login';
/** 交给 preload 的登录态（JSON），只由主进程写入 */
let pendingBridge = null;
/** 登录时从 www 抓到的完整登录态 */
let wwwStorage = null;
/** 门户不认的 token，避免"登录页 ↔ 门户"死循环 */
let ignoredToken = null;
/** 跨源注入只尝试一次 */
let bridgeAttempted = false;
let authLossBusy = false;
let pollTimer = null;
/** 窗口是否已经显示过（避免启动时闪一下登录框） */
let shown = false;
/** 从「会议服务 → 移动会议」捕获到的门户入口（带动态 nonce） */
let portalEntryUrl = null;
/** 登录成功后才落盘的待保存凭据（避免把输错的密码存下来） */
let pendingCredential = null;
/** 截图/调试时冻结自动跳转（NO_BOUNCE=1），方便拍到"登录已过期"这类中间态 */
let noBounce = !!process.env.NO_BOUNCE;

// ---------------------------------------------------------------------------
// 通用 webPreferences / 权限
// ---------------------------------------------------------------------------
const webPrefs = {
  partition: PARTITION,
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
  backgroundThrottling: false,
  // 页面里的 alert()/confirm()/prompt() 会阻塞渲染进程（表现为"无响应、点不动"），
  // 直接禁用：alert 变静默，confirm 返回 false，prompt 返回 null
  disableDialogs: true,
};

function installPermissionHandlers(ses) {
  const allow = new Set([
    'media', 'display-capture', 'fullscreen', 'notifications',
    'clipboard-read', 'clipboard-sanitized-write', 'pointerLock', 'audioCapture',
  ]);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (!isInternal(details.requestingUrl || wc.getURL())) return cb(false);
    cb(allow.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    if (!isInternal(requestingOrigin || '')) return false;
    return allow.has(permission);
  });
}

// ---------------------------------------------------------------------------
// 窗口尺寸（实现见 window-utils.js）
// ---------------------------------------------------------------------------
const targetBounds = (size) => boundsFor(win, size);
const animateBounds = (size, ms = RESIZE_MS) => animateTo(win, size, ms);


// ---------------------------------------------------------------------------
// 清理本地登录态（退出登录时用）
// ---------------------------------------------------------------------------
async function clearLoginState() {
  const ses = session.fromPartition(PARTITION);
  for (const origin of [WWW_ORIGIN, CONF_ORIGIN]) {
    try {
      await ses.clearStorageData({ origin, storages: ['localstorage', 'sessionstorage'] });
    } catch { /* 该源下没有数据时忽略 */ }
  }
  try {
    const cookies = await ses.cookies.get({});
    for (const cookie of cookies) {
      if (!cookie.domain.includes('125339')) continue;
      const url = `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path}`;
      await ses.cookies.remove(url, cookie.name).catch(() => {});
    }
  } catch { /* 忽略 */ }
  dropCachedToken();
  joinNameCache = '';            // 换账号后不要再用旧昵称
  saveState({ joinName: '' });
  wwwStorage = null;
  pendingBridge = null;
  portalEntryUrl = null;
  ignoredToken = null;
  bridgeAttempted = false;
}

/** 检测到退出登录：清 token、缩回登录窗 */
async function onLogoutDetected() {
  if (!win || win.isDestroyed() || phase === 'login') return;
  console.log('[logout] 检测到 /server/logout，清空本地登录态');
  await clearLoginState();
  if (!win || win.isDestroyed()) return;
  await gotoLogin();
}

// ---------------------------------------------------------------------------
// 启动策略：token 还有效就直接进会议，不显示登录框
// ---------------------------------------------------------------------------
/** 从 JWT 里读 exp（拿不到就按"未知"处理） */
function tokenExpiry(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return json && json.exp ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function showWindow() {
  if (!win || win.isDestroyed() || shown) return;
  shown = true;
  win.show();
}

/** 等新页面加载完再显示，避免"登录框被拉大"的闪一下 */
function showWhenLoaded() {
  if (!win || win.isDestroyed() || shown) return;
  const done = () => { clearTimeout(timer); showWindow(); };
  const timer = setTimeout(done, 4000);
  win.webContents.once('did-stop-loading', done);
}

/** 启动：先隐藏加载登录页，检查登录态，再决定显示什么 */
async function boot() {
  phase = 'login';
  win.setBounds(targetBounds(SIZE.login));

  // DISABLE_TOKEN=1：先清掉本地登录态（缓存 token + Cookie + localStorage），
  // 保证这次一定从登录页开始，而不是被旧会话直接带进门户
  if (DISABLE_TOKEN) {
    console.log('[boot] DISABLE_TOKEN=1：清空本地登录态，强制走登录流程');
    await clearLoginState();
  }

  win.loadURL(LOGIN_URL).catch(() => {});
  await new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve);
    setTimeout(resolve, 8000); // 网络慢也别卡死在隐藏状态
  });

  let token = await readToken();
  // localStorage 被清过、但缓存里还有有效 token：回填回去继续用
  if (!token && !DISABLE_TOKEN) {
    const cached = readCachedToken();
    const cachedExp = cached ? tokenExpiry(cached) : 0;
    if (cached && (cachedExp === 0 || cachedExp - Date.now() > 60 * 1000)) {
      console.log('[boot] localStorage 无 token，用缓存回填');
      await win.webContents.executeJavaScript(
        `localStorage.setItem('Authorization', ${JSON.stringify(cached)})`,
      ).catch(() => {});
      token = cached;
    }
  }
  const exp = token ? tokenExpiry(token) : 0;
  const valid = !!token && (exp === 0 || exp - Date.now() > 60 * 1000);

  if (valid) {
    console.log('[boot] 已有登录态，直接进会议（不显示登录框）');
    if (!readCachedToken() || readCachedToken() !== token) saveCachedToken(token); // 顺手补上缓存
    const resolved = await resolvePortalUrl();
    console.log('[resolve]', resolved && resolved.url
      ? `ok (via ${resolved.via || 'menu'}) ${resolved.url.replace(/nonce=[^&]+/, 'nonce=<hidden>')}`
      : JSON.stringify(resolved));

    if (resolved && resolved.url) {
      phase = 'main';
      showWhenLoaded();                      // 门户加载完再显示
      await growToMain({ goWorkbench: false });
      win.loadURL(resolved.url).catch(() => {});
      return;
    }
    // 登录态有效但算不出地址：走工作台 + 代点菜单
    showWhenLoaded();
    await growToMain();
    if (AUTO_ENTER) autoEnterPortal();
    return;
  }

  if (token) {
    ignoredToken = token;          // 过期 token，别让轮询把它当登录成功
    console.log('[boot] token 已过期，清空本地登录态');
    await clearLoginState();
  }
  console.log('[boot] 无有效登录态，显示登录框');
  await sleep(700); // 等 preload 把卡片尺寸报上来，避免先显示再缩窗口
  showWindow();
  startPolling();
}

// ---------------------------------------------------------------------------
// 登录态读取
// ---------------------------------------------------------------------------
async function readStorage() {
  if (!win || win.isDestroyed()) return null;
  const url = win.webContents.getURL();
  if (!url.startsWith(WWW_ORIGIN) && !url.startsWith(CONF_ORIGIN)) return null;
  try {
    return await win.webContents.executeJavaScript(`(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        out[k] = localStorage.getItem(k);
      }
      return out;
    })()`);
  } catch {
    return null;
  }
}

const readToken = () => (win && !win.isDestroyed()
  ? win.webContents.executeJavaScript('localStorage.getItem("Authorization") || ""').catch(() => '')
  : Promise.resolve(''));

// ---------------------------------------------------------------------------
// 布局切换
// ---------------------------------------------------------------------------
async function gotoLogin() {
  if (!win || win.isDestroyed()) return;
  const already = phase === 'login' && win.webContents.getURL().startsWith(LOGIN_URL);
  phase = 'login';
  console.log('[phase] login');
  stopPolling();
  win.setTitle('登录云视讯');
  win.setMaximizable(false);
  win.setFullScreenable(false);
  win.setMinimumSize(360, 320); // 登录框很小，必须放开最小限制
  pendingBridge = null;

  if (!already) win.loadURL(LOGIN_URL).catch(() => {});
  await animateBounds(SIZE.login, 260);
  win.setResizable(false); // 登录框不允许手动拉伸
  showWindow();
  startPolling();
}

/** 登录成功：同一个窗口原地放大（此时还停在 www 工作台） */
async function growToMain({ goWorkbench = true } = {}) {
  if (!win || win.isDestroyed()) return;
  phase = 'main';
  console.log('[phase] main');
  stopPolling();
  win.setTitle('云视讯');
  win.setMaximizable(true);
  win.setFullScreenable(true);

  await animateBounds(SIZE.main);
  applyMainMinSize();   // 动画结束后再收紧最小尺寸，避免中途先被夹到 1280x720
  saveState({ lastLoginAt: Date.now() });

  // 登录页不会自己跳走（例如带着旧 token 启动），补一次到工作台
  if (goWorkbench) {
    const here = win.webContents.getURL();
    if (here.includes('/auth/SignIn')) {
      win.loadURL(`${WWW_ORIGIN}/?status=login`).catch(() => {});
    }
  }
}

async function enterPortal(url = PORTAL_URL) {
  if (!win || win.isDestroyed() || phase === 'main') return;
  await growToMain();
  win.loadURL(url).catch(() => {});
}

const MAIN_MIN = { width: 1280, height: 720 };

function applyMainMinSize(target = win) {
  if (!target || target.isDestroyed()) return;
  const area = screen.getDisplayMatching(target.getBounds()).workArea;
  const minW = Math.min(MAIN_MIN.width, area.width - 20);
  const minH = Math.min(MAIN_MIN.height, area.height - 20);
  target.setMinimumSize(minW, minH);
  const b = target.getBounds();
  if (b.width < minW || b.height < minH) {
    const w = Math.max(b.width, minW);
    const h = Math.max(b.height, minH);
    target.setBounds({ ...b, width: w, height: h });
    console.log('[window] 窗口小于 1280x720，已放大到', w, 'x', h);
  }
}

/**
 * 门户会话（application.expire，约 30 分钟）过期后，用缓存的 www token 静默换一张新 nonce 重进。
 * 不弹登录框、不打扰用户；只有 www 的 10 小时 JWT 也失效时才真的回登录页。
 */
async function silentReauth() {
  if (DISABLE_TOKEN) {
    console.log('[reauth] DISABLE_TOKEN=1，跳过缓存 token 静默重进');
    return null;
  }
  const token = readCachedToken();
  if (!token) return null;
  const exp = tokenExpiry(token);
  if (exp && exp - Date.now() < 2 * 60 * 1000) return null; // 快过期了，重进也没意义

  const here = win && !win.isDestroyed() ? win.webContents.getURL() : '';
  let target = null;
  let hidden = null;

  if (here.startsWith(WWW_ORIGIN)) {
    target = win; // 已经在 www 上，直接借用
    const has = await win.webContents.executeJavaScript('!!localStorage.getItem("Authorization")')
      .catch(() => false);
    if (!has) {
      await win.webContents.executeJavaScript(
        `localStorage.setItem('Authorization', ${JSON.stringify(token)})`,
      ).catch(() => {});
    }
  } else {
    // 在门户页上，跨源读不到 www 的 localStorage，开个隐藏窗口去换 nonce
    hidden = new BrowserWindow({
      show: false,
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await hidden.loadURL(`${WWW_ORIGIN}/auth/SignIn`).catch(() => {});
    const has = await hidden.webContents.executeJavaScript('!!localStorage.getItem("Authorization")')
      .catch(() => false);
    if (!has) {
      await hidden.webContents.executeJavaScript(
        `localStorage.setItem('Authorization', ${JSON.stringify(token)})`,
      ).catch(() => {});
    }
    target = hidden;
  }

  const resolved = await resolvePortalUrl(target).catch(() => null);
  if (hidden && !hidden.isDestroyed()) hidden.destroy();
  return resolved && resolved.url ? resolved.url : null;
}

/** 门户不认我们的登录态：先尝试跨源注入，还不行就退回登录框 */
async function handleAuthLoss() {
  if (!win || win.isDestroyed() || phase !== 'main' || noBounce || authLossBusy) return;
  authLossBusy = true;
  console.log('[auth-loss] portal rejected session, bridgeAttempted =', bridgeAttempted);
  try {
    // 首选：www 的 JWT 还有效 → 换张 nonce 静默重进，用户无感
    if (reauthTries < 3) {
      const url = await silentReauth();
      if (url) {
        reauthTries++;
        console.log('[reauth] 门户会话过期，静默重进（第', reauthTries, '次）');
        phase = 'main';
        win.loadURL(url).catch(() => {});
        return;
      }
      console.log('[reauth] 静默重进失败，回登录页');
    }

    if (!bridgeAttempted && wwwStorage && wwwStorage.Authorization) {
      bridgeAttempted = true;
      pendingBridge = JSON.stringify(wwwStorage);
      phase = 'login'; // 复位布局状态，允许重新进入门户
      await enterPortal();
      return;
    }
    ignoredToken = wwwStorage?.Authorization || await readToken() || null;
    await gotoLogin();
  } finally {
    setTimeout(() => { authLossBusy = false; }, 400);
  }
}

// ---------------------------------------------------------------------------
// 登录轮询
// ---------------------------------------------------------------------------
function startPolling() {
  stopPolling();
  // 兜底通道：万一 /server/login 的响应码不是 200，或接口改了，仍然能靠 localStorage 发现登录
  pollTimer = setInterval(async () => {
    if (!win || win.isDestroyed() || phase !== 'login') return;
    const token = await readToken();
    if (!token || token === ignoredToken) return;
    handleLoginSuccess('poll');
  }, 700);
}

/** 等 localStorage 里出现 token（登录接口 200 后页面才写进去，会有几十毫秒延迟） */
async function waitForToken(ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const token = await readToken();
    if (token) return token;
    await sleep(150);
  }
  return '';
}

let loginBusy = false;
/** 登录刚成功时，拦住站点自己跳"官网工作台"的那一下，直接去门户 */
let suppressWorkbench = false;
let suppressTimer = null;
/** 静默重进的次数，防止死循环 */
let reauthTries = 0;

/** 登录成功：缓存 token → 算门户地址 → 放大窗口 → 进门户 */
async function handleLoginSuccess(source = 'poll') {
  if (loginBusy || !win || win.isDestroyed() || phase !== 'login') return;
  loginBusy = true;
  try {
    const token = await waitForToken(3000);
    if (!token || token === ignoredToken) return;

    stopPolling();
    reauthTries = 0;
    console.log('[login] 登录成功（来源:', source, '），token 长度', token.length);
    suppressWorkbench = true; // 兜底：轮询通道也要拦住工作台跳转
    showLoadingOverlay();
    saveCachedToken(token);
    if (pendingCredential) {
      saveCredential(pendingCredential.mobile, pendingCredential.password);
      pendingCredential = null;
    }

    // 此时页面还在 www，正好把整份登录态抓下来
    wwwStorage = await readStorage();
    bridgeAttempted = false;
    pendingBridge = null;

    // 登录态还在 www 源上，趁现在直接问接口要门户地址
    let resolved = await resolvePortalUrl();
    if (!resolved || !resolved.url) {
      // 刚跳转完时页面可能还在换文档，稍等再试一次
      await sleep(1500);
      const retry = await resolvePortalUrl();
      if (retry && retry.url) resolved = retry; else if (!resolved) resolved = retry;
    }
    console.log('[resolve]', resolved && resolved.url
      ? `ok (via ${resolved.via || 'menu'}) ${resolved.url.replace(/nonce=[^&]+/, 'nonce=<hidden>')}`
      : JSON.stringify(resolved));

    if (resolved && resolved.url) {
      await growToMain({ goWorkbench: false }); // 放大，但不跳工作台
      suppressWorkbench = true;
      win.loadURL(resolved.url).catch(() => {});
      setTimeout(() => { suppressWorkbench = false; }, 3000);
    } else {
      suppressWorkbench = false;                // 要走工作台了，放行
      await growToMain();
      if (AUTO_ENTER) autoEnterPortal();
    }
  } finally {
    loginBusy = false;
  }
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}



// ---------------------------------------------------------------------------
// 直接算出门户地址（不等页面渲染、不点菜单）
//   官网逻辑（逆向自 _app 的 tt 函数）：
//     1. 菜单接口返回一个带 "{}" 占位的地址模板
//     2. GET /server/mobile/nonce 拿到 nonce
//     3. template.replace("{}", nonce) → window.open(url)
//   我们在 www 源里用登录态把这两步跑一遍即可。
// ---------------------------------------------------------------------------
/** 登录成功到门户打开之间盖一层遮罩，避免用户看到中间过程 */
function showLoadingOverlay(target = win, text = '正在进入会议…') {
  if (!target || target.isDestroyed()) return;
  const bg = '#ffffff';
  const fg = '#1f2329';
  const js = `(() => {
    if (document.getElementById('yunshixun-loading')) return;
    if (!document.body) return;
    const d = document.createElement('div');
    d.id = 'yunshixun-loading';
    d.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;background:${bg};color:${fg};font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;');
    d.innerHTML = '<div style="width:26px;height:26px;border:3px solid rgba(128,128,128,.25);border-top-color:#1677ff;border-radius:50%;animation:yx-spin .8s linear infinite"></div><div>${text}</div><style>@keyframes yx-spin{to{transform:rotate(360deg)}}</style>';
    document.body.appendChild(d);
  })()`;
  target.webContents.executeJavaScript(js).catch(() => {});
}

/**
 * URL 白名单闸门：只有命中 config.URL_WHITELIST 的页面才允许显示。
 *
 * 关键在"先藏后显示"：站点的中转页在 did-navigate 时就渲染完了，
 * 事后再盖遮罩已经闪了一下。所以导航一开始（did-start-navigation）
 * 判断目标不是白名单就先 hide()，等落到白名单页面再 show()；
 * 如果 2 秒还困在非白名单页面，就显示出来并盖一层"加载中"。
 */
let gateHidden = false;
let gateStallTimer = null;
/** 纯工具窗口（取 nonce 之类），白名单闸门永远不要把它们显示出来 */
const helperWindows = new WeakSet();

function gateOnNavigationStart(target, url) {
  if (!target || target.isDestroyed()) return;
  if (helperWindows.has(target)) return;
  if (isWhitelisted(url)) {
    if (gateHidden) {
      gateHidden = false;
      if (gateStallTimer) { clearTimeout(gateStallTimer); gateStallTimer = null; }
      if (!target.isVisible()) target.show();
      console.log('[gate] 进入白名单页面，显示窗口');
    }
    return;
  }
  // 非白名单：先藏起来，避免中转页闪一下
  if (target.isVisible()) {
    target.hide();
    gateHidden = true;
    console.log('[gate] 非白名单页面，先隐藏窗口:', String(url).replace(/nonce=[^&]+/, 'nonce=<hidden>').slice(0, 90));
  }
  if (gateStallTimer) clearTimeout(gateStallTimer);
  gateStallTimer = setTimeout(() => {
    gateStallTimer = null;
    if (!target || target.isDestroyed()) return;
    const cur = target.webContents.getURL();
    if (isWhitelisted(cur)) return;
    // 一直停在非白名单页面：显示窗口 + 遮罩，至少让用户知道在加载
    gateHidden = false;
    if (!target.isVisible()) target.show();
    showLoadingOverlay(target, '加载中…');
    console.log('[gate] 已在非白名单页面停留，显示遮罩:', String(cur).slice(0, 90));
  }, 2000);
}

function applyUrlGate(target, url) {
  if (!target || target.isDestroyed()) return;
  if (helperWindows.has(target)) return;
  const cur = String(url || target.webContents.getURL() || '');
  if (isWhitelisted(cur)) {
    if (target !== win && !target.isVisible()) target.show();
    return;
  }
  // 子窗口还没显示过就继续藏着；已显示的补一层遮罩
  if (target.isVisible() || target === win) showLoadingOverlay(target, '加载中…');
}

async function resolvePortalUrl(target = win) {
  if (!target || target.isDestroyed()) return null;
  const src = `(async () => {
    const TPL = ${JSON.stringify(PORTAL_TEMPLATE)};
    const token = localStorage.getItem('Authorization') || '';
    if (!token) return { error: 'no-token' };
    const H = { Authorization: 'Bearer ' + token };
    const withTimeout = (p, ms) => Promise.race([
      p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
    ]);
    // 该站点的错误也是 200 + {code,msg}，不能只看 HTTP 状态
    const getJson = async (url, init) => {
      const r = await withTimeout(fetch(url, init || { headers: H }), 6000);
      if (!r.ok) return null;
      const raw = await r.text();
      if (!raw) return null;
      let j;
      try { j = JSON.parse(raw); } catch { j = raw; }
      if (j && typeof j === 'object' && j.code && j.code !== 'OK' && j.code !== 200) return null;
      return j;
    };
    const isNonce = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{16,}$/.test(v);

    // ① 取 nonce（带不带参数、GET/POST 都试一遍）
    let nonce = null;
    for (const [url, init] of [
      ['/server/mobile/nonce', { headers: H }],
      ['/mobile/nonce', { headers: H }],
      ['/server/mobile/nonce', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' }],
    ]) {
      let j = null;
      try { j = await getJson(url, init); } catch { continue; }
      if (!j) continue;
      let cand = null;
      if (typeof j === 'string' || typeof j === 'number') cand = String(j);
      else if (j && typeof j === 'object') {
        cand = j.data || j.nonce || j.token || Object.values(j).find((x) => typeof x === 'string');
        if (cand && typeof cand === 'object') cand = null;
      }
      if (isNonce(cand)) { nonce = cand; break; }
    }
    if (nonce) return { url: TPL.replace('{}', nonce), via: 'template' };

    // ② 兜底：从菜单里找带 {} 的地址模板（站点改了模板时还有救）
    let tpl = null;
    for (const api of ['/server/SC/home/menu', '/server/SC/home/menu/last', '/server/SC/menu']) {
      let j = null;
      try { j = await getJson(api); } catch { continue; }
      if (!j) continue;
      const stack = [j];
      while (stack.length && !tpl) {
        const v = stack.pop();
        if (typeof v === 'string') {
          if (v.includes('conf.125339.com.cn') && v.includes('{}')) tpl = v;
        } else if (v && typeof v === 'object') {
          for (const k of Object.keys(v)) stack.push(v[k]);
        }
      }
      if (tpl) break;
    }
    return { error: 'no-nonce', template: tpl || TPL };
  })()`;
  try {
    return await target.webContents.executeJavaScript(src);
  } catch (e) {
    return { error: 'eval-failed: ' + e.message };
  }
}

// ---------------------------------------------------------------------------
// 自动进入门户：点「会议服务 → 移动会议」，截住它弹出的动态地址
//   那个地址里的 nonce 是页面自己算的，我们不去伪造，只做"接手"
// ---------------------------------------------------------------------------
const rectJs = (text, scope) => `(() => {
  const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : 'document'};
  if (!root) return null;
  const hits = [...root.querySelectorAll('*')].filter(
    (e) => e.children.length === 0 && (e.innerText || '').trim() === ${JSON.stringify(text)},
  );
  const inView = hits.filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.x < innerWidth && r.y < innerHeight;
  });
  const el = inView[0] || hits[0];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
})()`;

async function realClick(rect) {
  if (!win || win.isDestroyed() || !rect) return;
  const x = Math.round(rect.x + rect.w / 2);
  const y = Math.round(rect.y + rect.h / 2);
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  await sleep(100);
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

async function autoEnterPortal() {
  if (!AUTO_ENTER) return;
  const exec = (src) => win.webContents.executeJavaScript(src).catch(() => null);
  for (let round = 0; round < 3 && !portalEntryUrl && phase === 'main'; round++) {
    await sleep(round === 0 ? 1500 : 1200);
    const trigger = await exec(rectJs('会议服务'));
    if (!trigger) continue;
    await realClick(trigger);
    await sleep(1200);
    const item = await exec(rectJs('移动会议', '[role="menu"], .MuiMenu-paper, .MuiPopover-paper'))
      || await exec(rectJs('移动会议'));
    if (!item) continue;
    await realClick(item);
    for (let k = 0; k < 8 && !portalEntryUrl; k++) await sleep(400);
  }
  if (!portalEntryUrl) {
    console.log('[auto] 没自动点到入口，请手动点「会议服务 → 移动会议」');
  }
}

// ---------------------------------------------------------------------------
// ysx:// 外部协议：让浏览器里的「点击进入客户端」直接唤起本壳子
//   YSX_PROTOCOL=0 可关闭注册
// ---------------------------------------------------------------------------
/** 待加入的会议（从 ysx:// 链接里解析出来，交给 preload 填表） */
let pendingJoin = null;
/** 上面这份数据只给这个 webContents 取（避免被其它页面偷走） */
let pendingJoinFor = null;

/**
 * 入会昵称：站点在 /v1/usg/dcs/member 里给了真实姓名，
 * 但要用它自己请求时带的 x-access-token。这里截获那对 token 后直接取名字。
 */
let cloudlinkToken = { access: '', auth: '' };
let joinNameCache = '';

function captureCloudlinkTokens(ses) {
  ses.webRequest.onBeforeSendHeaders({ urls: [`${CONF_ORIGIN}/v1/usg/*`] }, (details, callback) => {
    const h = details.requestHeaders || {};
    const access = h['X-Access-Token'] || h['x-access-token'];
    const auth = h['x-auth-token'] || h['X-Auth-Token'];
    if (access) cloudlinkToken.access = access;
    if (auth) cloudlinkToken.auth = auth;
    callback({ requestHeaders: h });
  });
}

async function resolveJoinName() {
  if (joinNameCache) return joinNameCache;
  const saved = readState().joinName;
  if (saved) {
    joinNameCache = String(saved);
    return joinNameCache;
  }

  const ses = session.fromPartition(PARTITION);
  // 站点的 token 和 member 接口都可能还没就绪，重试几次（每次 600ms，最多约 6 秒）
  for (let i = 0; i < 10; i += 1) {
    const { access, auth } = cloudlinkToken;
    if (access || auth) {
      try {
        const res = await ses.fetch(`${CONF_ORIGIN}/v1/usg/dcs/member`, {
          headers: { 'X-Access-Token': access, 'x-auth-token': auth, 'Content-Type': 'application/json' },
        });
        const json = await res.json().catch(() => null);
        const name = json && (json.name || json.englishName);
        if (name) {
          joinNameCache = String(name);
          saveState({ joinName: joinNameCache });
          console.log('[ysx] 入会昵称取自账号:', joinNameCache);
          return joinNameCache;
        }
      } catch { /* 下一轮再试 */ }
    }
    await sleep(600);
  }
  console.log('[ysx] 没拿到账号姓名，昵称用默认值');
  return '';
}

/** 在 www 源上用登录 token 换一个入会 nonce（带 nonce 的 webrtc 页才是"已登录入会"） */
const NONCE_JS = `(async () => {
  const token = localStorage.getItem('Authorization') || '';
  const H = token ? { Authorization: 'Bearer ' + token } : {};
  try {
    const r = await fetch('/server/mobile/nonce', { headers: H });
    if (!r.ok) return '';
    const raw = await r.text();
    try {
      const j = JSON.parse(raw);
      const v = j && typeof j === 'object'
        ? (j.data || j.nonce || Object.values(j).find((x) => typeof x === 'string'))
        : j;
      return typeof v === 'string' ? v : '';
    } catch {
      return String(raw).replace(/"/g, '').trim();
    }
  } catch {
    return '';
  }
})()`;

function parseNonce(raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  try {
    const j = JSON.parse(t);
    const v = j && typeof j === 'object'
      ? (j.data || j.nonce || Object.values(j).find((x) => typeof x === 'string'))
      : j;
    return typeof v === 'string' && /^[A-Za-z0-9_-]{16,}$/.test(v) ? v : '';
  } catch {
    const v = t.replace(/"/g, '').trim();
    return /^[A-Za-z0-9_-]{16,}$/.test(v) ? v : '';
  }
}

async function getJoinNonce() {
  const ses = session.fromPartition(PARTITION);

  // ① 优先用缓存的 www token 直接请求（不开任何窗口，最快）
  const cached = readCachedToken();
  if (cached) {
    try {
      const res = await ses.fetch(`${WWW_ORIGIN}/server/mobile/nonce`, {
        headers: { Authorization: `Bearer ${cached}` },
      });
      const nonce = parseNonce(await res.text());
      if (nonce) {
        console.log('[ysx] nonce 取自直连请求');
        return nonce;
      }
    } catch { /* 回退到窗口方案 */ }
  }

  // ② 回退：临时开一个隐藏窗口（token 存在 www 的 localStorage 里）
  const tmp = new BrowserWindow({ show: false, webPreferences: webPrefs });
  helperWindows.add(tmp);   // 只用来取 nonce，绝不能显示
  try {
    await tmp.loadURL(`${WWW_ORIGIN}/auth/SignIn`).catch(() => {});
    for (let i = 0; i < 6; i += 1) {
      const nonce = String(await tmp.webContents.executeJavaScript(NONCE_JS).catch(() => '') || '');
      if (nonce && /^[A-Za-z0-9_-]{16,}$/.test(nonce)) {
        console.log('[ysx] nonce 取自隐藏窗口');
        return nonce;
      }
      await sleep(500);
    }
    return '';
  } finally {
    if (!tmp.isDestroyed()) tmp.destroy();
  }
}

/** 打开会议窗口：优先用带 nonce 的"已登录入会"地址，取不到 nonce 再退回游客表单 */
async function openJoinWindow(confId) {
  const nonce = await getJoinNonce().catch(() => '');
  const joinName = (await resolveJoinName().catch(() => '')) || '参会人';
  if (!nonce) console.log('[ysx] 取不到 nonce（可能未登录），退回游客表单，可能被"仅授权用户"拦下');
  // 带 ?customer=...&nonce=xxx 才是已登录入会；纯 /webrtc/ 是游客表单，会被"仅允许授权用户"拦下
  const url = nonce
    ? `${CONF_ORIGIN}/webrtc/?customer=chinamobile&lang=zh-CN&nonce=${encodeURIComponent(nonce)}`
    : `${CONF_ORIGIN}/webrtc/`;
  console.log('[ysx] 入会地址', nonce ? '(带 nonce，已登录)' : '(无 nonce，游客)', '会议号', confId);

  if (joinWin && !joinWin.isDestroyed()) {
    const wcId = joinWin.webContents.id;
    pendingJoin = { confId, name: joinName };
    pendingJoinFor = wcId;
    joinWin.loadURL(url).catch(() => {});
    joinWin.show();
    joinWin.focus();
    return joinWin;
  }

  const area = screen.getPrimaryDisplay().workArea;
  joinWin = new BrowserWindow({
    width: Math.min(1280, area.width - 20),
    height: Math.min(800, area.height - 60),
    center: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    title: '加入会议',
    webPreferences: webPrefs,
  });
  const wcId = joinWin.webContents.id;
  pendingJoin = { confId, name: joinName };
  pendingJoinFor = wcId;
  joinWin.loadURL(url).catch(() => {});
  joinWin.on('closed', () => {
    if (pendingJoinFor === wcId) { pendingJoin = null; pendingJoinFor = null; }
    joinWin = null;
  });
  console.log('[ysx] 打开入会窗口 #' + wcId + '，昵称', joinName);
  return joinWin;
}
let joinWin = null;

function handleYsxArg(raw) {
  if (!isYsxUrl(raw)) return false;
  console.log('[ysx] 收到外部链接:', String(raw).replace(/(num=)(\d+)/, '$1$2').slice(0, 120));
  const parsed = parseYsxUrl(raw);
  if (!parsed) {
    console.log('[ysx] 没解析出会议号，忽略');
    return true;
  }
  showMainWindow();
  openJoinWindow(parsed.confId).catch((e) => console.log('[ysx] 打开入会窗口失败:', e.message));
  return true;
}

// ---------------------------------------------------------------------------
// 剪贴板监听（识别逻辑在 clipboard-watch.js）
// ---------------------------------------------------------------------------
let shareWin = null;

/**
 * 普通子窗口（会控助手 r1.125339.com.cn 这类）：按 host 复用。
 * 站点每次点按钮都会 window.open 一次，不复用就会越开越多。
 */
const childWins = new Map();   // host -> BrowserWindow

function openChildWindow(url, featureSize) {
  let host = url;
  try { host = new URL(url).host; } catch { /* 用原始字符串当 key */ }

  const exist = childWins.get(host);
  if (exist && !exist.isDestroyed()) {
    console.log('[child] 复用子窗口 #' + exist.id + '（' + host + '）');
    exist.loadURL(url).catch(() => {});
    if (exist.isMinimized()) exist.restore();
    exist.show();
    exist.focus();
    return exist;
  }

  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const width = Math.min(featureSize && featureSize.width ? featureSize.width : 1024, area.width - 40);
  const height = Math.min(featureSize && featureSize.height ? featureSize.height : 720, area.height - 80);
  const child = new BrowserWindow({
    width,
    height,
    center: true,
    show: false,          // 等页面进入白名单再显示，避免中转页闪一下
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: webPrefs,
  });
  childWins.set(host, child);
  child.on('closed', () => {
    if (childWins.get(host) === child) childWins.delete(host);
  });
  child.loadURL(url).catch(() => {});
  console.log('[child] 新建子窗口 #' + child.id + '（' + host + '）');
  return child;
}

/** 会议分享窗：全局只保留一个，新的会议复用同一个窗口 */
function openShareWindow(url) {
  if (shareWin && !shareWin.isDestroyed()) {
    console.log('[share] 复用分享窗口 #' + shareWin.id + '，换到', url.replace(/\?.*$/, '?…'));
    shareWin.loadURL(url).catch(() => {});
    if (shareWin.isMinimized()) shareWin.restore();
    shareWin.show();
    shareWin.focus();
    return shareWin;
  }
  const area = screen.getPrimaryDisplay().workArea;
  shareWin = new BrowserWindow({
    width: Math.min(420, area.width - 40),
    height: Math.min(640, area.height - 80),
    minWidth: 360,
    minHeight: 480,
    center: true,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    title: '移动会议 - 分享',
    webPreferences: webPrefs,
  });
  shareWin.loadURL(url).catch(() => {});
  shareWin.on('closed', () => { shareWin = null; });
  console.log('[share] 新建分享窗口 #' + shareWin.id);
  return shareWin;
}

let clipWatcher = null;

function startClipboardWatch() {
  clipWatcher = startClipWatch({
    onMeeting: (url) => openShareWindow(url),
    intervalMs: Number(process.env.CLIP_INTERVAL_MS || 1500),
  });
}

// ---------------------------------------------------------------------------
// 退出会议：会议页跳到 #/leave 就认为会议结束
//   LEAVE_ACTION=close（默认）窗口收进托盘并复位到门户
//   LEAVE_ACTION=portal      直接停在门户
//   LEAVE_ACTION=quit        整个应用退出
// ---------------------------------------------------------------------------
const LEAVE_ACTION = process.env.LEAVE_ACTION || 'close';
let leavingMeeting = false;
let lastLeaveAt = 0;
let lastErrorAt = 0;
/** 关闭确认弹窗是否正在显示，避免重复弹出 */
let closePrompting = false;

const isLeaveUrl = (url) => /\/webrtc\//.test(url) && /#\/leave\b/.test(url);
/** 会议页走到错误路由（#/errors、?error=...）就把窗口关掉 */
const isErrorUrl = (url) => /\/webrtc\//.test(url) && /error/i.test(url);
/** 会议分享页：yunshixun.125339.com.cn/share/<会议号>?xlocation=... */
const isShareUrl = (url) => /^https:\/\/yunshixun\.125339\.com\.cn\/share\//.test(url);

/** 会议界面是固定布局，窗口缩太小会把按钮挤掉；进出会议时切换最小尺寸 */

async function onMeetingLeft(targetWin, reason = 'leave') {
  // 注意：子窗口被销毁后还会再来一次导航事件，此时 fromWebContents 返回 null。
  // 这里绝不能回落到主窗，否则会把主窗口也一起关掉。
  const target = targetWin && !targetWin.isDestroyed() ? targetWin : null;
  if (!target) return;

  // 如果是弹出的子窗口（不是主窗），只关它，然后把主窗叫回来
  if (target !== win) {
    console.log('[meeting] 子窗口会议结束（' + reason + '），关闭该子窗口');
    target.destroy();
    showMainWindow();
    return;
  }

  // 防抖：did-navigate-in-page 和 did-stop-loading 会各触发一次
  if (leavingMeeting || Date.now() - lastLeaveAt < 2000) return;
  lastLeaveAt = Date.now();
  leavingMeeting = true;
  console.log('[meeting] 会议结束（' + reason + '），处理方式 →', LEAVE_ACTION);
  try {
    if (LEAVE_ACTION === 'quit') {
      isQuitting = true;
      app.quit();
      return;
    }
    if (LEAVE_ACTION === 'portal') {
      win.loadURL(PORTAL_URL).catch(() => {});
      return;
    }
    win.close();                       // 走关闭流程（下面会跳过"会议中"确认）
    await sleep(300);
    // 复位到门户，避免下次从托盘唤回时停在"已离开"页
    if (win && !win.isDestroyed()) win.loadURL(PORTAL_URL).catch(() => {});
  } finally {
    leavingMeeting = false;
  }
}

// ---------------------------------------------------------------------------
// 托盘：关闭窗口 = 收进后台；只有托盘菜单「退出」才真正结束进程
// ---------------------------------------------------------------------------
function showMainWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * 退出应用。
 * 普通 app.quit() 会等每个窗口的 renderer 正常关闭，遇到卡死的页面（会控页/会议页）
 * 就会"退出很久"，桌面上还会一直显示忙碌光标。这里直接 destroy 窗口，并兜底强杀。
 */
async function quitApp() {
  if (isQuitting) return;
  isQuitting = true;
  const graceful = process.env.QUIT_GRACEFUL === '1';
  // 托盘条目的注销是异步的：GNOME 的 appindicator 扩展会按名字去
  // /tmp/org.chromium.Chromium.XXXX 读图标，进程一消失它就找不到、卡住指针约 10 秒。
  // 所以先把窗口藏掉（用户看到"已退出"），再花一点时间让托盘干净注销。
  const graceMs = Number(process.env.QUIT_TRAY_GRACE_MS || 0);
  console.log('[quit] 开始退出，窗口数', BrowserWindow.getAllWindows().length,
    '| 模式', graceful ? 'graceful' : 'force', '| 托盘宽限', graceMs, 'ms');

  if (graceful) {
    app.quit();
    const t0 = setTimeout(() => { console.log('[quit] 超时，强制结束进程'); app.exit(0); }, 3000);
    if (t0.unref) t0.unref();
    return;
  }

  // ① 先让窗口从屏幕上消失（用户感知上等于立刻退出）
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.hide(); } catch { /* 已经没了 */ }
  }

  // ② 托盘已停用，这里不需要再等面板注销；graceMs 保留成配置项，默认 0
  if (graceMs > 0) await sleep(graceMs);

  // ③ 真正退出
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.destroy(); } catch { /* 已经没了 */ }
  }
  console.log('[quit] 结束进程');
  app.quit();
  const t = setTimeout(() => { app.exit(0); }, 1500);
  if (t.unref) t.unref();
}

// ---------------------------------------------------------------------------
// 托盘：已停用
//   GNOME 的 appindicator 扩展在进程退出后会去 /tmp/org.chromium.Chromium.XXXX
//   找托盘图标，找不到就反复重试，表现为"退出后鼠标转圈约 10 秒"。
//   这里把托盘整体关掉；需要恢复时把下面两个函数体还原即可。
// ---------------------------------------------------------------------------
function refreshTrayMenu() {
  // 已停用：不再构建托盘菜单
  return;
}

function createTray() {
  // 已停用：不创建托盘图标
  console.log('[tray] 托盘已停用（避免退出后鼠标转圈）');
  return;
}

// ---------------------------------------------------------------------------
// 主窗口（全程只有一个）
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: SIZE.login.width,
    height: SIZE.login.height,
    title: '登录云视讯',
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'), // 窗口/任务栏图标（512×512）
    show: false,
    webPreferences: webPrefs,
  });
  win.setBounds(targetBounds(SIZE.login));

  win.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();

    // 托盘已停用：关窗口就是退出程序（否则窗口消失后没有任何入口能唤回）。
    // 会议中先确认一下，避免误关导致会议中断。
    // 注意必须用异步对话框：close 事件里调 showMessageBoxSync 会阻塞主线程，
    // 表现就是"点关闭没反应"。
    const inMeeting = !leavingMeeting && /\/webrtc/i.test(win.webContents.getURL());
    if (!inMeeting) {
      quitApp();
      return;
    }

    if (closePrompting) return;
    closePrompting = true;
    dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['退出会议并关闭', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: '当前在会议中',
      detail: '关闭窗口会结束会议并退出程序。',
    }).then(({ response }) => {
      closePrompting = false;
      if (response === 0) quitApp();
    }).catch(() => { closePrompting = false; });
  });
  win.on('closed', () => { stopPolling(); shown = false; win = null; });

  // 系统弹"Is Not Responding"时这里会先触发，方便定位
  win.on('unresponsive', () => console.log('[perf] 窗口无响应 unresponsive'));
  win.on('responsive', () => console.log('[perf] 窗口恢复响应 responsive'));

  const onNavigated = (url) => {
    if (noBounce || phase !== 'main') return;
    const target = url || win.webContents.getURL();
    if (target.startsWith(`${WWW_ORIGIN}/auth/SignIn`) || /[#?&]\/?logout\b/.test(target)) {
      handleAuthLoss();
    }
  };
  win.webContents.on('did-navigate', (_e, url) => onNavigated(url));
  win.webContents.on('did-navigate-in-page', () => onNavigated());

  // 兜底：门户若原地显示"登录已过期"而不跳转，也要能退回登录框
  win.webContents.on('did-finish-load', () => {
    if (noBounce || phase !== 'main') return;
    setTimeout(async () => {
      if (!win || win.isDestroyed() || phase !== 'main' || authLossBusy) return;
      const text = await win.webContents.executeJavaScript('document.body.innerText').catch(() => '');
      if (/登录已过期|login expired|login status has expired/i.test(text)) handleAuthLoss();
    }, 1200);
  });

  boot()
    .then(() => {
      // 启动参数里的 ysx:// 要等门户起来再处理：
      // 入会昵称来自 /v1/usg/dcs/member，需要站点自己请求时带的 x-access-token
      const ysx = process.argv.find((a) => isYsxUrl(a));
      if (ysx) handleYsxArg(ysx);
    })
    .catch((e) => { console.error('[boot] failed', e); showWindow(); });
  return win;
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    console.log('[ysx] second-instance，argv =', JSON.stringify((argv || []).slice(-3)));
    showMainWindow();
    const ysx = (argv || []).find((a) => /^ysx:\/\//i.test(a));
    if (ysx) handleYsxArg(ysx);
    else console.log('[ysx] 这次启动的参数里没有 ysx:// 链接');
  });

  app.whenReady().then(() => {
    console.log('[env] ─────────────────────────────────────────');
    console.log('[env] 应用', app.getVersion(),
      '| electron', process.versions.electron,
      '| chromium', process.versions.chrome);
    console.log('[env] 系统', process.platform,
      '| 会话', process.env.XDG_SESSION_TYPE || '(unknown)',
      '| wayland', IS_WAYLAND ? '是' : '否',
      '| sandbox', process.argv.includes('--no-sandbox') ? '关闭' : '开启');
    console.log('[env] 数据目录', userDataDir);
    console.log('[env] ─────────────────────────────────────────');
    // Wayland 下 Chromium 的屏幕捕获依赖 PipeWire；wayland 会话里默认打开
    if (process.env.PIPEWIRE === '1' || (process.platform === 'linux' && IS_WAYLAND && process.env.PIPEWIRE !== '0')) {
      app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
      console.log('[env] 已启用 WebRTCPipeWireCapturer');
    }

    // Wayland 下屏幕共享依赖 xdg-desktop-portal，没跑起来就只能失败
    if (process.platform === 'linux') {
      execFile('pgrep', ['-af', 'libexec/xdg-desktop-portal'], (_err, stdout) => {
        const out = String(stdout || '').trim();
        if (out) {
          console.log('[env] xdg-desktop-portal 在跑:', out.split('\n').slice(0, 2).join(' | ').slice(0, 120));
        } else {
          console.warn('[portal] 没找到 xdg-desktop-portal 进程 → Wayland 下屏幕共享会失败');
          console.warn('[portal] 修复：sudo apt install xdg-desktop-portal xdg-desktop-portal-gnome，然后注销重登');
        }
      });
    }

    if (process.platform === 'win32') app.setAppUserModelId('com.chinamobile.yunshixun.shell');
    Menu.setApplicationMenu(null);

    const ses = session.fromPartition(PARTITION);
    ses.setUserAgent(ses.getUserAgent().replace(/\sElectron\/[\d.]+/i, ''));
    installPermissionHandlers(ses);
    installDisplayMediaHandler(ses);
    captureCloudlinkTokens(ses);

    // 监听登录请求：/server/login 返回 200 就认为登录成功，立刻缓存 token 并进门户
    ses.webRequest.onCompleted(
      { urls: [`${WWW_ORIGIN}/server/login*`] },
      (details, callback) => {
        try {
          // onCompleted 不保证给 callback（onBeforeRequest 才给），这里按需调用
          if (typeof callback === 'function') callback();
          if (details.statusCode !== 200) return;
          console.log('[net] /server/login -> 200');
          // 必须同步置位：页面拿到响应后会立刻 location.href 去工作台
          suppressWorkbench = true;
          clearTimeout(suppressTimer);
          suppressTimer = setTimeout(() => { suppressWorkbench = false; }, 10000);
          setTimeout(() => { handleLoginSuccess('login-api').catch(() => {}); }, 60);
        } catch (e) {
          console.error('[net] login listener error:', e.message);
        }
      },
    );

    // 监听退出登录请求：站点调 /server/logout 时，把本地 token 一起清掉
    ses.webRequest.onBeforeRequest(
      { urls: [`${WWW_ORIGIN}/server/logout*`] },
      (details, callback) => {
        try {
          if (typeof callback === 'function') callback({});
          // 让请求先飞出去，再清理，避免打断站点自己的退出流程
          setTimeout(() => { onLogoutDetected().catch(() => {}); }, 400);
        } catch (e) {
          console.error('[net] logout listener error:', e.message);
        }
      },
    );

    // preload 在文档开始前同步取登录态
    ipcMain.on('bridge:get', (event) => { event.returnValue = pendingBridge; });

    // 渲染进程报上来的 JS 错误
    ipcMain.on('log:renderer', (_event, payload) => logRendererError(payload));

    // ysx:// 唤起时把会议号交给 preload 填表
    ipcMain.on('join:get', (event) => {
      const sender = event.sender.id;
      const allowed = !!pendingJoin && (!pendingJoinFor || pendingJoinFor === sender);
      event.returnValue = allowed ? pendingJoin : null;
      if (allowed) {
        console.log('[ysx] 会议号已被窗口 #' + sender + ' 取走');
        pendingJoin = null;
        pendingJoinFor = null;
      }
    });

    // 自动填充用的账号密码
    ipcMain.on('cred:get', (event) => { event.returnValue = readCredential(); });
    ipcMain.on('cred:save', (_event, cred) => {
      if (!cred || typeof cred.mobile !== 'string' || typeof cred.password !== 'string') return;
      pendingCredential = cred; // 先记内存，登录成功再加密落盘
    });

    // 登录页把卡片尺寸报上来，窗口收成刚好包住卡片
    ipcMain.on('login:size', (_event, size) => {
      if (!win || win.isDestroyed() || phase !== 'login' || !size) return;
      if (LOGIN_FIXED_SIZE) return;   // 固定尺寸时忽略卡片测量值
      const width = Math.max(360, Math.min(600, size.width + LOGIN_PADDING * 2));
      const height = Math.max(320, Math.min(700, size.height + LOGIN_PADDING * 2 + LOGIN_EXTRA_HEIGHT));
      if (width === SIZE.login.width && height === SIZE.login.height) return;
      SIZE.login = { width, height };
      if (shown) {
        animateBounds(SIZE.login, 200).then(() => win && !win.isDestroyed() && win.setResizable(false));
      } else {
        win.setBounds(targetBounds(SIZE.login));
      }
    });

    // 全局导航日志：每次窗口打开/跳转的 URL 都打出来（nonce 打码）
    app.on('web-contents-created', (_e, contents) => {
      const fmt = (u) => String(u || '').replace(/nonce=[^&]+/, 'nonce=<hidden>');
      const who = () => {
        const w = BrowserWindow.fromWebContents(contents);
        return w ? `win#${w.id}${w === win ? '(main)' : ''}` : 'win#?';
      };
      // 同一 URL 短时间内重复出现只打一次（SPA 会连发好几个事件）
      let lastKey = '';
      let lastAt = 0;
      const logUrl = (kind, url) => {
        const u = fmt(url);
        const key = u;                       // 只按 URL 去重，避免 nav/inpage 重复刷
        if (key === lastKey && Date.now() - lastAt < 1500) return;
        lastKey = key;
        lastAt = Date.now();
        console.log(`[url] ${kind.padEnd(6)} ${who().padEnd(12)} ${u}`);
      };
      contents.on('did-start-navigation', (_e2, url, _inPlace, isMainFrame) => {
        if (!isMainFrame) return;
        const w0 = BrowserWindow.fromWebContents(contents);
        if (w0) gateOnNavigationStart(w0, url);
      });
      contents.on('did-navigate', (_e2, url) => logUrl('nav', url));
      contents.on('did-finish-load', () => {
        const w2 = BrowserWindow.fromWebContents(contents);
        if (w2) applyUrlGate(w2, contents.getURL());
      });
      contents.on('did-navigate-in-page', (_e2, url) => logUrl('inpage', url));
      contents.on('did-create-window', (child) => {
        console.log(`[url] window ${('win#' + child.id).padEnd(12)} ${fmt(child.webContents.getURL() || '(blank)')}`);
        // 站点可能用 window.open 指定超出屏幕的尺寸，导致标题栏的关闭按钮跑到屏幕外
        const area = screen.getDisplayMatching(child.getBounds()).workArea;
        const b = child.getBounds();
        const width = Math.min(b.width, area.width - 40);
        const height = Math.min(b.height, area.height - 80);
        if (width !== b.width || height !== b.height || b.x < area.x || b.y < area.y) {
          const x = Math.round(area.x + (area.width - width) / 2);
          const y = Math.round(area.y + (area.height - height) / 2);
          child.setBounds({ x, y, width, height });
          console.log(`[win] 子窗口 #${child.id} 尺寸 ${b.width}x${b.height} 超出屏幕，已改为 ${width}x${height} 并居中`);
        }
        child.setClosable(true);
        // 子窗口挂死：先记日志，超过阈值直接销毁，避免留下一个点不动的窗口
        let hungTimer = null;
        const hungLimit = Number(process.env.UNRESPONSIVE_CLOSE_MS || 15000);
        child.on('unresponsive', () => {
          console.log(`[win] 子窗口 #${child.id} 无响应（${hungLimit / 1000}s 后自动关闭）`);
          if (hungTimer) return;
          hungTimer = setTimeout(() => {
            if (!child.isDestroyed()) {
              console.log(`[win] 子窗口 #${child.id} 持续无响应，已强制关闭`);
              child.destroy();
            }
          }, hungLimit);
        });
        child.on('responsive', () => {
          if (hungTimer) {
            clearTimeout(hungTimer);
            hungTimer = null;
            console.log(`[win] 子窗口 #${child.id} 恢复响应`);
          }
        });
        // Ctrl+W 兜底关闭（有的站点窗口关不掉时用）
        child.webContents.on('before-input-event', (event, input) => {
          if (input.control && String(input.key).toLowerCase() === 'w') {
            event.preventDefault();
            console.log(`[win] Ctrl+W 关闭子窗口 #${child.id}`);
            child.destroy();
          }
        });
        child.on('resize', () => {
          const r = child.getBounds();
          console.log(`[win] 子窗口 #${child.id} 尺寸变为 ${r.width}x${r.height} at ${r.x},${r.y}`);
        });
      });
    });

    // 全局导航监听：任何窗口（含子窗口）跳到 #/leave 都算退出会议
    app.on('web-contents-created', (_e, contents) => {
      const check = (url) => {
        const target = url || contents.getURL();
        // 白名单闸门：非白名单页面不显示（主窗口盖遮罩，子窗口藏起来）
        const gw = BrowserWindow.fromWebContents(contents);
        if (gw) applyUrlGate(gw, target);
        // 会议页所在窗口不许小于 1280×720（含子窗口）
        if (/^https:\/\/conf\.125339\.com\.cn\/webrtc/.test(target)) {
          const mw = BrowserWindow.fromWebContents(contents);
          if (mw) applyMainMinSize(mw);
        }

        // 错误路由：直接关窗口（会议没进去，留着没意义）
        if (isErrorUrl(target)) {
          const ew = BrowserWindow.fromWebContents(contents);
          if (!ew) return;                       // 窗口已销毁，忽略
          if (Date.now() - lastErrorAt < 3000) return;
          lastErrorAt = Date.now();
          console.log('[meeting] 检测到错误路由，关闭窗口:', String(target).slice(0, 120));
          if (ew && ew !== win) {
            ew.destroy();
            showMainWindow();
          } else {
            onMeetingLeft(ew, 'error').catch(() => {});
          }
          return;
        }

        if (!isLeaveUrl(target)) return;
        const w = BrowserWindow.fromWebContents(contents);
        if (!w) return;                          // 拿不到窗口就不处理，避免误伤主窗
        onMeetingLeft(w, 'leave').catch(() => {});
      };
      contents.on('did-navigate', (_e2, url) => check(url));
      contents.on('did-navigate-in-page', (_e2, url) => check(url));
      contents.on('did-stop-loading', () => check());
    });

    // 站外链接交给系统浏览器
    app.on('web-contents-created', (_e, contents) => {
      contents.setWindowOpenHandler(({ url, features }) => {
        // 门户入口（会议服务→移动会议）：地址里带页面动态算出的 nonce，
        // 我们不改写、不伪造，只把它接过来在同一个窗口打开。
        if (url.startsWith(CONF_ORIGIN)) {
          portalEntryUrl = url;
          console.log('[portal-entry] captured:', url.replace(/nonce=[^&]+/, 'nonce=<hidden>'));
          if (win && !win.isDestroyed()) {
            (async () => {
              if (phase !== 'main') await growToMain();
              win.loadURL(url).catch(() => {});
            })();
          }
          return { action: 'deny' };
        }
        if (/^https?:/i.test(url)) {
          // 兜底：会议控制页在壳里反复卡死时，可以改成用系统浏览器打开
          if (process.env.R1_EXTERNAL === '1' && /^https:\/\/r1\.125339\.com\.cn\//.test(url)) {
            console.log('[window] 按 R1_EXTERNAL=1 用系统浏览器打开:', url.replace(/nonce=[^&]+/, 'nonce=<hidden>').slice(0, 100));
            shell.openExternal(url);
            return { action: 'deny' };
          }

          // 分享页单独开一个小窗，尺寸按卡片来
          if (isShareUrl(url)) {
            // 分享窗全局只允许一个：站点自己 window.open 的情况也接管过来
            openShareWindow(url);
            return { action: 'deny' };
          }
          if (isInternal(url)) {
            // 站点常用 window.open(url, '_blank', 'width=2400,height=1600') 指尺寸
            const feat = {};
            String(features || '').split(',').forEach((p) => {
              const [k, v] = p.split('=');
              if (k) feat[k.trim()] = String(v || '').trim();
            });
            openChildWindow(url, {
              width: Number(feat.width) || 1024,
              height: Number(feat.height) || 720,
            });
            return { action: 'deny' };   // 窗口由我们自己管，才能按 host 复用
          }
          shell.openExternal(url);
        }
        return { action: 'deny' };
      });
      contents.on('will-navigate', (event, url) => {
        // 非 http(s) 协议（如分享页的 ysx://）一律拦掉，避免弹系统外部协议对话框
        if (!/^https?:/i.test(url)) {
          event.preventDefault();
          console.log('[nav] 已忽略外部协议:', String(url).slice(0, 80));
          return;
        }
        if (!isInternal(url)) {
          event.preventDefault();
          shell.openExternal(url);
          return;
        }
        // 登录成功瞬间：站点会 location.href 到 www 工作台，拦掉，避免闪一下官网首页
        if (suppressWorkbench && /^https:\/\/www\.125339\.com\.cn\/.*[?&]status=login/.test(url)) {
          console.log('[nav] 已拦住官网工作台跳转');
          event.preventDefault();
        }
      });
      contents.on('render-process-gone', (_e2, details) => {
        console.log('[win] 渲染进程结束:', details.reason,
          '| exitCode =', details.exitCode, '| url =', String(contents.getURL()).slice(0, 80));
        if (details.reason !== 'clean-exit') contents.reload?.();
      });
      // 页面用 beforeunload 阻止关闭时，忽略它，否则点 X 会没反应
      contents.on('will-prevent-unload', (event) => {
        event.preventDefault();
        console.log('[win] 页面尝试阻止关闭（beforeunload），已忽略并允许关闭');
      });
      contents.on('did-fail-load', (_e2, code, desc, url, isMainFrame) => {
        if (isMainFrame) console.log('[win] 加载失败:', code, desc, String(url).slice(0, 80));
      });

      // 会议页的渲染进程报错很关键（HRTC / WebRTC 的错误都在这里）
      // Electron 45 起 console-message 只给事件对象（用旧的多参数签名会触发废弃警告）
      contents.on('console-message', (event) => {
        const lvl = event && event.level;
        const msg = event && event.message;
        const isWarnOrError = lvl === 'warning' || lvl === 'error'
          || (typeof lvl === 'number' && lvl >= 2);
        if (!isWarnOrError) return;
        const url = contents.getURL();
        if (process.env.LOG_RENDERER === '1' || url.includes('/webrtc') || url.includes('r1.125339.com.cn')) {
          const where = `${url.replace(/^https?:\/\//, '').slice(0, 60)}`;
          console.log(`[renderer @${where}]`, String(msg).slice(0, 300));
        }
      });
    });

    // 主线程卡顿探针：正常情况下这个间隔应该稳定在 1000ms 左右
    let lastTick = Date.now();
    setInterval(() => {
      const now = Date.now();
      const drift = now - lastTick - 1000;
      if (drift > 800) console.log('[perf] 主线程阻塞约', drift, 'ms');
      lastTick = now;
    }, 1000);

    createWindow();
    createTray();
    startClipboardWatch();
    registerYsxProtocol();
    if (SHOT_DIR) runSmoke(SHOT_DIR);
  });

  app.on('before-quit', () => { isQuitting = true; console.log('[quit] before-quit'); });
  app.on('will-quit', () => console.log('[quit] will-quit'));
  process.on('exit', (code) => console.log('[quit] process exit, code =', code));
  // 关窗只是隐藏，不会走到这里；真退出时再结束
  app.on('window-all-closed', () => { if (isQuitting) app.quit(); });
}

// ---------------------------------------------------------------------------
// 冒烟测试：给可行性报告出实证截图，正式运行不会走到
// ---------------------------------------------------------------------------
async function runSmoke(dir) {
  const shot = async (name) => {
    if (!win || win.isDestroyed()) return;
    const img = await win.capturePage();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), img.toPNG());
    const b = win.getBounds();
    console.log('[shot]', name, `${b.width}x${b.height}`, win.webContents.getURL());
  };

  if (process.env.SMOKE_SHARE) {
    await sleep(9000);
    const list = () => BrowserWindow.getAllWindows().map((w) => `${w.id}:${w.webContents.getURL().slice(0, 60)}`);
    console.log('[share-test] 初始窗口', list().length, JSON.stringify(list()));
    openShareWindow('https://yunshixun.125339.com.cn/share/373645373?xlocation=PROD');
    await sleep(4000);
    console.log('[share-test] 第一个之后', list().length, JSON.stringify(list()));
    openShareWindow('https://yunshixun.125339.com.cn/share/379172520?xlocation=PROD');
    await sleep(4000);
    console.log('[share-test] 第二个之后', list().length, JSON.stringify(list()));
    isQuitting = true;
    return app.quit();
  }

  if (process.env.SMOKE_QUIT) {
    await sleep(8000);
    // 造一个"卡死"的渲染进程（死循环），模拟会控页卡住时的退出
    const stuck = new BrowserWindow({ width: 600, height: 400, show: false, webPreferences: webPrefs });
    stuck.loadURL('data:text/html,<h1>x</h1>').then(() => {
      stuck.webContents.executeJavaScript('setTimeout(()=>{const t=Date.now();while(Date.now()-t<60000){}},100)').catch(() => {});
    }).catch(() => {});
    await sleep(1000);
    console.log('[quit] 触发退出（模拟托盘「关闭」）');
    quitApp();
    return undefined;
  }

  if (process.env.SMOKE_GATE) {
    await sleep(9000);
    const check = async (label) => {
      const url = win.webContents.getURL();
      const has = await win.webContents.executeJavaScript(
        `!!document.getElementById('yunshixun-loading')`,
      ).catch(() => 'ERR');
      console.log(`[gate] ${label} 遮罩=${has} url=${String(url).slice(0, 80)}`);
    };
    await check('门户');
    await win.loadURL('https://www.125339.com.cn/').catch(() => {});
    await sleep(5000);
    await check('官网首页(非白名单)');
    await win.loadURL('https://conf.125339.com.cn/#/portal/').catch(() => {});
    await sleep(5000);
    await check('回到门户');
    isQuitting = true;
    return app.quit();
  }

  if (process.env.SMOKE_CRASH) {
    await sleep(6000);
    console.log('[test] 触发未捕获异常和未处理拒绝');
    setTimeout(() => { throw new Error('测试用：主进程未捕获异常'); }, 10);
    setTimeout(() => { Promise.reject(new Error('测试用：未处理拒绝')); }, 200);
    await sleep(2500);
    isQuitting = true;
    return app.quit();
  }

  if (process.env.SMOKE_CLIP) {
    await sleep(6000);
    const sample1 = `曾亮邀请您参加移动会议
会议主题：湖南磐基周例会
会议时间：2026-11-02  10:00  (GMT+08:00) 北京、重庆、香港特别行政区、乌鲁木齐、台北
移动会议：379172520
参会链接：https://yunshixun.125339.com.cn/share/379172520?xlocation=PROD
点击链接，进入H5邀请页面。`;
    const sample2 = `张三邀请您参加移动会议
会议主题：周会
移动会议：379 172 521`;
    const sample3 = `这是一段普通文本，不是会议。`;
    await clipboard.writeText(sample1.trim());
    await sleep(2500);
    await clipboard.writeText(sample2.trim());
    await sleep(2500);
    await clipboard.writeText(sample3.trim());
    await sleep(2500);
    const wins = BrowserWindow.getAllWindows().map((w) => ({ id: w.id, url: w.webContents.getURL().slice(0, 90) }));
    console.log('[test] 窗口数 =', wins.length);
    console.log('[test] 窗口列表 =', JSON.stringify(wins, null, 1));
    isQuitting = true;
    return app.quit();
  }

  if (process.env.SMOKE_UNLOAD) {
    await sleep(11000);
    const child = new BrowserWindow({ width: 700, height: 500, show: true,
      webPreferences: webPrefs });
    await child.loadURL('data:text/html,<h1>child</h1><script>window.onbeforeunload=function(){return "stay"}</script>').catch(() => {});
    await sleep(1200);
    console.log('[test] 子窗已建:', child.id, '| destroyed =', child.isDestroyed());
    child.close();
    await sleep(1500);
    console.log('[test] 调用 close() 之后 → destroyed =', child.isDestroyed());
    isQuitting = true;
    return app.quit();
  }

  if (process.env.SMOKE_CHILD) {
    await sleep(11000);
    console.log('[test] 主窗 =', win.getBounds().width + 'x' + win.getBounds().height);
    await win.webContents.executeJavaScript(
      `window.open('https://r1.125339.com.cn/confportal/', '_blank', 'width=2400,height=1600')`,
    ).catch(() => {});
    await sleep(4000);
    // 再开一次同 host 的页面，验证复用而不是新建
    await win.webContents.executeJavaScript(
      `window.open('https://r1.125339.com.cn/confportal/#/conference/123', '_blank', 'width=1200,height=800')`,
    ).catch(() => {});
    await sleep(4000);
    for (const w of BrowserWindow.getAllWindows()) {
      const b = w.getBounds();
      console.log('[test] 窗口', w.id, b.width + 'x' + b.height, 'at', b.x + ',' + b.y,
        '| 可关闭 =', w.isClosable(), '| url =', w.webContents.getURL().slice(0, 60));
    }
    isQuitting = true;
    return app.quit();
  }

  if (process.env.SMOKE_SUBWIN) {
    await sleep(11000);
    console.log('[test] 主窗可见 =', win.isVisible());
    const child = new BrowserWindow({ width: 900, height: 700, show: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true } });
    await child.loadURL('https://conf.125339.com.cn/webrtc/?customer=chinamobile&lang=zh-CN#/leave').catch(() => {});
    await sleep(4000);
    console.log('[test] 子窗已关 =', child.isDestroyed(),
      '| 主窗存活 =', !!win && !win.isDestroyed(), '| 主窗可见 =', !!win && win.isVisible());
    isQuitting = true;
    return app.quit();
  }

  if (process.env.SMOKE_ERR) {
    await sleep(11000);
    await win.loadURL('https://conf.125339.com.cn/webrtc/?customer=chinamobile&lang=zh-CN#/login').catch(() => {});
    await sleep(4000);
    console.log('[test] 会议页 → 可见 =', win.isVisible(), '| 标题栏模式 = 普通窗口');
    await win.webContents.executeJavaScript(`location.hash = '#/errors?key=USG.000000004'`).catch(() => {});
    await sleep(4000);
    console.log('[test] 错误路由后 → 可见 =', win.isVisible(),
      '| url =', win.webContents.getURL().slice(0, 90));
    isQuitting = true;
    return app.quit();
  }

  if (process.env.SMOKE_MIN) {
    await sleep(11000);
    // 先放开最小限制把窗口缩小，再跳会议页，验证会不会被拉回 1280x720
    win.setMinimumSize(360, 320);
    win.setBounds({ ...win.getBounds(), width: 800, height: 600 });
    await sleep(800);
    console.log('[test] 缩小后 =', win.getBounds().width + 'x' + win.getBounds().height,
      '| min =', win.getMinimumSize().join('x'));
    await win.loadURL('https://conf.125339.com.cn/webrtc/?customer=chinamobile&lang=zh-CN#/joinNow?confId=1').catch(() => {});
    await sleep(4000);
    const b = win.getBounds();
    console.log('[test] 跳到会议页后 =', b.width + 'x' + b.height, '| min =', win.getMinimumSize().join('x'));
    isQuitting = true;
    return app.quit();
  }

  if (process.env.SMOKE_MEETING) {
    await sleep(11000);
    const before = win.getBounds();
    console.log('[test] 入会前窗口 =', before.width + 'x' + before.height, '| min =', win.getMinimumSize().join('x'));
    await win.loadURL('https://conf.125339.com.cn/webrtc/?customer=chinamobile&lang=zh-CN#/joinNow?confId=375321575&name=test').catch(() => {});
    await sleep(6000);
    const after = win.getBounds();
    console.log('[test] 入会后窗口 =', after.width + 'x' + after.height, '| min =', win.getMinimumSize().join('x'));
    await win.webContents.executeJavaScript(`location.hash = '#/leave'`).catch(() => {});
    await sleep(4000);
    console.log('[test] 离会后 min =', win.getMinimumSize().join('x'), '| 可见 =', win.isVisible());
    isQuitting = true;
    return app.quit();
  }

  if (process.env.SMOKE_LEAVE) {
    await sleep(12000);
    console.log('[test] 当前 url =', win.webContents.getURL());
    // 先像真实入会一样进会议室页，再用 hash 跳转到离开页（SPA 内部导航）
    await win.loadURL('https://conf.125339.com.cn/webrtc/?customer=chinamobile&lang=zh-CN#/joinNow?confId=375321575&name=test').catch(() => {});
    await sleep(5000);
    console.log('[test] 会议室页 url =', win.webContents.getURL());
    await win.webContents.executeJavaScript(`location.hash = '#/leave'`).catch(() => {});
    await sleep(5000);
    console.log('[test] 之后 → 窗口可见:', win.isVisible(), '| url =', win.webContents.getURL());
    isQuitting = true;
    return app.quit();
  }

  if (process.env.SMOKE_BLOCK) {
    await sleep(6000);
    console.log('[test] 初始 url =', win.webContents.getURL());
    suppressWorkbench = true;
    await win.webContents.executeJavaScript(`location.href = 'https://www.125339.com.cn/?status=login'`).catch(() => {});
    await sleep(3000);
    console.log('[test] 拦截生效 → url =', win.webContents.getURL());
    suppressWorkbench = false;
    await win.webContents.executeJavaScript(`location.href = 'https://www.125339.com.cn/?status=login'`).catch(() => {});
    await sleep(3500);
    console.log('[test] 放行对照 → url =', win.webContents.getURL());
    return app.quit();
  }

  if (process.env.SMOKE_REAUTH) {
    await sleep(13000);
    console.log('[test] 进门户后 url =', win.webContents.getURL());
    // 手动制造"门户会话过期"：删掉 application 标记再重载
    await win.webContents.executeJavaScript(`localStorage.removeItem('application')`).catch(() => {});
    win.webContents.reload();
    await sleep(14000);
    console.log('[test] 重载后 url =', win.webContents.getURL());
    return app.quit();
  }

  if (process.env.SMOKE_TRAY) {
    await sleep(7000);
    win.close();
    await sleep(1200);
    console.log('[test] 关窗后 → 窗口存活:', !!win && !win.isDestroyed(),
      '| 是否可见:', !!win && win.isVisible(), '| 托盘:', !!tray);
    isQuitting = true;
    return app.quit();
  }

  if (process.env.SMOKE_NET) {
    await sleep(5000);
    const status = await win.webContents.executeJavaScript(
      `fetch('/server/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.status)`,
    ).catch(() => -1);
    await sleep(2500);
    console.log('[test] 登录接口返回', status, '| 监听器未崩溃 | phase =', phase);
    return app.quit();
  }

  if (process.env.SMOKE_LOGOUT) {
    await sleep(6000);
    phase = 'main'; // 模拟"已登录在门户"，让退出处理真的走一遍
    console.log('[test] 触发 /server/logout');
    await win.webContents.executeJavaScript(`fetch('/server/logout', { method: 'POST' })`).catch(() => {});
    await sleep(3000);
    const left = await win.webContents.executeJavaScript('localStorage.length').catch(() => -1);
    const cookies = await session.fromPartition(PARTITION).cookies.get({}).catch(() => []);
    console.log('[test] phase =', phase, '| localStorage 条目 =', left, '| 125339 cookie =',
      cookies.filter((c) => c.domain.includes('125339')).length);
    await shot('logout-test.png');
    return app.quit();
  }


  if (process.env.SMOKE_LIVE) {
    await sleep(Number(process.env.SMOKE_LIVE) || 30000);
    await shot('live-flow.png');
    console.log('[live] url:', win.webContents.getURL().replace(/nonce=[^&]+/, 'nonce=<hidden>'));
    console.log('[live] phase:', phase, 'portalEntryUrl:', !!portalEntryUrl);
    for (const w of BrowserWindow.getAllWindows()) {
      if (w === win || w.isDestroyed()) continue;
      const b = w.getBounds();
      const text = await w.webContents.executeJavaScript(
        '(document.body.innerText||"").replace(/\\s+/g," ").slice(0,120)',
      ).catch(() => '(读不到)');
      console.log(`[live] 其它窗口 #${w.id} ${b.width}x${b.height} 可见=${w.isVisible()} url=${w.webContents.getURL().slice(0, 90)}`);
      console.log(`[live]   内容: ${text}`);
    }
    return app.quit();
  }

  if (process.env.SMOKE_FLOW) {
    // 模拟"用户登录成功"：往登录页写一个假 token，观察状态机怎么走
    await sleep(7000);
    await win.webContents.executeJavaScript('localStorage.setItem("Authorization", "FAKE_TOKEN_FOR_FLOW_TEST")');
    await sleep(14000);
    await shot('flow-after-fake-login.png');
    console.log('[flow] final phase =', phase, 'url =', win.webContents.getURL());
    return app.quit();
  }

  noBounce = true;
  await sleep(12000);
  await shot('01-login.png');

  // 模拟"登录成功"：同一个窗口原地放大，直接进网页会议端
  phase = 'main';
  win.loadURL(`${CONF_ORIGIN}/webrtc/`).catch(() => {});
  await animateBounds(SIZE.main);
  await sleep(7000);
  await shot('02-main-1280x820.png');

  const caps = await win.webContents.executeJavaScript(`(() => ({
    rtc: typeof window.RTCPeerConnection,
    getUserMedia: typeof navigator.mediaDevices?.getUserMedia,
    getDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia,
    ua: navigator.userAgent,
  }))()`).catch((e) => ({ error: String(e) }));
  console.log('[capability]', JSON.stringify(caps));
  app.quit();
}
