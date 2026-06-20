---
name: desktop-control
description: Control your desktop like a human — take screenshots, move the mouse, click, type, and interact with any GUI application. Works on Windows and macOS.
name_zh: "桌面控制"
description_zh: "像人一样操控桌面 — 截屏、移动鼠标、点击、输入，操控任何GUI应用程序。支持 Windows 和 macOS。"
name_ja: "デスクトップ制御"
description_ja: "人間のようにデスクトップを操作 — スクリーンショット、マウス移動、クリック、入力。Windows/macOS対応。"
name_ko: "데스크톱 제어"
description_ko: "사람처럼 데스크톱을 제어 — 스크린샷, 마우스 이동, 클릭, 입력. Windows/macOS 지원."
official: true
version: 2.0.0
---

# Desktop Control Skill

## When to Use This Skill

Use this skill when you need to interact with GUI applications that don't have command-line interfaces:

- **GUI application control** — WeChat, DingTalk, Slack, any desktop app
- **Visual verification** — Take screenshots to see what's on screen
- **Mouse/keyboard automation** — Click buttons, type text, drag elements
- **Multi-app workflows** — Copy from one app, paste to another

## Workflow Pattern

1. Take a screenshot to see current screen state
2. Analyze the screenshot to understand what's visible and find coordinates
3. Determine the action needed (click, type, scroll)
4. Execute the action using system commands
5. Take another screenshot to verify the result
6. Repeat until task is complete

---

## SAFETY — Blocked System Key Combos

NEVER send these keyboard shortcuts — they can crash apps, lock the system, or disrupt the user:

**Windows:** Ctrl+Alt+Delete, Alt+F4, Alt+Tab, Win+L (lock), Win+D (show desktop)
**macOS:** Cmd+Q (quit), Cmd+Shift+Q (log out), Cmd+Option+Esc (force quit), Cmd+Tab (app switch), Cmd+Space (Spotlight), Ctrl+Cmd+Q (lock screen)

If a task requires quitting an app, use the app's File > Exit menu or close button via click instead.

---

## Taking Screenshots

**Windows** — ALWAYS wrap in single quotes to prevent bash variable expansion:
```bash
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Windows.Forms; $s = [System.Windows.Forms.Screen]::PrimaryScreen; $bmp = New-Object System.Drawing.Bitmap($s.Bounds.Width, $s.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($s.Bounds.Location, [System.Drawing.Point]::Empty, $s.Bounds.Size); $bmp.Save("screenshot.png"); $g.Dispose(); $bmp.Dispose(); Write-Host "Saved screenshot.png"'
```

**macOS:**
```bash
screencapture -x screenshot.png
```

### Screenshot — Zoom (crop a region for closer inspection)

When a screenshot is too small to read text or find precise coordinates, crop a specific region:

**Windows:**
```bash
powershell -NoProfile -NonInteractive -Command '$x0=200; $y0=100; $x1=600; $y1=400; Add-Type -AssemblyName System.Drawing; $src = [System.Drawing.Image]::FromFile("screenshot.png"); $w=$x1-$x0; $h=$y1-$y0; $bmp = New-Object System.Drawing.Bitmap($w, $h); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.DrawImage($src, 0, 0, (New-Object System.Drawing.Rectangle($x0, $y0, $w, $h)), [System.Drawing.GraphicsUnit]::Pixel); $bmp.Save("zoomed.png"); $g.Dispose(); $bmp.Dispose(); $src.Dispose(); Write-Host "Cropped ($x0,$y0)-($x1,$y1) to zoomed.png"'
```

**macOS:**
```bash
screencapture -x -R 200,100,400,300 zoomed.png
```

---

## Mouse Control — Click

**Windows — atomic move+click (DPI-aware, uses SendInput):**

ALWAYS wrap the entire PowerShell command in single quotes when calling from bash.
```bash
powershell -NoProfile -NonInteractive -Command '$x = 500; $y = 300; Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class NM { [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; } [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; } [DllImport(\"user32.dll\")] public static extern uint SendInput(uint n, INPUT[] inp, int size); [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int n); }" -ErrorAction SilentlyContinue; [NM]::SetProcessDPIAware(); $sw = [NM]::GetSystemMetrics(0); $sh = [NM]::GetSystemMetrics(1); $nx = [int](($x * 65535) / $sw); $ny = [int](($y * 65535) / $sh); $move = New-Object NM+INPUT; $move.type = 0; $move.mi.dx = $nx; $move.mi.dy = $ny; $move.mi.dwFlags = 0x8001; $down = New-Object NM+INPUT; $down.type = 0; $down.mi.dwFlags = 0x0002; $up = New-Object NM+INPUT; $up.type = 0; $up.mi.dwFlags = 0x0004; [NM]::SendInput(1, @($move), [System.Runtime.InteropServices.Marshal]::SizeOf($move)); Start-Sleep -Milliseconds 50; [NM]::SendInput(2, @($down, $up), [System.Runtime.InteropServices.Marshal]::SizeOf($down)); Write-Host "Clicked ($x, $y)"'
```

**Key rules:**
- Replace `$x = 500; $y = 300` with target coordinates from screenshot analysis
- `SetProcessDPIAware()` + `65535` normalization handles all DPI scaling (100%–200%)
- `Add-Type -ErrorAction SilentlyContinue` prevents failure if type already defined in session
- Move and click are sent in one atomic sequence

**macOS:**
```bash
osascript -e 'tell application "System Events" to click at {500, 300}'
```

---

## Mouse Control — Double Click

**Windows:**
```bash
powershell -NoProfile -NonInteractive -Command '$x = 500; $y = 300; Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class NM2 { [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; } [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; } [DllImport(\"user32.dll\")] public static extern uint SendInput(uint n, INPUT[] inp, int size); [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int n); }" -ErrorAction SilentlyContinue; [NM2]::SetProcessDPIAware(); $sw = [NM2]::GetSystemMetrics(0); $sh = [NM2]::GetSystemMetrics(1); $nx = [int](($x * 65535) / $sw); $ny = [int](($y * 65535) / $sh); $move = New-Object NM2+INPUT; $move.type = 0; $move.mi.dx = $nx; $move.mi.dy = $ny; $move.mi.dwFlags = 0x8001; $down = New-Object NM2+INPUT; $down.type = 0; $down.mi.dwFlags = 0x0002; $up = New-Object NM2+INPUT; $up.type = 0; $up.mi.dwFlags = 0x0004; [NM2]::SendInput(1, @($move), [System.Runtime.InteropServices.Marshal]::SizeOf($move)); Start-Sleep -Milliseconds 50; [NM2]::SendInput(2, @($down, $up), [System.Runtime.InteropServices.Marshal]::SizeOf($down)); Start-Sleep -Milliseconds 80; [NM2]::SendInput(2, @($down, $up), [System.Runtime.InteropServices.Marshal]::SizeOf($down)); Write-Host "Double-clicked ($x, $y)"'
```

**macOS:**
```bash
osascript -e 'tell application "System Events" to double click at {500, 300}'
```

---

## Mouse Control — Right Click

**Windows:**
```bash
powershell -NoProfile -NonInteractive -Command '$x = 500; $y = 300; Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class NMR { [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; } [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; } [DllImport(\"user32.dll\")] public static extern uint SendInput(uint n, INPUT[] inp, int size); [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int n); }" -ErrorAction SilentlyContinue; [NMR]::SetProcessDPIAware(); $sw = [NMR]::GetSystemMetrics(0); $sh = [NMR]::GetSystemMetrics(1); $nx = [int](($x * 65535) / $sw); $ny = [int](($y * 65535) / $sh); $move = New-Object NMR+INPUT; $move.type = 0; $move.mi.dx = $nx; $move.mi.dy = $ny; $move.mi.dwFlags = 0x8001; $rdown = New-Object NMR+INPUT; $rdown.type = 0; $rdown.mi.dwFlags = 0x0008; $rup = New-Object NMR+INPUT; $rup.type = 0; $rup.mi.dwFlags = 0x0010; [NMR]::SendInput(1, @($move), [System.Runtime.InteropServices.Marshal]::SizeOf($move)); Start-Sleep -Milliseconds 50; [NMR]::SendInput(2, @($rdown, $rup), [System.Runtime.InteropServices.Marshal]::SizeOf($rdown)); Write-Host "Right-clicked ($x, $y)"'
```

**macOS:**
```bash
osascript -e 'tell application "System Events" to secondary click at {500, 300}'
```

---

## Mouse Control — Middle Click

**Windows:**
```bash
powershell -NoProfile -NonInteractive -Command '$x = 500; $y = 300; Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class NMM { [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; } [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; } [DllImport(\"user32.dll\")] public static extern uint SendInput(uint n, INPUT[] inp, int size); [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int n); }" -ErrorAction SilentlyContinue; [NMM]::SetProcessDPIAware(); $sw = [NMM]::GetSystemMetrics(0); $sh = [NMM]::GetSystemMetrics(1); $nx = [int](($x * 65535) / $sw); $ny = [int](($y * 65535) / $sh); $move = New-Object NMM+INPUT; $move.type = 0; $move.mi.dx = $nx; $move.mi.dy = $ny; $move.mi.dwFlags = 0x8001; $mdown = New-Object NMM+INPUT; $mdown.type = 0; $mdown.mi.dwFlags = 0x0020; $mup = New-Object NMM+INPUT; $mup.type = 0; $mup.mi.dwFlags = 0x0040; [NMM]::SendInput(1, @($move), [System.Runtime.InteropServices.Marshal]::SizeOf($move)); Start-Sleep -Milliseconds 50; [NMM]::SendInput(2, @($mdown, $mup), [System.Runtime.InteropServices.Marshal]::SizeOf($mdown)); Write-Host "Middle-clicked ($x, $y)"'
```

**macOS:**
```bash
osascript -e 'tell application "System Events" to click at {500, 300} using {option down}'
```

---

## Mouse Control — Scroll

**Windows:**
```bash
powershell -NoProfile -NonInteractive -Command '$x = 500; $y = 300; $delta = 3; Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class NMS { [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; } [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; } [DllImport(\"user32.dll\")] public static extern uint SendInput(uint n, INPUT[] inp, int size); [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int n); }" -ErrorAction SilentlyContinue; [NMS]::SetProcessDPIAware(); $sw = [NMS]::GetSystemMetrics(0); $sh = [NMS]::GetSystemMetrics(1); $nx = [int](($x * 65535) / $sw); $ny = [int](($y * 65535) / $sh); $move = New-Object NMS+INPUT; $move.type = 0; $move.mi.dx = $nx; $move.mi.dy = $ny; $move.mi.dwFlags = 0x8001; [NMS]::SendInput(1, @($move), [System.Runtime.InteropServices.Marshal]::SizeOf($move)); Start-Sleep -Milliseconds 50; $scroll = New-Object NMS+INPUT; $scroll.type = 0; $scroll.mi.mouseData = [uint32]($delta * 120); $scroll.mi.dwFlags = 0x0800; [NMS]::SendInput(1, @($scroll), [System.Runtime.InteropServices.Marshal]::SizeOf($scroll)); Write-Host "Scrolled up $delta"'
```

For scroll **down**, use negative delta: `$delta = -3`

**macOS — scroll via keyboard (most reliable):**
```bash
osascript -e 'tell application "System Events" to repeat 5 times' -e 'key code 125' -e 'end repeat'
```
```bash
# Page Down / Page Up
osascript -e 'tell application "System Events" to key code 121'
osascript -e 'tell application "System Events" to key code 116'
```

---

## Mouse Control — Move (hover without clicking)

**Windows:**
```bash
powershell -NoProfile -NonInteractive -Command '$x = 500; $y = 300; Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class NMV { [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; } [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; } [DllImport(\"user32.dll\")] public static extern uint SendInput(uint n, INPUT[] inp, int size); [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int n); }" -ErrorAction SilentlyContinue; [NMV]::SetProcessDPIAware(); $sw = [NMV]::GetSystemMetrics(0); $sh = [NMV]::GetSystemMetrics(1); $nx = [int](($x * 65535) / $sw); $ny = [int](($y * 65535) / $sh); $move = New-Object NMV+INPUT; $move.type = 0; $move.mi.dx = $nx; $move.mi.dy = $ny; $move.mi.dwFlags = 0x8001; [NMV]::SendInput(1, @($move), [System.Runtime.InteropServices.Marshal]::SizeOf($move)); Write-Host "Moved to ($x, $y)"'
```

**macOS:**
```bash
osascript -e 'tell application "System Events" to move mouse to {500, 300}'
```

---

## Mouse Control — Drag (click and drag from A to B)

**Windows:**
```bash
powershell -NoProfile -NonInteractive -Command '$x1=200; $y1=300; $x2=600; $y2=300; Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class NMD { [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; } [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; } [DllImport(\"user32.dll\")] public static extern uint SendInput(uint n, INPUT[] inp, int size); [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int n); }" -ErrorAction SilentlyContinue; [NMD]::SetProcessDPIAware(); $sw = [NMD]::GetSystemMetrics(0); $sh = [NMD]::GetSystemMetrics(1); function toAbs($x,$y) { return @([int](($x*65535)/$sw), [int](($y*65535)/$sh)) }; $s = toAbs $x1 $y1; $e = toAbs $x2 $y2; $m1 = New-Object NMD+INPUT; $m1.type=0; $m1.mi.dx=$s[0]; $m1.mi.dy=$s[1]; $m1.mi.dwFlags=0x8001; $down = New-Object NMD+INPUT; $down.type=0; $down.mi.dwFlags=0x0002; [NMD]::SendInput(1, @($m1), [System.Runtime.InteropServices.Marshal]::SizeOf($m1)); Start-Sleep -Milliseconds 50; [NMD]::SendInput(1, @($down), [System.Runtime.InteropServices.Marshal]::SizeOf($down)); Start-Sleep -Milliseconds 50; $steps=5; for($i=1;$i-le$steps;$i++){$cx=[int]($s[0]+($e[0]-$s[0])*$i/$steps);$cy=[int]($s[1]+($e[1]-$s[1])*$i/$steps);$mv=New-Object NMD+INPUT;$mv.type=0;$mv.mi.dx=$cx;$mv.mi.dy=$cy;$mv.mi.dwFlags=0x8001;[NMD]::SendInput(1,@($mv),[System.Runtime.InteropServices.Marshal]::SizeOf($mv));Start-Sleep -Milliseconds 20}; $up=New-Object NMD+INPUT;$up.type=0;$up.mi.dwFlags=0x0004; [NMD]::SendInput(1,@($up),[System.Runtime.InteropServices.Marshal]::SizeOf($up)); Write-Host "Dragged ($x1,$y1) to ($x2,$y2)"'
```

**macOS:**
```bash
osascript -e 'tell application "System Events" to click at {200, 300}' -e 'delay 0.1' -e 'tell application "System Events" to drag from {200, 300} to {600, 300}'
```

---

## Mouse Control — Get Cursor Position

**Windows:**
```bash
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Windows.Forms; $p = [System.Windows.Forms.Cursor]::Position; Write-Host "Cursor at ($($p.X), $($p.Y))"'
```

**macOS:**
```bash
osascript -e 'tell application "System Events" to get position of mouse'
```

---

## Clipboard — Read and Write

**Windows — Read clipboard:**
```bash
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Windows.Forms; $text = [System.Windows.Forms.Clipboard]::GetText(); Write-Host $text'
```

**Windows — Write to clipboard:**
```bash
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText("Hello World"); Write-Host "Copied to clipboard"'
```

**macOS — Read clipboard:**
```bash
pbpaste
```

**macOS — Write to clipboard:**
```bash
echo "Hello World" | pbcopy
```

---

## Keyboard Input

**Windows** — ALWAYS wrap in single quotes:
```bash
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("Hello World")'
```

```bash
# Press Enter
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")'
```

```bash
# Ctrl+C (copy) / Ctrl+V (paste) / Ctrl+A (select all)
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^c")'
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^v")'
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^a")'
```

### Hold Key (press and hold for a duration)

**Windows:**
```bash
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("{DOWN 10}"); Write-Host "Held Down arrow 10 times"'
```

**macOS:**
```bash
osascript -e 'tell application "System Events" to key code 125' -e 'delay 0.05' -e 'tell application "System Events" to key code 125'
```

**macOS:**
```bash
osascript -e 'tell application "System Events" to keystroke "Hello World"'
osascript -e 'tell application "System Events" to key code 36'  # Enter
osascript -e 'tell application "System Events" to keystroke "c" using command down'  # Cmd+C
```

---

## Finding and Launching Apps

**Windows — list running apps with windows:**
```bash
powershell -NoProfile -NonInteractive -Command 'Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object ProcessName, MainWindowTitle | Format-Table -AutoSize'
```

**Windows — search Start Menu for an app and launch it:**
```bash
powershell -NoProfile -NonInteractive -Command '$apps = Get-StartApps | Where-Object { $_.Name -like "*WeChat*" }; if ($apps) { Start-Process $apps[0].AppId; Write-Host "Launched: $($apps[0].Name)" } else { Write-Host "App not found" }'
```

**Windows — launch app by executable name:**
```bash
powershell -NoProfile -NonInteractive -Command 'Start-Process "WeChat.exe"'
```

**macOS:**
```bash
# List running apps
osascript -e 'tell application "System Events" to get name of every process whose visible is true'

# Launch app
open -a "WeChat"
```

---

## Window Management

**Windows — activate (bring to front) a window:**
```bash
powershell -NoProfile -NonInteractive -Command 'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate("WeChat")'
```

**Windows — maximize a window:**
```bash
powershell -NoProfile -NonInteractive -Command 'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class WM { [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern IntPtr FindWindow(string c, string t); }" -ErrorAction SilentlyContinue; $hwnd = [WM]::FindWindow($null, "WeChat"); [WM]::ShowWindow($hwnd, 3); Write-Host "Maximized"'
```

**Windows — minimize a window:**
```bash
powershell -NoProfile -NonInteractive -Command 'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class WM2 { [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern IntPtr FindWindow(string c, string t); }" -ErrorAction SilentlyContinue; $hwnd = [WM2]::FindWindow($null, "WeChat"); [WM2]::ShowWindow($hwnd, 6); Write-Host "Minimized"'
```

**macOS:**
```bash
osascript -e 'tell application "WeChat" to activate'
```

---

## Wait / Delay

When you need to wait for an app to load or a dialog to appear:

**Windows:**
```bash
powershell -NoProfile -NonInteractive -Command 'Start-Sleep -Seconds 2; Write-Host "Done waiting"'
```

**macOS:**
```bash
sleep 2
```

---

## Limitations

- Cannot bypass system security dialogs (UAC, password prompts)
- Screenshot analysis depends on AI vision capability
- Mouse coordinates must be calculated from screenshot analysis
- Some applications may block automated input
- SendKeys may not work in some UWP/Store apps — use SendInput mouse clicks instead
- NEVER send blocked system key combos (see SAFETY section above)
