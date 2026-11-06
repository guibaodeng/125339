# 云视讯桌面壳

把 `www.125339.com.cn` 的登录页和 `conf.125339.com.cn` 的门户，收进一个像微信 PC 端一样的 Electron 桌面客户端：**小窗登录 → 登录成功同一个窗口原地变大 → 自动进门户**。

> 结论与依据见 [`docs/可行性分析.md`](docs/可行性分析.md)。本项目是**可行性验证原型**。

## 跑起来

```bash
npm install
npm start
```

国内网络装依赖时建议先设镜像（Electron 二进制不走 npm 源）：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
```

### 关于 `--no-sandbox`

Linux 上 Electron 自带的 `chrome-sandbox` 需要 `root:root + 4755` 权限，否则会直接报
`The SUID sandbox helper binary was found, but is not configured correctly`。
`npm start` 默认带 `--no-sandbox` 绕过它，方便开发。

想用回沙箱（更安全，正式分发应该这样）：

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
npm run start:sandboxed
```

## 流程

```
登录窗（www/auth/SignIn，固定 410×424）
   │ 轮询 localStorage.Authorization
   ▼
拿到 token 的同时，直接用 token 调两个接口算出门户地址
   │ 1) GET /server/mobile/nonce → nonce
   │ 2) 套进固定模板（见下）
   ▼
template.replace("{}", nonce) → 同窗加载（窗口放大到 1280×820）
   ▼
门户「我的会议」（带登录态）

算不出来时自动退回：放大到工作台 → 代点「会议服务 → 移动会议」→ 截住 window.open
```

**不用等页面渲染、不用点菜单**——官网自己也是这么干的（`window.open(template.replace('{}', nonce))`）。

## 登录态存在哪、怎么复用

| 存什么 | 存在哪（实测） |
| --- | --- |
| `localStorage.Authorization`（JWT，约 10 小时有效） | `./userdata/Partitions/125339/Local Storage/`（LevelDB） |
| Cookie `Authorization`（hostOnly，www 域） | `./userdata/Partitions/125339/Cookies`（SQLite） |
| token 缓存副本（登录成功时写入） | `./userdata/session.json`（`safeStorage` 加密，权限 600） |

> 数据目录固定为项目下的 `./userdata`（绿色版做法）：换终端、换启动方式都用同一份 profile；
> 删掉这个目录 = 退出登录。需要放别处时用 `APP_USER_DATA=/path` 覆盖。

启动流程：

```
启动 → 隐藏加载 www/auth/SignIn（不显示）
        ├─ 读 localStorage.Authorization，解 JWT 的 exp
        ├─ 未过期 → 算门户地址 → 直接进会议，全程不显示登录框
        └─ 没有/已过期 → 显示登录框
```

JWT 判断留了 60 秒余量，避免"刚进去就过期"。

### 记住密码（替代 1Password）

登录页点「登录」或回车时，preload 把明文账号密码交给主进程**暂存内存**；
等 `/server/login` 返回 200（登录真的成功）才用 `safeStorage` 加密写入
`./userdata/credentials.json`（权限 600）。这样输错密码不会覆盖已存的那份。

下次打开登录页，`preload` 会把账号密码自动填好，焦点落在密码框，你只需要拖一次滑块。

- 关闭：`REMEMBER=0 npm start`
- 忘记：删掉 `./userdata/credentials.json`

**登录成功是"监听"出来的**：主进程用 `session.webRequest.onCompleted` 盯着
`POST /server/login`，拿到 200 就立刻缓存 token 并开始算门户地址；
万一以后接口改了，还有一条 700ms 轮询 `localStorage.Authorization` 的兜底通道。

### 10 小时内不用再登录

两级会话，寿命不同：

| 层级 | 期限 | 说明 |
| --- | --- | --- |
| www JWT（`Authorization`） | **10 小时** | 硬上限，过期只能重新登录（滑块） |
| 门户会话（`application.expire`） | 进门户后 **约 30 分钟** | 门户自己的"已登录"标记，过期就显示"登录已过期" |

所以门户掉线不代表要重新登录：只要 www 的 JWT 还在，壳子会自动用缓存的 token
换一张新 nonce，**静默重进门户**（`[reauth] 门户会话过期，静默重进`），用户看不到登录框。

只有 JWT 真的过期（10 小时）或你主动退出，才会回登录页。

**退出登录会被监听并清理**：站点调用 `POST /server/logout` 时，主进程通过
`session.webRequest.onBeforeRequest` 捕获，清空 www/conf 两个源的 localStorage 和 Cookie，
窗口立刻缩回登录框。token 过期时启动也会主动清一次，避免"拿着死 token 反复弹跳"。

> 这两个文件是**明文落盘**（Electron 默认行为）：能读到磁盘就能拿到 token。
> 如果要更严，可以用 `safeStorage` 再加密存一份自己的副本，但 localStorage 里那份仍是明文。

## 关键点：门户入口 = 固定模板 + nonce

模板直接写死在代码里（`PORTAL_TEMPLATE`），登录成功后只取 nonce 替换 `{}`：

```
https://conf.125339.com.cn/?lang=zh-CN&customer=chinamobile
  &nonce={}&redirect=user_conference_list#/login
```

实测日志：`[resolve] ok (via template) https://conf.125339.com.cn/?lang=zh-CN&customer=chinamobile&nonce=<hidden>&redirect=user_conference_list#/login`
落地后站点自己把 hash 改写成 `#/portal/cmp/user/conference/conference-list`。

取不到 nonce 时还有一条兜底：从菜单接口里找带 `{}` 的地址模板。

## 另外两种拿到入口的方式（已实现，但不再是主路径）

门户不认 www 的登录态（Cookie 是 hostOnly 的），真正能进门的地址是点「会议服务 → 移动会议」时 `window.open` 出来的：

```
https://conf.125339.com.cn/?lang=zh-CN&customer=chinamobile
  &nonce=<时间戳+40位随机>&redirect=user_conference_list#/login
```

`nonce` 每次点击都不同，**不伪造**。壳子只在 `window.open` 的出口处接住它：

```js
contents.setWindowOpenHandler(({ url }) => {
  if (url.startsWith('https://conf.125339.com.cn')) {
    win.loadURL(url);            // 同一个窗口打开
    return { action: 'deny' };   // 不另开新窗
  }
  ...
});
```

## 登录成功后不闪官网

站点自己的逻辑：`/server/login` 返回 200 后，登录页会执行
`window.location.href = "/?status=login"` 跳回官网工作台。所以原生流程是
**登录页 → 官网首页 → 点菜单 → 门户**，中间会闪一下官网首页。

壳子把这步拦掉了：

```js
// onCompleted 拿到 200 的同一时刻同步置位（比页面自己跳更早）
suppressWorkbench = true;

// will-navigate 里拦掉站点自己发起的跳转
if (suppressWorkbench && /www\.125339\.com\.cn\/.*[?&]status=login/.test(url)) {
  event.preventDefault();   // 登录页停在原地
}
```

同时盖一层「正在进入会议…」遮罩，然后直接 `loadURL(门户地址)`。
只有 nonce 算不出来时才会放行，退回"工作台 + 代点菜单"。

## 门户界面精简

右上角 5 个入口都是 `li.Navigation__Item`，用 CSS Module 前缀精确命中，隐藏第 3、第 5 个：

```css
li:has([class*="TaskProgressPopover__"]) { display: none !important; }  /* 任务中心 */
li:has([class*="AvatarMenu__"])          { display: none !important; }  /* 用户名/头像下拉 */
```

剩下：`Web入会 | 主持参会 | 中文 English`。

如果需要退出登录：站点的 `/server/logout` 仍会被监听并清理本地 token；
也可以直接删掉 `./userdata` 目录（等效于清空本地登录信息）。

## Linux / Wayland 下的屏幕共享（已实测可用）

Ubuntu 26.04 只有 Wayland，这条路必须走通。**两个条件缺一不可**：

| 条件 | 说明 |
| --- | --- |
| **Electron ≥ 45** | Chromium 156+；Electron 33（Chromium 130）在 Wayland 下捕获会挂死 |
| **原生 Wayland 运行** | `--ozone-platform-hint=auto`；默认的 XWayland 会去抓 XWayland 根窗口，同样挂死 |

壳子里已经默认处理：

```js
if (platform === 'linux' && isWayland) {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
  app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
}
```

实测结果（Electron 45.2.2 / Chromium 156 / Wayland / PipeWire）：

```
[display] 取源完成，用时 3365 ms
[display] #1 已交付捕获源
getDisplayMedia => { ok: true, tracks: 1, label: "Entire screen" }
```

注意取源要 **3～5 秒**（走 portal），所以超时兜底设成 15 秒。

## Linux / Wayland 排查笔记

Chromium 在 **X11 下可以直接抓屏**，但在 **Wayland 下必须走 PipeWire + xdg-desktop-portal**。
没有这套东西时，`getDisplayMedia` 不是报错，而是**挂住不返回**——整个 App 会假死。

壳子里做了三件事：

1. Linux 启动时自动加 `--enable-usermedia-screen-capturing`；
2. 检测到 Wayland 会话时自动启用 `WebRTCPipeWireCapturer`；
3. 启动日志里会检查 `xdg-desktop-portal` 进程是否在跑：

```
[env] session = wayland | wayland-0
[warn] 没找到 xdg-desktop-portal 进程 → Wayland 下屏幕共享会失败
```

**修复**：

```bash
sudo apt install xdg-desktop-portal xdg-desktop-portal-gnome
# 安装后必须注销重新登录（portal 是会话级服务）
```

最省事的替代：登录界面右下角齿轮 → 选 **Ubuntu on Xorg**，用 X11 会话。

**注意**：`callback({})` 不是"拒绝共享"。当页面请求了 video 却没给源时，Electron 会抛
`TypeError: Video was requested, but no video stream was provided`，表现为"主进程未捕获异常"弹窗。
现在只在拿到真实源时才调用 callback，拒绝时保持挂起。

## 会议窗口尺寸

会议界面是固定布局，缩太小会把底部按钮挤掉。进出会议时自动切换最小尺寸：

| 状态 | 最小尺寸 |
| --- | --- |
| 登录 | 360×320（登录窗固定 410×424，卡片本身约 356×340） |
| 门户 / 会议 | **1280×720**（按屏幕工作区自动裁剪） |

`conf.125339.com.cn/webrtc` 这个 URL 做了**单独监听**：不管它是主窗口还是子窗口、是直接加载还是中途跳转，
承载它的窗口都会被强制不小于 1280×720（已经小于的话会立刻放大）：

```js
if (/^https:\/\/conf\.125339\.com\.cn\/webrtc/.test(target)) {
  const w = BrowserWindow.fromWebContents(contents);
  if (w) applyMainMinSize(w);
}
```

```js
const isMeetingUrl = (url) => /\/webrtc\//.test(url) && !/#\/leave\b/.test(url);
if (isMeetingUrl(url)) applyMeetingMinSize(true);
```

## 会议分享页

分享链接形如 `https://yunshixun.125339.com.cn/share/<会议号>?xlocation=PROD&random=...`，
标题是「移动会议 - 分享」。

壳子专门处理它：

- 单独开一个 **420×640** 的小窗（不再套在 1280 的主窗里）
- **隐藏「加入会议」按钮**（按文案匹配，站点改类名也不怕）
- **隐藏顶部横幅图** `bannerPC.xxx.webp`（宽屏）/ `banner.xxx.webp`（窄屏），用路径前缀匹配，哈希变了也不影响
- **隐藏「没有安装移动会议客户端? 立即下载」整段** —— 注意"立即下载"实际是 `<button>`（带 MuiTouchRipple），
  按 `a/span` 找是找不到的；现在按"文案完全相等"取最深元素，再往上找含"没有安装"的那层整体隐藏
- **去掉滚动条**：页面自身有 80 多 px 溢出（`scrollHeight` 657 vs 视口 574），直接 `html,body{overflow:hidden}`

实测：

```
[result] {"exists":true,"display":"none"}
```

## 入会页自动点「加入会议」

`conf.125339.com.cn/webrtc/?customer=chinamobile...` 这个页面，当会议信息已经填好、
「加入会议」按钮变为可点时，自动点它（只点一次）：

```js
const btn = [...document.querySelectorAll('button')]
  .find((b) => (b.innerText || '').replace(/\s+/g, '') === '加入会议');
if (btn && !btn.disabled) btn.click();
```

细节：

- 按**文案**匹配按钮，不依赖类名；
- 按钮是 `disabled` 时不会点，每 300ms 重试，最多等 90 秒；
- 点完 2.5 秒还在原页面，会补一次 `form.requestSubmit()`（有些表单只认真实提交）；
- 只点一次，避免重复入会。

## 会议页：错误路由关窗

URL 里带 `error`（典型是 `#/errors?key=USG.000000004`）就直接关窗口、复位到门户：

```js
const isErrorUrl = (url) => /\/webrtc\//.test(url) && /error/i.test(url);
```

实测：

```
[meeting] 检测到错误路由，关闭窗口: ...#/errors?key=USG.000000004
[meeting] 会议结束（error），处理方式 → close
[window] 已收进托盘，进程继续运行
```

> 曾尝试过"会议页全屏以隐藏标题栏"，已回滚：Electron 的 `frame` 无法在运行时切换，
> 而全屏会占满整屏，影响使用。会议页保持普通窗口（有标题栏）。

## 退出会议时自动关窗

会议页退出时会跳到 `#/leave`：

```
https://conf.125339.com.cn/webrtc/?customer=chinamobile&lang=zh-CN&nonce=...&...#/leave
```

壳子监听导航，命中就以 `LEAVE_ACTION` 指定的方式处理（默认关窗）：

```js
const isLeaveUrl = (url) => /\/webrtc\//.test(url) && /#\/leave\b/.test(url);
```

| `LEAVE_ACTION` | 行为 |
| --- | --- |
| `close`（默认） | 窗口收进托盘，同时把隐藏窗口复位到门户（下次点托盘看到的是「我的会议」而不是离开页） |
| `portal` | 不关窗，直接回到门户 |
| `quit` | 整个应用退出 |

实测日志：

```
[meeting] 检测到 #/leave，会议已退出 → close
[window] 已收进托盘，进程继续运行
[test] 之后 → 窗口可见: false | url = .../#/portal/cmp/user/conference/conference-list
```

## 退出：为什么以前很慢

`app.quit()` 是"礼貌退出"：先给每个窗口发 close，等渲染进程确认。只要有一个页面卡死
（我们遇到过会控页 `r1.125339.com.cn/confportal/` 无响应），quit 就会一直等，
窗口留在屏幕上不动，桌面就会显示忙碌光标（鼠标一直转圈）。

现在改成强制退出：

```js
function quitApp() {
  isQuitting = true;
  for (const w of BrowserWindow.getAllWindows()) w.destroy();  // 不等渲染进程
  app.quit();
  setTimeout(() => app.exit(0), 1500);   // 兜底：1.5s 还没退干净就强杀
}
```

实测（故意造一个死循环的渲染进程）：

```
[quit] 触发退出（模拟托盘「关闭」）
[quit] 开始退出，窗口数 2
[quit] before-quit / will-quit
[quit] process exit, code = 0        ← 从触发到进程结束 2ms
```

### 关于退出后"鼠标还转圈 10 秒"

进程本身退得很快（日志里 `process exit` 在毫秒级），剩下的 10 秒是**桌面自己的超时**：
GNOME 会在"启动反馈/指针 grab 未释放"时保持忙碌光标，最长约 10 秒。

壳子这边能做的已经做了：

- 退出前先 `tray.destroy()`，让面板上的 StatusNotifierItem 正常注销；
- 托盘菜单点击后**延迟 150ms** 再退出，给 GTK 菜单弹层时间收起（避免它握着指针 grab 时进程就消失）；
- `.desktop` 显式 `StartupNotify=false`。

## 托盘（已停用）

GNOME 的 `ubuntu-appindicators` 扩展在进程退出后仍会去
`/tmp/org.chromium.Chromium.XXXX` 找托盘图标，找不到就反复重试，
表现为**退出后鼠标转圈约 10 秒**（实测：不创建托盘时退出完全正常）。

所以托盘整体停用：

```js
function createTray()  { console.log('[tray] 托盘已停用'); return; }
function refreshTrayMenu() { return; }
```

**行为变化**：

| 动作 | 现在 |
| --- | --- |
| 点窗口 X | **退出程序**（原本是收进托盘） |
| 会议中点 X | 弹确认框（"退出会议并关闭 / 取消"） |
| 重新打开 | 从应用列表启动；登录态仍在，会直接进门户 |

要恢复托盘：还原 `createTray()` / `refreshTrayMenu()` 两个函数体，
再把 close 处理改回 `win.hide()` 即可（git 历史里有完整实现）。

## 原托盘设计（已停用，留作记录）

- **关窗口 = 收进托盘**，进程继续跑（登录态、会议都不受影响）
- **右键托盘图标**：显示主窗口 / 关闭（真正退出应用）
- **左键点图标**：显示 ↔ 隐藏 切换
- 只有在托盘菜单点「退出」（或系统结束进程）才真正退出

图标用的就是站点自己的 favicon：`https://conf.125339.com.cn/favicon/chinaMobile.ico`
（服务端实际返回的是 144×144 PNG），已下载为 `assets/tray.png`，托盘和任务栏共用这一份。
想换图标直接替换这个文件即可。

想改回"关闭即退出"：删掉 `electron/main.js` 里 `win.on('close', ...)` 那段即可。

## 子窗口

站点会用 `window.open` 打开子窗口（例如会议控制页 `r1.125339.com.cn/confportal/`）。
壳子对这些窗口做了三件事：

1. **创建前夹尺寸**：`window.open` 指定的尺寸如果超出屏幕，按工作区裁剪并居中，
   避免关闭按钮跑到屏幕外；
2. **记录尺寸变化**：站点自己 `resizeTo` 时会打 `[win] 子窗口 #N 尺寸变为 WxH`；
3. **关闭兜底**：子窗内按 `Ctrl+W` 可直接关闭（`destroy()`，不走页面逻辑）；
4. **挂死自动回收**：子窗口渲染进程无响应超过 15 秒就强制关闭（`UNRESPONSIVE_CLOSE_MS` 可调），
   避免留下一个点不动的窗口；
5. **禁用 JS 原生对话框**：`disableDialogs: true`。页面里 `alert()`/`confirm()` 会阻塞渲染进程，
   表现就是"窗口无响应、点关闭没反应"；
6. **忽略 beforeunload**：页面常用 `onbeforeunload` 询问"确定离开会议吗？"，会拦掉关闭动作。
   `will-prevent-unload` 里 `preventDefault()` 强制放行：

   ```js
   contents.on('will-prevent-unload', (event) => event.preventDefault());
   ```

   这也解释了"托盘能关、点 X 关不掉"：托盘走 `destroy()`（绕过 beforeunload），点 X 走 `close()`（被拦）。
7. **必要时改用系统浏览器**：`R1_EXTERNAL=1 npm start`，把 `r1.125339.com.cn` 的页面交给 Chrome 打开。

## ysx:// 协议关联到壳子

浏览器里点「点击链接，进入 H5 邀请页面」会尝试打开 `ysx://com.zhongtai.ysx/app/callup?num=379682620`。
这台机器没装移动会议客户端、`x-scheme-handler/ysx` 也没人认领，所以系统会弹
“选择一个应用打开”（xdg-desktop-portal）。

壳子启动时会把这个协议**注册到自己身上**：

```js
// ~/.local/share/applications/yunshixun-desktop.desktop
MimeType=x-scheme-handler/ysx;
Exec="/path/to/electron" "/path/to/app" %u
```

然后：

```bash
xdg-settings set default-url-scheme-handler ysx yunshixun-desktop.desktop
```

之后从浏览器点链接，会用壳子打开，并且：

1. 解析出 `num=371145389`；
2. **先换一个入会 nonce**（在 www 源上用登录 token 请求 `/server/mobile/nonce`），
   打开 `webrtc/?customer=chinamobile&lang=zh-CN&nonce=xxx`；
3. 自动填入会议号和昵称、勾选协议；
4. 等「加入会议」按钮可用后自动点击。

**nonce 怎么拿**：优先用缓存的 www token 直接请求（`session.fetch`，不开窗口，约 250ms）；
拿不到才退回到"临时隐藏窗口"方案，该窗口登记为 helper，白名单闸门永远不会显示它。

**入会昵称**：不再是硬编码的"参会人"。站点在 `/v1/usg/dcs/member` 里给了真实姓名，
但它要站点自己请求时带的 `x-access-token`。壳子用 `webRequest.onBeforeSendHeaders`
截获这对 token，再用 `session.fetch` 取名字，成功后缓存到 `state.json`：

```
[ysx] 入会昵称取自账号: 邓桂保
[ysx] 打开入会窗口 #3，昵称 邓桂保
```

取不到时按顺序回退：`state.json` 缓存 → 账号接口 → `参会人`。
退出登录会清掉缓存。

**为什么必须带 nonce**：纯 `/webrtc/` 是游客表单，遇到"仅允许授权用户加入"的会议会被拦下：

```
加入会议失败
该会议仅允许授权用户加入，请登录对应账号或联系会议预定者
（#/errors?key=MMC.111071073）
```

带 nonce 的地址则是"已登录入会"，实测可以正常进会（`会议中(9)`）。
取不到 nonce（未登录）时才退回游客表单。

实测日志：

```
[ysx] 收到外部链接: ysx://com.zhongtai.ysx/app/callup?num=379682620&x=1
[ysx] 打开入会窗口，会议号 379682620
[ysx] 已填入会议号 379682620 ，等待按钮可用
[ysx] 表单已就绪，自动点击「加入会议」
```

**注意**：这会抢占 `ysx://`（如果日后装了官方客户端会冲突，最后注册的生效）。
不想注册：`YSX_PROTOCOL=0 npm start`；撤销：`xdg-settings set default-url-scheme-handler ysx ''`。

### desktop 文件的两种模式

| 模式 | 行为 |
| --- | --- |
| **开发**（`npm start`） | 写 `~/.local/share/applications/yunshixun-desktop.desktop`，`Exec` 带 `--no-sandbox`（不带会因 chrome-sandbox 权限直接 FATAL），名字标「开发」 |
| **打包**（deb/AppImage） | **不写**用户级文件，直接用 `/usr/share/applications/yunshixun-desktop.desktop`（安装包自带，Icon 为绝对路径）；并自动删除以前开发时写的旧覆盖文件 |

用户目录的同名 desktop **优先级高于** `/usr/share`。如果以前从开发版启动过，
那份旧文件会一直生效（指向 `node_modules/electron/dist/electron`、没有 `--no-sandbox`），
从启动器点就会崩。修掉：

```bash
rm -f ~/.local/share/applications/yunshixun-desktop.desktop
update-desktop-database ~/.local/share/applications
```

打包版第一次运行时会自动删掉它。

## 分享页自动点「网页入会」

分享页（`yunshixun.125339.com.cn/share/<会议号>`）出现「网页入会」按钮时自动点一次：

```js
const btn = [...document.querySelectorAll('button, [role="button"], a')]
  .find((el) => (el.innerText || '').replace(/\s+/g, '') === '网页入会');
if (btn && !btn.disabled) btn.click();
```

- 页面渲染完等 1.2 秒再点，找不到就每 300ms 重试，最多 12 秒；
- 只点一次；
- 同时仍然隐藏「加入会议」（拉起原生客户端那条路）和「立即下载」。

实测（注入一个假的「网页入会」按钮验证逻辑）：

```
[分享页] 自动网页入会开关: 开启
[share] 自动点击「网页入会」
[test] 假按钮被点击
```

> 注意：站点自己有个「自动网页入会开关」，开启时会**不用按钮直接进会**；
> 如果它报 `会议基础信息获取失败，停止自动入会流程`，页面上根本不会渲染按钮，
> 这时候我们也没有可点的东西。

## 子窗口按 host 复用（会控助手等）

站点点按钮时每次都会 `window.open`，不复用就会越开越多。现在普通子窗口按 **host** 复用：

```js
const childWins = new Map();   // host -> BrowserWindow

function openChildWindow(url) {
  const host = new URL(url).host;
  const exist = childWins.get(host);
  if (exist && !exist.isDestroyed()) {
    exist.loadURL(url);    // 复用：换到新地址
    exist.show();
    exist.focus();
    return exist;
  }
  // 否则新建，并在 closed 时从 map 移除
}
```

实测（连续两次打开 `r1.125339.com.cn` 的不同页面）：

```
[child] 新建子窗口 #3（r1.125339.com.cn）
[child] 复用子窗口 #3（r1.125339.com.cn）
[test] 窗口 3 ... url = https://r1.125339.com.cn/confportal/#/conference/123
```

始终只有一个会控助手窗口。关掉后 map 会清空，下次点会新建。

## 分享窗只保留一个

不管来源是剪贴板识别还是站点自己 `window.open`，分享窗都走同一个函数：

```js
function openShareWindow(url) {
  if (shareWin && !shareWin.isDestroyed()) {
    shareWin.loadURL(url);   // 复用：换到新会议
    shareWin.show();
    shareWin.focus();
    return shareWin;
  }
  // 否则新建
}
```

站点的 `window.open` 也被接管：

```js
if (isShareUrl(url)) {
  openShareWindow(url);
  return { action: 'deny' };   // 不让它自己再开一个
}
```

实测连续打开三场会，窗口数始终是 2（主窗 + 分享窗）：

```
[share] 新建分享窗口 #2
[share] 复用分享窗口 #2，换到 .../share/373645373?…
[share] 复用分享窗口 #2，换到 .../share/379172520?…
[share-test] 第二个之后 2 ["2:.../share/379172520","1:.../conference-list"]
```

## 剪贴板自动识别会议

每隔 1.5 秒读一次剪贴板文本，命中会议信息就自动开一个分享窗：

```
曾亮邀请您参加移动会议
会议主题：湖南磐基周例会
移动会议：379172520
参会链接：https://yunshixun.125339.com.cn/share/379172520?xlocation=PROD
```

| 情况 | 行为 |
| --- | --- |
| 文本里有 `/share/<会议号>` 链接 | **提取会议号**，统一拼成 `…/share/<会议号>?xlocation=PROD` 再打开 |
| 只有「移动会议：379 172 520」（带不带空格都行） | 拼成 `https://yunshixun.125339.com.cn/share/379172520?xlocation=PROD` |
| 普通文本 / 图片 / 文件 | 什么都不做 |
| 同一场会 | 不重复开窗（同一窗口复用） |

实现要点：

- Electron 45 起 `clipboard.readText()` 返回 **Promise**（对齐 W3C 异步剪贴板），必须 `await`；
- 启动时先把当前剪贴板记为"已处理"，避免一开程序就弹上次复制的会议；
- 只认 `/share/\d{6,}/` 形式的地址，防止把随手复制的普通链接也当会议打开；
- 链接里带的 `&random=xxx` 等参数会被丢掉，走和"只有会议号"完全相同的流程；
- 分享页里 `ysx://` 这类外部协议会被拦掉，避免弹系统协议对话框。

**处理完会清空剪贴板**（`CLIP_KEEP=1` 可保留），否则每次重启都会读到同一段文本、重复进会。
启动时也会先把当前剪贴板记为"已处理"（Wayland 下第一次读可能为空，会自动重试 4 次），
所以"复制会议 → 关掉软件 → 再打开"不会自动进会。

关闭：`CLIP_WATCH=0 npm start`；改间隔：`CLIP_INTERVAL_MS=3000`。

## 启动性能

一次"已有登录态"的启动原本要 ~4.8 秒窗口才出现，做了三处优化后约 **0.6 秒**就出来
（先显示窗口 + 遮罩，内容约 3 秒渲染完）。

| 优化 | 原来 | 现在 |
| --- | --- | --- |
| `showWhenLoaded()` 误等 4 秒兜底 | 页面其实已加载完，但 `did-stop-loading` 早错过了，只能等满 4s | 先判断 `webContents.isLoading()`，已加载就直接 `show()` |
| 启动流程 | 先加载 www 登录页读 token，再决定进门户（多一次页面加载） | 缓存 token 有效时**直接换 nonce 进门户**，跳过登录页 |
| 放大动画 | `await growToMain()` 之后才开始加载门户 | 动画与 `loadURL` 并行 |

快速通道的关键是：缓存的 token 能直接换到 nonce（`ses.fetch('/server/mobile/nonce')`），
不需要窗口；失败才回退到"加载登录页 → 读 localStorage → 走原流程"。

实测时间线（同一份 profile）：

```
15:14:10.463  日志文件
15:14:11.081  [boot] 缓存 token 有效，直接进门户（跳过登录页）   ← 窗口此刻显示
15:14:11.465  [url] nav 门户 URL
15:14:13.451  [url] inpage .../conference-list                   ← 遮罩撤掉
```

## 深色模式：Dark Reader 跟随系统

用 [`darkreader`](https://www.npmjs.com/package/darkreader) 而不是自己写 CSS 反色：

```js
const OPTIONS = { brightness: 100, contrast: 90, sepia: 0 };
dr.setFetchMethod(window.fetch.bind(window));
dr.enable(OPTIONS);      // 深色
dr.disable();            // 浅色
```

### 参数怎么调

可调项来自 darkreader 的 `Theme`（`node_modules/darkreader/index.d.ts`）：

| 参数 | 范围 | 默认 | 说明 |
| --- | --- | --- | --- |
| `brightness` | 0–100+ | 100 | 整体亮度，100 = 原亮度，越小越暗 |
| `contrast` | 0–100+ | 100 | 对比度，100 = 站点原对比度 |
| `sepia` | 0–100 | 0 | 暖色程度 |
| `grayscale` | 0–100 | 0 | 灰度 |
| `mode` | `1`/`0` | 1 | 1 = 深色，0 = 暗淡（dimmed） |

壳子里默认用 `brightness: 100, contrast: 90, sepia: 0`（对比度略降，长时间看着不刺眼），
每一项都能用环境变量覆盖：

```bash
DARK_CONTRAST=110 npm start            # 对比度更高，文字更锐利
DARK_BRIGHTNESS=85 npm start           # 整体压暗
DARK_SEPIA=20 npm start                # 偏暖（类似护眼）
DARK_GRAYSCALE=100 npm start           # 纯灰度
DARK_DIM=1 npm start                   # 暗淡模式（mode: 0），不是纯黑
```

实测差异（同一页面截图的平均亮度）：

| 配置 | 平均亮度 | 标准差 |
| --- | --- | --- |
| `DARK_CONTRAST=120` | 13 | 20.4 |
| `DARK_BRIGHTNESS=85 DARK_SEPIA=20` | 39 | 13.5 |

数值是主进程 `config.js` 读环境变量后经 `theme:options` 发给 preload 的，
想改成写死的默认值就改 `electron/config.js` 里的 `DARK_THEME`。

跟随系统：主进程用 `nativeTheme.shouldUseDarkColors` 判断，系统切换时广播给所有窗口：

```js
ipcMain.on('theme:get', (event) => { event.returnValue = themeMode(); });
nativeTheme.on('updated', () => { /* 广播 theme:set 给每个窗口 */ });
```

- **会议页 `/webrtc` 不套**（避免影响视频画面和会议 UI）
- 调试可强制：`DARK_MODE=dark` 或 `DARK_MODE=light`

### 两个坑

**① `require('darkreader')` 拿到的是空对象**

包的 `package.json` 写着 `"type": "module"`，但 `darkreader.js` 其实是 UMD。
Node 会按 ESM 处理 → `require()` 返回空命名空间、`import()` 也拿不到 `enable`。
解决办法是把 UMD 源码在新作用域里跑一遍：

```js
const src = fs.readFileSync(require.resolve('darkreader'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', src)(mod, mod.exports);
const dr = mod.exports;   // 有 enable / disable / setFetchMethod
```

**② preload 需要 `sandbox: false`**

沙箱化的 preload 不能 `require` 任意模块。我们本来就以 `--no-sandbox` 运行，
所以这里不额外降低系统级隔离。

打包时要把依赖带进去：`build.files` 加了 `node_modules/darkreader/**/*`
（实测 asar 里能正常加载）。

## 门户右上角「登出」

头像下拉被隐藏后，门户上就没有退出入口了。壳子在右上角（中英文切换后面）注入一个「登出」：

```js
// 站点右上角的文字项其实是 <button class="Button__TextButton... ec-text-button">，
// 直接把它的 class 借过来，字体/颜色/字重才能和「Web入会」完全一致
const refBtn = navUl.querySelector('button');
btn.className = refBtn.className;
btn.textContent = '登出';
```

实测两边计算样式完全相同：

```
webStyle   { fontSize: 12px, color: rgb(13,148,255), fontWeight: 400, fontFamily: "Helvetica Neue" }
logoutStyle{ fontSize: 12px, color: rgb(13,148,255), fontWeight: 400, fontFamily: "Helvetica Neue" }
```

主进程收到后：

```js
ipcMain.on('auth:logout', async () => {
  await clearLoginState();   // 缓存 token + 两个源的 localStorage + Cookies
  await gotoLogin();         // 缩回 410×424 登录窗并载入登录页
});
```

**踩过的坑**：门户是 SPA（`#/login` → `#/portal` 是前端路由，不重新加载页面），
所以不能在 preload 顶层判断 `location.hash.includes('/portal')`——那一刻还是 `#/login`。
判断要放到注入函数里，靠 MutationObserver 在路由切换后触发。

实测：

```
[test] 注入前: {"btn":true,"navLis":["Web入会","主持会议","任务中心","中文Englih","登出","邓桂保"]}
[logout] 收到门户「登出」请求
[test] 之后 → url = https://www.125339.com.cn/auth/SignIn | phase = login | 可见 = true
```

## URL 白名单：只显示"正经页面"

站点会经过一些中转/跳转页（`www.125339.com.cn/?status=login`、各种 OAuth 跳板），
直接显示出来体验很差。所以加了一道闸门：**只有命中白名单的页面才允许显示**。

```js
const URL_WHITELIST = ['r1.125339.com.cn', '/share/', 'conf.125339.com.cn', '/auth/SignIn'];
```

**做法是"先藏后显示"**，不是事后盖遮罩——中转页在 `did-navigate` 时就渲染完了，
再盖遮罩已经闪了一下。

| 时机 | 动作 |
| --- | --- |
| `did-start-navigation` 且目标非白名单 | 立刻 `win.hide()`（此时旧页面还没被替换） |
| 之后落到白名单页面 | `win.show()` |
| 2 秒后仍停在非白名单页面 | `show()` + 盖「加载中…」遮罩（避免窗口一直消失） |
| 子窗口（`show:false` 创建的） | 只在白名单页面才 `show()` |

跳到白名单页面后遮罩随新文档自然消失。

实测：

```
[gate] 门户 遮罩=false            url=conf.125339.com.cn/#/portal/...
[gate] 官网首页(非白名单) 遮罩=true  url=www.125339.com.cn/
[gate] 回到门户 遮罩=false         url=conf.125339.com.cn/#/portal/...
```

> 注意：如果你需要的某个页面（例如 www 上的某个授权页）不在白名单里，它会被遮住。
> 往 `URL_WHITELIST` 里加一条字符串即可。

## 日志与崩溃捕获

所有 `console.*` 会同时写进 **`userdata/app.log`**（5MB 轮转成 `app.log.1`），
出错时直接把这个文件发出来即可。

终端：`时:分:秒.毫秒 [标签] 内容`

```
21:08:35.472 [env] 应用 0.1.0 | electron 45.2.2 | chromium 156.0.8078.80
21:08:35.606 [tray] 已创建
21:08:36.073 [url] nav    win#1(main)  https://www.125339.com.cn/auth/SignIn
```

文件：`日期 时间 级别 [标签] 内容`

```
2026-11-04 21:08:35.472 INF [env] 应用 0.1.0 | electron 45.2.2 | chromium 156.0.8078.80
2026-11-04 21:08:35.612 WRN [portal] 没找到 xdg-desktop-portal 进程 → Wayland 下屏幕共享会失败
2026-11-04 21:08:36.073 INF [url] nav    win#1(main)  https://www.125339.com.cn/auth/SignIn
2026-11-04 20:54:07.751 ERR [crash] 主进程未捕获异常: ReferenceError: noBounce is not defined
```

降低噪音的几处处理：

- Chromium 自己的 stderr（dbus/drm/NSS）默认压掉（`--log-level=3`），`CHROME_LOG=1` 可恢复；
- 导航日志去掉 `did-start-navigation`（与 `did-navigate` 重复），同 URL 1.5 秒内只打一次；
- 真正的警告走 `console.warn`，文件里标 `WRN`；
- 启动时输出一段紧凑横幅（版本/系统/数据目录），不用再翻零散的 `[env]` 行。

同时接管了两类崩溃，**不再弹 GUI 错误框**：

```js
process.on('uncaughtException', (err) => console.error('[crash] 主进程未捕获异常:', err.stack));
process.on('unhandledRejection', (reason) => console.error('[crash] 未处理的 Promise 拒绝:', reason));
```

Electron 默认会给主进程未捕获异常弹「A JavaScript error occurred in the main process」，
装了监听就只剩日志。

渲染进程里的 JS 错误也会转发过来（每个页面最多 20 条，防刷屏）：

```
[error] [renderer-error @conf.125339.com.cn/webrtc/...] xxx is not a function (index.js:123)
```

只输出到终端、不落盘：`LOG_FILE=0 npm start`。

## 运行日志：每个窗口的 URL

所有窗口（主窗、子窗、分享窗）的导航都会打印到终端，不需要任何环境变量：

```
[url] start  win#1(main)  https://www.125339.com.cn/auth/SignIn
[url] nav    win#1(main)  https://www.125339.com.cn/auth/SignIn
[url] start  win#1(main)  https://conf.125339.com.cn/?lang=zh-CN&customer=chinamobile&nonce=<hidden>#/login
[url] inpage win#1(main)  https://conf.125339.com.cn/#/portal/cmp/user/conference/conference-list?...
[url] window win#2         https://yunshixun.125339.com.cn/share/...
```

| 字段 | 含义 |
| --- | --- |
| `start` / `nav` / `inpage` | 开始加载 / 主框架跳转完成 / SPA 内（hash）跳转 |
| `window` | 新窗口创建 |
| `win#N(main)` | 窗口 ID，`(main)` 表示主窗口 |

`nonce` 会打码成 `nonce=<hidden>`（那是一次性登录凭证，不落日志）。
相同事件 800ms 内会去重，避免刷屏。

## 打包

已配好 electron-builder，命令三条：

```bash
npm run dist:dir     # 只解包到 dist/linux-unpacked，用来验证配置，最快
npm run dist:linux   # 生成 AppImage + deb
npm run dist:win     # 生成 Windows 安装包（需要在 Windows 上跑，或 Linux 装 wine）
```

首次打包会下载 Electron 二进制和 app-builder（约 200MB），国内建议先设镜像：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

配置在 `package.json` 的 `build` 字段：

| 项 | 值 |
| --- | --- |
| appId | `com.chinamobile.yunshixun.shell` |
| productName | 移动会议 |
| 图标 | `assets/icon.png`（512×512，源图 `assets/icon-src.png` 256×256） |
| 包含文件 | `electron/**`、`assets/**`、`package.json` |
| Linux 目标 | AppImage + deb |

两个打包相关的代码处理：

- **打包后数据目录改成系统标准位置**（`~/.config/yunshixun-desktop`）——
  asar 是只读的，开发时用的 `./userdata` 在安装包里写不进去；
- **打包后的 Linux 自动加 `--no-sandbox`**：AppImage 里的 `chrome-sandbox` 拿不到 root 权限，
  不加会直接启动失败。

### 构建产物

```bash
npm run dist:linux
```

| 产物 | 大小 | 说明 |
| --- | --- | --- |
| `dist/yunshixun-desktop-0.1.0-x86_64.AppImage` | ~120MB | 免安装，`chmod +x` 后直接运行 |
| `dist/yunshixun-desktop-0.1.0-amd64.deb` | ~97MB | `sudo apt install ./xxx.deb` |

**安装路径是纯 ASCII 的 `/opt/yunshixun-desktop/`**（`productName` 用英文，中文只出现在启动器的显示名
`Name=移动会议` 上）。

图标来源是项目根目录的 `app-icon.png`（128×128），做两件事：

- 生成 16～512 全尺寸装到 `/usr/share/icons/hicolor/*/apps/`；
- 用 `extraFiles` 原样放到 `/opt/yunshixun-desktop/app-icon.png`，
  并让 `.desktop` 的 `Icon=` 直接指向这个**绝对路径**：

  ```ini
  Icon=/opt/yunshixun-desktop/app-icon.png
  ```

  比依赖图标主题查找更可靠——主题名找不到时启动器就是空白。

deb 元信息（已实测）：

```
Package: yunshixun-desktop        Architecture: amd64
Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6,
         xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0
Recommends: libappindicator3-1
Homepage: https://www.125339.com.cn
```

装到 `/opt/yunshixun-desktop/`，自带 `.desktop` 并声明 `MimeType=x-scheme-handler/ysx;`。

**首次构建会下载 fpm/7zip 到 `~/.cache/electron-builder`**，如果该目录不可写会报
`ENOENT: mkdir .../fpm@xxx`，设 `ELECTRON_BUILDER_CACHE=/path` 指到可写目录即可。

## 结构

```
electron/
  main.js             # 主流程：窗口生命周期、登录/门户切换、导航守卫、托盘、单实例
  preload.js          # 页面适配：登录页精简、暗色残留、分享页、入会页自动填表/点击
  config.js           # 配置与启动引导（userData、命令行开关、站点常量、环境变量）
  store.js            # 本地持久化：token 缓存、记住的账号密码、状态文件
  meeting-url.js      # 纯函数：从文本/ysx 链接里解析会议地址与会议号
  clipboard-watch.js  # 剪贴板轮询，命中会议就回调
  ysx-protocol.js     # ysx:// 协议注册（写 .desktop + xdg-settings）
  window-utils.js     # 窗口尺寸换算与放大动画
  display-media.js    # 屏幕共享（getDisplayMedia）接管
assets/               # 图标
docs/可行性分析.md     # 完整分析：实测结论、能力边界、风险、工作量、合规
screenshots/          # 实测截图
```

`main.js` 1500 行左右，剩下的是**强耦合的主流程**（窗口创建、登录态流转、门户入口），
再拆需要先把共享状态（`win` / `phase` / 登录态）收拢成一个 context 对象。

## 已验证 / 未验证

- ✅ 小窗 420×560 登录，滑块验证需人工拖（反自动化风控，未绕过）
- ✅ 登录成功后同一窗口放大到 1280×820（320ms 缓动）
- ✅ 截住动态 nonce 地址，同窗加载后**真实账号直接进入门户「我的会议」**
- ✅ 网页会议端 `/webrtc/` 正常渲染；`getUserMedia` / `getDisplayMedia` 可用
- ⏳ 进入真实会议后的音视频、屏幕共享（需要一场真实会议）
- ⏳ 你们租户是否开通网页入会 `supportWebRtc`（决定"能不能开会"）

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DISABLE_TOKEN=1` | 启动时清空本地登录态（缓存 token + Cookie + localStorage），强制走一次完整登录；同时禁用"用缓存 token 静默重进" |


| 变量 | 作用 |
| --- | --- |
| `APP_USER_DATA=/path` | 指定用户数据目录（绿色版/多开/测试） |
| `LOGIN_ORIGIN=conf` | 改用门户自带登录路由（默认走 www 统一登录） |
| `AUTO_ENTER=0` | 不代点菜单：只把窗口放大到工作台，用户自己点「会议服务 → 移动会议」（同样会被接住） |
| `NO_GPU=1` | 关闭硬件加速（软件渲染）。显卡驱动异常、画面撕裂/卡死时用 |
| `LOG_RENDERER=1` | 把所有页面的渲染进程告警转发到终端（会议页默认开启） |
| `DISPLAY_MEDIA=off` | 不接管屏幕共享（页面调 getDisplayMedia 直接失败），用来排查卡死 |
| `DISPLAY_MEDIA=system` | 交给系统选择器（macOS 15+ / 支持 portal 的环境） |
| `SHOT_DIR=/path` | 冒烟测试：自动截图并退出 |
| `SMOKE_LIVE=毫秒` | 跑真实流程 N 毫秒后截图退出（配合 `SHOT_DIR`） |
