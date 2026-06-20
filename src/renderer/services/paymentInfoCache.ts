// paymentInfoCache — localStorage 缓存 /api/payment/info 响应。WalletView 我的充值
// 页打开时套餐卡能秒出,不再等一次完整 HTTPS 往返(即使后端那边有 5 分钟内存缓存,
// 客户端这边仍要 ~200-800ms 网络延迟才能拿到)。
//
// 背景:profile 已经走 services/profileCache 做"先缓存秒开,后台 fetch 静默覆盖"
// 的体验。/api/payment/info 是 WalletView 第二个高延迟感知点,在此对齐方案。
//
// 跟 profileCache 的区别:
//   - paymentInfo 是全局数据(不按钱包分桶),所以 cache key 只有一个固定字符串
//   - TTL 跟后端一致 5 分钟。bnbPriceUsd 跟着 5 分钟周期刷,过期了就重新拉
//   - 不存敏感数据 (没钱包私钥、没用户身份),纯产品配置 + 价格

import type { PaymentInfo, RedeemPackagesResponse } from './noobclawApi';

const KEY = 'noobclaw_payment_info_cache';
const REDEEM_KEY = 'noobclaw_redeem_packages_cache';
export const PAYMENT_INFO_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Read the cached PaymentInfo. Returns null when:
 *   - no cached entry yet
 *   - entry is older than PAYMENT_INFO_CACHE_TTL_MS (5 min — matches backend cache)
 *   - JSON parse failure (corrupted entry)
 *
 * Safe to call before auth — payment info isn't gated.
 */
export function readCachedPaymentInfo(): PaymentInfo | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj?.data || !obj?.ts) return null;
    if (Date.now() - obj.ts > PAYMENT_INFO_CACHE_TTL_MS) return null;
    return obj.data as PaymentInfo;
  } catch { return null; }
}

/**
 * Persist a fresh PaymentInfo snapshot to localStorage. No-op when data is
 * missing (don't cache a failed fetch). Silent on quota errors.
 */
export function writeCachedPaymentInfo(data: PaymentInfo | null): void {
  if (!data) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ data, ts: Date.now() }));
  } catch { /* quota / disabled — degrade silently */ }
}

// ── CNY 卡密档位缓存(同 5 分钟 TTL)──────────────────────────────
// /api/redeem/packages 是「我的充值」的第三个高延迟感知点(USDT/BNB 已秒开,卡密
// 却要等一次往返)。同样做"先缓存秒出、后台 fetch 静默覆盖",卡密 tab 启动即就绪。

/** 读缓存的卡密档位;无 / 过期(>5min)/ 损坏 → null。 */
export function readCachedRedeemInfo(): RedeemPackagesResponse | null {
  try {
    const raw = localStorage.getItem(REDEEM_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj?.data || !obj?.ts) return null;
    if (Date.now() - obj.ts > PAYMENT_INFO_CACHE_TTL_MS) return null;
    return obj.data as RedeemPackagesResponse;
  } catch { return null; }
}

/** 持久化卡密档位快照。空 / packages 为空不缓存(别缓存"未配置"态)。 */
export function writeCachedRedeemInfo(data: RedeemPackagesResponse | null): void {
  if (!data || !data.packages || data.packages.length === 0) return;
  try {
    localStorage.setItem(REDEEM_KEY, JSON.stringify({ data, ts: Date.now() }));
  } catch { /* quota / disabled — degrade silently */ }
}
