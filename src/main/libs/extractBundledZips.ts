/**
 * On first launch, extract mingit.zip and python-win.zip from resources
 * into their expected directories. This dramatically speeds up NSIS installation
 * by reducing tens of thousands of small files to just 2 zip files.
 */
import path from 'path';
import fs from 'fs';
import { isPackaged, getResourcesPath } from './platformAdapter';
import { createInflateRaw } from 'zlib';

const ZIPS = ['mingit', 'python-win'] as const;

function readUInt16LE(buf: Buffer, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8);
}

function readUInt32LE(buf: Buffer, offset: number): number {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}

function inflateBuffer(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const inflate = createInflateRaw();
    inflate.on('data', (chunk: Buffer) => chunks.push(chunk));
    inflate.on('end', () => resolve(Buffer.concat(chunks)));
    inflate.on('error', reject);
    inflate.end(data);
  });
}

async function extractZip(zipPath: string, targetDir: string): Promise<void> {
  const buf = fs.readFileSync(zipPath);
  let offset = 0;

  while (offset < buf.length - 4) {
    const sig = readUInt32LE(buf, offset);
    if (sig !== 0x04034b50) break; // not a local file header

    const compression = readUInt16LE(buf, offset + 8);
    const compressedSize = readUInt32LE(buf, offset + 18);
    const uncompressedSize = readUInt32LE(buf, offset + 22);
    const nameLen = readUInt16LE(buf, offset + 26);
    const extraLen = readUInt16LE(buf, offset + 28);

    const nameStart = offset + 30;
    const fileName = buf.subarray(nameStart, nameStart + nameLen).toString('utf-8');
    const dataStart = nameStart + nameLen + extraLen;
    const dataEnd = dataStart + compressedSize;

    const fullPath = path.join(targetDir, fileName.replace(/\//g, path.sep));

    if (fileName.endsWith('/')) {
      // Directory entry
      fs.mkdirSync(fullPath, { recursive: true });
    } else {
      // File entry
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const rawData = buf.subarray(dataStart, dataEnd);

      if (compression === 0) {
        // Stored (no compression)
        fs.writeFileSync(fullPath, rawData);
      } else if (compression === 8) {
        // Deflate
        const inflated = await inflateBuffer(rawData);
        fs.writeFileSync(fullPath, inflated);
      } else {
        console.warn(`[extractBundledZips] Unsupported compression ${compression} for ${fileName}, skipping`);
      }
    }

    offset = dataEnd;
  }
}

export async function extractBundledZips(): Promise<void> {
  if (process.platform !== 'win32' || !isPackaged()) return;

  const resourcesPath = getResourcesPath();

  for (const name of ZIPS) {
    const zipPath = path.join(resourcesPath, `${name}.zip`);
    const targetDir = path.join(resourcesPath, name);

    // Already extracted — skip
    if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
      continue;
    }

    if (!fs.existsSync(zipPath)) {
      console.warn(`[extractBundledZips] ${name}.zip not found, skipping`);
      continue;
    }

    console.log(`[extractBundledZips] Extracting ${name}.zip...`);
    const start = Date.now();

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    try {
      await extractZip(zipPath, targetDir);

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`[extractBundledZips] ${name}.zip extracted in ${elapsed}s`);

      // Delete the zip to free disk space
      try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
    } catch (err) {
      console.error(`[extractBundledZips] Failed to extract ${name}.zip:`, err);
    }
  }
}
