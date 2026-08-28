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

app.whenReady().then(async () => {
  const ok = startServer();
  win = createWindow();
  buildMenu();
  updater.register();
  updater.startAutoCheck(win);   // 后台自更新：发现新版弹窗询问
  if (ok) {
    const up = await waitFor(PORT);
    if (up) {
      win.loadURL('http://127.0.0.1:' + PORT);
    } else {
      win.loadDataURL('<html><body style="font-family:sans-serif"><h2>DeepSeek Harness 未能启动</h2><p>请重试。端口 ' + PORT + ' 未就绪。</p></body></html>');
    }
  } else {
    win.loadDataURL('<html><body style="font-family:sans-serif"><h2>缺少运行组件</h2><p>未找到打包的 dsh。</p></body></html>');
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
