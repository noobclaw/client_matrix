// IM platform categories
export const CHINA_IM_PLATFORMS = ['dingtalk', 'feishu', 'wecom', 'qq'] as const;
export const GLOBAL_IM_PLATFORMS = ['telegram', 'discord'] as const;

// Platforms supported for push notifications (scheduled tasks etc., feishu also covers Lark)
export const NOTIFY_IM_PLATFORMS = ['telegram', 'feishu', 'lark', 'dingtalk'] as const;

/**
 * Get visible IM platforms based on language (for settings page)
 */
export const getVisibleIMPlatforms = (_language: string): readonly string[] => {
  // Show all platforms for all languages
  return [...CHINA_IM_PLATFORMS, ...GLOBAL_IM_PLATFORMS];
};

/**
 * Get available IM platforms for push notifications (for scheduled tasks etc.)
 */
export const getNotifyIMPlatforms = (): readonly string[] => {
  return NOTIFY_IM_PLATFORMS;
};
