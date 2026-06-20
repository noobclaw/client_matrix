// Zip a folder into a .zip file using Node.js built-in zlib + archiver-like approach
// Usage: node _zip-helper.cjs <sourceDir> <outputZip> [--strip-manifest-key]
//
// --strip-manifest-key: when zipping a chrome-extension folder, remove the
// `"key"` field from manifest.json before adding it to the zip. Required
// when uploading to Chrome Web Store — CWS rejects packages whose manifest
// "key" doesn't match the public key it has on file for the listing
// (Chinese error: "清单中"key"字段的值与当前内容不符"). Sideload / unpacked
// installs that need the legacy fixed ID should keep the key — use the
// regular `npm run package:extension` (no flag).
//
// --add-firefox-background: inject `background.scripts: ["background.js"]`
// alongside the existing `service_worker` so Firefox AMO accepts the
// archive. Firefox MV3 hard-rejects with:
//   "/background/service_worker manifest property must be paired with
//    use of /background/scripts property for Firefox compatibility"
// Chrome only warns if scripts is present, so we only add it for the
// Firefox-targeted zip.

const fs = require('fs');
const path = require('path');
const { createDeflateRaw } = require('zlib');

const sourceDir = process.argv[2];
const outputZip = process.argv[3];
const stripManifestKey = process.argv.includes('--strip-manifest-key');
const addFirefoxBackground = process.argv.includes('--add-firefox-background');

if (!sourceDir || !outputZip) {
  console.error('Usage: node _zip-helper.cjs <sourceDir> <outputZip> [--strip-manifest-key]');
  process.exit(1);
}

// Simple ZIP file writer (no external deps)
class ZipWriter {
  constructor(outputPath) {
    this.fd = fs.openSync(outputPath, 'w');
    this.offset = 0;
    this.entries = [];
  }

  _write(buf) {
    fs.writeSync(this.fd, buf);
    this.offset += buf.length;
  }

  async addFile(relativePath, fullPath) {
    const stat = fs.statSync(fullPath);
    let data = fs.readFileSync(fullPath);
    // ⛔ Hard-fail on any backslash / leading slash / drive letter that
    // somehow survives normalization. Firefox AMO + Edge Add-ons rejects
    // archives whose entry names contain "\" with the exact error
    //   "Invalid file name in archive: icons\icon128.png"
    // and the failure mode is silent if we just normalize-and-continue
    // (Chrome ignores it, Firefox doesn't). Better to crash the build.
    {
      const normalized = relativePath.replace(/\\/g, '/');
      if (/^([a-z]:)?\//i.test(normalized)) {
        throw new Error('zip entry must be RELATIVE, got: ' + JSON.stringify(relativePath));
      }
    }

    // CWS-targeted variant: strip the "key" field from the top-level
    // manifest.json before zipping. Doing it here (not on disk) keeps
    // the source file with the key for sideload installs while the
    // CWS upload zip ships without it.
    const isManifest = relativePath.replace(/\\/g, '/').toLowerCase() === 'manifest.json';
    if ((stripManifestKey || addFirefoxBackground) && isManifest) {
      try {
        const json = JSON.parse(data.toString('utf-8'));
        let touched = false;
        if (stripManifestKey && 'key' in json) {
          delete json.key;
          touched = true;
          console.log('  [strip-manifest-key] removed "key" from manifest.json (CWS-compatible)');
        }
        if (addFirefoxBackground && json.background && json.background.service_worker) {
          // Firefox MV3 needs `background.scripts` and rejects manifests
          // that still carry `background.service_worker` — the error is:
          //   "background.service_worker is currently disabled.
          //    Add background.scripts."
          // even when `scripts` is also present. Firefox parses
          // `service_worker` first, refuses on the spot, and never gets
          // to `scripts`. Earlier versions of this script kept both
          // fields hoping Firefox would prefer scripts; in practice
          // (Firefox 142+) the dual-field manifest is hard-rejected.
          //
          // Fix: for Firefox-only archives, swap service_worker → scripts
          // entirely. The chrome / edge zips are unaffected (they don't
          // pass --add-firefox-background, so service_worker stays).
          if (!Array.isArray(json.background.scripts) || json.background.scripts.length === 0) {
            json.background.scripts = [json.background.service_worker];
          }
          const removedSw = json.background.service_worker;
          delete json.background.service_worker;
          touched = true;
          console.log('  [add-firefox-background] replaced service_worker → scripts ['
            + removedSw + '] for Firefox MV3 (Firefox rejects archives that keep both fields)');
        }
        if (touched) {
          data = Buffer.from(JSON.stringify(json, null, 2) + '\n', 'utf-8');
        }
      } catch (e) {
        console.warn('  [manifest-rewrite] failed to parse manifest.json — leaving as-is:', e.message);
      }
    }

    // Compress
    const compressed = await new Promise((resolve, reject) => {
      const chunks = [];
      const deflate = createDeflateRaw({ level: 1 }); // fast compression
      deflate.on('data', c => chunks.push(c));
      deflate.on('end', () => resolve(Buffer.concat(chunks)));
      deflate.on('error', reject);
      deflate.end(data);
    });

    const crc = crc32(data);
    const nameBuffer = Buffer.from(relativePath.replace(/\\/g, '/'), 'utf-8');
    const headerOffset = this.offset;
    const { dosDate, dosTime } = dosDateTime(stat.mtimeMs);

    // Local file header
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // sig
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // compression: deflate
    local.writeUInt16LE(dosTime, 10); // mod time
    local.writeUInt16LE(dosDate, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    this._write(local);
    this._write(nameBuffer);
    this._write(compressed);

    this.entries.push({ nameBuffer, crc, compressedSize: compressed.length, uncompressedSize: data.length, headerOffset, dosDate, dosTime });
  }

  addDirectory(relativePath) {
    const nameBuffer = Buffer.from(relativePath.replace(/\\/g, '/') + '/', 'utf-8');
    const headerOffset = this.offset;
    const { dosDate, dosTime } = dosDateTime(Date.now());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    this._write(local);
    this._write(nameBuffer);

    this.entries.push({ nameBuffer, crc: 0, compressedSize: 0, uncompressedSize: 0, headerOffset, isDir: true, dosDate, dosTime });
  }

  finalize() {
    const cdStart = this.offset;

    for (const e of this.entries) {
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); // central dir sig
      cd.writeUInt16LE(20, 4); // version made by
      cd.writeUInt16LE(20, 6); // version needed
      cd.writeUInt16LE(0, 8); // flags
      cd.writeUInt16LE(e.isDir ? 0 : 8, 10); // compression
      cd.writeUInt16LE(e.dosTime, 12); // mod time
      cd.writeUInt16LE(e.dosDate, 14); // mod date
      cd.writeUInt32LE(e.crc, 16);
      cd.writeUInt32LE(e.compressedSize, 20);
      cd.writeUInt32LE(e.uncompressedSize, 24);
      cd.writeUInt16LE(e.nameBuffer.length, 28);
      cd.writeUInt16LE(0, 30); // extra field length
      cd.writeUInt16LE(0, 32); // comment length
      cd.writeUInt16LE(0, 34); // disk start
      cd.writeUInt16LE(0, 36); // internal attr
      cd.writeUInt32LE(e.isDir ? 0x10 : 0, 38); // external attr
      cd.writeUInt32LE(e.headerOffset, 42);

      this._write(cd);
      this._write(e.nameBuffer);
    }

    const cdSize = this.offset - cdStart;

    // End of central directory
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4); // disk
    eocd.writeUInt16LE(0, 6); // disk with cd
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);

    this._write(eocd);
    fs.closeSync(this.fd);
  }
}

// CRC32 table
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[i] = c;
}
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Walk directory
// Skip dev/VCS junk that has no business in a published extension archive.
// .git in particular: chrome-extension is a git repo, and walking the whole
// objects tree both bloats the archive and triggers strict-unzip failures
// (Firefox install rejects, Windows Explorer "archive is invalid").
const IGNORE = new Set(['.git', '.DS_Store', 'Thumbs.db', 'node_modules', '.vscode', '.idea']);
function walkDir(dir, base) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) {
      results.push({ rel, full, isDir: true });
      results.push(...walkDir(full, rel));
    } else {
      results.push({ rel, full, isDir: false });
    }
  }
  return results;
}

// Build a DOS-format (time, date) pair for a JS Date. DOS time/date can NOT
// legally encode month=0 or day=0 — some unzippers (Windows Explorer, parts
// of Firefox's signer) reject archives with the all-zero default we used
// originally. Fall back to a valid sentinel (1980-01-01 00:00:00) if mtime
// is missing or out of range.
function dosDateTime(mtimeMs) {
  let d = new Date(mtimeMs);
  let year = d.getFullYear();
  if (!Number.isFinite(year) || year < 1980 || year > 2107) {
    d = new Date(2024, 0, 1);
    year = 2024;
  }
  const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { dosDate, dosTime };
}

(async () => {
  const files = walkDir(sourceDir, '');
  console.log(`Zipping ${files.length} entries from ${sourceDir}...`);

  const zip = new ZipWriter(outputZip);

  let count = 0;
  for (const f of files) {
    if (f.isDir) {
      zip.addDirectory(f.rel);
    } else {
      await zip.addFile(f.rel, f.full);
    }
    count++;
    if (count % 500 === 0) console.log(`  ${count}/${files.length}...`);
  }

  zip.finalize();
  console.log(`Done: ${outputZip} (${(fs.statSync(outputZip).size / 1024 / 1024).toFixed(1)} MB)`);
})();
