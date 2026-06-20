/**
 * Reusable wallet info chip — BSC icon + truncated address + token balance +
 * always-visible top-up button. Used in:
 *   - CoworkView toolbar
 *   - CoworkSessionDetail toolbar
 *   - ScenarioView toolbar
 *
 * Click on top-up dispatches the global 'noobclaw:show-wallet' event which
 * the App-level listener wires to switching to the My Wallet page.
 *
 * If user is not authenticated, renders a single "connect wallet" button.
 */

import React from 'react';
import { i18nService } from '../../services/i18n';
import { noobClawAuth } from '../../services/noobclawAuth';

function formatAddr(addr: string) {
  if (!addr || addr.length <= 10) return addr || '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

interface Props {
  /** 'normal' (default, used in main toolbars) | 'compact' (smaller for tighter bars) */
  size?: 'normal' | 'compact';
}

export const WalletBadge: React.FC<Props> = ({ size = 'normal' }) => {
  const [authState, setAuthState] = React.useState(noobClawAuth.getState());
  React.useEffect(() => {
    const unsubscribe = noobClawAuth.subscribe(s => setAuthState(s));
    return unsubscribe;
  }, []);

  const isZh = i18nService.currentLanguage === 'zh';
  const compact = size === 'compact';
  const txt = compact ? 'text-[10px]' : 'text-xs';

  if (!authState.isAuthenticated || !authState.walletAddress) {
    return (
      <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg dark:bg-claude-darkSurface bg-claude-surface`}>
        <img src="bsc.svg" alt="BSC" className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
        <span className={`${txt} font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary`}>BSC</span>
        <button
          type="button"
          onClick={() => noobClawAuth.requireLoginUI()}
          className={`non-draggable px-2 py-0.5 rounded ${txt} font-semibold bg-claude-accent text-white hover:bg-claude-accentHover transition-colors`}
        >
          {i18nService.t('coworkConnectWallet')}
        </button>
      </div>
    );
  }

  const low = authState.tokenBalance < 1000;
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg dark:bg-claude-darkSurface bg-claude-surface`}>
      <img src="bsc.svg" alt="BSC" className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
      <span className={`${txt} font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary`}>BSC</span>
      <span className={`${txt} font-mono dark:text-claude-darkText text-claude-text`}>
        {formatAddr(authState.walletAddress)}
      </span>
      <span className={`${txt} dark:text-claude-darkTextSecondary text-claude-textSecondary`}>|</span>
      <span className={`${txt} font-semibold ${low ? 'text-red-500' : 'dark:text-claude-darkText text-claude-text'}`}>
        {i18nService.t('coworkTokenBalance', { n: authState.tokenBalance.toLocaleString() })}
      </span>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('noobclaw:show-wallet'))}
        className={`non-draggable px-3 py-1 rounded text-sm font-bold transition-colors shadow-sm ${
          low
            ? 'bg-yellow-500 text-white hover:bg-yellow-600 shadow-yellow-500/30'
            : 'bg-green-500 text-white hover:bg-green-600 shadow-green-500/30'
        }`}
        title={isZh ? '点击去「我的充值」' : 'Open Top Up'}
      >
        {low ? i18nService.t('coworkLowBalance') : (isZh ? '💰 充值' : '💰 Top up')}
      </button>
    </div>
  );
};
