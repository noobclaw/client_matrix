/**
 * MatrixFunnelConfig — 引流语配置块(MatrixTaskWizard 互动 / MatrixReplyFansWizard 回复粉丝共用)。
 *
 * 两种模式(默认共用,向后兼容老任务):
 *   共用   — 一份引流语+概率对所有已选账号生效(即老行为);账号+赛道列表只作展示。
 *   各账号 — 点账号卡逐号配置;未配置的账号视为「该号不带引流」(允许放行,
 *            向导下一步时由 unConfiguredCount 提示确认)。
 *
 * 数据约定:perMap 里 phrase 为空 = 未配置;保存时由向导过滤空项。
 *
 * 「AI自主评论」开关(任务级 ai_comment,默认开 = 老行为):关闭后 AI 只发引流语(改写后),
 *   此时引流语必填(共用=非空;各账号=每个已选账号都要配,不允许「不管了下一步」),概率固定 100%。
 *   向导用 funnelAiOffError() 卡下一步/保存,用 effFunnelProb() 算保存的概率。
 * 「AI改写引流语」开关(每份引流语一个 funnel_rewrite,默认开):关闭需确认,关后原样发布。
 */
import React, { useEffect, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { NumBox } from './NumberStepper';

export const FUNNEL_PHRASE_MAX = 1000; // 一行一条最多 20 条,放宽总字数
export const FUNNEL_LINES_MAX = 20;
export const FUNNEL_PROB_MIN = 1;
export const FUNNEL_PROB_MAX = 100;
export const FUNNEL_PROB_DEFAULT = 100;   // 2026-10-28:有引流语时默认 100%(原 50%);没填引流语时概率不生效

// funnel_rewrite:「AI改写引流语」,缺省/true = AI 改写(老行为);false = 原样发布。跟着这份引流语走
//   (共用模式 = 任务级 funnel 里;各账号模式 = 该账号那份 FunnelValue 里)。
export interface FunnelValue { funnel_phrase: string; funnel_probability: number; funnel_rewrite?: boolean }
export interface FunnelAccount { id: string; title: string; group?: string; platformName?: string; avatar?: string }

interface Props {
  accounts: FunnelAccount[];                 // 已勾选账号(向导 Step1 的 selected)
  accent: 'violet' | 'fuchsia';              // 跟宿主向导主题色
  perMode: boolean; setPerMode: (b: boolean) => void;
  shared: FunnelValue; setShared: (v: FunnelValue) => void;
  perMap: Record<string, FunnelValue>;
  setPerMap: (updater: (prev: Record<string, FunnelValue>) => Record<string, FunnelValue>) => void;
  disabled?: boolean;
  aiComment?: boolean; setAiComment?: (b: boolean) => void;   // 不传 setAiComment = 不显示开关(恒开)
}

/** 未配置引流语的账号数(仅各账号模式有意义;向导「下一步」用它决定要不要弹确认)。 */
export function countUnconfigured(accounts: FunnelAccount[], perMap: Record<string, FunnelValue>): number {
  return accounts.filter((a) => !(perMap[a.id]?.funnel_phrase || '').trim()).length;
}

/** 关闭「AI自主评论」时保存的概率固定 100;开着则原样。 */
export function effFunnelProb(aiComment: boolean, prob: number): number {
  return aiComment ? prob : FUNNEL_PROB_MAX;
}

/** 关闭「AI自主评论」时引流语必填:返回错误文案(null = 通过)。开着恒 null(老行为)。 */
export function funnelAiOffError(aiComment: boolean, perMode: boolean, accounts: FunnelAccount[], shared: FunnelValue, perMap: Record<string, FunnelValue>): string | null {
  if (aiComment) return null;
  if (!perMode) return (shared.funnel_phrase || '').trim() ? null : i18nService.t('wzFunnelAiOffErrShared');
  const n = countUnconfigured(accounts, perMap);
  return n > 0 ? i18nService.t('wzFunnelAiOffErrPer').replace('{n}', String(n)) : null;
}

/** 落库用:funnel_rewrite 只在关闭时写 false,开着不写(缺省 = 开 = 老行为)。 */
export function rewriteField(v: { funnel_rewrite?: boolean } | undefined): { funnel_rewrite?: false } {
  return v?.funnel_rewrite === false ? { funnel_rewrite: false } : {};
}

/** 向导内嵌确认弹层(不用系统 confirm):标题 + 可选说明 + 返回 / 确认。 */
export const FunnelConfirmDialog: React.FC<{ accent: 'violet' | 'fuchsia'; title: string; desc?: string; backLabel: string; okLabel: string; onBack: () => void; onOk: () => void }> = ({ accent, title, desc, backLabel, okLabel, onBack, onOk }) => (
  <div className="fixed inset-0 z-[120] bg-black/50 flex items-center justify-center p-6" role="alertdialog" aria-modal="true">
    <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-xl p-5 space-y-3">
      <div className="text-sm font-semibold dark:text-white leading-relaxed">{title}</div>
      {desc && <div className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{desc}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onBack} className="px-3.5 py-2 rounded-lg text-xs font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">{backLabel}</button>
        <button type="button" onClick={onOk} className={`px-3.5 py-2 rounded-lg text-xs font-semibold text-white ${accent === 'violet' ? 'bg-violet-500 hover:bg-violet-600' : 'bg-fuchsia-500 hover:bg-fuchsia-600'}`}>{okLabel}</button>
      </div>
    </div>
  </div>
);

/** 卡片式开关(「共用引流语」「AI自主评论」同款)。 */
export const SwitchCard: React.FC<{ accent: 'violet' | 'fuchsia'; label: string; desc: string; on: boolean; onToggle: () => void; disabled?: boolean; ring: string }> = ({ accent, label, desc, on, onToggle, disabled, ring }) => (
  <div className={`rounded-xl border px-4 py-3 space-y-1 ${on ? ring : 'border-gray-200 dark:border-gray-700'}`}>
    <label className="flex items-center justify-between gap-2 cursor-pointer">
      <span className="text-sm font-medium dark:text-gray-200">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={disabled}
        onClick={onToggle}
        className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${on ? (accent === 'violet' ? 'bg-violet-500' : 'bg-fuchsia-500') : 'bg-gray-300 dark:bg-gray-600'}`}
      >
        <span className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white transition-all ${on ? 'left-[20px]' : 'left-[2px]'}`} />
      </button>
    </label>
    <div className="text-[11px] text-gray-400 leading-relaxed">{desc}</div>
  </div>
);

const MatrixFunnelConfig: React.FC<Props> = ({ accounts, accent, perMode, setPerMode, shared, setShared, perMap, setPerMap, disabled, aiComment = true, setAiComment }) => {
  const [activeId, setActiveId] = useState<string>(accounts[0]?.id || '');
  const active = accounts.find((a) => a.id === activeId) || accounts[0];

  // ── 账号卡横排:50 个号也不换行 —— 单行横向滚动 + 鼠标拖拽,左右边缘渐隐提示
  //   「后面还有」(尾部卡片自然露一半)。拖拽后 50ms 内抑制 click,避免拖完误触发选卡。
  const rowRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; sl: number; moved: boolean } | null>(null);
  const justDraggedRef = useRef(false);
  const [fadeL, setFadeL] = useState(false);
  const [fadeR, setFadeR] = useState(false);
  const updateFades = () => {
    const r = rowRef.current;
    if (!r) return;
    setFadeL(r.scrollLeft > 4);
    setFadeR(r.scrollLeft + r.clientWidth < r.scrollWidth - 4);
  };
  useEffect(() => { const t = setTimeout(updateFades, 50); return () => clearTimeout(t); }, [accounts.length, perMode]);
  const onRowMouseDown = (e: React.MouseEvent) => { const r = rowRef.current; if (!r) return; dragRef.current = { x: e.clientX, sl: r.scrollLeft, moved: false }; };
  const onRowMouseMove = (e: React.MouseEvent) => {
    const d = dragRef.current, r = rowRef.current;
    if (!d || !r || e.buttons !== 1) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 4) d.moved = true;
    r.scrollLeft = d.sl - dx;
  };
  const onRowMouseUp = () => {
    if (dragRef.current?.moved) { justDraggedRef.current = true; setTimeout(() => { justDraggedRef.current = false; }, 50); }
    dragRef.current = null;
  };
  const ac = accent === 'violet' ? {
    ring: 'ring-violet-500/40', border: 'border-violet-500', bg: 'bg-violet-500/5', text: 'text-violet-500', accentCls: 'accent-violet-500', focus: 'focus:ring-violet-500/40', chipBg: 'bg-violet-500/10',
  } : {
    ring: 'ring-fuchsia-500/40', border: 'border-fuchsia-500', bg: 'bg-fuchsia-500/5', text: 'text-fuchsia-500', accentCls: 'accent-fuchsia-500', focus: 'focus:ring-fuchsia-500/40', chipBg: 'bg-fuchsia-500/10',
  };

  const editorValue: FunnelValue = perMode
    ? (perMap[active?.id || ''] || { funnel_phrase: '', funnel_probability: FUNNEL_PROB_DEFAULT })
    : shared;
  const setEditorValue = (v: FunnelValue) => {
    if (perMode) { const id = active?.id; if (id) setPerMap((prev) => ({ ...prev, [id]: v })); }
    else setShared(v);
  };
  const hasPhrase = editorValue.funnel_phrase.trim().length > 0;
  const rewriteOn = editorValue.funnel_rewrite !== false;
  const [rewriteConfirm, setRewriteConfirm] = useState(false);
  const aiOffErr = funnelAiOffError(aiComment, perMode, accounts, shared, perMap);
  const cardRing = `${ac.border} ${ac.bg} ring-1 ${ac.ring}`;

  return (
    <div className="space-y-4">
      {/* 模式开关(默认共用) + AI自主评论开关(默认开):左右两列,窄屏堆叠 */}
      <div className={`grid gap-3 ${setAiComment ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
        <SwitchCard
          accent={accent}
          ring={cardRing}
          label={i18nService.t('wzFunnelModeShared')}
          desc={perMode ? i18nService.t('wzFunnelModePerDesc') : i18nService.t('wzFunnelModeSharedDesc')}
          on={!perMode}
          onToggle={() => setPerMode(!perMode)}
          disabled={disabled}
        />
        {setAiComment && (
          <SwitchCard
            accent={accent}
            ring={cardRing}
            label={i18nService.t('wzFunnelAiComment')}
            desc={i18nService.t('wzFunnelAiCommentDesc')}
            on={aiComment}
            onToggle={() => setAiComment(!aiComment)}
            disabled={disabled}
          />
        )}
      </div>

      {/* 账号 + 赛道列表:共用模式只展示;各账号模式可点选逐号配置 */}
      <div>
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
          {i18nService.t('wzFunnelAccountsLabel').replace('{n}', String(accounts.length))}
        </div>
        <div className="relative">
          <div
            ref={rowRef}
            onScroll={updateFades}
            onMouseDown={onRowMouseDown}
            onMouseMove={onRowMouseMove}
            onMouseUp={onRowMouseUp}
            onMouseLeave={onRowMouseUp}
            className="flex gap-1.5 overflow-x-auto pb-1 select-none"
            style={{ scrollbarWidth: 'none', cursor: accounts.length > 3 ? 'grab' : undefined }}
          >
          {accounts.map((a) => {
            const configured = !!(perMap[a.id]?.funnel_phrase || '').trim();
            const isActive = perMode && active?.id === a.id;
            return (
              <button
                key={a.id}
                type="button"
                // 不用 disabled 表达「共用模式不可选」:disabled 按钮吞鼠标事件,会让按住卡片
                // 拖动横排失效。改由 onClick 守卫 + tabIndex 摘出焦点链,拖拽任何模式都好使。
                disabled={disabled}
                tabIndex={perMode ? 0 : -1}
                aria-disabled={!perMode}
                onClick={() => { if (justDraggedRef.current || disabled) return; if (perMode) setActiveId(a.id); }}
                className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-left transition-colors ${
                  isActive ? 'border-emerald-500 bg-emerald-500/10 ring-1 ring-emerald-500/50' : 'border-gray-200 dark:border-gray-700'
                } ${perMode ? 'cursor-pointer hover:border-gray-400 dark:hover:border-gray-500' : 'cursor-default'}`}
              >
                {a.avatar
                  ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-5 h-5 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                  : <span className={`w-5 h-5 rounded-full ${ac.chipBg} ${ac.text} flex items-center justify-center text-[10px] font-bold shrink-0`}>{(a.title || '?').slice(0, 1)}</span>}
                <span className="min-w-0">
                  <span className="block text-xs font-medium dark:text-gray-200 truncate max-w-[120px]">{a.title}</span>
                  <span className="block text-[10px] text-gray-400 truncate max-w-[120px]">{a.group || a.platformName || ''}</span>
                </span>
                {perMode && (
                  <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${configured ? 'bg-emerald-500/10 text-emerald-500' : 'bg-gray-400/10 text-gray-400'}`}>
                    {configured ? i18nService.t('wzFunnelConfigured') : i18nService.t('wzFunnelNotConfigured')}
                  </span>
                )}
              </button>
            );
          })}
          </div>
          {/* 边缘渐隐:提示左右还有更多账号(与向导底色一致 white/gray-900) */}
          {fadeL && <div className="pointer-events-none absolute left-0 top-0 bottom-1 w-8 bg-gradient-to-r from-white dark:from-gray-900 to-transparent" />}
          {fadeR && <div className="pointer-events-none absolute right-0 top-0 bottom-1 w-8 bg-gradient-to-l from-white dark:from-gray-900 to-transparent" />}
        </div>
      </div>

      {/* 编辑区:共用=一份;各账号=当前选中账号那份 */}
      <div className={`rounded-xl border px-4 py-3 space-y-3 ${accent === 'violet' ? 'border-fuchsia-500/25 bg-fuchsia-500/5' : 'border-fuchsia-500/25 bg-fuchsia-500/5'}`}>
        <div>
          <div className="flex items-start justify-between gap-3 mb-1.5">
            <label className="text-sm font-medium dark:text-gray-200 block">
              {/* i18n 文案自带 🎣,JSX 不再前置(原来显示成「🎣 🎣」) */}
              {i18nService.t(aiComment ? 'wzEngageFunnelPhraseLabel' : 'wzEngageFunnelPhraseLabelReq')}<span className="text-xs text-gray-400 font-normal ml-1">{i18nService.t(rewriteOn ? 'wzEngageFunnelPhraseHintRewrite' : 'wzEngageFunnelPhraseHintRaw')}</span>
            </label>
            {/* AI改写引流语:跟着当前编辑的这份引流语(共用 = 全部账号;各账号 = 当前账号)。关闭要确认,打开不用。 */}
            <span className="inline-flex items-center gap-1.5 shrink-0 text-xs text-gray-500 dark:text-gray-400">
              {i18nService.t('wzFunnelRewrite')}
              <button
                type="button"
                role="switch"
                aria-checked={rewriteOn}
                aria-label={i18nService.t('wzFunnelRewrite')}
                disabled={disabled}
                onClick={() => { if (rewriteOn) setRewriteConfirm(true); else setEditorValue({ ...editorValue, funnel_rewrite: true }); }}
                className={`relative w-8 h-[18px] rounded-full transition-colors shrink-0 ${rewriteOn ? (accent === 'violet' ? 'bg-violet-500' : 'bg-fuchsia-500') : 'bg-gray-300 dark:bg-gray-600'}`}
              >
                <span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all ${rewriteOn ? 'left-[16px]' : 'left-[2px]'}`} />
              </button>
            </span>
          </div>
          <textarea
            value={editorValue.funnel_phrase}
            onChange={(e) => {
              // 一行一条,最多 FUNNEL_LINES_MAX 条 —— 超出的行直接截掉;总字数上限照旧
              const lines = e.target.value.split('\n');
              const capped = (lines.length > FUNNEL_LINES_MAX ? lines.slice(0, FUNNEL_LINES_MAX) : lines).join('\n');
              setEditorValue({ ...editorValue, funnel_phrase: capped.slice(0, FUNNEL_PHRASE_MAX) });
            }}
            placeholder={i18nService.t('wzEngageFunnelPhrasePlaceholder')}
            rows={4}
            className={`w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40 resize-y min-h-[64px]`}
            disabled={disabled}
          />
          <div className="text-[11px] text-gray-400 mt-1">{i18nService.t('wzEngageFunnelCharCount').replace('{n}', String(editorValue.funnel_phrase.trim().length)).replace('{max}', String(FUNNEL_PHRASE_MAX))}</div>
        </div>
        <div>
          <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
            {i18nService.t('wzEngageFunnelProbLabel').replace('{n}', String(!aiComment ? FUNNEL_PROB_MAX : hasPhrase ? editorValue.funnel_probability : 0))}
            <span className="text-xs text-gray-400 font-normal ml-1">
              {!aiComment ? i18nService.t('wzEngageFunnelProbHintFixed') : hasPhrase ? '' : i18nService.t('wzEngageFunnelProbHintOff')}
            </span>
          </label>
          <NumBox
            value={aiComment ? editorValue.funnel_probability : FUNNEL_PROB_MAX}
            onChange={(n) => setEditorValue({ ...editorValue, funnel_probability: n })}
            min={FUNNEL_PROB_MIN}
            max={FUNNEL_PROB_MAX}
            step={5}
            disabled={disabled || !hasPhrase || !aiComment}
            accent="fuchsia"
            suffix="%"
          />
        </div>
        {aiOffErr && (
          <div className="rounded-lg border px-3 py-2 text-xs leading-relaxed border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400">
            ❌ {aiOffErr}
          </div>
        )}
      </div>
      {rewriteConfirm && (
        <FunnelConfirmDialog
          accent={accent}
          title={`⚠️ ${i18nService.t('wzFunnelRewriteOffConfirm')}`}
          backLabel={i18nService.t('wzFunnelRewriteOffCancel')}
          okLabel={i18nService.t('wzFunnelRewriteOffOk')}
          onBack={() => setRewriteConfirm(false)}
          onOk={() => { setRewriteConfirm(false); setEditorValue({ ...editorValue, funnel_rewrite: false }); }}
        />
      )}
    </div>
  );
};

/** 未配置确认弹层(向导内嵌,不用系统 confirm):还有 n 个账号没配 → 返回配置 / 不管了下一步。 */
export const FunnelUnsetConfirm: React.FC<{ count: number; accent: 'violet' | 'fuchsia'; onBack: () => void; onContinue: () => void }> = ({ count, accent, onBack, onContinue }) => (
  <FunnelConfirmDialog
    accent={accent}
    title={`⚠️ ${i18nService.t('wzFunnelUnsetWarnTitle').replace('{n}', String(count))}`}
    desc={i18nService.t('wzFunnelUnsetWarnDesc')}
    backLabel={i18nService.t('wzFunnelWarnBack')}
    okLabel={i18nService.t('wzFunnelWarnContinue')}
    onBack={onBack}
    onOk={onContinue}
  />
);

export default MatrixFunnelConfig;
