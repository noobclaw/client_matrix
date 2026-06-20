/**
 * ttsAlign — 配音「一口气」整段合成的【纯函数】:字幕解析 + 切句对齐。
 *
 * 抽成独立、零运行时依赖(无 fs / electron / 浏览器)的模块,既给 tts.ts 复用,
 * 也能被测试 harness 直接 transpile + 调用验证(对齐算法是音画同步的唯一风险点,必须可测)。
 *
 * 对齐思路见 alignSentencesToCues 注释。
 */

/** 一条字幕 cue(时间相对【本次合成】起点,秒)。 */
export interface TtsCue {
  text: string;
  start: number;
  end: number;
}

/**
 * 解析 edge-tts 写出的字幕文本 —— 同时兼容 SRT(`HH:MM:SS,mmm`)与 VTT(`HH:MM:SS.mmm`)
 * (edge-tts 版本不同输出不同)。返回逐条 cue(时间相对本段起点)。
 */
export function parseSubtitleText(raw: string): TtsCue[] {
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  // 毫秒分隔符 [.,] 同时吃 VTT 的点和 SRT 的逗号。
  const re = /(\d{2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{1,3})/;
  const cues: TtsCue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const toSec = (h: string, mi: string, s: string, ms: string) =>
      Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
    const start = toSec(m[1], m[2], m[3], m[4]);
    const end = toSec(m[5], m[6], m[7], m[8]);
    const textLines: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (!lines[j].trim()) break;
      textLines.push(lines[j].trim());
    }
    i = j;
    const text = textLines.join(' ').replace(/\s+/g, ' ').trim();
    if (text && end > start) cues.push({ text, start, end });
  }
  return cues;
}

/** 去标点 + 空格,只留「会发音」的字符,用于字符流对齐(两侧都用同一套规则)。 */
export function stripForAlign(s: string): string {
  return (s || '')
    .replace(/\s+/g, '')
    // 常见中英标点 / 省略号 / 破折号 / 各类括号引号 / 话题符
    .replace(/[，。！？!?；;、,.:：…⋯—–\-~～·•“”"'‘’「」『』（）()【】\[\]{}《》#@*_/\\|]/g, '');
}

/**
 * 把整段 cue 的时间轴按【去标点空格字符流】映射回 sentences[] 的每句边界。
 * 返回每句 {start,end}(秒,整段时间轴,无缝衔接:句 i 的 end == 句 i+1 的 start)。
 * 对不齐(cue 空 / 字符数差异过大 / 时间非法)返回 null —— 调用方回退逐句合成。
 *
 * 为什么靠谱:逐句边界都锚到 cue 的【真实结束时间戳】,不按比例估时长 → 不累积误差。
 * edge-tts 整段分句/cue 粒度不可控,但只要它念的字符流与我们文本基本一致(去标点后),
 * 累计映射就成立;数字/英文被 edge-tts 规整导致字符数差异过大时(ratio 越界)返回 null。
 */
export function alignSentencesToCues(
  sentences: string[], rawCues: TtsCue[], totalDur: number,
): Array<{ start: number; end: number }> | null {
  if (!sentences.length || !rawCues.length || !(totalDur > 0)) return null;

  // 1) cue 字符 → 结束时间 的锚点流(每个 cue 内字符按 [start,end] 均匀分布)。
  const charEnd: number[] = [];
  for (const c of rawCues) {
    const n = stripForAlign(c.text).length;
    if (n === 0) continue;
    const span = Math.max(0, c.end - c.start);
    for (let k = 0; k < n; k++) charEnd.push(c.start + (span * (k + 1)) / n);
  }
  if (charEnd.length === 0) return null;

  // 2) 句子去标点字符数;与 cue 字符流数量级要相当,否则 edge-tts 念的≠我们的文本 → 放弃。
  const sentLens = sentences.map((s) => stripForAlign(s).length);
  const totalSent = sentLens.reduce((a, n) => a + n, 0);
  if (totalSent === 0) return null;
  const ratio = charEnd.length / totalSent;        // cue字符 / 句字符
  if (ratio < 0.75 || ratio > 1.34) return null;   // 差异 >~33% 判对不齐

  // 3) 句界(句字符空间)→ 缩放到 cue 字符 index → 取该 index 的真实结束时间作为句界时间。
  const times: number[] = [0];
  let acc = 0;
  for (let i = 0; i < sentLens.length; i++) {
    acc += sentLens[i];
    if (i === sentLens.length - 1) { times.push(totalDur); break; }
    const idx = Math.min(charEnd.length - 1, Math.max(0, Math.round(acc * ratio) - 1));
    times.push(charEnd[idx]);
  }
  // 单调化 + 防 0/负/重叠;末项钉到整段末。
  for (let i = 1; i < times.length; i++) {
    if (!(times[i] > times[i - 1])) times[i] = Math.min(totalDur, times[i - 1] + 0.3);
  }
  times[times.length - 1] = Math.max(totalDur, times[times.length - 2] + 0.3);

  const out: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < sentLens.length; i++) out.push({ start: times[i], end: times[i + 1] });
  // 最终校验:每段时长 > 0。
  if (out.some((s) => !(s.end > s.start))) return null;
  return out;
}
