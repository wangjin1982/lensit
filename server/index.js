'use strict';
/**
 * LensIt 后端服务
 * - REST API：设置 / 标注会话（历史）
 * - 数据库：优先 Node 内置 node:sqlite（22.5+，零原生依赖），不可用时降级为 JSON 文件存储
 * - 快照图片落盘 data/snapshots，通过 /snapshots 静态访问
 */
const path = require('path');
const fs = require('fs');
const express = require('express');

const PORT = Number(process.env.PORT || 3777);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'lensit.db');
const JSON_STORE = path.join(DATA_DIR, 'store.json');

fs.mkdirSync(SNAP_DIR, { recursive: true });

// ---------------- 存储层 ----------------

function createSqliteStore() {
  const { DatabaseSync } = require('node:sqlite'); // 缺失/需 flag 时抛错 → 走 JSON 降级
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      region_x   INTEGER NOT NULL,
      region_y   INTEGER NOT NULL,
      region_w   INTEGER NOT NULL,
      region_h   INTEGER NOT NULL,
      zoom       REAL    NOT NULL DEFAULT 3,
      strokes    TEXT    NOT NULL DEFAULT '[]',
      snapshot   TEXT,
      note       TEXT    NOT NULL DEFAULT ''
    );
  `);
  return {
    name: 'sqlite',
    getSettings() {
      return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
    },
    setSetting(key, value) {
      db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(key, value);
    },
    insertSession(s) {
      const r = db.prepare(
        'INSERT INTO sessions(region_x, region_y, region_w, region_h, zoom, strokes, snapshot, note) VALUES(?,?,?,?,?,?,?,?)'
      ).run(s.region.x, s.region.y, s.region.w, s.region.h, s.zoom, JSON.stringify(s.strokes), s.snapshot || null, s.note || '');
      return Number(r.lastInsertRowid);
    },
    getSession(id) {
      return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    },
    listSessions(limit) {
      return db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT ?').all(limit);
    },
    deleteSession(id) {
      const row = this.getSession(id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return row;
    },
  };
}

function createJsonStore() {
  let store = { settings: {}, sessions: [], nextId: 1 };
  if (fs.existsSync(JSON_STORE)) store = JSON.parse(fs.readFileSync(JSON_STORE, 'utf8'));
  const save = () => fs.writeFileSync(JSON_STORE, JSON.stringify(store, null, 2));
  return {
    name: 'json',
    getSettings() { return { ...store.settings }; },
    setSetting(key, value) { store.settings[key] = value; save(); },
    insertSession(s) {
      const id = store.nextId++;
      store.sessions.push({
        id,
        created_at: new Date().toLocaleString('zh-CN', { hour12: false }),
        region_x: s.region.x, region_y: s.region.y, region_w: s.region.w, region_h: s.region.h,
        zoom: s.zoom, strokes: JSON.stringify(s.strokes), snapshot: s.snapshot || null, note: s.note || '',
      });
      save();
      return id;
    },
    getSession(id) { return store.sessions.find(s => s.id === Number(id)); },
    listSessions(limit) {
      return [...store.sessions].sort((a, b) => b.id - a.id).slice(0, limit);
    },
    deleteSession(id) {
      const i = store.sessions.findIndex(s => s.id === Number(id));
      const row = i >= 0 ? store.sessions[i] : null;
      if (i >= 0) { store.sessions.splice(i, 1); save(); }
      return row;
    },
  };
}

let store;
try { store = createSqliteStore(); }
catch (e) {
  store = createJsonStore();
  console.warn(`[lensit-server] node:sqlite 不可用（${e.message}），降级为 JSON 存储: ${JSON_STORE}`);
}
console.log(`[lensit-server] 存储后端: ${store.name}`);

// ---------------- API ----------------

const DEFAULT_SETTINGS = {
  hotkey: 'Ctrl+Alt+L',   // 开始标注热键
  lensRadius: 150,        // 放大镜半径（CSS px）
  zoom: 3,                // 默认放大倍率
  penColor: '#ff4d4f',    // 默认画笔颜色
  penWidth: 4,            // 默认画笔宽度
};

const app = express();
app.use(express.json({ limit: '32mb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const num = (v, min, max, dft) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dft;
};

app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: store.name, uptime: Math.round(process.uptime()) });
});

app.get('/api/settings', (req, res) => {
  const saved = store.getSettings();
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (saved[k] === undefined) continue;
    if (typeof DEFAULT_SETTINGS[k] === 'number') out[k] = num(saved[k], -1e9, 1e9, DEFAULT_SETTINGS[k]);
    else out[k] = saved[k];
  }
  res.json(out);
});

app.put('/api/settings', (req, res) => {
  const body = req.body || {};
  const nums = { lensRadius: [60, 400], zoom: [1.5, 8], penWidth: [1, 30] };
  for (const [k, [min, max]] of Object.entries(nums)) {
    if (body[k] !== undefined) store.setSetting(k, String(num(body[k], min, max, DEFAULT_SETTINGS[k])));
  }
  if (typeof body.hotkey === 'string' && /^Ctrl[+](Alt|Shift)[+][A-Z]$/.test(body.hotkey.trim())) {
    store.setSetting('hotkey', body.hotkey.trim());
  }
  if (typeof body.penColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.penColor.trim())) {
    store.setSetting('penColor', body.penColor.trim());
  }
  res.json({ ok: true });
});

app.post('/api/sessions', (req, res) => {
  const b = req.body || {};
  const r = b.region || {};
  if (!Number.isFinite(+r.x) || !Number.isFinite(+r.y) || !(+r.w > 0) || !(+r.h > 0)) {
    return res.status(400).json({ error: 'region 无效' });
  }
  const strokes = Array.isArray(b.strokes) ? b.strokes.slice(0, 2000) : [];

  let snapshot = null;
  if (typeof b.snapshot === 'string' && b.snapshot.startsWith('data:image/png;base64,')) {
    const name = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    fs.writeFileSync(path.join(SNAP_DIR, name), Buffer.from(b.snapshot.slice(22), 'base64'));
    snapshot = `/snapshots/${name}`;
  }

  const id = store.insertSession({
    region: { x: Math.round(+r.x), y: Math.round(+r.y), w: Math.round(+r.w), h: Math.round(+r.h) },
    zoom: num(b.zoom, 1, 32, DEFAULT_SETTINGS.zoom),
    strokes,
    snapshot,
    note: typeof b.note === 'string' ? b.note.slice(0, 200) : '',
  });
  res.json({ ok: true, id, url: `/api/sessions/${id}` });
});

function shapeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    region: { x: row.region_x, y: row.region_y, w: row.region_w, h: row.region_h },
    zoom: row.zoom,
    strokes: JSON.parse(row.strokes || '[]'),
    snapshot: row.snapshot,
    note: row.note,
  };
}

app.get('/api/sessions', (req, res) => {
  const limit = num(req.query.limit, 1, 500, 100);
  res.json(store.listSessions(limit).map(shapeRow));
});

app.get('/api/sessions/:id', (req, res) => {
  const row = store.getSession(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(shapeRow(row));
});

app.delete('/api/sessions/:id', (req, res) => {
  const row = store.deleteSession(Number(req.params.id));
  if (row && row.snapshot && row.snapshot.startsWith('/snapshots/')) {
    const f = path.join(SNAP_DIR, path.basename(row.snapshot));
    fs.unlink(f, () => {});
  }
  res.json({ ok: true });
});

app.use('/snapshots', express.static(SNAP_DIR));

app.listen(PORT, HOST, () => {
  console.log(`[lensit-server] http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
});
