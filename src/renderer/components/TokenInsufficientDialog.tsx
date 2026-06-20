import React from 'react';
import { i18nService } from '../services/i18n';

interface TokenInsufficientDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
  balance?: number;
}

const TokenInsufficientDialog: React.FC<TokenInsufficientDialogProps> = ({ onConfirm, onCancel, balance }) => {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onCancel}>
      <div className="w-full max-w-sm mx-4 p-8 rounded-2xl border border-yellow-500/30 dark:bg-[#1a1a2e] bg-white shadow-2xl text-center" onClick={e => e.stopPropagation()}>
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl border border-yellow-500/40 bg-yellow-500/10 flex items-center justify-center">
          <span className="text-3xl">⚡</span>
        </div>
        <h2 className="text-xl font-bold dark:text-white text-gray-900 mb-2">
          {i18nService.t('tokenInsufficientTitle')}
        </h2>
        <p className="dark:text-gray-400 text-gray-500 text-sm mb-2 leading-relaxed">
          {i18nService.t('tokenInsufficientDesc')}
        </p>
        {balance !== undefined && (
          <p className="text-yellow-400 text-sm font-medium mb-6">
            {i18nService.t('tokenInsufficientBalance', { n: balance.toLocaleString() })}
          </p>
        )}
        <button
          onClick={onConfirm}
          className="w-full py-3 rounded-xl bg-gradient-to-r from-yellow-500 to-orange-500 text-white font-semibold hover:from-yellow-600 hover:to-orange-600 transition-all mb-3 shadow-lg"
        >
          {i18nService.t('tokenInsufficientTopUp')}
        </button>
        <button
          onClick={onCancel}
          className="w-full py-2 rounded-xl dark:text-gray-500 text-gray-400 text-sm hover:dark:text-gray-300 hover:text-gray-600 transition-colors"
        >
          {i18nService.t('tokenInsufficientLater')}
        </button>
      </div>
    </div>
  );
};

export default TokenInsufficientDialog;
