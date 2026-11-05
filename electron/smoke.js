'use strict';
/**
 * 冒烟测试：出实证截图 / 验证各条链路。
 * 只有设置了 SHOT_DIR 时才会被 main.js 调用，正式运行不加载。
 */

const { app, BrowserWindow, clipboard, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { sleep, PARTITION, CONF_ORIGIN, SIZE } = require('./config');

/**
 * @param {object} ctx 由 main.js 提供
 *   win, setQuitting(), getPhase(), getPortalEntryUrl(), openShareWindow(), quitApp()
 */
async function runSmoke(ctx, dir) {
  const win = ctx.win;

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
    ctx.openShareWindow('https://yunshixun.125339.com.cn/share/373645373?xlocation=PROD');
    await sleep(4000);
    console.log('[share-test] 第一个之后', list().length, JSON.stringify(list()));
    ctx.openShareWindow('https://yunshixun.125339.com.cn/share/379172520?xlocation=PROD');
    await sleep(4000);
    console.log('[share-test] 第二个之后', list().length, JSON.stringify(list()));
    ctx.setQuitting();
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
    ctx.quitApp();
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
    ctx.setQuitting();
    return app.quit();
  }

  if (process.env.SMOKE_CRASH) {
    await sleep(6000);
    console.log('[test] 触发未捕获异常和未处理拒绝');
    setTimeout(() => { throw new Error('测试用：主进程未捕获异常'); }, 10);
    setTimeout(() => { Promise.reject(new Error('测试用：未处理拒绝')); }, 200);
    await sleep(2500);
    ctx.setQuitting();
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
    ctx.setQuitting();
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
    ctx.setQuitting();
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
    ctx.setQuitting();
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
    ctx.setQuitting();
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
    ctx.setQuitting();
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
    ctx.setQuitting();
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
    ctx.setQuitting();
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
    ctx.setQuitting();
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
    ctx.setQuitting();
    return app.quit();
  }

  if (process.env.SMOKE_NET) {
    await sleep(5000);
    const status = await win.webContents.executeJavaScript(
      `fetch('/server/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.status)`,
    ).catch(() => -1);
    await sleep(2500);
    console.log('[test] 登录接口返回', status, '| 监听器未崩溃 | phase =', ctx.getPhase());
    return app.quit();
  }

  if (process.env.SMOKE_LOGOUTBTN) {
    await sleep(12000);
    const before = await win.webContents.executeJavaScript(`(() => {
      const styleOf = (root) => {
        const b = root && root.querySelector('button');
        if (!b) return null;
        const s = getComputedStyle(b);
        return { text: b.innerText, fontSize: s.fontSize, color: s.color,
                 fontWeight: s.fontWeight, fontFamily: s.fontFamily.split(',')[0] };
      };
      const lis = [...document.querySelectorAll('ul[class*="Navigation"] > li')];
      const webLi = lis.find((l) => /Web入会/.test(l.innerText || ''));
      return JSON.stringify({
        btn: !!document.getElementById('yunshixun-logout'),
        url: location.href.slice(0, 80),
        navLis: lis.map((li) => (li.innerText || '').replace(/\s+/g, '').slice(0, 10)),
        webStyle: styleOf(webLi),
        logoutStyle: styleOf(document.getElementById('yunshixun-logout')),
      }, null, 1);
    })()`).catch((e) => 'ERR ' + e.message);
    console.log('[test] 注入前:', before);
    // 点一下注入的按钮
    const clicked = await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('yunshixun-logout');
      if (!el) return 'no-btn';
      el.querySelector('span').click();
      return 'clicked';
    })()`).catch((e) => 'ERR ' + e.message);
    console.log('[test] 点击结果:', clicked);
    await sleep(4000);
    console.log('[test] 之后 → url =', win.webContents.getURL().slice(0, 90),
      '| phase =', ctx.getPhase(), '| 可见 =', win.isVisible());
    ctx.setQuitting();
    return app.quit();
  }

  if (process.env.SMOKE_LOGOUT) {
    await sleep(6000);
    ctx.setPhase('main'); // 模拟"已登录在门户"，让退出处理真的走一遍
    console.log('[test] 触发 /server/logout');
    await win.webContents.executeJavaScript(`fetch('/server/logout', { method: 'POST' })`).catch(() => {});
    await sleep(3000);
    const left = await win.webContents.executeJavaScript('localStorage.length').catch(() => -1);
    const cookies = await session.fromPartition(PARTITION).cookies.get({}).catch(() => []);
    console.log('[test] phase =', ctx.getPhase(), '| localStorage 条目 =', left, '| 125339 cookie =',
      cookies.filter((c) => c.domain.includes('125339')).length);
    await shot('logout-test.png');
    return app.quit();
  }


  if (process.env.SMOKE_LIVE) {
    await sleep(Number(process.env.SMOKE_LIVE) || 30000);
    await shot('live-flow.png');
    console.log('[live] url:', win.webContents.getURL().replace(/nonce=[^&]+/, 'nonce=<hidden>'));
    console.log('[live] phase:', ctx.getPhase(), '| portalEntryUrl:', !!ctx.getPortalEntryUrl());
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
    console.log('[flow] final phase =', ctx.getPhase(), 'url =', win.webContents.getURL());
    return app.quit();
  }

  ctx.setNoBounce();
  await sleep(12000);
  await shot('01-login.png');

  // 模拟"登录成功"：同一个窗口原地放大，直接进网页会议端
  ctx.setPhase('main');
  win.loadURL(`${CONF_ORIGIN}/webrtc/`).catch(() => {});
  await ctx.animateBounds(SIZE.main);
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

module.exports = { runSmoke };
