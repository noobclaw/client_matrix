import React, { useState, useEffect, useCallback } from 'react';
import { noobClawAuth } from '../../services/noobclawAuth';
import { noobClawApi } from '../../services/noobclawApi';

// 嵌入「我的充值」页「会员订阅」tab 的会员面板(无独立页面 chrome)。
// 4 档(免费版第一)+ 周期选择 + 支付方式(USDT / BNB / 人民币兑换码)。
// 配色用 .text-primary / .bg-primary 等(随 WalletView 的 partner 金 / 默认绿主题自动适配)。

type Period = 'month' | 'quarter' | 'half' | 'year';
type PayMethod = 'TRON' | 'BSC' | 'RMB';

const PERIODS: Array<{ key: Period; label: string }> = [
  { key: 'month', label: '月付' },
  { key: 'quarter', label: '季付' },
  { key: 'half', label: '半年' },
  { key: 'year', label: '年付' },
];
const PERIOD_LABEL: Record<string, string> = { month: '月', quarter: '季', half: '半年', year: '年' };
const PERIOD_MONTHS: Record<Period, number> = { month: 1, quarter: 3, half: 6, year: 12 };
const RECOMMENDED = 'pro';
// 档位主题色:免费灰 / 基础蓝银 / 进阶金 / 旗舰紫。
const TIER_COLOR: Record<string, string> = { free: '#9aa0aa', basic: '#60a5fa', pro: '#fbbf24', max: '#a78bfa' };

function fmtCredits(n: number): string {
  n = Number(n) || 0;
  if (n >= 1e8) return (Math.round(n / 1e7) / 10) + '亿';
  if (n >= 1e4) return Math.round(n / 1e4) + '万';
  return String(n);
}

const MembershipPanel: React.FC<{ onPay?: (planCode: string, period: Period, chain: 'TRON' | 'BSC') => Promise<string | null> }> = ({ onPay }) => {
  const [cfg, setCfg] = useState<Awaited<ReturnType<typeof noobClawApi.getPlanConfig>>>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<Period>('month');
  const [method, setMethod] = useState<PayMethod>('TRON');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // rmb redeem
  const [redeemInput, setRedeemInput] = useState('');
  const [redeemMsg, setRedeemMsg] = useState<{ text: string; color: string }>({ text: '', color: '' });
  const [redeemBusy, setRedeemBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await noobClawApi.getPlanConfig();
    if (data) setCfg(data);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const plans = cfg?.plans || [];
  const cur = cfg?.current;
  const curCode = cur?.planCode || 'free';

  // 订阅下单交给 WalletView,复用「购买积分」那套支付步骤(QR/倒计时/轮询/取消)。失败回错误串在此显示。
  const subscribe = async (planCode: string) => {
    if (method === 'RMB' || !onPay) return;
    setBusy(true); setError('');
    const chain: 'TRON' | 'BSC' = method === 'BSC' ? 'BSC' : 'TRON';
    const err = await onPay(planCode, period, chain);
    if (err) setError(err);
    setBusy(false);
  };

  const submitRedeem = async () => {
    const code = redeemInput.trim();
    if (!code) { setRedeemMsg({ text: '请输入兑换码', color: '#ef4444' }); return; }
    setRedeemBusy(true); setRedeemMsg({ text: '', color: '' });
    try {
      const d = await noobClawApi.redeemCode(code);
      if (!d || !d.ok) { setRedeemMsg({ text: (d && d.message) || '兑换失败', color: '#ef4444' }); return; }
      setRedeemInput('');
      setRedeemMsg({
        text: d.product_type === 'subscription'
          ? `✅ 会员已开通(${PERIOD_LABEL[d.plan_period || ''] || ''}),本月算力已发放`
          : `✅ 已到账 ${Number(d.credits ?? 0).toLocaleString()} 算力`,
        color: '#22c55e',
      });
      await noobClawAuth.refreshBalance(); await load();
    } finally { setRedeemBusy(false); }
  };

  if (loading) return <div className="text-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary py-12">加载中…</div>;
  if (!cfg) return <div className="text-center text-sm text-red-400 py-12">会员套餐加载失败,请稍后重试(后端需部署)</div>;

  // ── 选择视图 ──
  const planName = (p: any) => p?.name_zh || p?.name_en || '';
  const sorted = [...plans].sort((a, b) => a.sort_order - b.sort_order); // free 在前

  return (
    <div>
      {/* 支付方式 */}
      <div className="mb-3 flex gap-2 p-1 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
        {([['TRON', 'USDT'], ['BSC', 'BNB'], ['RMB', 'CNY(兑换码)']] as Array<[PayMethod, string]>).map(([m, label]) => (
          <button key={m} onClick={() => { setMethod(m); setError(''); }} className={`flex-1 py-2 rounded-md text-xs font-semibold transition-all ${method === m ? 'bg-primary/15 text-primary' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'}`}>{label}</button>
        ))}
      </div>

      {/* 周期(折扣在卡片里显示,这里只切周期) */}
      <div className="mb-4 inline-flex rounded-lg overflow-hidden border dark:border-claude-darkBorder border-claude-border">
        {PERIODS.map(p => (
          <button key={p.key} onClick={() => setPeriod(p.key)} className={`px-4 py-2 text-xs ${period === p.key ? 'bg-primary text-black font-semibold' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText'}`}>{p.label}</button>
        ))}
      </div>

      {error && <div className="mb-3 p-3 rounded-lg bg-red-500/5 border border-red-500/20 text-xs text-red-400">{error}</div>}

      {/* 套餐卡(4 档,免费版第一) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {sorted.map(plan => {
          const isFree = plan.code === 'free';
          const isCur = plan.code === curCode;
          const isRec = plan.code === RECOMMENDED;
          const price = plan.prices?.[period];
          const tier = TIER_COLOR[plan.code] || '#9aa0aa';
          // 币种跟支付方式:USDT/BNB → 美元 $;CNY → 人民币 ¥。
          const useCny = method === 'RMB';
          const sym = useCny ? '¥' : '$';
          const months = PERIOD_MONTHS[period];
          const discount = price?.discount ?? 1;
          const finalP = isFree ? 0 : (useCny ? (price?.cny ?? plan.price_cny) : (price?.usd ?? plan.price_usd));
          const origP = useCny ? (plan.price_cny * months) : (plan.price_usd * months);
          const hasDiscount = !isFree && discount < 0.999;
          const off = Math.round(discount * 100) / 10; // 0.7→7、0.9→9
          return (
            <div key={plan.code} className="relative rounded-2xl p-4 flex flex-col dark:bg-claude-darkSurface bg-claude-surface"
              style={{ border: `${isRec ? 2 : 1}px solid`, borderColor: isRec ? tier : (isCur ? tier + '88' : 'rgba(255,255,255,0.08)'), boxShadow: isRec ? `0 0 26px -10px ${tier}` : undefined }}>
              {isRec && <span className="absolute -top-2.5 right-3 px-2 py-0.5 rounded-full text-[10px] font-bold text-black whitespace-nowrap" style={{ background: tier }}>最受欢迎</span>}
              {/* 档位名 + 档位色点 + 限时折扣 */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: tier }} />
                <span className="text-base font-semibold dark:text-claude-darkText text-claude-text">{planName(plan)}</span>
                {hasDiscount && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: '#ef444422', color: '#f87171' }}>限时{off}折</span>}
              </div>
              {/* 价格:最终价大字 + 原价划掉 + /周期 */}
              <div className="mt-3 flex items-end gap-1.5 flex-wrap">
                <span className="text-2xl font-extrabold dark:text-claude-darkText text-claude-text">{sym}{finalP}</span>
                {hasDiscount && <span className="text-xs line-through dark:text-claude-darkTextSecondary text-claude-textSecondary">{sym}{Math.round(origP)}</span>}
                {!isFree && <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">/{PERIOD_LABEL[period]}</span>}
              </div>
              <ul className="mt-3 space-y-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary flex-1">
                <li>· {isFree ? '注册礼 100万 积分' : `每月 ${fmtCredits(plan.monthly_credits)} 积分`}</li>
                <li>· 单平台最多 {plan.max_accounts_per_platform} 个号</li>
                <li>· {isFree ? '仅基础能力' : '全部能力可用'}</li>
              </ul>
              {isFree ? (
                <div className="mt-3 py-2 text-center text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{isCur ? '当前方案' : '免费'}</div>
              ) : method === 'RMB' ? (
                <div className="mt-3 py-2 text-center text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">CNY 请用下方兑换码</div>
              ) : (
                <button disabled={busy} onClick={() => subscribe(plan.code)} className="mt-3 py-2 rounded-lg text-xs font-bold text-black disabled:opacity-50 hover:brightness-95" style={{ background: tier }}>{isCur ? '续费 / 升级' : '订阅'}</button>
              )}
            </div>
          );
        })}
      </div>

      {/* 人民币兑换码 */}
      {method === 'RMB' && (
        <div className="mt-4 p-4 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-1">CNY 订阅(兑换码)</div>
          <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-3">在店铺购买订阅卡密后,在此输入兑换即可开通对应档位与周期。</div>
          <div className="flex gap-2">
            <input value={redeemInput} onChange={e => setRedeemInput(e.target.value)} placeholder="输入订阅兑换码" className="flex-1 px-3 py-2 rounded-lg dark:bg-claude-darkBg bg-claude-bg border dark:border-claude-darkBorder border-claude-border text-sm dark:text-claude-darkText text-claude-text focus:border-primary outline-none" />
            <button disabled={redeemBusy} onClick={submitRedeem} className="px-5 py-2 rounded-lg bg-primary text-black text-sm font-semibold disabled:opacity-50">{redeemBusy ? '兑换中…' : '兑换'}</button>
          </div>
          {redeemMsg.text && <div className="mt-2 text-xs" style={{ color: redeemMsg.color }}>{redeemMsg.text}</div>}
        </div>
      )}

      <p className="mt-5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">订阅赠送的算力按月发放、到期清零;你充值的算力永久有效、不受影响。到期需手动续费(暂不自动扣款)。</p>
    </div>
  );
};

export default MembershipPanel;
