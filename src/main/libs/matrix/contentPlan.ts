/**
 * 内容差异化 —— 矩阵号防判重的关键(对抗平台语义级查重)。
 *
 * 给一份基础成片配置(VideoCreationInput),为每个账号【重 roll】出一条不一样的片:
 * 轮换音色(口播音频不同)、字幕位置/字体/颜色、换镜节奏(maxClipSeconds 改变切片),
 * 复用现成成片管线 generateVideo 逐号产片 → 逐字节不同。复用旧 client 的 pipeline,
 * 不改它(矩阵只调用)。
 *
 * "每号发不一样的" = buildDifferentiatedInputs;"同条铺号" = 直接传同一份 PublishInput,
 * 不走这里。
 */

import { generateVideo } from '../video/pipeline';
import type { VideoCreationInput, SubtitlePosition } from '../video/pipeline';
import type { PublishInput } from '../video/publishers/types';

export interface DifferentiationOptions {
  voices?: string[];                       // 音色池(轮换)
  subtitlePositions?: SubtitlePosition[];  // 字幕位置池
  subtitleFonts?: string[];                // 字体文件名池(resources/fonts/ 下)
  subtitleColors?: string[];               // 字幕颜色池(#RRGGBB)
  maxClipSecondsPool?: number[];           // 换镜节奏池(改变切片 → 画面组合不同)
}

const DEFAULT_VOICES = ['zh-CN-YunjianNeural', 'zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-XiaoyiNeural'];
const DEFAULT_POSITIONS: SubtitlePosition[] = ['bottom', 'lower', 'center'];
const DEFAULT_CLIP_SECS = [3, 4, 5];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
// 安全取模(n 可能为负,如 hashStr 命中 INT_MIN)→ 永不返回 undefined。
function pick<T>(pool: T[], n: number): T { return pool[((n % pool.length) + pool.length) % pool.length]; }

/** 给某号派生一份差异化的成片配置(确定性:由 index + accountId 决定,可复现)。 */
export function differentiateInput(
  base: VideoCreationInput,
  accountId: string,
  index: number,
  opts: DifferentiationOptions = {},
): VideoCreationInput {
  const n = index + hashStr(accountId);
  const voices = opts.voices?.length ? opts.voices : DEFAULT_VOICES;
  const positions = opts.subtitlePositions?.length ? opts.subtitlePositions : DEFAULT_POSITIONS;
  const clipSecs = opts.maxClipSecondsPool?.length ? opts.maxClipSecondsPool : DEFAULT_CLIP_SECS;

  const out: VideoCreationInput = {
    ...base,
    videoCount: 1,                         // 每号一条
    voice: pick(voices, n),
    subtitlePosition: pick(positions, n),
    maxClipSeconds: pick(clipSecs, n),
  };
  if (opts.subtitleFonts?.length) out.subtitleFont = pick(opts.subtitleFonts, n);
  if (opts.subtitleColors?.length) out.subtitleColor = pick(opts.subtitleColors, n);
  return out;
}

/**
 * 为一批账号逐号产出差异化成片,返回 accountId → PublishInput(videoPath 指向各自的片)。
 * 串行产片(质量优先、慢无所谓);失败的号不进结果(taskRunner 会当 skipped)。
 * caption/tags 暂用 base 的(视频本身已差异化;文案逐号 AI 微改是后续增强)。
 */
export async function buildDifferentiatedInputs(
  accountIds: string[],
  base: VideoCreationInput,
  opts: DifferentiationOptions = {},
  emit?: (p: any) => void,
  signal?: AbortSignal,
): Promise<Record<string, PublishInput>> {
  const result: Record<string, PublishInput> = {};
  for (let i = 0; i < accountIds.length; i++) {
    if (signal?.aborted) break;
    const id = accountIds[i];
    const vin = differentiateInput(base, id, i, opts);
    try {
      const r = await generateVideo(vin, emit, signal);
      if (r.ok && r.outputPath) {
        result[id] = {
          videoPath: r.outputPath,
          title: base.publishTitle,
          description: base.publishCaption,
          tags: base.hashtags,
        };
      }
    } catch { /* 该号产片失败 → 不进 result,发布阶段当无内容跳过 */ }
  }
  return result;
}
