/**
 * 矩阵任务调度计算 —— 镜像老客户端 scenarioManager.computeNextPlannedRun 的抖动规则,
 * 但独立一份(Option A:矩阵自成运行时,不依赖会变的旧 scenario 运行时)。
 */

import type { MatrixTaskFrequency } from './types';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
function rand(min: number, max: number): number { return min + Math.floor(Math.random() * (max - min + 1)); }

/** 下次计划运行时间(epoch ms);once 返回 MAX(永不自动触发)。 */
export function nextRunAt(freq: MatrixTaskFrequency, fromTs: number, isFirstRun: boolean): number {
  switch (freq) {
    case '30min': return fromTs + 30 * MIN + rand(1, 10) * MIN;
    case '1h': return fromTs + HOUR + rand(1, 10) * MIN;
    case '3h': return fromTs + 3 * HOUR + rand(1, 45) * MIN;
    case '6h': return fromTs + 6 * HOUR + rand(1, 45) * MIN;
    case 'daily_random': {
      const d = new Date(fromTs); d.setHours(0, 0, 0, 0);
      const dayStart = d.getTime() + (isFirstRun ? 0 : DAY);
      const t = dayStart + rand(9 * 60, 23 * 60) * MIN;   // 09:00-23:00 随机
      return t > fromTs ? t : t + DAY;
    }
    case 'once':
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

export const FREQUENCY_LABEL: Record<MatrixTaskFrequency, string> = {
  once: '不重复(手动触发)',
  '30min': '每30分钟(+1-10分钟随机)',
  '1h': '每小时(+1-10分钟随机)',
  '3h': '每3小时(+1-45分钟随机)',
  '6h': '每6小时(+1-45分钟随机)',
  daily_random: '每日随机一次(09:00-23:00)',
};

export const FREQUENCY_OPTIONS: MatrixTaskFrequency[] = ['once', '30min', '1h', '3h', '6h', 'daily_random'];
