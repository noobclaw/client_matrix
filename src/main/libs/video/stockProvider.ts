/**
 * stockProvider — 按关键词取免费在线素材库(Pexels + Pixabay)的竖屏图片。
 *
 * ⚠️ key 必须留在服务端:搜索走 NoobClaw 服务端代理(/api/video/stock/search),
 * 服务端用自己持有的 key 搜好,返回【公开 CDN 图片 URL】列表;客户端直接下载这些
 * URL(图片 URL 本身不需要 key)。客户端不持有、也不打包任何素材库 key。
 *
 * 一期画面策略:用户参考图优先 → 不够的用这里的素材库图补 → 再不够上文字卡。
 * 只取图片(配 Ken Burns 运镜假装动起来),素材库视频留到后续。
 *
 * 没网 / 服务端没配 key → 返回空数组,上层自动降级到文字卡。
 */

import fs from 'fs';
import path from 'path';
import { probeImageSize, probeDuration } from './ffmpegRuntime';

const REQ_TIMEOUT_MS = 15_000;
/**
 * 单段视频下载超时。素材 clip 一般几 MB,正常几秒就下完;给到 25s 已很宽。
 * 收紧(原 60s)是因为:逐词串行 + 60s/段会让一个慢词白等好几分钟看着像卡死,
 * 25s 下不完基本就是链路卡住,早 bail 早试下一段/下一词。
 */
const VIDEO_REQ_TIMEOUT_MS = 25_000;
/** 同一搜索词内并发下载的段数上限(并发提速,又不至于把带宽打满让每段都变慢)。 */
const VIDEO_DOWNLOAD_CONCURRENCY = 4;
/**
 * 搜索阶段并发上限。搜索是【延迟瓶颈】(每词一次双跳往返:客户端→我们服务端→素材库),
 * 不吃带宽;并发把 N 个词的 N×RTT 压成 ~ceil(N/limit)×RTT —— 这是「搜索半天没动静」的
 * 主要提速点。下载才是带宽瓶颈,所以下载仍逐词串行(词内 4 并发),不在这里堆并发。
 */
const SEARCH_CONCURRENCY = 6;
/** 低于这个边长的素材图拉伸到 1080×1920 会糊,直接拒收(抄 MoneyPrinterTurbo 的 480 门槛)。 */
const MIN_IMAGE_EDGE = 480;
/** 太短的素材视频(<2s)拼起来太碎,拒收。 */
const MIN_VIDEO_SEC = 2;
/**
 * 在线视频素材最低短边(像素)。短边低于此值再上采样到 1080 竖屏会明显发糊。
 * MPT 的做法是 Pexels 精确匹配目标分辨率 / Pixabay 要求 w≥目标宽;我们经服务端
 * 代理只拿到一个 URL,改为统一卡「短边 ≥720」——上采样到 1080 最多 1.5×,画质可接受。
 */
const MIN_VIDEO_EDGE = 720;

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getNoobClawAuthToken } = require('../claudeSettings');
    const token = getNoobClawAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch { /* token 取不到就裸调,服务端会 401 */ }
  return headers;
}

async function downloadTo(url: string, destPath: string, minEdge = MIN_IMAGE_EDGE): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    // 带浏览器 UA + google Referer:很多图床对无 UA 的请求 403。Referer 用 google(不是图片
    //   自己的 origin —— 那反而像盗链被拒),多数图床对「从 google 图片点进来」放行(SEO 考量);
    //   google 缩略图 CDN(gstatic)更是无所谓。Pexels/Pixabay 也接受,无副作用。
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': 'https://www.google.com/',
      },
    });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) return false; // junk / error page
    fs.writeFileSync(destPath, buf);
    // 分辨率门槛:太小的图拉满竖屏会糊,拒收并删文件
    const { width, height } = await probeImageSize(destPath);
    if (width > 0 && height > 0 && (width < minEdge || height < minEdge)) {
      try { fs.unlinkSync(destPath); } catch {}
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 画幅方向(决定素材库搜竖屏/横屏/方形)。 */
export type StockOrientation = 'portrait' | 'landscape' | 'square';

/** 调服务端代理搜图,返回公开 CDN 图片 URL 列表(服务端持有 key)。 */
async function searchViaServer(keywords: string[], count: number, orientation: StockOrientation): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const qs = new URLSearchParams({
      keywords: keywords.join(','),
      count: String(count),
      orientation,
    });
    // 服务端 /stock/search 现在挂了 authMiddleware,必须带 NoobClaw JWT。
    // 没登录 → 没 token → 服务端 401 → 这里 catch 返空 → 上层降级文字卡。
    const res = await fetch(`${apiBase()}/api/video/stock/search?${qs.toString()}`, {
      signal: ctrl.signal,
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const images = json?.images;
    return Array.isArray(images) ? images.filter((u: any): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchStockOptions {
  keywords: string[];
  /** 需要的图片张数。 */
  count: number;
  /** 下载目录(需已存在)。 */
  destDir: string;
  /** 画幅方向,默认 portrait。 */
  orientation?: StockOrientation;
  /** 素材图最低边长(像素),低于则拒收。默认 MIN_IMAGE_EDGE。 */
  minImageEdge?: number;
}

/**
 * 经服务端代理搜图并下载到本地,返回本地绝对路径数组(长度 ≤ count)。
 * 服务端没 key / 没网时返回 []。
 */
export async function fetchStockImages(opts: FetchStockOptions): Promise<string[]> {
  const { keywords, count, destDir } = opts;
  if (count <= 0) return [];

  // 服务端会多返一些候选(下载可能失败/是错误页),这里多要点冗余
  const urls = await searchViaServer(keywords, count, opts.orientation ?? 'portrait');
  if (urls.length === 0) return [];

  const results: string[] = [];
  let idx = 0;
  for (const url of urls) {
    if (results.length >= count) break;
    const ext = (url.split('?')[0].match(/\.(jpg|jpeg|png|webp)$/i)?.[1] || 'jpg').toLowerCase();
    const dest = path.join(destDir, `stock_${String(idx).padStart(3, '0')}.${ext}`);
    idx++;
    const ok = await downloadTo(url, dest, opts.minImageEdge ?? MIN_IMAGE_EDGE);
    if (ok) results.push(dest);
  }

  return results;
}

/**
 * 给定一组公开图片 URL,直接下载到本地(复用 downloadTo 的体积/分辨率校验)。
 * 热搜成片用:Serper /images / og:image 已返回 URL 列表,无需再走关键词搜索。
 * 新闻配图常比素材库图小、且多为横图(og:image 16:9),minEdge 放宽到 360,
 * 不然卡 480 会把新闻图几乎删光;Ken Burns 运镜阶段会按竖屏裁切,小图上采样可接受。
 */
export async function downloadImagesFromUrls(
  urls: string[],
  destDir: string,
  minEdge = 200,        // 放宽:容 google 缩略图(~225px)+ 多数新闻图;卡太死会把图删光
  maxCount = Infinity,  // 凑够这么多张就停,不必把上百候选全下完(原图在前,够了就不用动缩略图)
): Promise<string[]> {
  // ⚠️ 必须并发,不能串行 for-await:候选里有防盗链原图 / 墙内连不上的 gstatic 缩略图,
  //   单个 downloadTo 失败要死等满 REQ_TIMEOUT_MS(15s)。串行 60+ 候选 → 最坏十几分钟卡死
  //   (用户实测「准备画面素材」一直卡)。并发 8 + 下够 maxCount 立即停 → 几秒~几十秒拿够。
  const valid = urls.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
  const results: string[] = [];
  const CONCURRENCY = 8;
  let next = 0;
  let stop = false;
  const worker = async () => {
    while (!stop) {
      const i = next++;
      if (i >= valid.length || results.length >= maxCount) break;
      const url = valid[i];
      const ext = (url.split('?')[0].match(/\.(jpg|jpeg|png|webp)$/i)?.[1] || 'jpg').toLowerCase();
      const dest = path.join(destDir, `hotspot_${String(i).padStart(3, '0')}.${ext}`);
      const ok = await downloadTo(url, dest, minEdge);
      if (ok) {
        results.push(dest);
        if (results.length >= maxCount) { stop = true; break; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, valid.length) }, worker));
  return maxCount === Infinity ? results : results.slice(0, maxCount);
}

// ─────────────────────────── 视频素材 ───────────────────────────

interface StockVideoMeta {
  url: string;
  durationSec: number;
  width: number;
  height: number;
}

/** 调服务端代理搜视频(type=video),返回公开 CDN 视频 URL + 元数据。 */
async function searchVideosViaServer(
  keywords: string[], count: number, orientation: StockOrientation, locale?: string, size?: string,
): Promise<StockVideoMeta[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const qs = new URLSearchParams({
      keywords: keywords.join(','),
      count: String(count),
      orientation,
      type: 'video',
    });
    // locale:区域语境兜底(母语长尾词也能命中);size:Pexels 源头最低分辨率档(small=HD≥720)。
    if (locale) qs.set('locale', locale);
    if (size) qs.set('size', size);
    const res = await fetch(`${apiBase()}/api/video/stock/search?${qs.toString()}`, {
      signal: ctrl.signal,
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const videos = json?.videos;
    if (!Array.isArray(videos)) return [];
    return videos
      .filter((v: any) => v && typeof v.url === 'string')
      .map((v: any) => ({
        url: v.url as string,
        durationSec: Number(v.durationSec) || 0,
        width: Number(v.width) || 0,
        height: Number(v.height) || 0,
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 下载一个视频文件并【探时长验真伪 + 卡分辨率】(probe 走 ffmpeg -i,抄 MPT save_video 的完整性校验思路)。
 * 返回真实宽高 / 时长;任何一关不过就删文件返 null:
 *   · 时长探不到(probeDuration<=0)→ 下到的是错误页/损坏文件,删。这是关键:坏 clip
 *     若放进合成会让 ffmpeg 在 renderSceneBg 阶段报错拖垮整条视频。
 *   · 短边 < MIN_VIDEO_EDGE → 低清,上采样会糊,删(G2;兜底服务端 meta 缺失/不准的情况)。
 */
async function downloadVideoTo(
  url: string,
  destPath: string,
  minEdge = MIN_VIDEO_EDGE,
): Promise<{ width: number; height: number; durationSec: number } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VIDEO_REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 16 * 1024) return null; // junk / error page
    fs.writeFileSync(destPath, buf);
    // G1 完整性:探不到时长 = 损坏 / 非视频,删。
    const durationSec = await probeDuration(destPath);
    if (durationSec <= 0) { try { fs.unlinkSync(destPath); } catch {} return null; }
    // G2 分辨率门槛:真实短边低于阈值,删。
    const { width, height } = await probeImageSize(destPath);
    if (width > 0 && height > 0 && Math.min(width, height) < minEdge) {
      try { fs.unlinkSync(destPath); } catch {}
      return null;
    }
    return { width, height, durationSec };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface StockVideoAsset {
  /** 本地绝对路径。 */
  path: string;
  /** 时长(秒),服务端 ffprobe/库元数据给的,可能为 0(未知)。 */
  durationSec: number;
  width: number;
  height: number;
}

/** 一个搜索词 → 它搜到并下好的素材视频(保留归属,供按分镜内容匹配)。 */
export interface StockVideoByTerm {
  term: string;
  assets: StockVideoAsset[];
}

export interface FetchVideosByTermsOptions {
  /** 逐个搜索的英文搜索词(已去重)。 */
  terms: string[];
  /** 每个搜索词下载几段视频。默认 4。 */
  perTermCount?: number;
  /** 下载目录(需已存在)。 */
  destDir: string;
  /** 画幅方向,默认 portrait;决定搜竖/横/方素材 + 比例过滤方向。 */
  orientation?: StockOrientation;
  /** 区域 locale(如 zh-CN / ja-JP / en-US),透传给素材库做语境兜底。可选。 */
  locale?: string;
  /** Pexels 视频最低分辨率档:small=HD / medium=Full HD / large=4K。默认 small。 */
  videoSize?: string;
  /** 下载后真实 probe 的最低短边(像素)。默认 MIN_VIDEO_EDGE。 */
  minVideoEdge?: number;
  /** 素材视频最短秒数,低于则拒收。默认 MIN_VIDEO_SEC。 */
  minVideoSec?: number;
  /**
   * 进度回调。phase 区分两段:
   *   · 'search'   = 并发搜索阶段。done/total 是【已搜完/总词数】,term 是刚搜完的词;
   *                  此阶段 got/totalGot 恒为 0(还没开始下载)。
   *   · 'download' = 逐词下载阶段。done/total 是词进度,got 是该词当前下到几段,
   *                  totalGot 是累计下到几段;clip 存在 = 词【下载中】的段级心跳(index/count),
   *                  不存在 = 该词整体下完的收尾回报。
   * 让 UI 既能显示「搜索 x/N」也能显示「下载 段 i/count」,不会几分钟没动静像卡死。
   */
  onProgress?: (info: {
    phase: 'search' | 'download';
    done: number; total: number; term: string; got: number; totalGot: number;
    clip?: { index: number; count: number };
  }) => void;
}

/**
 * 逐【搜索词】拉视频素材,保留「词 → 素材」归属。
 *
 * 这是相对旧版 bulk 搜的关键改进(抄 MoneyPrinterTurbo):旧版把所有词混成一个
 * 池子一次性搜,然后 pipeline 第 i 个分镜直接取池子第 i 个——画面跟内容毫无关系。
 * 现在每个词单独搜,pipeline 再按各分镜自己的搜索词挑对应素材,画面跟着内容走。
 *
 * 同时做竖屏过滤:元数据已知尺寸时,高 < 宽(横屏)直接拒收,免得裁成竖屏丢画面。
 *
 * 两阶段:① 并发搜索所有词(延迟瓶颈,SEARCH_CONCURRENCY 把 N×RTT 压成 ~N/limit×RTT,
 * 这是搜索提速主因);② 逐词下载(带宽瓶颈,词内 4 并发)。onProgress 用 phase 区分两段,
 * UI 既显示「搜索 x/N」又显示「下载 段 i/count」,不再"没动静"。没 key/没网时返回各词空数组。
 */
/** 限流并发执行(顺序无关):最多 limit 个任务同时跑,用于并行下载素材段。 */
async function mapWithLimit<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await task(items[i]);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
}

export async function fetchStockVideosByTerms(opts: FetchVideosByTermsOptions): Promise<StockVideoByTerm[]> {
  const { terms, destDir } = opts;
  const perTermCount = Math.max(1, opts.perTermCount ?? 4);
  const orientation = opts.orientation ?? 'portrait';
  const locale = opts.locale;
  const videoSize = opts.videoSize ?? 'small';
  const minVideoEdge = opts.minVideoEdge ?? MIN_VIDEO_EDGE;
  const minVideoSec = opts.minVideoSec ?? MIN_VIDEO_SEC;
  const out: StockVideoByTerm[] = [];
  if (!Array.isArray(terms) || terms.length === 0) return out;

  const termList = terms.map((t) => (t || '').trim());

  // ── 阶段一:并发搜索所有词。搜索是延迟瓶颈(双跳 RTT),并发把 N×RTT 压成 ~N/limit×RTT。
  // 各词候选 meta 收进 metasByIndex[i],保持与 termList 下标对应,供阶段二按序去重+下载。
  const metasByIndex: StockVideoMeta[][] = termList.map((): StockVideoMeta[] => []);
  let searched = 0;
  await mapWithLimit(
    termList.map((term, i) => ({ term, i })),
    SEARCH_CONCURRENCY,
    async ({ term, i }) => {
      // 多搜几条做候选(给下载失败留 backfill 余量)。空词跳过(metasByIndex[i] 保持空数组)。
      if (term) {
        metasByIndex[i] = await searchVideosViaServer([term], perTermCount + 3, orientation, locale, videoSize);
      }
      searched++;
      opts.onProgress?.({ phase: 'search', done: searched, total: termList.length, term, got: 0, totalGot: 0 });
    },
  );

  // ── 阶段二:逐词下载(下载是带宽瓶颈,词内已 4 并发;词间串行便于稳定回报进度)。
  const seenUrls = new Set<string>();
  let idx = 0;
  let totalGot = 0;

  for (let t = 0; t < termList.length; t++) {
    const term = termList[t];
    const assets: StockVideoAsset[] = [];
    if (term) {
      // 阶段一已搜好的候选,预过滤(去重 + 时长 + 比例 + 分辨率)后再【并发】下载;
      // 边下边报"段"级进度,不再因一个慢词几分钟没动静而像卡死。
      const metas = metasByIndex[t];
      const candidates: { meta: StockVideoMeta; dest: string }[] = [];
      for (const meta of metas) {
        if (candidates.length >= perTermCount + 2) break;
        if (seenUrls.has(meta.url)) continue;
        // 时长太短(<2s)拼起来太碎,跳过(0 = 未知,放行)。
        if (meta.durationSec > 0 && meta.durationSec < minVideoSec) continue;
        // 比例过滤(已知尺寸时):竖屏拒横屏素材,横屏拒竖屏素材,方形不过滤。
        if (meta.width > 0 && meta.height > 0) {
          if (orientation === 'portrait' && meta.height < meta.width) continue;
          if (orientation === 'landscape' && meta.width < meta.height) continue;
          // G2 分辨率预过滤:meta 尺寸已知且短边过小 → 直接跳过,省一次无用下载
          //（meta 缺失时不拦,留给 downloadVideoTo 用真实探测兜底)。
          if (Math.min(meta.width, meta.height) < minVideoEdge) continue;
        }
        seenUrls.add(meta.url);
        const ext = (meta.url.split('?')[0].match(/\.(mp4|mov|webm|m4v)$/i)?.[1] || 'mp4').toLowerCase();
        const dest = path.join(destDir, `stockvid_${String(idx).padStart(3, '0')}.${ext}`);
        idx++;
        candidates.push({ meta, dest });
      }

      // 并发下载候选(限流 VIDEO_DOWNLOAD_CONCURRENCY)。downloadVideoTo 内做完整性校验
      // (ffprobe 验时长)+ 真实分辨率门槛,过关的才收;真实宽高/时长优先于 meta(更准)。
      let settled = 0;
      await mapWithLimit(candidates, VIDEO_DOWNLOAD_CONCURRENCY, async ({ meta, dest }) => {
        const probed = await downloadVideoTo(meta.url, dest, minVideoEdge);
        settled++;
        if (probed) {
          assets.push({
            path: dest,
            durationSec: probed.durationSec || meta.durationSec,
            width: probed.width || meta.width,
            height: probed.height || meta.height,
          });
          totalGot++;
        }
        // 段级心跳(done=t 表示已完成 t 个词,当前是第 t+1 个词的下载中)。
        opts.onProgress?.({
          phase: 'download', done: t, total: termList.length, term, got: assets.length, totalGot,
          clip: { index: settled, count: candidates.length },
        });
      });
    }
    out.push({ term, assets });
    opts.onProgress?.({ phase: 'download', done: t + 1, total: termList.length, term, got: assets.length, totalGot });
  }

  return out;
}
