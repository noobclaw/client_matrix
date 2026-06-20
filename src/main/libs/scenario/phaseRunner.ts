/**
 * phaseRunner.ts — generic orchestrator executor.
 *
 * Downloads orchestrator.js from the server skill pack, constructs a
 * sandboxed `ctx` object with tool methods, and executes the orchestrator
 * via `new AsyncFunction('ctx', code)`.
 *
 * This is the ONLY file that needs to exist in the client for scenario
 * execution. All business logic (what to search, how to filter, which
 * AI prompts to use) lives on the server and is hot-updatable.
 */

import crypto from 'crypto';
import { coworkLog } from '../coworkLogger';
import { sendBrowserCommand, connectionHasCapability } from '../browserBridge';
import { PLATFORM_TAB_GROUPS, inferPlatformFromPattern, type LoginPlatform } from './platformLoginDriver';
import { groupTitle as buildGroupTitle, urlToSubPlatform, getStandardBounds } from './subPlatformRegistry';
import * as riskGuard from './riskGuard';
import * as taskStore from './taskStore';
import * as localExtractor from './localExtractor';
import { parseJsonSafe } from './localExtractor';
import { getNoobClawAuthToken } from '../claudeSettings';
import * as newsUsageStore from './newsUsageStore';
import * as engageHistoryStore from './engageHistoryStore';
import * as fs from 'fs';
import * as path from 'path';
import { writeTaskArtifacts, getTaskOutputDir } from './artifactWriter';
import { getResourcesPath } from '../platformAdapter';
import type {
  Draft,
  ScenarioPack,
  ScenarioTask,
} from './types';

// ── Progress helpers (imported from scenarioManager at call time) ──

export interface ProgressFns {
  stepStart: (step: number) => void;
  stepLog: (step: number, status: 'done' | 'running' | 'error', message: string) => void;
  stepDone: (step: number) => void;
  stepError: (step: number, error: string) => void;
  /** v5.x+: clear the live in-memory log buffer for a step and seed it with
   *  `label`. Used by iterative scenarios (X auto-engage step 2 doing 30
   *  follow / reply / like in a row) so the UI shows ONLY the current
   *  iteration instead of a buried backlog. The persistent run record
   *  (history view) still gets every line — only live view is reset. */
  stepActionBoundary?: (step: number, label: string) => void;
  /** v2.7+: nuke live logs for ALL steps in one shot. Iterative top-level
   *  scenarios (binance_from_x_link processing N URLs) call this between
   *  iterations so step 2/3/4 cards aren't crowded with the previous
   *  URL's logs. The persistent run record is unaffected — only the live
   *  in-memory buffer is wiped. Falls back gracefully when missing
   *  (orchestrator detects via typeof check and uses braille-spacer
   *  fallback for old client builds). */
  stepResetAll?: () => void;
  finishProgress: (status: 'done' | 'error' | 'partial', error?: string) => void;
  isAbortRequested: () => boolean;
  /** v2.4.35+: accumulate AI token usage per task so the run record
   *  can surface cost. Called after every successful aiCall with:
   *    - tokensDelta: raw total_tokens from this single call
   *    - costDeltaUsd: server-precomputed USD cost for this call (from
   *      _noobclaw.costUsd, i.e. billable_tokens × system_config's
   *      token_price_per_million). Precomputed server-side so the
   *      client doesn't hardcode a rate. */
  addTokensUsed?: (tokensDelta: number, costDeltaUsd: number) => void;
  /** v5.x+: surface per-action progress to the live RunProgress so the
   *  task detail page can render a glowing "本次运行进度" card with
   *  "X/Y" counters that tick up as each action completes. Optional —
   *  scenarios that don't track per-action quotas just skip these. */
  setActionTarget?: (type: string, target: number) => void;
  bumpActionProgress?: (type: string, n: number) => void;
}

export interface RunResult {
  status: 'ok' | 'failed';
  reason?: string;
  collected_count?: number;
  draft_count?: number;
  /** Per-action successful counts for this run, keyed by free-form
   *  action type (e.g. like, follow, comment, reply, post). Populated
   *  via ctx.addActionCount() from the orchestrator. Task detail page
   *  aggregates these into "累计完成" / "上次完成" cards. Undefined for
   *  pre-rollout runs (UI shows '-'). */
  action_counts?: Record<string, number>;
}

// ── Utilities ──

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(minMs: number, maxMs?: number): Promise<void> {
  const ms = maxMs ? randInt(minMs, maxMs) : minMs;
  return new Promise(r => setTimeout(r, ms));
}

/** v4.31.38: race 用 abort 哨兵 —— 所有 ctx.* 浏览器操作 race 它,abort flag
 *  设置后立即 reject('user_stopped'),不等浏览器响应。每 200ms 轮询一次。
 *  调用方负责清理 setInterval(通过 finally 或 race 完成自动 GC)。 */
function abortPoll(isAbortRequested: () => boolean): Promise<never> {
  return new Promise<never>((_, reject) => {
    const check = setInterval(() => {
      if (isAbortRequested()) {
        clearInterval(check);
        reject(new Error('user_stopped'));
      }
    }, 200);
    // 30 分钟兜底自动 GC,防 setInterval 永不退出泄漏
    setTimeout(() => clearInterval(check), 30 * 60 * 1000);
  });
}

/** v4.31.39: 所有 ctx.* 调 sendBrowserCommand 的统一入口 —— 调用前 check
 *  abort + race(sendBrowserCommand vs abortPoll)。task 停了浏览器侧立即
 *  throw user_stopped 不再 click/scroll/navigate。需要 closure 捕获 progress
 *  + getBridgeOpts,所以放进 buildContext 内做工厂。 */

function parseLikes(text: string): number {
  if (!text) return 0;
  const s = String(text).trim();
  const match = s.match(/([\d.]+)\s*([万wW千kK]*)/);
  if (!match) return parseInt(s, 10) || 0;
  const n = parseFloat(match[1]);
  const unit = match[2];
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(n * 10000);
  if (unit === '千' || unit === 'k' || unit === 'K') return Math.round(n * 1000);
  return Math.round(n);
}

function keywordMatch(text: string, keywords: string[]): boolean {
  if (!text) return false;
  const lowered = text.toLowerCase();
  return keywords.some(k => lowered.includes(k.toLowerCase()));
}

// ── Universal AI boilerplate / refusal / meta-talk detector ──
//
// Every scenario that calls ctx.aiCall() runs through this. The model
// occasionally returns one of:
//   - polite refusals ("I cannot fulfill...")
//   - ask-back boilerplate ("I'd be happy to help, but you haven't
//     provided the actual text...")
//   - meta-self-talk ("Here's the rewrite of your post:" / "改写后:")
// A real social-platform user post NEVER contains these. Posting them
// gets the account flagged as a bot.
//
// **Rules live on the backend** at src/services/aiBoilerplate.ts and
// are served at GET /api/ai/boilerplate-patterns. The client pulls them
// once on startup and caches in memory; that means tweaking the regex
// list is a backend-restart away — no client rebuild / user reinstall.
// We keep a tiny built-in fallback list so detection still works during
// the brief startup window before the fetch completes (or if the
// endpoint is unreachable).

interface BoilerplateRule { pattern: string; flags?: string }

const FALLBACK_RULES: BoilerplateRule[] = [
  { pattern: "I (cannot|can't|am unable to|won't|will not) (fulfill|help|provide|do|complete|generate|write|comply)", flags: 'i' },
  { pattern: "(I'?d|I would) be (happy|glad) to help", flags: 'i' },
  { pattern: "(you )?(haven'?t|did ?n'?t|have not) (yet )?(provided|shared|given|included)", flags: 'i' },
  { pattern: "\\b(rewrite|rewritten|paraphrase|paraphrased)\\b", flags: 'i' },
  { pattern: '我(无法|不能|没法|不会)(为|帮|完成|提供|生成|写)' }, // 我无法/不能/没法/不会 ...
  { pattern: '(改写后|改写版本|这是改写|帮你改写|帮我改写)' }, // 改写后/改写版本/...
];

function compileRules(rules: BoilerplateRule[]): RegExp[] {
  const out: RegExp[] = [];
  for (const r of rules) {
    try { out.push(new RegExp(r.pattern, r.flags || '')); }
    catch { /* skip malformed regex from the wire */ }
  }
  return out;
}

let _activeRules: RegExp[] = compileRules(FALLBACK_RULES);
let _rulesFetchPromise: Promise<void> | null = null;

async function fetchRulesOnce(): Promise<void> {
  if (_rulesFetchPromise) return _rulesFetchPromise;
  _rulesFetchPromise = (async () => {
    try {
      const resp = await fetch('https://api.noobclaw.com/api/ai/boilerplate-patterns', {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return;
      const data = await resp.json() as { rules?: BoilerplateRule[] };
      if (Array.isArray(data.rules) && data.rules.length > 0) {
        const compiled = compileRules(data.rules);
        if (compiled.length > 0) _activeRules = compiled;
      }
    } catch { /* keep fallback rules on any error */ }
  })();
  return _rulesFetchPromise;
}

// Kick off the fetch as soon as this module loads. Subsequent calls to
// looksLikeAIRefusal() see the wider rule set within ~100ms-2s of app
// startup; until then the FALLBACK list catches the most common cases.
fetchRulesOnce();

export function looksLikeAIRefusal(text: string): boolean {
  if (!text) return false;
  for (const re of _activeRules) {
    if (re.test(text)) return true;
  }
  return false;
}

// ── Quality gate (v2.4.58+) ──
//
// Deterministic post-AI checks. Used by post-creator orchestrators (XHS,
// Twitter, Binance) via opts.qualityGate in aiCall. Catches:
//   - Banned phrases (platform-specific shill / hype / faux-compliance)
//   - AI-grammar openers ("In the world of..." / "在...的浪潮中" etc.)
//   - Length bounds
//   - Missing un-round numbers (when content needs data density)
//   - Excess emoji
//
// On fail, aiCall augments user message with the failure list and retries.
// Defaults are conservative — most checks only run when caller opts in.

const AI_GRAMMAR_OPENERS = [
  /^\s*在.*的浪潮中/,
  /^\s*让我们(来)?(聊聊|看看|讨论|分析)/,
  /^\s*综上所述/,
  /^\s*总(的)?来说/,
  /^\s*众所周知/,
  /^\s*不可否认/,
  /^\s*毫无疑问/,
  /^\s*in the world of/i,
  /^\s*let'?s dive into/i,
  /^\s*it'?s no secret that/i,
  /^\s*in conclusion/i,
  /^\s*needless to say/i,
  /^\s*at the end of the day/i,
];

export interface QualityGateOpts {
  minLen?: number;
  maxLen?: number;
  bannedPhrases?: string[];
  requireUnRoundNumber?: boolean;
  maxRetries?: number;
}

export function checkQuality(
  text: string,
  opts: QualityGateOpts,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  const t = String(text || '').trim();

  // Length bounds
  if (opts.minLen && t.length < opts.minLen) {
    failures.push(`太短 (${t.length} < ${opts.minLen})`);
  }
  if (opts.maxLen && t.length > opts.maxLen) {
    failures.push(`太长 (${t.length} > ${opts.maxLen})`);
  }

  // Banned phrases — case-insensitive substring match
  if (opts.bannedPhrases && opts.bannedPhrases.length > 0) {
    const lowerT = t.toLowerCase();
    for (const phrase of opts.bannedPhrases) {
      if (!phrase) continue;
      if (lowerT.includes(phrase.toLowerCase())) {
        failures.push(`命中禁词: "${phrase}"`);
      }
    }
  }

  // AI-grammar openers
  for (const re of AI_GRAMMAR_OPENERS) {
    if (re.test(t)) {
      failures.push(`AI 腔开场: "${t.slice(0, 25)}..."`);
      break; // one is enough to fail
    }
  }

  // Excess emoji (universal — > 5 always looks like content mill)
  const emojiCount = (t.match(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F100}-\u{1F1FF}]/gu) || []).length;
  if (emojiCount > 5) {
    failures.push(`emoji 过多 (${emojiCount} > 5)`);
  }

  // Un-round number requirement (e.g. "92.3" / "0.043%" / "73 signups")
  // Triggered for content posts that should have data density.
  // Match: any number with decimal, or 万/亿/K/M/B units, or 2+ digit specific number
  if (opts.requireUnRoundNumber) {
    const hasUnRound = /\d+\.\d+|\d+(?:\.\d+)?\s*[万亿KMB]|\b\d{2,}\b/i.test(t);
    if (!hasUnRound) {
      failures.push('缺少具体数字 (需要至少一个不圆滑数据点)');
    }
  }

  return { passed: failures.length === 0, failures };
}

// ── Build the ctx object ──

function buildContext(
  pack: ScenarioPack,
  task: ScenarioTask,
  seenPostIds: Set<string>,
  progress: ProgressFns,
  appLocale?: string,
): Record<string, any> {
  const { manifest, scripts, config } = pack;

  // ⭐ Multi-tab routing: if manifest declares a tab_url_pattern, every
  // sendBrowserCommand call gets that pattern so the chrome-extension
  // dispatches to the matching tab instead of the active one.
  //
  // v4.25+ cross-tab scenarios (binance_from_x_repost): manifest can also
  // declare `secondary_tab_url_pattern`. Orchestrator calls
  // `ctx.setActiveTab('primary' | 'secondary')` to swap routing target
  // mid-run — needed when one scenario touches both X and Binance tabs.
  // Back-compat: single-tab scenarios never call setActiveTab and behave
  // as before (bridgeOpts bound to primary pattern).
  const primaryPattern = (manifest as any).tab_url_pattern as string | undefined;
  const secondaryPattern = (manifest as any).secondary_tab_url_pattern as string | undefined;
  let activePattern: string | undefined = primaryPattern;
  // v2.6+: also attach the per-platform tabGroup (title + color) so that
  // chrome-extension v1.2.21+ groups the tab into the right labeled
  // group without needing a hardcoded URL→{title,color} map inside the
  // extension. PLATFORM_TAB_GROUPS lives in platformLoginDriver — adding
  // a new platform now only requires updating that map (a client release)
  // and never another extension release.
  //
  // Cross-tab scenarios (e.g. binance_from_x_repost) switch the active
  // tab via ctx.setActiveTab('primary' | 'secondary'). The secondary
  // tab usually belongs to a different platform (X tab while doing a
  // Binance repost). We compute both tabGroups up-front so getBridgeOpts
  // can hand back the right one based on activePattern at the moment
  // of the command. Without this, switching to the X tab would send the
  // Binance group title and the new ext would mis-label the X tab.
  const platformId = (manifest as any).platform as string | undefined;
  const primaryTabGroup = (platformId && (PLATFORM_TAB_GROUPS as any)[platformId])
    ? (PLATFORM_TAB_GROUPS as any)[platformId as LoginPlatform]
    : undefined;
  // Infer secondary platform from its URL pattern (no need for a new
  // manifest field — the pattern already encodes the domain). The actual
  // mapping lives in platformLoginDriver so adding a new platform is a
  // single-file change.
  const secondaryPlatform = inferPlatformFromPattern(secondaryPattern);
  const secondaryTabGroup = secondaryPlatform ? PLATFORM_TAB_GROUPS[secondaryPlatform] : undefined;
  const getBridgeOpts = () => {
    const useSecondary = activePattern && activePattern === secondaryPattern;
    const tg = useSecondary ? (secondaryTabGroup || primaryTabGroup) : primaryTabGroup;
    // v1.4.0+: opt into per-platform isolated windows when the connected
    // extension advertises support. With isolation on, the extension uses
    // its own managed window for each platform instead of hijacking the
    // user's main browser tab — so multiple platforms can run in parallel
    // without Chrome throttling background tabs in the same window. Older
    // extensions (no capability) get the legacy shared-tab behavior;
    // extension simply ignores the unknown envelope.isolate field.
    const wantsIsolation = !!activePattern && connectionHasCapability(activePattern, 'isolated_windows');
    // v1.4.2+: also pass the manifest's anchor_url so the extension doesn't
    // need a hardcoded platform → URL map. Adding a new platform now means
    // setting anchor_url in the scenario manifest only.
    const anchorUrl = activePattern ? anchorUrlForPattern(activePattern) : undefined;
    if (!activePattern && !tg && !wantsIsolation && !anchorUrl) return undefined;
    const opts: { tabPattern?: string; tabGroup?: { title: string; color: string }; isolate?: boolean; anchor_url?: string } = {};
    if (activePattern) opts.tabPattern = activePattern;
    if (tg) opts.tabGroup = tg;
    if (wantsIsolation) opts.isolate = true;
    if (anchorUrl) opts.anchor_url = anchorUrl;
    return opts;
  };

  // ── Anchor URL pre-flight (v5.x+) ─────────────────────────────────
  // Replaces the chrome-extension's hardcoded anchorUrlFor table. Before
  // any routed command runs, we make sure SOME tab matches the active
  // tab_url_pattern; if none does, we open `manifest.anchor_url` (or
  // `secondary_anchor_url` when active pattern is the secondary one)
  // via tab_create. After this, the extension's findOrOpenTabByPattern
  // will succeed for navigate / scroll / browser routed commands.
  //
  // Why client-side: extension's anchorUrlFor only knows xhs / x / binance.
  // douyin / tiktok / youtube manifests now ship anchor_url and the runner
  // uses it without an extension republish. Adding a new platform = add
  // anchor_url to its manifest, no client release either (manifest is
  // hot-fetched per run).
  //
  // anchorPreflightDone tracks per-pattern so we don't re-check 50 times
  // during a long task. setActiveTab() resets the active key when switching.
  const anchorPreflightDone = new Set<string>();
  const anchorUrlForPattern = (pat: string | undefined): string | undefined => {
    if (!pat) return undefined;
    const m: any = manifest;
    if (pat === primaryPattern && typeof m.anchor_url === 'string') return m.anchor_url;
    if (pat === secondaryPattern && typeof m.secondary_anchor_url === 'string') return m.secondary_anchor_url;
    return undefined;
  };
  const ensureTabExistsForPattern = async (pat: string | undefined): Promise<void> => {
    if (!pat) return;
    if (anchorPreflightDone.has(pat)) return;
    let regex: RegExp;
    try { regex = new RegExp(pat); }
    catch { anchorPreflightDone.add(pat); return; }
    // v1.4.0+: when extension supports isolation, preflight MUST pass
    // isolate so tab_list returns only OUR managed windows' tabs and
    // tab_create routes the new tab into the right managed window. If we
    // omitted isolate here, tab_list would see the user's main-browser
    // x.com tab, preflight would skip tab_create, then the real command
    // (which DOES set isolate via getBridgeOpts) would open a fresh
    // managed window — leaving preflight and runtime out of sync, which
    // was the exact failure mode the v1.3.5 attempt hit.
    const isolate = connectionHasCapability(pat, 'isolated_windows');
    const preflightOpts: any = { tabPattern: pat };
    if (isolate) preflightOpts.isolate = true;
    // v1.4.2+: pass anchor_url so the extension doesn't fall back to its
    // hardcoded list. Even non-isolation flows benefit (extension still
    // needs an anchor when no matching tab exists).
    const preflightAnchor = anchorUrlForPattern(pat);
    if (preflightAnchor) preflightOpts.anchor_url = preflightAnchor;
    let tabs: any[] = [];
    try {
      const res: any = await sendBrowserCommand('tab_list', {}, 5000, preflightOpts);
      tabs = (res && Array.isArray(res.tabs)) ? res.tabs
        : ((res && res.data && Array.isArray(res.data.tabs)) ? res.data.tabs : []);
    } catch {
      // bridge / extension issue — let the original command surface the
      // real error; mark done so we don't retry tab_list on every call.
      anchorPreflightDone.add(pat);
      return;
    }
    const has = tabs.some(t => typeof t?.url === 'string' && regex.test(t.url));
    if (has) {
      anchorPreflightDone.add(pat);
      return;
    }
    const anchor = anchorUrlForPattern(pat);
    if (!anchor) {
      // No anchor declared — fall through and let the extension's legacy
      // anchorUrlFor (xhs / x / binance) try its hand. New platforms that
      // omit anchor_url will fail loudly with the existing "no anchor URL
      // known" error, which is the correct signal to add the field.
      anchorPreflightDone.add(pat);
      return;
    }
    coworkLog('INFO', 'phaseRunner', 'anchor pre-flight: opening', { pattern: pat, anchor, isolate });
    try {
      await sendBrowserCommand('tab_create', { url: anchor }, 12000, preflightOpts);
      // Give the new tab a moment to commit a URL the regex can match.
      // tab_create returns immediately after chrome.tabs.create resolves,
      // but the URL may still be about:blank for ~50-200ms.
      await new Promise<void>(r => setTimeout(r, 800));
    } catch (e) {
      coworkLog('WARN', 'phaseRunner', 'anchor pre-flight tab_create failed', { err: String(e) });
    }
    anchorPreflightDone.add(pat);
  };
  // Commands that don't depend on a routed tab — skip pre-flight for them.
  // tab_list / tab_create / tab_close / tab_switch operate on the global
  // tab list; check_anomaly is internal; bridge_health is a ping.
  const PREFLIGHT_SKIP = new Set([
    'tab_list', 'tab_create', 'tab_close', 'tab_switch',
    'bridge_health', 'extension_version',
  ]);

  // v4.31.39: 统一 abortable browser command —— 所有 ctx.* 浏览器操作经此入口,
  //   abort flag 设置后立即 throw 'user_stopped',不等浏览器响应。
  // v5.x+: 加一道 anchor 预检 —— 路由命令(带 tabPattern)前先确保有匹配 tab,
  //   否则按 manifest.anchor_url 自启,绕开 chrome-extension anchorUrlFor 缺
  //   douyin / tiktok / youtube 分支的问题。
  // D3: 只对真正幂等 + 副作用可重放的命令开启 retry。
  //   - navigate: 重复 navigate 到同一 URL,浏览器要么 no-op 要么 reload,
  //     都不破坏业务逻辑。CDN 冷启动 / captcha challenge / 网络抖动场景
  //     一次 35-45s 不算少见,1 次 retry 能救回一大半 timeout 失败。
  //   - scroll:   重复 scroll 一段距离至多多滚一点,不影响后续 read。
  //   - tab_list: 纯读,完全幂等。
  // 显式不在表里的(click / runScript / editor_insert_text / main_world_click
  // 等):可能引发重复点击、重复发推、重复扣费,绝对不能 retry。
  const RETRYABLE_ON_TIMEOUT = new Set(['navigate', 'scroll', 'tab_list']);
  // 命中下列错误信息 → 视为"卡死类失败"可 retry;其他错误(BROWSER_NOT_CONNECTED /
  // user_stopped / 业务级错误)直接传上层,retry 救不了或不能 retry。
  const isRetryableTimeoutError = (msg: string): boolean =>
    /timed out after|hard-timeout after/i.test(msg);

  const runOnceRace = (command: string, params: any, timeout: number): Promise<any> =>
    Promise.race([
      sendBrowserCommand(command, params, timeout, getBridgeOpts()),
      abortPoll(progress.isAbortRequested),
      // B3: hard-timeout 兜底 —— 对齐 ctx.browser 的同款保险。如果
      // sendBrowserCommand 内部 setTimeout 因事件循环阻塞 / SW 半死 /
      // 进程被挂起没 fire,整个 await 永远 pending → ctx.navigate /
      // ctx.scroll 卡死,orchestrator 后续 step 永远不跑。timeout+2000ms
      // 强行 reject 把症状盖住(让上层走失败分支),原 sendBrowserCommand
      // 的 timer 终会 fire 清 pendingRequests,不会泄漏。
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`abortableCmd "${command}" hard-timeout after ${timeout + 2000}ms`)),
          timeout + 2000,
        );
      }),
    ]);

  const abortableCmd = async (command: string, params: any, timeout: number): Promise<any> => {
    if (progress.isAbortRequested()) throw new Error('user_stopped');
    if (activePattern && !PREFLIGHT_SKIP.has(command)) {
      await ensureTabExistsForPattern(activePattern);
    }
    try {
      return await runOnceRace(command, params, timeout);
    } catch (err) {
      // D3: timeout 类失败重试一次。第一次失败往往是 CDN 冷启动 / 一次
      // 网络抖动 / B1 刚自愈完死 conn 还在重连;给一次重试比直接整个 step
      // 失败友好得多。失败信息会 throw 到上层,orchestrator 的常规错误处理
      // 路径会接住(scenario 多数 step 有 item-level 容错)。
      const msg = String((err as any)?.message || err);
      if (
        !RETRYABLE_ON_TIMEOUT.has(command) ||
        !isRetryableTimeoutError(msg) ||
        progress.isAbortRequested()  // 用户停了 task 就别 retry 浪费时间
      ) {
        throw err;
      }
      coworkLog('WARN', 'phaseRunner', `abortableCmd "${command}" first attempt timed out, retrying once`, { err: msg.slice(0, 200) });
      // 第二次再失败就老老实实把第二次的错误 throw 出去 — 不再 retry,
      // 否则 retry 链可能无限延长,navigate 真挂 60s+ × 多次 = task 不
      // finish。
      return await runOnceRace(command, params, timeout);
    }
  };

  // All drafts collected during this run (for saveDrafts)
  const allDrafts: Draft[] = [];

  // Per-action counters surfaced to the run record under result.action_counts.
  // Orchestrators call ctx.addActionCount('like'/'follow'/'comment'/'post'/'reply', 1)
  // on each successful action. The dashboard reads cumulative+last_run aggregates
  // off this map to populate the "累计完成" / "上次完成" stat cards. Keys are
  // free-form so future scenarios can introduce new action types without
  // touching this file.
  const actionCounts: Record<string, number> = {};
  // v6.x cleanup state — populated by openTab / registerChildExpectation
  // when scenarios pass sub_platform; drained by ctx._releaseAllWindows()
  // in runOrchestrator's finally block. See ctx._releaseAllWindows for
  // semantics. Defined here so they live for the whole buildContext
  // closure (same scope as actionCounts).
  const _claimedWindows = new Map<string, { idleGroupTitle: string }>();
  const _scopedTabsByRole = new Map<string, ReturnType<typeof createScopedTab>>();
  const _childRoleSubPlatform = new Map<string, { sub_platform: string; account: string }>();

  // v6.x (PR12 audit fix): single sink for tab-handle bookkeeping. Warns
  // when a role's tab is being replaced — usually means the orchestrator
  // re-opened the same role tab without closing the previous one
  // (retry loops, bad control flow). We DON'T auto-close the old one
  // here because the orchestrator may still hold a reference to it
  // mid-operation; logging is the safe default until we have a real
  // failure case to drive different policy.
  const _rememberScopedTab = (role: string, t: ReturnType<typeof createScopedTab>): void => {
    const prev = _scopedTabsByRole.get(role);
    if (prev && prev.id !== t.id) {
      coworkLog('WARN', 'phaseRunner',
        `[scopedTabs] role="${role}" reopened (old tab #${prev.id} → new tab #${t.id}); old handle may orphan if orchestrator doesn't close it`);
    }
    _scopedTabsByRole.set(role, t);
  };

  const ctx: Record<string, any> = {
    // ── Data ──
    task,
    config,
    manifest,
    seenPostIds,
    /** v5.x+: noobclaw 客户端 i18n 设置 ('zh' | 'en' | 'zh-TW' | 'ko' | 'ja'
     *  | 'ru' | 'fr' | 'de' | undefined)。orchestrator 用这个判断"这个用户
     *  想看什么语言的内容/输出"——比 navigator.language 准,因为浏览器经常
     *  跟客户端 UI 语言不一致(用户用中文 noobclaw 但 Chrome 是英文)。 */
    appLocale: appLocale || '',

    // ── Progress ──
    // Track current step so ctx.report() logs to the right panel
    _currentStep: 1,
    report: (msg: string) => progress.stepLog(ctx._currentStep || 1, 'running', msg),
    // v4.31.34: stepStart 同时写一条启动 log,UI 立刻能看到这一步在跑,
    //   不再卡"正在启动…(后端流式日志稍候)"。orchestrator 第一次 stepLog
    //   之前可能有数秒的浏览器交互(get_url / navigate),这段时间用户原本
    //   只能看到空 logs。
    stepStart: (step: number) => {
      ctx._currentStep = step;
      progress.stepStart(step);
      progress.stepLog(step, 'running', '▶ 步骤 ' + step + ' 开始');
    },
    stepLog: (step: number, status: string, msg: string) => progress.stepLog(step, status as any, msg),
    stepDone: (step: number) => progress.stepDone(step),
    /** v5.x+: orchestrator opt-in for iterative steps. Call at the top of each
     *  iteration (e.g. before each follow / reply / like in X auto-engage's
     *  step 2 loop) so the live UI clears the previous iteration's logs and
     *  shows only the current one. The full log timeline is preserved in the
     *  persistent run record (history view). Falls back to a no-op when the
     *  callback is missing — older client builds keep the old accumulating
     *  behavior. Both signatures supported:
     *    ctx.startAction('🎯 关注 @user')          → uses ctx._currentStep
     *    ctx.startAction(2, '🎯 关注 @user')       → explicit step number
     */
    startAction: (...args: any[]) => {
      if (!progress.stepActionBoundary) return;
      let step: number, label: string;
      if (typeof args[0] === 'number') { step = args[0]; label = String(args[1] || ''); }
      else { step = ctx._currentStep || 1; label = String(args[0] || ''); }
      progress.stepActionBoundary(step, label);
    },
    /** v2.7+: clear live logs across ALL steps. Used by iterative top-level
     *  scenarios (binance_from_x_link 5 URLs) so each iteration starts
     *  with empty step cards. Falls back to undefined on old client builds —
     *  orchestrators check via `typeof ctx.stepResetAll === 'function'`. */
    stepResetAll: progress.stepResetAll
      ? () => progress.stepResetAll!()
      : undefined,
    finish: (status: string, error?: string) => progress.finishProgress(status as any, error),
    aborted: () => progress.isAbortRequested(),

    // ── Browser commands — ALL Chrome extension primitives ──
    // Generic passthrough: orchestrator can call any extension command
    // Abortable: polls abort flag during wait
    browser: async (command: string, params?: any, timeout?: number) => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      const t = timeout || 10000;
      // v5.x+: anchor 预检 — 路由命令前确保有匹配 tab(参考 abortableCmd)。
      // v5.27+: 调用方手动塞了 params.tabId(走 task-tab 显式路由)就跳过 preflight,
      // 否则会按 activePattern 多开个 anchor tab。scoped 操作正确流程。
      const hasExplicitTabId = params && (params as any).tabId;
      if (activePattern && !PREFLIGHT_SKIP.has(command) && !hasExplicitTabId) {
        await ensureTabExistsForPattern(activePattern);
      }
      return Promise.race([
        sendBrowserCommand(command, params || {}, t, getBridgeOpts()),
        new Promise<never>((_, reject) => {
          const check = setInterval(() => {
            if (progress.isAbortRequested()) {
              clearInterval(check);
              reject(new Error('user_stopped'));
            }
          }, 300);
          // v4.31.34: race 第二个 promise 之前只在 abort 时 reject,timer 仅
          //   clearInterval。如果 sendBrowserCommand 内部的 setTimeout 因某种
          //   原因没 fire(扩展 half-open / 进程被挂起 等),整个 await 永远
          //   pending,orchestrator 卡在第一个 ctx.browser 上,后续 stepLog
          //   永远不调,UI 卡 "正在启动…"。这里改成 t+2s 后强制 reject 兜底。
          setTimeout(() => {
            clearInterval(check);
            reject(new Error('browser command "' + command + '" hard-timeout after ' + (t + 2000) + 'ms'));
          }, t + 2000);
        }),
      ]);
    },

    // v4.25+ cross-tab routing: swap which tab pattern ctx.browser/navigate/
    // scroll route to. Only used by scenarios declaring secondary_tab_url_pattern
    // (currently only binance_from_x_repost). No-op for single-tab scenarios.
    setActiveTab: (key: 'primary' | 'secondary') => {
      if (key === 'secondary') {
        if (!secondaryPattern) {
          coworkLog('WARN', 'phaseRunner', 'setActiveTab("secondary") called but no secondary_tab_url_pattern in manifest');
          return;
        }
        activePattern = secondaryPattern;
      } else {
        activePattern = primaryPattern;
      }
    },
    getActiveTabKey: () => (activePattern === secondaryPattern ? 'secondary' : 'primary'),

    // Convenience shortcuts for common operations
    // v4.31.38/39: 所有 ctx.* 浏览器操作走 abortableCmd —— race
    //   (sendBrowserCommand vs abortPoll),用户停 task 后浏览器侧立即 throw
    //   不再操作。之前只 navigate/scroll 加了,click/runScript 漏了 → 发推
    //   按钮的最后一击 click 不 abort,task 停了还能发出去。这里抽 helper
    //   统一加固。
    navigate: async (url: string) => {
      await abortableCmd('navigate', { url }, 30000);
    },

    scroll: async (amount?: number) => {
      // scroll 走 content-script 转发慢路径(扩展 background 无专门 handler →
      // injectContentScript + sendToContentScript + 可能 2 次重试 + MV3 SW 冷启动)。
      // 旧插件用户反馈"scroll timed out after 3000ms"就是这条路径 3s 预算太紧撞穿;
      // 提到 10s 给 SW 唤醒 + 注入开销留 ~2x 安全余量。abortableCmd 包住,用户停任务时
      // 仍会立刻中断,不会因为放宽 timeout 拖慢响应。
      await abortableCmd('scroll', { direction: 'down', amount: amount || randInt(2, 4) }, 10000);
    },

    // ── chargeAction ───────────────────────────────────────────────
    // Non-AI 互动动作按次扣费(点赞/关注/订阅/评论/图文 等)。每次成功执行
    // 一个互动动作单独计费,跟 AI 写作/生图的 token 费分开 — AI 写评论内容
    // 本身的 token 费走 /api/ai 的 chat 通道,这笔 charge 是产品层面"每次
    // 动作按次扣"。
    //
    // 架构边界:**服务端是单一权威**
    //   - 合法的 actionType / platform 由后端 charge.ts 的 PRICE_RANGES /
    //     ALLOWED_PLATFORMS 定义,这里 actionType / platform 都用 string
    //     透传,不在客户端做白名单 — 加新平台 / 新动作类型不需要重新发版
    //     客户端,只改后端 + scenarios/*.js 即可。
    //   - 非法 actionType / platform 服务端返 422 'invalid_action_type' /
    //     'invalid_platform',这里走 reason 返回,不抛异常。
    //   - 价格区间也在服务端定(防伪造),客户端不知道也不需要知道。
    //
    // 用法: const r = await ctx.chargeAction('like', 'douyin', refId)
    //   返回 { ok, charged, balance_after } 或 { ok: false, reason }
    //   balance 不够时不抛异常,返回 ok:false 让 orchestrator 自决(继续 or 停)
    chargeAction: async (
      actionType: string,
      platform: string,
      refId?: string
    ): Promise<{ ok: boolean; charged?: number; balance_after?: number; reason?: string }> => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      const nbAuthToken = getNoobClawAuthToken();
      if (!nbAuthToken) return { ok: false, reason: 'auth_missing' };
      try {
        const res = await fetch('https://api.noobclaw.com/api/charge/action', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${nbAuthToken}`,
          },
          body: JSON.stringify({ action_type: actionType, platform, ref_id: refId || null }),
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok) {
          // 402 insufficient_balance / 422 bad input / 500 server
          return { ok: false, reason: String(data?.error || `http_${res.status}`) };
        }
        const charged = typeof data?.charged === 'number' ? data.charged : 0;
        const costUsd = typeof data?.cost_usd === 'number' ? data.cost_usd : 0;
        // v1.x: feed the per-action charge into the same tokens/cost stream
        // as AI chat + image gen, so TaskDetailPage 的「本次/上次/累计消耗」
        // 💎 + $ 数字把按次扣费也算进来。旧版本(后端 charge.ts 没返 cost_usd)
        // 时 costUsd = 0,💎 数字仍准,只是 $ 那栏偏低。
        if (charged > 0 && progress.addTokensUsed) {
          progress.addTokensUsed(charged, costUsd);
        }
        return {
          ok: true,
          charged,
          balance_after: typeof data?.balance_after === 'number' ? data.balance_after : undefined,
        };
      } catch (err: any) {
        return { ok: false, reason: 'network_error: ' + String(err?.message || err).slice(0, 80) };
      }
    },

    sleep: async (min: number, max?: number) => {
      // Interruptible sleep — checks abort every 200ms (was 500ms)
      const total = max ? randInt(min, max) : min;
      const start = Date.now();
      while (Date.now() - start < total) {
        if (progress.isAbortRequested()) throw new Error('user_stopped');
        await sleep(Math.min(200, total - (Date.now() - start)));
      }
    },

    // ── Script injection ──
    // Runs a server-hosted script, optionally replacing __PLACEHOLDERS__
    runScript: async (name: string, params?: Record<string, string>) => {
      let script = scripts[name];
      if (!script) {
        coworkLog('WARN', 'phaseRunner', `script "${name}" not found in pack`);
        return null;
      }
      if (params) {
        for (const [key, val] of Object.entries(params)) {
          script = script.replace(new RegExp(`__${key.toUpperCase()}__`, 'g'), String(val).replace(/'/g, "\\'"));
        }
      }
      try {
        const res = await abortableCmd('javascript', { code: script }, 8000);
        const raw = res?.result;
        if (typeof raw === 'string') {
          try { return JSON.parse(raw); } catch { return raw; }
        }
        return raw;
      } catch (err) {
        if (String(err && (err as any).message || err).includes('user_stopped')) throw err;
        coworkLog('WARN', 'phaseRunner', `runScript("${name}") failed`, { err: String(err) });
        return null;
      }
    },

    // Atomic click at coordinates — used by orchestrator's clickByText().
    // v4.31.39: 加 abortableCmd —— click 是发推/发帖按钮的最后一击,task 停
    //   了不 abort 浏览器还会真的点出去,造成用户报告"任务停了还在自动发文"。
    click: async (x: number, y: number) => {
      // click(coordinate) 同 scroll —— 扩展 background 无专门 handler,走 content-script
      // 转发慢路径(inject + sendMessage + 可能重试 + SW 冷启动)。3s 预算偏紧,旧插件
      // 用户偶发"click timed out after 3000ms";提到 10s 给 SW 唤醒留余量。abortableCmd
      // 包住,user_stopped 时立刻中断,不影响发推/发帖最后一击的可控性。
      await abortableCmd('click', { coordinate: [x, y] }, 10000);
    },

    // Debug log (visible in sidecar console, not in UI)
    log: (msg: string) => {
      coworkLog('INFO', 'orchestrator', msg);
    },

    checkAnomaly: async () => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      try {
        const res = await sendBrowserCommand('check_anomaly', {}, 5000, getBridgeOpts());
        const data = res?.data || res || {};
        const status = data.status || 'ok';
        if (status === 'captcha' || status === 'login_wall' || status === 'rate_limited' || status === 'account_flag') {
          riskGuard.recordAnomaly(task.id, status as any, manifest.risk_caps);
          ctx.report('检测到异常: ' + status);
          throw new Error('anomaly:' + status);
        }
      } catch (err) {
        if (String(err).startsWith('Error: anomaly:')) throw err;
      }
    },

    // Read feed cards via extension's built-in command (CSP-safe)
    readCards: async () => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      try {
        const res = await sendBrowserCommand('read_feed_cards', {}, 8000, getBridgeOpts());
        const data = res?.data || res || {};
        return data.cards || [];
      } catch (err) {
        coworkLog('WARN', 'phaseRunner', 'readCards failed', { err: String(err) });
        return [];
      }
    },

    // Read detail page via extension's built-in command (CSP-safe)
    readDetail: async () => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      try {
        const res = await sendBrowserCommand('read_detail_page', {}, 8000, getBridgeOpts());
        return res?.data || res || null;
      } catch (err) {
        coworkLog('WARN', 'phaseRunner', 'readDetail failed', { err: String(err) });
        return null;
      }
    },

    // ── AI calls ──
    // Get a prompt template by name (for orchestrator to fill variables)
    getPrompt: (name: string) => {
      const text = pack.prompts?.[name];
      if (!text) throw new Error('Missing prompt: ' + name);
      return text;
    },

    // AI call — sends prompt as-is, no extra system prompt added, saves tokens
    // promptNameOrRaw: prompt name from pack.prompts, or '__raw__' for direct prompt string
    // When __raw__: promptOrInput = the complete prompt, rawInput = user message
    aiCall: async (
      promptNameOrRaw: string,
      promptOrInput: any,
      rawInput?: string,
      opts?: {
        model?: 'noobclawai-chat' | 'noobclawai-reasoner';
        // v2.4.58+: quality gate — when set, runs deterministic checks on
        // the AI's output (banned phrases / AI-grammar openers / length /
        // un-round number requirement). On failure, augments the user
        // message with the specific failure list and retries up to
        // maxRetries times. Reply scenarios omit this; post composers use it.
        qualityGate?: {
          minLen?: number;
          maxLen?: number;
          bannedPhrases?: string[];     // platform-specific (banned snippets)
          requireUnRoundNumber?: boolean;
          maxRetries?: number;          // default 2 (so total attempts ≤ 3)
        };
        // v4.31.3 架构清理:expectJson=false → 纯文本模式,跳过 JSON.parse,
        // qualityGate 直接验 raw 字符串,返回字符串。配合 prompt 里写 "只输出正文
        // 不要 JSON 包" 的场景。默认 true 维持老行为(老 orchestrator 不动)。
        expectJson?: boolean;
        // Internal — used by the recursive retry. Callers should NOT set this.
        _attempt?: number;
      }
    ) => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');

      let prompt: string;
      let userMessage: string;

      if (promptNameOrRaw === '__raw__') {
        prompt = String(promptOrInput);
        userMessage = String(rawInput || '');
      } else {
        const promptText = pack.prompts?.[promptNameOrRaw];
        if (!promptText) throw new Error('Missing prompt: ' + promptNameOrRaw);
        prompt = promptText.trim();
        userMessage = typeof promptOrInput === 'string' ? promptOrInput : JSON.stringify(promptOrInput);
      }

      // Model selection (v2.4.56+):
      //   - noobclawai-chat      (default) — reply / engagement / parsing,
      //                            optimized for speed + JSON obedience.
      //   - noobclawai-reasoner  — post composition (original / rewrite)
      //                            where we want deeper reasoning to craft
      //                            high-quality content with hook + structure.
      // Orchestrator picks via `opts.model`. Reply scenarios just omit it.
      const chosenModel = (opts && opts.model) || 'noobclawai-chat';
      const attempt = (opts && opts._attempt) || 1;
      const maxRetries = (opts && opts.qualityGate && opts.qualityGate.maxRetries) ?? 2;

      // Scenario rewrite must ALWAYS go through our NoobClaw proxy with
      // model=noobclawai-chat, regardless of the user's current default
      // provider. Rationale:
      //   - We bill scenario usage against the user's NoobClaw balance,
      //     not their personal Qwen/Kimi/DeepSeek-direct key. Using a
      //     third-party provider here would route the cost to them
      //     (surprise invoice) AND skip our metering / token ledger.
      //   - The rewrite prompt is tuned for deepseek-chat's JSON
      //     behaviour; swapping to reasoner/qwen/etc. regresses output
      //     quality or outright breaks JSON parsing.
      //   - Support is simpler when every scenario run uses the same
      //     upstream.
      //
      // So we build our own HTTP request to /api/ai/chat/completions,
      // independent of the user's settings. The Anthropic SDK is NOT
      // reusable here because it authenticates with x-api-key, while our
      // backend authMiddleware requires Authorization: Bearer <JWT>.
      // Simpler to just do a direct fetch in OpenAI-compat format.
      const nbAuthToken = getNoobClawAuthToken();
      if (!nbAuthToken) throw new Error('AI_NOT_CONFIGURED — 请先登录 NoobClaw 账号');

      const startedAt = Date.now();
      const heartbeat = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        ctx.report('AI 仍在生成中... (' + elapsedSec + 's)');
      }, 10000);

      const controller = new AbortController();
      const abortPoll = setInterval(() => {
        if (progress.isAbortRequested()) {
          controller.abort();
        }
      }, 500);

      // v4.31.4: 用 DeepSeek 原生 response_format 锁格式 — JSON 模式下后端
      // 保证 content 字符串是合法 JSON,纯文本模式直接返回字符串。
      //
      // ⚠️ 文档警告:json_object 模式必须 prompt 里含 "json" 字眼,否则 DeepSeek
      // 会无限输出空白直到 token 用完(stuck 请求)。所以下面做了保护性校验:
      // expectJson 默认为 true(老行为),但只在 prompt 真的提到 "json/JSON" 时
      // 才传 response_format,否则 fallback 到 text 模式 + 我方 JSON.parse 兜底。
      const wantJson = opts?.expectJson !== false;
      const promptMentionsJson = /json/i.test(prompt) || /json/i.test(userMessage);
      const requestBody: Record<string, unknown> = {
        model: chosenModel,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userMessage },
        ],
        stream: false,
        max_tokens: 8000,
      };
      if (wantJson && promptMentionsJson) {
        requestBody.response_format = { type: 'json_object' };
      } else if (!wantJson) {
        requestBody.response_format = { type: 'text' };
      }
      // 其余情况(wantJson 但 prompt 没说 json)— 不传,用 DeepSeek 默认 text,
      // 我方 JSON.parse 失败时仍然走 expectJson:true 的兜底路径(parse 失败抛 +
      // err.rawText 挂全文)。

      // v4.31.6: fetch 网络错误一次性重试。'fetch failed' 通常是瞬时网络抖动
       // (WiFi 切换 / VPN 重连 / 服务侧短暂 502),首次失败后等 3s 重试一次。
       // 不重试 5xx / abort / 业务错(401/402)— 那些是确定性失败。
      const fetchWithRetry = async (): Promise<Response> => {
        const doFetch = () => fetch('https://api.noobclaw.com/api/ai/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${nbAuthToken}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        try {
          return await doFetch();
        } catch (err: any) {
          if (err?.name === 'AbortError' || progress.isAbortRequested()) throw err;
          coworkLog('WARN', 'phaseRunner', 'fetch failed, retrying once', { err: String(err).slice(0, 200) });
          ctx.report('   ⚠️ 网络异常,3 秒后重试一次');
          await new Promise(r => setTimeout(r, 3000));
          return await doFetch(); // 第二次失败就让它抛
        }
      };

      try {
        const resp = await fetchWithRetry();
        if (!resp.ok) {
          if (resp.status === 401) throw new Error('AI_AUTH_FAILED — NoobClaw 登录态失效，请重新登录');
          if (resp.status === 402) throw new Error('CREDITS_INSUFFICIENT — 积分余额不足，请前往钱包充值');
          const errText = await resp.text().catch(() => '');
          throw new Error(`AI API ${resp.status}: ${errText.slice(0, 200)}`);
        }
        const json = await resp.json() as any;
        const raw = json?.choices?.[0]?.message?.content || '';
        if (!raw) {
          coworkLog('WARN', 'phaseRunner', 'AI returned empty content', { json });
          throw new Error('AI_EMPTY_RESPONSE — AI 返回空内容');
        }
        // v2.4.36: capture token usage + server-authoritative USD cost.
        // Backend's /api/ai/chat/completions now returns:
        //   response._noobclaw = {
        //     remainingTokens, tokensUsed,
        //     priceUsdPerMillion, costUsd   ← new in v4.20.1 backend
        //   }
        // costUsd is precomputed server-side from system_config.token_price_
        // per_million × billableTokens (after cache-hit discount), so the
        // client never hardcodes a rate. Falls back to raw total_tokens
        // only when the server doesn't include the NoobClaw extension
        // (backward compat with old backends).
        try {
          const nb = json?._noobclaw;
          const total = Number(json?.usage?.total_tokens) || 0;
          const cost = Number(nb?.costUsd) || 0;
          if (total > 0 && progress.addTokensUsed) progress.addTokensUsed(total, cost);
        } catch { /* non-fatal */ }
        // v4.31.3 架构清理:两条返回路径 — JSON 模式 vs 纯文本模式 —
        // 都走同一个 qualityGate 重试逻辑。
        const isTextMode = opts?.expectJson === false;

        // ── 决定可被 qualityGate 校验的 text + 最终 return value ──
        let textForGate: string;
        let returnValue: any;
        if (isTextMode) {
          // 纯文本模式 — 不解析,直接用 raw,return string
          textForGate = raw;
          returnValue = raw;
        } else {
          // JSON 模式 — 严格 parse,失败抛 AI_PARSE_FAIL(原文挂 err.rawText)
          const parsed = parseJsonSafe(raw);
          if (!parsed) {
            coworkLog('WARN', 'phaseRunner', 'AI response not JSON', { rawHead: raw.slice(0, 300) });
            const err: any = new Error('AI_PARSE_FAIL — AI 返回非 JSON: ' + raw.slice(0, 200).replace(/[\n\r]/g, ' '));
            err.rawText = raw;
            err.code = 'AI_PARSE_FAIL';
            throw err;
          }
          textForGate = (parsed && (parsed.text || parsed.content)) || (typeof parsed === 'string' ? parsed : '');
          returnValue = parsed;
        }

        // v5.x Universal boilerplate guard — runs on EVERY aiCall, not just
        // post composers. Catches model meta-talk / refusal templates before
        // they hit replies, comments, captions, or post bodies. Retry once;
        // still bad → throw so the orchestrator skips this send.
        const BOILERPLATE_MAX_RETRIES = 1; // 1 retry → 2 total attempts
        if (looksLikeAIRefusal(String(textForGate))) {
          if (attempt <= BOILERPLATE_MAX_RETRIES) {
            ctx.report('   ⚠️ AI 返回元描述/拒绝模板,重试中(' + attempt + '/' + (BOILERPLATE_MAX_RETRIES + 1) + '): ' + String(textForGate).slice(0, 80));
            const _hint = '\n\n⚠️ 上次输出包含 "rewrite/rewritten/改写/抱歉/I cannot" 等 AI 元描述/拒绝模板。**绝对禁止**这些词出现 — 直接输出真实用户口吻的内容,不要描述"自己在做什么"。';
            const newRawInput = (rawInput || userMessage) + _hint;
            if (promptNameOrRaw === '__raw__') {
              return await ctx.aiCall(promptNameOrRaw, prompt, newRawInput, {
                ...(opts || {}), _attempt: attempt + 1,
              } as any);
            } else {
              return await ctx.aiCall(promptNameOrRaw, userMessage + _hint, undefined, {
                ...(opts || {}), _attempt: attempt + 1,
              } as any);
            }
          } else {
            coworkLog('WARN', 'phaseRunner', 'AI boilerplate after retries — aborting call', {
              attempts: attempt, head: String(textForGate).slice(0, 200),
            });
            ctx.report('   🚫 AI 重试 ' + attempt + ' 次仍返回元描述/拒绝模板,放弃这次调用以免暴露身份');
            const err: any = new Error('AI_BOILERPLATE_AFTER_RETRY — AI 多次返回元描述/拒绝模板');
            err.code = 'AI_BOILERPLATE_AFTER_RETRY';
            // Deliberately NOT setting err.rawText. Some orchestrators have
            // catch blocks that fall back to err.rawText as the post body
            // when AI_PARSE_FAIL happens; if we set it here, the boilerplate
            // text would be published exactly the way we're trying to
            // prevent.
            throw err;
          }
        }

        // v2.4.58+ Quality gate(post composers opt in via opts.qualityGate)
        // 不论 JSON / text 模式都跑同一套校验 + 重试。
        if (opts && opts.qualityGate) {
          const gate = checkQuality(String(textForGate), opts.qualityGate);
          if (!gate.passed) {
            if (attempt <= maxRetries) {
              coworkLog('WARN', 'phaseRunner', 'Quality gate failed, retrying', {
                attempt, failures: gate.failures, textHead: String(textForGate).slice(0, 100),
              });
              ctx.report('   ⚠️ 质量门未过(' + gate.failures.join(' / ') + '),第 ' + attempt + ' 次尝试,重写中...');
              const feedback = '\n\n⚠️ 上次输出在以下维度不合格,这次必须修正:\n'
                + gate.failures.map(f => '  • ' + f).join('\n')
                + '\n\n重新写一次,严格修正上述问题。';
              const newRawInput = (rawInput || userMessage) + feedback;
              if (promptNameOrRaw === '__raw__') {
                return await ctx.aiCall(promptNameOrRaw, prompt, newRawInput, {
                  ...opts, _attempt: attempt + 1,
                });
              } else {
                return await ctx.aiCall(promptNameOrRaw, userMessage + feedback, undefined, {
                  ...opts, _attempt: attempt + 1,
                });
              }
            } else {
              coworkLog('WARN', 'phaseRunner', 'Quality gate exhausted retries, returning last attempt', {
                attempts: attempt, failures: gate.failures,
              });
              ctx.report('   ⚠️ 质量门 ' + (maxRetries + 1) + ' 次都未过,使用最后一次输出。失败项: ' + gate.failures.join(' / '));
            }
          } else if (attempt > 1) {
            ctx.report('   ✅ 质量门第 ' + attempt + ' 次尝试通过');
          }
        }

        return returnValue;
      } catch (err: any) {
        if (err?.name === 'AbortError' || progress.isAbortRequested()) {
          throw new Error('user_stopped');
        }
        throw err;
      } finally {
        clearInterval(heartbeat);
        clearInterval(abortPoll);
      }
    },

    // ── State management ──
    recordSeen: (postIds: string[]) => {
      taskStore.recordSeen(task.id, postIds);
    },
    // v4.25.36: 暴露读取 seen 列表 — binance_from_x_repost 等需要跨 run 跳过
    // 已经搬运过的源推文。返回 Set<string>(orchestrator 自己 .has() 判断)。
    getSeenIds: (): Set<string> => {
      return taskStore.getSeenPostIds(task.id);
    },
    // v6: AI 衍生关键词回写 — 当原关键词的新鲜内容都被搜尽(本轮所有词只返回已抓过的素材)时,
    //   orchestrator 让 AI 按 persona/track/原词衍生几个新词,通过此方法【累积存回任务配置】,
    //   下次运行自动纳入关键词池(长期自我扩张)。field 默认 'keywords'(string[]);图文任务的
    //   实景图词在 'real_photo_keywords'(空格分隔字符串)。去重后写回 taskStore 持久化 + 同步内存
    //   task 让本轮后续也能读到。返回合并后的完整列表。老客户端无此方法 → orchestrator 用可选链,
    //   只衍生当次用、不持久化(优雅降级,不崩)。
    appendKeywords: (words: string[], field: 'keywords' | 'real_photo_keywords' = 'keywords'): string[] => {
      const clean = (words || []).map((w) => String(w || '').trim()).filter(Boolean);
      const anyTask = task as any;
      if (field === 'real_photo_keywords') {
        const merged = String(anyTask.real_photo_keywords || '').trim().split(/\s+/).filter(Boolean);
        for (const w of clean) if (!merged.includes(w)) merged.push(w);
        const joined = merged.join(' ');
        anyTask.real_photo_keywords = joined;
        if (clean.length > 0) taskStore.updateTask(task.id, { real_photo_keywords: joined } as any);
        return merged;
      }
      const merged = Array.isArray(anyTask.keywords) ? anyTask.keywords.slice() : [];
      for (const w of clean) if (!merged.includes(w)) merged.push(w);
      anyTask.keywords = merged;
      if (clean.length > 0) taskStore.updateTask(task.id, { keywords: merged });
      return merged;
    },

    // Call backend API (e.g. image generation) — includes auth token,
    // abortable via progress.isAbortRequested() every 300ms.
    //
    // Pass `body` for POST (default). Omit body (or pass undefined) to
    // issue a GET — used by the async image-job polling flow which hits
    // /api/image/status/:job_id.
    apiCall: async (endpoint: string, body?: any) => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      const baseUrl = 'https://api.noobclaw.com';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const authToken = getNoobClawAuthToken();
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const method = body === undefined ? 'GET' : 'POST';

      // AbortController so we can cancel the fetch mid-flight when the user
      // hits stop — without this, the client blocks for up to a minute on
      // long-running image generation.
      const controller = new AbortController();
      const abortPoll = setInterval(() => {
        if (progress.isAbortRequested()) {
          controller.abort();
          clearInterval(abortPoll);
        }
      }, 300);

      // Heartbeat only for long-running POSTs (not short GET polls).
      // /status/:id polls come back in <100ms each, a heartbeat would
      // flood the log.
      const started = Date.now();
      const heartbeat = method === 'POST'
        ? setInterval(() => {
            const secs = Math.round((Date.now() - started) / 1000);
            if (secs >= 8) ctx.report('仍在生成中... (' + secs + 's)');
          }, 8000)
        : null;

      try {
        const resp = await fetch(baseUrl + endpoint, {
          method,
          headers,
          body: method === 'POST' ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        if (!resp.ok) {
          if (resp.status === 402) {
            throw new Error('TOKEN_INSUFFICIENT — 积分不足，请充值后重试');
          }
          const errText = await resp.text().catch(() => '');
          throw new Error('API ' + resp.status + ': ' + errText.slice(0, 200));
        }
        const json = await resp.json() as any;
        // 累加图片生成的 token 到任务统计 — chat 路径在 ctx.aiCall 内部走
        // progress.addTokensUsed(usage.total_tokens, _noobclaw.costUsd),但 imageGen
        // 走通用 apiCall 不经过那条路径,导致图的 token 不在任务"💎 X tokens"里显示。
        // sync /api/image/generate 和 async /api/image/status/<id>(done) 都返回
        // token_cost + _noobclaw.costUsd,在这里统一累加。同一 jobId 只会 done 一次,
        // 不会重复累加。
        try {
          const tokenCost = Number(json?.token_cost) || 0;
          if (tokenCost > 0 && progress.addTokensUsed) {
            const cost = Number(json?._noobclaw?.costUsd) || 0;
            progress.addTokensUsed(tokenCost, cost);
          }
        } catch { /* non-fatal */ }
        return json;
      } catch (err: any) {
        if (err?.name === 'AbortError' || progress.isAbortRequested()) {
          throw new Error('user_stopped');
        }
        throw err;
      } finally {
        clearInterval(abortPoll);
        if (heartbeat) clearInterval(heartbeat);
      }
    },

    // v2.x: news_usage local dedup for writing scenarios (binance / x).
    //   ctx.newsUsage.isUsed(title)  → bool  — has this wallet posted on this
    //                                          source article (by title) for
    //                                          this scenario before?
    //   ctx.newsUsage.markUsed(title) → void — call after a successful publish
    //
    // Wallet is auto-derived from current JWT inside the helper. Scenario id
    // is auto-bound from the manifest so orchestrator doesn't need to pass it.
    // Title hash logic (md5 of normalized title) is encapsulated in the helper.
    newsUsage: {
      isUsed: (title: string): boolean => {
        const scenarioId = String((manifest as any)?.id || '');
        if (!scenarioId) return false;
        return newsUsageStore.isNewsUsed(scenarioId, title);
      },
      markUsed: (title: string): void => {
        const scenarioId = String((manifest as any)?.id || '');
        if (!scenarioId) return;
        newsUsageStore.markNewsUsed(scenarioId, title);
      },
    },

    // v6.x: engage_history local dedup for engage / reply scenarios.
    //   ctx.engageHistory.has(action, targetId)      → bool
    //   ctx.engageHistory.remember(action, targetId) → void
    //
    // platform is auto-bound from manifest.platform inside the helper —
    // orchestrator only passes (action, targetId). Wallet is scoped via
    // JWT inside engageHistoryStore (matrix accounts don't share dedup).
    //
    // Conventions:
    //   action = 'comment'  → auto_engage: target = BV / aweme / photoId
    //   action = 'reply'    → reply_fans:  target = md5(name + content)
    //   action = 'like' / 'follow' currently unused but reserved
    //
    // Fails open everywhere: missing wallet / missing store / DB error →
    // has() returns false, remember() no-ops. A duplicate comment is
    // worse than the dedup not catching it, but blocking the whole task
    // because sqlite hiccuped is worse than both.
    engageHistory: {
      has: (action: string, targetId: string): boolean => {
        const platform = String((manifest as any)?.platform || '');
        if (!platform) return false;
        return engageHistoryStore.isEngaged(platform, action, targetId);
      },
      remember: (action: string, targetId: string): void => {
        const platform = String((manifest as any)?.platform || '');
        if (!platform) return;
        engageHistoryStore.markEngaged(platform, action, targetId);
      },
    },

    // Generic file-write into the task's output dir. Used by scenarios
    // that produce a free-form report (e.g. auto_reply's run summary)
    // instead of structured drafts. Returns the absolute path so the
    // orchestrator can log it.
    writeReport: async (filename: string, content: string) => {
      try {
        // Resolve platform from the manifest so Twitter tasks' outputs
        // land in "推特/<task>/..." not "小红书/<task>/...". Before the
        // v2.4.23 fix, getTaskOutputDir defaulted to 'xhs' which put
        // every Twitter report under the XHS folder.
        const platform = (manifest as any).platform || 'xhs';
        const dir = getTaskOutputDir(task, platform);
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        // sanitize: strip path separators, keep CJK + alnum + safe punctuation
        const safeName = String(filename || 'report.md').replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
        const filePath = path.join(dir, safeName);
        fs.writeFileSync(filePath, String(content), 'utf8');
        coworkLog('INFO', 'phaseRunner', 'writeReport ok', { path: filePath, bytes: Buffer.byteLength(String(content), 'utf8') });
        return { ok: true, path: filePath, dir };
      } catch (err) {
        coworkLog('WARN', 'phaseRunner', 'writeReport failed', { err: String(err) });
        return { ok: false, reason: String(err && (err as any).message ? (err as any).message : err) };
      }
    },

    // v2.4.90: Binary asset write — decodes base64 and saves to task's
    // output dir. Unlike writeReport (utf8-only), this handles images /
    // audio / any binary. Used by x_link_rewrite to save source tweet
    // images next to the markdown report for user audit.
    // opts.subdir: optional subdirectory inside task dir (e.g. '原文').
    // Single-level only, stripped of path separators / parent refs for safety.
    writeAsset: async (
      filename: string,
      base64: string,
      opts?: { subdir?: string; compress?: boolean; maxSizeKB?: number; maxDimension?: number }
    ) => {
      try {
        const platform = (manifest as any).platform || 'xhs';
        const dir = getTaskOutputDir(task, platform);
        let targetDir = dir;
        if (opts && typeof opts.subdir === 'string' && opts.subdir.trim()) {
          // v4.25.2: 允许嵌套("原文/career_side_hustle"),但每层 segment 单独 sanitize
          // 防 path traversal:任何带 .. 的 segment 直接丢
          const segments = opts.subdir.split(/[\\/]+/).map(s =>
            s.replace(/[:*?"<>|]/g, '_').replace(/^\.+$/, '').slice(0, 80).trim()
          ).filter(s => s.length > 0 && s !== '..');
          if (segments.length > 0) targetDir = path.join(dir, ...segments);
        }
        try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}
        const safeNameRaw = String(filename || 'asset.bin').replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);

        let buf = Buffer.from(String(base64 || ''), 'base64');
        let safeName = safeNameRaw;

        // v4.25+: opt-in 图片压缩 — orchestrator 设 { compress: true } 就把图压
        // 到 ≤maxSizeKB(默认 300KB)。jpeg + 长边 ≤maxDimension(默认 1600).
        // 用 sharp(client deps 已带);非图片或 sharp 解码失败就 fallback 写原 buffer。
        if (opts && opts.compress && buf.length > 0) {
          const targetKB = opts.maxSizeKB || 300;
          const maxDim = opts.maxDimension || 1600;
          if (buf.length > targetKB * 1024) {
            try {
              // dynamic require 避免 sharp 没装(开发时)整个 phaseRunner 起不来
              const sharp = require('sharp');
              let pipeline = sharp(buf, { failOn: 'error' }).rotate();
              const meta = await pipeline.metadata().catch((): any => null);
              if (meta && meta.width && meta.height) {
                const longest = Math.max(meta.width, meta.height);
                if (longest > maxDim) {
                  pipeline = pipeline.resize({
                    width: meta.width >= meta.height ? maxDim : undefined,
                    height: meta.height > meta.width ? maxDim : undefined,
                    fit: 'inside', withoutEnlargement: true,
                  });
                }
                // 二分逼近 quality
                let qLo = 30, qHi = 90;
                let best: Buffer | null = null;
                for (let it = 0; it < 6; it++) {
                  const q = Math.round((qLo + qHi) / 2);
                  const out = await pipeline.clone().jpeg({ quality: q, mozjpeg: true }).toBuffer();
                  if (out.length <= targetKB * 1024) { best = out; qLo = q + 1; }
                  else qHi = q - 1;
                  if (qLo > qHi) break;
                }
                if (!best) best = await pipeline.clone().jpeg({ quality: 30, mozjpeg: true }).toBuffer();
                buf = Buffer.from(best);
                // 强制扩展名为 .jpg(压缩后是 jpeg)
                safeName = safeNameRaw.replace(/\.(png|webp|gif|bmp|tiff?)$/i, '.jpg');
                if (!/\.jpe?g$/i.test(safeName)) safeName = safeName.replace(/\.[^.]*$/, '') + '.jpg';
              }
            } catch (compressErr) {
              coworkLog('WARN', 'phaseRunner', 'writeAsset compress failed, falling back to original', {
                err: String(compressErr).slice(0, 200),
              });
            }
          }
        }

        const filePath = path.join(targetDir, safeName);
        fs.writeFileSync(filePath, buf);
        coworkLog('INFO', 'phaseRunner', 'writeAsset ok', { path: filePath, bytes: buf.length });
        return { ok: true, path: filePath, dir: targetDir, bytes: buf.length };
      } catch (err) {
        coworkLog('WARN', 'phaseRunner', 'writeAsset failed', { err: String(err) });
        return { ok: false, reason: String(err && (err as any).message ? (err as any).message : err) };
      }
    },

    // v4.25.2: 拉服务端下发的爆文库配置(max_per_run / max_image_size_kb / max_image_count)。
    // 缓存到 ctx 上避免每次都打一遍 GET — 同一次 run 内只取一次。
    // 取不到就用代码里的默认值兜底(5/300/4),保证旧服务端兼容。
    getViralConfig: async () => {
      if ((ctx as any)._viralConfigCache) return (ctx as any)._viralConfigCache;
      const fallback: any = {
        max_per_run: 100,
        max_image_size_kb: 300,
        max_image_count: 4,
        // v4.27: 兜底阈值跟服务端 VIRAL_THRESHOLDS 一致。新服务端会下发,
        // 老服务端拿不到也能用这套默认值。
        thresholds: {
          // 字段在三平台对齐 — 缺失维度服务端可挂 null,helper 会跳过。
          // XHS 的 min_views 填值但实际抓不到(平台不公开),仅为 schema 对齐。
          xhs:     { min_likes: 500, min_comments: 20, min_views: 1000, min_match: 1 },
          x:       { min_likes: 500, min_comments: 20, min_views: 1000, min_match: 1 },
          binance: { min_likes: 500, min_comments: 20, min_views: 5000, min_match: 1 },
        },
      };
      try {
        const baseUrl = 'https://api.noobclaw.com';
        const resp = await fetch(baseUrl + '/api/viral/library/config');
        if (!resp.ok) {
          (ctx as any)._viralConfigCache = fallback;
          return fallback;
        }
        const data = await resp.json();
        const merged: any = {
          max_per_run: typeof data.max_per_run === 'number' && data.max_per_run > 0 ? data.max_per_run : fallback.max_per_run,
          max_image_size_kb: typeof data.max_image_size_kb === 'number' && data.max_image_size_kb > 0 ? data.max_image_size_kb : fallback.max_image_size_kb,
          max_image_count: typeof data.max_image_count === 'number' && data.max_image_count > 0 ? data.max_image_count : fallback.max_image_count,
          thresholds: (data.thresholds && typeof data.thresholds === 'object') ? data.thresholds : fallback.thresholds,
        };
        (ctx as any)._viralConfigCache = merged;
        return merged;
      } catch (_) {
        (ctx as any)._viralConfigCache = fallback;
        return fallback;
      }
    },

    // v4.28 把已识别的爆款队列(ctx._viralFlushQueue)批量发到爆文库,清空队列。
    // 每个动作间隔调一次 — 任务被中断时不至于一次丢光所有识别的爆款。
    // 返 { ok, accepted, inserted, updated, dup_skip, failed, ... } — 服务端
    // 准确反馈每条入库的状态。
    flushViralQueue: async (platform: string): Promise<any> => {
      const queue = (ctx as any)._viralFlushQueue;
      if (!Array.isArray(queue) || queue.length === 0) {
        return { ok: false, reason: 'empty', queue_size: 0 };
      }
      const items = queue.splice(0); // 取出 + 同步清空,防 reentry 重复发
      try {
        const res = await (ctx as any).pushToViralLibrary({ platform, items });
        // 累计 ingest 计数到 viralStats,reportViralStatus 末尾打总结时用
        if (res && (res.ok || res.accepted || res.queued)) {
          if (!(ctx as any)._viralStats) (ctx as any)._viralStats = {};
          const s = (ctx as any)._viralStats;
          s.ingested = (s.ingested || 0) + (res.accepted || res.queued || 0);
        }
        return res || { ok: false, reason: 'no_response' };
      } catch (err: any) {
        // push 失败:把 items 放回队尾,下次 flush 重试
        queue.unshift(...items);
        return { ok: false, reason: 'push_failed:' + String(err && err.message || err).slice(0, 80) };
      }
    },

    // v4.27 评估候选帖是否过爆款阈值。post 字段名按平台 normalize 取(orchestrator
    // 里 metric 字段命名各异:likes / likes_count / comment_count / replies_count …)。
    // 任一阈值字段命中算 1 hit;hit 数 ≥ min_match 即合格。字段缺失不参与评估。
    //
    // 返回 boolean。这是判"该帖是否值得入爆文库"的唯一真理来源 — 跟"该帖是否
    // 被选去回复"完全独立。
    //
    // v4.25.12 副作用:每次调用累加 ctx._viralStats(供 reportViralStatus 在 run 末
    // 打总结)。让用户看到"本次评估 N 篇,M 篇过门槛,实际入库 K 条"的可见性。
    passViralThreshold: async (post: any, platform: string): Promise<boolean> => {
      if (!(ctx as any)._viralStats) (ctx as any)._viralStats = {
        evaluated: 0, passed: 0, missed_likes: 0, missed_comments: 0, missed_views: 0,
        no_threshold: 0, no_post_data: 0,
      };
      const stats = (ctx as any)._viralStats;
      if (!post || !platform) {
        stats.no_post_data++;
        return false;
      }
      const cfg = await (ctx as any).getViralConfig();
      const t = cfg && cfg.thresholds && cfg.thresholds[platform];
      if (!t) {
        stats.no_threshold++;
        return false;
      }
      stats.evaluated++;
      const likes = Number(post.likes_count ?? post.likes ?? 0) || 0;
      const comments = Number(
        post.comments_count ?? post.replies_count ?? post.comment_count
        ?? post.comments ?? post.replies ?? 0
      ) || 0;
      const views = Number(post.views_count ?? post.views ?? 0) || 0;
      let hits = 0;
      if (t.min_likes != null    && likes    >= t.min_likes)    hits++;
      else if (t.min_likes != null) stats.missed_likes++;
      if (t.min_comments != null && comments >= t.min_comments) hits++;
      else if (t.min_comments != null) stats.missed_comments++;
      if (t.min_views != null    && views    >= t.min_views)    hits++;
      else if (t.min_views != null) stats.missed_views++;
      const need = (typeof t.min_match === 'number' && t.min_match > 0) ? t.min_match : 1;
      const pass = hits >= need;
      if (pass) stats.passed++;
      return pass;
    },

    // v4.25.12 在 run 末尾汇总打一条总结 — 不管是否有爆款入库,用户都能看到
    // "本次爆文库到底干了啥"。每个 orchestrator 在 step 3 写报告前调一次。
    reportViralStatus: async (platform: string, stepNum?: number): Promise<void> => {
      const stats = (ctx as any)._viralStats;
      const step = (stepNum && stepNum > 0) ? stepNum : (ctx._currentStep || 3);
      // 拉服务端阈值显示出来,让用户看到门槛是多少
      let thresholdLine = '';
      try {
        const cfg = await (ctx as any).getViralConfig();
        const t = cfg && cfg.thresholds && cfg.thresholds[platform];
        if (t) {
          const parts: string[] = [];
          if (t.min_likes != null) parts.push('赞≥' + t.min_likes);
          if (t.min_comments != null) parts.push('评论≥' + t.min_comments);
          if (t.min_views != null) parts.push('浏览≥' + t.min_views);
          thresholdLine = '门槛: ' + parts.join(' OR ') + ' (任 ' + (t.min_match || 1) + ' 项)';
        }
      } catch (_) {}

      if (!stats || stats.evaluated === 0) {
        progress.stepLog(step, 'running',
          '📊 爆文库[' + platform + ']: 本次未评估任何候选(可能 feed 没读到帖子或 metric 全缺)'
          + (thresholdLine ? ' · ' + thresholdLine : ''));
        return;
      }
      progress.stepLog(step, 'running',
        '📊 爆文库[' + platform + ']: 评估 ' + stats.evaluated + ' 篇 · 过门槛 ' + stats.passed + ' 篇'
        + (thresholdLine ? ' · ' + thresholdLine : ''));
      if (stats.passed === 0 && stats.evaluated > 0) {
        // 帮用户理解为啥都没过
        const missLines: string[] = [];
        if (stats.missed_likes > 0) missLines.push('赞不够 ' + stats.missed_likes + ' 篇');
        if (stats.missed_comments > 0) missLines.push('评论不够 ' + stats.missed_comments + ' 篇');
        if (stats.missed_views > 0) missLines.push('浏览不够 ' + stats.missed_views + ' 篇');
        if (missLines.length > 0) {
          progress.stepLog(step, 'running', '   原因: ' + missLines.join(' / '));
        }
      }
    },

    // v4.25+: ingest 当次抓到的原文 + 原图到爆文库(三平台共享池)。
    // payload 形式:
    //   ctx.pushToViralLibrary({ platform: 'x'|'xhs'|'binance', items: [
    //     {
    //       source_id: string,        // 必填,平台内唯一(tweet_id / note_id / post_id)
    //       source_url: string,
    //       title?: string,           // 推特/币安没有标题,可省
    //       content: string,          // 必填,正文
    //       author?: string,          // 显示名
    //       author_handle?: string,   // @handle / 个人页 slug
    //       image_base64s?: string[], // 后端会用 sharp 压到 ≤300KB 再传 R2
    //       posted_at?: number|string,
    //       views?: number, likes?: number, replies?: number,
    //     }
    //   ]})
    // 后端会:
    //   - 过滤政治/暴力/血腥/色情命中条目
    //   - sanitize + 参数化入库防注入
    //   - 单条最多 4 张图,每张压到 ≤300KB
    //   - 一次最多 ingest 5 条(配置在 /api/viral/library/config)
    //   - 重复 source_id 只更新 metrics 不覆盖正文/图
    pushToViralLibrary: async (payload: { platform: 'x' | 'xhs' | 'binance'; items: any[] }) => {
      if (!payload || !payload.platform || !Array.isArray(payload.items) || payload.items.length === 0) {
        return { ok: false, reason: 'invalid_payload' };
      }
      const authToken = getNoobClawAuthToken();
      if (!authToken) {
        coworkLog('INFO', 'phaseRunner', 'pushToViralLibrary skipped (no auth token)');
        return { ok: false, reason: 'no_auth_token' };
      }

      // v4.25.3 (C):客户端预压缩 base64 — 把每张图压到 ≤300KB 再上传,
      // body 体积 5-20x 缩水(慢网用户上传时间从分钟级降到秒级)。
      // 服务端 sharp 检测 buf.length 已 ≤target 会跳过二次压缩。
      try {
        const sharp = require('sharp');
        const TARGET_KB = 300;
        const MAX_DIM = 1600;
        for (const item of payload.items) {
          if (!Array.isArray(item.image_base64s)) continue;
          for (let bi = 0; bi < item.image_base64s.length; bi++) {
            const b64 = item.image_base64s[bi];
            if (typeof b64 !== 'string' || b64.length === 0) continue;
            try {
              const buf = Buffer.from(b64, 'base64');
              if (buf.length <= TARGET_KB * 1024) continue; // 已经够小
              let pipeline = sharp(buf, { failOn: 'error' }).rotate();
              const meta = await pipeline.metadata().catch((): any => null);
              if (!meta || !meta.width || !meta.height) continue;
              const longest = Math.max(meta.width, meta.height);
              if (longest > MAX_DIM) {
                pipeline = pipeline.resize({
                  width: meta.width >= meta.height ? MAX_DIM : undefined,
                  height: meta.height > meta.width ? MAX_DIM : undefined,
                  fit: 'inside', withoutEnlargement: true,
                });
              }
              let qLo = 30, qHi = 90;
              let best: Buffer | null = null;
              for (let it = 0; it < 6; it++) {
                const q = Math.round((qLo + qHi) / 2);
                const out = await pipeline.clone().jpeg({ quality: q, mozjpeg: true }).toBuffer();
                if (out.length <= TARGET_KB * 1024) { best = out; qLo = q + 1; }
                else qHi = q - 1;
                if (qLo > qHi) break;
              }
              if (!best) best = await pipeline.clone().jpeg({ quality: 30, mozjpeg: true }).toBuffer();
              item.image_base64s[bi] = Buffer.from(best).toString('base64');
            } catch (perItemErr) {
              // 单张压缩失败保留原 base64,服务端会再尝试压
              coworkLog('WARN', 'phaseRunner', 'preCompress single image failed', {
                err: String(perItemErr).slice(0, 100),
              });
            }
          }
        }
      } catch (compressErr) {
        // sharp 不可用 — 保留原 base64,服务端兜底压缩
        coworkLog('INFO', 'phaseRunner', 'preCompress unavailable, sending raw', {
          err: String(compressErr).slice(0, 100),
        });
      }

      // v4.25.3 (B):AbortController 30s 超时 — 弱网用户最坏 30s 而不是无限 hang
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      try {
        const baseUrl = 'https://api.noobclaw.com';
        const resp = await fetch(baseUrl + '/api/viral/library/ingest', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            platform: payload.platform,
            items: payload.items,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        // v4.25.3 (A):服务端现在异步处理,立即返回 202 + queued 数。
        // 200(老服务端)和 202(新服务端)都视为 OK。
        if (!resp.ok && resp.status !== 202) {
          const errText = await resp.text().catch(() => '');
          coworkLog('WARN', 'phaseRunner', 'pushToViralLibrary http error', {
            status: resp.status, body: errText.slice(0, 200),
          });
          return { ok: false, reason: 'http_' + resp.status };
        }
        const data = await resp.json().catch(() => ({}));
        coworkLog('INFO', 'phaseRunner', 'pushToViralLibrary ok', {
          accepted: data.accepted, queued: data.queued, items: data.items?.length,
        });
        return {
          ok: true,
          accepted: data.accepted || 0,
          queued: data.queued || 0,
          items: data.items || [],
        };
      } catch (err: any) {
        clearTimeout(timeoutId);
        const msg = err?.name === 'AbortError' ? 'timeout_30s' : String(err).slice(0, 200);
        coworkLog('WARN', 'phaseRunner', 'pushToViralLibrary failed', { err: msg });
        return { ok: false, reason: msg };
      }
    },

    // v4.25.4: 50% 概率从爆文库挑文章给 post_creator 改写。
    // 服务端按当前钱包过滤,排除已用过的(基于 viral_library.used_by_wallets 数组)。
    // 返回 { ok: true, item: {...} } 或 { ok: false, reason: '...' }
    pickFromViralLibrary: async (
      platform: 'x' | 'xhs' | 'binance',
      opts?: { category?: string }
    ) => {
      const authToken = getNoobClawAuthToken();
      if (!authToken) return { ok: false, reason: 'no_auth_token' };
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      try {
        const baseUrl = 'https://api.noobclaw.com';
        const qs = new URLSearchParams({ platform });
        if (opts?.category) qs.set('category', opts.category);
        const resp = await fetch(baseUrl + '/api/viral/library/pick?' + qs.toString(), {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${authToken}` },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!resp.ok) return { ok: false, reason: 'http_' + resp.status };
        const data = await resp.json().catch(() => ({}));
        return data;
      } catch (err: any) {
        clearTimeout(timeoutId);
        const msg = err?.name === 'AbortError' ? 'timeout_15s' : String(err).slice(0, 200);
        coworkLog('WARN', 'phaseRunner', 'pickFromViralLibrary failed', { err: msg });
        return { ok: false, reason: msg };
      }
    },

    // v4.25.6: 推特视频搬运 — 通过 Twitter Syndication API 拿真链 mp4
    // 端点 https://cdn.syndication.twimg.com/tweet-result?id=<id>&token=<rand>
    // 是 Twitter 给第三方 embed 用的公开端点,无需 cookie / 无需登录。
    // 返回 mediaDetails[].video_info.variants 含多档 mp4 直链。
    //
    // 实测(2026-04-27): tweet 2048339856938696725 拿到 720x1280 mp4,
    // 1 MB 文件 0.6s 下完。
    //
    // 不存任何 binary,只存到任务输出目录。caller 拿 filePath 后自己决定干啥
    // (本地审计 / 上传到币安/推特 / 走爆文库等)。
    fetchTweetVideo: async (
      tweetUrl: string,
      opts?: { outputDir?: string; preferQuality?: 'highest' | 'lowest' | 'medium' }
    ) => {
      try {
        // 1) 抽 status_id
        const m = String(tweetUrl || '').match(/(?:twitter|x)\.com\/[^\/]+\/status\/(\d+)/i);
        if (!m) return { ok: false, reason: 'invalid_tweet_url' };
        const statusId = m[1];

        // 2) 调 syndication API,加重试 —— Twitter 端偶发 503 / rate-limit / 网络瞬断,
        //    用户报"有时候又行"。3 次重试 + 指数退避 (1s/2s/4s) 把成功率从 ~50% 提到 95%+。
        //    每次失败的 status code / 错误打 log 方便用户在 cowork.log 里看根因。
        let meta: any = null;
        let lastErr = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
          const token = Math.random().toString(36).slice(2, 14);
          const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${statusId}&token=${token}`;
          const apiCtl = new AbortController();
          const apiTo = setTimeout(() => apiCtl.abort(), 8000); // 8s/次,3 次共 ~24s + 退避
          try {
            const apiResp = await fetch(apiUrl, {
              method: 'GET',
              headers: { 'User-Agent': 'Mozilla/5.0 NoobClaw/1.0', 'Accept': 'application/json' },
              signal: apiCtl.signal,
            });
            clearTimeout(apiTo);
            if (!apiResp.ok) {
              lastErr = 'http_' + apiResp.status;
              coworkLog('WARN', 'phaseRunner', `fetchTweetVideo Syndication 失败 attempt=${attempt}/3 status=${apiResp.status} statusId=${statusId}`);
              if (apiResp.status >= 500 || apiResp.status === 429) {
                if (attempt < 3) { await sleep(1000 * Math.pow(2, attempt - 1)); continue; }
              }
              return { ok: false, reason: 'syndication_http_' + apiResp.status };
            }
            meta = await apiResp.json().catch(() => null);
            if (meta) break;
            lastErr = 'json_parse_failed';
          } catch (e: any) {
            clearTimeout(apiTo);
            lastErr = String(e?.message || e).slice(0, 80);
            coworkLog('WARN', 'phaseRunner', `fetchTweetVideo Syndication 网络异常 attempt=${attempt}/3 err=${lastErr} statusId=${statusId}`);
            if (attempt < 3) { await sleep(1000 * Math.pow(2, attempt - 1)); continue; }
            return { ok: false, reason: 'syndication_failed:' + lastErr };
          }
        }
        if (!meta) return { ok: false, reason: 'syndication_no_meta:' + lastErr };
        if (meta.__typename === 'TweetTombstone') {
          return { ok: false, reason: 'tweet_unavailable' };
        }

        // 3) 找视频 + 选 mp4 variant
        const mediaList: any[] = Array.isArray(meta.mediaDetails) ? meta.mediaDetails : [];
        const videoMedia = mediaList.find((it: any) => it && it.type === 'video');
        if (!videoMedia) return { ok: false, reason: 'no_video' };

        const variants: Array<{ content_type: string; bitrate?: number; url: string }>
          = videoMedia.video_info?.variants || [];
        const mp4Variants = variants
          .filter(v => v && v.content_type === 'video/mp4' && typeof v.url === 'string')
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (mp4Variants.length === 0) {
          return { ok: false, reason: 'no_mp4_variant', hls_url: variants.find(v => v.content_type === 'application/x-mpegURL')?.url };
        }

        const pref = opts?.preferQuality || 'highest';
        const chosen = pref === 'highest' ? mp4Variants[0]
          : pref === 'lowest' ? mp4Variants[mp4Variants.length - 1]
          : mp4Variants[Math.floor(mp4Variants.length / 2)];

        // 4) 下载视频字节
        // v1.x: clearTimeout 之前在 await fetch() 后立刻 clear,意思 abort 只
        // 控制 header 阶段(几百 ms)。后续 arrayBuffer() 读 body 时 abort 已
        // 失活,大文件慢 CDN 时永远读不完(user 实测等 1500s+ 无 timeout)。
        // 修:clearTimeout 推迟到 arrayBuffer() 也完成之后,确保 5min 真覆盖
        // 整个 header + body 下载流程。
        const dlCtl = new AbortController();
        const dlTo = setTimeout(() => dlCtl.abort(), 5 * 60 * 1000); // 5 min total (header + body)
        let videoBuf: Buffer;
        try {
          const vResp = await fetch(chosen.url, {
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0 NoobClaw/1.0' },
            signal: dlCtl.signal,
          });
          if (!vResp.ok) {
            clearTimeout(dlTo);
            return { ok: false, reason: 'video_download_http_' + vResp.status };
          }
          const ab = await vResp.arrayBuffer();
          clearTimeout(dlTo);
          videoBuf = Buffer.from(ab);
        } catch (e: any) {
          clearTimeout(dlTo);
          return { ok: false, reason: 'video_download_failed:' + String(e?.message || e).slice(0, 80) };
        }

        // 5) 写本地 — 默认任务目录,subdir = '原文'
        const dir = opts?.outputDir || path.join(getTaskOutputDir(task, manifest.platform as any), '原文');
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        const videoFile = path.join(dir, `源视频_${statusId}.mp4`);
        fs.writeFileSync(videoFile, videoBuf);

        // 6) 顺手下封面图(poster) — 失败不阻塞
        let posterFile: string | null = null;
        const posterUrl = videoMedia.media_url_https || '';
        if (posterUrl) {
          try {
            const pResp = await fetch(posterUrl, { method: 'GET' });
            if (pResp.ok) {
              const pAb = await pResp.arrayBuffer();
              const ext = posterUrl.split('.').pop()?.split('?')[0]?.toLowerCase() || 'jpg';
              posterFile = path.join(dir, `源视频封面_${statusId}.${ext}`);
              fs.writeFileSync(posterFile, Buffer.from(pAb));
            }
          } catch { /* poster 失败不阻塞 */ }
        }

        const orig = videoMedia.original_info || {};
        coworkLog('INFO', 'phaseRunner', 'fetchTweetVideo ok', {
          statusId, size: videoBuf.length, bitrate: chosen.bitrate, file: videoFile,
        });
        return {
          ok: true,
          statusId,
          filePath: videoFile,
          posterPath: posterFile,
          videoUrl: chosen.url,                       // 原始 mp4 直链(给爆文库存)
          posterUrl: posterUrl || null,
          size: videoBuf.length,
          duration: videoMedia.video_info?.duration_millis || 0,
          width: orig.width || 0,
          height: orig.height || 0,
          bitrate: chosen.bitrate || 0,
          contentType: 'video/mp4',
        };
      } catch (err: any) {
        coworkLog('WARN', 'phaseRunner', 'fetchTweetVideo unexpected error', { err: String(err) });
        return { ok: false, reason: 'unexpected:' + String(err?.message || err).slice(0, 100) };
      }
    },

    // v4.25.6 Phase 2: 推特视频搬运 — 上传链路
    //
    // 把本地 mp4 文件通过 sidecar 临时 HTTP 端点喂给浏览器扩展,扩展 fetch
    // 拿到 blob 后构造 File 对象注入到 input[type=file]。整个流程不走
    // native messaging base64 IPC,大文件(几十 MB 视频)无压力。
    //
    // 内部用法:registerFile() → upload_file_from_url 命令 → unregister。
    // 上层应封装 publishVideoToBinance / publishVideoToTwitter 两个 helper
    // 包含完整的 modal 流程。
    uploadVideoFromDisk: async (
      filePath: string,
      opts: {
        targetSelector: string;       // file input CSS selector
        fileName?: string;
        mimeType?: string;
        ttlMs?: number;
      }
    ) => {
      try {
        const { registerFile, buildUrl, unregister } = require('../localFileServer');
        const fs = require('fs');
        if (!fs.existsSync(filePath)) {
          return { ok: false, reason: 'file_not_found' };
        }
        const fileName = opts.fileName || require('path').basename(filePath);
        const token = registerFile(filePath, {
          mimeType: opts.mimeType,
          fileName,
          ttlMs: opts.ttlMs || 5 * 60 * 1000,
        });
        // sidecar 端口 — 跟 sidecar-server.ts 里的 PORT 同步,默认 18800
        const port = parseInt(process.env.NOOBCLAW_SIDECAR_PORT || '18800', 10);
        const fileUrl = buildUrl(token, port);
        try {
          // v1.2.17 bug fix: 老代码把 getBridgeOpts() 当 timeoutMs 传(setTimeout
          // 拿到对象 → 立刻触发"timed out after [object Object]ms")。
          // 现在显式传 ttlMs(默认 5 min)做 timeout,getBridgeOpts() 走第 4 参 options。
          const uploadTimeout = opts.ttlMs || 5 * 60 * 1000;
          const r = await sendBrowserCommand('upload_file_from_url', {
            selector: opts.targetSelector,
            fileUrl,
            fileName,
            mimeType: opts.mimeType,
          }, uploadTimeout, getBridgeOpts());
          // 不 unregister(让 TTL 兜底),浏览器有时会重 fetch
          return r;
        } catch (err: any) {
          unregister(token); // 失败时立即清掉
          return { ok: false, reason: 'upload_command_failed:' + String(err?.message || err).slice(0, 100) };
        }
      } catch (err: any) {
        coworkLog('WARN', 'phaseRunner', 'uploadVideoFromDisk failed', { err: String(err) });
        return { ok: false, reason: 'unexpected:' + String(err?.message || err).slice(0, 100) };
      }
    },


    // v4.25.6 Phase 2: 完整发视频帖到币安广场 — 整合 modal 流程。
    // 跟图片帖完全不同:点视频图标 → 弹 quote-mode modal → 在 modal 内
    // upload + 写正文 → 发文。
    //
    // 用户实测 DOM:
    //   - 工具栏视频图标 SVG path d 头部 "M8.6 8.883" (用 :has 锁)
    //   - 弹出 modal class: .short-editor-inner.quote-mode
    //   - modal 内 file input: accept 含 mp4 的 input
    //   - modal 内 ProseMirror: 正文输入
    //   - 发文按钮: button 含 "发文" 文本,默认带 .inactive 类
    //
    // 限制(币安实测): 时长 ≤ 10 min, 大小 ≤ 200 MB,11 种格式
    //
    // 调用前提: 当前 active tab 已经在 binance.com/square 且 inline 编辑器可见
    publishVideoToBinance: async (videoFilePath: string, content: string, opts?: {
      uploadTimeoutMs?: number;       // 视频上传等待上限,默认 3 min
      publishRetries?: number;         // "发文"按钮 polling 重试,默认 6
    }) => {
      const log = (msg: string) => ctx.report('   ' + msg);
      const uploadTimeout = opts?.uploadTimeoutMs || 3 * 60 * 1000;
      const publishRetries = opts?.publishRetries || 6;

      try {
        // ── Step 1: 点工具栏视频图标 → 等 modal 出现 ──
        log('🎬 点视频图标 → 等弹出 modal...');
        const videoIconSel = '.icon-box:has(svg path[d^="M8.6 8.883"])';
        try {
          await sendBrowserCommand('main_world_click', { selector: videoIconSel }, getBridgeOpts());
        } catch (e: any) {
          return { ok: false, reason: 'video_icon_click_failed:' + String(e?.message || e).slice(0, 80) };
        }
        // 等 modal 出现 (最多 6 秒)
        const modalSel = '.short-editor-inner.quote-mode';
        let modalReady = false;
        for (let i = 0; i < 12; i++) {
          await new Promise(r => setTimeout(r, 500));
          try {
            const r = await sendBrowserCommand('query_selector', { selector: modalSel, limit: 1 }, getBridgeOpts());
            const els = (r && (r as any).elements) || ((r as any)?.data?.elements) || [];
            if (els.length > 0) { modalReady = true; break; }
          } catch { /* keep polling */ }
        }
        if (!modalReady) return { ok: false, reason: 'modal_not_appearing' };
        log('✓ modal 出现');

        // ── Step 2: 上传视频文件到 modal 内的 input ──
        const fileInputSel = '.short-editor-inner.quote-mode input[type="file"][accept*="mp4"]';
        log('📤 上传视频文件 ' + videoFilePath.split(/[/\\]/).pop());
        const upR: any = await (ctx.uploadVideoFromDisk as any)(videoFilePath, {
          targetSelector: fileInputSel,
          mimeType: 'video/mp4',
        });
        if (!upR || !upR.ok) {
          return { ok: false, reason: 'video_upload_failed:' + (upR?.reason || upR?.error || 'unknown') };
        }
        log('✓ 视频字节已注入 input,等币安处理...');

        // ── Step 3: polling 等"发文"按钮变 active(视频上传 + 转码完成的信号) ──
        const publishBtnSel = '.short-editor-inner.quote-mode button';
        let publishReady = false;
        const startWait = Date.now();
        let lastBtnTexts = '';
        while (Date.now() - startWait < uploadTimeout) {
          await new Promise(r => setTimeout(r, 1500));
          try {
            const r = await sendBrowserCommand('query_selector', {
              selector: publishBtnSel, limit: 5, attrs: 'class',
            }, getBridgeOpts());
            const els = (r && (r as any).elements) || ((r as any)?.data?.elements) || [];
            const btns = els as Array<{ text?: string; class?: string }>;
            lastBtnTexts = btns.map(b => `[${b.text || ''}|${(b.class || '').slice(0, 30)}]`).join(' ');
            // 找文本为"发文"且 class 不含 inactive 的
            const ready = btns.find(b => /^发文$/.test((b.text || '').trim()) && !/inactive/.test(b.class || ''));
            if (ready) { publishReady = true; break; }
          } catch { /* keep polling */ }
          // 心跳
          if ((Date.now() - startWait) % 30000 < 1500) {
            log('⏳ 等视频处理中... ' + Math.round((Date.now() - startWait) / 1000) + 's');
          }
        }
        if (!publishReady) {
          return { ok: false, reason: 'publish_btn_never_active', detail: '上传超时 / 视频处理失败 / 按钮文案变了 — 末次按钮: ' + lastBtnTexts.slice(0, 200) };
        }
        log('✓ 视频处理完成,发文按钮已激活');

        // ── Step 4: 写正文到 modal 内 ProseMirror ──
        const editorSel = '.short-editor-inner.quote-mode .ProseMirror[contenteditable="true"]';
        log('✏️ 写入正文(' + content.length + ' 字符)...');
        try {
          await sendBrowserCommand('main_world_click', { selector: editorSel }, getBridgeOpts());
          await new Promise(r => setTimeout(r, 400));
          const ir: any = await sendBrowserCommand('editor_insert_text', {
            selector: editorSel, text: content,
          }, getBridgeOpts());
          if (!ir || (!ir.ok && ir.error)) {
            return { ok: false, reason: 'editor_insert_failed:' + (ir?.error || 'unknown') };
          }
        } catch (e: any) {
          return { ok: false, reason: 'editor_failed:' + String(e?.message || e).slice(0, 80) };
        }

        // ── Step 5: 点"发文"按钮 ──
        // 用 click_with_text 在 modal 容器范围内精准匹配 "发文" 文本
        log('🚀 点击 [发文] ...');
        let published = false;
        for (let attempt = 0; attempt < publishRetries; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
          try {
            const r: any = await sendBrowserCommand('click_with_text', {
              containerSel: modalSel,
              acceptedTexts: ['发文', '发布', 'Post', 'Publish'],
              opts: { fuzzy: true, skipInactive: true, returnDebug: true },
            }, getBridgeOpts());
            if (r?.ok) { published = true; break; }
            if (r?.error && !/inactive/.test(r.error)) break;
          } catch { /* retry */ }
        }
        if (!published) {
          return { ok: false, reason: 'publish_click_failed' };
        }

        // ── Step 6: 等 modal 关闭(发文成功的信号) ──
        let modalClosed = false;
        const closeWait = Date.now();
        while (Date.now() - closeWait < 15000) {
          await new Promise(r => setTimeout(r, 800));
          try {
            const r = await sendBrowserCommand('query_selector', { selector: modalSel, limit: 1 }, getBridgeOpts());
            const els = (r && (r as any).elements) || ((r as any)?.data?.elements) || [];
            if (els.length === 0) { modalClosed = true; break; }
          } catch { /* keep polling */ }
        }
        if (!modalClosed) {
          // 假设成功 — modal 偶尔残留,日志里 warn
          coworkLog('WARN', 'phaseRunner', 'publishVideoToBinance: modal lingered after publish click');
        }
        return { ok: true, modalClosed };
      } catch (err: any) {
        return { ok: false, reason: 'unexpected:' + String(err?.message || err).slice(0, 100) };
      }
    },

    // v4.25.6 Phase 3: 直接 mp4 URL → 落本地任务目录。给 viral 库 pick
    // 路径用(库里存的就是 syndication 拿到的 mp4 直链,不需要再过一次
    // syndication API)。
    //
    // 跟 fetchTweetVideo 区别:那个吃 tweet URL,内部走 syndication;
    // 这个吃直接 mp4 URL,纯 fetch + 写盘。
    downloadVideoToDisk: async (
      videoUrl: string,
      opts?: { outputDir?: string; fileName?: string; posterUrl?: string }
    ) => {
      try {
        if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
          return { ok: false, reason: 'invalid_video_url' };
        }
        const dlCtl = new AbortController();
        const dlTo = setTimeout(() => dlCtl.abort(), 5 * 60 * 1000);
        let videoBuf: Buffer;
        try {
          const vResp = await fetch(videoUrl, {
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0 NoobClaw/1.0' },
            signal: dlCtl.signal,
          });
          clearTimeout(dlTo);
          if (!vResp.ok) return { ok: false, reason: 'video_http_' + vResp.status };
          const ab = await vResp.arrayBuffer();
          videoBuf = Buffer.from(ab);
        } catch (e: any) {
          clearTimeout(dlTo);
          return { ok: false, reason: 'video_fetch_failed:' + String(e?.message || e).slice(0, 80) };
        }
        const dir = opts?.outputDir || path.join(getTaskOutputDir(task, manifest.platform as any), '原文');
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        const baseName = opts?.fileName
          || ('viral_video_' + Date.now() + '.mp4');
        const filePath = path.join(dir, baseName);
        fs.writeFileSync(filePath, videoBuf);
        // 顺手下封面图(如有)
        let posterFile: string | null = null;
        if (opts?.posterUrl) {
          try {
            const pResp = await fetch(opts.posterUrl);
            if (pResp.ok) {
              const pAb = await pResp.arrayBuffer();
              const ext = (opts.posterUrl.split('.').pop() || 'jpg').split('?')[0].toLowerCase();
              posterFile = filePath.replace(/\.mp4$/, '_poster.' + ext);
              fs.writeFileSync(posterFile, Buffer.from(pAb));
            }
          } catch { /* poster 失败不阻塞 */ }
        }
        return { ok: true, filePath, posterPath: posterFile, size: videoBuf.length };
      } catch (err: any) {
        return { ok: false, reason: 'unexpected:' + String(err?.message || err).slice(0, 100) };
      }
    },

    // 视频下载「派生输出」:对刚下到本地的视频,按 opts 额外导出 无声视频 / 音轨(.m4a)。
    // 纯本地 ffmpeg、零成本,各自独立、单个失败不影响其它,返回 { mutePath?, audioPath?, errors[] }。
    // (字幕/语音转写是独立项,不在此能力内。)
    deriveVideoExtras: async (
      videoFilePath: string,
      opts?: { mute?: boolean; audio?: boolean },
    ) => {
      try {
        const { deriveVideoExtras } = require('../video/deriveExtras');
        return await deriveVideoExtras(videoFilePath, opts || {});
      } catch (err: any) {
        return { errors: ['deriveVideoExtras 调用失败: ' + String(err?.message || err).slice(0, 120)] };
      }
    },

    // v4.25.6 Phase 2: 推特 compose 视频上传 — 比币安简单,
    // [data-testid="fileInput"] 同时接图和视频(mp4 直接传)。
    //
    // 调用前提: 当前 active tab 已经在 x.com/compose/post 或 inline reply
    // 编辑器已展开,SEL_COMPOSE_TEXTAREA 已 focused/已写正文。
    //
    // 这个 helper 只管"上传视频字节 + 等转码完成",不管点提交按钮(交给
    // 调用方 — orchestrator 已经有自己的提交按钮 polling 逻辑)。
    uploadVideoToTwitter: async (videoFilePath: string, opts?: {
      processingWaitMs?: number;       // 等推特处理视频的时间,默认 60s
    }) => {
      const log = (msg: string) => ctx.report('   ' + msg);
      const waitMs = opts?.processingWaitMs || 60000;

      try {
        // Twitter compose 的 file input,既接图又接视频
        const fileInputSel = 'input[data-testid="fileInput"], input[type="file"][accept*="image"], input[type="file"]';
        log('📤 上传视频到推特 compose ...');
        const upR: any = await (ctx.uploadVideoFromDisk as any)(videoFilePath, {
          targetSelector: fileInputSel,
          mimeType: 'video/mp4',
        });
        if (!upR || !upR.ok) {
          return { ok: false, reason: 'video_upload_failed:' + (upR?.reason || upR?.error || 'unknown') };
        }

        // 等推特服务端转码 — 简单 wait,推特没有显眼的"处理完成"DOM 信号,
        // 比起在 DOM 里 polling 不如等一段固定时间(视频越大越久)。
        log('⏳ 等推特处理视频 ' + Math.round(waitMs / 1000) + 's...');
        await new Promise(r => setTimeout(r, waitMs));
        return { ok: true };
      } catch (err: any) {
        return { ok: false, reason: 'unexpected:' + String(err?.message || err).slice(0, 100) };
      }
    },

    // ── 视频二创基建(薄原语):把现有 ffmpeg / edge-tts 暴露给 orchestrator ──
    //   设计原则「能放 orchestrator 尽量放」:选品 / 翻译 / 滤镜串拼接 / 合成编排
    //   全在 orchestrator(读盘热更新),这里只给 3 个非原生干不了的薄入口。
    //   orchestrator 沙箱不能 require('path'),所以输出文件路径统一用 ctx.outPath 拼。
    runFfmpeg: async (args: string[], opts?: { timeoutMs?: number; cwd?: string }) => {
      try {
        const { runFfmpeg } = require('../video/ffmpegRuntime');
        const r = await runFfmpeg(Array.isArray(args) ? args : [], {
          timeoutMs: opts?.timeoutMs || 300000,
          cwd: opts?.cwd,
          onStderr: () => {},
        });
        return { ok: !!(r && r.ok), code: (r && r.code != null) ? r.code : null, stderr: ((r && r.stderr) || '').slice(-2000) };
      } catch (e: any) {
        return { ok: false, code: null, stderr: 'runFfmpeg_exception:' + String(e?.message || e).slice(0, 200) };
      }
    },
    tts: async (text: string, opts?: { voice?: string; rate?: number; fileName?: string; subdir?: string }) => {
      try {
        const ttsMod = require('../video/tts');
        const dir = path.join(getTaskOutputDir(task, manifest.platform as any), opts?.subdir || '制作');
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        const outFile = path.join(dir, opts?.fileName || ('tts_' + Date.now() + '.mp3'));
        const voice = opts?.voice || (ttsMod.getTtsVoice ? ttsMod.getTtsVoice() : undefined);
        const r = await ttsMod.synthesize(String(text || ''), outFile, voice, opts?.rate);
        return { ok: !!(r && r.ok), audioPath: (r && r.audioPath) || outFile, durationSec: (r && r.durationSec) || 0, synthesized: !!(r && r.synthesized), cues: (r && r.cues) || [] };
      } catch (e: any) {
        return { ok: false, reason: 'tts_exception:' + String(e?.message || e).slice(0, 200) };
      }
    },
    // 取任务输出目录下的绝对路径(orchestrator 拼 ffmpeg 输出 / 中间文件名用)。
    outPath: (name: string, subdir?: string) => {
      const dir = path.join(getTaskOutputDir(task, manifest.platform as any), subdir || '制作');
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      return path.join(dir, name || ('out_' + Date.now()));
    },
    // 写文本文件到绝对路径(orchestrator 生成 .srt / .txt 喂 ffmpeg 用)。路径建议用 ctx.outPath 取。
    writeFile: (absPath: string, content: string) => {
      try {
        try { fs.mkdirSync(path.dirname(absPath), { recursive: true }); } catch {}
        fs.writeFileSync(absPath, String(content == null ? '' : content), 'utf8');
        return { ok: true, path: absPath };
      } catch (e: any) {
        return { ok: false, reason: 'writeFile_failed:' + String(e?.message || e).slice(0, 150) };
      }
    },
    // 发文成功后调,服务端把当前钱包追加到 viral_library.used_by_wallets,
    // 下次同钱包不会再选中这篇。
    markViralUsed: async (viralId: string) => {
      const authToken = getNoobClawAuthToken();
      if (!authToken) return { ok: false, reason: 'no_auth_token' };
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      try {
        const baseUrl = 'https://api.noobclaw.com';
        const resp = await fetch(baseUrl + '/api/viral/library/mark-used', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({ viral_id: viralId }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!resp.ok) return { ok: false, reason: 'http_' + resp.status };
        return await resp.json().catch(() => ({ ok: true }));
      } catch (err: any) {
        clearTimeout(timeoutId);
        const msg = err?.name === 'AbortError' ? 'timeout_10s' : String(err).slice(0, 200);
        coworkLog('WARN', 'phaseRunner', 'markViralUsed failed', { err: msg });
        return { ok: false, reason: msg };
      }
    },

    saveDrafts: async (rawDrafts: any[]) => {
      const drafts: Draft[] = rawDrafts.map(d => ({
        id: crypto.randomUUID(),
        task_id: task.id,
        source_post: d.source_post,
        extraction: d.extraction,
        variant: d.variant,
        status: 'pending' as const,
        created_at: Date.now(),
        // preserve images field so artifactWriter can save them as PNG files
        ...(d.images ? { images: d.images } : {}),
      } as Draft & { images?: any[] }));
      taskStore.addDrafts(drafts);
      allDrafts.push(...drafts);
      try {
        const platform = (manifest as any).platform || 'xhs';
        const result = await writeTaskArtifacts(task, drafts, platform);
        return { dir: result.dir, files: result.files };
      } catch (err) {
        coworkLog('WARN', 'phaseRunner', 'artifact save failed', { err: String(err) });
        return { dir: '', files: [] };
      }
    },

    // ── Utilities ──
    parseLikes,
    keywordMatch,
    randInt,

    // ── Internal: access to accumulated drafts ──
    _getAllDrafts: () => allDrafts,

    // ── Action-count reporting ────────────────────────────────────────
    // Orchestrator hook: call once per successful primary action to bump
    // the per-type counter that surfaces on the task detail page as
    // "累计完成" + "上次完成". `n` defaults to 1 for the common
    // "did one like / one follow" case.
    //
    // Also mirrors the bump into the live RunProgress (via
    // progress.bumpActionProgress) so the running-glow "本次运行进度"
    // card on TaskDetailPage ticks up in real time without any extra
    // wiring from the orchestrator. Pairs with ctx.setActionTargets,
    // which the orchestrator should call once near the start of a run
    // after it has picked the daily caps.
    addActionCount: (type: string, n: number = 1) => {
      if (!type || typeof type !== 'string') return;
      const k = type.trim();
      if (!k) return;
      const delta = Number(n) || 0;
      actionCounts[k] = (actionCounts[k] || 0) + delta;
      if (typeof progress.bumpActionProgress === 'function') {
        try { progress.bumpActionProgress(k, delta); } catch { /* non-fatal */ }
      }
    },
    /** Declare per-type planned targets at the start of a run. Pass an
     *  object of { type: target } pairs; subsequent ctx.addActionCount
     *  calls show up as "X/target" on the running progress card. Re-calling
     *  with a new value updates the displayed target (last write wins). */
    setActionTargets: (targets: Record<string, number>) => {
      if (!targets || typeof targets !== 'object') return;
      for (const [k, v] of Object.entries(targets)) {
        if (!k || typeof k !== 'string') continue;
        if (typeof progress.setActionTarget === 'function') {
          try { progress.setActionTarget(k.trim(), Number(v) || 0); } catch { /* non-fatal */ }
        }
      }
    },
    // Internal accessor used by runOrchestrator to fold counts into the
    // final RunResult so they get persisted on the run record.
    _getActionCounts: () => ({ ...actionCounts }),

    // ── v6.x task-end cleanup state (PR9 — Phase 2-C) ──────────────────
    // Populated by openTab / registerChildExpectation when they take the
    // v6 sub_platform path. runOrchestrator's finally calls
    // ctx._releaseAllWindows() which iterates these and tells the ext to
    // (a) close any tabs whose role is in manifest.transient_roles, and
    // (b) revert each claimed windowKey's tab group title to idle form.
    // _claimedWindows: windowKey → { idleGroupTitle }
    // _scopedTabsByRole: role → ScopedTab (most recent open for that role)
    // _childRoleSubPlatform: role → { sub_platform, account } captured at
    //   registerChildExpectation time so waitChildTab can stamp the
    //   resulting ScopedTab with the right windowKey.

    // ── v5.27+ task-tab API (Phase D — explicit per-task tabId routing) ──
    //
    // 老架构问题:一个平台一个 NoobClaw managed group,同平台多 tab(XHS
    // creator + explore)在同一 group 里 → findOrOpenTabByPattern 用 tabs[0]
    // 拿 group 第一个 tab,多 tab 时返回顺序不定 → 路由歧义。
    //
    // 新架构(扩展 v1.5.3+):
    //   - ctx.openTab() 显式开 owned window + tab + per-task group,返回 ScopedTab
    //   - ScopedTab.* 自动给所有命令塞 tabId → 扩展按 tabId 直接 chrome.tabs.get
    //     绕过 group lookup,不再有 group ambiguity
    //   - ctx.registerChildExpectation() + ctx.waitChildTab() 配合用 — 显式等
    //     XHS handler 触发的 window.open child tab,扩展 chrome.tabs.onCreated
    //     listener 监听到 + 自动 detach 到新窗口 + 注册到 task registry
    //
    // 兼容性: orchestrator 必须先 `typeof ctx.openTab === 'function'` 探测,
    // 没有就用老 setActiveTab/tabPattern 路径(fallback)。
    taskId: task.id,
    openTab: async (opts: {
      // v6.x (preferred, requires ext v1.6.0+):
      //   sub_platform encodes (platform, domain_tier) — see subPlatformRegistry
      //   account_id defaults to 'default' until multi-account work lands
      sub_platform?: string;
      account_id?: string;
      // v1.5.3 legacy:
      //   platform — short code (xhs/binance/x/youtube/tiktok/douyin)
      //   windowed — 'owned' (default) opens new physical window;
      //              'reuse' opens tab in active focused window
      platform?: string;
      windowed?: 'owned' | 'reuse';
      // Common:
      role: string;
      url: string;
    }) => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      if (!opts || !opts.role || !opts.url) {
        throw new Error('openTab requires { role, url }');
      }

      // v1.6.x (PR15): if scenario didn't pass sub_platform explicitly,
      // derive it from the URL's hostname. Window uniqueness in v6.x is
      // (sub_platform, account_id) where sub_platform IS the domain-tier
      // identity — so the URL the scenario wants to open already
      // determines which window owns it. No role-based guessing.
      //
      //   url=https://www.xiaohongshu.com/...     → xhs_main
      //   url=https://creator.xiaohongshu.com/... → xhs_creator
      //   url=https://creator.douyin.com/...      → douyin_creator
      //   url=https://www.douyin.com/...          → douyin_main
      //   url=https://www.binance.com/square      → binance_square
      //   etc.
      //
      // Scenarios that pre-compute sub_platform (e.g. PR9's
      // xhs_reply_fans_comment) short-circuit this — the explicit value
      // always wins.
      if (!opts.sub_platform) {
        const inferred = urlToSubPlatform(opts.url);
        if (inferred) {
          opts = { ...opts, sub_platform: inferred };
        }
      }

      // v6 path: client computes opaque windowKey + groupTitle, ext routes
      // by Map<windowKey, ...>. Window persists across tasks targeting the
      // same sub_platform + account.
      //
      // Capability gate (PR10): only take the v6 path when the connected
      // ext advertises 'window_registry_v6' (v1.6.0+ ships this capability
      // in its hello). Pre-v1.6 ext would silently treat windowKey as an
      // unknown field and fall through to its legacy adopt-first logic,
      // which works but defeats the persistent-window benefit AND skips
      // the title-revert step at task end. Better to detect + downgrade
      // explicitly so we (a) still send `platform` to drive the legacy
      // schema and (b) don't track for cleanup we can't honor.
      if (opts.sub_platform && connectionHasCapability(undefined, 'window_registry_v6')) {
        const account = opts.account_id || 'default';
        const windowKey = `${opts.sub_platform}::${account}`;
        const activeTitle = buildGroupTitle(opts.sub_platform, account, task.id);
        const idleTitle = buildGroupTitle(opts.sub_platform, account, null);
        // Pass the same deterministic bounds the pre-run check uses, so a
        // task-created window is identical in size/position to a pre-run
        // window for the same sub_platform. Without this, task-fresh
        // windows fell back to ext cascadeBounds() and came out a
        // different size ("some big, some small"). Ext only applies bounds
        // when it actually creates a new window — reuse leaves the
        // existing window's size untouched.
        const bounds = getStandardBounds(opts.sub_platform, account);
        const res: any = await sendBrowserCommand(
          'task_open_tab',
          {
            windowKey,
            groupTitle: activeTitle,
            role: opts.role,
            url: opts.url,
            taskId: task.id,
            bounds,
          },
          15000,
          getBridgeOpts(),
        );
        if (!res || res.ok === false) {
          throw new Error('openTab failed: ' + ((res && res.error) || 'unknown'));
        }
        // Track for task-end cleanup. Idle title used to revert group label
        // after this task releases the window. scopedTabsByRole used to
        // close transient_roles tabs declared in the manifest.
        _claimedWindows.set(windowKey, { idleGroupTitle: idleTitle });
        const scopedTab = createScopedTab(
          res.tabId, res.windowId, task.id, opts.sub_platform, opts.role,
          { sendBrowserCommand, progress, getBridgeOpts, randInt }, windowKey,
        );
        _rememberScopedTab(opts.role, scopedTab);
        return scopedTab;
      }

      // Legacy v1.5.3 path: per-task window per (taskId, role).
      // Reached either because the scenario passed only `platform`, OR
      // because it passed `sub_platform` but the connected ext is too
      // old to honor it. In the latter case derive a `platform` short-
      // code from sub_platform (split on '_', take prefix) so the legacy
      // ext schema still gets a sensible value.
      let legacyPlatform = opts.platform;
      if (!legacyPlatform && opts.sub_platform) {
        legacyPlatform = opts.sub_platform.split('_')[0];
        coworkLog('INFO', 'phaseRunner',
          `[openTab] ext lacks window_registry_v6, falling back to legacy schema (sub_platform=${opts.sub_platform} → platform=${legacyPlatform})`);
      }
      if (!legacyPlatform) {
        throw new Error('openTab requires either sub_platform or platform');
      }
      const res: any = await sendBrowserCommand(
        'task_open_tab',
        {
          taskId: task.id,
          platform: legacyPlatform,
          role: opts.role,
          url: opts.url,
          windowed: opts.windowed || 'owned',
        },
        15000,
        getBridgeOpts(),
      );
      if (!res || res.ok === false) {
        throw new Error('openTab failed: ' + ((res && res.error) || 'unknown'));
      }
      const scopedTab = createScopedTab(
        res.tabId, res.windowId, task.id, legacyPlatform, opts.role,
        { sendBrowserCommand, progress, getBridgeOpts, randInt },
      );
      _rememberScopedTab(opts.role, scopedTab);
      return scopedTab;
    },
    registerChildExpectation: async (opts: {
      parentTab: { id: number };
      role: string;
      urlPattern: string;
      // v6.x (requires ext v1.6.1+): route spawned tab into the
      // windowRegistry window for {childSubPlatform, childAccountId}.
      // When omitted, ext takes the v1.5.3 detach-to-new-window path.
      childSubPlatform?: string;
      childAccountId?: string;
    }) => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      if (!opts || !opts.parentTab || !opts.parentTab.id || !opts.role || !opts.urlPattern) {
        throw new Error('registerChildExpectation requires { parentTab:{id}, role, urlPattern }');
      }
      const payload: any = {
        taskId: task.id,
        parentTabId: opts.parentTab.id,
        role: opts.role,
        urlPattern: opts.urlPattern,
      };
      // v6 cross-window child routing gated on the matching ext capability
      // (PR8 / ext v1.6.1+ ships 'cross_window_child_routing'). Old ext
      // would silently drop the extra fields and take the legacy
      // "detach into new ad-hoc window" path — functional but defeats
      // the "explore tab lives in xhs_main's window" routing the
      // scenario asked for. Detect + downgrade so the next bullet (track
      // for cleanup) doesn't track a windowKey the ext won't own.
      if (opts.childSubPlatform && connectionHasCapability(undefined, 'cross_window_child_routing')) {
        const account = opts.childAccountId || 'default';
        const childWindowKey = `${opts.childSubPlatform}::${account}`;
        payload.childWindowKey = childWindowKey;
        payload.childGroupTitle = buildGroupTitle(opts.childSubPlatform, account, task.id);
        // Track for cleanup — child's windowKey may be a brand-new one
        // (e.g. first time scenario opens explore tab on xhs_main).
        _claimedWindows.set(childWindowKey, {
          idleGroupTitle: buildGroupTitle(opts.childSubPlatform, account, null),
        });
        // Remember sub_platform per-role so waitChildTab can stamp the
        // resulting ScopedTab with the right windowKey.
        _childRoleSubPlatform.set(opts.role, { sub_platform: opts.childSubPlatform, account });
      }
      const res: any = await sendBrowserCommand(
        'task_register_child_expect',
        payload,
        5000,
        getBridgeOpts(),
      );
      if (!res || res.ok === false) {
        throw new Error('registerChildExpectation failed: ' + ((res && res.error) || 'unknown'));
      }
    },
    waitChildTab: async (opts: { role: string; platform?: string; timeout?: number }) => {
      if (progress.isAbortRequested()) throw new Error('user_stopped');
      if (!opts || !opts.role) throw new Error('waitChildTab requires { role }');
      const timeout = opts.timeout || 12000;
      const res: any = await sendBrowserCommand(
        'task_wait_child_tab',
        { taskId: task.id, role: opts.role, timeout },
        timeout + 2000,
        getBridgeOpts(),
      );
      if (!res || res.ok === false) {
        return null; // timeout — orchestrator 自决重试 / 跳过 / 报错
      }
      // If registerChildExpectation was called with childSubPlatform, the
      // resulting ScopedTab carries the same windowKey for downstream
      // cleanup logic.
      const childMeta = _childRoleSubPlatform.get(opts.role);
      const windowKey = childMeta
        ? `${childMeta.sub_platform}::${childMeta.account}`
        : undefined;
      const scopedTab = createScopedTab(
        res.tabId, res.windowId, task.id, opts.platform || '', opts.role,
        { sendBrowserCommand, progress, getBridgeOpts, randInt }, windowKey,
      );
      _rememberScopedTab(opts.role, scopedTab);
      return scopedTab;
    },
    /** 已知 tabId 时直接构造一个 ScopedTab handle(不调扩展)。 */
    scopedTab: (tabId: number, windowId?: number, platform?: string, role?: string) => {
      return createScopedTab(tabId, windowId || -1, task.id, platform || '', role || '',
        { sendBrowserCommand, progress, getBridgeOpts, randInt });
    },
    /** 查 task 已注册的某 role 的 tab(extension 端 task_get_tab) */
    getTaskTab: async (role: string) => {
      const res: any = await sendBrowserCommand('task_get_tab', { taskId: task.id, role }, 3000, getBridgeOpts());
      if (!res || res.ok === false) return null;
      return createScopedTab(res.tabId, res.windowId, task.id, '', role,
        { sendBrowserCommand, progress, getBridgeOpts, randInt });
    },
    /** opt-in 收尾:关掉本 task 所有 tab。orchestrator 通常不调,留 tab 给用户查看 */
    closeAllTaskTabs: async () => {
      try { await sendBrowserCommand('task_close_all', { taskId: task.id }, 5000, getBridgeOpts()); } catch (_) {}
    },
    /**
     * Internal task-end cleanup (called by runOrchestrator's finally, NOT
     * by orchestrator code). Does two things:
     *
     *   1. Close every tab whose role is listed in manifest.transient_roles.
     *      These are "throwaway" tabs the scenario opens for a sub-task
     *      (e.g. xhs_reply_fans_comment's explore tab) — they get destroyed
     *      so the user doesn't have to clean up after each task end.
     *      Long-lived roles (creator, home, etc) survive for reuse.
     *
     *   2. Send task_window_release to ext for every windowKey we claimed.
     *      This reverts the Chrome tab group title from active form
     *      (with task short-id) back to idle form — the window itself
     *      persists for the next task targeting the same sub_platform.
     *
     * Idempotent and best-effort: orchestrator may have already closed
     * tabs manually; ext may have lost a windowKey if user closed window.
     * Both paths swallow errors.
     */
    _releaseAllWindows: async () => {
      const transientRoles = pack.manifest?.transient_roles ?? [];
      for (const role of transientRoles) {
        const st = _scopedTabsByRole.get(role);
        if (!st) continue;
        try { await st.close(); }
        catch (e) {
          coworkLog('WARN', 'phaseRunner',
            `transient close for role=${role} failed: ${String((e as any)?.message || e).slice(0, 80)}`);
        }
      }
      for (const [windowKey, info] of _claimedWindows) {
        try {
          await sendBrowserCommand(
            'task_window_release',
            { windowKey, idleGroupTitle: info.idleGroupTitle },
            3000,
            getBridgeOpts(),
          );
        } catch (e) {
          coworkLog('WARN', 'phaseRunner',
            `task_window_release for ${windowKey} failed: ${String((e as any)?.message || e).slice(0, 80)}`);
        }
      }
      _claimedWindows.clear();
      _scopedTabsByRole.clear();
      _childRoleSubPlatform.clear();
    },
  };

  return ctx;
}

// ── ScopedTab — handle绑定到一个 tabId,所有方法自动塞 tabId ──
//
// 为啥 factory 不 class:phaseRunner 给 orchestrator 暴露的 ctx 是普通对象
// (orchestrator 用 new AsyncFunction 执行,看不到 class 原型链)。返回普通
// object 最稳。
type ScopedTabDeps = {
  sendBrowserCommand: typeof sendBrowserCommand;
  progress: ProgressFns;
  getBridgeOpts: () => any;
  randInt: (a: number, b: number) => number;
};

function createScopedTab(
  tabId: number,
  windowId: number,
  taskId: string,
  platform: string,
  role: string,
  deps: ScopedTabDeps,
  // v6.x: opaque key the ext routes by (e.g. "xhs_creator::default").
  // Stamped on the ScopedTab so downstream cleanup logic can correlate
  // tab → windowKey without re-deriving from platform/account. Undefined
  // for tabs created via the legacy v1.5.3 schema (no v6 routing).
  windowKey?: string,
) {
  const browser = async (command: string, params: any = {}, timeout?: number): Promise<any> => {
    if (deps.progress.isAbortRequested()) throw new Error('user_stopped');
    const t = timeout || 10000;
    // 注意:scoped 走 tabId 路径,不调 ensureTabExistsForPattern。
    // 扩展按 params.tabId 直接 chrome.tabs.get,绕过所有 group lookup。
    return Promise.race([
      deps.sendBrowserCommand(command, { ...params, tabId }, t, deps.getBridgeOpts()),
      new Promise<never>((_, reject) => {
        const check = setInterval(() => {
          if (deps.progress.isAbortRequested()) {
            clearInterval(check);
            reject(new Error('user_stopped'));
          }
        }, 300);
        setTimeout(() => {
          clearInterval(check);
          reject(new Error('scopedTab.browser "' + command + '" hard-timeout after ' + (t + 2000) + 'ms'));
        }, t + 2000);
      }),
    ]);
  };

  const getUrl = async (): Promise<string> => {
    try {
      const res: any = await browser('get_url', {});
      return (res && res.url) || (res && res.data && res.data.url) || '';
    } catch (_) { return ''; }
  };

  // v6.x: per-tab uploadVideoFromDisk — top-level ctx.uploadVideoFromDisk 走
  //   sendBrowserCommand 不塞 tabId,扩展 resolveTab 按 platform-level group
  //   title 找 tab,跟 per-task tab 的 task-specific group title 不匹配 → 走
  //   fallback 开新窗口 → 视频上传到错的 tab。给 ScopedTab 加这个方法,内部
  //   localFileServer 注册 → upload_file_from_url 自动塞自己的 tabId → 命中
  //   per-task tab(modal 所在的那个)。orchestrator 用 _activeTab.uploadVideoFromDisk
  //   而非 ctx.uploadVideoFromDisk 就规避了 bug。
  const uploadVideoFromDisk = async (
    filePath: string,
    opts: { targetSelector: string; fileName?: string; mimeType?: string; ttlMs?: number },
  ): Promise<any> => {
    if (deps.progress.isAbortRequested()) throw new Error('user_stopped');
    try {
      const { registerFile, buildUrl, unregister } = require('../localFileServer');
      const fs = require('fs');
      if (!fs.existsSync(filePath)) {
        return { ok: false, reason: 'file_not_found' };
      }
      const fileName = opts.fileName || require('path').basename(filePath);
      const ttl = opts.ttlMs || 5 * 60 * 1000;
      const token = registerFile(filePath, { mimeType: opts.mimeType, fileName, ttlMs: ttl });
      const port = parseInt(process.env.NOOBCLAW_SIDECAR_PORT || '18800', 10);
      const fileUrl = buildUrl(token, port);
      try {
        const r = await deps.sendBrowserCommand('upload_file_from_url', {
          selector: opts.targetSelector,
          fileUrl,
          fileName,
          mimeType: opts.mimeType,
          tabId, // 关键 — 扩展按 tabId 直接 chrome.tabs.get,绕开 platform group lookup
        }, ttl, deps.getBridgeOpts());
        return r;
      } catch (err: any) {
        unregister(token);
        return { ok: false, reason: 'upload_command_failed:' + String(err?.message || err).slice(0, 100) };
      }
    } catch (err: any) {
      return { ok: false, reason: 'unexpected:' + String(err?.message || err).slice(0, 100) };
    }
  };

  return {
    id: tabId,
    windowId,
    taskId,
    platform,
    role,
    windowKey,
    browser,
    navigate: (url: string) => browser('navigate', { url }, 30000),
    // scopedTab.scroll — 对齐顶层 ctx.scroll(line 676 同款理由):scroll 走 content-script
    // 慢路径,3s 在 SW 冷启动 / 注入重试时撞穿。提到 10s。所有 _activeTab.scroll() 都吃
    // 这个默认值,小红书点赞 / xhs_viral_production_career / xhs_reply_fans_comment 等
    // 全部 scenario 受益。
    scroll: (amount?: number) =>
      browser('scroll', { direction: 'down', amount: amount || deps.randInt(2, 4) }, 10000),
    cdpClick: (x: number, y: number) => browser('cdp_click', { x, y }),
    cdpKey: (key: string, params?: any) => browser('cdp_key', { key, ...(params || {}) }),
    cdpEval: (expression: string, awaitPromise?: boolean) =>
      browser('cdp_eval', { expression, awaitPromise: awaitPromise !== false }),
    cdpScreenshot: () => browser('cdp_screenshot', {}),
    queryMany: (selector: string, limit?: number, attrs?: string) => {
      const p: any = { selector, limit: limit || 50 };
      if (attrs) p.attrs = attrs;
      return browser('query_selector', p);
    },
    find: (query: string) => browser('find', { query }),
    mainWorldClick: (selector: string, opts?: any) =>
      browser('main_world_click', { selector, ...(opts || {}) }),
    click: (x: number, y: number) => browser('click', { x, y }),
    editorPasteText: (selector: string, text: string) =>
      browser('editor_paste_text', { selector, text }),
    editorInsertText: (selector: string, text: string) =>
      browser('editor_insert_text', { selector, text }),
    type: (selector: string, text: string) => browser('type', { selector, text }),
    runScript: (code: string) => browser('javascript', { code }),
    getUrl,
    getPageText: () => browser('get_page_text', {}),
    getHtml: () => browser('get_html', {}),
    close: () => browser('tab_close', {}),
    reload: () => browser('reload', {}),
    uploadVideoFromDisk,
  };
}

// ── Main entry ──

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export async function runOrchestrator(
  pack: ScenarioPack,
  task: ScenarioTask,
  seenPostIds: Set<string>,
  progress: ProgressFns,
  options?: { scriptOverride?: string; targetDraft?: any; appLocale?: string },
): Promise<RunResult> {
  const orchestratorCode = options?.scriptOverride || pack.orchestrator;
  if (!orchestratorCode) {
    return { status: 'failed', reason: 'no_orchestrator_in_pack' };
  }

  const ctx = buildContext(pack, task, seenPostIds, progress, options?.appLocale);
  // Inject target draft for the upload_draft.js path
  if (options?.targetDraft) {
    (ctx as any)._targetDraft = options.targetDraft;
  }

  // v2.8+: dedup + 跨平台拆窗口 完全交给 chrome-extension 1.4.22+ 自治。
  // ext 在 _windowMutex 内串行处理 — 比 client 这边更靠谱(无 IPC 延迟、
  // 不可能跟 ext 自己 race)。这里之前的 closeDuplicatePlatformTabs +
  // ensurePlatformsInSeparateWindows 调用都删了,任务启动直接进 orchestrator。

  // v6.x: best-effort task-end cleanup. Closes manifest.transient_roles
  // tabs and sends task_window_release for every windowKey the run claimed
  // so Chrome tab group titles revert from active form ("🤖 abc1 XHS·创作")
  // to idle form ("🤖 XHS·创作"). Runs whether orchestrator succeeded or
  // threw. Errors swallowed inside _releaseAllWindows — never let cleanup
  // mask a real orchestrator failure.
  const _doCleanup = async () => {
    try {
      const release = (ctx as any)._releaseAllWindows;
      if (typeof release === 'function') await release();
    } catch (e) {
      coworkLog('WARN', 'phaseRunner', 'cleanup threw', { err: String(e).slice(0, 120) });
    }
  };

  try {
    const fn = new AsyncFunction('ctx', orchestratorCode);
    const result = await fn(ctx);
    // Always pull whatever the orchestrator booked via ctx.addActionCount —
    // it survives whether the orchestrator returned a structured result or
    // just exited after ctx.finish(). Empty object means "this scenario
    // doesn't track action counts" (older scenarios pre-rollout); the UI
    // shows '-' in that case.
    const actionCounts = ctx._getActionCounts() as Record<string, number>;
    // If orchestrator returned a result, use it (merging in action_counts
    // unless the orchestrator already supplied them — orchestrator wins).
    if (result && typeof result === 'object' && result.status) {
      const r = result as RunResult;
      if (!r.action_counts && Object.keys(actionCounts).length > 0) {
        r.action_counts = actionCounts;
      }
      return r;
    }
    // Otherwise construct from state
    const drafts = ctx._getAllDrafts();
    return {
      status: 'ok',
      collected_count: 0,
      draft_count: drafts.length,
      action_counts: Object.keys(actionCounts).length > 0 ? actionCounts : undefined,
    };
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    coworkLog('ERROR', 'phaseRunner', 'orchestrator threw', { err: msg });
    // v5.x+: pull whatever the orchestrator already booked via ctx.addActionCount
    // BEFORE rethrowing. Without this, a follow run that succeeded on 3/5
    // items then died on item 4 (navigate timeout, abort, browser crash)
    // would lose all 3 follows from the run record — the success path above
    // does this merge, but the catch path used to skip it, so users saw
    // "上次完成 0" even though the platform really got 3 follows.
    // scenarioManager has a separate rescue via progressByTaskId.action_progress,
    // but that's not guaranteed populated (bumpActionProgress may have raced or
    // never run for some action types). Belt-and-suspenders: surface counts here.
    const actionCounts = ctx._getActionCounts() as Record<string, number>;
    const failResult: RunResult = msg.includes('user_stopped')
      ? { status: 'failed', reason: 'user_stopped' }
      : { status: 'failed', reason: msg };
    if (Object.keys(actionCounts).length > 0) {
      failResult.action_counts = actionCounts;
    }
    return failResult;
  } finally {
    // v6.x window cleanup runs on EVERY return / throw path.
    await _doCleanup();
  }
}
