import React from 'react';
import { useSelector } from 'react-redux';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { RootState } from '../../store';
import { coworkService } from '../../services/cowork';
import CoworkSessionList from './CoworkSessionList';
import ListChecksIcon from '../icons/ListChecksIcon';
import TrashIcon from '../icons/TrashIcon';
import { i18nService } from '../../services/i18n';

/**
 * 主区域「所有 AI 对话」历史列表页 —— 把原来只在侧栏/搜索浮层里的会话列表搬到主内容区:
 *   · 复用 CoworkSessionList(自带空状态 coworkNoSessions + 每条删除/置顶/重命名)。
 *   · 操作菜单(…)常驻显示(alwaysShowActions),不靠 hover。
 *   · 支持批量删除:进入批量模式后逐条勾选 / 全选 / 删除选中。
 *   · 点击某条 → loadSession + onOpenSession() 跳到对话界面(cowork view)。
 * 矩阵版侧栏不常驻对话历史,所以单独成页。
 */
interface Props {
  /** 选中某条对话后调用 —— 让 App 切到 cowork 聊天视图。 */
  onOpenSession: () => void;
}

const CoworkHistoryPage: React.FC<Props> = ({ onOpenSession }) => {
  const sessions = useSelector((s: RootState) => s.cowork.sessions);
  const currentSessionId = useSelector((s: RootState) => s.cowork.currentSessionId);
  const isZh = i18nService.currentLanguage === 'zh';

  const [isBatchMode, setIsBatchMode] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = React.useState(false);

  const handleSelect = async (id: string) => { await coworkService.loadSession(id); onOpenSession(); };
  const handleDelete = async (id: string) => { await coworkService.deleteSession(id); };
  const handleTogglePin = async (id: string, pinned: boolean) => { await coworkService.setSessionPinned(id, pinned); };
  const handleRename = async (id: string, title: string) => { await coworkService.renameSession(id, title); };

  const enterBatchMode = (preselectId?: string) => {
    setIsBatchMode(true);
    setSelectedIds(new Set(preselectId ? [preselectId] : []));
  };
  const exitBatchMode = () => {
    setIsBatchMode(false);
    setSelectedIds(new Set());
    setShowBatchDeleteConfirm(false);
  };
  const handleToggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const handleSelectAll = () => {
    setSelectedIds(prev => (prev.size === sessions.length ? new Set() : new Set(sessions.map(s => s.id))));
  };
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    await coworkService.deleteSessions(Array.from(selectedIds));
    exitBatchMode();
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-lg font-semibold dark:text-white text-claude-text">{isZh ? '所有 AI 对话' : 'All AI Conversations'}</h1>
          {isBatchMode ? (
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 cursor-pointer text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mr-1">
                <input
                  type="checkbox"
                  checked={selectedIds.size === sessions.length && sessions.length > 0}
                  onChange={handleSelectAll}
                  className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 accent-claude-accent cursor-pointer"
                />
                {i18nService.t('batchSelectAll')}
              </label>
              <button
                type="button"
                onClick={() => selectedIds.size > 0 && setShowBatchDeleteConfirm(true)}
                disabled={selectedIds.size === 0}
                className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  selectedIds.size > 0
                    ? 'bg-red-500 hover:bg-red-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
                }`}
              >
                <TrashIcon className="h-3.5 w-3.5" />
                {selectedIds.size > 0 ? selectedIds.size : ''}
              </button>
              <button
                type="button"
                onClick={exitBatchMode}
                className="px-3 py-1.5 text-xs font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                {i18nService.t('batchCancel')}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              {sessions.length > 0 && (
                <button
                  type="button"
                  onClick={() => enterBatchMode()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                >
                  <ListChecksIcon className="h-3.5 w-3.5" />
                  {i18nService.t('batchOperations')}
                </button>
              )}
              <span className="text-xs text-gray-400">{isZh ? `${sessions.length} 个对话` : `${sessions.length} chats`}</span>
            </div>
          )}
        </div>
        <CoworkSessionList
          sessions={sessions}
          currentSessionId={currentSessionId}
          isBatchMode={isBatchMode}
          selectedIds={selectedIds}
          showBatchOption={true}
          alwaysShowActions={true}
          onSelectSession={handleSelect}
          onDeleteSession={handleDelete}
          onTogglePin={handleTogglePin}
          onRenameSession={handleRename}
          onToggleSelection={handleToggleSelection}
          onEnterBatchMode={enterBatchMode}
        />
      </div>

      {/* 批量删除确认 */}
      {showBatchDeleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowBatchDeleteConfirm(false)}
        >
          <div
            className="w-full max-w-sm mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-5 py-4">
              <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
                <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
              </div>
              <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('batchDeleteConfirmTitle')}
              </h2>
            </div>
            <div className="px-5 pb-4">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('batchDeleteConfirmMessage').replace('{count}', String(selectedIds.size))}
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border">
              <button
                onClick={() => setShowBatchDeleteConfirm(false)}
                className="px-4 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                onClick={handleBatchDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
              >
                {i18nService.t('batchDelete')} ({selectedIds.size})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CoworkHistoryPage;
