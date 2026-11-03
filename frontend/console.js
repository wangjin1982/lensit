'use strict';
/* LensIt 控制台：设置表单 + 标注历史列表（fetch 后端 API） */
(() => {
  // 页面从 file:// 加载，后端地址固定本机
  const BASE = 'http://127.0.0.1:3777';
  const $ = id => document.getElementById(id);
  const emit = (ch, payload) => window.lensIt && window.lensIt.send(ch, payload);

  let toastTimer = 0;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
  }

  async function api(method, urlPath, body) {
    const res = await fetch(BASE + urlPath, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  async function loadHealth() {
    try {
      const h = await api('GET', '/api/health');
      $('dot').classList.remove('bad');
      $('dbinfo').textContent = `后端运行中 · 存储后端: ${h.db}`;
    } catch {
      $('dot').classList.add('bad');
      $('dbinfo').textContent = '后端不可用';
    }
  }

  async function loadSettings() {
    try {
      const s = await api('GET', '/api/settings');
      $('s-hotkey').value = s.hotkey;
      $('s-radius').value = s.lensRadius;
      $('s-zoom').value = s.zoom;
      $('s-color').value = s.penColor;
      $('s-width').value = s.penWidth;
    } catch { toast('读取设置失败'); }
  }

  async function saveSettings() {
    const body = {
      hotkey: $('s-hotkey').value,
      lensRadius: Number($('s-radius').value),
      zoom: Number($('s-zoom').value),
      penColor: $('s-color').value,
      penWidth: Number($('s-width').value),
    };
    try {
      await api('PUT', '/api/settings', body);
      emit('settings-changed'); // 主进程会重新注册热键并同步放大镜窗口
      toast('设置已保存');
    } catch { toast('保存失败'); }
  }

  async function loadHistory() {
    const box = $('hist');
    try {
      const list = await api('GET', '/api/sessions?limit=50');
      if (!list.length) { box.innerHTML = '<div class="empty">暂无标注记录 —— 按 ' +
        (document.querySelector('#s-hotkey').value || 'Ctrl+Alt+L') + ' 开始第一次标注</div>'; return; }
      box.innerHTML = '';
      for (const it of list) {
        const row = document.createElement('div');
        row.className = 'item';
        const thumb = it.snapshot
          ? `<img src="${BASE + it.snapshot}" alt="快照">`
          : '<div class="ph">无快照</div>';
        row.innerHTML = `${thumb}
          <div class="meta">
            <b>#${it.id}</b> · ${it.zoom}×
            <div><span>${it.createdAt}</span><span>区域 ${it.region.w}×${it.region.h}</span><span>笔画 ${it.strokes.length}</span></div>
          </div>`;
        const del = document.createElement('button');
        del.className = 'ghost';
        del.textContent = '删除';
        del.onclick = async () => {
          await api('DELETE', `/api/sessions/${it.id}`);
          loadHistory();
        };
        row.appendChild(del);
        box.appendChild(row);
      }
    } catch {
      box.innerHTML = '<div class="empty">历史加载失败（后端不可用）</div>';
    }
  }

  $('btn-save').onclick = saveSettings;
  $('btn-refresh').onclick = loadHistory;
  $('btn-start').onclick = () => emit('start-selection');

  if (window.lensIt) window.lensIt.on('history-changed', loadHistory);

  loadHealth();
  loadSettings();
  loadHistory();
})();
