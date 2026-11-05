'use strict';
/**
 * 剪贴板监听：复制到「移动会议号 / 会议链接」时通知外部
 *
 *   CLIP_WATCH=0        关闭监听
 *   CLIP_INTERVAL_MS    轮询间隔（默认 1500ms）
 *
 * 注意：Electron 45 起 clipboard.readText() 返回 Promise（对齐 W3C 异步剪贴板）。
 */

const { clipboard } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { extractMeetingUrl } = require('./meeting-url');

/**
 * @param {object} opts
 * @param {(url: string) => void} opts.onMeeting 识别到会议地址时回调
 * @param {number} [opts.intervalMs]
 * @returns {{ stop: () => void }}
 */
function startClipboardWatch({ onMeeting, intervalMs = 1500 } = {}) {
  if (process.env.CLIP_WATCH === '0') {
    console.log('[clip] 已按 CLIP_WATCH=0 关闭剪贴板监听');
    return { stop() {} };
  }

  let lastClipText = '';
  let lastOpened = '';
  let busy = false;
  let timer = null;

  const poll = async () => {
    if (busy) return;
    busy = true;
    let text = '';
    try {
      text = String((await clipboard.readText()) || '').trim();
    } catch {
      busy = false;
      return;
    }
    busy = false;

    if (!text || text === lastClipText) return;
    lastClipText = text;

    const url = extractMeetingUrl(text);
    // 只认真正的会议分享地址（/share/<6位以上会议号>），避免误开空窗
    if (!url || !/\/share\/\d{6,}/.test(url)) return;
    if (url === lastOpened) return;   // 同一场会不重复开窗
    lastOpened = url;

    console.log('[clip] 识别到会议，打开分享窗:', url.replace(/\?.*$/, '?…'));
    onMeeting(url);

    // 处理完清空剪贴板：否则下次启动又会读到同一段文本，重复进会
    if (process.env.CLIP_KEEP !== '1') {
      try {
        await clipboard.writeText('');
        lastClipText = '';
        console.log('[clip] 已清空剪贴板（CLIP_KEEP=1 可保留）');
      } catch { /* 清不掉就算了 */ }
    }
  };

  // 启动时先把当前剪贴板记为"已处理"，避免一开程序就弹出上次复制的会议。
  // Wayland 下第一次读可能拿不到内容，重试几次再开始轮询。
  const seed = async () => {
    for (let i = 0; i < 4; i += 1) {
      try {
        const t = await clipboard.readText();
        if (t !== undefined && t !== null) {
          lastClipText = String(t || '').trim();
          return;
        }
      } catch { /* 再试 */ }
      await sleep(250);
    }
  };

  const start = async () => {
    await seed();
    timer = setInterval(poll, intervalMs);
    console.log('[clip] 剪贴板监听已启动，间隔', intervalMs, 'ms',
      lastClipText ? '(已有内容，记为已处理)' : '(剪贴板为空)');
  };
  start();

  return {
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** 分享窗关掉后调用：允许再次识别同一场会 */
    reset() {
      lastOpened = '';
    },
  };
}

module.exports = { startClipboardWatch };
