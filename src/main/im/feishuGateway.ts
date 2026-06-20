/**
 * Feishu/Lark Gateway
 * Manages WebSocket connection for receiving messages
 * Adapted from im-gateway for Electron main process
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import {
  FeishuConfig,
  FeishuGatewayStatus,
  FeishuMessageContext,
  IMMessage,
  IMMediaAttachment,
  DEFAULT_FEISHU_STATUS,
} from './types';
import {
  uploadImageToFeishu,
  uploadFileToFeishu,
  detectFeishuFileType,
  isFeishuImagePath,
  isFeishuAudioPath,
  resolveFeishuMediaPath,
  downloadFeishuMedia,
  getFeishuDefaultMimeType,
  mapFeishuMediaType,
} from './feishuMedia';
import { parseMediaMarkers } from './dingtalkMediaParser';
import { stringifyAsciiJson } from './jsonEncoding';
import { isSystemProxyEnabled, resolveSystemProxyUrl } from '../libs/systemProxy';
import { coworkLog } from '../libs/coworkLogger';

// Message deduplication cache
const processedMessages = new Map<string, number>();
const MESSAGE_DEDUP_TTL = 5 * 60 * 1000; // 5 minutes

// Feishu message event structure
interface FeishuMessageEvent {
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; user_id?: string };
      name: string;
    }>;
  };
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
    };
    sender_type: string;
  };
}

export class FeishuGateway extends EventEmitter {
  private wsClient: any = null;
  private restClient: any = null;
  private config: FeishuConfig | null = null;
  private status: FeishuGatewayStatus = { ...DEFAULT_FEISHU_STATUS };
  private botOpenId: string | null = null;
  private onMessageCallback?: (message: IMMessage, replyFn: (text: string) => Promise<void>) => Promise<void>;
  private lastChatId: string | null = null;
  private log: (...args: any[]) => void = () => {};

  constructor() {
    super();
  }

  /**
   * Get current gateway status
   */
  getStatus(): FeishuGatewayStatus {
    return { ...this.status };
  }

  /**
   * Check if gateway is connected
   */
  isConnected(): boolean {
    return this.status.connected;
  }

  /**
   * Public method for external reconnection triggers (e.g., network events)
   */
  reconnectIfNeeded(): void {
    if (!this.wsClient && this.config) {
      this.log('[Feishu Gateway] External reconnection trigger');
      this.start(this.config).catch((error) => {
        console.error('[Feishu Gateway] Reconnection failed:', error.message);
      });
    }
  }

  /**
   * Set message callback
   */
  setMessageCallback(
    callback: (message: IMMessage, replyFn: (text: string) => Promise<void>) => Promise<void>
  ): void {
    this.onMessageCallback = callback;
  }

  /**
   * Start Feishu gateway
   */
  async start(config: FeishuConfig): Promise<void> {
    if (this.wsClient) {
      throw new Error('Feishu gateway already running');
    }

    if (!config.enabled) {
      console.log('[Feishu Gateway] Feishu is disabled in config');
      return;
    }

    if (!config.appId || !config.appSecret) {
      throw new Error('Feishu appId and appSecret are required');
    }

    this.config = config;
    this.log = config.debug ? console.log.bind(console) : () => {};

    this.log('[Feishu Gateway] Starting WebSocket gateway...');
    coworkLog('INFO', 'feishu-gateway', `start: domain=${config.domain}, appId=${config.appId?.slice(0, 8)}..., enabled=${config.enabled}`);

    try {
      // Dynamically import @larksuiteoapi/node-sdk
      const Lark = await import('@larksuiteoapi/node-sdk');

      // Resolve domain
      const domain = this.resolveDomain(config.domain, Lark);
      coworkLog('INFO', 'feishu-gateway', `Resolved domain: ${domain}`);

      // Create REST client for sending messages
      this.restClient = new Lark.Client({
        appId: config.appId,
        appSecret: config.appSecret,
        appType: Lark.AppType.SelfBuild,
        domain,
      });

      // Probe bot info to get open_id
      coworkLog('INFO', 'feishu-gateway', 'Probing bot info via /open-apis/bot/v3/info...');
      const probeResult = await this.probeBot();
      if (!probeResult.ok) {
        coworkLog('ERROR', 'feishu-gateway', `probeBot failed: ${probeResult.error}; rawKeys=${Object.keys((probeResult.raw || {}) as any).join(',')}`);
        throw new Error(`Failed to probe bot: ${probeResult.error}`);
      }

      this.botOpenId = probeResult.botOpenId || null;
      this.log(`[Feishu Gateway] Bot info: ${probeResult.botName} (${this.botOpenId})`);
      coworkLog(
        'INFO',
        'feishu-gateway',
        `probeBot OK: botName=${probeResult.botName || 'unknown'}, botOpenId=${this.botOpenId || 'null'}; rawKeys=${Object.keys((probeResult.raw || {}) as any).join(',')}`
      );

      // Resolve proxy agent for WebSocket if system proxy is enabled
      let proxyAgent: any = undefined;
      if (isSystemProxyEnabled()) {
        const feishuTarget = domain === Lark.Domain.Feishu
          ? 'https://open.feishu.cn'
          : 'https://open.larksuite.com';
        const proxyUrl = await resolveSystemProxyUrl(feishuTarget);
        if (proxyUrl) {
          try {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            proxyAgent = new HttpsProxyAgent(proxyUrl);
            this.log(`[Feishu Gateway] Using proxy agent for WebSocket: ${proxyUrl}`);
          } catch (e: any) {
            console.warn(`[Feishu Gateway] Failed to create proxy agent: ${e.message}`);
          }
        }
      }

      // Custom logger that tees the Lark SDK's internal messages into our
      // cowork.log file. The SDK defaults to console.log/warn/error, which
      // Tauri captures on the sidecar's stdout but never persists to disk,
      // so without this every WSClient connect failure and every
      // "no X handle" dispatch miss is invisible to the user.
      const sdkLog = (level: 'INFO' | 'WARN' | 'ERROR', tag: string, msg: unknown[]): void => {
        let line: string;
        try {
          line = msg.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join(' ');
        } catch {
          line = String(msg);
        }
        coworkLog(level, tag, line);
      };
      const sdkLogger = {
        error: (msg: unknown[]) => sdkLog('ERROR', 'lark-sdk', msg),
        warn: (msg: unknown[]) => sdkLog('WARN', 'lark-sdk', msg),
        info: (msg: unknown[]) => sdkLog('INFO', 'lark-sdk', msg),
        debug: (msg: unknown[]) => sdkLog('INFO', 'lark-sdk', msg),
        trace: (msg: unknown[]) => sdkLog('INFO', 'lark-sdk', msg),
      };

      // Create WebSocket client. Cast to any because @larksuiteoapi/node-sdk
      // accepts a custom `logger` at runtime but its .d.ts omits the field.
      this.wsClient = new Lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        domain,
        loggerLevel: Lark.LoggerLevel.debug,
        logger: sdkLogger,
        agent: proxyAgent,
      } as any);

      // Create event dispatcher
      const eventDispatcher = new Lark.EventDispatcher({
        encryptKey: config.encryptKey,
        verificationToken: config.verificationToken,
        loggerLevel: Lark.LoggerLevel.debug,
        logger: sdkLogger,
      } as any);

      // Register event handlers
      eventDispatcher.register({
        'im.message.receive_v1': async (data: any) => {
          try {
            const event = data as FeishuMessageEvent;
            coworkLog(
              'INFO',
              'feishu-gateway',
              `Inbound im.message.receive_v1: message_id=${event.message?.message_id}, chat_id=${event.message?.chat_id}, msg_type=${event.message?.message_type}`
            );

            // Check for duplicate
            if (this.isMessageProcessed(event.message.message_id)) {
              this.log(`[Feishu Gateway] Duplicate message ignored: ${event.message.message_id}`);
              return;
            }

            const ctx = this.parseMessageEvent(event);
            // Fire-and-forget: do not await so the Lark SDK can send the ack
            // to Feishu server immediately. Replies are sent via replyFn/sendWithMedia,
            // not through the event handler return value.
            this.handleInboundMessage(ctx).catch((err) => {
              console.error(`[Feishu Gateway] Error handling message ${ctx.messageId}: ${err.message}`);
              coworkLog('ERROR', 'feishu-gateway', `handleInboundMessage failed: ${err?.message || err}`);
            });
          } catch (err: any) {
            console.error(`[Feishu Gateway] Error parsing message event: ${err.message}`);
            coworkLog('ERROR', 'feishu-gateway', `Event handler exception: ${err?.message || err}`);
          }
        },
        'im.message.message_read_v1': async () => {
          // Ignore read receipts
        },
        'im.chat.member.bot.added_v1': async (data: any) => {
          this.log(`[Feishu Gateway] Bot added to chat ${data.chat_id}`);
        },
        'im.chat.member.bot.deleted_v1': async (data: any) => {
          this.log(`[Feishu Gateway] Bot removed from chat ${data.chat_id}`);
        },
      });

      // Start WebSocket client.
      //
      // The Lark SDK's `WSClient.start` is actually fire-and-forget
      // internally: it calls `this.reConnect(true)` *without awaiting*, so
      // its returned promise resolves immediately after setting the event
      // dispatcher. That means `await wsClient.start(...)` gives you no
      // signal about whether the WebSocket is actually connected.
      //
      // We need our own readiness probe. After kicking off start() we poll
      // the internal `wsConfig.getWSInstance()` until it exists and is in
      // the OPEN readyState, with a 15s budget. If that never happens we
      // assume the SDK's reconnect loop is stuck and flip the gateway
      // status to error so the UI toggle reflects reality instead of
      // claiming a happy green state with no inbound messages.
      coworkLog('INFO', 'feishu-gateway', 'Calling wsClient.start({ eventDispatcher })...');
      try {
        const startReturn = this.wsClient.start({ eventDispatcher });
        if (startReturn && typeof startReturn.then === 'function') {
          await startReturn; // resolves immediately; real connect happens async
        }
      } catch (wsErr: any) {
        coworkLog('ERROR', 'feishu-gateway', `wsClient.start threw: ${wsErr?.message || wsErr}`);
        throw new Error(`WebSocket connection failed: ${wsErr?.message || wsErr}`);
      }

      const WS_READY_DEADLINE_MS = 15_000;
      const wsDeadline = Date.now() + WS_READY_DEADLINE_MS;
      let wsReady = false;
      while (Date.now() < wsDeadline) {
        const ws = this.wsClient?.wsConfig?.getWSInstance?.();
        // readyState OPEN (1) means the SDK's underlying WebSocket actually
        // completed its handshake. Anything else (CONNECTING, CLOSED, null)
        // means we're still waiting or have already failed.
        if (ws && ws.readyState === 1) {
          wsReady = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!wsReady) {
        coworkLog(
          'ERROR',
          'feishu-gateway',
          'wsClient did not reach OPEN state within 15s — gateway is effectively disconnected'
        );
        throw new Error('WebSocket did not reach OPEN state within 15s');
      }
      coworkLog('INFO', 'feishu-gateway', 'WebSocket reached OPEN state — ready to receive events');

      this.status = {
        connected: true,
        startedAt: new Date().toISOString(),
        botOpenId: this.botOpenId,
        error: null,
        lastInboundAt: null,
        lastOutboundAt: null,
      };

      this.log('[Feishu Gateway] WebSocket gateway started successfully');
      coworkLog('INFO', 'feishu-gateway', 'Gateway fully started, ready to receive messages');
      this.emit('connected');
    } catch (error: any) {
      coworkLog('ERROR', 'feishu-gateway', `start failed: ${error?.message || error}`);
      this.wsClient = null;
      this.restClient = null;
      this.status = {
        connected: false,
        startedAt: null,
        botOpenId: null,
        error: error.message,
        lastInboundAt: null,
        lastOutboundAt: null,
      };
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop Feishu gateway
   */
  async stop(): Promise<void> {
    if (!this.wsClient) {
      this.log('[Feishu Gateway] Not running');
      return;
    }

    this.log('[Feishu Gateway] Stopping WebSocket gateway...');

    this.wsClient = null;
    this.restClient = null;
    this.config = null;
    this.status = {
      connected: false,
      startedAt: null,
      botOpenId: this.status.botOpenId,
      error: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    };

    this.log('[Feishu Gateway] WebSocket gateway stopped');
    this.emit('disconnected');
  }

  /**
   * Resolve domain to Lark SDK domain
   */
  private resolveDomain(domain: string, Lark: any): any {
    if (domain === 'lark') return Lark.Domain.Lark;
    if (domain === 'feishu') return Lark.Domain.Feishu;
    return domain.replace(/\/+$/, '');
  }

  /**
   * Probe bot info.
   *
   * The real Lark response is `{ code, msg, bot: {app_name, open_id, ...} }` —
   * NOT `{ data: { bot: {...} } }`. The old code read `response.data.bot.*`
   * so both botName and botOpenId always came back undefined, and the log
   * showed `botName=unknown, botOpenId=null` even for fully working apps.
   * We now try the actual field locations first and keep the legacy ones as
   * a secondary fallback in case a newer SDK wraps responses.
   */
  private async probeBot(): Promise<{
    ok: boolean;
    error?: string;
    botName?: string;
    botOpenId?: string;
    raw?: unknown;
  }> {
    try {
      const response: any = await this.restClient.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });

      if (response.code !== 0) {
        return { ok: false, error: `code=${response.code} msg=${response.msg}`, raw: response };
      }

      const bot = response.bot ?? response.data?.bot ?? response.data;
      return {
        ok: true,
        botName: bot?.app_name ?? response.data?.app_name,
        botOpenId: bot?.open_id ?? response.data?.open_id,
        raw: response,
      };
    } catch (err: any) {
      // The Lark SDK wraps axios, and when the server returns a non-2xx HTTP
      // response (e.g. 400 with a business error body like {"code":4040,...})
      // the error is thrown without surfacing the body. Reach into the axios
      // error shape to recover as much as we can, including the actual Lark
      // error code and message. Otherwise our log just says "Request failed
      // with status code 400" with no clue what went wrong.
      const httpStatus = err?.response?.status;
      const body = err?.response?.data;
      let bodyText = '';
      if (body) {
        try {
          bodyText = typeof body === 'string' ? body : JSON.stringify(body);
        } catch {
          bodyText = String(body);
        }
      }
      const errorMsg = `${err.message}${httpStatus ? ` (HTTP ${httpStatus})` : ''}${bodyText ? ` body=${bodyText.slice(0, 500)}` : ''}`;
      return { ok: false, error: errorMsg, raw: body };
    }
  }

  /**
   * Add a reaction emoji to a message (best-effort, non-blocking)
   */
  private async addReaction(messageId: string, emojiType: string): Promise<void> {
    if (!this.restClient) return;
    try {
      const response: any = await this.restClient.request({
        method: 'POST',
        url: `/open-apis/im/v1/messages/${messageId}/reactions`,
        data: { reaction_type: { emoji_type: emojiType } },
      });
      if (response.code !== 0) {
        this.log(`[Feishu Gateway] Failed to add reaction: ${response.msg || response.code}`);
      }
    } catch (err: any) {
      this.log(`[Feishu Gateway] Failed to add reaction: ${err.message}`);
    }
  }

  /**
   * Check if message was already processed (deduplication)
   */
  private isMessageProcessed(messageId: string): boolean {
    this.cleanupProcessedMessages();
    if (processedMessages.has(messageId)) {
      return true;
    }
    processedMessages.set(messageId, Date.now());
    return false;
  }

  /**
   * Clean up expired messages from cache
   */
  private cleanupProcessedMessages(): void {
    const now = Date.now();
    for (const [messageId, timestamp] of processedMessages) {
      if (now - timestamp > MESSAGE_DEDUP_TTL) {
        processedMessages.delete(messageId);
      }
    }
  }

  /**
   * Parse message content
   */
  private parseMessageContent(content: string, messageType: string): string {
    try {
      const parsed = JSON.parse(content);
      if (messageType === 'text') {
        return parsed.text || '';
      }
      if (messageType === 'post') {
        return this.parsePostContent(content);
      }
      // For media types, return descriptive text (media keys extracted in parseMessageEvent)
      if (messageType === 'image') return '[图片]';
      if (messageType === 'audio') return '[语音]';
      if (messageType === 'video' || messageType === 'media') return '[视频]';
      if (messageType === 'file') return parsed.file_name ? `[文件: ${parsed.file_name}]` : '[文件]';
      return content;
    } catch {
      return content;
    }
  }

  /**
   * Parse post (rich text) content
   */
  private parsePostContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      const title = parsed.title || '';
      const contentBlocks = parsed.content || [];
      let textContent = title ? `${title}\n\n` : '';

      for (const paragraph of contentBlocks) {
        if (Array.isArray(paragraph)) {
          for (const element of paragraph) {
            if (element.tag === 'text') {
              textContent += element.text || '';
            } else if (element.tag === 'a') {
              textContent += element.text || element.href || '';
            } else if (element.tag === 'at') {
              textContent += `@${element.user_name || element.user_id || ''}`;
            }
          }
          textContent += '\n';
        }
      }

      return textContent.trim() || '[富文本消息]';
    } catch {
      return '[富文本消息]';
    }
  }

  /**
   * Check if bot was mentioned
   */
  private checkBotMentioned(event: FeishuMessageEvent): boolean {
    const mentions = event.message.mentions ?? [];
    if (mentions.length === 0) return false;
    if (!this.botOpenId) return mentions.length > 0;
    return mentions.some((m) => m.id.open_id === this.botOpenId);
  }

  /**
   * Strip bot mention from text
   */
  private stripBotMention(text: string, mentions?: FeishuMessageEvent['message']['mentions']): string {
    if (!mentions || mentions.length === 0) return text;
    let result = text;
    for (const mention of mentions) {
      result = result.replace(new RegExp(`@${mention.name}\\s*`, 'g'), '').trim();
      result = result.replace(new RegExp(mention.key, 'g'), '').trim();
    }
    return result;
  }

  /**
   * Parse Feishu message event
   */
  private parseMessageEvent(event: FeishuMessageEvent): FeishuMessageContext {
    const messageType = event.message.message_type;
    const rawContent = this.parseMessageContent(event.message.content, messageType);
    const mentionedBot = this.checkBotMentioned(event);
    const content = this.stripBotMention(rawContent, event.message.mentions);

    // Extract media keys from content JSON for media message types
    let mediaKey: string | undefined;
    let mediaType: string | undefined;
    let mediaFileName: string | undefined;
    let mediaDuration: number | undefined;

    if (['image', 'file', 'audio', 'video', 'media'].includes(messageType)) {
      try {
        const parsed = JSON.parse(event.message.content);
        mediaType = messageType;

        if (messageType === 'image') {
          mediaKey = parsed.image_key;
        } else {
          // file, audio, video, media all use file_key
          mediaKey = parsed.file_key;
          mediaFileName = parsed.file_name;
          if (parsed.duration !== undefined) {
            mediaDuration = typeof parsed.duration === 'string'
              ? parseInt(parsed.duration, 10)
              : parsed.duration;
          }
        }
      } catch {
        // JSON parse failed, skip media extraction
      }
    }

    return {
      chatId: event.message.chat_id,
      messageId: event.message.message_id,
      senderId: event.sender.sender_id.user_id || event.sender.sender_id.open_id || '',
      senderOpenId: event.sender.sender_id.open_id || '',
      chatType: event.message.chat_type,
      mentionedBot,
      rootId: event.message.root_id,
      parentId: event.message.parent_id,
      content,
      contentType: messageType,
      mediaKey,
      mediaType,
      mediaFileName,
      mediaDuration,
    };
  }

  /**
   * Resolve receive_id_type
   */
  private resolveReceiveIdType(target: string): 'open_id' | 'user_id' | 'chat_id' {
    if (target.startsWith('ou_')) return 'open_id';
    if (target.startsWith('oc_')) return 'chat_id';
    return 'chat_id';
  }

  /**
   * Send text message
   */
  private async sendTextMessage(to: string, text: string, replyToMessageId?: string): Promise<void> {
    const receiveIdType = this.resolveReceiveIdType(to);
    const content = stringifyAsciiJson({ text });

    if (replyToMessageId) {
      const response = await this.restClient.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'text' },
      });

      if (response.code !== 0) {
        throw new Error(`Feishu reply failed: ${response.msg || `code ${response.code}`}`);
      }
      return;
    }

    const response = await this.restClient.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: to, content, msg_type: 'text' },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu send failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  /**
   * Build markdown card
   */
  private buildMarkdownCard(text: string): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true },
      elements: [{ tag: 'markdown', content: text }],
    };
  }

  /**
   * Send card message
   */
  private async sendCardMessage(to: string, text: string, replyToMessageId?: string): Promise<void> {
    const receiveIdType = this.resolveReceiveIdType(to);
    const card = this.buildMarkdownCard(text);
    const content = stringifyAsciiJson(card);

    if (replyToMessageId) {
      const response = await this.restClient.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'interactive' },
      });

      if (response.code !== 0) {
        throw new Error(`Feishu card reply failed: ${response.msg || `code ${response.code}`}`);
      }
      return;
    }

    const response = await this.restClient.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: to, content, msg_type: 'interactive' },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu card send failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  /**
   * Send message (auto-select format based on config)
   */
  private async sendMessage(to: string, text: string, replyToMessageId?: string): Promise<void> {
    const renderMode = this.config?.renderMode || 'text';

    this.log(`[Feishu Gateway] Sending text message:`, JSON.stringify({
      to,
      renderMode,
      replyToMessageId,
      textLength: text.length,
    }));

    if (renderMode === 'card') {
      await this.sendCardMessage(to, text, replyToMessageId);
    } else {
      await this.sendTextMessage(to, text, replyToMessageId);
    }
  }

  /**
   * Send image message
   */
  private async sendImageMessage(to: string, imageKey: string, replyToMessageId?: string): Promise<void> {
    const receiveIdType = this.resolveReceiveIdType(to);
    const content = stringifyAsciiJson({ image_key: imageKey });

    this.log(`[Feishu Gateway] Sending image message:`, JSON.stringify({
      to,
      imageKey,
      receiveIdType,
      replyToMessageId,
    }));

    if (replyToMessageId) {
      const response = await this.restClient.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'image' },
      });
      if (response.code !== 0) {
        throw new Error(`Feishu image reply failed: ${response.msg || `code ${response.code}`}`);
      }
      return;
    }

    const response = await this.restClient.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: to, content, msg_type: 'image' },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu image send failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  /**
   * Send file message
   */
  private async sendFileMessage(to: string, fileKey: string, replyToMessageId?: string): Promise<void> {
    const receiveIdType = this.resolveReceiveIdType(to);
    const content = stringifyAsciiJson({ file_key: fileKey });

    this.log(`[Feishu Gateway] Sending file message:`, JSON.stringify({
      to,
      fileKey,
      receiveIdType,
      replyToMessageId,
    }));

    if (replyToMessageId) {
      const response = await this.restClient.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'file' },
      });
      if (response.code !== 0) {
        throw new Error(`Feishu file reply failed: ${response.msg || `code ${response.code}`}`);
      }
      return;
    }

    const response = await this.restClient.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: to, content, msg_type: 'file' },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu file send failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  /**
   * Send audio message
   */
  private async sendAudioMessage(to: string, fileKey: string, duration?: number, replyToMessageId?: string): Promise<void> {
    const receiveIdType = this.resolveReceiveIdType(to);
    const content = stringifyAsciiJson({
      file_key: fileKey,
      ...(duration !== undefined && { duration: Math.floor(duration).toString() })
    });

    this.log(`[Feishu Gateway] Sending audio message:`, JSON.stringify({
      to,
      fileKey,
      duration,
      receiveIdType,
      replyToMessageId,
    }));

    if (replyToMessageId) {
      const response = await this.restClient.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'audio' },
      });
      if (response.code !== 0) {
        throw new Error(`Feishu audio reply failed: ${response.msg || `code ${response.code}`}`);
      }
      return;
    }

    const response = await this.restClient.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: to, content, msg_type: 'audio' },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu audio send failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  /**
   * Upload and send media from file path
   * @param customFileName - custom file name parsed from Markdown (e.g. "Today's News" from [Today's News](file.txt))
   */
  private async uploadAndSendMedia(
    to: string,
    filePath: string,
    mediaType: 'image' | 'video' | 'audio' | 'file',
    replyToMessageId?: string,
    customFileName?: string
  ): Promise<void> {
    // Resolve path
    const absPath = resolveFeishuMediaPath(filePath);

    if (!fs.existsSync(absPath)) {
      console.warn(`[Feishu Gateway] File not found: ${absPath}`);
      return;
    }

    // Use custom file name or extract from path, preserve original extension
    const originalFileName = path.basename(absPath);
    const ext = path.extname(absPath);
    const fileName = customFileName ? `${customFileName}${ext}` : originalFileName;
    const fileStats = fs.statSync(absPath);

    this.log(`[Feishu Gateway] Uploading media:`, JSON.stringify({
      absPath,
      mediaType,
      originalFileName,
      customFileName,
      fileName,
      fileSize: fileStats.size,
      fileSizeKB: (fileStats.size / 1024).toFixed(1),
    }));

    if (mediaType === 'image' || isFeishuImagePath(absPath)) {
      // Upload image
      this.log(`[Feishu Gateway] Starting image upload: ${fileName}`);
      const result = await uploadImageToFeishu(this.restClient, absPath);
      this.log(`[Feishu Gateway] Image upload result:`, JSON.stringify(result));
      if (!result.success || !result.imageKey) {
        console.warn(`[Feishu Gateway] Image upload failed: ${result.error}`);
        return;
      }
      await this.sendImageMessage(to, result.imageKey, replyToMessageId);
    } else if (mediaType === 'audio' || isFeishuAudioPath(absPath)) {
      // Upload audio
      this.log(`[Feishu Gateway] Starting audio upload: ${fileName}`);
      const result = await uploadFileToFeishu(this.restClient, absPath, fileName, 'opus');
      this.log(`[Feishu Gateway] Audio upload result:`, JSON.stringify(result));
      if (!result.success || !result.fileKey) {
        console.warn(`[Feishu Gateway] Audio upload failed: ${result.error}`);
        return;
      }
      await this.sendAudioMessage(to, result.fileKey, undefined, replyToMessageId);
    } else {
      // Upload as file (including video - Feishu video requires cover image, send as file for simplicity)
      this.log(`[Feishu Gateway] Starting file upload: ${fileName}`);
      const fileType = detectFeishuFileType(fileName);
      this.log(`[Feishu Gateway] Detected file type: ${fileType}`);
      const result = await uploadFileToFeishu(this.restClient, absPath, fileName, fileType);
      this.log(`[Feishu Gateway] File upload result:`, JSON.stringify(result));
      if (!result.success || !result.fileKey) {
        console.warn(`[Feishu Gateway] File upload failed: ${result.error}`);
        return;
      }
      await this.sendFileMessage(to, result.fileKey, replyToMessageId);
    }
  }

  /**
   * Send message with media support - detects and uploads media from text
   */
  private async sendWithMedia(to: string, text: string, replyToMessageId?: string): Promise<void> {
    // Parse media markers from text
    const markers = parseMediaMarkers(text);

    this.log(`[Feishu Gateway] Parsed media markers:`, JSON.stringify({
      to,
      replyToMessageId,
      textLength: text.length,
      markersCount: markers.length,
      markers: markers.map(m => ({ type: m.type, path: m.path, name: m.name })),
    }));

    if (markers.length === 0) {
      // No media, send as text/card
      await this.sendMessage(to, text, replyToMessageId);
      return;
    }

    // Upload and send each media
    for (const marker of markers) {
      try {
        this.log(`[Feishu Gateway] Processing media:`, JSON.stringify(marker));
        // Pass the file name parsed from markdown
        await this.uploadAndSendMedia(to, marker.path, marker.type, replyToMessageId, marker.name);
      } catch (error: any) {
        console.error(`[Feishu Gateway] Failed to send media: ${error.message}`);
      }
    }

    // Send the text message (keep full text for context)
    await this.sendMessage(to, text, replyToMessageId);
  }

  /**
   * Handle inbound message
   */
  private async handleInboundMessage(ctx: FeishuMessageContext): Promise<void> {
    // In group chat, only respond when bot is mentioned
    if (ctx.chatType === 'group' && !ctx.mentionedBot) {
      this.log('[Feishu Gateway] Ignoring group message without bot mention');
      return;
    }

    // Download media attachments if present
    let attachments: IMMediaAttachment[] | undefined;
    if (ctx.mediaKey && ctx.mediaType && this.restClient) {
      try {
        const result = await downloadFeishuMedia(
          this.restClient,
          ctx.messageId,
          ctx.mediaKey,
          ctx.mediaType,
          ctx.mediaFileName
        );
        if (result) {
          attachments = [{
            type: mapFeishuMediaType(ctx.mediaType),
            localPath: result.localPath,
            mimeType: getFeishuDefaultMimeType(ctx.mediaType, ctx.mediaFileName),
            fileName: ctx.mediaFileName,
            fileSize: result.fileSize,
            duration: ctx.mediaDuration ? ctx.mediaDuration / 1000 : undefined,
          }];
        }
      } catch (err: any) {
        console.error(`[Feishu] 下载媒体失败: ${err.message}`);
      }
    }

    // Create IMMessage
    const message: IMMessage = {
      platform: 'feishu',
      messageId: ctx.messageId,
      conversationId: ctx.chatId,
      senderId: ctx.senderId,
      content: ctx.content,
      chatType: ctx.chatType === 'p2p' ? 'direct' : 'group',
      timestamp: Date.now(),
      attachments,
    };
    this.status.lastInboundAt = Date.now();

    // Log the full input message
    this.log(`[Feishu] Received message:`, JSON.stringify({
      sender: ctx.senderOpenId,
      senderId: ctx.senderId,
      chatId: ctx.chatId,
      chatType: ctx.chatType === 'p2p' ? 'direct' : 'group',
      messageId: ctx.messageId,
      contentType: ctx.contentType,
      content: ctx.content,
      mentionedBot: ctx.mentionedBot,
      rootId: ctx.rootId,
      parentId: ctx.parentId,
      mediaKey: ctx.mediaKey,
      mediaType: ctx.mediaType,
      attachmentsCount: attachments?.length || 0,
    }, null, 2));

    // Create reply function with media support
    const replyFn = async (text: string) => {
      // Log the full output message
      this.log(`[Feishu] Sending reply:`, JSON.stringify({
        conversationId: ctx.chatId,
        replyToMessageId: ctx.messageId,
        replyLength: text.length,
        reply: text,
      }, null, 2));

      await this.sendWithMedia(ctx.chatId, text, ctx.messageId);
      this.status.lastOutboundAt = Date.now();
    };

    // Store last chat ID for notifications
    this.lastChatId = ctx.chatId;

    // Emit message event
    this.emit('message', message);

    // Add processing reaction (fire-and-forget)
    this.addReaction(ctx.messageId, 'OnIt').catch(() => {});

    // Call message callback if set. If it isn't wired, SHOUT about it —
    // we used to silently drop the message here, which was how the Tauri
    // sidecar sat for weeks "receiving" Lark events but never replying.
    if (this.onMessageCallback) {
      coworkLog('INFO', 'feishu-gateway', `Dispatching to onMessageCallback: messageId=${ctx.messageId}`);
      try {
        await this.onMessageCallback(message, replyFn);
      } catch (error: any) {
        console.error(`[Feishu Gateway] Error in message callback: ${error.message}`);
        coworkLog('ERROR', 'feishu-gateway', `onMessageCallback threw: ${error?.message || error}`);
        await replyFn(`抱歉，处理消息时出现错误：${error.message}`);
      }
    } else {
      coworkLog(
        'ERROR',
        'feishu-gateway',
        `onMessageCallback is not wired! Message dropped: messageId=${ctx.messageId}, chat=${ctx.chatId}. This means IMGatewayManager.initialize() was never called — check sidecar-server.ts getIMGatewayManagerInstance.`
      );
    }
  }

  /**
   * Get the current notification target for persistence.
   */
  getNotificationTarget(): string | null {
    return this.lastChatId;
  }

  /**
   * Restore notification target from persisted state.
   */
  setNotificationTarget(chatId: string): void {
    this.lastChatId = chatId;
  }

  /**
   * Send a notification message to the last known chat.
   */
  async sendNotification(text: string): Promise<void> {
    if (!this.lastChatId || !this.restClient) {
      throw new Error('No conversation available for notification');
    }
    await this.sendMessage(this.lastChatId, text);
    this.status.lastOutboundAt = Date.now();
  }

  /**
   * Send a notification message with media support to the last known chat.
   */
  async sendNotificationWithMedia(text: string): Promise<void> {
    if (!this.lastChatId || !this.restClient) {
      throw new Error('No conversation available for notification');
    }
    await this.sendWithMedia(this.lastChatId, text, undefined);
    this.status.lastOutboundAt = Date.now();
  }
}
