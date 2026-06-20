/**
 * seedanceProvider — 「AI 自动成片」的视频片段生成(走 NoobClaw 服务端代理 Seedance）。
 *
 * 架构(对齐 stockProvider / billing 的"重活在服务端、key 不下发"原则):
 *   · ARK key 在服务端(backend/src/routes/video.ts 的 /api/video/seedance/*)。
 *   · 客户端只发 { prompt, imageUrls(参考图 base64), duration, ratio, resolution },
 *     由服务端【先扣费再提交】Ark 异步任务,返回 taskId + chargeId;失败服务端幂等退款。
 *   · 客户端轮询 /status/:taskId 拿 succeeded 的 video_url,直接从公网 CDN 下载到本地
 *     (mp4 字节不经我们服务器,省带宽,跟 stock 下载一个路子)。
 *
 * 计费:每个片段在服务端按【时长 × 分辨率档】扣积分(seedance_price_cny_per_sec)。
 *   片段失败(Ark 拒绝/任务 failed)服务端按 chargeId 自动退款,客户端无需补偿。
 *
 * 成本控制(对齐用户"以最低成本生成最好视频"):
 *   · 默认 720p(分辨率倍率 1×),关键镜才上 1080p。
 *   · 每镜时长按该镜配音时长 clamp 到 [minDur, 12],不无脑拉满。
 *   · 限并发(Ark 账号级限流),逐镜失败优雅降级(交给 pipeline 用参考图/邻镜兜底)。
 */

import * as fs from 'fs';
import * as path from 'path';
import { getNoobClawAuthToken } from '../claudeSettings';

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

export type SeedanceResolution = '480p' | '720p' | '1080p';
export type SeedanceRatio = '9:16' | '16:9' | '1:1' | 'adaptive';
/** 模型档位:lite(1.0 Lite) | pro(1.0 Pro) | pro15(1.5 Pro,默认) | v2(2.0)。服务端映射真实模型 ID + 价格。 */
export type SeedanceTier = 'lite' | 'pro' | 'pro15' | 'v2';

export interface SeedanceSceneSpec {
  /** 该镜的画面 prompt(英文/中文均可,Seedance 双语)。 */
  prompt: string;
  /** 该镜目标时长(秒);内部 clamp 到 [4,12](1.5-pro 下限 4)。 */
  durationSec: number;
  /** 该镜【故事板首帧】data URL(故事板模式 i2v);有则用它做图生视频,无则退化文生视频。 */
  keyframeDataUrl?: string;
}

export interface SeedanceClipResult {
  /** 该镜成片本地路径;失败为 null(pipeline 据此降级)。 */
  path: string | null;
  /** 失败原因(供日志)。 */
  error?: string;
  /** 该镜实扣积分(服务端 create 时扣;失败镜服务端已退,不计入总额)。 */
  chargedTokens?: number;
}

export interface GenerateSeedanceOptions {
  scenes: SeedanceSceneSpec[];
  /** 参考图本地绝对路径(≤2),做风格/人设统一。会读成 data URL 发给服务端。 */
  referenceImages?: string[];
  resolution?: SeedanceResolution;
  /** 模型档位(默认 pro15 = 1.5 Pro)。 */
  tier?: SeedanceTier;
  ratio?: SeedanceRatio;
  /** 片段下载落地目录(临时素材目录)。 */
  destDir: string;
  /** 并发上限(Ark 账号级限流,默认 2)。 */
  concurrency?: number;
  /** 单镜最大等待秒数(轮询超时,默认 240)。 */
  perClipTimeoutSec?: number;
  /** 中断信号:用户「停止」时停止轮询、不再生成新镜。 */
  signal?: AbortSignal;
  /**
   * 进度回调。除常规进度文案外,在每镜【真成功落盘】时会带上该镜 chargedTokens,
   * pipeline 据此实时累加「上次消耗」(否则要等整个 generateSeedanceClips 跑完才累加,
   * 用户看不到顶部消耗跟着进度涨)。
   */
  onProgress?: (msg: string, chargedTokens?: number) => void;
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

/** 本地图片读成 data URL(服务端 image_url 接受 http(s) 或 data:image/*)。 */
function imageToDataUrl(absPath: string): string | null {
  try {
    if (!fs.existsSync(absPath)) return null;
    const ext = path.extname(absPath).toLowerCase();
    const mime = MIME_BY_EXT[ext] || 'image/jpeg';
    const b64 = fs.readFileSync(absPath).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> | null {
  const token = getNoobClawAuthToken();
  if (!token) return null;
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

interface CreateResult { taskId: string; chargeId: string; chargedTokens: number; }

/** 提交一个 Seedance 片段任务。返回 taskId+chargeId,或抛错(含 402 余额不足)。 */
async function createClip(
  prompt: string, imageUrls: string[], duration: number, ratio: string,
  resolution: string | undefined, tier: string | undefined,
): Promise<CreateResult> {
  const headers = authHeaders();
  if (!headers) throw new Error('未登录 NoobClaw');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 35_000);
  try {
    const resp = await fetch(`${apiBase()}/api/video/seedance/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt, imageUrls, duration, ratio, resolution, tier }),
      signal: ctrl.signal,
    });
    if (resp.status === 402) throw new Error('余额不足');
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`提交失败(${resp.status})${t ? ': ' + t.slice(0, 120) : ''}`);
    }
    const json: any = await resp.json();
    if (!json?.taskId) throw new Error('服务端未返回 taskId');
    return { taskId: json.taskId, chargeId: json.chargeId || '', chargedTokens: Number(json.chargedTokens) || 0 };
  } finally {
    clearTimeout(timer);
  }
}

interface StatusResult { status: 'queued' | 'running' | 'succeeded' | 'failed'; videoUrl?: string | null; error?: string; }

/** 查一次任务状态。 */
async function pollClipOnce(taskId: string, chargeId: string): Promise<StatusResult> {
  const headers = authHeaders();
  if (!headers) throw new Error('未登录 NoobClaw');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const url = `${apiBase()}/api/video/seedance/status/${encodeURIComponent(taskId)}`
      + (chargeId ? `?chargeId=${encodeURIComponent(chargeId)}` : '');
    const resp = await fetch(url, { headers, signal: ctrl.signal });
    if (!resp.ok) return { status: 'running' }; // 暂时性查询失败 → 当还在跑,下轮再试
    const json: any = await resp.json();
    return { status: json?.status || 'running', videoUrl: json?.videoUrl, error: json?.error };
  } finally {
    clearTimeout(timer);
  }
}

/** 把 CDN 上的成片下载到本地 mp4(片段小,直接 buffer 落盘)。重试 3 次,防 CDN 偶发 fetch failed。 */
async function downloadVideo(url: string, outPath: string): Promise<void> {
  if (!url) throw new Error('empty_video_url');
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      if (!resp.ok) throw new Error(`下载失败 ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buf);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(1500 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface StoryboardResult {
  /** 每镜首帧 dataURL 数组(失败为空)。 */
  images: string[];
  /** 服务端按张实扣的积分(失败/未配置为 0);计入「本次消耗」总额。 */
  chargedTokens: number;
  /** 失败原因(服务端返回的 error/detail 或异常信息),供进度展示排查;成功为空。 */
  error?: string;
}

/**
 * 故事板首帧:【逐张】调服务端 /api/image/storyboard 生成每镜首帧 dataURL。
 *
 * 为什么逐张而不是组图一次出 N 张:组图是单次长请求(6 张 >100s),必然撞 Cloudflare
 * 的 100s 超时(HTTP 524)→ 生产环境组图永远失败。逐张每张独立短请求(~20s)既绕开 524,
 * 又能逐张回进度(onProgress)。一致性靠每张都带【角色设定串(character)】文本维持。
 *
 * 返回的 images 按 shot 索引【对齐】(某张失败 → 该位置为空串 ''),pipeline 按 index 挂首帧,
 * 失败的那镜自动退化为纯文生视频。chargedTokens 为各张实扣之和。
 */
export async function generateStoryboard(
  opts: { shots: string[]; character?: string; style?: string; count?: number },
  onProgress?: (done: number, total: number) => void,
): Promise<StoryboardResult> {
  const headers = authHeaders();
  if (!headers) return { images: [], chargedTokens: 0, error: '未登录' };
  const shots = (opts.shots || []).filter((s) => typeof s === 'string' && s.trim());
  const total = shots.length;
  const images: string[] = new Array(total).fill('');
  let chargedTokens = 0;
  let okCount = 0;
  let lastError = '';
  // image2「单参考锚定」:第 1 张成功的首帧作锚点,后续每镜把它当参考图(图生图)→ 锁角色一致。
  let anchor = '';

  for (let i = 0; i < total; i++) {
    onProgress?.(i, total);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000); // 单张 < CF 100s,绝不触发 524
    try {
      const resp = await fetch(`${apiBase()}/api/image/storyboard`, {
        method: 'POST',
        headers,
        // 单镜单图:count=1。character 每张都带(文本一致)+ 有锚点时把锚点当参考图(图生图,更强一致)。
        body: JSON.stringify({
          shots: [shots[i]], character: opts.character || '', style: opts.style || '', count: 1,
          ...(anchor ? { referenceImage: anchor } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        let detail = '';
        try { const ej: any = await resp.json(); detail = ej?.detail || ej?.error || ''; }
        catch { try { detail = (await resp.text()).slice(0, 200); } catch { /* ignore */ } }
        lastError = `HTTP ${resp.status}${detail ? ' · ' + detail : ''}`;
        continue;
      }
      const json: any = await resp.json();
      const imgs = Array.isArray(json?.images) ? json.images.filter((s: any) => typeof s === 'string' && s) : [];
      chargedTokens += Number(json?.chargedTokens) || 0;
      if (imgs[0]) { images[i] = imgs[0]; okCount++; if (!anchor) anchor = imgs[0]; }
      else lastError = json?.error || 'empty';
    } catch (e) {
      lastError = String((e as any)?.message || e).slice(0, 200);
    } finally { clearTimeout(timer); }
  }
  onProgress?.(total, total);
  return { images, chargedTokens, error: okCount > 0 ? undefined : (lastError || 'all_failed') };
}

/** 生成单镜:create → 轮询 → 下载。失败返回 {path:null,error}(不抛,交给上层降级)。 */
async function generateOne(
  idx: number, scene: SeedanceSceneSpec, imageUrls: string[],
  ratio: string, resolution: string | undefined, tier: string | undefined, destDir: string, timeoutSec: number,
  signal: AbortSignal | undefined,
  onProgress?: (m: string, chargedTokens?: number) => void,
): Promise<SeedanceClipResult> {
  const duration = Math.max(4, Math.min(12, Math.round(scene.durationSec || 5)));
  // 故事板模式:该镜有首帧图 → 用它做 i2v(图生视频,更稳);否则用全局参考图 / 纯文生视频。
  const imgs = (scene.keyframeDataUrl && scene.keyframeDataUrl.length > 0) ? [scene.keyframeDataUrl] : imageUrls;
  try {
    const { taskId, chargeId, chargedTokens } = await createClip(scene.prompt, imgs, duration, ratio, resolution, tier);
    // 每镜【先扣费再生成】(服务端 /seedance/create 原子扣费),把这笔扣费显出来 ——
    // 否则用户只看到"生成中"、看不到扣费,会以为没收钱(失败镜服务端会自动退)。
    onProgress?.(chargedTokens > 0
      ? `💎 第 ${idx + 1} 镜 已扣 ${chargedTokens.toLocaleString()} 积分 · AI 生成中…`
      : `🎬 第 ${idx + 1} 镜 AI 生成中…`);
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      await sleep(5000);
      if (signal?.aborted) return { path: null, error: '已停止', chargedTokens };
      const st = await pollClipOnce(taskId, chargeId);
      if (st.status === 'succeeded') {
        if (!st.videoUrl) return { path: null, error: '成片无 video_url', chargedTokens };
        const outPath = path.join(destDir, `seedance_${idx + 1}_${taskId.slice(-8)}.mp4`);
        await downloadVideo(st.videoUrl, outPath);
        // 镜真成功落盘 → 把该镜 chargedTokens 透给 onProgress,pipeline 实时累加进「上次消耗」。
        //   失败镜走不到这条 emit(上方 return path:null),所以语义仍是「只计成功镜」,
        //   跟服务端「有 token 输出不退、0 输出才退」的退款策略对齐。
        onProgress?.(`✅ 第 ${idx + 1} 镜 AI 片段就绪`, chargedTokens);
        return { path: outPath, chargedTokens };
      }
      // 失败镜:服务端按 chargeId 自动退款,不计入实扣总额。
      if (st.status === 'failed') return { path: null, error: st.error || 'Ark 任务失败' };
    }
    return { path: null, error: '生成超时' };
  } catch (e) {
    return { path: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 批量生成各镜 Seedance 片段(限并发)。返回与 scenes 等长的结果数组(失败项 path:null）。
 * 服务端逐片段计费 + 失败自动退款,所以这里只管生成 + 收集,不处理钱。
 */
export async function generateSeedanceClips(opts: GenerateSeedanceOptions): Promise<SeedanceClipResult[]> {
  const { scenes, destDir } = opts;
  // 档位/分辨率不在客户端定:透传(可能 undefined)→ 服务端 create 端点决定。
  const resolution = opts.resolution;
  const tier = opts.tier;
  const ratio = opts.ratio || '9:16';
  // 并发 3 / 单镜超时 300s:失败或超时的镜会被 pipeline「就近复用」成重复画面,
  // 所以宁可多等、并发高一点,尽量让每镜都真生成出来,减少重复片段。
  const concurrency = Math.max(1, Math.min(4, opts.concurrency ?? 3));
  const timeoutSec = Math.max(60, Math.min(600, opts.perClipTimeoutSec ?? 300));

  // 参考图读成 data URL(≤2),所有镜共用 → 风格统一。
  const imageUrls = (opts.referenceImages || [])
    .slice(0, 2)
    .map(imageToDataUrl)
    .filter((u): u is string => !!u);

  const results = new Array<SeedanceClipResult>(scenes.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < scenes.length) {
      if (opts.signal?.aborted) break;
      const i = next++;
      results[i] = await generateOne(i, scenes[i], imageUrls, ratio, resolution, tier, destDir, timeoutSec, opts.signal, opts.onProgress);
    }
  };
  const n = Math.max(1, Math.min(concurrency, scenes.length));
  await Promise.all(Array.from({ length: n }, () => worker()));

  // 结尾汇总实扣积分(只计成功镜;失败镜服务端已退)。
  const okResults = results.filter((r) => r && r.path);
  const totalCharged = okResults.reduce((s, r) => s + (r.chargedTokens || 0), 0);
  if (totalCharged > 0) {
    opts.onProgress?.(`💎 AI 成片共扣 ${totalCharged.toLocaleString()} 积分(${okResults.length} 镜成功${okResults.length < scenes.length ? `,${scenes.length - okResults.length} 镜失败已退` : ''})`);
  }
  return results;
}
