/**
 * IM Gateway Manager
 * Unified manager for DingTalk, Feishu and Telegram gateways
 */

import { EventEmitter } from 'events';
import { DingTalkGateway } from './dingtalkGateway';
import { FeishuGateway } from './feishuGateway';
import { TelegramGateway } from './telegramGateway';
import { DiscordGateway } from './discordGateway';
import { QQGateway } from './qqGateway';
import { WecomGateway } from './wecomGateway';
import { IMChatHandler } from './imChatHandler';
import { IMCoworkHandler } from './imCoworkHandler';
import { IMStore } from './imStore';
import { getOapiAccessToken } from './dingtalkMedia';
import { fetchJsonWithTimeout } from './http';
import {
  IMGatewayConfig,
  IMGatewayStatus,
  IMPlatform,
  IMMessage,
  IMConnectivityCheck,
  IMConnectivityTestResult,
  IMConnectivityVerdict,
} from './types';
import type { Database } from 'sql.js';
import type { CoworkRunner } from '../libs/coworkRunner';
import type { CoworkStore } from '../coworkStore';
const CONNECTIVITY_TIMEOUT_MS = 10_000;
const INBOUND_ACTIVITY_WARN_AFTER_MS = 2 * 60 * 1000;

interface TelegramGetMeResponse {
  ok?: boolean;
  result?: {
    username?: string;
  };
  description?: string;
}

interface DiscordUserResponse {
  username?: string;
  discriminator?: string;
}

export interface IMGatewayManagerOptions {
  coworkRunner?: CoworkRunner;
  coworkStore?: CoworkStore;
}

export class IMGatewayManager extends EventEmitter {
  private dingtalkGateway: DingTalkGateway;
  private feishuGateway: FeishuGateway;
  private telegramGateway: TelegramGateway;
  private discordGateway: DiscordGateway;
  private qqGateway: QQGateway;
  private wecomGateway: WecomGateway;
  private imStore: IMStore;
  private chatHandler: IMChatHandler | null = null;
  private coworkHandler: IMCoworkHandler | null = null;
  private getLLMConfig: (() => Promise<any>) | null = null;
  private getSkillsPrompt: (() => Promise<string | null>) | null = null;

  // Cowork dependencies
  private coworkRunner: CoworkRunner | null = null;
  private coworkStore: CoworkStore | null = null;

  constructor(db: Database, saveDb: () => void, options?: IMGatewayManagerOptions) {
    super();

    this.imStore = new IMStore(db, saveDb);
    this.dingtalkGateway = new DingTalkGateway();
    this.feishuGateway = new FeishuGateway();
    this.telegramGateway = new TelegramGateway();
    this.discordGateway = new DiscordGateway();
    this.qqGateway = new QQGateway();
    this.wecomGateway = new WecomGateway();

    // Store Cowork dependencies if provided
    if (options?.coworkRunner && options?.coworkStore) {
      this.coworkRunner = options.coworkRunner;
      this.coworkStore = options.coworkStore;
    }

    // Forward gateway events
    this.setupGatewayEventForwarding();
  }

  /**
   * Set up event forwarding from gateways
   */
  private setupGatewayEventForwarding(): void {
    // DingTalk events
    this.dingtalkGateway.on('connected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.dingtalkGateway.on('disconnected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.dingtalkGateway.on('error', (error) => {
      this.emit('error', { platform: 'dingtalk', error });
      this.emit('statusChange', this.getStatus());
    });
    this.dingtalkGateway.on('message', (message: IMMessage) => {
      this.emit('message', message);
    });

    // Feishu events
    this.feishuGateway.on('connected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.feishuGateway.on('disconnected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.feishuGateway.on('error', (error) => {
      this.emit('error', { platform: 'feishu', error });
      this.emit('statusChange', this.getStatus());
    });
    this.feishuGateway.on('message', (message: IMMessage) => {
      this.emit('message', message);
    });

    // Telegram events
    this.telegramGateway.on('connected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.telegramGateway.on('disconnected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.telegramGateway.on('error', (error) => {
      this.emit('error', { platform: 'telegram', error });
      this.emit('statusChange', this.getStatus());
    });
    this.telegramGateway.on('message', (message: IMMessage) => {
      this.emit('message', message);
    });

    // Discord events
    this.discordGateway.on('status', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.discordGateway.on('connected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.discordGateway.on('disconnected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.discordGateway.on('error', (error) => {
      this.emit('error', { platform: 'discord', error });
      this.emit('statusChange', this.getStatus());
    });
    this.discordGateway.on('message', (message: IMMessage) => {
      this.emit('message', message);
    });


    // QQ events
    this.qqGateway.on('connected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.qqGateway.on('disconnected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.qqGateway.on('error', (error) => {
      this.emit('error', { platform: 'qq', error });
      this.emit('statusChange', this.getStatus());
    });
    this.qqGateway.on('message', (message: IMMessage) => {
      this.emit('message', message);
    });

    // WeCom events
    this.wecomGateway.on('status', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.wecomGateway.on('connected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.wecomGateway.on('disconnected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.wecomGateway.on('error', (error) => {
      this.emit('error', { platform: 'wecom', error });
      this.emit('statusChange', this.getStatus());
    });
    this.wecomGateway.on('message', (message: IMMessage) => {
      this.emit('message', message);
    });
  }

  /**
   * Reconnect all disconnected gateways
   * Called when network is restored via IPC event
   */
  reconnectAllDisconnected(): void {
    console.log('[IMGatewayManager] Reconnecting all disconnected gateways...');

    if (this.dingtalkGateway && !this.dingtalkGateway.isConnected()) {
      console.log('[IMGatewayManager] Reconnecting DingTalk...');
      this.dingtalkGateway.reconnectIfNeeded();
    }

    if (this.feishuGateway && !this.feishuGateway.isConnected()) {
      console.log('[IMGatewayManager] Reconnecting Feishu...');
      this.feishuGateway.reconnectIfNeeded();
    }

    if (this.telegramGateway && !this.telegramGateway.isConnected()) {
      console.log('[IMGatewayManager] Reconnecting Telegram...');
      this.telegramGateway.reconnectIfNeeded();
    }

    if (this.discordGateway && !this.discordGateway.isConnected()) {
      console.log('[IMGatewayManager] Reconnecting Discord...');
      this.discordGateway.reconnectIfNeeded();
    }


    if (this.qqGateway && !this.qqGateway.isConnected()) {
      console.log('[IMGatewayManager] Reconnecting QQ...');
      this.qqGateway.reconnectIfNeeded();
    }

    if (this.wecomGateway && !this.wecomGateway.isConnected()) {
      console.log('[IMGatewayManager] Reconnecting WeCom...');
      this.wecomGateway.reconnectIfNeeded();
    }
  }

  /**
   * Initialize the manager with LLM and skills providers
   */
  initialize(options: {
    getLLMConfig: () => Promise<any>;
    getSkillsPrompt?: () => Promise<string | null>;
  }): void {
    this.getLLMConfig = options.getLLMConfig;
    this.getSkillsPrompt = options.getSkillsPrompt ?? null;

    // Set up message handlers for gateways
    this.setupMessageHandlers();
  }

  /**
   * Set up message handlers for both gateways
   */
  private setupMessageHandlers(): void {
    const messageHandler = async (
      message: IMMessage,
      replyFn: (text: string) => Promise<void>
    ): Promise<void> => {
      // Persist notification target whenever we receive a message
      this.persistNotificationTarget(message.platform);

      try {
        let response: string;

        // Always use Cowork mode if handler is available
        if (this.coworkHandler) {
          console.log('[IMGatewayManager] Using Cowork mode for message processing');
          response = await this.coworkHandler.processMessage(message);
        } else {
          // Fallback to regular chat handler
          if (!this.chatHandler) {
            this.updateChatHandler();
          }

          if (!this.chatHandler) {
            throw new Error('Chat handler not available');
          }

          response = await this.chatHandler.processMessage(message);
        }

        await replyFn(response);
      } catch (error: any) {
        console.error(`[IMGatewayManager] Error processing message: ${error.message}`);
        // Don't send "Replaced by a newer IM request" error to user, just log it
        if (error.message === 'Replaced by a newer IM request') {
          return;
        }
        // Send error message to user
        try {
          await replyFn(`处理消息时出错: ${error.message}`);
        } catch (replyError) {
          console.error(`[IMGatewayManager] Failed to send error reply: ${replyError}`);
        }
      }
    };

    this.dingtalkGateway.setMessageCallback(messageHandler);
    this.feishuGateway.setMessageCallback(messageHandler);
    this.telegramGateway.setMessageCallback(messageHandler);
    this.discordGateway.setMessageCallback(messageHandler);
    this.qqGateway.setMessageCallback(messageHandler);
    this.wecomGateway.setMessageCallback(messageHandler);
  }

  /**
   * Persist the notification target for a platform after receiving a message.
   */
  private persistNotificationTarget(platform: IMPlatform): void {
    try {
      let target: any = null;
      if (platform === 'dingtalk') {
        target = this.dingtalkGateway.getNotificationTarget();
      } else if (platform === 'feishu') {
        target = this.feishuGateway.getNotificationTarget();
      } else if (platform === 'telegram') {
        target = this.telegramGateway.getNotificationTarget();
      } else if (platform === 'discord') {
        target = this.discordGateway.getNotificationTarget();
      } else if (platform === 'qq') {
        target = this.qqGateway.getNotificationTarget();
      } else if (platform === 'wecom') {
        target = this.wecomGateway.getNotificationTarget();
      }
      if (target != null) {
        this.imStore.setNotificationTarget(platform, target);
      }
    } catch (err: any) {
      console.warn(`[IMGatewayManager] Failed to persist notification target for ${platform}:`, err.message);
    }
  }

  /**
   * Restore notification target from SQLite after gateway starts.
   */
  private restoreNotificationTarget(platform: IMPlatform): void {
    try {
      const target = this.imStore.getNotificationTarget(platform);
      if (target == null) return;

      if (platform === 'dingtalk') {
        this.dingtalkGateway.setNotificationTarget(target);
      } else if (platform === 'feishu') {
        this.feishuGateway.setNotificationTarget(target);
      } else if (platform === 'telegram') {
        this.telegramGateway.setNotificationTarget(target);
      } else if (platform === 'discord') {
        this.discordGateway.setNotificationTarget(target);
      } else if (platform === 'qq') {
        this.qqGateway.setNotificationTarget(target);
      } else if (platform === 'wecom') {
        this.wecomGateway.setNotificationTarget(target);
      }
      console.log(`[IMGatewayManager] Restored notification target for ${platform}`);
    } catch (err: any) {
      console.warn(`[IMGatewayManager] Failed to restore notification target for ${platform}:`, err.message);
    }
  }

  /**
   * Update chat handler with current settings
   */
  private updateChatHandler(): void {
    if (!this.getLLMConfig) {
      console.warn('[IMGatewayManager] LLM config provider not set');
      return;
    }

    const imSettings = this.imStore.getIMSettings();

    this.chatHandler = new IMChatHandler({
      getLLMConfig: this.getLLMConfig,
      getSkillsPrompt: this.getSkillsPrompt || undefined,
      imSettings,
    });

    // Update or create Cowork handler if dependencies are available
    this.updateCoworkHandler();
  }

  /**
   * Update or create Cowork handler
   * Always creates handler if dependencies are available (Cowork mode is always enabled for IM)
   */
  private updateCoworkHandler(): void {
    // Always create Cowork handler if we have the required dependencies
    if (this.coworkRunner && this.coworkStore && !this.coworkHandler) {
      this.coworkHandler = new IMCoworkHandler({
        coworkRunner: this.coworkRunner,
        coworkStore: this.coworkStore,
        imStore: this.imStore,
        getSkillsPrompt: this.getSkillsPrompt || undefined,
      });
      console.log('[IMGatewayManager] Cowork handler created');
    }
  }

  // ==================== Configuration ====================

  /**
   * Get current configuration
   */
  getConfig(): IMGatewayConfig {
    return this.imStore.getConfig();
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<IMGatewayConfig>): void {
    const previousConfig = this.imStore.getConfig();
    this.imStore.setConfig(config);

    // Update chat handler if settings changed
    if (config.settings) {
      this.updateChatHandler();
    }

    // Hot-update Telegram config on running gateway
    if (config.telegram && this.telegramGateway) {
      this.telegramGateway.updateConfig(config.telegram);
    }


    // Hot-update DingTalk config: restart if credential fields changed
    if (config.dingtalk && this.dingtalkGateway) {
      const oldDt = previousConfig.dingtalk;
      const newDt = { ...oldDt, ...config.dingtalk };
      const credentialsChanged =
        newDt.clientId !== oldDt.clientId ||
        newDt.clientSecret !== oldDt.clientSecret;

      if (credentialsChanged && this.dingtalkGateway.isConnected()) {
        console.log('[IMGatewayManager] DingTalk credentials changed, restarting gateway...');
        this.restartGateway('dingtalk').catch((err) => {
          console.error('[IMGatewayManager] Failed to restart DingTalk after config change:', err.message);
        });
      }
    }

    // Hot-update Feishu config: restart if credential fields changed
    if (config.feishu && this.feishuGateway) {
      const oldFs = previousConfig.feishu;
      const newFs = { ...oldFs, ...config.feishu };
      const credentialsChanged =
        newFs.appId !== oldFs.appId ||
        newFs.appSecret !== oldFs.appSecret;

      if (credentialsChanged && this.feishuGateway.isConnected()) {
        console.log('[IMGatewayManager] Feishu credentials changed, restarting gateway...');
        this.restartGateway('feishu').catch((err) => {
          console.error('[IMGatewayManager] Failed to restart Feishu after config change:', err.message);
        });
      }
    }

    // Hot-update Discord config: restart if credential fields changed
    if (config.discord && this.discordGateway) {
      const oldDc = previousConfig.discord;
      const newDc = { ...oldDc, ...config.discord };
      const credentialsChanged = newDc.botToken !== oldDc.botToken;

      if (credentialsChanged && this.discordGateway.isConnected()) {
        console.log('[IMGatewayManager] Discord credentials changed, restarting gateway...');
        this.restartGateway('discord').catch((err) => {
          console.error('[IMGatewayManager] Failed to restart Discord after config change:', err.message);
        });
      }
    }


    // Hot-update QQ config: restart if credential fields changed
    if (config.qq && this.qqGateway) {
      const oldQQ = previousConfig.qq;
      const newQQ = { ...oldQQ, ...config.qq };
      const credentialsChanged =
        newQQ.appId !== oldQQ.appId ||
        newQQ.appSecret !== oldQQ.appSecret;

      if (credentialsChanged && this.qqGateway.isConnected()) {
        console.log('[IMGatewayManager] QQ credentials changed, restarting gateway...');
        this.restartGateway('qq').catch((err) => {
          console.error('[IMGatewayManager] Failed to restart QQ after config change:', err.message);
        });
      }
    }

    // Hot-update WeCom config: restart if credential fields changed
    if (config.wecom && this.wecomGateway) {
      const oldWc = previousConfig.wecom;
      const newWc = { ...oldWc, ...config.wecom };
      const credentialsChanged =
        newWc.botId !== oldWc.botId ||
        newWc.secret !== oldWc.secret;

      if (credentialsChanged && this.wecomGateway.isConnected()) {
        console.log('[IMGatewayManager] WeCom credentials changed, restarting gateway...');
        this.restartGateway('wecom').catch((err) => {
          console.error('[IMGatewayManager] Failed to restart WeCom after config change:', err.message);
        });
      }
    }
  }

  /**
   * Restart a specific gateway (stop then start with latest config)
   * Used for hot-reloading when credentials change at runtime.
   */
  private async restartGateway(platform: IMPlatform): Promise<void> {
    console.log(`[IMGatewayManager] Restarting ${platform} gateway...`);
    await this.stopGateway(platform);
    await this.startGateway(platform);
    console.log(`[IMGatewayManager] ${platform} gateway restarted successfully`);
  }

  // ==================== Status ====================

  /**
   * Get current status of all gateways
   */
  getStatus(): IMGatewayStatus {
    return {
      dingtalk: this.dingtalkGateway.getStatus(),
      feishu: this.feishuGateway.getStatus(),
      qq: this.qqGateway.getStatus(),
      telegram: this.telegramGateway.getStatus(),
      discord: this.discordGateway.getStatus(),
      wecom: this.wecomGateway.getStatus(),
    };
  }

  /**
   * Test platform connectivity and readiness for conversation.
   */
  async testGateway(
    platform: IMPlatform,
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    const config = this.buildMergedConfig(configOverride);
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();

    const addCheck = (check: IMConnectivityCheck) => {
      checks.push(check);
    };

    const missingCredentials = this.getMissingCredentials(platform, config);
    if (missingCredentials.length > 0) {
      addCheck({
        code: 'missing_credentials',
        level: 'fail',
        message: `缺少必要配置项: ${missingCredentials.join(', ')}`,
        suggestion: '请补全配置后重新测试连通性。',
      });

      return {
        platform,
        testedAt,
        verdict: 'fail',
        checks,
      };
    }

    try {
      const authMessage = await this.withTimeout(
        this.runAuthProbe(platform, config),
        CONNECTIVITY_TIMEOUT_MS,
        '鉴权探测超时'
      );
      addCheck({
        code: 'auth_check',
        level: 'pass',
        message: authMessage,
      });
    } catch (error: any) {
      addCheck({
        code: 'auth_check',
        level: 'fail',
        message: `鉴权失败: ${error.message}`,
        suggestion: '请检查 ID/Secret/Token 是否正确，且机器人权限已开通。',
      });
      return {
        platform,
        testedAt,
        verdict: 'fail',
        checks,
      };
    }

    const status = this.getStatus();
    const enabled = Boolean(config[platform]?.enabled);
    const connected = this.isConnected(platform);

    if (enabled && !connected) {
      const discordStarting = platform === 'discord' && status.discord.starting;
      addCheck({
        code: 'gateway_running',
        level: discordStarting ? 'info' : 'warn',
        message: discordStarting
          ? 'IM 渠道正在启动，请稍后重试。'
          : 'IM 渠道已启用但当前未连接。',
        suggestion: discordStarting
          ? '等待启动完成后重新测试。'
          : '请检查网络、机器人配置和平台侧事件开关。',
      });
    } else {
      addCheck({
        code: 'gateway_running',
        level: connected ? 'pass' : 'info',
        message: connected ? 'IM 渠道已启用且运行正常。' : 'IM 渠道当前未启用。',
        suggestion: connected ? undefined : '请点击对应 IM 渠道胶囊按钮启用该渠道。',
      });
    }

    const startedAt = this.getStartedAtMs(platform, status);
    const lastInboundAt = this.getLastInboundAt(platform, status);
    const lastOutboundAt = this.getLastOutboundAt(platform, status);

    if (connected && startedAt && testedAt - startedAt >= INBOUND_ACTIVITY_WARN_AFTER_MS) {
      if (!lastInboundAt) {
        addCheck({
          code: 'inbound_activity',
          level: 'warn',
          message: '已连接超过 2 分钟，但尚未收到任何入站消息。',
          suggestion: '请确认机器人已在目标会话中，或按平台规则 @机器人 触发消息。',
        });
      } else {
        addCheck({
          code: 'inbound_activity',
          level: 'pass',
          message: '已检测到入站消息。',
        });
      }
    } else if (connected) {
      addCheck({
        code: 'inbound_activity',
        level: 'info',
        message: '网关刚启动，入站活动检查将在 2 分钟后更准确。',
      });
    }

    if (connected && lastInboundAt) {
      if (!lastOutboundAt) {
        addCheck({
          code: 'outbound_activity',
          level: 'warn',
          message: '已收到消息，但尚未观察到成功回发。',
          suggestion: '请检查消息发送权限、机器人可见范围和会话回包权限。',
        });
      } else {
        addCheck({
          code: 'outbound_activity',
          level: 'pass',
          message: '已检测到成功回发消息。',
        });
      }
    } else if (connected) {
      addCheck({
        code: 'outbound_activity',
        level: 'info',
        message: '尚未收到可用于评估回发能力的入站消息。',
      });
    }

    const lastError = this.getLastError(platform, status);
    if (lastError) {
      addCheck({
        code: 'platform_last_error',
        level: connected ? 'warn' : 'fail',
        message: `最近错误: ${lastError}`,
        suggestion: connected
          ? '当前已连接，但建议修复该错误避免后续中断。'
          : '该错误可能阻断对话，请优先修复后重试。',
      });
    }

    if (platform === 'feishu') {
      const isLark = config.feishu.domain === 'lark';
      const platformLabel = isLark ? 'Lark' : '飞书';
      addCheck({
        code: 'feishu_group_requires_mention',
        level: 'info',
        message: `${platformLabel}群聊中仅响应 @机器人的消息。`,
        suggestion: '请在群聊中使用 @机器人 + 内容触发对话。',
      });
      addCheck({
        code: 'feishu_event_subscription_required',
        level: 'info',
        message: `${platformLabel}需要开启消息事件订阅（im.message.receive_v1）才能收消息。`,
        suggestion: `请在${platformLabel}开发者后台确认事件订阅、权限和发布状态。`,
      });
    } else if (platform === 'discord') {
      addCheck({
        code: 'discord_group_requires_mention',
        level: 'info',
        message: 'Discord 群聊中仅响应 @机器人的消息。',
        suggestion: '请在频道中使用 @机器人 + 内容触发对话。',
      });
    } else if (platform === 'telegram') {
      addCheck({
        code: 'telegram_privacy_mode_hint',
        level: 'info',
        message: 'Telegram 群聊中仅响应 @机器人 或回复机器人的消息。',
        suggestion: '请先在 @BotFather 中关闭 Privacy Mode（/setprivacy → Disable），然后在群聊中使用 @机器人 + 内容触发对话。',
      });
    } else if (platform === 'dingtalk') {
      addCheck({
        code: 'dingtalk_bot_membership_hint',
        level: 'info',
        message: '钉钉机器人需被加入目标会话并具备发言权限。',
        suggestion: '请确认机器人在目标会话中，且企业权限配置允许收发消息。',
      });
    } else if (platform === 'qq') {
      addCheck({
        code: 'qq_guild_mention_hint',
        level: 'info',
        message: 'QQ 频道中需要 @机器人 才能触发消息响应，也支持私信对话。',
        suggestion: '请在频道中使用 @机器人 + 内容触发对话，或通过私信直接发送消息。',
      });
    } else if (platform === 'wecom') {
      addCheck({
        code: 'wecom_websocket_hint',
        level: 'info',
        message: '企业微信机器人通过 WebSocket 长连接接收消息。',
        suggestion: '请在企业微信中向机器人发送消息触发对话。群聊中需 @机器人。',
      });
    }

    return {
      platform,
      testedAt,
      verdict: this.calculateVerdict(checks),
      checks,
    };
  }

  // ==================== Gateway Control ====================

  /**
   * Start a specific gateway
   */
  async startGateway(platform: IMPlatform): Promise<void> {
    const config = this.getConfig();

    // Ensure chat handler is ready
    this.updateChatHandler();

    if (platform === 'dingtalk') {
      await this.dingtalkGateway.start(config.dingtalk);
    } else if (platform === 'feishu') {
      await this.feishuGateway.start(config.feishu);
    } else if (platform === 'telegram') {
      await this.telegramGateway.start(config.telegram);
    } else if (platform === 'discord') {
      await this.discordGateway.start(config.discord);
    } else if (platform === 'qq') {
      await this.qqGateway.start(config.qq);
    } else if (platform === 'wecom') {
      await this.wecomGateway.start(config.wecom);
    }

    // Restore persisted notification target
    this.restoreNotificationTarget(platform);
  }

  /**
   * Stop a specific gateway
   */
  async stopGateway(platform: IMPlatform): Promise<void> {
    if (platform === 'dingtalk') {
      await this.dingtalkGateway.stop();
    } else if (platform === 'feishu') {
      await this.feishuGateway.stop();
    } else if (platform === 'telegram') {
      await this.telegramGateway.stop();
    } else if (platform === 'discord') {
      await this.discordGateway.stop();
    } else if (platform === 'qq') {
      await this.qqGateway.stop();
    } else if (platform === 'wecom') {
      await this.wecomGateway.stop();
    }
  }

  /**
   * Start all enabled gateways
   */
  async startAllEnabled(): Promise<void> {
    const config = this.getConfig();

    if (config.dingtalk.enabled && config.dingtalk.clientId && config.dingtalk.clientSecret) {
      try {
        await this.startGateway('dingtalk');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start DingTalk: ${error.message}`);
      }
    }

    if (config.feishu.enabled && config.feishu.appId && config.feishu.appSecret) {
      try {
        await this.startGateway('feishu');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start Feishu: ${error.message}`);
      }
    }

    if (config.telegram.enabled && config.telegram.botToken) {
      try {
        await this.startGateway('telegram');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start Telegram: ${error.message}`);
      }
    }

    if (config.discord.enabled && config.discord.botToken) {
      try {
        await this.startGateway('discord');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start Discord: ${error.message}`);
      }
    }


    if (config.qq?.enabled && config.qq?.appId && config.qq?.appSecret) {
      try {
        await this.startGateway('qq');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start QQ: ${error.message}`);
      }
    }

    if (config.wecom?.enabled && config.wecom?.botId && config.wecom?.secret) {
      try {
        await this.startGateway('wecom');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start WeCom: ${error.message}`);
      }
    }
  }

  /**
   * Stop all gateways
   */
  async stopAll(): Promise<void> {
    await Promise.all([
      this.dingtalkGateway.stop(),
      this.feishuGateway.stop(),
      this.telegramGateway.stop(),
      this.discordGateway.stop(),
      this.qqGateway.stop(),
      this.wecomGateway.stop(),
    ]);
  }

  /**
   * Check if any gateway is connected
   */
  isAnyConnected(): boolean {
    return this.dingtalkGateway.isConnected() || this.feishuGateway.isConnected() || this.telegramGateway.isConnected() || this.discordGateway.isConnected() || this.qqGateway.isConnected() || this.wecomGateway.isConnected();
  }

  /**
   * Check if a specific gateway is connected
   */
  isConnected(platform: IMPlatform): boolean {
    if (platform === 'dingtalk') {
      return this.dingtalkGateway.isConnected();
    }
    if (platform === 'telegram') {
      return this.telegramGateway.isConnected();
    }
    if (platform === 'discord') {
      return this.discordGateway.isConnected();
    }
    if (platform === 'qq') {
      return this.qqGateway.isConnected();
    }
    if (platform === 'wecom') {
      return this.wecomGateway.isConnected();
    }
    return this.feishuGateway.isConnected();
  }

  /**
   * Send a notification message through a specific platform.
   * Uses platform-specific broadcast mechanisms.
   * Returns true if successfully sent, false if platform not connected.
   */
  async sendNotification(platform: IMPlatform, text: string): Promise<boolean> {
    if (!this.isConnected(platform)) {
      console.warn(`[IMGatewayManager] Cannot send notification: ${platform} is not connected`);
      return false;
    }

    try {
      if (platform === 'dingtalk') {
        await this.dingtalkGateway.sendNotification(text);
      } else if (platform === 'feishu') {
        await this.feishuGateway.sendNotification(text);
      } else if (platform === 'telegram') {
        await this.telegramGateway.sendNotification(text);
      } else if (platform === 'discord') {
        await this.discordGateway.sendNotification(text);
      } else if (platform === 'qq') {
        await this.qqGateway.sendNotification(text);
      } else if (platform === 'wecom') {
        await this.wecomGateway.sendNotification(text);
      }
      return true;
    } catch (error: any) {
      console.error(`[IMGatewayManager] Failed to send notification via ${platform}:`, error.message);
      return false;
    }
  }

  async sendNotificationWithMedia(platform: IMPlatform, text: string): Promise<boolean> {
    if (!this.isConnected(platform)) {
      console.warn(`[IMGatewayManager] Cannot send notification: ${platform} is not connected`);
      return false;
    }

    try {
      if (platform === 'dingtalk') {
        await this.dingtalkGateway.sendNotificationWithMedia(text);
      } else if (platform === 'feishu') {
        await this.feishuGateway.sendNotificationWithMedia(text);
      } else if (platform === 'telegram') {
        await this.telegramGateway.sendNotificationWithMedia(text);
      } else if (platform === 'discord') {
        await this.discordGateway.sendNotificationWithMedia(text);
      } else if (platform === 'qq') {
        await this.qqGateway.sendNotificationWithMedia(text);
      } else if (platform === 'wecom') {
        await this.wecomGateway.sendNotificationWithMedia(text);
      }
      return true;
    } catch (error: any) {
      console.error(`[IMGatewayManager] Failed to send notification with media via ${platform}:`, error.message);
      return false;
    }
  }

  private buildMergedConfig(configOverride?: Partial<IMGatewayConfig>): IMGatewayConfig {
    const current = this.getConfig();
    if (!configOverride) {
      return current;
    }
    return {
      ...current,
      ...configOverride,
      dingtalk: { ...current.dingtalk, ...(configOverride.dingtalk || {}) },
      feishu: { ...current.feishu, ...(configOverride.feishu || {}) },
      qq: { ...current.qq, ...(configOverride.qq || {}) },
      telegram: { ...current.telegram, ...(configOverride.telegram || {}) },
      discord: { ...current.discord, ...(configOverride.discord || {}) },
      wecom: { ...current.wecom, ...(configOverride.wecom || {}) },
      settings: { ...current.settings, ...(configOverride.settings || {}) },
    };
  }

  private getMissingCredentials(platform: IMPlatform, config: IMGatewayConfig): string[] {
    if (platform === 'dingtalk') {
      const fields: string[] = [];
      if (!config.dingtalk.clientId) fields.push('clientId');
      if (!config.dingtalk.clientSecret) fields.push('clientSecret');
      return fields;
    }
    if (platform === 'feishu') {
      const fields: string[] = [];
      if (!config.feishu.appId) fields.push('appId');
      if (!config.feishu.appSecret) fields.push('appSecret');
      return fields;
    }
    if (platform === 'telegram') {
      return config.telegram.botToken ? [] : ['botToken'];
    }
    if (platform === 'qq') {
      const fields: string[] = [];
      if (!config.qq?.appId) fields.push('appId');
      if (!config.qq?.appSecret) fields.push('appSecret');
      return fields;
    }
    if (platform === 'wecom') {
      const fields: string[] = [];
      if (!config.wecom?.botId) fields.push('botId');
      if (!config.wecom?.secret) fields.push('secret');
      return fields;
    }
    return config.discord.botToken ? [] : ['botToken'];
  }

  private async runAuthProbe(platform: IMPlatform, config: IMGatewayConfig): Promise<string> {
    if (platform === 'dingtalk') {
      await getOapiAccessToken(config.dingtalk.clientId, config.dingtalk.clientSecret);
      return '钉钉鉴权通过。';
    }

    if (platform === 'feishu') {
      const Lark = await import('@larksuiteoapi/node-sdk');
      const domain = this.resolveFeishuDomain(config.feishu.domain, Lark);
      const client = new Lark.Client({
        appId: config.feishu.appId,
        appSecret: config.feishu.appSecret,
        appType: Lark.AppType.SelfBuild,
        domain,
      });
      let response: any;
      try {
        response = await client.request({
          method: 'GET',
          url: '/open-apis/bot/v3/info',
        });
      } catch (err: any) {
        // Lark's /bot/v3/info returns HTTP 400 + a business error body like
        // {"code":4040,"msg":"app_secret invalid"} when credentials are bad.
        // Surface that body instead of axios's generic "Request failed with
        // status code 400" so the user knows exactly what to fix.
        const httpStatus = err?.response?.status;
        const body = err?.response?.data;
        if (body && typeof body === 'object' && typeof body.code === 'number') {
          throw new Error(`Lark error ${body.code}: ${body.msg || 'unknown'}`);
        }
        const bodyText = body ? (typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 300) : '';
        throw new Error(`${err.message}${httpStatus ? ` (HTTP ${httpStatus})` : ''}${bodyText ? ` body=${bodyText}` : ''}`);
      }
      if (response.code !== 0) {
        throw new Error(response.msg || `code ${response.code}`);
      }
      // The real Lark response is {code, msg, bot: {app_name, open_id, ...}} —
      // not wrapped under `data`. Read the top-level `bot` field first and
      // keep the old `data.*` paths as legacy fallbacks.
      const bot = response.bot ?? response.data?.bot ?? response.data;
      const botName = bot?.app_name ?? response.data?.app_name ?? 'unknown';
      const isLark = config.feishu.domain === 'lark';
      return `${isLark ? 'Lark' : '飞书'}鉴权通过（Bot: ${botName}）。`;
    }

    if (platform === 'telegram') {
      const response = await fetchJsonWithTimeout<TelegramGetMeResponse>(
        `https://api.telegram.org/bot${config.telegram.botToken}/getMe`,
        {},
        CONNECTIVITY_TIMEOUT_MS
      );
      if (!response.ok) {
        const description = response.description || 'unknown error';
        throw new Error(description);
      }
      const username = response.result?.username ? `@${response.result.username}` : 'unknown';
      return `Telegram 鉴权通过（Bot: ${username}）。`;
    }

    if (platform === 'wecom') {
      const { botId, secret } = config.wecom;
      if (!botId || !secret) {
        throw new Error('配置不完整');
      }
      // Create a temporary WSClient to verify authentication
      const { WSClient } = await import('@wecom/aibot-node-sdk');
      const tmpClient = new WSClient({ botId, secret, maxReconnectAttempts: 0 });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('企业微信鉴权超时（10s）'));
          }, CONNECTIVITY_TIMEOUT_MS);
          tmpClient.on('authenticated', () => {
            clearTimeout(timer);
            resolve();
          });
          tmpClient.on('error', (err: Error) => {
            clearTimeout(timer);
            reject(err);
          });
          tmpClient.connect();
        });
        return `企业微信鉴权通过（Bot ID: ${botId}）。`;
      } finally {
        try { tmpClient.disconnect(); } catch (_) { /* ignore */ }
      }
    }

    if (platform === 'discord') {
      const response = await fetchJsonWithTimeout<DiscordUserResponse>('https://discord.com/api/v10/users/@me', {
        headers: {
          Authorization: `Bot ${config.discord.botToken}`,
        },
      }, CONNECTIVITY_TIMEOUT_MS);
      const username = response.username ? `${response.username}#${response.discriminator || '0000'}` : 'unknown';
      return `Discord 鉴权通过（Bot: ${username}）。`;
    }

    if (platform === 'qq') {
      const { appId, appSecret } = config.qq;
      if (!appId || !appSecret) {
        throw new Error('配置不完整');
      }
      // Verify credentials by requesting an AccessToken directly via HTTP
      // This avoids starting a full WebSocket connection just for auth check
      const tokenResponse = await fetchJsonWithTimeout<{ access_token?: string; expires_in?: number; code?: number; message?: string }>(
        'https://bots.qq.com/app/getAppAccessToken',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId, clientSecret: appSecret }),
        },
        CONNECTIVITY_TIMEOUT_MS
      );
      if (!tokenResponse.access_token) {
        throw new Error(tokenResponse.message || '获取 AccessToken 失败');
      }
      return `QQ 鉴权通过（AccessToken 已获取）。`;
    }

    return '未知平台。';
  }


  private resolveFeishuDomain(domain: string, Lark: any): any {
    if (domain === 'lark') return Lark.Domain.Lark;
    if (domain === 'feishu') return Lark.Domain.Feishu;
    return domain.replace(/\/+$/, '');
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutError: string): Promise<T> {
    let timeoutId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<T>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error(timeoutError)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
  }

  private getStartedAtMs(platform: IMPlatform, status: IMGatewayStatus): number | null {
    if (platform === 'feishu') {
      return status.feishu.startedAt ? Date.parse(status.feishu.startedAt) : null;
    }
    if (platform === 'dingtalk') return status.dingtalk.startedAt;
    if (platform === 'telegram') return status.telegram.startedAt;
    if (platform === 'qq') return status.qq.startedAt;
    if (platform === 'wecom') return status.wecom.startedAt;
    return status.discord.startedAt;
  }

  private getLastInboundAt(platform: IMPlatform, status: IMGatewayStatus): number | null {
    if (platform === 'dingtalk') return status.dingtalk.lastInboundAt;
    if (platform === 'feishu') return status.feishu.lastInboundAt;
    if (platform === 'telegram') return status.telegram.lastInboundAt;
    if (platform === 'qq') return status.qq.lastInboundAt;
    if (platform === 'wecom') return status.wecom.lastInboundAt;
    return status.discord.lastInboundAt;
  }

  private getLastOutboundAt(platform: IMPlatform, status: IMGatewayStatus): number | null {
    if (platform === 'dingtalk') return status.dingtalk.lastOutboundAt;
    if (platform === 'feishu') return status.feishu.lastOutboundAt;
    if (platform === 'telegram') return status.telegram.lastOutboundAt;
    if (platform === 'qq') return status.qq.lastOutboundAt;
    if (platform === 'wecom') return status.wecom.lastOutboundAt;
    return status.discord.lastOutboundAt;
  }

  private getLastError(platform: IMPlatform, status: IMGatewayStatus): string | null {
    if (platform === 'dingtalk') return status.dingtalk.lastError;
    if (platform === 'feishu') return status.feishu.error;
    if (platform === 'telegram') return status.telegram.lastError;
    if (platform === 'qq') return status.qq.lastError;
    if (platform === 'wecom') return status.wecom.lastError;
    return status.discord.lastError;
  }

  private calculateVerdict(checks: IMConnectivityCheck[]): IMConnectivityVerdict {
    if (checks.some((check) => check.level === 'fail')) {
      return 'fail';
    }
    if (checks.some((check) => check.level === 'warn')) {
      return 'warn';
    }
    return 'pass';
  }
}
