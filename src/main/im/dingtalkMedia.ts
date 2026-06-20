/**
 * DingTalk Media Upload Utilities
 */
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';
import { sanitizeLogArgs, sanitizeSensitiveString } from './logSanitizer';

const DINGTALK_OAPI = 'https://oapi.dingtalk.com';
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

// Legacy oapi access_token cache
let oapiAccessToken: string | null = null;
let oapiTokenExpiry = 0;

export type DingTalkMediaType = 'image' | 'voice' | 'video' | 'file';

export interface MediaUploadResult {
  success: boolean;
  mediaId?: string;
  error?: string;
}

// File extension categories
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
const AUDIO_EXTENSIONS = ['.ogg', '.amr', '.mp3', '.wav', '.m4a', '.aac'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov'];

/**
 * Get legacy oapi access_token
 * Legacy oapi API requires a different token retrieval method
 */
export async function getOapiAccessToken(appKey: string, appSecret: string): Promise<string> {
  const now = Date.now();
  if (oapiAccessToken && oapiTokenExpiry > now + 60000) {
    console.log(`[DingTalk Media] 使用缓存的 oapi token, 剩余有效期: ${Math.round((oapiTokenExpiry - now) / 1000)}秒`);
    return oapiAccessToken;
  }

  console.log(`[DingTalk Media] 获取新的 oapi token...`);

  const response = await axios.get<{ access_token: string; expires_in: number; errcode?: number; errmsg?: string }>(
    `${DINGTALK_OAPI}/gettoken`,
    {
      params: {
        appkey: appKey,
        appsecret: appSecret,
      },
    }
  );

  if (response.data.errcode && response.data.errcode !== 0) {
    console.error(`[DingTalk Media] 获取 oapi token 失败:`, JSON.stringify(response.data));
    throw new Error(`获取 oapi token 失败: ${response.data.errmsg}`);
  }

  oapiAccessToken = response.data.access_token;
  oapiTokenExpiry = now + response.data.expires_in * 1000;
  console.log(`[DingTalk Media] 获取 oapi token 成功, 有效期: ${response.data.expires_in}秒`);
  return oapiAccessToken;
}

/**
 * Upload media file to DingTalk
 */
export async function uploadMediaToDingTalk(
  accessToken: string,
  filePath: string,
  mediaType: DingTalkMediaType,
  fileName?: string
): Promise<MediaUploadResult> {
  console.log(`[DingTalk Media] 开始上传媒体文件:`, JSON.stringify({ filePath, mediaType, fileName }));

  try {
    // Handle path (supports file:// protocol)
    const absPath = filePath.startsWith('file://')
      ? decodeURIComponent(filePath.replace('file://', ''))
      : path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

    console.log(`[DingTalk Media] 解析后的绝对路径: ${absPath}`);

    // Validate file
    if (!fs.existsSync(absPath)) {
      console.error(`[DingTalk Media] 文件不存在: ${absPath}`);
      return { success: false, error: `文件不存在: ${absPath}` };
    }

    const stats = fs.statSync(absPath);
    console.log(`[DingTalk Media] 文件大小: ${(stats.size / 1024).toFixed(1)}KB`);

    if (stats.size > MAX_FILE_SIZE) {
      console.error(`[DingTalk Media] 文件过大: ${(stats.size / 1024 / 1024).toFixed(1)}MB (限制20MB)`);
      return { success: false, error: `文件过大: ${(stats.size / 1024 / 1024).toFixed(1)}MB (限制20MB)` };
    }

    // Create FormData
    const form = new FormData();
    const mimeType = getMimeType(absPath);
    // Use custom file name or extract from path
    const uploadFileName = fileName || path.basename(absPath);
    console.log(`[DingTalk Media] MIME 类型: ${mimeType}, 文件名: ${uploadFileName}`);

    form.append('media', fs.createReadStream(absPath), {
      filename: uploadFileName,
      contentType: mimeType,
    });

    // Upload to DingTalk
    const uploadUrl = `${DINGTALK_OAPI}/media/upload?access_token=${accessToken}&type=${mediaType}`;
    console.log(sanitizeSensitiveString(`[DingTalk Media] 上传 URL: ${uploadUrl}`));

    const response = await axios.post(
      uploadUrl,
      form,
      {
        headers: form.getHeaders(),
        maxContentLength: MAX_FILE_SIZE,
        maxBodyLength: MAX_FILE_SIZE,
        timeout: 60000,
      }
    );

    console.log(`[DingTalk Media] 上传响应:`, JSON.stringify(response.data));

    if (response.data.errcode && response.data.errcode !== 0) {
      console.error(`[DingTalk Media] 钉钉API错误: ${response.data.errmsg}`);
      return { success: false, error: `钉钉API错误: ${response.data.errmsg}` };
    }

    console.log(`[DingTalk Media] 上传成功, media_id: ${response.data.media_id}`);
    return { success: true, mediaId: response.data.media_id };
  } catch (error: any) {
    console.error(...sanitizeLogArgs(['[DingTalk Media] 上传失败:', error.message, error.response?.data]));
    return { success: false, error: `上传失败: ${error.message}` };
  }
}

/**
 * Determine media type based on file extension
 */
export function detectMediaType(filePath: string): DingTalkMediaType {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'voice';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  return 'file';
}

/**
 * Get file MIME type
 */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.ogg': 'audio/ogg',
    '.amr': 'audio/amr',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

/**
 * Check if file path is an image
 */
export function isImagePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}
