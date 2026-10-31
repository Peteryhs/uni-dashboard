// Deterministic raster exports of public/icon.svg, with four-sample edge antialiasing.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function chunk(type, data) { const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff; for (const n of body) crc = crcTable[(crc ^ n) & 255] ^ (crc >>> 8); const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result; }
for (const size of [192, 512]) {
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let ink = 0;
    for (const a of [.25, .75]) for (const b of [.25, .75]) {
      const px = (x + a) * 192 / size, py = (y + b) * 192 / size;
      if ((py >= 55 && py <= 111 && ((px >= 52 && px <= 75) || (px >= 117 && px <= 140))) || (py >= 111 && ((px - 96) / 44) ** 2 + ((py - 111) / 32.25) ** 2 <= 1 && ((px - 96) / 21) ** 2 + ((py - 111) / 12.75) ** 2 >= 1)) ink++;
    }
    const offset = y * (size * 3 + 1) + 1 + x * 3;
    [29, 31, 35].forEach((base, i) => { rows[offset + i] = Math.round(base + ([245, 246, 247][i] - base) * ink / 4); });
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  writeFileSync(new URL(`../apps/web/public/icon-${size}.png`, import.meta.url), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
}
