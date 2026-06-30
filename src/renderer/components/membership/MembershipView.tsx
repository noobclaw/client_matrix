import React, { useState, useEffect, useCallback, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { noobClawAuth } from '../../services/noobclawAuth';
import { noobClawApi } from '../../services/noobclawApi';

interface MembershipViewProps {
  onShowWallet?: () => void;
}

type Period = 'month' | 'quarter' | 'half' | 'year';
type Chain = 'BSC' | 'TRON';

const PERIODS: Array<{ key: Period; label: string; off?: string }> = [
  { key: 'month', label: '月付' },
  { key: 'quarter', label: '季付', off: '9折' },
  { key: 'half', label: '半年', off: '8折' },
  { key: 'year', label: '年付', off: '7折' },
];

const PLATFORM_HINT: Record<string, string> = { '*': '全部平台' };

// 把后端百万级 credits 折成易读的「万」。仅用于套餐对比的额度展示。
function fmtCredits(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(n % 100_000_000 === 0 ? 0 : 1)}亿`;
  if (n >= 10_000) return `${Math.round(n / 10_000)}万`;
  return String(n);
}

const MembershipView: React.FC<MembershipViewProps> = ({ onShowWallet }) => {
  const [cfg, setCfg] = useState<Awaited<ReturnType<typeof noobClawApi.getPlanConfig>>>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<Period>('year');
  const [chain, setChain] = useState<Chain>('TRON');
  const [step, setStep] = useState<'select' | 'pay' | 'success'>('select');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // pay step
  const [payPlan, setPayPlan] = useState<string>('');
  const [payAmount, setPayAmount] = useState('');
  const [payAddress, setPayAddress] = useState('');
  const [paySymbol, setPaySymbol] = useState<'USDT' | 'BNB'>('USDT');
  const [copyToast, setCopyToast] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await noobClawApi.getPlanConfig();
    if (data) setCfg(data);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const currentPlanCode = cfg?.current?.planCode || 'free';
  const usedRatio = cfg?.current?.subUsedRatio ?? 0;
  const subActive = cfg?.current?.subActive ?? false;

  const planByCode = (code: string) => cfg?.plans.find(p => p.code === code) || null;
  const currentPlan = planByCode(currentPlanCode);

  // ── 下订阅单 ──
  const subscribe = async (planCode: string) => {
    setBusy(true);
    setError('');
    const res = await noobClawApi.createSubscriptionOrder(planCode, period, chain);
    if (res?.order) {
      const order = res.order;
      const isTron = chain === 'TRON';
      setPayPlan(planCode);
      setPayAmount(isTron ? String(parseFloat(order.usdt_amount)) : String(parseFloat(order.bnb_amount)));
      setPaySymbol(isTron ? 'USDT' : 'BNB');
      // TRON 收款地址随下单返回;BSC 从 /payment/info 取 treasury。
      let addr = res.treasuryWallet || '';
      if (!isTron) {
        const info: any = await noobClawApi.getPaymentInfo();
        addr = info?.chains?.BSC?.treasuryWallet || info?.treasuryWallet || '';
      }
      setPayAddress(addr);
      setStep('pay');
      startPoll(order.order_no);
    } else if (res?.code === 'PENDING_LIMIT') {
      setError('有未完成的订单,请先完成支付或等待其过期');
    } else if (res?.code === 'TRON_DISABLED') {
      setError('USDT(TRON)收款通道未配置,请改用 BNB 或联系客服');
    } else {
      setError(res?.error || '创建订单失败,请稍后重试');
    }
    setBusy(false);
  };

  const startPoll = (orderNo: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const r = await noobClawApi.pollOrderStatus(orderNo);
      const status = r?.order?.status;
      if (status === 'completed') {
        if (pollRef.current) clearInterval(pollRef.current);
        await noobClawAuth.refreshBalance();
        await load();
        setStep('success');
      } else if (status === 'failed' || status === 'cancelled' || status === 'expired') {
        if (pollRef.current) clearInterval(pollRef.current);
        setError('订单已失效或超时,请重新下单');
        setStep('select');
      }
    }, 5000);
  };

  const copyAddr = async () => {
    try { await navigator.clipboard.writeText(payAddress); setCopyToast(true); setTimeout(() => setCopyToast(false), 1500); } catch { /* ignore */ }
  };

  const backToSelect = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    setStep('select');
    setError('');
  };

  // ── 渲染:套餐选择 ──
  const renderSelect = () => {
    const paidPlans = (cfg?.plans || []).filter(p => p.code !== 'free');
    return (
      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* 当前档位 + 用量 */}
        <div className="rounded-2xl border border-border bg-card p-5 mb-8">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <span className="px-3 py-1 rounded-full text-sm font-semibold bg-primary/15 text-primary">
                当前:{currentPlan?.name_zh || '免费版'}
              </span>
              {subActive && cfg?.current?.periodEnd && (
                <span className="text-xs text-gray-400">到期 {new Date(cfg.current.periodEnd).toLocaleDateString()}</span>
              )}
            </div>
            <button onClick={onShowWallet} className="text-xs text-primary hover:underline">充值 / 兑换码 →</button>
          </div>
          {/* 订阅桶用量进度条(只显比例,不显数值) */}
          {subActive && currentPlan && currentPlan.monthly_credits > 0 && (
            <div className="mt-4">
              <div className="flex justify-between text-xs text-gray-400 mb-1">
                <span>本月用量</span>
                <span>{Math.round(usedRatio * 100)}%</span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, Math.round(usedRatio * 100))}%` }} />
              </div>
            </div>
          )}
        </div>

        {/* 周期 + 链选择 */}
        <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
          <div className="inline-flex rounded-lg border border-border overflow-hidden">
            {PERIODS.map(p => (
              <button key={p.key} onClick={() => setPeriod(p.key)}
                className={`px-4 py-2 text-sm ${period === p.key ? 'bg-primary text-white' : 'bg-card text-gray-300 hover:bg-muted'}`}>
                {p.label}{p.off && <span className="ml-1 text-xs opacity-80">{p.off}</span>}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-lg border border-border overflow-hidden">
            {(['TRON', 'BSC'] as Chain[]).map(c => (
              <button key={c} onClick={() => setChain(c)}
                className={`px-4 py-2 text-sm ${chain === c ? 'bg-primary text-white' : 'bg-card text-gray-300 hover:bg-muted'}`}>
                {c === 'TRON' ? 'USDT' : 'BNB'}
              </button>
            ))}
          </div>
        </div>

        {error && <div className="mb-4 text-sm text-red-400">{error}</div>}

        {/* 套餐卡 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {paidPlans.map(plan => {
            const price = plan.prices?.[period];
            const isCurrent = plan.code === currentPlanCode;
            return (
              <div key={plan.code} className={`rounded-2xl border p-5 flex flex-col ${isCurrent ? 'border-primary' : 'border-border'} bg-card`}>
                <div className="text-lg font-semibold">{plan.name_zh}</div>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-2xl font-bold">¥{price?.cny ?? plan.price_cny}</span>
                  <span className="text-xs text-gray-400">/{PERIODS.find(p => p.key === period)?.label}</span>
                </div>
                <div className="text-xs text-gray-400">≈ ${price?.usd ?? plan.price_usd}</div>
                <ul className="mt-4 space-y-1.5 text-sm text-gray-300 flex-1">
                  <li>· 每月 {fmtCredits(plan.monthly_credits)} 算力</li>
                  <li>· 单平台最多 {plan.max_accounts_per_platform} 个号</li>
                  <li>· {PLATFORM_HINT[plan.allowed_platforms] || plan.allowed_platforms}</li>
                  <li>· 全部能力可用</li>
                </ul>
                <button
                  disabled={busy}
                  onClick={() => subscribe(plan.code)}
                  className={`mt-4 py-2 rounded-lg text-sm font-medium ${isCurrent ? 'bg-muted text-gray-300' : 'bg-primary text-white hover:opacity-90'} disabled:opacity-50`}>
                  {isCurrent ? '续费 / 升级' : '订阅'}
                </button>
              </div>
            );
          })}
        </div>
        <p className="mt-6 text-xs text-gray-500">
          订阅赠送的算力按月发放、到期清零;你充值的算力永久有效、不受影响。到期需手动续费(暂不自动扣款)。
        </p>
      </div>
    );
  };

  // ── 渲染:支付 ──
  const renderPay = () => {
    const plan = planByCode(payPlan);
    return (
      <div className="max-w-md mx-auto px-6 py-8">
        <button onClick={backToSelect} className="text-sm text-gray-400 hover:text-gray-200 mb-4">← 返回选择</button>
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="text-center mb-4">
            <div className="text-sm text-gray-400">订阅 {plan?.name_zh} · {PERIODS.find(p => p.key === period)?.label}</div>
            <div className="mt-1 text-2xl font-bold">{payAmount} {paySymbol}</div>
            <div className="text-xs text-gray-500 mt-1">请向下方地址转账【精确金额】(含小数尾数用于自动对账)</div>
          </div>
          {payAddress ? (
            <div className="flex flex-col items-center">
              <div className="bg-white p-3 rounded-lg"><QRCodeSVG value={payAddress} size={160} /></div>
              <div className="mt-3 w-full">
                <div className="text-xs text-gray-400 mb-1">{chain === 'TRON' ? 'USDT-TRC20' : 'BNB (BSC)'} 收款地址</div>
                <div className="flex items-center gap-2 bg-muted rounded-lg px-3 py-2">
                  <span className="text-xs break-all flex-1">{payAddress}</span>
                  <button onClick={copyAddr} className="text-xs text-primary shrink-0">{copyToast ? '已复制' : '复制'}</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center text-sm text-red-400">收款地址未配置,请联系客服</div>
          )}
          <div className="mt-5 flex items-center justify-center gap-2 text-sm text-gray-400">
            <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
            转账后自动到账,正在等待链上确认…
          </div>
        </div>
      </div>
    );
  };

  // ── 渲染:成功 ──
  const renderSuccess = () => {
    const plan = planByCode(payPlan);
    return (
      <div className="max-w-md mx-auto px-6 py-16 text-center">
        <div className="text-5xl mb-4">🎉</div>
        <div className="text-xl font-semibold mb-2">订阅已开通</div>
        <div className="text-sm text-gray-400 mb-6">{plan?.name_zh} 已生效,本月算力已发放。</div>
        <button onClick={() => { setStep('select'); load(); }} className="px-6 py-2 rounded-lg bg-primary text-white text-sm">完成</button>
      </div>
    );
  };

  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="px-6 pt-6">
        <h1 className="text-xl font-bold">会员中心</h1>
      </div>
      {loading ? (
        <div className="text-center text-sm text-gray-400 py-20">加载中…</div>
      ) : step === 'select' ? renderSelect() : step === 'pay' ? renderPay() : renderSuccess()}
    </div>
  );
};

export default MembershipView;
