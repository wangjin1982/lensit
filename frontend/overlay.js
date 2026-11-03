'use strict';
/* LensIt 放大镜/标注浮层
 * 模式：lens（实时放大镜跟随鼠标）⇄ pen（冻结画面 + 标记笔）
 * 左键单击：lens → pen（冻结）；右键：pen → lens（清除标记）/ lens → 退出；Esc：退出
 */
(() => {
  const video = document.getElementById('cap');
  const bg = document.getElementById('bg');
  const ink = document.getElementById('ink');
  const hud = document.getElementById('hud');
  const bctx = bg.getContext('2d');
  const kctx = ink.getContext('2d');

  const S = {
    mode: 'idle',          // idle | lens | pen
    baseUrl: 'http://127.0.0.1:3777',
    region: null,          // 选区（CSS px，相对本窗口）
    displayPhys: { w: 0, h: 0 },
    dpr: window.devicePixelRatio || 1,
    zoom: 3,
    radius: 150,
    pen: { color: '#ff4d4f', width: 4 },
    tool: 'pen',           // pen | eraser
    cursor: null,          // {x,y} CSS px
    strokes: [],           // [{tool,color,width,points:[{x,y}]}] 物理px
    current: null,
    raf: 0,
    stream: null,
  };

  const emit = (ch, payload) => window.lensIt && window.lensIt.send(ch, payload);
  const on = (ch, cb) => (window.lensIt ? window.lensIt.on(ch, cb) : () => {});

  // ---------- 画布尺寸 ----------
  function resizeCanvases() {
    S.dpr = window.devicePixelRatio || 1;
    const w = Math.round(window.innerWidth * S.dpr);
    const h = Math.round(window.innerHeight * S.dpr);
    for (const c of [bg, ink]) { c.width = w; c.height = h; }
    redrawInk();
  }
  window.addEventListener('resize', resizeCanvases);

  // ---------- 启动 ----------
  on('session-start', async p => {
    S.baseUrl = p.baseUrl || S.baseUrl;
    S.region = p.region;
    S.displayPhys = p.displayPhys;
    const st = p.settings || {};
    S.zoom = Number(st.zoom) || 3;
    S.radius = Number(st.lensRadius) || 150;
    if (st.penColor) S.pen.color = st.penColor;
    if (st.penWidth) S.pen.width = Number(st.penWidth) || 4;

    resizeCanvases();
    try {
      S.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: p.sourceId,
            minWidth: S.displayPhys.w, maxWidth: S.displayPhys.w,
            minHeight: S.displayPhys.h, maxHeight: S.displayPhys.h,
          },
        },
      });
      video.srcObject = S.stream;
      await video.play();
    } catch (e) {
      hud.textContent = '屏幕采集失败: ' + e.message;
      emit('session-closed');
      window.close();
      return;
    }
    setMode('lens');
    emit('session-ready');
  });

  on('settings-updated', st => {
    if (!st) return;
    if (st.lensRadius) S.radius = Number(st.lensRadius);
    if (st.penColor) S.pen.color = st.penColor;
    if (st.penWidth) S.pen.width = Number(st.penWidth);
    updateHud();
  });

  function setMode(m) {
    S.mode = m;
    document.body.className = 'mode-' + m;
    if (m === 'lens') {
      if (video.paused) video.play().catch(() => {});
      if (!S.raf) S.raf = requestAnimationFrame(loop);
    } else {
      cancelAnimationFrame(S.raf); S.raf = 0;
      video.pause();
      drawFrame(false); // 冻结底图（无镜头）
    }
    updateHud();
  }

  // ---------- 渲染 ----------
  function loop() {
    if (S.mode !== 'lens') { S.raf = 0; return; }
    drawFrame(true);
    S.raf = requestAnimationFrame(loop);
  }

  function drawFrame(withLens) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const W = bg.width, H = bg.height;
    const kx = vw / S.displayPhys.w, ky = vh / S.displayPhys.h;
    const R = S.region;
    const Rx = R.x * S.dpr, Ry = R.y * S.dpr, Rw = R.w * S.dpr, Rh = R.h * S.dpr;

    bctx.imageSmoothingEnabled = true;
    bctx.clearRect(0, 0, W, H);
    bctx.drawImage(video, 0, 0, vw, vh, 0, 0, W, H);

    // 选区外压暗
    bctx.save();
    bctx.beginPath();
    bctx.rect(0, 0, W, H);
    bctx.rect(Rx, Ry, Rw, Rh);
    bctx.fillStyle = 'rgba(0,0,0,0.45)';
    bctx.fill('evenodd');
    bctx.restore();

    // 选区描边
    bctx.lineWidth = 2;
    bctx.strokeStyle = 'rgba(61,220,255,0.9)';
    bctx.strokeRect(Rx + 1, Ry + 1, Rw - 2, Rh - 2);

    if (withLens && S.cursor && S.mode === 'lens') {
      const inRegion =
        S.cursor.x >= R.x && S.cursor.x <= R.x + R.w &&
        S.cursor.y >= R.y && S.cursor.y <= R.y + R.h;
      if (inRegion) drawLens(S.cursor.x * S.dpr, S.cursor.y * S.dpr, kx, ky);
    }
  }

  function drawLens(cx, cy, kx, ky) {
    const Rd = S.radius * S.dpr;
    const halfVx = (Rd / S.zoom) * kx, halfVy = (Rd / S.zoom) * ky;
    const svx = cx * kx, svy = cy * ky;

    bctx.save();
    bctx.beginPath();
    bctx.arc(cx, cy, Rd, 0, Math.PI * 2);
    bctx.clip();
    bctx.fillStyle = '#000';
    bctx.fillRect(cx - Rd, cy - Rd, Rd * 2, Rd * 2);
    bctx.imageSmoothingEnabled = S.zoom < 1.99; // 高倍率用最近邻，像素颗粒清晰
    bctx.drawImage(video,
      svx - halfVx, svy - halfVy, halfVx * 2, halfVy * 2,
      cx - Rd, cy - Rd, Rd * 2, Rd * 2);
    bctx.restore();

    bctx.beginPath();
    bctx.arc(cx, cy, Rd, 0, Math.PI * 2);
    bctx.lineWidth = 3;
    bctx.strokeStyle = '#3ddcff';
    bctx.stroke();
    bctx.beginPath();
    bctx.arc(cx, cy, Rd + 2, 0, Math.PI * 2);
    bctx.lineWidth = 1;
    bctx.strokeStyle = 'rgba(0,0,0,0.55)';
    bctx.stroke();
    // 中心十字
    bctx.strokeStyle = 'rgba(61,220,255,0.9)';
    bctx.lineWidth = 1;
    bctx.beginPath();
    bctx.moveTo(cx - 8, cy); bctx.lineTo(cx + 8, cy);
    bctx.moveTo(cx, cy - 8); bctx.lineTo(cx, cy + 8);
    bctx.stroke();
  }

  // ---------- 笔迹 ----------
  function redrawInk() {
    kctx.clearRect(0, 0, ink.width, ink.height);
    for (const s of S.strokes) drawStroke(s);
  }

  function drawStroke(s) {
    if (!s.points.length) return;
    kctx.save();
    kctx.lineCap = 'round';
    kctx.lineJoin = 'round';
    kctx.lineWidth = s.width;
    kctx.strokeStyle = s.color;
    if (s.tool === 'eraser') kctx.globalCompositeOperation = 'destination-out';
    kctx.beginPath();
    kctx.moveTo(s.points[0].x, s.points[0].y);
    if (s.points.length === 1) kctx.lineTo(s.points[0].x + 0.01, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) kctx.lineTo(s.points[i].x, s.points[i].y);
    kctx.stroke();
    kctx.restore();
  }

  // ---------- 鼠标 ----------
  window.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (S.mode === 'pen') {
      S.strokes = []; S.current = null;
      redrawInk();
      setMode('lens');
    } else if (S.mode === 'lens') {
      closeSession();
    }
  });

  window.addEventListener('mousemove', e => {
    S.cursor = { x: e.clientX, y: e.clientY };
    if (S.mode === 'pen' && S.current) {
      const pt = { x: e.clientX * S.dpr, y: e.clientY * S.dpr };
      S.current.points.push(pt);
      drawStroke(S.current);
    }
  });

  window.addEventListener('mouseleave', () => { S.cursor = null; });

  window.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (S.mode === 'lens') { setMode('pen'); return; } // 单击 → 冻结进入标记
    if (S.mode === 'pen') {
      S.current = {
        tool: S.tool, color: S.pen.color, width: S.tool === 'eraser' ? S.pen.width * 4 : S.pen.width,
        points: [{ x: e.clientX * S.dpr, y: e.clientY * S.dpr }],
      };
    }
  });

  window.addEventListener('mouseup', e => {
    if (e.button !== 0 || !S.current) return;
    if (S.current.points.length) S.strokes.push(S.current);
    S.current = null;
  });

  window.addEventListener('wheel', e => {
    if (S.mode !== 'lens') return;
    S.zoom = Math.min(8, Math.max(1.5, S.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    updateHud();
  }, { passive: true });

  // ---------- 键盘 ----------
  const COLORS = { r: '#ff4d4f', g: '#52c41a', b: '#4096ff', y: '#faad14' };
  window.addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') { closeSession(); return; }
    if (S.mode === 'lens') {
      if (k === '+' || k === '=') { S.zoom = Math.min(8, S.zoom * 1.25); updateHud(); }
      else if (k === '-') { S.zoom = Math.max(1.5, S.zoom / 1.25); updateHud(); }
      return;
    }
    if (S.mode !== 'pen') return;
    if (COLORS[k]) { S.tool = 'pen'; S.pen.color = COLORS[k]; updateHud(); }
    else if (k === '1') { S.pen.width = 3; updateHud(); }
    else if (k === '2') { S.pen.width = 6; updateHud(); }
    else if (k === '3') { S.pen.width = 12; updateHud(); }
    else if (k === 'e') { S.tool = S.tool === 'eraser' ? 'pen' : 'eraser'; updateHud(); }
    else if (k === 'z' && e.ctrlKey) { S.strokes.pop(); redrawInk(); }
    else if (k === 'c') { S.strokes = []; redrawInk(); }
    else if (k === 's' && !e.ctrlKey) { saveSession(); }
  });

  // ---------- 保存 ----------
  async function saveSession() {
    if (!S.region || !video.videoWidth) return { ok: false };
    const dpr = S.dpr, R = S.region;
    const kx = video.videoWidth / S.displayPhys.w, ky = video.videoHeight / S.displayPhys.h;
    const c = document.createElement('canvas');
    c.width = Math.round(R.w * dpr); c.height = Math.round(R.h * dpr);
    const g = c.getContext('2d');
    g.drawImage(video,
      R.x * dpr * kx, R.y * dpr * ky, R.w * dpr * kx, R.h * dpr * ky,
      0, 0, c.width, c.height);
    g.drawImage(ink, R.x * dpr, R.y * dpr, R.w * dpr, R.h * dpr, 0, 0, c.width, c.height);
    try {
      const res = await fetch(`${S.baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          region: { x: Math.round(R.x * dpr), y: Math.round(R.y * dpr), w: c.width, h: c.height },
          zoom: Number(S.zoom.toFixed(2)),
          strokes: S.strokes,
          snapshot: c.toDataURL('image/png'),
        }),
      });
      const data = await res.json();
      hudFlash(`已保存到历史 #${data.id}`);
      emit('session-saved', data);
      return data;
    } catch (err) {
      hudFlash('保存失败: ' + err.message);
      return { ok: false };
    }
  }

  let hudTimer = 0;
  function hudFlash(text) {
    hud.dataset.flash = text;
    updateHud();
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => { delete hud.dataset.flash; updateHud(); }, 1800);
  }

  function updateHud() {
    if (S.mode === 'lens') {
      hud.innerHTML = `放大镜 <b>${S.zoom.toFixed(1)}×</b>　滚轮调倍率　<b>左键单击</b> 冻结并标记　右键退出`;
    } else if (S.mode === 'pen') {
      const tool = S.tool === 'eraser' ? '橡皮' : '标记笔';
      hud.innerHTML = `${tool} <b>${S.pen.color}</b> ${S.pen.width}px　R/G/B/Y 换色 · 1/2/3 笔宽 · E 橡皮 · Ctrl+Z 撤销 · C 清空 · S 保存` +
        `　<b>右键</b> 取消回放大镜`;
    }
    if (hud.dataset.flash) {
      hud.innerHTML = `<b>${hud.dataset.flash}</b>`;
    }
  }

  function closeSession() {
    cancelAnimationFrame(S.raf); S.raf = 0;
    if (S.stream) { for (const t of S.stream.getTracks()) t.stop(); S.stream = null; }
    emit('session-closed');
    window.close();
  }

  // ---------- 自测 ----------
  on('selftest-save', async () => {
    const r = await saveSession();
    emit('selftest-saved', { ok: !!(r && r.ok !== false && r.id), id: r && r.id });
  });

  updateHud();
})();
