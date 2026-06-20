/**
 * mediaLimits — 用户上传素材(背景音乐 / 本地视频)的格式 + 大小白名单校验。
 *
 * 主进程(Electron)和 sidecar(Tauri)共用这一份逻辑,保证两种运行时对
 * 「能传什么、最大多大」的判断完全一致。文件选择框的扩展名过滤只是软提示
 * (个别系统能切到「所有文件」绕过),所以这里再按真实扩展名 + fs 实测体积
 * 兜一道,超限的直接剔除并把原因回给调用方提示用户。
 */
import * as fs from 'fs';
import * as path from 'path';

/** 背景音乐上限:20MB。够 320kbps 整曲(合成时混音读取无压力)。 */
export const BGM_MAX_BYTES = 20 * 1024 * 1024;
/** 单个本地视频素材上限:200MB。 */
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024;

/** 允许的音频扩展名(与文件选择框 filters 保持一致)。 */
export const AUDIO_EXTS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg'];
/** 允许的视频扩展名(与文件选择框 filters 保持一致)。 */
export const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'];

export interface MediaValidation {
  /** 通过校验的绝对路径(保持原顺序)。 */
  valid: string[];
  /** 被剔除的文件 + 中文原因(给 UI 提示)。 */
  rejected: { name: string; reason: string }[];
}

function fmtMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}

/**
 * 按格式 + 大小校验一批已选文件。kind 决定用哪套扩展名 / 体积上限。
 * 绝不抛错:读不到的文件按「无法读取」剔除。
 */
export function validateMediaFiles(
  paths: string[],
  kind: 'audio' | 'video',
): MediaValidation {
  const exts = kind === 'audio' ? AUDIO_EXTS : VIDEO_EXTS;
  const maxBytes = kind === 'audio' ? BGM_MAX_BYTES : VIDEO_MAX_BYTES;
  const valid: string[] = [];
  const rejected: { name: string; reason: string }[] = [];

  for (const p of paths || []) {
    if (!p) continue;
    const name = p.split(/[\\/]/).pop() || p;
    const ext = path.extname(p).toLowerCase().replace('.', '');
    if (!exts.includes(ext)) {
      rejected.push({ name, reason: `格式不支持（仅 ${exts.join(' / ')}）` });
      continue;
    }
    let size = -1;
    try { size = fs.statSync(p).size; } catch { /* 读不到 */ }
    if (size < 0) { rejected.push({ name, reason: '文件无法读取' }); continue; }
    if (size === 0) { rejected.push({ name, reason: '空文件' }); continue; }
    if (size > maxBytes) {
      rejected.push({ name, reason: `超过 ${fmtMB(maxBytes)}MB 上限（当前 ${fmtMB(size)}MB）` });
      continue;
    }
    valid.push(p);
  }

  return { valid, rejected };
}

/** 把 rejected 列表拼成给用户看的多行提示(空列表返回 '')。 */
export function rejectedMessage(rejected: { name: string; reason: string }[]): string {
  if (!rejected || rejected.length === 0) return '';
  return rejected.map((r) => `· ${r.name}：${r.reason}`).join('\n');
}
