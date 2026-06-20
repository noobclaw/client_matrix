/**
 * DingTalk Media Download Utilities
 */
import * as fs from 'fs';
import * as path from 'path';
import { getUserDataPath } from '../libs/platformAdapter';
import { fetchWithSystemProxy } from './http';
import type { IMMediaType } from './types';

const DINGTALK_API = 'https://api.dingtalk.com';
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const INBOUND_DIR = 'dingtalk-inbound';

/**
 * Get DingTalk media storage directory
 */
export function getDingtalkMediaDir(): string {
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
function generateFileName(prefix: string, extension: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}_${random}${extension}`;
}

/**
 * Get default extension based on media type
 */
function getDefaultExtension(mediaType: string): string {
  switch (mediaType) {
    case 'image': return '.jpg';
    case 'video': return '.mp4';
    case 'audio': return '.ogg';
    case 'voice': return '.ogg';
    case 'file': return '.bin';
    default: return '.bin';
  }
}

/**
 * Get default MIME type based on media type
 */
export function getDefaultMimeType(mediaType: string): string {
  switch (mediaType) {
    case 'image': return 'image/jpeg';
    case 'video': return 'video/mp4';
    case 'audio': return 'audio/ogg';
    case 'voice': return 'audio/ogg';
    case 'file': return 'application/octet-stream';
    default: return 'application/octet-stream';
  }
}

/**
 * Map DingTalk message type to IMMediaType
 */
export function mapDingtalkMediaType(mediaType: string): IMMediaType {
  switch (mediaType) {
    case 'image': return 'image';
    case 'video': return 'video';
    case 'audio': return 'audio';
    case 'voice': return 'voice';
    case 'file': return 'document';
    default: return 'document';
  }
}

/**
 * Download DingTalk media file
 *
 * Uses DingTalk bot message file download API:
 * POST /v1.0/robot/messageFiles/download
 *
 * @param accessToken DingTalk access_token
 * @param downloadCode downloadCode from the message
 * @param robotCode bot robotCode (i.e. clientId)
 * @param mediaType media type (image/video/audio/file)
 * @param fileName original file name (optional)
 */
export async function downloadDingtalkFile(
  accessToken: string,
  downloadCode: string,
  robotCode: string,
  mediaType: string,
  fileName?: string
): Promise<{ localPath: string; fileSize: number } | null> {
  try {
    console.log(`[DingTalk Media] 下载媒体文件:`, JSON.stringify({
      mediaType,
      fileName,
      downloadCodeLength: downloadCode.length,
    }));

    // Step 1: Get temporary download URL from DingTalk API
    const apiResponse = await fetchWithSystemProxy(
      `${DINGTALK_API}/v1.0/robot/messageFiles/download`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': accessToken,
        },
        body: JSON.stringify({ downloadCode, robotCode }),
      }
    );

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error(`[DingTalk Media] 获取下载URL失败: HTTP ${apiResponse.status}`, errorText);
      return null;
    }

    const apiResult = await apiResponse.json() as { downloadUrl?: string };
    if (!apiResult.downloadUrl) {
      console.error(`[DingTalk Media] API未返回downloadUrl:`, JSON.stringify(apiResult));
      return null;
    }

    console.log(`[DingTalk Media] 获取下载URL成功`);

    // Step 2: Download actual file from the temporary URL
    const fileResponse = await fetchWithSystemProxy(apiResult.downloadUrl);
    if (!fileResponse.ok) {
      console.error(`[DingTalk Media] 文件下载失败: HTTP ${fileResponse.status}`);
      return null;
    }

    const buffer = Buffer.from(await fileResponse.arrayBuffer());

    if (buffer.length > MAX_FILE_SIZE) {
      console.warn(`[DingTalk Media] 文件过大: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (限制: 20MB)`);
      return null;
    }

    // Determine file extension
    let extension = getDefaultExtension(mediaType);
    if (fileName) {
      const ext = path.extname(fileName);
      if (ext) extension = ext;
    }

    const localFileName = generateFileName(mediaType, extension);
    const mediaDir = getDingtalkMediaDir();
    const localPath = path.join(mediaDir, localFileName);

    fs.writeFileSync(localPath, buffer);

    console.log(`[DingTalk Media] Download successful: ${localFileName} (${(buffer.length / 1024).toFixed(1)} KB)`);

    return {
      localPath,
      fileSize: buffer.length,
    };
  } catch (error: any) {
    console.error(`[DingTalk Media] 下载失败: ${error.message}`);
    return null;
  }
}

/**
 * Clean up expired media files
 * @param maxAgeDays maximum retention days, default 7 days
 */
export function cleanupOldDingtalkMediaFiles(maxAgeDays: number = 7): void {
  const mediaDir = getDingtalkMediaDir();
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
        console.warn(`[DingTalk Media] 清理文件失败 ${file}: ${err.message}`);
      }
    }

    if (cleanedCount > 0) {
      console.log(`[DingTalk Media] 清理了 ${cleanedCount} 个过期文件`);
    }
  } catch (error: any) {
    console.warn(`[DingTalk Media] 清理错误: ${error.message}`);
  }
}
