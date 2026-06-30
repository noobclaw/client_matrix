/**
 * 内容使用计数(去重 + 复用上限)—— 生产型任务(搬运/爆款仿写/…)共用。
 *
 * 旧做法:一条内容(post_id)用过一次就【永久跳过】(seen Set)。问题:内容消耗太快,关键词很快搜尽。
 * 新做法:同一条内容在【某号某平台】上最多用 cap 次(每次不同号/不同改写 → 不同成品),到 cap 才跳过。
 *   · 互动型(engage):cap=1(点过就不再碰,见 engageRunner 的 engageHistory,不走这里)。
 *   · 生产型(viral/repost):cap=3(默认,env MATRIX_CONTENT_REUSE_CAP 可调)。
 *
 * 兼容性:暴露 `.set`(已达上限的 id 集合,真 Set → orchestrator 的 `seenPostIds instanceof Set` 与 `.has()` 照用)
 *   + `.record(id)`(每用一次 +1,达上限加进 set 并落盘)。所以各 orchestrator 的 seenPostIds/recordSeen 契约【零改动】。
 * 存储极小:`{ post_id: 用过几次 }`,按 (账号, 平台) 分文件,超 1 万条裁最旧。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

function matrixDir(): string {
  return process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
}

/** 内容复用上限(env 可调,不写死)。默认 1 = 同一条内容只用一次(下载+上传成功即计 1 次,之后跳过)。 */
export function defaultContentReuseCap(): number {
  const n = parseInt(String(process.env.MATRIX_CONTENT_REUSE_CAP || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export interface ContentUsage {
  /** 已达复用上限(用满 cap 次)的 id 集合 —— 兼容 orchestrator 的 seenPostIds(真 Set)。 */
  set: Set<string>;
  /** 记录一次使用:count[id]+1,达 cap 加进 set 并落盘。 */
  record: (id: string) => void;
  /** 手动落盘(record 内部已落盘,一般不用单独调)。 */
  save: () => void;
  cap: number;
}

export function contentUsageStore(accountId: string, platform: string, cap?: number): ContentUsage {
  const CAP = Math.max(1, Number(cap) || defaultContentReuseCap());
  const dir = path.join(matrixDir(), 'content_usage', platform || 'src');
  const file = path.join(dir, `${accountId}.json`);
  let counts: Record<string, number> = {};
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object') counts = j; } catch { counts = {}; }
  const set = new Set<string>();
  for (const id of Object.keys(counts)) { if ((counts[id] || 0) >= CAP) set.add(id); }
  const save = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const keys = Object.keys(counts);
      if (keys.length > 10000) { for (const k of keys.slice(0, keys.length - 10000)) delete counts[k]; }
      fs.writeFileSync(file, JSON.stringify(counts));
    } catch { /* ignore */ }
  };
  const record = (id: string) => {
    const key = String(id || '').trim();
    if (!key) return;
    counts[key] = (counts[key] || 0) + 1;
    if (counts[key] >= CAP) set.add(key);
    save();
  };
  return { set, record, save, cap: CAP };
}
