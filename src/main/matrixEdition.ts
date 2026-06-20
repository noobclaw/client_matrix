/**
 * 矩阵 edition 开关(主进程/sidecar 侧)。
 *
 * 与渲染层 src/renderer/matrixEdition.ts 镜像(sidecar 与 renderer 是分开打包的,
 * 不能跨目录 import,所以各放一份)。本仓恒为 true。
 *
 * 作用:
 *   · sidecar 数据目录用 NoobClawMatrix(与旧 client 的 NoobClaw 彻底分开,
 *     否则 scenario 任务库/会话等会共享同一文件夹 → 矩阵 app 误读旧任务)。
 *   · sidecar 不启动旧的 scenario 定时调度 / AI 定时调度(只跑矩阵任务)。
 */
export const MATRIX_EDITION = true;
