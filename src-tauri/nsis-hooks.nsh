; NSIS installer hooks for NoobClaw
;
; Background:
;   Chrome / Edge / Firefox 通过 Native Messaging Host (NMH) 协议拉起
;   noobclaw-server.exe 与浏览器扩展通信。NMH 跑着的时候 Windows 镜像
;   加载器对 noobclaw-server.exe 持锁,安装器覆盖时报
;   "Error opening file for writing"。
;
; 策略(竞态安全版):
;   1. taskkill 自家 sidecar(杀软不扣分)。
;   2. 直接 Delete 目标 exe —— 删成功证明无人持有镜像锁,而且文件直接
;      从磁盘消失,浏览器扩展之后 spawn NMH 会 CreateProcess
;      "file not found" 失败,不会在 NSIS 释放新版前重新加锁。
;   3. Delete 失败说明浏览器又把 NMH 拉起来了 → 弹自定义提示让用户
;      关浏览器后重试。
;
; 之前用 FileOpen 'a' 探测有竞态:探测时未锁 → hook 返回 → NSIS 开始
; 解压 → 浏览器心跳重生 NMH → 文件被重新加锁 → NSIS 报默认错。
; Delete 把窗口收紧到"删完到 NSIS 写新文件"之间,且期间路径不存在,
; 浏览器无法 spawn。
;
; ⚠️ 不再静默 taskkill chrome.exe / msedge.exe / firefox.exe。
; 安装器灭用户浏览器是 360/腾讯/火绒启发式里的高权重恶意特征。

!define NC_SIDECAR_NAME "noobclaw-server.exe"

!macro NC_KILL_SIDECAR
  nsExec::Exec 'taskkill /F /IM ${NC_SIDECAR_NAME} /T'
  Pop $0
  Sleep 500
!macroend

; 通用守卫:杀 sidecar -> 删 sidecar exe -> 删不掉就让用户关浏览器重试。
;
; TAG 给本宏内部的标签做命名空间,避免 PREINSTALL/PREUNINSTALL 都展开
; 到同一个 .nsi 时裸标签冲突。
!macro NC_GUARD TAG OPERATION
  Push $0

  !insertmacro NC_KILL_SIDECAR

  nc_guard_try_${TAG}:
    ; 文件已经不在 = 删过了或者全新装,直接放行
    IfFileExists "$INSTDIR\${NC_SIDECAR_NAME}" 0 nc_guard_done_${TAG}

    ClearErrors
    Delete "$INSTDIR\${NC_SIDECAR_NAME}"
    IfFileExists "$INSTDIR\${NC_SIDECAR_NAME}" 0 nc_guard_done_${TAG}

    ; Delete 后文件还在 → NMH 持镜像锁,删不掉
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "NoobClaw is in use by a browser.$\r$\n$\r$\nQuit Chrome / Edge / Firefox completely, then click Retry — or Cancel to abort the ${OPERATION}." \
      /SD IDCANCEL \
      IDRETRY nc_guard_retry_${TAG}
    Pop $0
    Abort "User canceled ${OPERATION}"

  nc_guard_retry_${TAG}:
    !insertmacro NC_KILL_SIDECAR
    Goto nc_guard_try_${TAG}

  nc_guard_done_${TAG}:
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro NC_GUARD INSTALL "install"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro NC_GUARD UNINSTALL "uninstall"
!macroend
