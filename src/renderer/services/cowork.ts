import { store } from '../store';
import {
  setSessions,
  setCurrentSession,
  addSession,
  updateSessionStatus,
  deleteSession as deleteSessionAction,
  deleteSessions as deleteSessionsAction,
  addMessage,
  updateMessageContent,
  updateMessageMetadata,
  setStreaming,
  updateSessionPinned,
  updateSessionTitle,
  enqueuePendingPermission,
  dequeuePendingPermission,
  setConfig,
  clearCurrentSession,
} from '../store/slices/coworkSlice';
import type {
  CoworkSession,
  CoworkConfigUpdate,
  CoworkApiConfig,
  CoworkSandboxStatus,
  CoworkSandboxProgress,
  CoworkUserMemoryEntry,
  CoworkMemoryStats,
  CoworkPermissionResult,
  CoworkStartOptions,
  CoworkContinueOptions,
} from '../types/cowork';

class CoworkService {
  private streamListenerCleanups: Array<() => void> = [];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    // Load initial config
    await this.loadConfig();

    // Load sessions list
    await this.loadSessions();

    // Set up stream listeners
    this.setupStreamListeners();

    this.initialized = true;
  }

  private setupStreamListeners(): void {
    const cowork = window.electron?.cowork;
    if (!cowork) return;

    // Clean up any existing listeners
    this.cleanupListeners();

    // Message listener - also check if session exists (for IM-created sessions)
    const messageCleanup = cowork.onStreamMessage(async ({ sessionId, message }) => {
      // Debug: log user messages to check if imageAttachments are preserved
      if (message.type === 'user') {
        const meta = message.metadata as Record<string, unknown> | undefined;
        console.log('[CoworkService] onStreamMessage received user message', {
          sessionId,
          messageId: message.id,
          hasMetadata: !!meta,
          metadataKeys: meta ? Object.keys(meta) : [],
          hasImageAttachments: !!(meta?.imageAttachments),
          imageAttachmentsCount: Array.isArray(meta?.imageAttachments) ? (meta.imageAttachments as unknown[]).length : 0,
        });
      }
      // Check if session exists in current list
      const state = store.getState().cowork;
      const sessionExists = state.sessions.some(s => s.id === sessionId);

      if (!sessionExists) {
        // Session was created by IM or another source, refresh the session list
        await this.loadSessions();
      }

      // A new user turn means this session is actively running again
      // (especially important for IM-triggered turns that do not call continueSession from renderer).
      if (message.type === 'user') {
        store.dispatch(updateSessionStatus({ sessionId, status: 'running' }));
      }

      // Do not force status back to "running" on arbitrary messages.
      // Late stream chunks can arrive after an error/complete event.
      store.dispatch(addMessage({ sessionId, message }));
    });
    this.streamListenerCleanups.push(messageCleanup);

    // Message update listener (for streaming content updates)
    const messageUpdateCleanup = cowork.onStreamMessageUpdate(({ sessionId, messageId, content }) => {
      store.dispatch(updateMessageContent({ sessionId, messageId, content }));
    });
    this.streamListenerCleanups.push(messageUpdateCleanup);

    // Message metadata update listener (e.g. per-turn token usage) —
    // fires after a stream completes and carries the usage field onto
    // the last assistant message. Bubble UI reads metadata.usage to
    // render the "12.5K in · 841 out" footer.
    const coworkAny = cowork as unknown as {
      onStreamMessageMetadata?: (cb: (data: { sessionId: string; messageId: string; metadata: Record<string, unknown> }) => void) => () => void;
    };
    if (typeof coworkAny.onStreamMessageMetadata === 'function') {
      const metadataCleanup = coworkAny.onStreamMessageMetadata(({ sessionId, messageId, metadata }) => {
        store.dispatch(updateMessageMetadata({ sessionId, messageId, metadata }));
      });
      this.streamListenerCleanups.push(metadataCleanup);
    }

    // Permission request listener
    const permissionCleanup = cowork.onStreamPermission(({ sessionId, request }) => {
      store.dispatch(enqueuePendingPermission({
        sessionId,
        toolName: request.toolName,
        toolInput: request.toolInput,
        requestId: request.requestId,
        toolUseId: request.toolUseId ?? null,
      }));
    });
    this.streamListenerCleanups.push(permissionCleanup);

    // Complete listener
    const completeCleanup = cowork.onStreamComplete(({ sessionId }) => {
      store.dispatch(updateSessionStatus({ sessionId, status: 'completed' }));
      // Refresh token balance after each completed turn
      import('./noobclawAuth').then(m => m.noobClawAuth.refreshBalance()).catch(() => {});
    });
    this.streamListenerCleanups.push(completeCleanup);

    // Listen for _noobclaw SSE payloads forwarded from cowork proxy (lucky bag, balance update, rebate)
    const noobclawCleanup = window.electron?.noobclaw?.onSsePayload((payload: Record<string, unknown>) => {
      console.log('[CoworkService] noobclaw:sse-payload received:', JSON.stringify(payload));
      const luckyBag = payload.luckyBag as { hit?: boolean; amount?: number } | undefined;
      if (luckyBag?.hit) {
        window.dispatchEvent(new CustomEvent('noobclaw:lucky-bag', {
          detail: { reward: luckyBag.amount },
        }));
      }
      if (payload.remainingTokens !== undefined) {
        window.dispatchEvent(new CustomEvent('noobclaw:balance-update', {
          detail: { balance: payload.remainingTokens },
        }));
      }
      // 关于"BUSDT 返佣到账通知":此处不读 payload.rebate。返佣的事件源是 client
      // refreshBalance 拉 /api/ai/balance 后的 pendingRebates(见
      // noobclawAuth.refreshBalance),走 atomic UPDATE...RETURNING 路径,带去重。
      // backend 的 AI SSE _noobclaw payload 不发 rebate 字段(仅 remainingTokens /
      // tokensUsed / luckyBag / priceUsdPerMillion / costUsd),所以这里没桥接。
      // 如果将来真要走 SSE 桥接,记得跟 notified_at 标记打通,否则会跟 balance
      // 轮询路径双重派发同一笔。
    });
    if (noobclawCleanup) this.streamListenerCleanups.push(noobclawCleanup);

    // Error listener
    const errorCleanup = cowork.onStreamError(({ sessionId }) => {
      store.dispatch(updateSessionStatus({ sessionId, status: 'error' }));
    });
    this.streamListenerCleanups.push(errorCleanup);
  }

  private cleanupListeners(): void {
    this.streamListenerCleanups.forEach(cleanup => cleanup());
    this.streamListenerCleanups = [];
  }

  async loadSessions(): Promise<void> {
    const result = await window.electron?.cowork?.listSessions();
    if (result?.success && result.sessions) {
      store.dispatch(setSessions(result.sessions));
    }
  }

  async loadConfig(): Promise<void> {
    const result = await window.electron?.cowork?.getConfig();
    if (result?.success && result.config) {
      store.dispatch(setConfig(result.config));
    }
  }

  async startSession(options: CoworkStartOptions): Promise<CoworkSession | null> {
    const cowork = window.electron?.cowork;
    if (!cowork) {
      console.error('Cowork API not available');
      return null;
    }

    store.dispatch(setStreaming(true));

    const result = await cowork.startSession(options);
    if (result.success && result.session) {
      store.dispatch(addSession(result.session));
      if (result.session.status !== 'running') {
        store.dispatch(setStreaming(false));
      }
      return result.session;
    }

    store.dispatch(setStreaming(false));
    console.error('Failed to start session:', result.error);
    return null;
  }

  async continueSession(options: CoworkContinueOptions): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) {
      console.error('Cowork API not available');
      return false;
    }

    store.dispatch(setStreaming(true));
    store.dispatch(updateSessionStatus({ sessionId: options.sessionId, status: 'running' }));

    const result = await cowork.continueSession({
      sessionId: options.sessionId,
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      activeSkillIds: options.activeSkillIds,
      imageAttachments: options.imageAttachments,
    });
    if (!result.success) {
      store.dispatch(setStreaming(false));
      store.dispatch(updateSessionStatus({ sessionId: options.sessionId, status: 'error' }));
      console.error('Failed to continue session:', result.error);
      return false;
    }

    return true;
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const result = await cowork.stopSession(sessionId);
    if (result.success) {
      store.dispatch(setStreaming(false));
      store.dispatch(updateSessionStatus({ sessionId, status: 'idle' }));
      return true;
    }

    console.error('Failed to stop session:', result.error);
    return false;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const result = await cowork.deleteSession(sessionId);
    if (result.success) {
      store.dispatch(deleteSessionAction(sessionId));
      return true;
    }

    console.error('Failed to delete session:', result.error);
    return false;
  }

  async deleteSessions(sessionIds: string[]): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const result = await cowork.deleteSessions(sessionIds);
    if (result.success) {
      store.dispatch(deleteSessionsAction(sessionIds));
      return true;
    }

    console.error('Failed to batch delete sessions:', result.error);
    return false;
  }

  async setSessionPinned(sessionId: string, pinned: boolean): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.setSessionPinned) return false;

    const result = await cowork.setSessionPinned({ sessionId, pinned });
    if (result.success) {
      store.dispatch(updateSessionPinned({ sessionId, pinned }));
      return true;
    }

    console.error('Failed to update session pin:', result.error);
    return false;
  }

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.renameSession) return false;

    const normalizedTitle = title.trim();
    if (!normalizedTitle) return false;

    const result = await cowork.renameSession({ sessionId, title: normalizedTitle });
    if (result.success) {
      store.dispatch(updateSessionTitle({ sessionId, title: normalizedTitle }));
      return true;
    }

    console.error('Failed to rename session:', result.error);
    return false;
  }

  async exportSessionResultImage(options: {
    rect: { x: number; y: number; width: number; height: number };
    defaultFileName?: string;
  }): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.exportResultImage) {
      return { success: false, error: 'Cowork export API not available' };
    }

    try {
      const result = await cowork.exportResultImage(options);
      return result ?? { success: false, error: 'Failed to export session image' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export session image',
      };
    }
  }

  async captureSessionImageChunk(options: {
    rect: { x: number; y: number; width: number; height: number };
  }): Promise<{ success: boolean; width?: number; height?: number; pngBase64?: string; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.captureImageChunk) {
      return { success: false, error: 'Cowork capture API not available' };
    }

    try {
      const result = await cowork.captureImageChunk(options);
      return result ?? { success: false, error: 'Failed to capture session image chunk' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to capture session image chunk',
      };
    }
  }

  async saveSessionResultImage(options: {
    pngBase64: string;
    defaultFileName?: string;
  }): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.saveResultImage) {
      return { success: false, error: 'Cowork save image API not available' };
    }

    try {
      const result = await cowork.saveResultImage(options);
      return result ?? { success: false, error: 'Failed to save session image' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save session image',
      };
    }
  }

  async loadSession(sessionId: string): Promise<CoworkSession | null> {
    const cowork = window.electron?.cowork;
    if (!cowork) return null;

    const result = await cowork.getSession(sessionId);
    if (result.success && result.session) {
      store.dispatch(setCurrentSession(result.session));
      store.dispatch(setStreaming(result.session.status === 'running'));
      return result.session;
    }

    console.error('Failed to load session:', result.error);
    return null;
  }

  async respondToPermission(requestId: string, result: CoworkPermissionResult): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const response = await cowork.respondToPermission({ requestId, result });
    if (response.success) {
      store.dispatch(dequeuePendingPermission({ requestId }));
      return true;
    }

    console.error('Failed to respond to permission:', response.error);
    return false;
  }

  async updateConfig(config: CoworkConfigUpdate): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const result = await cowork.setConfig(config);
    if (result.success) {
      const currentConfig = store.getState().cowork.config;
      store.dispatch(setConfig({ ...currentConfig, ...config }));
      return true;
    }

    console.error('Failed to update config:', result.error);
    return false;
  }

  async getApiConfig(): Promise<CoworkApiConfig | null> {
    if (!window.electron?.getApiConfig) {
      return null;
    }
    return window.electron.getApiConfig();
  }

  async checkApiConfig(options?: { probeModel?: boolean }): Promise<{ hasConfig: boolean; config: CoworkApiConfig | null; error?: string } | null> {
    if (!window.electron?.checkApiConfig) {
      return null;
    }
    return window.electron.checkApiConfig(options);
  }

  async saveApiConfig(config: CoworkApiConfig): Promise<{ success: boolean; error?: string } | null> {
    if (!window.electron?.saveApiConfig) {
      return null;
    }
    return window.electron.saveApiConfig(config);
  }

  async getSandboxStatus(): Promise<CoworkSandboxStatus | null> {
    if (!window.electron?.cowork?.getSandboxStatus) {
      return null;
    }
    return window.electron.cowork.getSandboxStatus();
  }

  async installSandbox(): Promise<{ success: boolean; status: CoworkSandboxStatus; error?: string } | null> {
    if (!window.electron?.cowork?.installSandbox) {
      return null;
    }
    return window.electron.cowork.installSandbox();
  }

  async listMemoryEntries(input: {
    query?: string;
    status?: 'created' | 'stale' | 'deleted' | 'all';
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<CoworkUserMemoryEntry[]> {
    const api = window.electron?.cowork?.listMemoryEntries;
    if (!api) return [];
    const result = await api(input);
    if (!result?.success || !result.entries) return [];
    return result.entries;
  }

  async createMemoryEntry(input: {
    text: string;
    confidence?: number;
    isExplicit?: boolean;
  }): Promise<CoworkUserMemoryEntry | null> {
    const api = window.electron?.cowork?.createMemoryEntry;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.entry) return null;
    return result.entry;
  }

  async updateMemoryEntry(input: {
    id: string;
    text?: string;
    confidence?: number;
    status?: 'created' | 'stale' | 'deleted';
    isExplicit?: boolean;
  }): Promise<CoworkUserMemoryEntry | null> {
    const api = window.electron?.cowork?.updateMemoryEntry;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.entry) return null;
    return result.entry;
  }

  async deleteMemoryEntry(input: { id: string }): Promise<boolean> {
    const api = window.electron?.cowork?.deleteMemoryEntry;
    if (!api) return false;
    const result = await api(input);
    return Boolean(result?.success);
  }

  async getMemoryStats(): Promise<CoworkMemoryStats | null> {
    const api = window.electron?.cowork?.getMemoryStats;
    if (!api) return null;
    const result = await api();
    if (!result?.success || !result.stats) return null;
    return result.stats;
  }

  onSandboxDownloadProgress(callback: (progress: CoworkSandboxProgress) => void): () => void {
    if (!window.electron?.cowork?.onSandboxDownloadProgress) {
      return () => {};
    }
    return window.electron.cowork.onSandboxDownloadProgress(callback);
  }

  async generateSessionTitle(prompt: string | null): Promise<string | null> {
    if (!window.electron?.generateSessionTitle) {
      return null;
    }
    return window.electron.generateSessionTitle(prompt);
  }

  async getRecentCwds(limit?: number): Promise<string[]> {
    if (!window.electron?.getRecentCwds) {
      return [];
    }
    return window.electron.getRecentCwds(limit);
  }

  clearSession(): void {
    store.dispatch(clearCurrentSession());
  }

  destroy(): void {
    this.cleanupListeners();
    this.initialized = false;
  }
}

export const coworkService = new CoworkService();
