/**
 * 矩阵 edition 开关。
 *
 * client_matrix 是「矩阵专属」构建:
 *   · 启动默认进「矩阵号」;
 *   · 侧栏只留矩阵相关 + 我的充值 + 设置,隐藏涨粉/AI对话/币安/全网热搜/人格测试等旧入口;
 *   · 不自动运行旧调度(AI 定时任务 / 热搜成片定时 / scenario 定时),避免与矩阵任务冲突。
 *
 * 矩阵自己的数据(账号池等)本就在独立目录(~/NoobClaw/matrix/),与旧 client 的库互不干扰;
 * 加上独立的 tauri identifier(com.noobclaw.matrix),数据目录也彻底分开。
 *
 * 本仓恒为 true。
 */
export const MATRIX_EDITION = true;
