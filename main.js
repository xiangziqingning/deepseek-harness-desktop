// DeepSeek Harness 桌面版 —— Electron shell
// 用打包进来的 @deepseek-ai/dsh 启动器，通过 ELECTRON_RUN_AS_NODE 跑 "dsh web"，
// 等 Web 服务起来后，把 DeepSeek Harness 界面装入原生窗口。
const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const updater = require('./update-ipc');

let serverChild = null;
let win = null;
const PORT = 3090; // 与打包 home 的 cordis.patch.yml 保持一致，避免和浏览器里的 3080 冲突

function startServer() {
  const root = __dirname;
  const launcher = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const home = path.join(root, 'home');
  const nodeExe = path.join(root, 'node.exe');   // 打包进的自带 Node 24（DSH 需要 Node 22+ 的 zlib/module 新 API）
  if (!fs.existsSync(nodeExe)) { console.error('missing bundled node.exe'); return false; }
  if (!fs.existsSync(launcher)) { console.error('missing launcher: ' + launcher); return false; }
  const env = Object.assign({}, process.env, { DSH_HOME: home });
  // 用自带 Node 24 跑 dsh web，关闭自动开浏览器（我们自建窗口）
  serverChild = spawn(nodeExe, [launcher, '--profile', 'web', '--no-open'], { env, stdio: 'ignore' });
  serverChild.on('error', (e) => console.error('spawn error: ' + e.message));
  return true;
}

// 轮询等待 Web 服务就绪
function waitFor(port, timeoutMs) {
  return new Promise(resolve => {
    const deadline = Date.now() + (timeoutMs || 60000);
    (function poll() {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, res => { res.resume(); resolve(true); });
      req.on('error', () => { if (Date.now() > deadline) resolve(false); else setTimeout(poll, 1000); });
      req.on('timeout', () => { req.destroy(); });
    })();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 700,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  return win;
}

function buildMenu() {
  const template = [
    { label: '应用', submenu: [
      { label: '检查更新', click: async () => {
          const r = await updater.check();
          if (r && r.state === 'available') {
            const c = await dialog.showMessageBox(win, { type: 'info', buttons: ['现在更新','稍后'], title: '发现新版本', message: '发现新版本 v' + r.latest + '（当前 v' + r.current + '）', detail: (r.notes||'') });
            if (c.response === 0) updater.applyUpdate(win);
          } else {
            dialog.showMessageBox(win, { type: 'info', title: '检查更新', message: r && r.state === 'error' ? (r.message||'检查失败') : '已是最新版本 v' + (r && r.current || updater.currentVersion()) });
          }
        } },
      { role: 'reload' }, { role: 'toggleDevTools' }, { role: 'quit' }
    ]}
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const LOADING_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><html><head><meta charset="utf-8"><style>' +
  'html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center;background:#0b1220;color:#cfe0ff;font-family:-apple-system,"Microsoft YaHei",sans-serif}' +
  '.wrap{text-align:center}.spin{width:56px;height:56px;margin:0 auto 24px;border:4px solid rgba(77,141,255,.2);border-top-color:#4D8DFF;border-radius:50%;animation:spin 1s linear infinite}' +
  'h1{font-size:18px;font-weight:600;margin:0}.p{margin-top:10px;font-size:13px;color:#8aa3c8}.bar{width:260px;height:6px;margin:22px auto 0;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden}' +
  '.fill{width:0;height:100%;background:linear-gradient(90deg,#4D8DFF,#7B5CFF);border-radius:999px;animation:load 2.4s ease-in-out infinite}' +
  '@keyframes spin{to{transform:rotate(360deg)}}@keyframes load{0%{width:8%}50%{width:70%}100%{width:8%}}' +
  '</style></head><body><div class="wrap"><div class="spin"></div>' +
  '<h1>正在启动 DeepSeek Harness…</h1><p class="p">首次启动需初始化本地运行时，稍稍等待</p>' +
  '<div class="bar"><div class="fill"></div></div></div></body></html>'
);

app.whenReady().then(async () => {
  win = createWindow();
  win.loadURL(LOADING_PAGE);   // 立即显示加载页，避免空白“卡住”
  buildMenu();
  updater.register();
  updater.startAutoCheck(win);   // 后台自更新：发现新版弹窗询问
  const ok = startServer();
  if (ok) {
    const up = await waitFor(PORT, 90000);
    if (up) {
      win.loadURL('http://127.0.0.1:' + PORT);
    } else {
      win.loadDataURL('<html><body style="font-family:sans-serif;padding:40px"><h2>DeepSeek Harness 未能启动</h2><p>端口 ' + PORT + ' 未就绪。请重启软件再试。</p></body></html>');
    }
  } else {
    win.loadDataURL('<html><body style="font-family:sans-serif;padding:40px"><h2>缺少运行组件</h2><p>未找到打包的 dsh。</p></body></html>');
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (serverChild) { try { serverChild.kill(); } catch (e) {} }
  app.quit();
});
app.on('before-quit', () => {
  if (serverChild) { try { serverChild.kill(); } catch (e) {} }
});
