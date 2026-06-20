/**
 * publishers/registry — 9 个平台 driver 的统一注册表。
 *
 * pipeline 出片完成后,从 task.input.publishPlatforms 拿到要发布的 id 列表,
 * 用 getDriver(id) 拿到 driver,iterator forEach 上传。任何单平台失败 → 日志推一条,
 * 继续下一个,不杀任务(用户硬约束)。
 *
 * 每个 driver 一个 lazy require(避免启动时把 9 个平台的依赖全 import,
 * 用户没用某平台时连初始化代价都没)。
 */

import type { PublisherDriver, VideoPlatform } from './types';

/** Lazy 解析器:首次取该平台时才 require,以后缓存。 */
type DriverFactory = () => PublisherDriver;

const REGISTRY: Record<VideoPlatform, DriverFactory> = {
  binance:   () => require('./binance').binanceDriver,
  x:         () => require('./twitter').twitterDriver,
  douyin:    () => require('./douyin').douyinDriver,
  xhs:       () => require('./xhs').xhsDriver,
  tiktok:    () => require('./tiktok').tiktokDriver,
  bilibili:  () => require('./bilibili').bilibiliDriver,
  kuaishou:  () => require('./kuaishou').kuaishouDriver,
  shipinhao: () => require('./shipinhao').shipinhaoDriver,
  toutiao:   () => require('./toutiao').toutiaoDriver,
};

const cache = new Map<VideoPlatform, PublisherDriver>();

/**
 * 拿一个平台的 driver。lazy 解析 + 缓存;driver 文件未实现时 require 抛 MODULE_NOT_FOUND,
 * 这里 catch 返回 null,上层走【该平台跳过】路径(跟未登录同义)。
 */
export function getDriver(platform: VideoPlatform): PublisherDriver | null {
  if (cache.has(platform)) return cache.get(platform)!;
  try {
    const drv = REGISTRY[platform]();
    if (drv && typeof drv.upload === 'function' && typeof drv.checkLogin === 'function') {
      cache.set(platform, drv);
      return drv;
    }
    return null;
  } catch {
    // driver 文件还没实现 / 路径错 → 当未支持处理
    return null;
  }
}

/** 给 UI / 调试用:列出所有【已实装】(driver 文件存在)的平台 id。 */
export function listImplementedPlatforms(): VideoPlatform[] {
  const out: VideoPlatform[] = [];
  for (const id of Object.keys(REGISTRY) as VideoPlatform[]) {
    if (getDriver(id)) out.push(id);
  }
  return out;
}
