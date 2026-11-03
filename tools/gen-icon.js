'use strict';
/* 生成托盘图标 assets/icon.png（32x32 放大镜图形）—— 纯 Node 实现 PNG 编码，免依赖 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 32, H = 32;
const px = Buffer.alloc(W * H * 4, 0); // RGBA 透明底

const CYAN = [61, 220, 255, 255];
function put(x, y, c, a = 255) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const na = a / 255;
  px[i] = Math.round(c[0] * na + px[i] * (1 - na));
  px[i + 1] = Math.round(c[1] * na + px[i + 1] * (1 - na));
  px[i + 2] = Math.round(c[2] * na + px[i + 2] * (1 - na));
  px[i + 3] = Math.min(255, Math.round(a + px[i + 3] * (1 - na)));
}

// 镜片圆环：圆心(13.5,12.5) 外径 9.8 内径 8.2
const cx = 13.5, cy = 12.5;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (d <= 9.8 && d >= 8.2) put(x, y, CYAN);
    else if (d < 8.2) {
      // 镜片内加号（白色）
      if (Math.abs(x + 0.5 - cx) < 1.2 || Math.abs(y + 0.5 - cy) < 1.2) put(x, y, [255, 255, 255], 235);
    }
  }
}
// 手柄：从(20.5,19.5)到(28.5,27.5)，宽 2.2
const hx0 = 20.5, hy0 = 19.5, hx1 = 28.5, hy1 = 27.5;
const len = Math.hypot(hx1 - hx0, hy1 - hy0);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const t = Math.max(0, Math.min(1, ((x + 0.5 - hx0) * (hx1 - hx0) + (y + 0.5 - hy0) * (hy1 - hy0)) / (len * len)));
    const d = Math.hypot(x + 0.5 - (hx0 + t * (hx1 - hx0)), y + 0.5 - (hy0 + t * (hy1 - hy0)));
    if (t > 0.001 && t < 0.999 && d <= 2.2) put(x, y, CYAN);
  }
}

// ---- PNG 编码 ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('icon written:', out, png.length, 'bytes');
