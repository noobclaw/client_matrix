/**
 * MatrixViralRewriteWizard — 矩阵版「小红书爆款批量仿写」向导。
 *
 * 多账号:勾选 N 个号,每个号用【自己的赛道/关键词/人设】去小红书搜本 niche 爆款 → 维度化创意引擎
 * 仿写 → AI 生图 → 发布。来源=每号关键词搜(沿用账号已配,不在向导填)。比图文创作更简:无参考文案、
 * 无配图模式(固定 AI 生图)。
 *
 *   Step 1 — 勾选 N 个账号
 *   Step 2 — 每号每轮仿写篇数 + AI 风格 + 发布方式
 *   Step 3 — 运行频率 + 摘要 + 条款
 */

import React, { useEffect, useMemo, useState } from 'react';

type WizardStep = 1 | 2 | 3;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

const PLATFORM_NAME: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', kuaishou: '快手', tiktok: 'TikTok' };

const AI_STYLES: { value: string; label: string }[] = [
  { value: 'ai_auto', label: '自动(按内容选)' },
  { value: 'text_card', label: '文字卡片' },
  { value: 'minimalist', label: '极简' },
  { value: 'photographic', label: '写实摄影' },
  { value: 'illustration', label: '插画' },
];

export interface ViralRewriteWizardSave {
  name: string;
  accountIds: string[];
  concurrency: number;
  frequency: string;
  dailyCount: number;
  aiImageStyle: string;
  autoPublish: boolean;
}

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: WizardAccount[];
  accountsLoading?: boolean;
  initialTask?: any | null;
  onCancel: () => void;
  onSave: (input: ViralRewriteWizardSave) => Promise<void> | void;
}

const MatrixViralRewriteWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);

  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    if (Array.isArray(initialTask?.accountIds) && initialTask.accountIds.length) return initialTask.accountIds.map(String);
    return accounts.filter((a) => a.status !== 'banned' && a.status !== 'login_required').map((a) => a.id);
  });
  const toggle = (id: string) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const vr = initialTask?.viralRewrite || {};
  const [dailyCount, setDailyCount] = useState<number>(Math.max(1, Math.min(20, Number(vr.dailyCount) || 1)));
  const [aiImageStyle, setAiImageStyle] = useState<string>(vr.aiImageStyle || 'ai_auto');
  const [autoPublish, setAutoPublish] = useState<boolean>(vr.autoPublish !== false);

  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'daily_random');
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([true, true]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [selectedIds, dailyCount, runInterval]);

  // 每个选中号都要有关键词(没词没法搜爆款)。
  const selectedNoKeyword = useMemo(
    () => accounts.filter((a) => selectedIds.includes(a.id) && (!a.keywords || a.keywords.length === 0)),
    [accounts, selectedIds],
  );

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: selectedIds.length === 0
      ? { ok: false, reason: '请至少勾选一个已登录账号' }
      : selectedNoKeyword.length > 0
        ? { ok: false, reason: `有 ${selectedNoKeyword.length} 个号没配关键词(爆款仿写要靠关键词搜,到「我的矩阵账号」编辑里加)` }
        : { ok: true },
    2: { ok: true },
    3: { ok: allTermsAccepted, reason: '请勾选使用条款' },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[3].ok) { setSaveError(canAdvance[3].reason || ''); return; }
    if (!canAdvance[1].ok) { setSaveError(canAdvance[1].reason || ''); return; }
    setSaving(true);
    try {
      await onSave({
        name: initialTask?.name || `${platformLabel}爆款仿写 · ${selectedIds.length} 个号`,
        accountIds: selectedIds,
        concurrency: selectedIds.length,
        frequency: runInterval,
        dailyCount,
        aiImageStyle,
        autoPublish,
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || '保存失败');
    } finally { setSaving(false); }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = { once: '不重复（手动触发）', '3h': '每 3 小时', '6h': '每 6 小时', daily_random: '每日随机时间一次' };
    return m[runInterval] || runInterval;
  }, [runInterval]);

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">🔥 {editing ? `编辑${platformLabel}爆款仿写任务` : `配置${platformLabel}爆款批量仿写`}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-rose-500/40 text-rose-500 bg-rose-500/5">第 {step} / 3 步</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-rose-500/30 bg-rose-500/5 text-rose-700 dark:text-rose-300">
              🔥 勾选多个已登录的{platformLabel}账号。每个号用<strong>自己的赛道/关键词</strong>去小红书搜本领域<strong>爆款笔记</strong>,按<strong>自己的人设 + 随机文风</strong>仿写成原创(N 个号各不相同),AI 配图后发布。关键词/人设在「我的矩阵账号」里给每个号设。
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                选 {platformLabel} 账号<span className="text-xs text-gray-400 font-normal ml-1">· 已登录即可{selectedIds.length ? `;已选 ${selectedIds.length}` : ''}</span>
              </label>
              <div className="space-y-1.5 max-h-72 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {accounts.length === 0 && accountsLoading && (<div className="p-3 text-center text-xs text-gray-400">账号加载中…</div>)}
                {accounts.length === 0 && !accountsLoading && (
                  <div className="p-3 text-center space-y-2.5">
                    <div className="text-xs text-gray-400">该平台还没有账号。先去「我的矩阵账号」添加并扫码登录{platformLabel}。</div>
                    <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }} className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-rose-500 hover:bg-rose-600 active:scale-95">👥 去「我的矩阵账号」添加 →</button>
                  </div>
                )}
                {accounts.map((a) => {
                  const ready = a.status !== 'login_required' && a.status !== 'banned';
                  const reason = a.status === 'banned' ? '已封' : a.status === 'login_required' ? '未连接' : '';
                  const title = a.nickname || a.displayName;
                  const noKw = !a.keywords || a.keywords.length === 0;
                  return (
                    <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                      <input type="checkbox" checked={selectedIds.includes(a.id)} onChange={() => ready && toggle(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-rose-500 shrink-0" />
                      {a.avatar
                        ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                        : <span className="w-7 h-7 rounded-full bg-rose-500/20 text-rose-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-500">{PLATFORM_NAME[a.platform || ''] || a.platform}</span>
                          <span className="font-medium truncate dark:text-white">{title}</span>
                          {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">{PLATFORM_NAME[a.platform || ''] || ''}号:{a.displayId}</span>}
                          {a.status === 'login_required'
                            ? <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: a.platform || platform } })); onCancel(); }} title="去「我的矩阵账号」扫码登录这个号" className="text-[11px] text-amber-500 underline decoration-dotted hover:text-amber-400 shrink-0">未连接 · 去登录 →</button>
                            : reason ? <span className="text-[11px] text-amber-500 shrink-0">{reason}</span> : null}
                          {ready && noKw && <span className="text-[11px] text-amber-500 shrink-0">未配关键词</span>}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">备注:{a.displayName}{a.group ? ` · ${a.group}` : ''}{a.keywords && a.keywords.length ? ` · 🏷️ ${a.keywords.join('/')}` : ''}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
              {selectedNoKeyword.length > 0 && <div className="text-[11px] text-amber-500 mt-1.5">⚠ 有 {selectedNoKeyword.length} 个选中号没配关键词,爆款仿写靠关键词搜,它们无法跑</div>}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">每号每轮仿写 <span className="text-rose-500 font-bold">{dailyCount}</span> 篇</label>
              <input type="range" min={1} max={20} value={dailyCount} onChange={(e) => setDailyCount(Number(e.target.value))} disabled={saving} className="w-full accent-rose-500" />
              <div className="flex justify-between text-[10px] text-gray-400"><span>1</span><span>20</span></div>
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">🎨 AI 生图风格<span className="text-xs text-gray-400 font-normal ml-1">· 仿写配图走 AI 生图(从仿写正文派生)</span></label>
              <select value={aiImageStyle} onChange={(e) => setAiImageStyle(e.target.value)} disabled={saving} className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/40">
                {AI_STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">📤 生成后</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setAutoPublish(true)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${autoPublish ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-rose-500/50'}`}>
                  🚀 直接发布<div className="text-[11px] text-gray-400 font-normal mt-0.5">各号仿写后自动发布到小红书</div>
                </button>
                <button type="button" onClick={() => setAutoPublish(false)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${!autoPublish ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-rose-500/50'}`}>
                  💾 仅本地<div className="text-[11px] text-gray-400 font-normal mt-0.5">只生成存本地,审核后手动发</div>
                </button>
              </div>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">⏰ 运行频率</label>
              <div className="flex gap-2 flex-wrap">
                {[['once', '不重复（手动触发）'], ['3h', '每 3 小时'], ['6h', '每 6 小时'], ['daily_random', '每日随机时间']].map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setRunInterval(value)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${runInterval === value ? 'border-rose-500 bg-rose-500/10 text-rose-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-rose-500/50'}`}>{label}</button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">📋 任务摘要</div>
              <SummaryRow label="账号" value={`${selectedIds.length} 个(各自关键词搜本niche爆款,内容互不相同)`} />
              <SummaryRow label="数量" value={`每号每轮仿写 ${dailyCount} 篇,共约 ${selectedIds.length * dailyCount} 篇/轮`} />
              <SummaryRow label="配图" value={`AI 生图(${AI_STYLES.find((s) => s.value === aiImageStyle)?.label || aiImageStyle})`} />
              <SummaryRow label="发布" value={autoPublish ? '直接发布到各号小红书' : '仅本地保存(手动审核后发)'} />
              <SummaryRow label="运行频率" value={intervalLabel} />
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">使用条款</div>
              {['我理解 NoobClaw 会在我本地用各账号专属指纹浏览器代我搜集爆款、仿写并发布', '我理解内容原创度/版权与平台账号风险由我自己承担'].map((term, i) => (
                <label key={i} className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input type="checkbox" checked={termsAccepted[i]} onChange={(e) => { const next = [...termsAccepted]; next[i] = e.target.checked; setTermsAccepted(next); }} disabled={saving} className="mt-0.5 h-4 w-4 accent-rose-500 shrink-0" />
                  <span className="leading-relaxed">{term}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </div>

      {saveError && (
        <div className="px-6 pt-2 pb-1 shrink-0">
          <div className="rounded-lg border px-3 py-2 text-xs leading-relaxed border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400">❌ {saveError}</div>
        </div>
      )}

      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center gap-2 shrink-0">
        <button type="button" onClick={onCancel} disabled={saving} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2">取消</button>
        <div className="flex-1" />
        {step > 1 && <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">← 上一步</button>}
        {step < 3 ? (
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50">下一步 →</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50">{saving ? '保存中...' : (editing ? '✓ 保存修改' : '🔥 创建任务')}</button>
        )}
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixViralRewriteWizard;
