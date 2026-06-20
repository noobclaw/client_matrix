---
name: system-monitor
description: Monitor system resources — CPU, memory, disk, network, processes. Find resource-hungry apps, clean temp files, and manage startup programs.
name_zh: "系统监控"
description_zh: "监控系统资源 — CPU、内存、磁盘、网络、进程。查找占资源的应用、清理临时文件、管理开机启动。"
name_ja: "システムモニター"
description_ja: "システムリソース監視 — CPU、メモリ、ディスク、ネットワーク、プロセス。リソース消費アプリの検出、一時ファイル清掃。"
name_ko: "시스템 모니터"
description_ko: "시스템 리소스 모니터링 — CPU, 메모리, 디스크, 네트워크, 프로세스. 자원 소모 앱 찾기, 임시 파일 정리."
official: true
version: 1.0.0
---

# System Monitor Skill

## When to Use This Skill

Use this skill when the user wants to:
- Check system performance (CPU, memory, disk usage)
- Find which processes are consuming the most resources
- Check disk space and clean up
- View network connections and bandwidth
- Manage startup programs
- Get system hardware information

## System Information

### Windows
```powershell
# System overview
systeminfo | Select-String "OS Name|Total Physical Memory|System Type|Processor"

# CPU info
wmic cpu get Name, NumberOfCores, MaxClockSpeed

# Memory info
wmic memorychip get Capacity, Speed, Manufacturer
```

### macOS
```bash
# System overview
system_profiler SPHardwareDataType | grep -E "Model|Processor|Memory|Chip"

# macOS version
sw_vers
```

## Resource Monitoring

### CPU Usage
```powershell
# Windows — Current CPU usage
wmic cpu get LoadPercentage

# Windows — Top CPU processes
Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name, CPU, WorkingSet64
```

```bash
# macOS/Linux — Top processes
top -l 1 | head -20        # macOS
top -bn1 | head -20        # Linux
```

### Memory Usage
```powershell
# Windows
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 Name, @{N='Memory(MB)';E={[math]::Round($_.WorkingSet64/1MB,1)}}

# Total memory usage
$os = Get-CimInstance Win32_OperatingSystem
"Used: {0:N0} MB / Total: {1:N0} MB ({2:N1}%)" -f (($os.TotalVisibleMemorySize - $os.FreePhysicalMemory)/1KB), ($os.TotalVisibleMemorySize/1KB), ((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100)
```

```bash
# macOS
vm_stat | head -10
memory_pressure

# Linux
free -h
```

### Disk Usage
```powershell
# Windows — Drive info
Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N='Used(GB)';E={[math]::Round($_.Used/1GB,1)}}, @{N='Free(GB)';E={[math]::Round($_.Free/1GB,1)}}, @{N='Total(GB)';E={[math]::Round(($_.Used+$_.Free)/1GB,1)}}
```

```bash
# macOS/Linux
df -h
```

### Network
```powershell
# Windows — Active connections
netstat -ano | Select-String "ESTABLISHED" | Select-Object -First 20

# Windows — Bandwidth per process
Get-NetTCPConnection | Select-Object OwningProcess, RemoteAddress, RemotePort, State | Sort-Object OwningProcess
```

```bash
# macOS
netstat -an | grep ESTABLISHED | head -20
lsof -i -P | head -30
```

## Cleanup

### Windows
```powershell
# Temp files size
(Get-ChildItem $env:TEMP -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB | ForEach-Object { "{0:N0} MB in temp" -f $_ }

# Clean temp files (show what would be deleted first)
Get-ChildItem $env:TEMP -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) }

# Windows Update cleanup
# Dism.exe /online /Cleanup-Image /StartComponentCleanup
```

### macOS
```bash
# Check temp/cache sizes
du -sh ~/Library/Caches/ 2>/dev/null
du -sh /tmp/ 2>/dev/null

# Homebrew cleanup
brew cleanup --dry-run
```

## Startup Programs

### Windows
```powershell
# List startup programs
Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location

# Or via registry
Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run
Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Run
```

### macOS
```bash
# List login items
osascript -e 'tell application "System Events" to get name of every login item'

# List launch agents
ls ~/Library/LaunchAgents/
ls /Library/LaunchAgents/
```

## Important Notes

- Never kill system-critical processes
- Always show what will be deleted before cleanup
- Ask for confirmation before any destructive operation
- Some operations require administrator privileges
