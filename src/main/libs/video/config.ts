/**
 * config — 视频创作的客户端运行期配置。
 *
 * ⚠️ 这里【不】放任何在线素材库 API key —— Pexels/Pixabay 的 key 必须留在服务端
 * (见 stockProvider.ts:走 /api/video/stock/search 代理)。客户端只留无需鉴权的
 * 本地偏好(目前就一个 edge-tts 音色),可被 userData/video-config.json 覆盖。
 */

import fs from 'fs';
import path from 'path';
import { getUserDataPath } from '../platformAdapter';

interface VideoLocalConfig {
  /** edge-tts 默认音色,可在 json 里覆盖。 */
  ttsVoice?: string;
}

let _cache: VideoLocalConfig | null = null;

function configPath(): string {
  return path.join(getUserDataPath(), 'video-config.json');
}

function readLocalConfig(): VideoLocalConfig {
  if (_cache) return _cache;
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    _cache = JSON.parse(raw) as VideoLocalConfig;
  } catch {
    _cache = {};
  }
  return _cache;
}

/** 强制重读(测试时改了 json 后调用)。 */
export function reloadVideoConfig(): void {
  _cache = null;
}

export function getTtsVoice(): string {
  const local = readLocalConfig();
  return process.env.NOOBCLAW_TTS_VOICE || local.ttsVoice || 'zh-CN-XiaoxiaoNeural';
}
