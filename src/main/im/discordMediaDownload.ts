/**
 * Discord Media Download Utilities
 */
import * as fs from 'fs';
import * as path from 'path';
import { getUserDataPath } from '../libs/platformAdapter';
import { fetchWithSystemProxy } from './http';
import type { IMMediaType } from './types';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const INBOUND_DIR = 'discord-inbound';

/**
 * Get Discord media storage directory
 */
export function getDiscordMediaDir(): string {
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
    'application/pdf': '.pdf',
    'application/zip': '.zip',
  };
  return mimeMap[mimeType] || '.bin';
}

/**
 * Map Discord contentType to IMMediaType
 */
export function mapDiscordContentType(contentType: string | null): IMMediaType {
  if (!contentType) return 'document';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Download Discord attachment
 *
 * @param url Discord CDN download URL
 * @param mimeType MIME type
 * @param fileName original file name (optional)
 */
export async function downloadDiscordAttachment(
  url: string,
  mimeType: string,
  fileName?: string
): Promise<{ localPath: string; fileSize: number } | null> {
  try {
    console.log(`[Discord Media] 下载附件:`, JSON.stringify({
      mimeType,
      fileName,
    }));

    const response = await fetchWithSystemProxy(url);
    if (!response.ok) {
      console.error(`[Discord Media] 下载失败: HTTP ${response.status}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > MAX_FILE_SIZE) {
      console.warn(`[Discord Media] 文件过大: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (限制: 25MB)`);
      return null;
    }

    // Determine file extension
    let extension = getExtensionFromMime(mimeType);
    if (fileName) {
      const ext = path.extname(fileName);
      if (ext) extension = ext;
    }

    const localFileName = generateFileName(extension);
    const mediaDir = getDiscordMediaDir();
    const localPath = path.join(mediaDir, localFileName);

    fs.writeFileSync(localPath, buffer);

    console.log(`[Discord Media] 下载成功: ${localFileName} (${(buffer.length / 1024).toFixed(1)} KB)`);

    return {
      localPath,
      fileSize: buffer.length,
    };
  } catch (error: any) {
    console.error(`[Discord Media] 下载失败: ${error.message}`);
    return null;
  }
}

/**
 * Clean up expired media files
 * @param maxAgeDays maximum retention days, default 7 days
 */
export function cleanupOldDiscordMediaFiles(maxAgeDays: number = 7): void {
  const mediaDir = getDiscordMediaDir();
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
        console.warn(`[Discord Media] 清理文件失败 ${file}: ${err.message}`);
      }
    }

    if (cleanedCount > 0) {
      console.log(`[Discord Media] 清理了 ${cleanedCount} 个过期文件`);
    }
  } catch (error: any) {
    console.warn(`[Discord Media] 清理错误: ${error.message}`);
  }
}
