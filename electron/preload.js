'use strict';
/**
 * preload：做三件事，都只在自家域名下生效。
 *   1. 隐藏登录页「忘记密码」下面那两行提示
 *   2. 隐藏登录页页脚（帮助/隐私/条款 + 备案号那一条）
 *   3. 隐藏门户页脚（ChinaMobilePrivacy_ 打头的那个容器）
 *
 * 定位尽量不依赖 emotion 生成的哈希类名（css-xxxx），改用"文本 + 结构"判断，
 * 站点重新构建后不容易失效。
 */

const { ipcRenderer } = require('electron');

// 把页面里的 JS 错误转发给主进程（写进日志文件），避免只闪一下控制台就没了
(() => {
  let sent = 0;
  const report = (message) => {
    if (sent >= 20) return;   // 防止死循环刷屏
    sent += 1;
    try {
      ipcRenderer.send('log:renderer', { url: location.href, message: String(message).slice(0, 500) });
    } catch { /* 忽略 */ }
  };
  window.addEventListener('error', (e) => {
    const where = e && e.filename ? ` (${String(e.filename).split('/').pop()}:${e.lineno})` : '';
    report(`${(e && e.message) || 'error'}${where}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    report((r && (r.stack || r.message)) || r || 'unhandledrejection');
  });
})();

const CONF_ORIGIN = 'https://conf.125339.com.cn';
const WWW_ORIGIN = 'https://www.125339.com.cn';

function injectCss(css) {
  const add = () => {
    try {
      const style = document.createElement('style');
      style.setAttribute('data-yunshixun', 'hide');
      style.textContent = css;
      const host = document.head || document.documentElement || document.body;
      if (!host) return false;
      host.appendChild(style);
      return true;
    } catch {
      return false;
    }
  };
  // preload 执行时文档可能还没有 documentElement，退化到 DOMContentLoaded
  if (!add()) {
    document.addEventListener('DOMContentLoaded', add, { once: true });
  }
}

function hide(el) {
  if (el && el.style.display !== 'none') el.style.setProperty('display', 'none', 'important');
}

// ---------------------------------------------------------------------------
// 门户：页脚容器类名以 ChinaMobilePrivacy_ 开头（CSS Module，前缀稳定）
// ---------------------------------------------------------------------------
if (location.origin === CONF_ORIGIN) {
  injectCss(`
    /* 页脚 */
    [class*="ChinaMobilePrivacy_"] { display: none !important; }
    /* 右上角第 3 项：任务中心（含图标） */
    li:has(> [class*="TaskProgressPopover__"]),
    li:has([class*="TaskProgressPopover__"]) { display: none !important; }
    /* 右上角第 5 项：用户名 / 头像下拉 */
    li:has([class*="AvatarMenu__"]) { display: none !important; }
  `);
}

// ---------------------------------------------------------------------------
// 登录页：两行提示 + 页脚
// ---------------------------------------------------------------------------
function sweepLoginPage() {
  if (!location.pathname.startsWith('/auth/')) return;

  // ① 忘记密码下面两行：按文案判断，不依赖类名
  document.querySelectorAll('p').forEach((p) => {
    const text = (p.textContent || '').replace(/\s+/g, '');
    if (text.includes('申请账号请咨询') || text.includes('严禁上传、传输、存储、处理带有')) {
      hide(p);
    }
  });

  // ② 顶部 logo 区（左侧营销容器，按 CSS Module 的稳定前缀匹配）
  const brand = document.querySelector('[class*="leftContainer"]');
  if (brand) hide(brand);

  // ③ 顶部导航「首页 | APP下载」：从"首页"链接往上找，直到含有"APP下载"又不含输入框的那层
  const homeLink = [...document.querySelectorAll('a')].find((a) => (a.textContent || '').trim() === '首页');
  if (homeLink) {
    let el = homeLink.parentElement;
    while (el && el !== document.body) {
      if (!el.querySelector('input') && /APP下载/.test(el.textContent || '')) { hide(el); break; }
      el = el.parentElement;
    }
  }

  // ④ 页脚：同时包含"帮助"链接和备案号的 div，取最深的那个（= 页脚容器本身）
  const footers = [...document.querySelectorAll('div')].filter(
    (d) => d.querySelector('a[href*="/help"]') && /京ICP备/.test(d.textContent || ''),
  );
  hide(footers[footers.length - 1]);

  // ⑤ 量出卡片尺寸，交给主进程把窗口收成刚好包住它
  reportCardSize();
}

/** 找登录卡片：包含输入框和"忘记密码"的那层容器 */
function findCard() {
  const input = document.getElementById('mobile');
  if (!input) return null;
  let el = input.parentElement;
  while (el && el !== document.body) {
    if (el.querySelector('button') && /忘记密码/.test(el.textContent || '')) return el;
    el = el.parentElement;
  }
  return null;
}

function reportCardSize() {
  try {
    const card = findCard();
    if (!card) return;
    const rect = card.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) return;
    ipcRenderer.send('login:size', {
      width: Math.ceil(rect.width),
      height: Math.ceil(rect.height),
    });
  } catch {
    /* 量不到就保持默认窗口尺寸 */
  }
}

if (location.origin === WWW_ORIGIN) {
  let timer = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; sweepLoginPage(); }, 300);
  };

  const start = () => {
    sweepLoginPage();
    // SPA 会在登录/切页时重绘，用观察器兜住
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}


// ---------------------------------------------------------------------------
// 会议入会页（conf.125339.com.cn/webrtc/?customer=chinamobile...）：
// 页面已经填好会议信息时，「加入会议」按钮会变成可点，这里自动点它
// ---------------------------------------------------------------------------
function isConfJoinPage() {
  // 入会表单在 /webrtc/ 路径下；带不带 ?customer= 都可能出现
  return location.origin === CONF_ORIGIN && location.pathname.startsWith('/webrtc');
}

if (isConfJoinPage()) {
  // ysx:// 唤起时主进程会存好会议号；没有也不影响自动点击
  let joinInfo = null;
  try { joinInfo = ipcRenderer.sendSync('join:get'); } catch { joinInfo = null; }

  let prefilling = false;
  let userTyped = false;
  let clicked = false;
  let tries = 0;
  let warnedDisabled = false;

  // 用户自己动过表单就不再抢着点，避免"刚输完会议号就被带走"
  document.addEventListener('input', (e) => {
    if (prefilling) return;
    const id = e.target && e.target.id;
    if (id === 'confId' || id === 'nickName') userTyped = true;
  }, true);

  const setValue = (id, value) => {
    const el = document.getElementById(id);
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  // 按钮不一定是 <button>，antd/MUI 常用 <a> 或 [role=button]
  const findJoinBtn = () => {
    const cands = [...document.querySelectorAll('button, [role="button"], a')]
      .filter((el) => (el.innerText || '').replace(/\s+/g, '') === '加入会议');
    if (!cands.length) return null;
    // 有多个时取最内层那个（外层容器点了没反应）
    return cands.find((el) => !cands.includes(el.parentElement)) || cands[cands.length - 1];
  };

  const startedAt = Date.now();
  const DEADLINE_MS = 30000;
  let stopped = false;

  const attemptClick = () => {
    if (clicked || stopped) return;
    if (userTyped) {
      console.log('[auto-join] 检测到手动输入，放弃自动点击');
      clicked = true;
      return;
    }
    const btn = findJoinBtn();
    if (btn && !btn.disabled) {
      clicked = true;
      console.log('[auto-join] 「加入会议」按钮可用，自动点击');
      btn.click();
      setTimeout(() => {
        const again = findJoinBtn();
        if (again && !again.disabled && again.form && again.form.requestSubmit) {
          console.log('[auto-join] 按钮仍在，改用 form.requestSubmit()');
          again.form.requestSubmit();
        }
      }, 2500);
      return;
    }
    if (btn && btn.disabled && !warnedDisabled) {
      warnedDisabled = true;
      console.log('[auto-join] 按钮存在但处于禁用状态，等待表单填好');
    }
    if (Date.now() - startedAt > DEADLINE_MS) {
      stopped = true;
      const texts = [...document.querySelectorAll('button, [role="button"], a')]
        .map((el) => (el.innerText || '').replace(/\s+/g, '')).filter(Boolean).slice(0, 12);
      console.log('[auto-join] 30 秒内没找到可点的「加入会议」，页面按钮文案:', JSON.stringify(texts));
    }
  };

  // 先填 ysx 带来的会议号，再开始盯着按钮
  const fillThenJoin = (left = 25) => {
    if (!joinInfo || !joinInfo.confId) {
      attemptClick();
      return;
    }
    prefilling = true;
    const ok = setValue('confId', joinInfo.confId);
    setValue('nickName', joinInfo.name || '参会人');
    const cb = document.querySelector('.ant-checkbox-input');
    if (cb && !cb.checked) cb.click();
    prefilling = false;
    if (ok) {
      console.log('[ysx] 已填入会议号', joinInfo.confId);
      setTimeout(attemptClick, 400);
      return;
    }
    if (left > 0) setTimeout(() => fillThenJoin(left - 1), 300);
    else attemptClick();
  };

  const start = () => {
    fillThenJoin();
    setInterval(attemptClick, 300);   // 轮询：按钮出现/变可用都能抓到
    new MutationObserver(attemptClick)
      .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

// ---------------------------------------------------------------------------
// 会议分享页（yunshixun.125339.com.cn/share/xxx）：只保留卡片，隐藏「加入会议」
// ---------------------------------------------------------------------------
if (location.host === 'yunshixun.125339.com.cn') {
  // 顶部横幅图：宽屏是 bannerPC.xxx.webp，窄屏是 banner.xxx.webp（哈希会变，用前缀匹配）
  // 卡片内容很少，页面却有 80 多 px 溢出，直接把滚动条关掉
  injectCss(`
    img[src*="/static/media/bannerPC"],
    img[src*="/static/media/banner."] { display: none !important; }
    html, body { overflow: hidden !important; }
  `);
}

// ---------------------------------------------------------------------------
if (location.host === 'yunshixun.125339.com.cn' && location.pathname.startsWith('/share/')) {
  const sweepShare = () => {
    // ① 隐藏「加入会议」按钮
    document.querySelectorAll('button').forEach((btn) => {
      const text = (btn.innerText || '').replace(/\s+/g, '');
      if (text === '加入会议') hide(btn);
    });

    // ② 隐藏「没有安装移动会议客户端? 立即下载」整段
    //    注意"立即下载"实际是个 <button>（带 MuiTouchRipple），不能用 a/span/div 去找
    const cands = [...document.querySelectorAll('*')]
      .filter((el) => (el.textContent || '').trim() === '立即下载');
    const dl = cands[cands.length - 1];   // 取最深的那个，避免拿到外层容器
    if (dl) {
      let el = dl;
      let target = dl;
      while (el && el !== document.body) {
        if (/没有安装/.test(el.textContent || '')) { target = el; break; }
        el = el.parentElement;
      }
      hide(target);
    }
  };
  // ③ 自动点「网页入会」：这是进入网页会议的主入口
  let webJoinClicked = false;
  const autoWebJoin = (left = 40) => {
    if (webJoinClicked) return;
    const btn = [...document.querySelectorAll('button, [role="button"], a')]
      .find((el) => (el.innerText || '').replace(/\s+/g, '') === '网页入会');
    if (btn && !btn.disabled) {
      webJoinClicked = true;
      console.log('[share] 自动点击「网页入会」');
      btn.click();
      return;
    }
    if (left > 0) setTimeout(() => autoWebJoin(left - 1), 300);   // 最多等 12 秒
  };

  let shareTimer = null;
  const scheduleShare = () => {
    if (shareTimer) return;
    shareTimer = setTimeout(() => { shareTimer = null; sweepShare(); }, 200);
  };
  const startShare = () => {
    sweepShare();
    setTimeout(autoWebJoin, 1200);   // 等卡片渲染完再点，避免点空
    new MutationObserver(scheduleShare).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startShare, { once: true });
  } else {
    startShare();
  }
}

// ---------------------------------------------------------------------------
// 自动填充账号密码（等价于浏览器密码管理器的能力）
//   站点是 React 受控组件，直接改 value 不生效，必须走原生 setter + input 事件
// ---------------------------------------------------------------------------
function setInputValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillCredentials() {
  let cred = null;
  try { cred = ipcRenderer.sendSync('cred:get'); } catch { cred = null; }
  if (!cred || !cred.mobile || !cred.password) return;

  let tries = 0;
  const tick = () => {
    const mobile = document.getElementById('mobile');
    const password = document.getElementById('password');
    if (mobile && password) {
      if (!mobile.value) setInputValue(mobile, cred.mobile);
      if (!password.value) setInputValue(password, cred.password);
      // 焦点落到密码框，用户下一步就是拖滑块
      if (password.value) password.focus();
      return;
    }
    // React 水合可能重建输入框，重试几次
    if (tries++ < 20) setTimeout(tick, 200);
  };
  tick();
}

/** 点「登录」或回车时，把明文账号密码交给主进程加密保存 */
function captureCredentials() {
  const mobile = document.getElementById('mobile');
  const password = document.getElementById('password');
  if (!mobile || !password || !mobile.value || !password.value) return;
  ipcRenderer.send('cred:save', { mobile: mobile.value, password: password.value });
}

if (location.origin === WWW_ORIGIN) {
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (btn && /登\s*录/.test(btn.textContent || '')) captureCredentials();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') captureCredentials();
  }, true);

  const startFill = () => { if (location.pathname.startsWith('/auth/')) fillCredentials(); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startFill, { once: true });
  } else {
    startFill();
  }
}

// ---------------------------------------------------------------------------
// 登录态注入（当前流程用不到：门户靠 nonce 入口，这里保留兜底）
// ---------------------------------------------------------------------------
if (location.origin === CONF_ORIGIN) {
  try {
    const raw = ipcRenderer.sendSync('bridge:get');
    if (raw) {
      const data = JSON.parse(raw);
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string' && localStorage.getItem(key) === null) {
          localStorage.setItem(key, value);
        }
      }
    }
  } catch {
    /* 取不到就跳过，不影响页面本身 */
  }
}
