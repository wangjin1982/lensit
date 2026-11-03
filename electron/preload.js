'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 渲染进程与主进程之间的白名单通道（安全：contextIsolation 下仅暴露最小接口）
const OUT = ['select-done', 'select-cancel', 'session-ready', 'session-closed', 'session-saved',
  'settings-changed', 'selftest-saved', 'start-selection', 'open-console'];
const IN = ['select-init', 'session-start', 'settings-updated', 'selftest-save', 'console-init', 'history-changed'];

contextBridge.exposeInMainWorld('lensIt', {
  send: (channel, payload) => { if (OUT.includes(channel)) ipcRenderer.send(channel, payload); },
  on: (channel, callback) => {
    if (!IN.includes(channel)) return () => {};
    const handler = (_e, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
