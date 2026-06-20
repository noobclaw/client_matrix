import React from 'react';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import { i18nService } from '../../services/i18n';
import LuckyBag from '../cowork/LuckyBag';
import { ErrorBoundary } from '../ErrorBoundary';

interface QuickUseViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

export const QuickUseView: React.FC<QuickUseViewProps> = ({ isSidebarCollapsed, onToggleSidebar, onNewChat, updateBadge }) => {
  const isMac = window.electron.platform === 'darwin';

  return (
    <div className="flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg">
      {/* NoobCoin 福袋红包空投 — self-positioned overlay,监听 backend SSE 触发。
          原本只在 chat 对话框(CoworkSessionDetail) + scenario 页(ScenarioView)
          有,一键使用页漏挂导致这页用户永远抽不到红包。这里补齐,跟其他两页
          用同一份 LuckyBag 组件,行为完全一致。 */}
      <ErrorBoundary name="LuckyBag" fallback={null}>
        <LuckyBag />
      </ErrorBoundary>
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">{i18nService.t('quickUse')}</h1>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto">
          {/* Coming Soon Hero */}
          <div className="p-8 rounded-2xl border border-green-500/20 bg-gradient-to-br from-green-500/5 to-transparent text-center mb-8">
            <div className="text-5xl mb-4">🚀</div>
            <h3 className="text-xl font-bold dark:text-white mb-3">{i18nService.t('quickUseHeroTitle')}</h3>
            <p className="text-gray-400 text-sm leading-relaxed mb-6">
              {i18nService.t('quickUseHeroDesc')}
            </p>
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-green-500/30 bg-green-500/10 text-green-400 text-sm">
              <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></div>
              {i18nService.t('quickUseComingSoon')}
            </div>
          </div>

          {/* Preview Cards */}
          <h4 className="text-sm font-medium text-gray-400 mb-4">{i18nService.t('quickUseUpcomingTypes')}</h4>
          <div className="grid grid-cols-2 gap-3">
            {[
              { icon: '📊', title: i18nService.t('quickUsePumpFunMonitor'), desc: i18nService.t('quickUsePumpFunDesc') },
              { icon: '🐦', title: 'Twitter Alpha', desc: i18nService.t('quickUseTwitterAlphaDesc') },
              { icon: '💱', title: i18nService.t('quickUseDexArbitrage'), desc: i18nService.t('quickUseDexArbitrageDesc') },
              { icon: '🐋', title: i18nService.t('quickUseWhaleTracker'), desc: i18nService.t('quickUseWhaleTrackerDesc') },
              { icon: '📈', title: i18nService.t('quickUseTechAnalysis'), desc: i18nService.t('quickUseTechAnalysisDesc') },
              { icon: '📢', title: 'TG/Discord', desc: i18nService.t('quickUseTgDiscordDesc') },
            ].map((item, i) => (
              <div key={i} className="p-4 rounded-xl border border-gray-800 opacity-60 cursor-not-allowed">
                <div className="text-2xl mb-2">{item.icon}</div>
                <p className="text-sm font-medium dark:text-white">{item.title}</p>
                <p className="text-xs text-gray-500">{item.desc}</p>
                <span className="text-xs text-gray-600 mt-1 inline-block">{i18nService.t('quickUseComingSoon')}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default QuickUseView;
