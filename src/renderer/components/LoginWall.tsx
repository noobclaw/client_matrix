import React from 'react';
import { noobClawAuth } from '../services/noobclawAuth';
import { i18nService } from '../services/i18n';

interface LoginWallProps {
  onDismiss?: () => void;
  // Kept for prop-shape compatibility with App.tsx; the "Skip login + use
  // your own API key" path was removed at user request, so this is unused.
  onSwitchToCustomApi?: () => void;
}

export const LoginWall: React.FC<LoginWallProps> = ({ onDismiss }) => {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm mx-4 p-8 rounded-2xl border border-green-500/30 dark:bg-[#12121a] bg-white shadow-2xl text-center relative">
        {/* Close (X) — top-right */}
        <button
          onClick={onDismiss}
          aria-label="Close"
          className="absolute top-3 right-3 w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-white dark:hover:bg-white/5 hover:bg-gray-100 transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>

        {/* Logo */}
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl overflow-hidden">
          <img src="logo.png" alt="NoobClaw" className="w-full h-full object-cover" />
        </div>

        <h2 className="text-xl font-bold dark:text-white text-gray-900 mb-2">
          {i18nService.t('loginWallTitle')}
        </h2>
        <p className="dark:text-gray-400 text-gray-500 text-sm mb-1 leading-relaxed">
          {i18nService.t('loginWallDescOpenSource')}
          <span
            className="text-blue-400 hover:text-blue-300 cursor-pointer font-medium"
            onClick={() => window.electron?.shell?.openExternal?.('https://github.com/noobclaw')}
          >
            {i18nService.t('loginWallViewSource')}
          </span>
        </p>
        <p className="dark:text-gray-400 text-gray-500 text-sm mb-6 leading-relaxed">
          {i18nService.t('loginWallDescBefore')}<span className="text-green-400 font-medium">{i18nService.t('loginWallDescHighlight')}</span>{i18nService.t('loginWallDescAfter')}<span className="text-yellow-400 font-medium">{i18nService.t('loginWallDescHighlight2')}</span>
        </p>

        <button
          onClick={() => noobClawAuth.openWebsiteLogin()}
          className="w-full py-3 rounded-xl bg-green-500/20 border border-green-500/40 text-green-400 font-semibold hover:bg-green-500/30 transition-all mb-3"
        >
          {i18nService.t('loginWallConnectBtn')}
        </button>

        <p className="text-xs dark:text-gray-500 text-gray-400 leading-relaxed">
          {i18nService.t('loginWallSupports')}<br />
          {i18nService.t('loginWallNoGas')}
        </p>
      </div>
    </div>
  );
};

export default LoginWall;
