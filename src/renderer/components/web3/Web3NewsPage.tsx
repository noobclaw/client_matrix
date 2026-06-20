import React from 'react';
import Web3News from './Web3News';
import WindowTitleBar from '../window/WindowTitleBar';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import { i18nService } from '../../services/i18n';

interface Web3NewsPageProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

const Web3NewsPage: React.FC<Web3NewsPageProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';

  return (
    <div className="flex flex-col h-full w-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b dark:border-claude-darkBorder border-claude-border shrink-0 dark:bg-claude-darkSurface/50 bg-claude-surface/50 draggable" style={{ paddingLeft: isMac ? 80 : undefined }}>
        <div className="non-draggable flex items-center gap-2">
          {isSidebarCollapsed && (
            <>
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
            </>
          )}
          <h1 className="text-sm font-semibold dark:text-claude-darkText text-claude-text flex items-center gap-2">
            <span>{'\uD83D\uDD25'}</span> {i18nService.t('hotTopics')}
          </h1>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        <Web3News />
      </div>
    </div>
  );
};

export default Web3NewsPage;
