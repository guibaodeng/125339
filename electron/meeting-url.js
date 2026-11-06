'use strict';
/**
 * 会议链接/会议号的解析（纯函数，无副作用，可单独测试）
 */

const SHARE_BASE = 'https://yunshixun.125339.com.cn/share';

/**
 * 从一段文本里提取会议分享地址。
 *   ① 优先 125339 的分享链接
 *   ② 「移动会议：379172520」/「移动会议: 379 172 520」
 *   ③ 兜底：文本里带"会议"字样 + 任意链接
 * 返回 null 表示这段文本不是会议信息。
 */
function extractMeetingUrl(text) {
  const t = String(text || '');
  if (!t.trim()) return null;

  // ① 分享链接：只取会议号，然后统一按"会议号"那条流程拼标准地址
  //    （链接里常带 &random=xxx 之类的参数，去掉更干净，也避免触发客户端拉起逻辑）
  const share = t.match(/https?:\/\/[^\s"'<>）)]*125339\.com\.cn\/share\/(\d{6,})/i);
  if (share) return `${SHARE_BASE}/${share[1]}?xlocation=PROD`;

  const num = t.match(/移动会议\s*[:：]\s*([0-9][0-9\s]{4,20})/);
  if (num) {
    const digits = num[1].replace(/\s+/g, '');
    if (digits.length >= 6) return `${SHARE_BASE}/${digits}?xlocation=PROD`;
  }

  if (/会议/.test(t)) {
    const any = t.match(/https?:\/\/[^\s"'<>）)]+/i);
    if (any) return any[0];
  }
  return null;
}

/**
 * 从 ysx://com.zhongtai.ysx/app/callup?num=379682620&... 里取会议号。
 * 返回 { confId } 或 null。
 */
function parseYsxUrl(raw) {
  try {
    const u = new URL(raw);
    const num = u.searchParams.get('num')
      || u.searchParams.get('confId')
      || (String(raw).match(/[?&]num=([0-9]{6,})/) || [])[1];
    const digits = String(num || '').replace(/\D/g, '');
    return digits ? { confId: digits } : null;
  } catch {
    const m = String(raw || '').match(/num=([0-9]{6,})/);
    return m ? { confId: m[1] } : null;
  }
}

/** 是否是 ysx:// 链接 */
const isYsxUrl = (raw) => /^ysx:\/\//i.test(String(raw || ''));

module.exports = { SHARE_BASE, extractMeetingUrl, parseYsxUrl, isYsxUrl };
