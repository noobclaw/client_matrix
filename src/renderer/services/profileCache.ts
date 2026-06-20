// profileCache — 用户 profile (含 partner / referrer / balance) 的 localStorage
// 缓存。三个 view 都依赖它做"先用缓存秒开,后台 fetch 静默覆盖"的体验:
//   - InviteView           (邀请返佣页)
//   - CoworkView           (新建对话欢迎页 + 合伙人主题 cascade)
//   - WalletView           (我的充值页 + 合伙人徽章 + 套餐色系)
//
// 缓存键按钱包小写,所以用户切换钱包(本客户端少见但可能发生)不会拿到旧账号的
// referrer/partner 数据。
//
// TTL 24h — referrer 很少变;balance / partner 之类 mild drift 可接受,因为
// 每次都会在后台 re-fetch 覆盖 cache,只是首屏看到的是上一次的快照。

export const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function key(wallet: string): string {
  return `noobclaw_profile_cache:${wallet.toLowerCase()}`;
}

/**
 * Read a cached profile for the given wallet. Returns null if:
 *   - no wallet provided
 *   - no cached entry
 *   - entry exists but is stale (older than PROFILE_CACHE_TTL_MS)
 *   - JSON parse failure (corrupted entry)
 *
 * Safe to call before authentication completes (returns null and degrades
 * gracefully — caller falls back to network fetch).
 */
export function readCachedProfile(wallet: string | null | undefined): any | null {
  if (!wallet) return null;
  try {
    const raw = localStorage.getItem(key(wallet));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj?.data || !obj?.ts) return null;
    if (Date.now() - obj.ts > PROFILE_CACHE_TTL_MS) return null;
    return obj.data;
  } catch { return null; }
}

/**
 * Persist a fresh profile snapshot to localStorage. No-op when:
 *   - wallet missing
 *   - data missing (don't cache empty results from failed fetches)
 *   - localStorage quota exceeded / disabled (degrade silently)
 */
export function writeCachedProfile(wallet: string | null | undefined, data: any): void {
  if (!wallet || !data) return;
  try {
    localStorage.setItem(key(wallet), JSON.stringify({ data, ts: Date.now() }));
  } catch { /* quota exceeded / disabled — degrade silently */ }
}
