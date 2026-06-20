import React from 'react';
import { i18nService } from '../../services/i18n';

const ICONS: Record<string, string> = {
  x: '🐦',
  douyin: '🎵',
  tiktok: '📱',
  youtube: '📺',
};

const LABEL_KEYS: Record<string, string> = {
  x: 'scenarioPlatformX',
  douyin: 'scenarioPlatformDouyin',
  tiktok: 'scenarioPlatformTiktok',
  youtube: 'scenarioPlatformYoutube',
};

interface Props {
  platform: string;
}

export const PlatformPlaceholder: React.FC<Props> = ({ platform }) => {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center max-w-md">
        <div className="text-6xl mb-4">{ICONS[platform] || '🚧'}</div>
        <h3 className="text-xl font-bold dark:text-white mb-2">
          {i18nService.t(LABEL_KEYS[platform] || 'scenarioPlatformSoon')}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          {i18nService.t('scenarioPlatformSoonHint')}
        </p>
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-green-500/30 bg-green-500/10 text-green-400 text-sm">
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          {i18nService.t('scenarioPlatformSoon')}
        </div>
      </div>
    </div>
  );
};

export default PlatformPlaceholder;
