/**
 * QuickAction type definitions
 * Used for homepage quick action feature
 */

/**
 * Preset prompt (raw structure, loaded from JSON)
 */
export interface Prompt {
  /** Unique identifier */
  id: string;
}

/**
 * Localized preset prompt (contains translated text)
 */
export interface LocalizedPrompt {
  /** Unique identifier */
  id: string;
  /** Display title */
  label: string;
  /** Short description */
  description?: string;
  /** Full prompt content */
  prompt: string;
}

/**
 * Quick action main item (raw structure, loaded from JSON)
 */
export interface QuickAction {
  /** Unique identifier */
  id: string;
  /** Icon name (Heroicons) */
  icon: string;
  /** Theme color (hex) */
  color: string;
  /** Maps to Skill ID */
  skillMapping: string;
  /** Preset prompt list */
  prompts: Prompt[];
}

/**
 * Localized quick action main item (contains translated text)
 */
export interface LocalizedQuickAction {
  /** Unique identifier */
  id: string;
  /** Display title */
  label: string;
  /** Icon name (Heroicons) */
  icon: string;
  /** Theme color (hex) */
  color: string;
  /** Maps to Skill ID */
  skillMapping: string;
  /** Preset prompt list (localized) */
  prompts: LocalizedPrompt[];
}

/**
 * Quick actions configuration (raw structure)
 */
export interface QuickActionsConfig {
  /** Configuration version */
  version: number;
  /** Quick action list */
  actions: QuickAction[];
}

/**
 * Internationalization configuration structure
 */
export interface QuickActionsI18n {
  zh: QuickActionsI18nData;
  en: QuickActionsI18nData;
  [key: string]: QuickActionsI18nData;
}

export interface QuickActionsI18nData {
  [actionId: string]: {
    label: string;
    prompts: {
      [promptId: string]: {
        label: string;
        description?: string;
        prompt: string;
      };
    };
  };
}
