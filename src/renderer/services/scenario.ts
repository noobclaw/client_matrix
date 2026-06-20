/**
 * Scenario service — thin renderer-side wrapper around window.electron.scenario.
 *
 * All scenario logic (discovery, extraction, composition, risk guard, draft
 * upload) lives in the main process. This file only exposes convenient
 * async methods so React components don't have to reach into window.electron
 * directly.
 */

import type {
  ScenarioManifestIPC,
  ScenarioTaskIPC,
  ScenarioDraftIPC,
  ScenarioRunOutcome,
  ScenarioPlatform,
  ScenarioWorkflowType,
  ScenarioTaskRun,
  ScenarioRunProgress,
  XhsLoginStatus,
} from '../types/scenario';

export type Scenario = ScenarioManifestIPC;
export type Task = ScenarioTaskIPC;
export type Draft = ScenarioDraftIPC;
export type RunOutcome = ScenarioRunOutcome;

class ScenarioService {
  // ── Catalogue ──

  async listScenarios(): Promise<Scenario[]> {
    try {
      const res = await window.electron.scenario.listScenarios();
      return res?.scenarios || [];
    } catch {
      return [];
    }
  }

  /** Filter scenarios by platform and workflow type. */
  async listScenariosFor(platform: ScenarioPlatform, workflow?: ScenarioWorkflowType): Promise<Scenario[]> {
    const all = await this.listScenarios();
    return all.filter(
      s => s.platform === platform && (!workflow || s.workflow_type === workflow)
    );
  }

  // ── Tasks ──

  async listTasks(): Promise<Task[]> {
    try {
      const r = await window.electron.scenario.listTasks();
      return Array.isArray(r) ? r : [];
    } catch {
      return [];
    }
  }

  async listTasksFor(platform: ScenarioPlatform): Promise<Task[]> {
    const [tasks, scenarios] = await Promise.all([this.listTasks(), this.listScenarios()]);
    const scenarioById = new Map(scenarios.map(s => [s.id, s]));
    return tasks.filter(t => scenarioById.get(t.scenario_id)?.platform === platform);
  }

  getTask(id: string): Promise<Task | null> {
    return window.electron.scenario.getTask(id);
  }

  createTask(input: Omit<Task, 'id' | 'created_at' | 'updated_at'>): Promise<Task> {
    return window.electron.scenario.createTask(input);
  }

  updateTask(id: string, patch: Partial<Task>): Promise<Task | null> {
    return window.electron.scenario.updateTask(id, patch);
  }

  deleteTask(id: string): Promise<boolean> {
    return window.electron.scenario.deleteTask(id);
  }

  runTaskNow(id: string): Promise<RunOutcome> {
    return window.electron.scenario.runTaskNow(id);
  }

  /** Upload a single already-generated draft. Used by TaskDetailPage
   *  per-draft 📤 button when auto_upload was false. */
  uploadDraft(taskId: string, draftId: string): Promise<{ status: string; reason?: string }> {
    return (window.electron.scenario as any).uploadDraft(taskId, draftId);
  }

  runStatus(id: string): Promise<{ runs: ScenarioTaskRun[]; cooldown_ends_at: number }> {
    return window.electron.scenario.runStatus(id);
  }

  // ── Drafts ──

  async listDrafts(taskId?: string): Promise<Draft[]> {
    try {
      const r = await window.electron.scenario.listDrafts(taskId);
      return Array.isArray(r) ? r : [];
    } catch {
      return [];
    }
  }

  pushDraft(draftId: string): Promise<{ status: 'ready_for_user' | 'failed'; error?: string }> {
    return window.electron.scenario.pushDraft(draftId);
  }

  deleteDraft(draftId: string): Promise<boolean> {
    return window.electron.scenario.deleteDraft(draftId);
  }

  markDraftIgnored(draftId: string): Promise<Draft | null> {
    return window.electron.scenario.markDraftIgnored(draftId);
  }

  // ── Active task management ──

  setActiveTask(id: string): Promise<Task | null> {
    return window.electron.scenario.setActiveTask(id);
  }

  getActiveTask(): Promise<Task | null> {
    return window.electron.scenario.getActiveTask();
  }

  // ── Running state ──

  async getRunningTaskId(): Promise<string | null> {
    try {
      const r = await window.electron.scenario.getRunningTaskId();
      return r?.runningTaskId || null;
    } catch {
      return null;
    }
  }

  /** Multi-tab concurrency (Twitter v1): returns ALL running task ids —
   *  can be > 1 when XHS task + Twitter task are both in flight. */
  async getRunningTaskIds(): Promise<string[]> {
    try {
      const r = await window.electron.scenario.getRunningTaskIds();
      return Array.isArray(r?.runningTaskIds) ? r.runningTaskIds : [];
    } catch {
      return [];
    }
  }

  /** Connected browser extensions, with their reported versions + when
   *  the bridge accepted the connection. Used to detect outdated
   *  extensions: an extension that pre-dates the version-reporting
   *  protocol (< 1.2.0) shows up with version === '' AND has been
   *  connected for > 5s without sending hello (older versions don't
   *  send it at all). */
  async getConnectedExtensions(): Promise<Array<{ id: string; version: string; tabCount: number; connectedAt: number }>> {
    try {
      const r = await window.electron.scenario.getConnectedExtensions();
      return Array.isArray(r?.extensions) ? r.extensions : [];
    } catch {
      return [];
    }
  }

  /** All recorded runs across every task, newest-first. Used by the
   *  Run History page. */
  async getAllRuns(): Promise<Array<{
    task_id: string;
    started_at: number;
    finished_at?: number;
    status: 'success' | 'failure' | 'skipped' | 'running';
    reason?: string;
    collected_count?: number;
    draft_count?: number;
  }>> {
    try {
      const r = await window.electron.scenario.getAllRuns();
      return Array.isArray(r?.runs) ? r.runs : [];
    } catch {
      return [];
    }
  }

  /** Rich run records (v2.4.22+) — full task snapshot + step logs +
   *  output dir. Replaces getAllRuns for the Run History UI. */
  async listRunRecords(filter?: { task_id?: string; platform?: string; light?: boolean }): Promise<Array<any>> {
    try {
      const r = await window.electron.scenario.listRunRecords(filter);
      return Array.isArray(r?.records) ? r.records : [];
    } catch {
      return [];
    }
  }

  /** Single record lookup, for the read-only detail page. */
  async getRunRecord(id: string): Promise<any | null> {
    try {
      const r = await window.electron.scenario.getRunRecord(id);
      return r?.record || null;
    } catch {
      return null;
    }
  }

  async getRunProgress(taskId?: string): Promise<ScenarioRunProgress | null> {
    try {
      return await window.electron.scenario.getRunProgress(taskId) || null;
    } catch {
      return null;
    }
  }

  /** v4.31.41: Persistent fallback for the detail page —— in-memory progress
   *  gets cleared 30s after task end, but runRecords keeps step_logs forever.
   *  UI mounts: read latest record, show its step_logs as a baseline; live
   *  polling overlays in-memory progress when task is actively running. */
  async getLatestRunRecord(taskId: string): Promise<any | null> {
    try {
      return await (window.electron.scenario as any).getLatestRunRecord(taskId) || null;
    } catch {
      return null;
    }
  }

  async requestAbort(taskId?: string): Promise<void> {
    try {
      await window.electron.scenario.requestAbort(taskId);
    } catch {}
  }

  // ── XHS login gate ──

  async checkXhsLogin(platform: 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao' = 'xhs'): Promise<XhsLoginStatus> {
    try {
      return await window.electron.scenario.checkXhsLogin(platform as any);
    } catch (err) {
      return { loggedIn: false, reason: 'browser_not_connected' };
    }
  }

  async openXhsLogin(platform: 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao' = 'xhs'): Promise<{ ok: boolean; reason?: string }> {
    try {
      return await window.electron.scenario.openXhsLogin(platform as any);
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  }

  // ── Creator center secondary gate (xhs / douyin 图文创作专用) ──
  // 首页 tab 不等于创作者中心 tab,LoginRequiredModal 额外加一行检查保证用户
  // 真打开过 creator.* 子域、且不是停在登录重定向页。

  async checkCreatorCenter(platform: 'xhs' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao'): Promise<XhsLoginStatus> {
    try {
      return await window.electron.scenario.checkCreatorCenter(platform as any);
    } catch (err) {
      return { loggedIn: false, reason: 'browser_not_connected' };
    }
  }

  async openCreatorCenter(platform: 'xhs' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao'): Promise<{ ok: boolean; reason?: string }> {
    try {
      return await window.electron.scenario.openCreatorCenter(platform as any);
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  }

  /** 视频任务登录预检【cookie 快路径】(req 3):返回 {loggedIn} 或 null(拿不准 → 调用方回退老校验)。 */
  async checkVideoLoginByCookie(platform: string, which?: 'main' | 'creator'): Promise<{ loggedIn: boolean } | null> {
    try {
      return await (window.electron.scenario as any).checkVideoLoginByCookie(platform, which);
    } catch {
      return null;
    }
  }

  /** 【多平台】一次性 cookie 预检:一次 CDP 读全部、按域名+名逐平台判。返回 { [platform]: true|false|null }。 */
  async checkVideoLoginByCookieBatch(items: { platform: string; which?: 'main' | 'creator' }[]): Promise<Record<string, boolean | null>> {
    try {
      return await (window.electron.scenario as any).checkVideoLoginByCookieBatch(items) || {};
    } catch {
      return {};
    }
  }

  /** 在唯一的检查/登录窗里给某平台开一个 tab 登录(一窗多 tab,不再每点开新窗;role 各平台不同)。 */
  async openVideoLoginInCheckWindow(url: string, role?: string): Promise<{ ok: boolean; diag?: string }> {
    const fn = (window.electron?.scenario as any)?.openLoginInCheckWindow;
    if (typeof fn !== 'function') {
      return { ok: false, diag: 'preload 没暴露 openLoginInCheckWindow(typeof=' + typeof fn + ')' };
    }
    try {
      const r: any = await fn(url, role);
      if (r && typeof r === 'object' && typeof r.diag === 'string') return r;   // 主进程新代码:带 diag,透传
      return { ok: !!(r && r.ok), diag: '主进程返回无 diag(=主bundle可能是旧的): ' + JSON.stringify(r) };
    } catch (e: any) {
      return { ok: false, diag: 'IPC 抛错: ' + String(e?.message || e) };       // reject:无 handler / 主进程抛异常
    }
  }

  /** 模态关闭时收掉检查/登录窗。 */
  async closeVideoLoginCheckWindow(): Promise<void> {
    try { await (window.electron.scenario as any).closeLoginCheckWindow(); } catch { /* ignore */ }
  }

  // ── Derived helpers ──

  /** Aggregate per-task stats the task dashboard likes to show.
   *
   *  v5.x+: the previous 3 cards (累计采集 / 生成草稿 / 已推送) were
   *  replaced with 累计完成 / 累计消耗 / 上次完成 / 上次消耗. The new
   *  fields are computed from per-run telemetry (`action_counts`,
   *  `tokens_used`, `cost_usd`) that orchestrators emit via
   *  `ctx.addActionCount()` + the auto-summed token/cost maps in
   *  scenarioManager. Pre-rollout runs lack these fields, so they
   *  contribute 0 to the cumulative totals and the UI shows '-' for
   *  the "last run" panel until a fresh run lands. */
  async getTaskStats(taskId: string): Promise<{
    runs: ScenarioTaskRun[];
    draft_count: number;
    pending_draft_count: number;
    pushed_draft_count: number;
    last_run_at: number | null;
    last_run_status: ScenarioTaskRun['status'] | null;
    cooldown_ends_at: number;
    /** Sum across every recorded successful run, keyed by free-form
     *  action type ('like' / 'follow' / 'comment' / 'reply' / 'post'). */
    cumulative_action_counts: Record<string, number>;
    /** Sum of credits consumed across every recorded run. */
    cumulative_tokens_used: number;
    /** Sum of USD cost across every recorded run (computed at run-time
     *  from system_config.token_price_per_million). */
    cumulative_cost_usd: number;
    /** action_counts of the most recent run, or {} if it doesn't have any. */
    last_run_action_counts: Record<string, number>;
    /** Credits consumed by the most recent run, or 0. */
    last_run_tokens_used: number;
    /** USD cost of the most recent run, or 0. */
    last_run_cost_usd: number;
  }> {
    const [runStatusResult, drafts] = await Promise.all([
      this.runStatus(taskId).catch(() => ({ runs: [], cooldown_ends_at: 0 })),
      this.listDrafts(taskId),
    ]);
    const runs = Array.isArray(runStatusResult?.runs) ? runStatusResult.runs : [];
    const cooldown_ends_at = runStatusResult?.cooldown_ends_at || 0;
    // v6.x: '上次完成' 是上一次真正跑完的统计 — 不能选 status='running' 的当前
    //   in-progress run(那个 action_counts 永远是空/0,会把上次的正确数据顶掉)。
    //   优先找最近一条 status≠'running' 的 run;全是 running 才回退到末尾。
    let last: any = null;
    for (let i = runs.length - 1; i >= 0; i--) {
      if (runs[i] && runs[i].status !== 'running') { last = runs[i]; break; }
    }
    if (!last) last = runs.length > 0 ? runs[runs.length - 1] : null;

    // Cumulative aggregation. Iterate all runs (including failed/skipped —
    // an action that succeeded before a later failure still counts).
    const cumulative_action_counts: Record<string, number> = {};
    let cumulative_tokens_used = 0;
    let cumulative_cost_usd = 0;
    for (const r of runs) {
      const ac = r.action_counts;
      if (ac && typeof ac === 'object') {
        for (const [k, v] of Object.entries(ac)) {
          cumulative_action_counts[k] = (cumulative_action_counts[k] || 0) + (Number(v) || 0);
        }
      }
      cumulative_tokens_used += Number(r.tokens_used) || 0;
      cumulative_cost_usd    += Number(r.cost_usd)    || 0;
    }

    return {
      runs,
      draft_count: drafts.length,
      pending_draft_count: drafts.filter(d => d.status === 'pending').length,
      pushed_draft_count: drafts.filter(d => d.status === 'pushed').length,
      last_run_at: last?.started_at || null,
      last_run_status: last?.status || null,
      cooldown_ends_at,
      cumulative_action_counts,
      cumulative_tokens_used,
      cumulative_cost_usd,
      last_run_action_counts: (last?.action_counts && typeof last.action_counts === 'object') ? last.action_counts : {},
      last_run_tokens_used: Number(last?.tokens_used) || 0,
      last_run_cost_usd: Number(last?.cost_usd) || 0,
    };
  }
}

export const scenarioService = new ScenarioService();
