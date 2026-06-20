/**
 * CardActionRow — 各平台 WorkflowsPage 卡片底部统一的操作行。
 *
 * 左:「开始 …」主按钮(占 ~70%)。右:「查看已有任务 »」文字入口(占 ~30%),
 * 点击调 onGoToMyTasks 跳到当前平台的「我的涨粉任务」tab。
 *
 * 抽成共享组件,避免在 11 个 WorkflowsPage 里逐张卡复制同一段样式。
 * 各卡片只传 label(含 emoji)+ btnClass(主色),其余统一。
 */

import React from 'react';

export const CardActionRow: React.FC<{
  loading?: boolean;
  onConfigure: () => void;
  onGoToMyTasks?: () => void;
  isZh: boolean;
  /** 主按钮文案,含 emoji,如 '📝 开始创作 →'。 */
  label: string;
  /** 主按钮主色 class,如 'bg-fuchsia-500 hover:bg-fuchsia-600 shadow-lg shadow-fuchsia-500/25'。 */
  btnClass: string;
}> = ({ loading, onConfigure, onGoToMyTasks, isZh, label, btnClass }) => (
  <div className="flex items-stretch gap-2">
    <button
      type="button"
      onClick={onConfigure}
      disabled={loading}
      className={`flex-[7] px-4 py-2.5 text-sm font-bold rounded-xl disabled:opacity-40 disabled:cursor-not-allowed text-white transition-all active:scale-95 ${btnClass}`}
    >
      {label}
    </button>
    <button
      type="button"
      onClick={() => onGoToMyTasks?.()}
      className="flex-[3] px-2 py-2.5 text-xs font-medium rounded-xl text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800/60 hover:bg-gray-200 dark:hover:bg-gray-700/80 border border-gray-300 dark:border-gray-600 transition-colors whitespace-nowrap"
    >
      {isZh ? '已有任务' : 'My tasks'} »
    </button>
  </div>
);
