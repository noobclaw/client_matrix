/**
 * 系统级「防休眠」—— 对齐旧客户端 chrome-extension 的 chrome.power.requestKeepAwake('system')
 * 与 scenarioManager 的 powerSaveBlocker('prevent-app-suspension')。
 *
 * 为什么不复用那两份:矩阵指纹内核是独立 fingerprint-chromium 进程、纯 CDP 控,既不走
 * chrome-extension(用不到 chrome.power),Electron 的 powerSaveBlocker 在 Tauri 出货里也基本是死的。
 * 所以照搬【语义】换实现:只防【系统空闲休眠】、不防屏幕变暗(省电,跟 'system' 一致)。
 *
 * 实现:跨平台靠一个【长驻子进程】持有保活断言(断言随持有它的线程/进程退出而自动解除,
 * 故必须长驻,不能一次性调用)。kernelPool 在【有内核存活】时 acquire、【全部关闭】后 release。
 *   · Windows:powershell P/Invoke SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED);
 *   · macOS:caffeinate -i(防空闲休眠、屏幕可灭) -w <pid>(本进程退出即自动解除,防孤儿);
 *   · Linux:不处理(矩阵目标平台 win/mac)。
 *
 * 边界(跟旧客户端注释一致,这些挡不住):用户显式点「睡眠」、合盖、电量极低 —— 都是硬件/用户驱动。
 */

import { spawn, type ChildProcess } from 'child_process';
import { coworkLog } from '../coworkLogger';

let holder: ChildProcess | null = null;
let active = false;

/** 开启系统保活(幂等:已开则直接返回)。 */
export function acquireSystemKeepAwake(): void {
  if (active) return;
  active = true;
  try {
    if (process.platform === 'darwin') {
      // -i 防系统空闲休眠(不防屏幕灭);-w 本 sidecar 进程退出即自动解除(双保险防孤儿)。
      holder = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', windowsHide: true });
    } else if (process.platform === 'win32') {
      // ES_CONTINUOUS(0x80000000)|ES_SYSTEM_REQUIRED(0x00000001)=防系统休眠、屏幕可灭。
      // assertion 随设置它的线程退出而解除 → ps 必须长驻:设置后无限循环(顺带每 30s 复设兜底),
      // 被 kill 时 finally 用单独 ES_CONTINUOUS 复位(即便被强杀,线程死亡也会自动解除)。
      const ps = [
        "$sig='[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);';",
        '$t=Add-Type -MemberDefinition $sig -Name Power -Namespace Win32 -PassThru;',
        'try { $t::SetThreadExecutionState(0x80000001) | Out-Null;',
        'while($true){ Start-Sleep -Seconds 30; $t::SetThreadExecutionState(0x80000001) | Out-Null } }',
        'finally { $t::SetThreadExecutionState(0x80000000) | Out-Null }',
      ].join(' ');
      holder = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true });
    } else {
      active = false; // linux 等:不处理
      return;
    }
    holder?.on('error', (e) => coworkLog('WARN', 'powerKeepAwake', 'holder error: ' + (e?.message || e)));
    holder?.on('exit', () => { holder = null; });
    coworkLog('INFO', 'powerKeepAwake', `系统防休眠 ON (${process.platform})`);
  } catch (e: any) {
    active = false;
    coworkLog('WARN', 'powerKeepAwake', 'acquire failed: ' + String(e?.message || e));
  }
}

/** 释放系统保活(幂等:未开则直接返回)。 */
export function releaseSystemKeepAwake(): void {
  if (!active) return;
  active = false;
  try { holder?.kill(); } catch { /* ignore */ }
  holder = null;
  coworkLog('INFO', 'powerKeepAwake', '系统防休眠 OFF');
}
