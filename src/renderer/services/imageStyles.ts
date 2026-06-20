/**
 * Image style registry — fetched from backend on demand, memoized for the
 * lifetime of the renderer. Falls back to a hardcoded baked-in list if the
 * backend is unreachable (so wizards still render usable options offline).
 *
 * Source of truth: backend/src/services/imageStyles.ts. Keep the hardcoded
 * fallback below in sync at major releases — the backend list wins at
 * runtime so a server-side override propagates without a client release.
 */

import { getBackendApiUrl } from './endpoints';
import { noobClawAuth } from './noobclawAuth';

export interface ImageStyle {
  id: string;
  zh: string;
  en: string;
  icon: string;
  desc_zh: string;
  desc_en: string;
  prompt_prefix: string;
}

export const FALLBACK_IMAGE_STYLES: ImageStyle[] = [
  { id: 'ai_auto',     icon: '🪄', zh: 'AI 自由发挥', en: 'AI auto',       desc_zh: '让 AI 自己根据文案发挥', desc_en: 'Let AI freely interpret the copy', prompt_prefix: '' },
  { id: 'realistic',   icon: '📷', zh: '实景照片',    en: 'Realistic',     desc_zh: '真实摄影感',       desc_en: 'Real photo',         prompt_prefix: '风格:真实摄影' },
  { id: 'text_card',   icon: '🎴', zh: '文字卡片',    en: 'Text card',     desc_zh: '米白底大字',       desc_en: 'Cream bg',           prompt_prefix: '风格:文字卡片' },
  { id: 'illustration',icon: '✏️', zh: '手绘插画',    en: 'Illustration',  desc_zh: '扁平 + 清新',       desc_en: 'Flat & fresh',       prompt_prefix: '风格:手绘插画' },
  { id: 'cinematic',   icon: '🎬', zh: '电影质感',    en: 'Cinematic',     desc_zh: '光影 + 氛围',       desc_en: 'Moody lighting',     prompt_prefix: '风格:电影质感' },
  { id: 'anime',       icon: '🌸', zh: '动漫风格',    en: 'Anime',         desc_zh: '日系二次元',       desc_en: 'Japanese anime',     prompt_prefix: '风格:日系动漫' },
  { id: '3d_render',   icon: '🧊', zh: '3D 渲染',     en: '3D render',     desc_zh: '立体质感',         desc_en: 'Volumetric',         prompt_prefix: '风格:3D 渲染' },
  { id: 'vintage',     icon: '🎞️', zh: '复古胶片',    en: 'Vintage',       desc_zh: '怀旧颗粒',         desc_en: 'Grainy retro',       prompt_prefix: '风格:复古胶片' },
  { id: 'minimalist',  icon: '◻️', zh: '极简设计',    en: 'Minimalist',    desc_zh: '留白 + 单色',       desc_en: 'Whitespace',         prompt_prefix: '风格:极简设计' },
  { id: 'ink_wash',    icon: '🖌️', zh: '水墨国风',    en: 'Ink wash',      desc_zh: '中国水墨写意',     desc_en: 'Chinese ink',        prompt_prefix: '风格:中国水墨' },
  { id: 'oil_painting',icon: '🖼️', zh: '油画风格',    en: 'Oil painting',  desc_zh: '厚涂笔触',         desc_en: 'Thick strokes',      prompt_prefix: '风格:古典油画' },
  { id: 'watercolor',  icon: '💧', zh: '水彩绘画',    en: 'Watercolor',    desc_zh: '透明渐染',         desc_en: 'Soft wash',          prompt_prefix: '风格:水彩绘画' },
  { id: 'cyberpunk',   icon: '🌃', zh: '赛博朋克',    en: 'Cyberpunk',     desc_zh: '霓虹 + 未来',       desc_en: 'Neon future',        prompt_prefix: '风格:赛博朋克' },
];

export const DEFAULT_IMAGE_STYLE_ID = 'ai_auto';

let cached: { styles: ImageStyle[]; default_id: string } | null = null;
let inflight: Promise<{ styles: ImageStyle[]; default_id: string }> | null = null;

export async function fetchImageStyles(): Promise<{ styles: ImageStyle[]; default_id: string }> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(`${getBackendApiUrl()}/api/image/styles`, {
        headers: noobClawAuth.getAuthHeaders(),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (Array.isArray(json?.styles) && json.styles.length > 0) {
        cached = { styles: json.styles, default_id: json.default_id || DEFAULT_IMAGE_STYLE_ID };
        return cached;
      }
      throw new Error('empty styles');
    } catch (e) {
      console.warn('[imageStyles] fetch failed, using hardcoded fallback:', (e as Error).message);
      cached = { styles: FALLBACK_IMAGE_STYLES, default_id: DEFAULT_IMAGE_STYLE_ID };
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
