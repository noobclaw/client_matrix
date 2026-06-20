import React, { useEffect, useRef, useState } from 'react';
import { i18nService } from '../services/i18n';

/* ────────────────────────────────────────────────────────────────────
   RebateDrawer — 右侧滑入抽屉,通知合伙人/邀请人:好友充值给你结算了佣金。
   全局组件(渲染于 App.tsx 顶层),跨页面通用,不依赖 mainView。

   触发:
     window.dispatchEvent(new CustomEvent('noobclaw:rebate-received', {
       detail: { amount: '0.20', fromWallet?: '0x...', level?: 1 },
     }))

   事件源(规划):
     - services/cowork.ts 的 `noobclaw:sse-payload` IPC 处理器会在
       backend payload 含 rebateNotification 字段时桥接派发(本次一起加)。
     - Backend 端在 rebate batch 上链确认后,塞进下一次 AI SSE 响应的
       _noobclaw 块中(沿用 luckyBag 路径)。Backend 那边的发推逻辑需要
       自己写,本组件只负责"看到事件就弹"。

   交互:
     - 从右侧滑入,4 秒后自动滑出(用户没操作的情况下)
     - 点击 → 调 onShowInvite() 跳邀请返佣页 + 立即关闭抽屉
     - hover 时暂停自动消失,鼠标离开后重新计时(避免用户正在读时被收走)
     - 短时间内连续到达多笔佣金时:后到的盖在前一个上面(不堆叠不丢失)
   ──────────────────────────────────────────────────────────────────── */

const AUTO_DISMISS_MS = 4_000;
const SLIDE_ANIM_MS = 350;

interface RebateDetail {
  amount: string | number;
  fromWallet?: string;
  level?: number;
}

interface RebateDrawerProps {
  onShowInvite: () => void;
}

const RebateDrawer: React.FC<RebateDrawerProps> = ({ onShowInvite }) => {
  // 'idle' = 隐藏 / 'entering' = 滑入中 / 'visible' = 已停留 / 'exiting' = 滑出中
  const [phase, setPhase] = useState<'idle' | 'entering' | 'visible' | 'exiting'>('idle');
  const [detail, setDetail] = useState<RebateDetail | null>(null);
  // 关闭按钮的 hover state — 单独管 visual,不污染卡片整体的 cursor:pointer。
  // v1.x bugfix: 这个 useState 原来定义在 phase==='idle' 的 early return 之后,
  // 第一次 render(idle 状态)从未注册到 React hooks 链表,事件触发 phase→visible
  // 后不再 early return,这个 hook 突然多出来,React Hooks 规则破坏 → 抛 #310
  // → 整个 RebateDrawer crash → 上层无 ErrorBoundary 时整 App 黑屏。
  // Hooks 必须在 early return **之前**,顺序固定,所以提到这里。
  const [closeHover, setCloseHover] = useState(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const exitTimerRef = useRef<ReturnType<typeof setTimeout>>();
  // enterTimerRef 是触发 entering→visible 的 30ms 微延后,用 ref 包住为了在
  // unmount / 新事件接管 / clearTimers 路径中能取消。漏了它会出现:组件 unmount
  // 在 30ms 内的 race window 时,timer 仍然 fire 一次 setPhase('visible'),React
  // 报 "state update on unmounted component" 警告(微内存泄漏)。
  const enterTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const isHoveringRef = useRef(false);

  const clearTimers = () => {
    if (dismissTimerRef.current) { clearTimeout(dismissTimerRef.current); dismissTimerRef.current = undefined; }
    if (exitTimerRef.current) { clearTimeout(exitTimerRef.current); exitTimerRef.current = undefined; }
    if (enterTimerRef.current) { clearTimeout(enterTimerRef.current); enterTimerRef.current = undefined; }
  };

  const startAutoDismiss = () => {
    clearTimers();
    dismissTimerRef.current = setTimeout(() => {
      if (isHoveringRef.current) {
        // 用户鼠标还在卡上 — 推迟。mouseleave 会重新调用 startAutoDismiss。
        return;
      }
      setPhase('exiting');
      exitTimerRef.current = setTimeout(() => {
        setPhase('idle');
        setDetail(null);
      }, SLIDE_ANIM_MS);
    }, AUTO_DISMISS_MS);
  };

  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as RebateDetail | undefined;
      if (!d || d.amount === undefined || d.amount === null) return;
      // 新事件直接接管:不论当前是 entering/visible/exiting,清旧计时,
      // 用新 detail 重新滑入。最差情况是用户错过上一笔的最后 0.x 秒,
      // 但保证最新的那笔一定能展示满 4s,符合"重要佣金不能漏"的产品诉求。
      clearTimers();
      setDetail(d);
      setPhase('entering');
      // 微延后切到 visible,触发 transition;放在 ref 里方便 clearTimers 取消,
      // 避免 unmount race window 里的 setPhase-on-unmounted 警告。
      enterTimerRef.current = setTimeout(() => setPhase('visible'), 30);
      startAutoDismiss();
    };
    window.addEventListener('noobclaw:rebate-received', handler);
    // v1.x 关键 bugfix: 通知 noobclawAuth listener 已就绪。修复 module-singleton
    // 在 React 渲染前就 atomic 标记 notified_at + dispatch 事件,但 listener
    // 还没注册导致事件落入虚空的 race。先 addEventListener 再 dispatch ready
    // 信号 — noobclawAuth 收到信号后 flush 暂存的 pending rebates,这次能被
    // 上面的 listener 接到。
    window.dispatchEvent(new Event('noobclaw:rebate-drawer-ready'));
    return () => {
      window.removeEventListener('noobclaw:rebate-received', handler);
      clearTimers();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === 'idle' || !detail) return null;

  const offscreen = phase === 'entering' || phase === 'exiting';
  // 格式化金额 — 兼容字符串 / 数字两种入参,统一渲染成最多 4 位小数(USDT 链上精度
  // 通常 6 位,前端展示 4 位足够;尾随 0 保留以体现"真金白银"质感)。
  const fmtAmount = (() => {
    const n = typeof detail.amount === 'string' ? parseFloat(detail.amount) : detail.amount;
    if (!Number.isFinite(n)) return String(detail.amount);
    return n.toFixed(n >= 1 ? 2 : 4);
  })();

  const dismissNow = () => {
    clearTimers();
    setPhase('exiting');
    exitTimerRef.current = setTimeout(() => {
      setPhase('idle');
      setDetail(null);
    }, SLIDE_ANIM_MS);
  };

  const handleClick = () => {
    clearTimers();
    setPhase('exiting');
    onShowInvite();
    exitTimerRef.current = setTimeout(() => {
      setPhase('idle');
      setDetail(null);
    }, SLIDE_ANIM_MS);
  };

  // (closeHover 已经在组件顶部所有 hooks 一起定义,见上面的 bugfix 注释)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
      onMouseEnter={() => { isHoveringRef.current = true; }}
      onMouseLeave={() => { isHoveringRef.current = false; startAutoDismiss(); }}
      style={{
        position: 'fixed',
        top: 72,
        right: offscreen ? -380 : 16,
        zIndex: 10000,
        width: 340,
        padding: '14px 36px 14px 16px',  // 右内边距留给 × 按钮
        borderRadius: 14,
        background: 'linear-gradient(135deg, rgba(8,16,10,0.97) 0%, rgba(12,28,18,0.97) 100%)',
        // v1.x 用户反馈:边框要"显眼的绿色框"、统一(非合伙人也是绿色,不跟 partner tier 走)
        // 所以 border 用 inline solid #00FF88,绕开 body.invite-partner-active 的
        // .border-claude-accent cascade(本组件本来也没用那个 class,但加注释挡一下未来改动)。
        border: '2px solid #00FF88',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,255,136,0.2), 0 0 32px rgba(0,255,136,0.35)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        cursor: 'pointer',
        transition: `right ${SLIDE_ANIM_MS}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${SLIDE_ANIM_MS}ms ease`,
        opacity: offscreen ? 0 : 1,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        outline: 'none',
      }}
      aria-label={i18nService.t('rebateNotifyAria') || 'Rebate received'}
    >
      <div
        style={{
          width: 42, height: 42, borderRadius: 12, flexShrink: 0,
          background: 'linear-gradient(135deg, #00FF88 0%, #00D4A0 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, boxShadow: '0 0 16px rgba(0,255,136,0.4)',
        }}
        aria-hidden
      >
        💰
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13, color: '#e6ffee', lineHeight: 1.5, fontWeight: 500,
            wordBreak: 'break-word',
          }}
        >
          {(() => {
            // i18n 模板带 {amount} 占位,客户端在这里替换。
            // 兜底英文文案保证 i18n 漏 key 时也有合理输出。
            const tpl = i18nService.t('rebateNotifyMessage')
              || 'Congrats! Your friend topped up — you earned {amount} BUSDT in rebate.';
            const parts = tpl.split('{amount}');
            return (
              <>
                {parts[0]}
                <span style={{ color: '#00FF88', fontWeight: 700 }}>{fmtAmount} BUSDT</span>
                {parts[1] ?? ''}
              </>
            );
          })()}
        </div>
        <div
          style={{
            marginTop: 4, fontSize: 12, color: '#00FF88', fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          {i18nService.t('rebateNotifyCta') || 'View details'}
          <span style={{ fontSize: 14, lineHeight: 1 }}>›</span>
        </div>
      </div>
      {/* 关闭按钮 — 右上角小 ×。stopPropagation 防止冒泡到卡片 onClick(跳转邀请页)。
          仍然保留 4s 自动消失;这个按钮是给"想立刻清掉"的用户用的逃生口。 */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); dismissNow(); }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dismissNow(); } }}
        onMouseEnter={() => setCloseHover(true)}
        onMouseLeave={() => setCloseHover(false)}
        aria-label={i18nService.t('rebateNotifyClose') || 'Close'}
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
          width: 22,
          height: 22,
          borderRadius: 6,
          border: 'none',
          background: closeHover ? 'rgba(0,255,136,0.18)' : 'transparent',
          color: closeHover ? '#00FF88' : 'rgba(230,255,238,0.7)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          lineHeight: 1,
          padding: 0,
          transition: 'background 120ms ease, color 120ms ease',
        }}
      >
        ✕
      </button>
    </div>
  );
};

export default React.memo(RebateDrawer);
