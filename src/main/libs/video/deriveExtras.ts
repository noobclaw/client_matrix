/**
 * deriveExtras — 视频下载的「派生输出」引擎(纯本地 ffmpeg)。
 *
 * 视频无水印下载拿到的是平台直链 mp4(音视频已混流)。用户可选额外导出:
 *   · 无声视频  —— ffmpeg 去音轨、视频流拷贝不重编码(无损、秒级、免费)。平台短视频本身
 *                  无独立字幕轨,去音轨后即得「无声无字幕」干净底片,适合二创重配音/重配字。
 *   · 音轨      —— 抽原始音频流到 .m4a(优先拷贝 AAC,非 AAC 源转码)。免费。
 *
 * 两者都是纯本地 ffmpeg、零服务器成本,互相独立、单个失败不影响其它;产物放在和原视频
 * 【同目录】、同 base 名,方便用户在「打开输出文件夹」里一眼看到一组文件:
 *   foo.mp4 / foo_无声.mp4 / foo.m4a
 *
 * 注:字幕(语音转写)是另一档功能 —— 需要 ASR(本地模型或云端),作为独立项推进,不在此模块。
 */

import * as fs from 'fs';
import * as path from 'path';
import { runFfmpeg, isFfmpegAvailable } from './ffmpegRuntime';

export interface DeriveExtrasOpts {
  /** 导出去掉音轨的视频(= 无声无字幕视频)。 */
  mute?: boolean;
  /** 导出抽出来的音轨(.m4a)。 */
  audio?: boolean;
}

export interface DeriveExtrasResult {
  mutePath?: string;
  audioPath?: string;
  /** 每个派生项失败的简短原因(不抛错,逐项收集)。 */
  errors: string[];
}

/** 把 ffmpeg stderr 末行抽成一句简短原因。 */
function lastErr(stderr: string): string {
  const lines = (stderr || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 120) : 'failed';
}

export async function deriveVideoExtras(
  videoPath: string,
  opts: DeriveExtrasOpts,
): Promise<DeriveExtrasResult> {
  const res: DeriveExtrasResult = { errors: [] };
  const wantMute = !!opts.mute;
  const wantAudio = !!opts.audio;
  if (!wantMute && !wantAudio) return res;

  if (!videoPath || !fs.existsSync(videoPath)) {
    res.errors.push('源视频不存在');
    return res;
  }
  if (!isFfmpegAvailable()) {
    res.errors.push('ffmpeg 不可用,无法派生');
    return res;
  }

  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  const out = (suffix: string, ext: string) => path.join(dir, `${base}${suffix}.${ext}`);

  // 1) 无声视频:去音轨,视频流拷贝不重编码(无损、秒级)。
  if (wantMute) {
    const p = out('_无声', 'mp4');
    const r = await runFfmpeg(['-y', '-i', videoPath, '-map', '0:v:0', '-c', 'copy', '-an', p], { timeoutMs: 120_000 });
    if (r.ok && fs.existsSync(p)) res.mutePath = p;
    else res.errors.push('无声视频: ' + lastErr(r.stderr));
  }

  // 2) 音轨:抽原始音频流 → .m4a。优先 -c:a copy(无损保留 AAC);非 AAC 源拷贝会失败,退回转码 aac。
  if (wantAudio) {
    const m4a = out('', 'm4a');
    let r = await runFfmpeg(['-y', '-i', videoPath, '-vn', '-c:a', 'copy', m4a], { timeoutMs: 120_000 });
    if (!(r.ok && fs.existsSync(m4a))) {
      r = await runFfmpeg(['-y', '-i', videoPath, '-vn', '-c:a', 'aac', '-b:a', '192k', m4a], { timeoutMs: 180_000 });
    }
    if (r.ok && fs.existsSync(m4a)) res.audioPath = m4a;
    else res.errors.push('音轨: ' + lastErr(r.stderr));
  }

  return res;
}
