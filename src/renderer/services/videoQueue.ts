/**
 * videoQueue — 「视频创作」大类(电影级 / 在线素材 / 模板速生 / 翻译二创)的额度 + 单槽抢占协调器。
 *
 * 背景:视频任务分散在两套引擎——
 *   · 本地一键成片(原创 / AI 自动成片) → videoTaskStore(renderer,本地 ffmpeg pipeline)
 *   · 翻译二创                         → scenario 系统(主进程 orchestrator)
 * 需求(对齐币安等 scenario 任务的设计):
 *   · 新建任务【只校验列表总数 ≤5】(视频算一类,含已完成),不校验余额、不立即运行。
 *   · 运行是【抢占式】:到点 / 手动触发时,谁先抢到空槽谁就跑;槽被占就【不跑、也不排队】
 *     (下一拍/下次触发再抢),不再是 FIFO「排队第 N 位」。
 *
 * 因此本协调器只做两件事:
 *   1) canCreate():统计 videoTaskStore + scenario('video') 总数,<5 才放行(含已完成)。
 *   2) tryRun():空闲就开跑(local→videoTaskStore.runTask;scenario→runTaskNow),忙则返回 false。
 */

import { videoTaskStore } from './videoTaskStore';
import { scenarioService } from './scenario';

export type VideoJobKind = 'local' | 'scenario';

interface RunningJob {
  kind: VideoJobKind;
  refId: string;
  title: string;
  startedAt: number;
}

/** 视频创作大类列表总上限(含已完成);超了拒绝新建,需先删旧的。 */
export const VIDEO_TASK_LIMIT = 5;

type Listener = () => void;

class VideoQueue {
  /** 当前占用单槽的任务(抢占式:同时只 1 个);空闲为 null。 */
  private current: RunningJob | null = null;
  private listeners = new Set<Listener>();

  constructor() {
    // 本地定时任务到点时也走抢占(避免和手动触发同时开两个)。回调注入避免循环依赖。
    try {
      videoTaskStore.onScheduleDue = (taskId: string) => {
        const t = videoTaskStore.getTask(taskId);
        this.tryRun('local', taskId, t?.title || '视频任务');
      };
    } catch { /* 老 store 没有该字段则忽略 */ }
  }

  // ── 订阅(UI 实时刷新「生成中」徽章) ───────────────────────
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    for (const l of this.listeners) { try { l(); } catch { /* ignore */ } }
  }

  // ── 额度(列表总数 ≤5,含已完成) ─────────────────────────
  /** 视频大类当前任务总数 = 本地任务 + scenario('video') 任务。 */
  async totalCount(): Promise<number> {
    const local = videoTaskStore.getTasks().length;
    let scenario = 0;
    try { scenario = (await scenarioService.listTasksFor('video')).length; } catch { /* ignore */ }
    return local + scenario;
  }

  /** 是否还能新建(总数 < 上限)。满了返回 false(上层提示先删旧的)。 */
  async canCreate(): Promise<boolean> {
    return (await this.totalCount()) < VIDEO_TASK_LIMIT;
  }

  // ── 运行态查询(UI 用) ─────────────────────────────────
  /** 槽是否被占(含本地 store 自身在跑)。 */
  isBusy(): boolean {
    return this.current !== null || videoTaskStore.isAnyRunning();
  }

  isRunning(refId: string): boolean {
    return this.current?.refId === refId;
  }

  // ── 抢占式开跑 ─────────────────────────────────────────
  /**
   * 尝试立即开跑:空闲返回 true 并启动;槽被占则【不排队】返回 false。
   * 调用方:手动触发(返回 false → 提示「已有视频生成中」)、定时到点(false → 下拍再抢)。
   */
  tryRun(kind: VideoJobKind, refId: string, title: string): boolean {
    if (this.isBusy()) return false;
    this.current = { kind, refId, title: title || '视频任务', startedAt: Date.now() };
    this.emit();
    void this.runCurrent();
    return true;
  }

  private async runCurrent(): Promise<void> {
    const job = this.current;
    if (!job) return;
    try {
      if (job.kind === 'local') {
        const runId = videoTaskStore.runTask(job.refId);
        if (runId) await this.waitLocalDone(job.refId);
        // runId 为 null(任务已删 / store 忙):直接释放槽。
      } else {
        await scenarioService.runTaskNow(job.refId); // 主进程跑完才 resolve
      }
    } catch { /* 单条失败不影响释放槽 */ }
    this.current = null;
    this.emit();
  }

  /** 等本地任务跑完:订阅 videoTaskStore,任务终态 / 全局空闲即 resolve。 */
  private waitLocalDone(taskId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): boolean => {
        const t = videoTaskStore.getTask(taskId);
        if (!t || t.lastStatus !== 'running' || !videoTaskStore.isAnyRunning()) return true;
        return false;
      };
      if (done()) { resolve(); return; }
      const unsub = videoTaskStore.subscribe(() => {
        if (done()) { unsub(); resolve(); }
      });
      const timer = setInterval(() => {
        if (done()) { clearInterval(timer); try { unsub(); } catch { /* ignore */ } resolve(); }
      }, 3000);
    });
  }
}

export const videoQueue = new VideoQueue();
