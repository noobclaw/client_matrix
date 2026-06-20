// useCountUp — 数字滚动 hook,ease-out cubic 缓动,600ms 默认。
//
// 历史:本来只在 PartnerHero(邀请页顶部 banner)用,用来把"返佣比例 40%"
// 从 0 滚到 40。v1.x 把同样的效果扩到 InviteView 右上 4 张统计卡(直接邀请 /
// 总网络 / USDT 总返佣 / $Noob 奖励),所以抽到独立 hook。
//
// 行为:
//   - target 变化(包括从 0 → N、从 N → M)都会重新从 0 滚到新 target
//     (跟 PartnerHero 原行为一致;后续若要 "从上次值滚到新值",改这里一处即可)
//   - target 是 NaN / undefined / null → 当 0 处理(setVal(0)、立刻结束)
//   - 组件 unmount 时 cancelAnimationFrame 不留尾巴
//
// 用法:
//   const v = useCountUp(profile?.totalNoob ?? 0);
//   <span>{Math.floor(v).toLocaleString()}</span>
//
//   const u = useCountUp(parseFloat(usdt));
//   <span>${u.toFixed(2)}</span>
import { useEffect, useState } from 'react';

export function useCountUp(target: number, durationMs = 600): number {
  const [val, setVal] = useState(0);
  useEffect(() => {
    const safeTarget = Number.isFinite(target) ? target : 0;
    if (safeTarget === 0) {
      setVal(0);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);  // ease-out cubic
      setVal(safeTarget * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return val;
}

export default useCountUp;
