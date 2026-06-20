const fs = require('fs');
const path = require('path');
const src = 'C:\\Users\\Administrator\\Desktop\\noobclaw_centered_logo_pack\\png';
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngBuffers = sizes.map(s => fs.readFileSync(path.join(src, s + 'x' + s + '.png')));
const numImages = pngBuffers.length;
const headerSize = 6 + (numImages * 16);
let offset = headerSize;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(numImages, 4);
const entries = Buffer.alloc(numImages * 16);
for (let i = 0; i < numImages; i++) {
  const png = pngBuffers[i];
  const s = sizes[i];
  entries.writeUInt8(s >= 256 ? 0 : s, i * 16);
  entries.writeUInt8(s >= 256 ? 0 : s, i * 16 + 1);
  entries.writeUInt8(0, i * 16 + 2);
  entries.writeUInt8(0, i * 16 + 3);
  entries.writeUInt16LE(1, i * 16 + 4);
  entries.writeUInt16LE(32, i * 16 + 6);
  entries.writeUInt32LE(png.length, i * 16 + 8);
  entries.writeUInt32LE(offset, i * 16 + 12);
  offset += png.length;
}
const ico = Buffer.concat([header, entries, ...pngBuffers]);
fs.writeFileSync(path.join(__dirname, '..', 'build', 'icons', 'win', 'icon.ico'), ico);
console.log('ICO created:', ico.length, 'bytes with', numImages, 'images');
