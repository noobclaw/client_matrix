/**
 * Generate DMG background PNG from SVG.
 *
 * The original background had a hand-drawn curvy arrow that looked
 * amateurish. This script renders a clean straight arrow → pointing
 * from the app icon slot to the Applications folder slot, matching
 * the appPosition / applicationFolderPosition in tauri.conf.json:
 *   app icon          at x=180, y=170 (centred on 660x400 window)
 *   Applications icon at x=480, y=170
 *
 * Arrow drawn between icon edges (~x=240 → ~x=420), centred vertically
 * at y=170. Text "拖入 Applications 即可安装" below the arrow.
 *
 * Run:  node scripts/generate-dmg-background.cjs
 * Outputs: src-tauri/icons/dmg-background.png (660x400, 8-bit RGBA)
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const W = 660;
const H = 400;

// Arrow geometry
const ARROW_Y = 170;          // same y as icon slots
const ARROW_START_X = 245;    // just right of the app icon
const ARROW_END_X = 425;      // just left of the Applications icon
const ARROW_COLOR = '#666666';
const ARROW_STROKE = 3;
const ARROW_HEAD_SIZE = 14;

const TEXT_Y = ARROW_Y + 45;
const TEXT_COLOR = '#888888';
const TEXT_FONT_SIZE = 15;

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>

  <!-- Straight horizontal arrow body -->
  <line x1="${ARROW_START_X}" y1="${ARROW_Y}" x2="${ARROW_END_X - ARROW_HEAD_SIZE}" y2="${ARROW_Y}"
        stroke="${ARROW_COLOR}" stroke-width="${ARROW_STROKE}" stroke-linecap="round"/>

  <!-- Arrow head (filled triangle) -->
  <polygon points="${ARROW_END_X},${ARROW_Y} ${ARROW_END_X - ARROW_HEAD_SIZE},${ARROW_Y - ARROW_HEAD_SIZE * 0.55} ${ARROW_END_X - ARROW_HEAD_SIZE},${ARROW_Y + ARROW_HEAD_SIZE * 0.55}"
           fill="${ARROW_COLOR}"/>

  <!-- Caption — keep short to match the original DMG wording. -->
  <text x="${W / 2}" y="${TEXT_Y}"
        font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif"
        font-size="${TEXT_FONT_SIZE}"
        fill="${TEXT_COLOR}"
        text-anchor="middle">
    Drag to install
  </text>
</svg>
`.trim();

const outPath = path.resolve(__dirname, '..', 'src-tauri', 'icons', 'dmg-background.png');

(async () => {
  const png = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toBuffer();
  fs.writeFileSync(outPath, png);
  const stat = fs.statSync(outPath);
  console.log(`Wrote ${outPath} (${(stat.size / 1024).toFixed(1)} KB, ${W}x${H})`);
})();
