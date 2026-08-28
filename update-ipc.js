// DeepSeek Harness 桌面版 —— 自更新器（GitHub Releases 方案，自动下载+校验+原子替换）
// 在 electron 主进程里运行；定期检查新版本，有新版则询问并自动下载替换 resources\app。
const { app, dialog, ipcMain } = require('electron');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DEFAULT = { owner: '<你的GitHub用户名>', repo: 'deepseek-harness-desktop', checkMs: 6*60*60*1000, timeoutMs: 30000, maxRetries: 3 };
let cfg = Object.assign({}, DEFAULT);
function loadConfig() {
  try {
    const f = path.join(path.dirname(process.execPath), 'update-config.json');
    if (fs.existsSync(f)) cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(f, 'utf8')));
  } catch (e) {}
}
function currentVersion() { try { return require('./package.json').version; } catch (e) { return '1.0.0'; } }
function semver(a, b) { const p=(v)=>String(v||'').replace(/^v/i,'').split('.').map(Number); a=p(a); b=p(b); for(let i=0;i<3;i++){ if((a[i]||0)>(b[i]||0))return 1; if((a[i]||0)<(b[i]||0))return -1;} return 0; }

function httpReq(url, { headers={}, timeout=cfg.timeoutMs, redirects=5, method='GET' } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    const req = mod.request(url, { method, headers: Object.assign({ 'User-Agent': 'dsh-desktop-updater' }, headers), timeout }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).toString();
        resolve(httpReq(next, { headers, timeout, redirects: redirects-1, method }));
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}
function readBody(res) { return new Promise((resolve, reject) => { let b=''; res.on('data', c=>b+=c); res.on('end', ()=>resolve(b)); res.on('error', reject); }); }
async function getJson(url) {
  const res = await httpReq(url, { headers: { 'Accept': 'application/vnd.github+json' } });
  const b = await readBody(res);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error('HTTP '+res.statusCode);
  return JSON.parse(b.replace(/^\uFEFF/, ''));
}
function sha512File(p) { return new Promise((res, rej) => { const h=crypto.createHash('sha512'); const s=fs.createReadStream(p); s.on('data', d=>h.update(d)); s.on('end', ()=>res(h.digest('hex'))); s.on('error', rej); }); }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// 带重试+断点续传的下载
async function download(url, dest, { sha512=null, onProgress=null }={}) {
  const part = dest + '.part';
  let resume = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const headers = { 'User-Agent': 'dsh-desktop-updater' };
  if (resume > 0) headers['Range'] = 'bytes=' + resume + '-';
  const res = await httpReq(url, { headers });
  if (![200,206,416].includes(res.statusCode)) { res.resume(); throw new Error('下载失败 HTTP '+res.statusCode); }
  if (res.statusCode === 200) resume = 0;
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(part, { flags: resume>0 && res.statusCode===206 ? 'a' : 'w' });
    let got = resume, total = 0;
    if (res.headers['content-length']) total = resume + parseInt(res.headers['content-length'], 10);
    const cr = res.headers['content-range']; if (cr) { const m = cr.match(/\/(\d+)$/); if (m) total = parseInt(m[1], 10); }
    res.on('data', c => { got += c.length; if (onProgress) onProgress(got, total||0); });
    res.pipe(ws);
    ws.on('finish', () => ws.close(async () => {
      try {
        if (sha512) { const gotS = await sha512File(part); if (gotS.toLowerCase() !== String(sha512).toLowerCase()) { fs.rmSync(part, { force: true }); reject(new Error('校验失败')); return; } }
        fs.rmSync(dest, { force: true }); fs.renameSync(part, dest); resolve({ size: got });
      } catch (e) { reject(e); }
    }));
    ws.on('error', reject); res.on('error', reject);
  });
}

async function fetchLatest() {
  if (!cfg.owner || cfg.owner.startsWith('<')) throw { friendly: '未配置更新源，请在 exe 同目录的 update-config.json 里填写 owner/repo' };
  const api = 'https://api.github.com';
  const rel = await getJson(`${api}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/releases/latest`);
  const manAsset = (rel.assets||[]).find(a => a.name === 'latest.json');
  if (!manAsset) throw new Error('发布版缺少 latest.json');
  const man = JSON.parse((await readBody(await httpReq(manAsset.browser_download_url))).replace(/^\uFEFF/, ''));
  const assetMap = {}; (rel.assets||[]).forEach(a => assetMap[a.name] = a.browser_download_url);
  return {
    version: man.version, notes: man.notes || '', releaseUrl: rel.html_url,
    files: (man.files||[]).map(f => Object.assign({}, f, { url: assetMap[f.name] })).filter(f => !!f.url)
  };
}

let lastRes = null;
async function check({ silent=false }={}) {
  const cur = currentVersion();
  try {
    const man = await fetchLatest();
    const file = (man.files||[]).find(f => /\.zip$/i.test(f.name) || man.files[0]);
    const newer = semver(man.version, cur) > 0;
    lastRes = { state: newer && file ? 'available' : 'upToDate', current: cur, latest: man.version, notes: man.notes, releaseUrl: man.releaseUrl, url: file && file.url, sha512: file && file.sha512, size: file && file.size };
    return lastRes;
  } catch (e) {
    if (e && e.friendly) { lastRes = { state: 'error', message: e.friendly }; return lastRes; }
    lastRes = { state: 'error', message: '检查更新失败：' + (e && e.message || '网络异常') };
    return lastRes;
  }
}

// 下载并应用更新：替换 resources\app 文件夹
async function applyUpdate(win) {
  const r = lastRes;
  if (!r || r.state !== 'available' || !r.url) return { ok: false, error: '没有可用更新' };
  const appDir = app.getAppPath();               // .../resources/app
  const updDir = path.join(os.tmpdir(), 'dsh-upd-' + Date.now());
  const zip = path.join(updDir, 'update.zip');
  fs.mkdirSync(updDir, { recursive: true });
  let ok = false, lastErr;
  for (let i=0;i<=cfg.maxRetries && !ok;i++) {
    try { await download(r.url, zip, { sha512: r.sha512 }); ok = true; }
    catch (e) { lastErr = e; await sleep(Math.min(1500*Math.pow(2,i), 8000)); }
  }
  if (!ok) { fs.rmSync(updDir, { recursive: true, force: true }); return { ok: false, error: '下载失败：' + (lastErr&&lastErr.message||'') }; }
  // 解压到临时（新包根应是 app 内容，或 dist 目录）
  const extractDir = path.join(updDir, 'x');
  fs.mkdirSync(extractDir, { recursive: true });
  try {
    await extract(zip, extractDir);
    // 找到真正的 app 内容：可能 zip 内含 resources\app，也可能直接是 app 内容
    let newApp;
    const cand1 = path.join(extractDir, 'resources', 'app');
    const cand2 = extractDir;
    newApp = fs.existsSync(path.join(cand2, 'main.js')) ? cand2 : (fs.existsSync(cand1) ? cand1 : cand2);
    // 原子替换 resources\app
    const bak = appDir + '.bak';
    fs.rmSync(bak, { recursive: true, force: true });
    fs.rmSync(appDir+'.old', { recursive: true, force: true });
    fs.renameSync(appDir, appDir + '.old');
    fs.renameSync(newApp, appDir);
    fs.rmSync(appDir + '.old', { recursive: true, force: true });
  } catch (e) {
    try { if (fs.existsSync(appDir+'.old') && !fs.existsSync(appDir)) fs.renameSync(appDir+'.old', appDir); } catch (e2) {}
    fs.rmSync(updDir, { recursive: true, force: true });
    return { ok: false, error: '安装失败：' + e.message };
  }
  fs.rmSync(updDir, { recursive: true, force: true });
  setTimeout(() => { try { app.relaunch(); app.exit(0); } catch (e) { app.relaunch(); } }, 700);
  return { ok: true, version: r.latest };
}

// 解压 zip（用系统 tar 或 powershell Expand-Archive）
function extract(zip, dest) {
  return new Promise((resolve, reject) => {
    // Windows 10+ 自带 tar
    execFile('tar.exe', ['-xf', zip, '-C', dest], (err) => {
      if (!err) return resolve();
      execFile('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`], (e2) => e2 ? reject(e2) : resolve());
    });
  });
}

function register() {
  loadConfig();
  ipcMain.handle('upd:check', () => check());
  ipcMain.handle('upd:apply', (e, { win }) => applyUpdate(win));
  ipcMain.handle('upd:status', () => lastRes);
  ipcMain.handle('upd:version', () => currentVersion());
  ipcMain.handle('upd:config', () => ({ configured: !(cfg.owner.startsWith('<')), owner: cfg.owner, repo: cfg.repo }));
}

function startAutoCheck(win) {
  setTimeout(async () => {
    const r = await check({ silent: true });
    if (r && r.state === 'available') {
      const { dialog } = require('electron');
      const choice = await dialog.showMessageBox(win, {
        type: 'info', buttons: ['现在更新', '稍后'],
        title: '发现新版本', message: 'DeepSeek Harness 有新版本 v' + r.latest + '（当前 v' + r.current + '）', detail: (r.notes||'') + '\n\n是否现在下载并更新？'
      });
      if (choice.response === 0) applyUpdate(win);
    }
  }, 10000);
  setInterval(async () => { const r = await check({ silent: true }); }, cfg.checkMs);
}

module.exports = { register, startAutoCheck, check, applyUpdate, currentVersion, cfg, loadConfig };
