'use strict';
/**
 * LensIt 主进程：托盘/热键/框选窗口/放大镜窗口，并负责拉起后端服务（Express 子进程）。
 * 渲染层（前端）通过 preload 桥 + HTTP API 与后端（Express + SQLite）通信。
 */
const {
  app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain,
  desktopCapturer, screen, nativeImage, session,
} = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3777);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'server', 'index.js');
const SELFTEST = process.argv.includes('--selftest');
const ST_OUT = path.join(ROOT, 'selftest-out');

const log = (msg) => {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  if (SELFTEST) { try { fs.mkdirSync(ST_OUT, { recursive: true }); fs.appendFileSync(path.join(ST_OUT, 'selftest.log'), line + '\n'); } catch {} }
};

// ---------------- HTTP 小工具（主进程内访问后端 API） ----------------
const api = (method, urlPath, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request(`${BASE}${urlPath}`, {
    method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    timeout: 4000,
  }, res => {
    let buf = '';
    res.on('data', c => { buf += c; });
    res.on('end', () => {
      try { resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); }
      catch { resolve({ status: res.statusCode, body: buf }); }
    });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});
const healthOk = () => api('GET', '/api/health').then(r => r.body && r.body.ok).catch(() => false);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------- 后端子进程管理 ----------------
let serverChild = null;

async function ensureServer() {
  if (await healthOk()) { log('后端已在运行，直接复用'); return true; }
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const trySpawn = (args) => {
    log(`启动后端: node ${args.join(' ')}`);
    const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
    return child;
  };
  // node:sqlite 在部分 Node 版本需要 --experimental-sqlite；flag 不存在则该进程立刻退出，降级重试
  serverChild = trySpawn(['--experimental-sqlite', SERVER_JS]);
  const earlyExit = new Promise(resolve => serverChild.once('exit', code => resolve(code)));
  const stayedAlive = await Promise.race([earlyExit.then(c => ({ exited: c })), sleep(1500).then(() => ({ alive: true }))]);
  if (stayedAlive.exited !== undefined) {
    log(`带 flag 启动失败(exit=${stayedAlive.exited})，改用无 flag 启动`);
    serverChild = trySpawn([SERVER_JS]);
  }
  for (let i = 0; i < 40; i++) {
    if (await healthOk()) { log('后端就绪'); return true; }
    await sleep(150);
  }
  log('错误: 后端 6 秒内未就绪');
  return false;
}

// ---------------- 窗口 ----------------
let tray = null;
let selectWin = null;
let overlayWin = null;
let consoleWin = null;
let hotkeyAccel = 'Ctrl+Alt+L';

function displayForWindow(win) {
  return screen.getDisplayNearestPoint({
    x: win.getBounds().x + 8, y: win.getBounds().y + 8,
  });
}

function startSelection() {
  if (overlayWin) { overlayWin.focus(); return; }
  if (selectWin) { selectWin.focus(); return; }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  selectWin = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y,
    width: display.bounds.width, height: display.bounds.height,
    frame: false, transparent: true, resizable: false, movable: false,
    skipTaskbar: true, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  selectWin.setAlwaysOnTop(true, 'screen-saver');
  selectWin.once('ready-to-show', () => selectWin.show());
  selectWin.on('closed', () => { selectWin = null; });
  selectWin.loadFile(path.join(ROOT, 'frontend', 'select.html'));
}

async function openOverlay(display, regionCss, settings) {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  const source = sources.find(s => s.display_id === String(display.id)) || sources[0];
  if (!source) { log('错误: 未找到屏幕采集源'); return; }

  overlayWin = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y,
    width: display.bounds.width, height: display.bounds.height,
    frame: false, transparent: true, resizable: false, movable: false,
    skipTaskbar: true, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setContentProtection(true); // 关键：把自己从屏幕采集中排除，避免“镜中镜”
  overlayWin.once('ready-to-show', () => overlayWin.show());
  overlayWin.on('closed', () => { overlayWin = null; broadcast('history-changed'); });
  overlayWin.on('focus', () => overlayWin.webContents.send('session-focus'));

  await overlayWin.loadFile(path.join(ROOT, 'frontend', 'overlay.html'));
  overlayWin.webContents.send('session-start', {
    sourceId: source.id,
    baseUrl: BASE,
    displayId: display.id,
    displayPhys: {
      w: Math.round(display.bounds.width * display.scaleFactor),
      h: Math.round(display.bounds.height * display.scaleFactor),
    },
    region: regionCss, // 相对屏幕左上角的 CSS px
    settings,
  });
}

function openConsole() {
  if (consoleWin) { consoleWin.focus(); return; }
  consoleWin = new BrowserWindow({
    width: 820, height: 640, minWidth: 640, minHeight: 480,
    title: 'LensIt 控制台',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  consoleWin.on('closed', () => { consoleWin = null; });
  consoleWin.loadFile(path.join(ROOT, 'frontend', 'console.html'));
}

function broadcast(ch, payload) {
  if (consoleWin && !consoleWin.isDestroyed()) consoleWin.webContents.send(ch, payload);
}

// ---------------- 热键 / 托盘 ----------------

async function applyHotkey() {
  const r = await api('GET', '/api/settings').catch(() => null);
  if (r && r.body && typeof r.body.hotkey === 'string') hotkeyAccel = r.body.hotkey;
  globalShortcut.unregisterAll();
  const okMain = globalShortcut.register(hotkeyAccel, () => startSelection());
  const okConsole = globalShortcut.register('Ctrl+Alt+H', () => openConsole());
  log(`热键注册: 标注=${hotkeyAccel}(${okMain ? 'ok' : '失败'}) 控制台=Ctrl+Alt+H(${okConsole ? 'ok' : '失败'})`);
  return okMain;
}

function createTray() {
  const iconPath = path.join(ROOT, 'assets', 'icon.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon.isEmpty() ? undefined : icon);
  tray.setToolTip('LensIt 放大镜标注');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `开始标注（${hotkeyAccel}）`, click: () => startSelection() },
    { label: '控制台（设置 / 历史）', click: () => openConsole() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('double-click', () => startSelection());
}

// ---------------- IPC ----------------

ipcMain.on('start-selection', () => startSelection());
ipcMain.on('open-console', () => openConsole());

ipcMain.on('select-done', async (_e, rectCss) => {
  const display = selectWin ? displayForWindow(selectWin) : screen.getPrimaryDisplay();
  if (selectWin) { selectWin.destroy(); selectWin = null; }
  if (!rectCss || rectCss.w < 16 || rectCss.h < 16) return;
  const r = await api('GET', '/api/settings').catch(() => ({ body: {} }));
  await openOverlay(display, rectCss, r.body || {});
});

ipcMain.on('select-cancel', () => { if (selectWin) { selectWin.destroy(); selectWin = null; } });

ipcMain.on('session-closed', () => { if (overlayWin) { overlayWin.destroy(); overlayWin = null; } });
ipcMain.on('session-saved', (_e, info) => {
  log(`标注已保存: #${info && info.id}`);
  broadcast('history-changed');
});

ipcMain.on('settings-changed', async () => {
  await applyHotkey();
  if (overlayWin) {
    const r = await api('GET', '/api/settings').catch(() => null);
    if (r && r.body) overlayWin.webContents.send('settings-updated', r.body);
  }
});

ipcMain.on('selftest-saved', async (_e, info) => { selftestSaved = info; });

// ---------------- 自测 ----------------
let selftestSaved = null;

async function runSelfTest() {
try {
  fs.rmSync(ST_OUT, { recursive: true, force: true });
  fs.mkdirSync(ST_OUT, { recursive: true });
  log('selftest: 开始（固定区域，不经过框选窗口）');
  const d = screen.getPrimaryDisplay();
  const w = Math.min(560, Math.round(d.bounds.width * 0.35));
  const h = Math.round(w * 0.7);
  const regionCss = {
    x: Math.round((d.bounds.width - w) / 2),
    y: Math.round((d.bounds.height - h) / 2),
    w, h,
  };
  const r = await api('GET', '/api/settings');
  log(`selftest: settings=${JSON.stringify(r.body)}`);
  await openOverlay(d, regionCss, r.body);

  // 等待 session-ready
  const ready = await waitFor(() => sessionReadyFlag, 8000);
  if (!ready) { log('selftest: FAIL 放大镜窗口未就绪（无 session-ready）'); app.exit(1); return; }
  const wc = overlayWin.webContents;
  const cx = regionCss.x + regionCss.w / 2, cy = regionCss.y + regionCss.h / 2;
  const shot = async name => {
    try {
      const img = await Promise.race([wc.capturePage(), sleep(5000).then(() => null)]);
      if (!img) { log(`selftest: 截图 ${name} 超时，跳过`); return; }
      fs.writeFileSync(path.join(ST_OUT, name), img.toPNG());
      log(`selftest: 截图 ${name} (${img.getSize().width}x${img.getSize().height})`);
    } catch (e) { log(`selftest: 截图 ${name} 失败: ${e.message}`); }
  };
  const mouse = ev => { try { wc.sendInputEvent(ev); } catch (e) { log(`selftest: sendInputEvent 失败: ${e.message}`); } };

  mouse({ type: 'mouseMove', x: Math.round(cx - 120), y: Math.round(cy - 60) });
  await sleep(500); await shot('1-lens.png');
  mouse({ type: 'mouseMove', x: Math.round(cx + 100), y: Math.round(cy + 40) });
  await sleep(400); await shot('2-lens-moved.png');
  mouse({ type: 'mouseWheel', x: Math.round(cx + 100), y: Math.round(cy + 40), deltaY: -240 });
  await sleep(400); await shot('3-lens-zoomed.png');

  log('selftest: 单击冻结 → 标记模式');
  mouse({ type: 'mouseDown', x: Math.round(cx + 100), y: Math.round(cy + 40), button: 'left', clickCount: 1 });
  await sleep(80);
  mouse({ type: 'mouseUp', x: Math.round(cx + 100), y: Math.round(cy + 40), button: 'left', clickCount: 1 });
  log('selftest: 单击已发送');
  await sleep(400);
  let lastX = Math.round(cx + 100), lastY = Math.round(cy + 40);
  // 重新按住左键拖动 = 画笔涂写
  mouse({ type: 'mouseDown', x: lastX, y: lastY, button: 'left', clickCount: 1 });
  await sleep(80);
  for (let i = 0; i <= 10; i++) {
    lastX = Math.round(cx - 140 + i * 28);
    lastY = Math.round(cy - 40 + Math.sin(i / 2) * 60);
    mouse({ type: 'mouseMove', x: lastX, y: lastY });
    await sleep(70);
  }
  mouse({ type: 'mouseUp', x: lastX, y: lastY, button: 'left', clickCount: 1 });
  await sleep(300); await shot('4-pen.png');

  log('selftest: 保存会话到后端');
  wc.send('selftest-save');
  const saved = await waitFor(() => selftestSaved, 8000);
  if (!saved || !selftestSaved.ok) { log('selftest: FAIL 保存失败'); app.exit(1); return; }
  const list = await api('GET', '/api/sessions?limit=5');
  const row = list.body && list.body[0];
  const snapExists = row && row.snapshot ? fs.existsSync(path.join(ROOT, 'data', row.snapshot.replace(/^\//, ''))) : false;
  log(`selftest: 落库 id=${row && row.id} strokes=${row ? row.strokes.length : '?'} 快照文件=${snapExists}`);
  await shot('5-after-save.png');

  log('selftest: 右键 → 取消标记，回放大镜');
  mouse({ type: 'mouseDown', x: lastX, y: lastY, button: 'right', clickCount: 1 });
  await sleep(60);
  mouse({ type: 'mouseUp', x: lastX, y: lastY, button: 'right', clickCount: 1 });
  await sleep(400); await shot('6-back-to-lens.png');

  const pass = row && row.strokes.length > 0 && snapExists;
  log(`selftest: ${pass ? 'PASS' : 'FAIL'}`);
  app.exit(pass ? 0 : 1);
} catch (e) {
  log('selftest: 异常 ' + (e && e.stack || e));
  app.exit(1);
}
}

let sessionReadyFlag = false;
ipcMain.on('session-ready', () => { sessionReadyFlag = true; });

async function waitFor(fn, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await sleep(120);
  }
  return fn();
}

// ---------------- 生命周期 ----------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('LensIt 已在运行');
  app.quit();
} else {
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      callback(permission === 'media'); // 放大镜需要屏幕采集
    });
    const ok = await ensureServer();
    if (!ok && !SELFTEST) log('警告: 后端不可用，历史/设置功能将不可用');
    await applyHotkey();
    createTray();
    if (SELFTEST) runSelfTest();
    else openConsole();
  });

  app.on('second-instance', () => { if (consoleWin) consoleWin.focus(); else openConsole(); });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (serverChild) { try { serverChild.kill(); } catch {} }
  });
}
