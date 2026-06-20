/**
 * usedHotspotStore — 按【任务】持久化「已用过的热点 id」。
 *
 * 热搜成片一次跑 N 条时每条独立选题,且跨次运行也不该重复同一热点。选题前读出该任务
 * 用过的 id 传给后端 /hotspot/pick 排除;选中后立刻记一笔。存在 userData/used-hotspots.json:
 *   { [taskId]: string[] }
 * 每任务封顶 CAP 条(热榜每天滚动,旧 id 早已不在池里,封顶只为防文件无限增长)。
 * 所有读写都【不抛】—— 持久化失败只记内存/静默,绝不阻塞出片。
 */
// ⚠️ 不能用 electron 的 app.getPath:视频管线跑在 sidecar 进程(pkg node,无 electron app)→ app
//   undefined → 读写全静默失败 → 已用列表永远空 → 去重根本不生效(热搜成片跨次跑选到同一热点的真因)。
//   改用 platformAdapter.getUserDataPath():electron 模式走 app、sidecar 模式回退 OS 标准路径(同一目录)。
import { getUserDataPath } from '../platformAdapter';
import * as fs from 'fs';
import * as path from 'path';

const CAP = 500;

function storePath(): string {
  return path.join(getUserDataPath(), 'used-hotspots.json');
}

function readAll(): Record<string, string[]> {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const json = JSON.parse(raw);
    return json && typeof json === 'object' && !Array.isArray(json) ? json : {};
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, string[]>): void {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(data), 'utf8');
  } catch {
    /* 持久化失败不阻塞出片 */
  }
}

/** 读出该任务用过的热点 id 列表(用于选题排除)。无 taskId 返空。 */
export function getUsedHotspots(taskId: string): string[] {
  if (!taskId) return [];
  const list = readAll()[taskId];
  return Array.isArray(list) ? list : [];
}

/** 记一条该任务刚用过的热点 id(去重 + 封顶丢最旧)。无 taskId / id 静默跳过。 */
export function markHotspotUsed(taskId: string, id: string): void {
  if (!taskId || !id) return;
  const all = readAll();
  const list = Array.isArray(all[taskId]) ? all[taskId] : [];
  if (list.includes(id)) return;
  list.push(id);
  if (list.length > CAP) list.splice(0, list.length - CAP);
  all[taskId] = list;
  writeAll(all);
}
