---
name: image-editor
description: Edit images without opening Photoshop — resize, crop, compress, convert formats, add watermarks, adjust colors, merge images, and create thumbnails.
name_zh: "图片编辑"
description_zh: "无需 Photoshop 编辑图片 — 缩放、裁剪、压缩、格式转换、加水印、调色、拼图、生成缩略图。"
name_ja: "画像編集"
description_ja: "Photoshop不要の画像編集 — リサイズ、切り抜き、圧縮、フォーマット変換、透かし、色調整。"
name_ko: "이미지 편집"
description_ko: "포토샵 없이 이미지 편집 — 크기 조정, 자르기, 압축, 형식 변환, 워터마크, 색상 조정."
official: true
version: 1.0.0
---

# Image Editor Skill

## When to Use This Skill

Use this skill when the user needs to:
- Resize or crop images
- Compress images to reduce file size
- Convert between formats (PNG, JPG, WebP, GIF, BMP)
- Add text or image watermarks
- Adjust brightness, contrast, saturation
- Merge/combine multiple images
- Create thumbnails
- Remove or change background color

## Prerequisites

The `sharp` library should be available in the Node.js environment. If not:
```bash
npm install sharp
```

## Image Operations

### Resize
```javascript
const sharp = require('sharp');

// Resize to specific dimensions
await sharp('input.png').resize(800, 600).toFile('output.png');

// Resize by width, maintain aspect ratio
await sharp('input.png').resize(800).toFile('output.png');

// Resize by percentage
const meta = await sharp('input.png').metadata();
await sharp('input.png').resize(Math.round(meta.width * 0.5)).toFile('output.png');
```

### Crop
```javascript
// Crop a region (left, top, width, height)
await sharp('input.png').extract({ left: 100, top: 50, width: 400, height: 300 }).toFile('cropped.png');
```

### Compress
```javascript
// JPEG compression
await sharp('input.jpg').jpeg({ quality: 60 }).toFile('compressed.jpg');

// PNG compression
await sharp('input.png').png({ compressionLevel: 9 }).toFile('compressed.png');

// WebP compression (best size/quality ratio)
await sharp('input.png').webp({ quality: 75 }).toFile('output.webp');
```

### Format Conversion
```javascript
// PNG to JPG
await sharp('input.png').jpeg().toFile('output.jpg');

// JPG to WebP
await sharp('input.jpg').webp().toFile('output.webp');

// Any to PNG
await sharp('input.bmp').png().toFile('output.png');
```

### Add Text Watermark
```javascript
const svgText = `<svg width="300" height="50">
  <text x="10" y="35" font-size="24" fill="rgba(255,255,255,0.5)" font-family="Arial">
    NoobClaw
  </text>
</svg>`;

await sharp('input.png')
  .composite([{ input: Buffer.from(svgText), gravity: 'southeast' }])
  .toFile('watermarked.png');
```

### Adjust Colors
```javascript
// Brightness and contrast
await sharp('input.png')
  .modulate({ brightness: 1.2 })  // 1.0 = normal, >1 = brighter
  .linear(1.2, -30)               // contrast adjustment
  .toFile('adjusted.png');

// Grayscale
await sharp('input.png').grayscale().toFile('gray.png');

// Blur
await sharp('input.png').blur(5).toFile('blurred.png');

// Sharpen
await sharp('input.png').sharpen().toFile('sharpened.png');
```

### Merge Images
```javascript
// Side by side (horizontal)
const img1 = sharp('left.png');
const img2 = sharp('right.png');
const meta1 = await img1.metadata();
const meta2 = await img2.metadata();

await sharp({
  create: {
    width: meta1.width + meta2.width,
    height: Math.max(meta1.height, meta2.height),
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 }
  }
})
.composite([
  { input: await img1.toBuffer(), left: 0, top: 0 },
  { input: await img2.toBuffer(), left: meta1.width, top: 0 }
])
.toFile('merged.png');
```

### Get Image Info
```javascript
const metadata = await sharp('input.png').metadata();
console.log(`Size: ${metadata.width}x${metadata.height}`);
console.log(`Format: ${metadata.format}`);
console.log(`Channels: ${metadata.channels}`);
console.log(`File size: ${metadata.size} bytes`);
```

## Command-Line Alternatives

If sharp is not available, use system tools:

```bash
# macOS — sips
sips -Z 800 input.png --out resized.png          # Resize
sips -s format jpeg input.png --out output.jpg    # Convert

# ImageMagick (cross-platform, if installed)
convert input.png -resize 800x600 output.png     # Resize
convert input.png -quality 60 output.jpg          # Compress
convert input.png -crop 400x300+100+50 crop.png   # Crop
```

## Important Notes

- Always preserve original files — save to new filenames
- Ask user for desired quality/size tradeoff when compressing
- Show before/after file sizes for compression operations
- Respect image orientation (EXIF data)
