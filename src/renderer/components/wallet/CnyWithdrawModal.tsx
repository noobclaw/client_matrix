/**
 * CnyWithdrawModal — CNY 人民币提现弹窗(客户端)
 *
 * 后端 routes/withdrawCny.ts 已就绪;本组件只做 UI:
 *   ① 拉额度 summary(可提现/已提现/处理中 + ¥50 起、上限、fee_pct)
 *   ② 选支付宝/微信 + 上传收款码(POST /upload-qr → R2 URL)
 *   ③ 填金额 → POST /api/me/withdraw/cny → 运营 1-3 工作日手动转账
 *   ④ 历史列表(pending/paid/canceled)
 *
 * 共享组件:InviteView(返佣页)和 WalletView(充值页)两处入口都开它。
 * 同时只允许 1 笔 pending(后端强约束),has_pending 时表单禁用。
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { noobClawApi } from '../../services/noobclawApi';

type Summary = {
  total_earned: string; total_paid: string; total_pending: string;
  withdrawable: string; has_pending: boolean;
  min_amount: number; max_amount: number; fee_pct: number;
  qr_alipay?: string | null; qr_wechat?: string | null; // 记住的收款码(支付宝/微信各一张)
};
type HistItem = {
  id: string; amount_cny: string; fee_pct: number; amount_paid_cny: string;
  qr_kind: string; qr_image_url?: string | null; status: 'pending' | 'paid' | 'canceled';
  created_at: string; paid_at: string | null; paid_note: string | null; external_ref: string | null;
};

export const CnyWithdrawModal: React.FC<{
  isZh: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}> = ({ isZh, onClose, onSuccess }) => {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [history, setHistory] = useState<HistItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [amount, setAmount] = useState('');
  const [qrKind, setQrKind] = useState<'alipay' | 'wechat'>('alipay');
  const [qrUrl, setQrUrl] = useState('');         // 上传成功后的 R2 URL
  const [qrUploading, setQrUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ text: string; color: string }>({ text: '', color: '' });
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async (): Promise<{ items: HistItem[]; summary: Summary | null }> => {
    const [s, h] = await Promise.all([
      noobClawApi.getCnyWithdrawSummary(),
      noobClawApi.getCnyWithdrawHistory(10),
    ]);
    if (s) setSummary(s);
    const items: HistItem[] = h.items || [];
    setHistory(items);
    setLoading(false);
    return { items, summary: s };
  };
  // 收款码:支付宝/微信【各记住一张】(后端 users.cny_qr_*),开窗 + 切收款方式时自动回填,不必每次重传;删了再传就是新的。
  const savedQrFor = (kind: 'alipay' | 'wechat', s: Summary | null): string =>
    (kind === 'wechat' ? s?.qr_wechat : s?.qr_alipay) || '';
  useEffect(() => {
    void (async () => {
      const { summary: s } = await refresh();
      setQrUrl(savedQrFor(qrKind, s)); // qrKind 默认 alipay → 回填支付宝那张(若已记住)
    })();
  }, []);

  const handlePickQr = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setQrUploading(true);
    setMsg({ text: '', color: '' });
    try {
      const r = await noobClawApi.uploadCnyWithdrawQr(file, qrKind); // 带 kind → 后端按支付宝/微信记住
      if (r.ok && r.url) { setQrUrl(r.url); void refresh(); } // refresh 让 summary.qr_* 更新(切收款方式时回填用)
      else setMsg({ text: (isZh ? '收款码上传失败:' : 'QR upload failed: ') + (r.error || ''), color: 'text-red-500' });
    } finally {
      setQrUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleSubmit = async () => {
    if (submitting) return;
    // summary 没拉到(后端 /summary 非 200 / 网络问题)→ 之前这里静默 return,点了没反应。
    // 现在给明确提示,而不是让用户对着无反应的按钮发呆。
    if (!summary) { setMsg({ text: isZh ? '提现额度未加载成功,请关闭重开或检查网络后重试' : 'Withdrawal info failed to load — reopen or check your network and retry', color: 'text-red-500' }); return; }
    // 必填项优先提示:收款方式已默认选中,收款码 + 金额是用户必须填的。
    if (!qrUrl) { setMsg({ text: isZh ? '请先上传收款码' : 'Please upload your receive QR first', color: 'text-red-500' }); return; }
    if (!amount.trim()) { setMsg({ text: isZh ? '请输入提现金额' : 'Please enter the withdrawal amount', color: 'text-red-500' }); return; }
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) { setMsg({ text: isZh ? '请输入有效的提现金额' : 'Enter a valid amount', color: 'text-red-500' }); return; }
    if (amt < summary.min_amount) { setMsg({ text: (isZh ? `最低提现 ¥${summary.min_amount}` : 'Min ¥' + summary.min_amount), color: 'text-red-500' }); return; }
    if (amt > summary.max_amount) { setMsg({ text: (isZh ? `单笔上限 ¥${summary.max_amount}` : 'Max ¥' + summary.max_amount), color: 'text-red-500' }); return; }
    if (amt > parseFloat(summary.withdrawable)) { setMsg({ text: (isZh ? `超过可提现余额 ¥${summary.withdrawable}` : 'Over withdrawable ¥' + summary.withdrawable), color: 'text-red-500' }); return; }
    setSubmitting(true);
    setMsg({ text: '', color: '' });
    try {
      const r = await noobClawApi.createCnyWithdraw(amt, qrUrl, qrKind);
      if (r.ok) {
        setMsg({ text: r.message || (isZh ? '✅ 申请已提交,工作人员将在 1-3 个工作日内处理' : '✅ Submitted, our team will process it within 1-3 business days'), color: 'text-green-500' });
        setAmount(''); // 保留 qrUrl —— 记住收款码,下次提现直接用,省得重传
        await refresh();
        onSuccess?.();
      } else {
        const errMap: Record<string, string> = {
          pending_exists: isZh ? '已有一笔提现处理中,请等运营处理后再申请' : 'A withdrawal is already pending',
          over_withdrawable: (isZh ? '超过可提现余额 ¥' : 'Over withdrawable ¥') + (r.withdrawable || ''),
          below_min: (isZh ? '低于最低提现额 ¥' : 'Below min ¥') + (r.min || ''),
          above_max: (isZh ? '超过单笔上限 ¥' : 'Above max ¥') + (r.max || ''),
        };
        setMsg({ text: errMap[r.error || ''] || (isZh ? '提交失败:' : 'Failed: ') + (r.error || ''), color: 'text-red-500' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls = 'w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500/50';
  const statusLabel = (s: string) => isZh
    ? ({ pending: '处理中', paid: '已转账', canceled: '已取消' }[s] || s)
    : s;
  const hasPending = !!summary?.has_pending;

  // v2.8: 用 portal 渲染到 document.body —— 否则在「我的充值」页被合伙人金色卡片的
  //   filter/glow 当成 position:fixed 的包含块,全屏遮罩被裁进卡片里(弹窗显示不全)。
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl p-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-bold dark:text-white">💴 {isZh ? 'CNY 提现' : 'Withdraw CNY'}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {loading ? (
          <div className="py-10 text-center text-sm text-gray-500">{isZh ? '加载中...' : 'Loading...'}</div>
        ) : (
          <>
            {/* 额度三数字 —— 纯文字一行,不套框 */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mb-4 text-sm">
              {[
                { label: isZh ? '可提现' : 'Withdrawable', val: summary?.withdrawable, hi: true },
                { label: isZh ? '处理中' : 'Pending', val: summary?.total_pending },
                { label: isZh ? '已提现' : 'Paid', val: summary?.total_paid },
              ].map((x, i) => (
                <span key={i} className="text-gray-500 dark:text-gray-400">
                  {x.label}：<span className={`font-bold ${x.hi ? 'text-green-500' : 'dark:text-white'}`}>¥{x.val ?? '0.00'}</span>
                </span>
              ))}
            </div>

            {hasPending && (
              <div className="mb-3 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                {isZh ? '已有一笔提现处理中,运营处理后才能申请下一笔。' : 'A withdrawal is pending; wait for it to be processed.'}
              </div>
            )}

            {/* 表单 */}
            <fieldset disabled={hasPending || submitting} className={hasPending ? 'opacity-50' : ''}>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">{isZh ? '收款方式' : 'Receive via'}</label>
              <div className="grid grid-cols-2 gap-2 mb-3">
                {(['alipay', 'wechat'] as const).map((k) => (
                  <button key={k} type="button" onClick={() => { setQrKind(k); setQrUrl(savedQrFor(k, summary)); setMsg({ text: '', color: '' }); }}
                    className={`rounded-lg border p-2 text-sm ${qrKind === k ? 'border-green-500 bg-green-500/10 text-green-600 dark:text-green-400 font-medium' : 'border-gray-300 dark:border-gray-700 dark:text-gray-300'}`}>
                    {k === 'alipay' ? (isZh ? '支付宝' : 'Alipay') : (isZh ? '微信' : 'WeChat')}
                  </button>
                ))}
              </div>

              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">{isZh ? '收款码' : 'Receive QR code'}</label>
              {qrUrl ? (
                // 已有收款码(本次上传 或 记住的上次):展示大图 + 删除 / 重新上传
                <div className="flex items-start gap-3 mb-3">
                  <div className="relative">
                    <img src={qrUrl} alt="qr" className="w-24 h-24 rounded-lg border border-gray-200 dark:border-gray-700 object-cover bg-white" />
                    <button type="button" title={isZh ? '删除' : 'Remove'} onClick={async () => { setQrUrl(''); try { await noobClawApi.deleteCnyWithdrawQr(qrKind); void refresh(); } catch { /* 删除失败不阻塞,重传会覆盖 */ } }}
                      className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-red-500 text-white text-xs leading-none flex items-center justify-center shadow hover:bg-red-600">×</button>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11px] text-gray-400">{isZh ? '已上传(可删除后重传)' : 'Uploaded (remove to replace)'}</span>
                    <button type="button" onClick={() => fileRef.current?.click()} disabled={qrUploading}
                      className="px-3 py-1.5 rounded-lg text-xs border border-gray-300 dark:border-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 w-fit">
                      {qrUploading ? (isZh ? '上传中...' : 'Uploading...') : (isZh ? '重新上传' : 'Re-upload')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 mb-3">
                  <button type="button" onClick={() => fileRef.current?.click()} disabled={qrUploading}
                    className="px-3 py-2 rounded-lg text-sm border border-gray-300 dark:border-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">
                    {qrUploading ? (isZh ? '上传中...' : 'Uploading...') : (isZh ? '上传收款码' : 'Upload QR')}
                  </button>
                  <span className="text-[11px] text-gray-400">{isZh ? '支付宝/微信「我的收款码」截图' : 'Your Alipay/WeChat receive-QR screenshot'}</span>
                </div>
              )}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={handlePickQr} />

              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                {isZh ? '本次提现金额 (¥)' : 'Withdrawal amount (¥)'}
                <span className="text-[11px] text-gray-400 ml-1">
                  {isZh ? `¥${summary?.min_amount ?? 10} 起,最多 ¥${summary?.withdrawable ?? '0.00'}` : `min ¥${summary?.min_amount ?? 10}, up to ¥${summary?.withdrawable ?? '0.00'}`}
                </span>
              </label>
              <input className={inputCls} type="number" min={summary?.min_amount} value={amount}
                onChange={(e) => setAmount(e.target.value)} placeholder={String(summary?.min_amount || 10)} />

              {summary && summary.fee_pct > 0 && (
                <p className="text-[11px] text-gray-400 mt-1">{isZh ? `手续费 ${(summary.fee_pct * 100).toFixed(0)}%` : `Fee ${(summary.fee_pct * 100).toFixed(0)}%`}</p>
              )}

              <button type="button" onClick={handleSubmit} disabled={submitting || hasPending}
                className="w-full mt-4 py-2.5 rounded-lg text-sm font-semibold bg-green-500 text-white hover:bg-green-600 disabled:opacity-50">
                {submitting ? (isZh ? '提交中...' : 'Submitting...') : '💴 ' + (isZh ? '申请提现' : 'Request withdrawal')}
              </button>
            </fieldset>

            {msg.text && <p className={`mt-3 text-sm ${msg.color}`}>{msg.text}</p>}

            <p className="mt-3 text-[11px] text-gray-400 leading-relaxed">
              {isZh ? '提交后工作人员将会在 1-3 个工作日内处理。' : 'Our team will process your request within 1-3 business days.'}
            </p>

            {/* 历史 —— 始终显示(空时给占位),避免用户以为「没有提现记录」 */}
            <div className="mt-5">
              <div className="text-sm font-medium dark:text-gray-200 mb-2">{isZh ? '提现记录' : 'History'}</div>
              {history.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-700 px-3 py-4 text-center text-xs text-gray-400">
                  {isZh ? '暂无提现记录' : 'No withdrawals yet'}
                </div>
              ) : (
                <>
                {/* 固定高度滚动区:记录再多也只占这一块、内部滚动,表单和「申请提现」始终可见 */}
                <div className="space-y-1.5 max-h-[260px] overflow-y-auto pr-1">
                  {history.map((h) => (
                    <div key={h.id} className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs">
                      <div className="dark:text-gray-200">
                        ¥{h.amount_cny} <span className="text-gray-400">· {h.qr_kind === 'wechat' ? (isZh ? '微信' : 'WeChat') : (isZh ? '支付宝' : 'Alipay')}</span>
                        <div className="text-[10px] text-gray-400">{new Date(h.created_at).toLocaleString()}</div>
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] ${h.status === 'paid' ? 'bg-green-500/10 text-green-500' : h.status === 'pending' ? 'bg-amber-500/10 text-amber-500' : 'bg-gray-500/10 text-gray-400'}`}>
                        {statusLabel(h.status)}
                      </span>
                    </div>
                  ))}
                </div>
                {history.length >= 10 && (
                  <div className="mt-1.5 text-center text-[10px] text-gray-400">{isZh ? '仅显示最近 10 条提现记录' : 'Showing the latest 10 records'}</div>
                )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
};
