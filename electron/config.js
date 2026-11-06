'use strict';
/**
 * 配置与启动引导
 *
 * 这里做两件必须"尽早"完成的事：
 *   1. 决定用户数据目录并 app.setPath('userData')，否则 Electron 会先用默认目录；
 *   2. 挂上 Linux/Wayland 相关的命令行开关，必须在 app ready 之前。
 * 其余是各模块共用的常量和小工具。
 */

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// 用户数据目录
//   开发时用项目下的 ./userdata（绿色版）；打包后 asar 内不可写，改用系统标准目录。
//   APP_USER_DATA 可覆盖（测试用）。
// ---------------------------------------------------------------------------
const userDataDir = process.env.APP_USER_DATA
  ? path.resolve(process.env.APP_USER_DATA)
  : (app.isPackaged
    ? path.join(app.getPath('appData'), 'yunshixun-desktop')
    : path.join(__dirname, '..', 'userdata'));
try { fs.mkdirSync(userDataDir, { recursive: true }); } catch { /* 目录不可写时交给 Electron 报错 */ }
app.setPath('userData', userDataDir);

// ---------------------------------------------------------------------------
// 命令行开关（必须在 ready 前）
// ---------------------------------------------------------------------------
const IS_WAYLAND = process.platform === 'linux'
  && ((process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' || !!process.env.WAYLAND_DISPLAY);

if (process.platform === 'linux') {
  // 屏幕捕获所必需，缺了会表现为"调 getDisplayMedia 后直接挂住"
  app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
}

/**
 * Wayland 下必须用原生 Wayland 运行，屏幕捕获才能走 PipeWire/portal。
 * 走 XWayland 时 Chromium 会去抓 XWayland 的根窗口，结果就是挂死。
 * 想强制回 X11：OZONE=x11
 */
if (process.platform === 'linux' && IS_WAYLAND && process.env.OZONE !== 'x11') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}

// 打包后的 Linux 程序带不了 SUID sandbox（AppImage 里 chrome-sandbox 拿不到 root），
// 不关 sandbox 会直接启动失败
if (app.isPackaged && process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
}

/**
 * 压掉 Chromium 自己的 stderr 噪音（dbus / drm / NSS 那一堆 ERROR 行）。
 *   3 = 只输出 FATAL；想全看：CHROME_LOG=1
 */
if (process.env.CHROME_LOG !== '1') {
  app.commandLine.appendSwitch('log-level', '3');
}

/** NO_GPU=1：关掉硬件加速改走软件渲染 */
if (process.env.NO_GPU === '1') {
  app.disableHardwareAcceleration();
  console.log('[gpu] 已关闭硬件加速（软件渲染）');
}

// ---------------------------------------------------------------------------
// 站点与窗口常量
// ---------------------------------------------------------------------------
const CONF_ORIGIN = 'https://conf.125339.com.cn';
const WWW_ORIGIN = 'https://www.125339.com.cn';
const SHARE_BASE = 'https://yunshixun.125339.com.cn/share';
const PORTAL_URL = `${CONF_ORIGIN}/#/portal/`;
/** 门户入口模板：{} 处填 nonce（实测站点点的就是这条 URL） */
const PORTAL_TEMPLATE = `${CONF_ORIGIN}/?lang=zh-CN&customer=chinamobile&nonce={}&redirect=user_conference_list#/login`;

/** 'www' = 官网统一登录（常规流程，默认）；'conf' = 门户自带登录路由 */
const LOGIN_ORIGIN = process.env.LOGIN_ORIGIN === 'conf' ? 'conf' : 'www';
const LOGIN_URL = LOGIN_ORIGIN === 'www'
  ? `${WWW_ORIGIN}/auth/SignIn`
  : `${CONF_ORIGIN}/#/login`;

/** 登录窗固定尺寸；设成 null 则退回"按登录卡片自适应" */
const LOGIN_FIXED_SIZE = { width: 410, height: 424 };
const SIZE = {
  login: LOGIN_FIXED_SIZE || { width: 420, height: 560 },
  main: { width: 1280, height: 820 },
};
const LOGIN_PADDING = 24;
/** 自适应模式下，登录窗在"卡片 + padding"基础上再多留的高度 */
const LOGIN_EXTRA_HEIGHT = 30;
const RESIZE_MS = 320;

const PARTITION = 'persist:125339';
/** 允许的站点后缀：其它域名一律交给系统浏览器 */
const ALLOWED_SUFFIX = ['125339.com.cn', 'huaweicloud.com', 'dbankcloud.cn'];

// ---------------------------------------------------------------------------
// 环境变量开关
// ---------------------------------------------------------------------------
const SHOT_DIR = process.env.SHOT_DIR || '';
/** AUTO_ENTER=0 时只把窗口放大到工作台，菜单交给用户自己点（点完同样会被接住） */
const AUTO_ENTER = process.env.AUTO_ENTER !== '0';
/** REMEMBER=0 时不记住账号密码 */
const REMEMBER = process.env.REMEMBER !== '0';
/**
 * Dark Reader 主题参数（都可以用环境变量覆盖）
 *   brightness 0~100+，100 = 原始亮度，越小越暗
 *   contrast   0~100+，100 = 站点原对比度
 *   sepia      0~100，暖色
 *   mode       1 = 深色，0 = 暗淡（dimmed）
 */
const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
};
const DARK_THEME = {
  brightness: num(process.env.DARK_BRIGHTNESS, 100),
  contrast: num(process.env.DARK_CONTRAST, 90),
  sepia: num(process.env.DARK_SEPIA, 0),
  grayscale: num(process.env.DARK_GRAYSCALE, 0),
  mode: process.env.DARK_DIM === '1' ? 0 : 1,
};

/** DISABLE_TOKEN=1：启动时清掉本地登录态，强制走一次完整的登录流程（调试用） */
const DISABLE_TOKEN = process.env.DISABLE_TOKEN === '1';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
/** 只有这些 URL 才允许显示窗口；其余（中转页、跳转页）一律遮成"加载中" */
const URL_WHITELIST = ['r1.125339.com.cn', '/share/', 'conf.125339.com.cn', '/auth/SignIn'];

const isWhitelisted = (url) => {
  const u = String(url || '');
  return !!u && URL_WHITELIST.some((k) => u.includes(k));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isInternal = (url) => {
  try {
    const { hostname } = new URL(url);
    return ALLOWED_SUFFIX.some((s) => hostname === s || hostname.endsWith(`.${s}`));
  } catch {
    return false;
  }
};

module.exports = {
  userDataDir,
  IS_WAYLAND,
  CONF_ORIGIN,
  WWW_ORIGIN,
  SHARE_BASE,
  PORTAL_URL,
  PORTAL_TEMPLATE,
  LOGIN_ORIGIN,
  LOGIN_URL,
  LOGIN_FIXED_SIZE,
  SIZE,
  LOGIN_PADDING,
  LOGIN_EXTRA_HEIGHT,
  RESIZE_MS,
  PARTITION,
  ALLOWED_SUFFIX,
  SHOT_DIR,
  AUTO_ENTER,
  REMEMBER,
  DISABLE_TOKEN,
  DARK_THEME,
  sleep,
  isInternal,
  URL_WHITELIST,
  isWhitelisted,
};
