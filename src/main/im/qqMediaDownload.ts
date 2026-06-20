/**
 * QQ Media Download Utilities
 */
import * as fs from 'fs';
import * as path from 'path';
import { getUserDataPath } from '../libs/platformAdapter';
import { fetchWithSystemProxy } from './http';
import type { IMMediaType } from './types';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const INBOUND_DIR = 'qq-inbound';

/**
 * Get QQ media storage directory
 */
export function getQQMediaDir(): string {
  const userDataPath = getUserDataPath();
  const mediaDir = path.join(userDataPath, INBOUND_DIR);

  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  return mediaDir;
}

/**
 * Generate unique file name
 */
function generateFileName(extension: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}_${random}${extension}`;
}

/**
 * Get file extension from MIME type
 */
function getExtensionFromMime(mimeType: string): string {
  const mimeMap: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/wav': '.wav',
    'audio/amr': '.amr',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
  };
  return mimeMap[mimeType] || '.bin';
}

/**
 * Map QQ SDK parsed type to IMMediaType
 */
export function mapQQMediaType(type: string): IMMediaType {
  switch (type) {
    case 'image': return 'image';
    case 'video': return 'video';
    case 'audio': return 'audio';
    case 'voice': return 'voice';
    default: return 'document';
  }
}

/**
 * Infer MIME type from file name
 */
function inferMimeType(type: string, fileName?: string): string {
  if (fileName) {
    const ext = path.extname(fileName).toLowerCase();
    const extMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.amr': 'audio/amr',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
    };
    if (extMap[ext]) return extMap[ext];
  }
  // Fallback based on type
  switch (type) {
    case 'image': return 'image/jpeg';
    case 'video': return 'video/mp4';
    case 'audio':
    case 'voice': return 'audio/mpeg';
    default: return 'application/octet-stream';
  }
}

/**
 * Download QQ attachment
 *
 * @param url QQ CDN download URL
 * @param type SDK parsed media type (image/video/audio/file)
 * @param fileName original file name (optional)
 */
export async function downloadQQAttachment(
  url: string,
  type: string,
  fileName?: string
): Promise<{ localPath: string; fileSize: number; mimeType: string } | null> {
  try {
    const mimeType = inferMimeType(type, fileName);
    console.log(`[QQ Media] 下载附件:`, JSON.stringify({
      type,
      mimeType,
      fileName,
    }));

    const response = await fetchWithSystemProxy(url);
    if (!response.ok) {
      console.error(`[QQ Media] 下载失败: HTTP ${response.status}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > MAX_FILE_SIZE) {
      console.warn(`[QQ Media] 文件过大: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (限制: 25MB)`);
      return null;
    }

    // Determine file extension
    let extension = getExtensionFromMime(mimeType);
    if (fileName) {
      const ext = path.extname(fileName);
      if (ext) extension = ext;
    }

    const localFileName = generateFileName(extension);
    const mediaDir = getQQMediaDir();
    const localPath = path.join(mediaDir, localFileName);

    fs.writeFileSync(localPath, buffer);

    console.log(`[QQ Media] 下载成功: ${localFileName} (${(buffer.length / 1024).toFixed(1)} KB)`);

    return {
      localPath,
      fileSize: buffer.length,
      mimeType,
    };
  } catch (error: any) {
    console.error(`[QQ Media] 下载失败: ${error.message}`);
    return null;
  }
}

/**
 * Clean up expired media files
 * @param maxAgeDays maximum retention days, default 7 days
 */
export function cleanupOldQQMediaFiles(maxAgeDays: number = 7): void {
  const mediaDir = getQQMediaDir();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  try {
    if (!fs.existsSync(mediaDir)) {
      return;
    }

    const files = fs.readdirSync(mediaDir);
    let cleanedCount = 0;

    for (const file of files) {
      const filePath = path.join(mediaDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          cleanedCount++;
        }
      } catch (err: any) {
        console.warn(`[QQ Media] 清理文件失败 ${file}: ${err.message}`);
      }
    }

    if (cleanedCount > 0) {
      console.log(`[QQ Media] 清理了 ${cleanedCount} 个过期文件`);
    }
  } catch (error: any) {
    console.warn(`[QQ Media] 清理错误: ${error.message}`);
  }
}
