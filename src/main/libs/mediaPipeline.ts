/**
 * Media Pipeline — image/audio/video processing utilities.
 * Handles format conversion, size limits, temp file lifecycle.
 *
 * Reference: OpenClaw src/media/ (56 files, simplified to core pipeline)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawnSync } from 'child_process';
import { coworkLog } from './coworkLogger';

// ── Config ──

export interface MediaConfig {
  maxImageSizeBytes: number;    // default: 10MB
  maxAudioSizeBytes: number;    // default: 25MB
  maxVideoSizeBytes: number;    // default: 100MB
  tempDir: string;
  cleanupIntervalMs: number;    // default: 30 min
  maxTempFileAgeMs: number;     // default: 1 hour
}

const DEFAULT_CONFIG: MediaConfig = {
  maxImageSizeBytes: 10 * 1024 * 1024,
  maxAudioSizeBytes: 25 * 1024 * 1024,
  maxVideoSizeBytes: 100 * 1024 * 1024,
  tempDir: path.join(os.tmpdir(), 'noobclaw-media'),
  cleanupIntervalMs: 30 * 60 * 1000,
  maxTempFileAgeMs: 60 * 60 * 1000,
};

let config = { ...DEFAULT_CONFIG };
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

// ── Init ──

export function initMediaPipeline(customConfig?: Partial<MediaConfig>): void {
  if (customConfig) config = { ...config, ...customConfig };
  if (!fs.existsSync(config.tempDir)) fs.mkdirSync(config.tempDir, { recursive: true });

  // Start auto-cleanup
  if (!cleanupTimer) {
    cleanupTimer = setInterval(cleanupTempFiles, config.cleanupIntervalMs);
  }
  coworkLog('INFO', 'mediaPipeline', `Initialized, tempDir=${config.tempDir}`);
}

export function stopMediaPipeline(): void {
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
}

// ── Temp file management ──

export function createTempPath(ext: string): string {
  if (!fs.existsSync(config.tempDir)) fs.mkdirSync(config.tempDir, { recursive: true });
  return path.join(config.tempDir, `media-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
}

export function cleanupTempFiles(): number {
  if (!fs.existsSync(config.tempDir)) return 0;
  const cutoff = Date.now() - config.maxTempFileAgeMs;
  let cleaned = 0;
  try {
    const files = fs.readdirSync(config.tempDir);
    for (const file of files) {
      const filePath = path.join(config.tempDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {}
    }
  } catch {}
  if (cleaned > 0) coworkLog('INFO', 'mediaPipeline', `Cleaned ${cleaned} temp files`);
  return cleaned;
}

// ── Size validation ──

export function validateFileSize(filePath: string, type: 'image' | 'audio' | 'video'): { valid: boolean; size: number; limit: number } {
  const stat = fs.statSync(filePath);
  const limits = { image: config.maxImageSizeBytes, audio: config.maxAudioSizeBytes, video: config.maxVideoSizeBytes };
  return { valid: stat.size <= limits[type], size: stat.size, limit: limits[type] };
}

// ── Image processing ──

export function convertImage(inputPath: string, outputFormat: 'jpeg' | 'png' | 'webp', quality?: number): string | null {
  const outPath = createTempPath(outputFormat === 'jpeg' ? 'jpg' : outputFormat);

  // Try sharp (if available), fallback to system commands
  try {
    if (process.platform === 'win32') {
      // PowerShell image conversion via System.Drawing
      const q = quality || 85;
      execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; $img=[System.Drawing.Image]::FromFile('${inputPath.replace(/'/g, "''")}'); $img.Save('${outPath.replace(/'/g, "''")}'); $img.Dispose()"`, { timeout: 15000 });
    } else {
      // macOS/Linux: try sips (macOS) or convert (ImageMagick)
      if (process.platform === 'darwin') {
        execSync(`sips -s format ${outputFormat} "${inputPath}" --out "${outPath}"`, { timeout: 15000 });
      } else {
        execSync(`convert "${inputPath}" "${outPath}"`, { timeout: 15000 });
      }
    }
    return fs.existsSync(outPath) ? outPath : null;
  } catch (e) {
    coworkLog('WARN', 'mediaPipeline', `Image conversion failed: ${e}`);
    return null;
  }
}

export function resizeImage(inputPath: string, maxWidth: number, maxHeight: number): string | null {
  const outPath = createTempPath('jpg');

  try {
    if (process.platform === 'darwin') {
      execSync(`sips -Z ${Math.max(maxWidth, maxHeight)} "${inputPath}" --out "${outPath}"`, { timeout: 15000 });
    } else if (process.platform === 'win32') {
      execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; $img=[System.Drawing.Image]::FromFile('${inputPath.replace(/'/g, "''")}'); $w=${maxWidth}; $h=${maxHeight}; $ratio=[Math]::Min($w/$img.Width, $h/$img.Height); $nw=[int]($img.Width*$ratio); $nh=[int]($img.Height*$ratio); $bmp=New-Object System.Drawing.Bitmap($nw,$nh); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.DrawImage($img,0,0,$nw,$nh); $bmp.Save('${outPath.replace(/'/g, "''")}'); $g.Dispose(); $bmp.Dispose(); $img.Dispose()"`, { timeout: 15000 });
    } else {
      execSync(`convert "${inputPath}" -resize ${maxWidth}x${maxHeight} "${outPath}"`, { timeout: 15000 });
    }
    return fs.existsSync(outPath) ? outPath : null;
  } catch (e) {
    coworkLog('WARN', 'mediaPipeline', `Image resize failed: ${e}`);
    return null;
  }
}

export function getImageDimensions(inputPath: string): { width: number; height: number } | null {
  try {
    if (process.platform === 'darwin') {
      const out = execSync(`sips -g pixelWidth -g pixelHeight "${inputPath}"`, { encoding: 'utf8', timeout: 5000 });
      const wMatch = out.match(/pixelWidth:\s*(\d+)/);
      const hMatch = out.match(/pixelHeight:\s*(\d+)/);
      if (wMatch && hMatch) return { width: parseInt(wMatch[1]), height: parseInt(hMatch[1]) };
    } else if (process.platform === 'win32') {
      const out = execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; $img=[System.Drawing.Image]::FromFile('${inputPath.replace(/'/g, "''")}'); Write-Host $img.Width $img.Height; $img.Dispose()"`, { encoding: 'utf8', timeout: 5000 });
      const parts = out.trim().split(/\s+/);
      if (parts.length >= 2) return { width: parseInt(parts[0]), height: parseInt(parts[1]) };
    }
  } catch {}
  return null;
}

// ── Audio processing ──

export function convertAudio(inputPath: string, outputFormat: 'mp3' | 'wav' | 'ogg' | 'opus'): string | null {
  const outPath = createTempPath(outputFormat);
  try {
    // ffmpeg is the universal audio converter
    execSync(`ffmpeg -y -i "${inputPath}" "${outPath}"`, { timeout: 30000, stdio: 'ignore' });
    return fs.existsSync(outPath) ? outPath : null;
  } catch {
    // Fallback: try sox
    try {
      execSync(`sox "${inputPath}" "${outPath}"`, { timeout: 30000, stdio: 'ignore' });
      return fs.existsSync(outPath) ? outPath : null;
    } catch {
      coworkLog('WARN', 'mediaPipeline', `Audio conversion failed (install ffmpeg or sox)`);
      return null;
    }
  }
}

export function getAudioDuration(inputPath: string): number | null {
  // `ffmpeg -i <file>`(无输出文件)总以非 0 退出并抛错,但 Duration 已打在
  // stderr 上(err.stderr)。改用 ffmpeg 解析,省掉对 ffprobe 的依赖。
  try {
    let stderr = '';
    try {
      execSync(`ffmpeg -hide_banner -i "${inputPath}"`, { encoding: 'utf8', timeout: 10000 });
    } catch (e: any) {
      stderr = e && e.stderr ? String(e.stderr) : '';
    }
    const m = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (!m) return null;
    const dur = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
    return Number.isFinite(dur) && dur > 0 ? dur : null;
  } catch {
    return null;
  }
}

// ── Video processing ──

export function extractVideoFrame(inputPath: string, timeSeconds: number = 0): string | null {
  const outPath = createTempPath('jpg');
  try {
    execSync(`ffmpeg -y -ss ${timeSeconds} -i "${inputPath}" -frames:v 1 "${outPath}"`, {
      timeout: 15000, stdio: 'ignore',
    });
    return fs.existsSync(outPath) ? outPath : null;
  } catch {
    coworkLog('WARN', 'mediaPipeline', 'Video frame extraction failed (install ffmpeg)');
    return null;
  }
}

export function getVideoDuration(inputPath: string): number | null {
  return getAudioDuration(inputPath); // 同一条 ffmpeg -i 命令既出音频也出视频时长
}

// ── Download helper ──

export async function downloadMedia(url: string, ext?: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    const detectedExt = ext || mimeToExt(contentType) || 'bin';
    const outPath = createTempPath(detectedExt);

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outPath, buffer);

    coworkLog('INFO', 'mediaPipeline', `Downloaded ${url} → ${outPath} (${buffer.length} bytes)`);
    return outPath;
  } catch (e) {
    coworkLog('WARN', 'mediaPipeline', `Download failed: ${e}`);
    return null;
  }
}

// ── MIME helpers ──

function mimeToExt(mime: string): string | null {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'application/pdf': 'pdf',
  };
  return map[mime.split(';')[0].trim()] || null;
}

export function extToMime(ext: string): string {
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    pdf: 'application/pdf',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

// ── File info ──

export function getMediaInfo(filePath: string): {
  exists: boolean; size: number; ext: string; mime: string;
  dimensions?: { width: number; height: number } | null;
  duration?: number | null;
} {
  if (!fs.existsSync(filePath)) return { exists: false, size: 0, ext: '', mime: '' };

  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = extToMime(ext);
  const isImage = mime.startsWith('image/');
  const isAV = mime.startsWith('audio/') || mime.startsWith('video/');

  return {
    exists: true,
    size: stat.size,
    ext,
    mime,
    dimensions: isImage ? getImageDimensions(filePath) : undefined,
    duration: isAV ? getAudioDuration(filePath) : undefined,
  };
}
