/**
 * IM Gateway Types for Renderer Process
 * Mirrors src/main/im/types.ts for use in React components
 */

// ==================== DingTalk Types ====================

export interface DingTalkConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  robotCode?: string;
  corpId?: string;
  agentId?: string;
  messageType: 'markdown' | 'card';
  cardTemplateId?: string;
  debug?: boolean;
}

export interface DingTalkGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Feishu Types ====================

export interface FeishuConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark' | string;
  encryptKey?: string;
  verificationToken?: string;
  renderMode: 'text' | 'card';
  debug?: boolean;
  feishuAppId?: string;
  feishuAppSecret?: string;
  larkAppId?: string;
  larkAppSecret?: string;
}

export interface FeishuGatewayStatus {
  connected: boolean;
  startedAt: string | null;
  botOpenId: string | null;
  error: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Telegram Types ====================

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  allowedUserIds?: string[];
  debug?: boolean;
}

export interface TelegramGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botUsername: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Discord Types ====================

export interface DiscordConfig {
  enabled: boolean;
  botToken: string;
  debug?: boolean;
}

export interface DiscordGatewayStatus {
  connected: boolean;
  starting: boolean;
  startedAt: number | null;
  lastError: string | null;
  botUsername: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== QQ Types ====================

export interface QQConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  debug?: boolean;
}

export interface QQGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== WeCom Types ====================

export interface WecomConfig {
  enabled: boolean;
  botId: string;
  secret: string;
  debug?: boolean;
}

export interface WecomGatewayStatus {
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  botId: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

// ==================== Common IM Types ====================

export type IMPlatform = 'dingtalk' | 'feishu' | 'qq' | 'telegram' | 'discord' | 'wecom';

export interface IMGatewayConfig {
  dingtalk: DingTalkConfig;
  feishu: FeishuConfig;
  qq: QQConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  wecom: WecomConfig;
  settings: IMSettings;
}

export interface IMSettings {
  systemPrompt?: string;
  skillsEnabled: boolean;
  feishuAppId?: string;
  feishuAppSecret?: string;
  larkAppId?: string;
  larkAppSecret?: string;
}

export interface IMGatewayStatus {
  dingtalk: DingTalkGatewayStatus;
  feishu: FeishuGatewayStatus;
  qq: QQGatewayStatus;
  telegram: TelegramGatewayStatus;
  discord: DiscordGatewayStatus;
  wecom: WecomGatewayStatus;
}

// ==================== Media Attachment Types ====================

export type IMMediaType = 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';

export interface IMMediaAttachment {
  type: IMMediaType;
  localPath: string;          // Local path after download
  mimeType: string;           // MIME type
  fileName?: string;          // Original file name
  fileSize?: number;          // File size (bytes)
  width?: number;             // Image/video width
  height?: number;            // Image/video height
  duration?: number;          // Audio/video duration (seconds)
}

export interface IMMessage {
  platform: IMPlatform;
  messageId: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  content: string;
  chatType: 'direct' | 'group';
  timestamp: number;
  attachments?: IMMediaAttachment[];
  mediaGroupId?: string;      // Media group ID (for combining multiple images)
}

// ==================== IPC Result Types ====================

export interface IMConfigResult {
  success: boolean;
  config?: IMGatewayConfig;
  error?: string;
}

export interface IMStatusResult {
  success: boolean;
  status?: IMGatewayStatus;
  error?: string;
}

export interface IMGatewayResult {
  success: boolean;
  error?: string;
}

// ==================== Connectivity Test Types ====================

export type IMConnectivityVerdict = 'pass' | 'warn' | 'fail';

export type IMConnectivityCheckLevel = 'pass' | 'info' | 'warn' | 'fail';

export type IMConnectivityCheckCode =
  | 'missing_credentials'
  | 'auth_check'
  | 'gateway_running'
  | 'inbound_activity'
  | 'outbound_activity'
  | 'platform_last_error'
  | 'feishu_group_requires_mention'
  | 'feishu_event_subscription_required'
  | 'discord_group_requires_mention'
  | 'telegram_privacy_mode_hint'
  | 'dingtalk_bot_membership_hint'
  | 'qq_guild_mention_hint'
  | 'wecom_websocket_hint';

export interface IMConnectivityCheck {
  code: IMConnectivityCheckCode;
  level: IMConnectivityCheckLevel;
  message: string;
  suggestion?: string;
}

export interface IMConnectivityTestResult {
  platform: IMPlatform;
  testedAt: number;
  verdict: IMConnectivityVerdict;
  checks: IMConnectivityCheck[];
}

export interface IMConnectivityTestResponse {
  success: boolean;
  result?: IMConnectivityTestResult;
  error?: string;
}

// ==================== Default Configurations ====================

export const DEFAULT_DINGTALK_CONFIG: DingTalkConfig = {
  enabled: false,
  clientId: '',
  clientSecret: '',
  messageType: 'markdown',
  debug: true,
};

export const DEFAULT_FEISHU_CONFIG: FeishuConfig = {
  enabled: false,
  appId: '',
  appSecret: '',
  domain: 'feishu',
  renderMode: 'card',
  debug: true,
};

export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  enabled: false,
  botToken: '',
  allowedUserIds: [],
  debug: true,
};

export const DEFAULT_DISCORD_CONFIG: DiscordConfig = {
  enabled: false,
  botToken: '',
  debug: true,
};

export const DEFAULT_QQ_CONFIG: QQConfig = {
  enabled: false,
  appId: '',
  appSecret: '',
  debug: true,
};

export const DEFAULT_WECOM_CONFIG: WecomConfig = {
  enabled: false,
  botId: '',
  secret: '',
  debug: true,
};

export const DEFAULT_IM_SETTINGS: IMSettings = {
  systemPrompt: '',
  skillsEnabled: true,
};

export const DEFAULT_IM_CONFIG: IMGatewayConfig = {
  dingtalk: DEFAULT_DINGTALK_CONFIG,
  feishu: DEFAULT_FEISHU_CONFIG,
  qq: DEFAULT_QQ_CONFIG,
  telegram: DEFAULT_TELEGRAM_CONFIG,
  discord: DEFAULT_DISCORD_CONFIG,
  wecom: DEFAULT_WECOM_CONFIG,
  settings: DEFAULT_IM_SETTINGS,
};

export const DEFAULT_IM_STATUS: IMGatewayStatus = {
  dingtalk: {
    connected: false,
    startedAt: null,
    lastError: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  feishu: {
    connected: false,
    startedAt: null,
    botOpenId: null,
    error: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  telegram: {
    connected: false,
    startedAt: null,
    lastError: null,
    botUsername: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  discord: {
    connected: false,
    starting: false,
    startedAt: null,
    lastError: null,
    botUsername: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  qq: {
    connected: false,
    startedAt: null,
    lastError: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
  wecom: {
    connected: false,
    startedAt: null,
    lastError: null,
    botId: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  },
};
