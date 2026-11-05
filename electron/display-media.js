'use strict';
/**
 * 屏幕共享（getDisplayMedia）接管。
 *
 * 不能不做：Electron 不注册 setDisplayMediaRequestHandler 的话，页面调
 * getDisplayMedia 会直接失败。
 *
 * 注意两个坑（都踩过）：
 *   1. callback({}) 不是"拒绝"！当页面请求了 video 而 streams 里没有 video 时，
 *      Electron 会抛 TypeError: Video was requested, but no video stream was provided，
 *      在 Linux 上表现为"主进程未捕获异常"弹窗。想拒绝只能"不调用 callback"。
 *   2. getSources() 跑在浏览器进程（即主进程）里。Wayland 下如果没有
 *      xdg-desktop-portal / PipeWire，它可能长时间不返回，整个 App 跟着卡死。
 *      这里用超时兜底：超时就放弃本次共享并保持挂起，绝不传空对象。
 *
 * 环境变量：
 *   DISPLAY_MEDIA=screen  共享主屏（默认）
 *   DISPLAY_MEDIA=system  交给系统选择器（macOS 15+ 生效）
 *   DISPLAY_MEDIA=off     完全不接管，页面调 getDisplayMedia 直接失败（排查用）
 */

const { desktopCapturer } = require('electron');

const TIMEOUT_MS = 15000;
let requestSeq = 0;

async function pickSource() {
  const started = Date.now();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 }, // 不要缩略图，明显更快
    fetchWindowIcons: false,
  });
  console.log('[display] 取源完成，用时', Date.now() - started, 'ms，共', sources.length, '个');
  return sources[0] || null;
}

function installDisplayMediaHandler(ses) {
  const mode = process.env.DISPLAY_MEDIA || 'screen';

  if (mode === 'off') {
    console.log('[display] 已按 DISPLAY_MEDIA=off 关闭屏幕共享接管');
    return;
  }

  ses.setDisplayMediaRequestHandler((_request, callback) => {
    const id = ++requestSeq;
    let settled = false;

    // 只有真正拿到源才调用 callback；拒绝就保持挂起（见文件头注释）
    const grant = (source) => {
      if (settled) return;
      settled = true;
      try {
        callback({
          video: source,
          audio: process.platform === 'win32' ? 'loopback' : undefined,
        });
        console.log('[display] #' + id, '已交付捕获源');
      } catch (e) {
        console.log('[display] #' + id, '交付失败:', e.message);
      }
    };

    const giveUp = (reason) => {
      if (settled) return;
      settled = true;
      console.log('[display] #' + id, '放弃本次共享（' + reason + '）');
    };

    const timer = setTimeout(() => giveUp('取源超时 ' + TIMEOUT_MS + 'ms'), TIMEOUT_MS);

    pickSource()
      .then((source) => {
        clearTimeout(timer);
        if (!source) return giveUp('没有可用的屏幕源');
        grant(source);
      })
      .catch((e) => {
        clearTimeout(timer);
        giveUp('取源失败: ' + e.message);
      });
  }, { useSystemPicker: mode === 'system' });

  console.log('[display] 屏幕共享接管已安装，模式 =', mode);
}

module.exports = { installDisplayMediaHandler };
