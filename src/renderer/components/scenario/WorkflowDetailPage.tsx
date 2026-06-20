/**
 * WorkflowDetailPage — layer 2 inside a specific workflow type.
 *
 * Per product direction (2026-04): clicking a workflow card should go
 * directly to the scenario library for that workflow — no nested marketing
 * page in between. The NoobClaw advantages hero has been moved up to
 * XhsWorkflowsPage so it's visible on entry to the XHS tab.
 *
 * This page now renders:
 *   1. Back button
 *   2. Short header with workflow icon + title
 *   3. Scenario grid (the "场景库")
 */

import React from 'react';
import { i18nService } from '../../services/i18n';
import type { Scenario, Task, Draft } from '../../services/scenario';

interface Props {
  workflow_type: string;
  scenarios: Scenario[];
  tasks: Task[];
  draftsByTask: Map<string, Draft[]>;
  onBack: () => void;
  onConfigure: (scenario: Scenario) => void;
  onOpenTask: (task_id: string) => void;
}

const WORKFLOW_META: Record<string, { icon: string; titleKey: string; descKey: string }> = {
  viral_production: {
    icon: '🔥',
    titleKey: 'scenarioWorkflowViral',
    descKey: 'scenarioWorkflowViralDesc',
  },
  // v1.1.x: image-text 独立 workflow_type,跟 viral_production 分开避免 .find 撞车。
  // 没单独 i18n key 时复用 viral 的标题(图文创作也算"爆款生产"的一种)。
  // v1.x: 进一步拆成 douyin / xhs 各自独立 workflow_type,满足"每张卡片用
  //   独立 workflow_type"规则。保留旧 image_text_creation key 兜底,防止
  //   老 run record(刚升级前的存档)在历史页渲染时拿不到 meta。
  douyin_image_text_creation: {
    icon: '📝',
    titleKey: 'scenarioWorkflowViral',
    descKey: 'scenarioWorkflowViralDesc',
  },
  xhs_image_text_creation: {
    icon: '📝',
    titleKey: 'scenarioWorkflowViral',
    descKey: 'scenarioWorkflowViralDesc',
  },
  image_text_creation: {
    icon: '📝',
    titleKey: 'scenarioWorkflowViral',
    descKey: 'scenarioWorkflowViralDesc',
  },
  auto_reply: {
    icon: '💬',
    titleKey: 'scenarioWorkflowAutoReply',
    descKey: 'scenarioWorkflowAutoReplyDesc',
  },
  mass_comment: {
    icon: '🎯',
    titleKey: 'scenarioWorkflowMassComment',
    descKey: 'scenarioWorkflowMassCommentDesc',
  },
  dm_reply: {
    icon: '📬',
    titleKey: 'scenarioWorkflowDmReply',
    descKey: 'scenarioWorkflowDmRelyDesc',
  },
  data_monitor: {
    icon: '📈',
    titleKey: 'scenarioWorkflowDataMonitor',
    descKey: 'scenarioWorkflowDataMonitorDesc',
  },
};

export const WorkflowDetailPage: React.FC<Props> = ({
  workflow_type,
  scenarios,
  tasks,
  draftsByTask,
  onBack,
  onConfigure,
  onOpenTask,
}) => {
  const installedScenarioIds = new Set(tasks.map(t => t.scenario_id));
  const taskByScenarioId = new Map(tasks.map(t => [t.scenario_id, t]));
  const meta = WORKFLOW_META[workflow_type] || WORKFLOW_META.viral_production;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Back button */}
      <button
        type="button"
        onClick={onBack}
        className="mb-6 inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
      >
        ← {i18nService.t('scenarioTaskBack')}
      </button>

      {/* Compact header */}
      <div className="mb-6 flex items-start gap-4">
        <div className="text-4xl">{meta.icon}</div>
        <div>
          <h1 className="text-2xl font-bold dark:text-white mb-1">
            {i18nService.t('scenarioPlatformXhs')} · {i18nService.t(meta.titleKey)}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-2xl">
            {i18nService.t(meta.descKey)}
          </p>
        </div>
      </div>

      {/* Scenario grid (= 场景库) */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-4">
          📚 {i18nService.t('scenarioSectionScenarios')}
        </h2>

        {scenarios.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {i18nService.t('scenarioWorkflowComingSoon')}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {scenarios.map(s => {
              const installed = installedScenarioIds.has(s.id);
              const task = taskByScenarioId.get(s.id);
              const pendingCount = task
                ? (draftsByTask.get(task.id) || []).filter(d => d.status === 'pending').length
                : 0;
              return (
                <div
                  key={s.id}
                  className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5 hover:shadow-lg hover:border-green-500/50 dark:hover:border-green-500/50 transition-all"
                >
                  <div className="text-3xl mb-3">{s.icon || '📝'}</div>
                  <div className="font-semibold dark:text-white mb-1">{s.name_zh}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed mb-4 min-h-[3rem] line-clamp-3">
                    {s.description_zh}
                  </div>
                  <div className="flex items-center gap-2">
                    {installed && task ? (
                      <>
                        <button
                          type="button"
                          onClick={() => onOpenTask(task.id)}
                          className="flex-1 text-xs font-medium px-3 py-2 rounded-lg bg-green-500/10 text-green-500 border border-green-500/30 hover:bg-green-500/20 transition-colors"
                        >
                          {i18nService.t('scenarioCardOpen')}
                          {pendingCount > 0 && (
                            <span className="ml-1">
                              ·{' '}
                              {i18nService
                                .t('scenarioCardTaskDraftCount')
                                .replace('{n}', String(pendingCount))}
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => onConfigure(s)}
                          className="text-xs font-medium px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                        >
                          {i18nService.t('scenarioCardEdit')}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onConfigure(s)}
                        className="flex-1 text-xs font-medium px-3 py-2 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 transition-opacity"
                      >
                        {i18nService.t('scenarioCardConfigure')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};

export default WorkflowDetailPage;
