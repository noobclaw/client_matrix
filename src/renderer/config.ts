// Configuration type definitions
export interface AppConfig {
  // API configuration
  api: {
    key: string;
    baseUrl: string;
  };
  // Model configuration
  model: {
    availableModels: Array<{
      id: string;
      name: string;
      supportsImage?: boolean;
    }>;
    defaultModel: string;
    defaultModelProvider?: string;
  };
  // Multi-model provider configuration
  providers?: {
    openai: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      // API protocol format: anthropic for Anthropic-compatible, openai for OpenAI-compatible
      apiFormat?: 'anthropic' | 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    deepseek: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    moonshot: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      /** Whether to enable Moonshot Coding Plan mode (uses dedicated Coding API endpoint) */
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    zhipu: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      /** Whether to enable GLM Coding Plan mode (uses dedicated Coding API endpoint) */
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    minimax: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    noobclawAI: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    qwen: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      /** Whether to enable Qwen Coding Plan mode (uses dedicated Coding API endpoint) */
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    openrouter: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    gemini: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    anthropic: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    volcengine: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      /** Whether to enable Volcengine Coding Plan mode (uses dedicated Coding API endpoint) */
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    xiaomi: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    stepfun: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    ollama: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    custom: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
    [key: string]: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      codingPlanEnabled?: boolean;
      models?: Array<{
        id: string;
        name: string;
        supportsImage?: boolean;
      }>;
    };
  };
  // Theme configuration
  theme: 'light' | 'dark' | 'system';
  // Language configuration
  language: string;
  // Whether to use system proxy
  useSystemProxy: boolean;
  // Language initialization flag (used to determine if this is the first launch)
  language_initialized?: boolean;
  // Application configuration
  app: {
    port: number;
    isDevelopment: boolean;
    testMode?: boolean;
    // true = use NoobClaw server (default); false = user configures own API Key
    useNoobClawServer?: boolean;
  };
  // AI assistant name (local storage, default Adia Laura)
  aiAssistantName?: string;
  // AI assistant avatar (base64 data URL, local storage)
  aiAssistantAvatar?: string;
  // Keyboard shortcuts configuration
  shortcuts?: {
    newChat: string;
    search: string;
    settings: string;
    [key: string]: string | undefined;
  };
}

// Default configuration
export const defaultConfig: AppConfig = {
  api: {
    key: '',
    baseUrl: 'https://api.deepseek.com/anthropic',
  },
  model: {
    availableModels: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', supportsImage: false },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
    ],
    defaultModel: 'noobclawai-chat',
    defaultModelProvider: 'noobclawAI',
  },
  providers: {
    openai: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.openai.com',
      apiFormat: 'openai',
      models: [
        { id: 'gpt-5.2-2025-12-11', name: 'GPT-5.2', supportsImage: true },
        { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', supportsImage: true }
      ]
    },
    gemini: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiFormat: 'openai',
      models: [
        { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', supportsImage: true },
        { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', supportsImage: true },
        { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', supportsImage: true }
      ]
    },
    anthropic: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.anthropic.com',
      apiFormat: 'anthropic',
      models: [
        { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', supportsImage: true },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', supportsImage: true },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', supportsImage: true }
      ]
    },
    deepseek: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
        { id: 'deepseek-chat', name: 'DeepSeek Chat', supportsImage: false }
      ]
    },
    moonshot: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      apiFormat: 'anthropic',
      codingPlanEnabled: false,
      models: [
        { id: 'kimi-k2.5', name: 'Kimi K2.5', supportsImage: true }
      ]
    },
    zhipu: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiFormat: 'anthropic',
      codingPlanEnabled: false,
      models: [
        { id: 'glm-5', name: 'GLM 5', supportsImage: false },
        { id: 'glm-4.7', name: 'GLM 4.7', supportsImage: false }
      ]
    },
    minimax: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', supportsImage: false },
        { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', supportsImage: false }
      ]
    },
    noobclawAI: {
      enabled: true,
      apiKey: '',
      // Dynamic backend URL: test builds use localhost:3001, production builds use online server
      // Note: actual URL is overridden at runtime in ConfigService.loadConfig()
      // to include Electron hostname detection. This is just the compile-time default.
      baseUrl: (import.meta.env.VITE_TEST_MODE === 'true'
        ? 'http://127.0.0.1:3001'
        : 'https://api.noobclaw.com') + '/api/ai/chat/completions',
      apiFormat: 'openai',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', supportsImage: false },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', supportsImage: false },
        { id: 'deepseek-inhouse-chat', name: 'DeepSeek Chat (安全)', supportsImage: false },
        { id: 'deepseek-inhouse-reasoner', name: 'DeepSeek Reasoner (安全)', supportsImage: false }
      ]
    },
    qwen: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
      apiFormat: 'anthropic',
      codingPlanEnabled: false,
      models: [
        { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', supportsImage: true },
        { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', supportsImage: false }
      ]
    },
    xiaomi: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.xiaomimimo.com/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'mimo-v2-flash', name: 'MiMo V2 Flash', supportsImage: false }
      ]
    },
    stepfun: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.stepfun.com/v1',
      apiFormat: 'openai',
      models: [
        { id: 'step-3.5-flash', name: 'Step 3.5 Flash', supportsImage: false }
      ]
    },
    volcengine: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible',
      apiFormat: 'anthropic',
      codingPlanEnabled: false,
      models: [
        { id: 'ark-code-latest', name: 'Auto', supportsImage: false },
        { id: 'doubao-seed-2-0-pro-260215', name: 'Doubao-Seed-2.0-pro', supportsImage: false },
        { id: 'doubao-seed-2-0-lite-260215', name: 'Doubao-Seed-2.0-lite', supportsImage: false },
        { id: 'doubao-seed-2-0-mini-260215', name: 'Doubao-Seed-2.0-mini', supportsImage: false }
      ]
    },
    openrouter: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://openrouter.ai/api',
      apiFormat: 'anthropic',
      models: [
        { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', supportsImage: true },
        { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', supportsImage: true },
        { id: 'openai/gpt-5.2-codex', name: 'GPT 5.2 Codex', supportsImage: true },
        { id: 'google/gemini-3-pro-preview', name: 'Gemini 3 Pro', supportsImage: true },
      ]
    },
    ollama: {
      enabled: false,
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
      apiFormat: 'openai',
      models: [
        { id: 'qwen3-coder-next', name: 'Qwen3-Coder-Next', supportsImage: false },
        { id: 'glm-4.7-flash', name: 'GLM 4.7 Flash', supportsImage: false }
      ]
    },
    custom: {
      enabled: false,
      apiKey: '',
      baseUrl: '',
      apiFormat: 'openai',
      models: []
    }
  },
  theme: 'system',
  language: 'zh',
  useSystemProxy: false,
  aiAssistantName: 'Adia Laura',
  app: {
    port: 3000,
    isDevelopment: process.env.NODE_ENV === 'development',
    // When VITE_TEST_MODE=true, even production builds use local services (test builds only)
    testMode: process.env.NODE_ENV === 'development' || import.meta.env.VITE_TEST_MODE === 'true',
    // Default to NoobClaw server, no user API Key configuration needed
    useNoobClawServer: true,
  },
  shortcuts: {
    newChat: 'Ctrl+N',
    search: 'Ctrl+F',
    settings: 'Ctrl+,',
  }
};

// Configuration storage keys
export const CONFIG_KEYS = {
  APP_CONFIG: 'app_config',
  AUTH: 'auth_state',
  CONVERSATIONS: 'conversations',
  PROVIDERS_EXPORT_KEY: 'providers_export_key',
  SKILLS: 'skills',
};

// Model provider categories
export const CHINA_PROVIDERS = ['deepseek', 'moonshot', 'qwen', 'zhipu', 'minimax', 'volcengine', 'noobclawAI', 'stepfun', 'xiaomi', 'ollama', 'custom'] as const;
export const GLOBAL_PROVIDERS = ['openai', 'gemini', 'anthropic', 'openrouter'] as const;
export const EN_PRIORITY_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;

/**
 * Get visible model providers based on language
 */
export const getVisibleProviders = (language: string): readonly string[] => {
  // Show all providers in development environment
  // if (import.meta.env.DEV) {
  //   return [...CHINA_PROVIDERS, ...GLOBAL_PROVIDERS];
  // }

  // Chinese -> China edition, English -> International edition
  if (language === 'zh') {
    return CHINA_PROVIDERS;
  }

  const orderedProviders = [
    ...EN_PRIORITY_PROVIDERS,
    ...CHINA_PROVIDERS,
    ...GLOBAL_PROVIDERS,
  ];
  const uniqueProviders = [...new Set(orderedProviders)];
  // Move ollama and custom to the end, with custom last
  for (const key of ['ollama', 'custom'] as const) {
    const idx = uniqueProviders.indexOf(key);
    if (idx !== -1) {
      uniqueProviders.splice(idx, 1);
      uniqueProviders.push(key);
    }
  }
  return uniqueProviders;
};
