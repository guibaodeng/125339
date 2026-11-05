'use strict';
/**
 * ysx:// 外部协议：让浏览器里的「点击进入客户端」直接唤起本程序
 *
 *   YSX_PROTOCOL=0 可关闭注册
 *
 * Linux 下靠写一个 .desktop（声明 MimeType=x-scheme-handler/ysx）+ xdg-settings
 * 来成为默认处理程序；被唤起时 URL 出现在命令行参数里。
 */

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const YSX_SCHEME = 'ysx';
const DESKTOP_ID = 'yunshixun-desktop.desktop';
/** 开发版用独立的 desktop id，避免和安装版同 id 抢默认处理程序 */
const DEV_DESKTOP_ID = 'yunshixun-desktop-dev.desktop';
const SYSTEM_DESKTOP = '/usr/share/applications/yunshixun-desktop.desktop';

function logCurrentHandler() {
  execFile('xdg-mime', ['query', 'default', 'x-scheme-handler/ysx'], (err, stdout) => {
    const cur = String(stdout || '').trim();
    console.log('[ysx] 当前 x-scheme-handler/ysx 默认处理程序:', cur || '(未设置)');
  });
}

function setDefaultHandler(tag, id = DESKTOP_ID) {
  execFile('xdg-settings', ['set', 'default-url-scheme-handler', YSX_SCHEME, id],
    (err, _o, stderr) => {
      if (err) console.log('[ysx] 注册失败:', String(stderr || err.message).trim().slice(0, 160));
      else {
        console.log('[ysx] 已注册 x-scheme-handler/ysx →', tag, id);
        logCurrentHandler();
      }
    });
}

function registerYsxProtocol() {
  if (process.env.YSX_PROTOCOL === '0') {
    console.log('[ysx] 已按 YSX_PROTOCOL=0 跳过协议注册');
    return;
  }
  try {
    if (process.platform !== 'linux') {
      console.log('[ysx] setAsDefaultProtocolClient ->', app.setAsDefaultProtocolClient(YSX_SCHEME));
      return;
    }

    const appsDir = path.join(app.getPath('home'), '.local/share/applications');
    fs.mkdirSync(appsDir, { recursive: true });
    const localDesktop = path.join(appsDir, DESKTOP_ID);

    // 打包版：直接用 /usr/share/applications 里安装包自带的那份，
    // 绝不在用户目录写覆盖文件（以前写了，指向开发目录、还不带 --no-sandbox，从启动器一点就崩）
    if (app.isPackaged) {
      try {
        if (fs.existsSync(localDesktop)) {
          const old = fs.readFileSync(localDesktop, 'utf8');
          if (old.includes('node_modules/electron') || old.includes('PycharmProjects')) {
            fs.unlinkSync(localDesktop);
            console.log('[ysx] 已删除旧的用户级 desktop 覆盖文件（它指向开发目录）');
          }
        }
      } catch { /* 删不掉就算了 */ }
      setDefaultHandler('');
      return;
    }

    // 开发版：用独立的 dev id，绝不占用 yunshixun-desktop.desktop（那是安装版的 id）。
    // 以前占用同 id 会把安装版顶掉，导致浏览器点 ysx:// 拉起的是开发目录里的 electron。
    const staleSameId = path.join(appsDir, DESKTOP_ID);
    if (fs.existsSync(staleSameId)) {
      try {
        fs.unlinkSync(staleSameId);
        console.log('[ysx] 已删除旧的同名用户级 desktop（它会抢安装版的关联）');
      } catch { /* 删不掉就算了 */ }
    }

    const exec = `"${process.execPath}" --no-sandbox "${app.getAppPath()}"`;
    const iconPath = path.join(app.getAppPath(), 'app-icon.png');
    const desktop = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=移动会议（开发）',
      'Comment=中国移动云视讯桌面客户端（开发模式）',
      `Exec=${exec} %u`,
      'Terminal=false',
      'Categories=Network;',
      'StartupWMClass=yunshixun-desktop',
      ...(fs.existsSync(iconPath) ? [`Icon=${iconPath}`] : []),
      "MimeType=x-scheme-handler/ysx;",
      '',
    ].join('\n');
    fs.writeFileSync(path.join(appsDir, DEV_DESKTOP_ID), desktop, { mode: 0o644 });

    // 装了正式版就别抢默认处理程序
    if (fs.existsSync(SYSTEM_DESKTOP)) {
      console.log('[ysx] 检测到安装版，ysx:// 继续由安装版处理（开发版只保留' + DEV_DESKTOP_ID + '）');
      logCurrentHandler();
      return;
    }

    setDefaultHandler('（开发版）', DEV_DESKTOP_ID);
  } catch (e) {
    console.log('[ysx] 注册异常:', e.message);
  }
}

module.exports = { YSX_SCHEME, DESKTOP_ID, registerYsxProtocol };
