import { AppConfig, CONFIG_KEYS, defaultConfig } from '../config';
import { localStore } from './store';

const getFixedProviderApiFormat = (providerKey: string): 'anthropic' | 'openai' | null => {
  if (providerKey === 'openai' || providerKey === 'gemini' || providerKey === 'stepfun' || providerKey === 'noobclawAI') {
    return 'openai';
  }
  if (providerKey === 'anthropic') {
    return 'anthropic';
  }
  return null;
};

const normalizeProviderBaseUrl = (providerKey: string, baseUrl: unknown): string => {
  if (typeof baseUrl !== 'string') {
    return '';
  }

  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (providerKey !== 'gemini') {
    return normalized;
  }

  if (!normalized || !normalized.includes('generativelanguage.googleapis.com')) {
    return normalized;
  }

  if (normalized.endsWith('/v1beta/openai') || normalized.endsWith('/v1/openai')) {
    return normalized;
  }
  if (normalized.endsWith('/v1beta')) {
    return `${normalized}/openai`;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized.slice(0, -3)}v1beta/openai`;
  }

  return 'https://generativelanguage.googleapis.com/v1beta/openai';
};

const normalizeProviderApiFormat = (providerKey: string, apiFormat: unknown): 'anthropic' | 'openai' => {
  const fixed = getFixedProviderApiFormat(providerKey);
  if (fixed) {
    return fixed;
  }
  if (apiFormat === 'openai') {
    return 'openai';
  }
  return 'anthropic';
};

const normalizeProvidersConfig = (providers: AppConfig['providers']): AppConfig['providers'] => {
  if (!providers) {
    return providers;
  }

  return Object.fromEntries(
    Object.entries(providers).map(([providerKey, providerConfig]) => [
      providerKey,
      {
        ...providerConfig,
        baseUrl: normalizeProviderBaseUrl(providerKey, providerConfig.baseUrl),
        apiFormat: normalizeProviderApiFormat(providerKey, providerConfig.apiFormat),
      },
    ])
  ) as AppConfig['providers'];
};

class ConfigService {
  private config: AppConfig = defaultConfig;

  async init() {
    try {
      const storedConfig = await localStore.getItem<AppConfig>(CONFIG_KEYS.APP_CONFIG);
      if (!storedConfig) {
        // First boot: persist defaultConfig so the main process can read it from SQLite
        await localStore.setItem(CONFIG_KEYS.APP_CONFIG, this.config);
      } else if (storedConfig) {
        const mergedProviders = storedConfig.providers
          ? Object.fromEntries(
              Object.entries({
                ...(defaultConfig.providers ?? {}),
                ...storedConfig.providers,
              }).map(([providerKey, providerConfig]) => [
                providerKey,
                (() => {
                  const mergedProvider = {
                    ...(defaultConfig.providers as Record<string, any>)?.[providerKey],
                    ...providerConfig,
                  };
                  return {
                    ...mergedProvider,
                    baseUrl: normalizeProviderBaseUrl(providerKey, mergedProvider.baseUrl),
                    apiFormat: normalizeProviderApiFormat(providerKey, mergedProvider.apiFormat),
                  };
                })(),
              ])
            )
          : defaultConfig.providers;

        const mergedApp = {
          ...defaultConfig.app,
          ...storedConfig.app,
        };
        // When server mode is enabled, force noobclawAI to enabled and override baseUrl to prevent reading stale stored values
        const useNoobClawServer = mergedApp.useNoobClawServer !== false;
        if (mergedProviders?.['noobclawAI']) {
          const noobProvider = mergedProviders as Record<string, any>;
          if (useNoobClawServer) {
            noobProvider['noobclawAI'].enabled = true;
          }
          // Always override baseUrl to correct backend URL (ignore stale stored value)
          const buildTestMode = (import.meta as any).env?.VITE_TEST_MODE === 'true';
          const isTauri = !!(window as any).__TAURI__;
          let testMode = buildTestMode;
          // Tauri webviews serve the frontend from `tauri://localhost/`
          // (macOS WKWebView) or `http://tauri.localhost/` (Windows
          // WebView2). On macOS specifically `hostname === 'localhost'`
          // and the old check would falsely flip testMode = true, then
          // persist it, then cascade through every downstream call
          // (getWebsiteUrl / getBackendApiUrl / noobclawAI.baseUrl /
          // claudeSettings.resolveMatchedProvider) — breaking wallet
          // connect, AI chat, lucky bag, and Lark. Guard with both the
          // Tauri global and the scheme check so the bug cannot reappear
          // if Tauri ever changes its webview URL scheme on one platform.
          if (!testMode && !isTauri) {
            try {
              const h = window.location.hostname;
              const proto = window.location.protocol;
              if (
                proto !== 'file:' &&
                proto !== 'tauri:' &&
                (h === 'localhost' || h === '127.0.0.1')
              ) {
                testMode = true;
              }
            } catch {}
          }
          noobProvider['noobclawAI'].baseUrl = testMode
            ? 'http://127.0.0.1:3001/api/ai/chat/completions'
            : 'https://api.noobclaw.com/api/ai/chat/completions';
          // Sync effective testMode to stored config so that the main process
          // (which cannot access VITE_TEST_MODE) uses the correct backend URL.
          mergedApp.testMode = testMode;
        }

        this.config = {
          ...defaultConfig,
          ...storedConfig,
          api: {
            ...defaultConfig.api,
            ...storedConfig.api,
          },
          model: {
            ...defaultConfig.model,
            ...storedConfig.model,
          },
          app: mergedApp,
          shortcuts: {
            ...defaultConfig.shortcuts!,
            ...(storedConfig.shortcuts ?? {}),
          } as AppConfig['shortcuts'],
          providers: mergedProviders as AppConfig['providers'],
        };
        // Persist merged config so the main process reads correct testMode and baseUrl
        await localStore.setItem(CONFIG_KEYS.APP_CONFIG, this.config);
      }
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  }

  getConfig(): AppConfig {
    return this.config;
  }

  async updateConfig(newConfig: Partial<AppConfig>) {
    const normalizedProviders = normalizeProvidersConfig(newConfig.providers as AppConfig['providers'] | undefined);
    this.config = {
      ...this.config,
      ...newConfig,
      ...(normalizedProviders ? { providers: normalizedProviders } : {}),
    };
    await localStore.setItem(CONFIG_KEYS.APP_CONFIG, this.config);
  }

  getApiConfig() {
    return {
      apiKey: this.config.api.key,
      baseUrl: this.config.api.baseUrl,
    };
  }
}

export const configService = new ConfigService(); 
