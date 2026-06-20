import { join } from 'path';
import { isPackaged, getAppPath, getResourcesPath } from './platformAdapter';
import type { SqliteStore } from '../sqliteStore';
import type { CoworkApiConfig } from './coworkConfigStore';
import {
  configureCoworkOpenAICompatProxy,
  type OpenAICompatProxyTarget,
  getCoworkOpenAICompatProxyBaseURL,
  getCoworkOpenAICompatProxyStatus,
} from './coworkOpenAICompatProxy';
import { normalizeProviderApiFormat, type AnthropicApiFormat } from './coworkFormatTransform';

const ZHIPU_CODING_PLAN_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
// Qwen Coding Plan dedicated endpoints (OpenAI compatible and Anthropic compatible)
const QWEN_CODING_PLAN_OPENAI_BASE_URL = 'https://coding.dashscope.aliyuncs.com/v1';
const QWEN_CODING_PLAN_ANTHROPIC_BASE_URL = 'https://coding.dashscope.aliyuncs.com/apps/anthropic';
// Volcengine Coding Plan dedicated endpoints (OpenAI compatible and Anthropic compatible)
const VOLCENGINE_CODING_PLAN_OPENAI_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
const VOLCENGINE_CODING_PLAN_ANTHROPIC_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding';
// Moonshot/Kimi Coding Plan dedicated endpoints (OpenAI compatible and Anthropic compatible)
const MOONSHOT_CODING_PLAN_OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1';
const MOONSHOT_CODING_PLAN_ANTHROPIC_BASE_URL = 'https://api.kimi.com/coding';

type ProviderModel = {
  id: string;
};

type ProviderConfig = {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai' | 'native';
  codingPlanEnabled?: boolean;
  models?: ProviderModel[];
};

type AppConfig = {
  model?: {
    defaultModel?: string;
    defaultModelProvider?: string;
  };
  providers?: Record<string, ProviderConfig>;
  app?: {
    useNoobClawServer?: boolean;
    testMode?: boolean;
  };
};

export type ApiConfigResolution = {
  config: CoworkApiConfig | null;
  error?: string;
};

// NoobClaw JWT auth token (set by renderer via IPC when user logs in/out).
//
// Storage layering:
//   1. macOS Tauri sidecar with the native addon loaded → keychain
//      (com.noobclaw.desktop / noobclaw-jwt) via the Security framework.
//      This is the preferred path — tokens are no longer plaintext in
//      the user's SQLite file.
//   2. Everything else (Electron, Windows, Linux, dev builds without
//      the .node addon) → SQLite kv store. Same `NOOBCLAW_AUTH_TOKEN_KEY`
//      as before so existing users don't lose their login.
//
// On macOS we try keychain first on read, and if it misses we also
// check SQLite — this lets the migration from plaintext SQLite →
// keychain happen transparently on first launch (if a token is found
// in SQLite it'll be promoted to keychain and deleted from SQLite).
const NOOBCLAW_AUTH_TOKEN_KEY = 'noobclaw_auth_token';
const KEYCHAIN_ACCOUNT = 'noobclaw-jwt';

let _noobClawAuthToken: string | null = null;
let _authTokenHydrated = false;

function hydrateAuthTokenFromStore(): void {
  if (_authTokenHydrated) return;

  // Try keychain first on macOS. Lazy-require to avoid a circular import
  // at module load time (nativeDesktopMac → coworkLogger → … → here).
  if (process.platform === 'darwin') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { nativeKeychainGet } = require('./nativeDesktopMac');
      const kc = nativeKeychainGet(KEYCHAIN_ACCOUNT);
      if (typeof kc === 'string' && kc) {
        _noobClawAuthToken = kc;
        _authTokenHydrated = true;
        return;
      }
    } catch {
      /* native addon not loaded — fall through to SQLite */
    }
  }

  const sqliteStore = getStore();
  if (!sqliteStore) return; // store not ready yet; retry on next call
  try {
    const persisted = sqliteStore.get<string>(NOOBCLAW_AUTH_TOKEN_KEY);
    if (typeof persisted === 'string' && persisted) {
      _noobClawAuthToken = persisted;
      // One-shot migration: promote any SQLite-persisted token to
      // keychain, then clear the SQLite copy so the plaintext doesn't
      // linger. Silent on failure — the next setNoobClawAuthToken()
      // call will retry.
      if (process.platform === 'darwin') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { nativeKeychainSet } = require('./nativeDesktopMac');
          if (nativeKeychainSet(KEYCHAIN_ACCOUNT, persisted)) {
            try { sqliteStore.delete(NOOBCLAW_AUTH_TOKEN_KEY); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    }
  } catch {
    /* ignore — treat as no persisted token */
  }
  _authTokenHydrated = true;
}

export function getNoobClawAuthToken(): string | null {
  hydrateAuthTokenFromStore();
  return _noobClawAuthToken;
}

export function setNoobClawAuthToken(token: string | null): void {
  _noobClawAuthToken = token;
  _authTokenHydrated = true;

  // macOS: write to keychain. On failure, fall through to SQLite so
  // persistence still works on dev builds without the native addon.
  let keychainOk = false;
  if (process.platform === 'darwin') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { nativeKeychainSet, nativeKeychainDelete } = require('./nativeDesktopMac');
      if (token) {
        keychainOk = nativeKeychainSet(KEYCHAIN_ACCOUNT, token);
      } else {
        keychainOk = nativeKeychainDelete(KEYCHAIN_ACCOUNT);
      }
    } catch {
      /* native addon not loaded */
    }
  }

  // SQLite fallback (and also: keep the legacy row in sync when the
  // native addon isn't present, so existing callers keep working).
  if (!keychainOk) {
    const sqliteStore = getStore();
    if (sqliteStore) {
      try {
        if (token) {
          sqliteStore.set(NOOBCLAW_AUTH_TOKEN_KEY, token);
        } else {
          sqliteStore.delete(NOOBCLAW_AUTH_TOKEN_KEY);
        }
      } catch {
        /* ignore — renderer will re-sync on next restart */
      }
    }
  } else {
    // Keychain write succeeded — also clear any stale SQLite entry so
    // we don't keep a plaintext copy around forever.
    const sqliteStore = getStore();
    if (sqliteStore) {
      try { sqliteStore.delete(NOOBCLAW_AUTH_TOKEN_KEY); } catch { /* ignore */ }
    }
  }
}

// Store getter function injected from main.ts
let storeGetter: (() => SqliteStore | null) | null = null;

export function setStoreGetter(getter: () => SqliteStore | null): void {
  storeGetter = getter;
}

const getStore = (): SqliteStore | null => {
  if (!storeGetter) {
    return null;
  }
  return storeGetter();
};

export function getClaudeCodePath(): string {
  if (isPackaged()) {
    return join(
      getResourcesPath(),
      'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/cli.js'
    );
  }

  // In development, try to find the SDK in the project root node_modules
  const appPath = getAppPath();
  const rootDir = appPath.endsWith('dist-electron')
    ? join(appPath, '..')
    : appPath;

  return join(rootDir, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js');
}

type MatchedProvider = {
  providerName: string;
  providerConfig: ProviderConfig;
  modelId: string;
  apiFormat: AnthropicApiFormat;
  baseURL: string;
};

function getEffectiveProviderApiFormat(providerName: string, apiFormat: unknown): AnthropicApiFormat {
  if (providerName === 'openai' || providerName === 'gemini' || providerName === 'stepfun' || providerName === 'noobclawAI') {
    return 'openai';
  }
  if (providerName === 'anthropic') {
    return 'anthropic';
  }
  return normalizeProviderApiFormat(apiFormat);
}

function providerRequiresApiKey(providerName: string): boolean {
  // noobclawAI uses JWT authentication, no API Key needed
  return providerName !== 'ollama' && providerName !== 'noobclawAI';
}

function resolveMatchedProvider(appConfig: AppConfig): { matched: MatchedProvider | null; error?: string } {
  const providers = appConfig.providers ?? {};

  // When server mode is on, always route through our backend (ignore stored baseUrl)
  const useNoobClawServer = appConfig.app?.useNoobClawServer !== false;
  if (useNoobClawServer) {
    const noobConfig = (providers['noobclawAI'] || {}) as ProviderConfig;
    // Detect test mode.
    //
    // In Tauri sidecar mode (identified by `--tauri-pid=<PID>` argv added
    // by src-tauri/src/lib.rs), the ONLY valid test-mode signal is the
    // explicit NOOBCLAW_TEST_MODE=1 environment variable. We deliberately
    // ignore both `appConfig.app.testMode` and the stored
    // noobclawAI.baseUrl heuristic in this branch because a historic
    // config.ts bug on macOS WKWebView (hostname === 'localhost' under
    // `tauri://`) wrote `testMode: true` + `noobclawAI.baseUrl: http://
    // 127.0.0.1:3001/...` into every Mac user's SQLite store. That
    // poison persists across app launches and silently routed all AI
    // calls, the wallet-connect URL, and the backend API to a dead
    // local port — surfacing to the user as "chat invisible / lucky
    // bag invisible / wallet opens 127.0.0.1 / Lark API configuration
    // not found". Locking the Tauri branch to env-var-only breaks any
    // dev who was relying on stored testMode, but they can re-enable
    // it with `NOOBCLAW_TEST_MODE=1 tauri dev`.
    //
    // In Electron mode the legacy behavior is preserved so existing
    // Electron test-mode flows keep working.
    const isTauriSidecar = process.argv.some((a) => a.startsWith('--tauri-pid='));
    const storedBaseUrl = typeof noobConfig.baseUrl === 'string' ? noobConfig.baseUrl : '';
    const storedBaseUrlLooksLikeTest = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(storedBaseUrl);
    const testMode = isTauriSidecar
      ? process.env.NOOBCLAW_TEST_MODE === '1'
      : process.env.NOOBCLAW_TEST_MODE === '1'
        || appConfig.app?.testMode === true
        || storedBaseUrlLooksLikeTest;
    const backendBase = testMode ? 'http://127.0.0.1:3001' : 'https://api.noobclaw.com';
    const baseURL = `${backendBase}/api/ai/chat/completions`;
    // Use the user's selected model from config, not always the first model
    const modelId = appConfig.model?.defaultModel || noobConfig.models?.[0]?.id || 'noobclawai-chat';
    return {
      matched: {
        providerName: 'noobclawAI',
        providerConfig: noobConfig,
        modelId,
        baseURL,
        apiFormat: 'openai',
      },
    };
  }

  // When server mode is off, skip NoobClaw providers to avoid accidentally routing
  // through them when a third-party provider with the same model name is configured.
  const isNoobClawProvider = (name: string) =>
    name === 'noobclawAI' || name === 'noobclawAI';

  const resolveFallbackModel = (): string | undefined => {
    for (const [name, provider] of Object.entries(providers)) {
      if (isNoobClawProvider(name)) continue;
      if (!provider?.enabled || !provider.models || provider.models.length === 0) {
        continue;
      }
      return provider.models[0].id;
    }
    return undefined;
  };

  const modelId = appConfig.model?.defaultModel || resolveFallbackModel();
  if (!modelId) {
    return { matched: null, error: 'No available model configured in enabled providers.' };
  }

  let providerEntry: [string, ProviderConfig] | undefined;
  const preferredProviderName = appConfig.model?.defaultModelProvider?.trim();
  if (preferredProviderName && !isNoobClawProvider(preferredProviderName)) {
    const preferredProvider = providers[preferredProviderName];
    if (
      preferredProvider?.enabled
      && preferredProvider.models?.some((model) => model.id === modelId)
    ) {
      providerEntry = [preferredProviderName, preferredProvider];
    }
  }

  if (!providerEntry) {
    providerEntry = Object.entries(providers).find(([name, provider]) => {
      if (isNoobClawProvider(name)) return false;
      if (!provider?.enabled || !provider.models) {
        return false;
      }
      return provider.models.some((model) => model.id === modelId);
    });
  }

  if (!providerEntry) {
    return { matched: null, error: `No enabled provider found for model: ${modelId}` };
  }

  const [providerName, providerConfig] = providerEntry;
  let apiFormat = getEffectiveProviderApiFormat(providerName, providerConfig.apiFormat);
  let baseURL = providerConfig.baseUrl?.trim();

  // Handle Zhipu GLM Coding Plan endpoint switch
  if (providerName === 'zhipu' && providerConfig.codingPlanEnabled) {
    baseURL = ZHIPU_CODING_PLAN_BASE_URL;
    apiFormat = 'openai';
  }

  // Handle Qwen Coding Plan endpoint switch
  // Coding Plan supports both OpenAI and Anthropic compatible formats
  if (providerName === 'qwen' && providerConfig.codingPlanEnabled) {
    if (apiFormat === 'anthropic') {
      baseURL = QWEN_CODING_PLAN_ANTHROPIC_BASE_URL;
    } else {
      baseURL = QWEN_CODING_PLAN_OPENAI_BASE_URL;
      apiFormat = 'openai';
    }
  }

  // Handle Volcengine Coding Plan endpoint switch
  // Coding Plan supports both OpenAI and Anthropic compatible formats
  if (providerName === 'volcengine' && providerConfig.codingPlanEnabled) {
    if (apiFormat === 'anthropic') {
      baseURL = VOLCENGINE_CODING_PLAN_ANTHROPIC_BASE_URL;
    } else {
      baseURL = VOLCENGINE_CODING_PLAN_OPENAI_BASE_URL;
      apiFormat = 'openai';
    }
  }

  // Handle Moonshot/Kimi Coding Plan endpoint switch
  // Coding Plan supports both OpenAI and Anthropic compatible formats
  if (providerName === 'moonshot' && providerConfig.codingPlanEnabled) {
    if (apiFormat === 'anthropic') {
      baseURL = MOONSHOT_CODING_PLAN_ANTHROPIC_BASE_URL;
    } else {
      baseURL = MOONSHOT_CODING_PLAN_OPENAI_BASE_URL;
      apiFormat = 'openai';
    }
  }

  if (!baseURL) {
    return { matched: null, error: `Provider ${providerName} is missing base URL.` };
  }

  if (apiFormat === 'anthropic' && providerRequiresApiKey(providerName) && !providerConfig.apiKey?.trim()) {
    return { matched: null, error: `Provider ${providerName} requires API key for Anthropic-compatible mode.` };
  }

  return {
    matched: {
      providerName,
      providerConfig,
      modelId,
      apiFormat,
      baseURL,
    },
  };
}

export function resolveCurrentApiConfig(target: OpenAICompatProxyTarget = 'local'): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return {
      config: null,
      error: 'Store is not initialized.',
    };
  }

  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig) {
    return {
      config: null,
      error: 'Application config not found.',
    };
  }

  const { matched, error } = resolveMatchedProvider(appConfig);
  if (!matched) {
    return {
      config: null,
      error,
    };
  }

  const resolvedBaseURL = matched.baseURL;
  const resolvedApiKey = matched.providerConfig.apiKey?.trim() || '';
  // noobclawAI uses JWT auth instead of a static API key.
  // Hydrate from store here so sidecar-only restarts (Lark-triggered
  // sessions arriving before the renderer re-syncs via IPC) still see
  // the last known token.
  if (matched.providerName === 'noobclawAI') {
    hydrateAuthTokenFromStore();
    if (!_noobClawAuthToken) {
      return { config: null, error: 'Missing auth token — please connect your wallet to use NoobClaw AI.' };
    }
  }
  const effectiveApiKey = matched.providerName === 'noobclawAI'
    ? (_noobClawAuthToken || '')
    : matched.providerName === 'ollama'
      && matched.apiFormat === 'anthropic'
      && !resolvedApiKey
      ? 'sk-ollama-local'
      : resolvedApiKey;

  if (matched.apiFormat === 'anthropic') {
    return {
      config: {
        apiKey: effectiveApiKey,
        baseURL: resolvedBaseURL,
        model: matched.modelId,
        apiType: 'anthropic',
      },
    };
  }

  // Try OpenAI compatibility proxy first (Electron mode)
  const proxyStatus = getCoworkOpenAICompatProxyStatus();
  if (proxyStatus.running) {
    configureCoworkOpenAICompatProxy({
      baseURL: resolvedBaseURL,
      apiKey: effectiveApiKey || undefined,
      model: matched.modelId,
      provider: matched.providerName,
    });

    const proxyBaseURL = getCoworkOpenAICompatProxyBaseURL(target);
    if (proxyBaseURL) {
      // NOTE: `isOpenAICompat: true` MUST be set here even though the
      // Anthropic SDK is the caller. The proxy translates between
      // Anthropic and OpenAI payload shapes internally, and several
      // downstream code paths use this flag to:
      //   - queryEngine.ts:558 → take the non-streaming codepath so
      //     the SDK's MessageStream.js doesn't crash on the proxy's
      //     message_start event (which lacks a `content: []` field,
      //     causing `this._currentMessage.content.push(...)` to throw
      //     "Cannot read properties of undefined (reading 'push')").
      //   - anthropicClient.ts:64 → skip the SDK's model validation
      //     round-trip (proxy returns 404 for /v1/models).
      //   - createMessageStream → strip cache_control / thinking /
      //     beta headers the proxy doesn't understand.
      // Forgetting this flag here is what made noobclawAI chat hang
      // silently on macOS packaged builds after Event #2.
      return {
        config: {
          apiKey: resolvedApiKey || 'noobclaw-openai-compat',
          baseURL: proxyBaseURL,
          model: matched.modelId,
          apiType: 'openai',
          isOpenAICompat: true,
        } as any,
      };
    }
  }

  // Fallback: return OpenAI-compat config directly (sidecar mode without proxy)
  // queryEngine's isOpenAICompat path will handle the request format conversion
  return {
    config: {
      apiKey: effectiveApiKey || resolvedApiKey,
      baseURL: resolvedBaseURL,
      model: matched.modelId,
      apiType: 'openai',
      isOpenAICompat: true,
    } as any,
  };
}

export function getCurrentApiConfig(target: OpenAICompatProxyTarget = 'local'): CoworkApiConfig | null {
  return resolveCurrentApiConfig(target).config;
}

export function buildEnvForConfig(config: CoworkApiConfig): Record<string, string> {
  const baseEnv = { ...process.env } as Record<string, string>;

  baseEnv.ANTHROPIC_AUTH_TOKEN = config.apiKey;
  baseEnv.ANTHROPIC_API_KEY = config.apiKey;
  baseEnv.ANTHROPIC_BASE_URL = config.baseURL;
  baseEnv.ANTHROPIC_MODEL = config.model;

  return baseEnv;
}
