'use strict';
/**
 * 窗口尺寸工具：把目标尺寸换算成"居中且不超出工作区"的 bounds，并做平滑动画。
 * 纯函数式，窗口对象由调用方传入。
 */

const { screen } = require('electron');

/** 目标尺寸 → 屏幕工作区内的居中 bounds */
function boundsFor(target, size, margin = 40) {
  const area = screen.getDisplayMatching(target.getBounds()).workArea;
  const width = Math.min(size.width, area.width - margin);
  const height = Math.min(size.height, area.height - margin);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

/** 从当前 bounds 平滑动画到目标尺寸（ease-out），返回 Promise */
function animateTo(target, size, ms = 320) {
  if (!target || target.isDestroyed()) return Promise.resolve();
  const to = boundsFor(target, size);
  const from = target.getBounds();
  const start = Date.now();
  target.setResizable(true);

  return new Promise((resolve) => {
    const tick = () => {
      if (!target || target.isDestroyed()) return resolve();
      const t = Math.min(1, (Date.now() - start) / ms);
      const k = 1 - (1 - t) ** 3;
      target.setBounds({
        x: Math.round(from.x + (to.x - from.x) * k),
        y: Math.round(from.y + (to.y - from.y) * k),
        width: Math.round(from.width + (to.width - from.width) * k),
        height: Math.round(from.height + (to.height - from.height) * k),
      });
      if (t < 1) setTimeout(tick, 16);
      else resolve();
    };
    tick();
  });
}

module.exports = { boundsFor, animateTo };
