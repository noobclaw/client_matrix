---
name: clipboard-manager
description: Read and write system clipboard content. Copy text, images, and files between applications. Monitor clipboard changes.
name_zh: "剪贴板管理"
description_zh: "读写系统剪贴板内容。在应用之间复制文本、图片和文件。监控剪贴板变化。"
name_ja: "クリップボード管理"
description_ja: "システムクリップボードの読み書き。アプリ間でテキスト、画像、ファイルをコピー。"
name_ko: "클립보드 관리"
description_ko: "시스템 클립보드 내용 읽기/쓰기. 앱 간 텍스트, 이미지, 파일 복사."
official: true
version: 1.0.0
---

# Clipboard Manager Skill

## When to Use This Skill

Use this skill when you need to:
- Read current clipboard content
- Copy text or data to clipboard
- Transfer content between applications
- Process clipboard content (translate, format, summarize)

## Reading Clipboard

### Windows (PowerShell)
```powershell
# Read text from clipboard
Get-Clipboard

# Read clipboard format info
Get-Clipboard -Format Text
Get-Clipboard -Format FileDropList
Get-Clipboard -Format Image
```

### macOS
```bash
# Read text from clipboard
pbpaste

# Read clipboard as HTML
osascript -e 'the clipboard as «class HTML»'
```

### Linux
```bash
# Requires xclip
xclip -selection clipboard -o
```

## Writing to Clipboard

### Windows (PowerShell)
```powershell
# Copy text to clipboard
Set-Clipboard "Hello World"

# Copy file path to clipboard
Set-Clipboard (Get-Item "C:\path\to\file.txt").FullName

# Copy command output to clipboard
Get-Process | Out-String | Set-Clipboard
```

### macOS
```bash
# Copy text to clipboard
echo "Hello World" | pbcopy

# Copy file content to clipboard
cat file.txt | pbcopy

# Copy command output to clipboard
ls -la | pbcopy
```

### Linux
```bash
echo "Hello World" | xclip -selection clipboard
```

## Common Workflows

### Copy and Transform
```bash
# Read clipboard → process → write back
# Example: uppercase clipboard content

# macOS
pbpaste | tr '[:lower:]' '[:upper:]' | pbcopy

# Windows PowerShell
(Get-Clipboard).ToUpper() | Set-Clipboard
```

### Save Clipboard Image
```powershell
# Windows — Save clipboard image to file
Add-Type -AssemblyName System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img) { $img.Save("clipboard_image.png") }
```

```bash
# macOS — Save clipboard image
osascript -e 'set imgData to the clipboard as «class PNGf»' -e 'set filePath to (POSIX path of (path to desktop)) & "clipboard_image.png"' -e 'set fileRef to open for access filePath with write permission' -e 'write imgData to fileRef' -e 'close access fileRef'
```

## Important Notes

- Clipboard content may contain sensitive data — never log or transmit it externally
- Always inform the user before overwriting clipboard content
- Image clipboard operations are platform-specific
