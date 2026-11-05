'use strict';
/**
 * 日志与崩溃捕获
 *
 * 做三件事：
 *   1. 把 console.* 同时写进文件（userdata/app.log），方便出问题后直接发一个文件；
 *   2. 接管 uncaughtException / unhandledRejection ——
 *      Electron 默认会为主进程未捕获异常弹一个 GUI 错误框，装了监听就不再弹，只记日志；
 *   3. 给渲染进程留一个上报入口（preload 里的 window.onerror 转发过来）。
 *
 *   LOG_FILE=0 可只输出到 stdout
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 5 * 1024 * 1024;
let stream = null;
let logPath = '';

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 终端用：12:34:56.789 */
const clock = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

/** 文件用：2026-11-04 12:34:56.789 */
const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock()}`;
};

const LEVEL = { log: 'INF', warn: 'WRN', error: 'ERR' };

const fmt = (v) => {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  try { return JSON.stringify(v); } catch { return String(v); }
};

function rotate(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch { /* 首次写，没有旧文件 */ }
}

/** 把 console.log/warn/error 复制一份到文件；重复调用只生效一次 */
let teed = false;
function teeConsole(dir) {
  if (process.env.LOG_FILE === '0') return '';
  try {
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'app.log');
    rotate(logPath);
    stream = fs.createWriteStream(logPath, { flags: 'a' });
    stream.on('error', () => { stream = null; });
    if (teed) return logPath;
    teed = true;
    for (const level of ['log', 'warn', 'error']) {
      const orig = console[level].bind(console);
      console[level] = (...args) => {
        const msg = args.map(fmt).join(' ');
        // 终端也带时间，多个进程的日志混在一起时能对上先后
        orig(`${clock()} ${msg}`);
        if (!stream) return;
        try { stream.write(`${stamp()} ${LEVEL[level]} ${msg}\n`); } catch { /* 忽略 */ }
      };
    }
  } catch { /* 目录不可写就不落盘 */ }
  return logPath;
}

/** 接管未捕获异常：不弹 GUI 错误框，只写日志 */
function installCrashHandlers() {
  process.on('uncaughtException', (err) => {
    console.error('[crash] 主进程未捕获异常:', err && err.stack ? err.stack : err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[crash] 未处理的 Promise 拒绝:', reason && reason.stack ? reason.stack : reason);
  });
}

/** 渲染进程里抓到的错误（preload 转发过来） */
function logRendererError(payload) {
  const where = payload && payload.url ? String(payload.url).slice(0, 80) : '?';
  const msg = payload && payload.message ? String(payload.message).slice(0, 300) : '(无消息)';
  console.error(`[renderer-error @${where}] ${msg}`);
}

const getLogPath = () => logPath;

module.exports = { teeConsole, installCrashHandlers, logRendererError, getLogPath };
