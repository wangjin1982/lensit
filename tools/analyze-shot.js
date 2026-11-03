'use strict';
/* 自测截图的程序化分析：在隐藏窗口里用 canvas 解码 PNG，统计特征像素与亮度网格。
 * 用法: electron tools/analyze-shot.js --file <png路径>
 * 输出 JSON: { size, cyanCount, cyanBBox, redCount, redBBox, lumGrid8 } */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');

const args = process.argv;
const file = args[args.indexOf('--file') + 1];
if (!file || !fs.existsSync(file)) { console.error('need --file <png>'); process.exit(2); }

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<canvas id="c"></canvas>');
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
  const result = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(dataUrl)};
    await img.decode();
    const c = document.getElementById('c');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const W = c.width, H = c.height;
    const data = ctx.getImageData(0, 0, W, H).data;

    const near = (r, g, b, R, G, B, tol) =>
      Math.abs(r - R) <= tol && Math.abs(g - G) <= tol && Math.abs(b - B) <= tol;

    let cyanCount = 0, redCount = 0;
    let cyanBox = null, redBox = null;
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const i = (y * W + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (near(r, g, b, 61, 220, 255, 42)) {
          cyanCount++;
          cyanBox = cyanBox ? {
            x0: Math.min(cyanBox.x0, x), y0: Math.min(cyanBox.y0, y),
            x1: Math.max(cyanBox.x1, x), y1: Math.max(cyanBox.y1, y),
          } : { x0: x, y0: y, x1: x, y1: y };
        }
        if (near(r, g, b, 255, 77, 79, 48)) {
          redCount++;
          redBox = redBox ? {
            x0: Math.min(redBox.x0, x), y0: Math.min(redBox.y0, y),
            x1: Math.max(redBox.x1, x), y1: Math.max(redBox.y1, y),
          } : { x0: x, y0: y, x1: x, y1: y };
        }
      }
    }

    const lumGrid = [];
    for (let gy = 0; gy < 8; gy++) {
      const row = [];
      for (let gx = 0; gx < 8; gx++) {
        let sum = 0, n = 0;
        const x0 = Math.floor(gx * W / 8), y0 = Math.floor(gy * H / 8);
        const x1 = Math.floor((gx + 1) * W / 8), y1 = Math.floor((gy + 1) * H / 8);
        for (let y = y0; y < y1; y += 6) for (let x = x0; x < x1; x += 6) {
          const i = (y * W + x) * 4;
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          n++;
        }
        row.push(Math.round(sum / n));
      }
      lumGrid.push(row.join(','));
    }
    return { size: W + 'x' + H, cyanCount, cyanBBox: cyanBox, redCount, redBBox: redBox, lumGrid };
  })()`);
  console.log(JSON.stringify(result));
  app.exit(0);
});
