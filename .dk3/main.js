const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const ROOT = '/home/dengguibao/PycharmProjects/125339';
app.setPath('userData', path.join(ROOT, '.dk3/ud'));
for (const ch of ['join:get','cred:get','bridge:get']) ipcMain.on(ch, (e) => { e.returnValue = null; });
ipcMain.on('theme:get', (e) => { e.returnValue = 'dark'; });   // 强制深色
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 820, show: false,
    webPreferences: { partition: 'persist:125339', preload: path.join(ROOT, 'electron/preload.js'),
      contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e) => { const m = String((e && e.message) || ''); if (/dark|reader/i.test(m)) console.log('[page]', m.slice(0, 140)); });
  await win.loadURL('https://conf.125339.com.cn/#/portal/').catch(() => {});
  await sleep(10000);
  const st = await win.webContents.executeJavaScript(`JSON.stringify({
    styles: document.querySelectorAll('style').length,
    darkreaderClass: document.querySelectorAll('[class*="darkreader"]').length,
    bg: getComputedStyle(document.body).backgroundColor,
  })`).catch((e) => 'ERR ' + e.message);
  console.log('[STATE]', st);
  const img = await win.capturePage().catch(() => null);
  if (img) require('node:fs').writeFileSync(path.join(ROOT, '.dk3/shot.png'), img.toPNG());
  app.quit();
});
