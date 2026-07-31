/**
 * StoryboardReviewModal — 电影级「分镜表」审阅屏。
 *
 * ## 为什么必须有这一屏
 * 老链路是:填完向导 → 直接开跑 → 几分钟后出片才知道对不对。分镜表把【烧钱之前】的
 * 那一刻交还给用户:
 *   · 对齐   —— AI 猜歪了在这里就拦住,不用等出片
 *   · 校验   —— 用户粘的脚本解析对没对,一眼看穿
 *   · 止损   —— Seedance 是逐镜真金白银,跑完才发现方向错了钱就白烧了
 *   · 控成本 —— 「要动」逐镜勾选。不勾 = 首帧 + 运镜(几毛);勾了 = 生成视频(几块)
 *
 * ## 数据契约
 * shots 原样来自主进程 storyboardScript 的解析结果,用户改完后作为
 * `input.storyboardShots` 回传 pipeline —— pipeline 见到它就直接用,不再跑一次解析
 * (省一次 AI 调用,也保证用户改过的内容原样生效)。
 *
 * locked[] 记录的是【用户脚本里明确写了】的字段,这里用一个小锁标出来,提示用户
 * 这些内容来自他自己的脚本、AI 没有改过。
 */

import React, { useMemo, useState, useEffect } from 'react';
import type { StoryShot } from '../../../services/videoCreation';

type ShotType = StoryShot['type'];

const TYPE_META: Record<ShotType, { zh: string; en: string; cls: string }> = {
  chart:      { zh: '图表',   en: 'Chart',      cls: 'bg-violet-500/15 text-violet-700 dark:text-violet-300' },
  textcard:   { zh: '文字卡', en: 'Text card',  cls: 'bg-blue-500/15 text-blue-700 dark:text-blue-300' },
  scene:      { zh: '实景',   en: 'Scene',      cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  person:     { zh: '人物',   en: 'Person',     cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  logo:       { zh: '标识',   en: 'Logo',       cls: 'bg-slate-500/15 text-slate-700 dark:text-slate-300' },
  transition: { zh: '转场',   en: 'Transition', cls: 'bg-gray-500/15 text-gray-600 dark:text-gray-400' },
};
const TYPE_ORDER: ShotType[] = ['scene', 'person', 'chart', 'textcard', 'logo', 'transition'];

export interface StoryboardReviewModalProps {
  open: boolean;
  isZh: boolean;
  /** 解析中 → 显示骨架/进度。 */
  loading: boolean;
  /** 解析失败原因(非空时显示错误态 + 重试)。 */
  error?: string | null;
  shots: StoryShot[];
  /** 解析器的告警(逐字保真、截断等),原样透传给用户。 */
  warnings?: string[];
  /** 口播逐字复核 0~1。<1 说明 AI 可能改写了原文 —— 必须让用户看见。 */
  fidelity?: number;
  /** Seedance 每秒积分(用于估「要动」的镜要花多少)。拿不到就不显示金额。 */
  creditsPerSec?: number | null;
  usdPerSec?: number | null;
  onChange: (shots: StoryShot[]) => void;
  onRetry: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function StoryboardReviewModal(props: StoryboardReviewModalProps) {
  const {
    open, isZh, loading, error, shots, warnings, fidelity,
    creditsPerSec, usdPerSec, onChange, onRetry, onConfirm, onCancel,
  } = props;
  const [expanded, setExpanded] = useState<number | null>(null);
  // 解析已跑了多少秒。长脚本要分块跑几次 LLM,十几二十秒很正常 —— 没有动的东西
  // 用户会以为卡死了,所以给一个走字的计时 + 转圈。
  const [elapsed, setElapsed] = useState(0);

  // 关闭时收起展开态,避免下次打开还停在上一次那一行。
  useEffect(() => { if (!open) setExpanded(null); }, [open]);
  useEffect(() => {
    if (!loading) { setElapsed(0); return; }
    setElapsed(0);
    const t = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [loading]);

  const totalSec = useMemo(
    () => Math.round(shots.reduce((a, s) => a + (Number(s.seconds) || 0), 0)),
    [shots],
  );
  const animateCount = useMemo(() => shots.filter((s) => s.animate).length, [shots]);
  // 只有勾了「要动」的镜才按秒烧 Seedance;其余是首帧 + 运镜,成本可忽略。
  const animateSec = useMemo(
    () => shots.filter((s) => s.animate).reduce((a, s) => a + Math.max(4, Math.min(12, Number(s.seconds) || 5)), 0),
    [shots],
  );
  const estCredits = creditsPerSec != null ? Math.round(creditsPerSec * animateSec) : null;
  const estUsd = usdPerSec != null ? usdPerSec * animateSec : null;

  if (!open) return null;

  const patch = (i: number, p: Partial<StoryShot>) => {
    const next = shots.slice();
    next[i] = { ...next[i], ...p };
    onChange(next);
  };
  const removeAt = (i: number) => onChange(shots.filter((_, k) => k !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= shots.length) return;
    const next = shots.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const isLocked = (s: StoryShot, field: string) => Array.isArray(s.locked) && s.locked.includes(field);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-5xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-gray-900 shadow-2xl border border-gray-200 dark:border-gray-800">
        {/* 头 */}
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800 flex items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold dark:text-white">
              {isZh ? '分镜表 · 开跑前确认' : 'Storyboard — review before running'}
            </div>
            <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
              {isZh ? (
                <>
                  下面每一行是一个镜头。<span className="text-gray-700 dark:text-gray-300">念出来的字就是你写的原话，一个字不改</span>；画面按你在「画面」里写的内容生成。<br />
                  默认每个镜头出一张图，再给它加上缓缓推近的效果 —— 几乎不花钱。
                  想让哪个镜头<span className="text-gray-700 dark:text-gray-300">真的动起来</span>（人在走、车在开），就勾上「要动」，那一格改用 AI 生成视频，<span className="text-fuchsia-600 dark:text-fuchsia-400">按秒收费</span>。
                </>
              ) : (
                <>
                  Each row below is one shot. <span className="text-gray-700 dark:text-gray-300">The narration is read exactly as you wrote it</span>, and the visual follows what you put in the Visual column.<br />
                  By default every shot is a still image with a slow push-in, which costs almost nothing.
                  Tick “Animate” on the shots you want to <span className="text-gray-700 dark:text-gray-300">actually move</span> — those are generated as AI video and <span className="text-fuchsia-600 dark:text-fuchsia-400">charged per second</span>.
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none px-1"
            aria-label={isZh ? '关闭' : 'Close'}
          >
            ×
          </button>
        </div>

        {/* 体 */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="py-16 flex flex-col items-center gap-3">
              <span className="w-7 h-7 rounded-full border-2 border-fuchsia-500/30 border-t-fuchsia-500 animate-spin" />
              <div className="text-sm text-gray-500 dark:text-gray-400">
                {isZh ? '正在解析分镜…' : 'Parsing storyboard…'}
                <span className="ml-1 tabular-nums text-fuchsia-500 font-medium">{elapsed}s</span>
              </div>
              <div className="text-[11px] text-gray-400">
                {isZh
                  ? '只跑文字，不出图、不生成视频。脚本越长拆得越多，通常 10~40 秒。'
                  : 'Text only — no images, no video. Longer scripts take more passes, usually 10-40s.'}
              </div>
            </div>
          )}

          {!loading && error && (
            <div className="py-12 text-center">
              <div className="text-sm text-red-500 mb-3">
                {isZh ? `分镜解析失败：${error}` : `Storyboard parse failed: ${error}`}
              </div>
              <button
                type="button"
                onClick={onRetry}
                className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                {isZh ? '重试' : 'Retry'}
              </button>
            </div>
          )}

          {!loading && !error && (
            <>
              {/* 逐字保真告警:口播被 AI 改写过是最严重的问题,必须显眼 */}
              {typeof fidelity === 'number' && fidelity < 0.99 && (
                <div className="mb-3 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">
                  {isZh
                    ? `⚠️ 口播逐字复核 ${(fidelity * 100).toFixed(0)}% —— AI 可能改动了原文措辞，请核对下面的「口播」列。`
                    : `⚠️ Verbatim check ${(fidelity * 100).toFixed(0)}% — the AI may have reworded your script. Please check the Narration column.`}
                </div>
              )}
              {Array.isArray(warnings) && warnings.length > 0 && (
                <div className="mb-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 px-3 py-2 text-[12px] text-gray-600 dark:text-gray-400">
                  {warnings.map((w, i) => <div key={i}>· {w}</div>)}
                </div>
              )}

              {shots.length === 0 && (
                <div className="py-12 text-center text-sm text-gray-500">
                  {isZh ? '没有解析出任何分镜' : 'No shots parsed'}
                </div>
              )}

              {/* 表头:没有它,那一串数字和标签用户根本不知道是什么 */}
              {shots.length > 0 && (
                <div className="flex items-center gap-2 px-3 pb-1.5 text-[11px] text-gray-400 dark:text-gray-500">
                  <span className="w-7 shrink-0">#</span>
                  <span className="w-14 shrink-0">{isZh ? '秒' : 'Sec'}</span>
                  <span className="w-[68px] shrink-0">{isZh ? '画面类型' : 'Type'}</span>
                  <span className="flex-1 min-w-0">{isZh ? '念什么 / 画什么' : 'Narration / Visual'}</span>
                  <span className="shrink-0">{isZh ? '生成视频' : 'Animate'}</span>
                  <span className="w-[92px] shrink-0" />
                </div>
              )}
              <div className="space-y-2">
                {shots.map((s, i) => {
                  const meta = TYPE_META[s.type] || TYPE_META.scene;
                  const isOpen = expanded === i;
                  return (
                    <div
                      key={i}
                      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-800/40"
                    >
                      {/* 行头 */}
                      <div className="flex items-center gap-2 px-3 py-2">
                        <span className="w-7 shrink-0 text-[12px] text-gray-400 tabular-nums">{i + 1}</span>
                        <input
                          type="number"
                          min={1}
                          max={120}
                          value={s.seconds}
                          onChange={(e) => patch(i, { seconds: Math.max(1, Math.min(120, Number(e.target.value) || 1)) })}
                          className="w-14 shrink-0 rounded border border-gray-300 dark:border-gray-700 bg-transparent px-1.5 py-0.5 text-[12px] dark:text-white tabular-nums"
                          title={isZh ? '时长（秒）。有旁白时最终以真实配音时长为准' : 'Seconds (final length follows the real TTS duration)'}
                        />
                        <select
                          value={s.type}
                          onChange={(e) => patch(i, { type: e.target.value as ShotType })}
                          className={`w-[68px] shrink-0 rounded px-1 py-0.5 text-[11px] border-0 ${meta.cls}`}
                        >
                          {TYPE_ORDER.map((t) => (
                            <option key={t} value={t}>{isZh ? TYPE_META[t].zh : TYPE_META[t].en}</option>
                          ))}
                        </select>
                        <div
                          className="flex-1 min-w-0 cursor-pointer"
                          onClick={() => setExpanded(isOpen ? null : i)}
                          title={`${isZh ? '念' : 'Say'}: ${s.narration}
${isZh ? '画面' : 'Visual'}: ${s.visualFirst}`}
                        >
                          <div className="truncate text-[13px] dark:text-gray-200">
                            <span className="text-gray-400 mr-1">{isZh ? '念' : 'Say'}</span>
                            {s.narration || <span className="text-gray-400">{isZh ? '（这一镜不说话）' : '(silent)'}</span>}
                          </div>
                          {/* 画面是这一镜真正会被画出来的东西 —— 藏在展开里等于没有 */}
                          <div className="truncate text-[12px] text-gray-500 dark:text-gray-400">
                            <span className="text-gray-400 mr-1">{isZh ? '画' : 'See'}</span>
                            {s.visualFirst || <span className="text-amber-500">{isZh ? '（没写画面，AI 会自己发挥）' : '(no visual — AI will improvise)'}</span>}
                          </div>
                        </div>
                        <label
                          className="shrink-0 flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400 cursor-pointer"
                          title={isZh ? '勾上 = 这一镜用 AI 生成会动的视频，按秒收费；不勾 = 出一张图慢慢推近，几乎不花钱' : 'Ticked = AI-generated moving video for this shot, charged per second. Unticked = a still image with a slow push-in, nearly free.'}
                        >
                          <input
                            type="checkbox"
                            checked={!!s.animate}
                            onChange={(e) => patch(i, { animate: e.target.checked })}
                            className="accent-fuchsia-500"
                          />
                          {isZh ? '要动' : 'Animate'}
                        </label>
                        <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                          className="shrink-0 px-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-30" title={isZh ? '上移' : 'Move up'}>↑</button>
                        <button type="button" onClick={() => move(i, 1)} disabled={i === shots.length - 1}
                          className="shrink-0 px-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-30" title={isZh ? '下移' : 'Move down'}>↓</button>
                        <button type="button" onClick={() => removeAt(i)}
                          className="shrink-0 px-1 text-gray-400 hover:text-red-500" title={isZh ? '删除这一镜' : 'Delete shot'}>🗑</button>
                        <button type="button" onClick={() => setExpanded(isOpen ? null : i)}
                          className="shrink-0 px-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">{isOpen ? '▴' : '▾'}</button>
                      </div>

                      {/* 展开:可编辑详情 */}
                      {isOpen && (
                        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-gray-100 dark:border-gray-800">
                          <Row
                            label={isZh ? '口播（逐字照念）' : 'Narration (verbatim)'}
                            locked={isLocked(s, 'narration')}
                            isZh={isZh}
                          >
                            <textarea
                              value={s.narration}
                              onChange={(e) => patch(i, { narration: e.target.value })}
                              rows={2}
                              className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-[12px] dark:text-white resize-y"
                            />
                          </Row>
                          <Row
                            label={isZh ? '画面（决定这镜画什么）' : 'Visual (what gets generated)'}
                            locked={isLocked(s, 'visual_first')}
                            isZh={isZh}
                          >
                            <textarea
                              value={s.visualFirst}
                              onChange={(e) => patch(i, { visualFirst: e.target.value })}
                              rows={2}
                              className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-[12px] dark:text-white resize-y"
                            />
                          </Row>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <Row label={isZh ? '花字（打在屏幕上）' : 'On-screen text'} locked={isLocked(s, 'on_screen_text')} isZh={isZh}>
                              <input
                                value={s.onScreenText || ''}
                                onChange={(e) => patch(i, { onScreenText: e.target.value })}
                                className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-[12px] dark:text-white"
                              />
                            </Row>
                            <Row label={isZh ? '配乐情绪' : 'Music mood'} locked={isLocked(s, 'bgm_mood')} isZh={isZh}>
                              <input
                                value={s.bgmMood || ''}
                                onChange={(e) => patch(i, { bgmMood: e.target.value })}
                                placeholder={isZh ? '轻快 / 紧张 / 悬疑 / 大气…' : 'upbeat / tense / mystery…'}
                                className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-[12px] dark:text-white"
                              />
                            </Row>
                          </div>
                          {s.animate && (
                            <Row label={isZh ? '运动（只在生成视频时用）' : 'Motion (video only)'} locked={isLocked(s, 'motion')} isZh={isZh}>
                              <input
                                value={s.motion || ''}
                                onChange={(e) => patch(i, { motion: e.target.value })}
                                placeholder={isZh ? '如：镜头缓慢推近，人物转头看向窗外' : 'e.g. slow push-in, subject turns toward the window'}
                                className="w-full rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-[12px] dark:text-white"
                              />
                            </Row>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* 脚:统计 + 费用 + 确认 */}
        <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-800 flex flex-wrap items-center gap-x-4 gap-y-2 justify-between">
          <div className="text-[12px] text-gray-600 dark:text-gray-400">
            <span className="dark:text-gray-200 font-medium">{shots.length}</span> {isZh ? '镜' : 'shots'}
            <span className="mx-2 text-gray-300 dark:text-gray-700">·</span>
            {isZh ? '约' : '~'} <span className="dark:text-gray-200 font-medium">{totalSec}</span>s
            <span className="mx-2 text-gray-300 dark:text-gray-700">·</span>
            {isZh ? '首帧' : 'frames'} <span className="dark:text-gray-200 font-medium">{shots.length}</span> {isZh ? '张' : ''}
            <span className="mx-2 text-gray-300 dark:text-gray-700">·</span>
            {isZh ? '生成视频' : 'animated'} <span className={animateCount > 0 ? 'text-fuchsia-600 dark:text-fuchsia-400 font-medium' : 'dark:text-gray-200 font-medium'}>{animateCount}</span> {isZh ? '镜' : ''}
            {estCredits != null && animateCount > 0 && (
              <span className="ml-2 text-fuchsia-600 dark:text-fuchsia-400">
                ≈ {estCredits.toLocaleString()} {isZh ? '积分' : 'credits'}
                {estUsd != null && ` ($${estUsd.toFixed(2)})`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              {isZh ? '返回修改' : 'Back'}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={loading || !!error || shots.length === 0}
              className="px-5 py-2 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium"
            >
              {isZh ? '确认，开始生成' : 'Confirm & generate'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row(props: { label: string; locked?: boolean; isZh: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-0.5 flex items-center gap-1">
        {props.label}
        {props.locked && (
          <span
            className="text-[10px] px-1 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            title={props.isZh ? '来自你的脚本，AI 没有改动' : 'From your script — untouched by AI'}
          >
            🔒 {props.isZh ? '你写的' : 'yours'}
          </span>
        )}
      </div>
      {props.children}
    </div>
  );
}
