---
name: file-manager
description: Advanced file management — search files, batch rename, convert formats, compare directories, calculate sizes, and organize files intelligently.
name_zh: "文件管理"
description_zh: "高级文件管理 — 搜索文件、批量重命名、格式转换、目录对比、计算大小、智能整理文件。"
name_ja: "ファイル管理"
description_ja: "高度なファイル管理 — ファイル検索、一括リネーム、フォーマット変換、ディレクトリ比較、サイズ計算。"
name_ko: "파일 관리"
description_ko: "고급 파일 관리 — 파일 검색, 일괄 이름 변경, 형식 변환, 디렉토리 비교, 크기 계산."
official: true
version: 1.0.0
---

# File Manager Skill

## When to Use This Skill

Use this skill when the user needs to:
- Search for files by name, type, size, or date
- Batch rename files with patterns
- Organize files into folders by type/date
- Find and remove duplicate files
- Calculate folder sizes
- Compare two directories
- Convert file formats (images, documents)

## File Search

### Windows
```bash
# Search by name
dir /s /b "C:\Users\*report*.pdf"

# Search by extension
dir /s /b "C:\Users\*.jpg"

# Find large files (>100MB)
forfiles /p "C:\" /s /m *.* /c "cmd /c if @fsize GEQ 104857600 echo @path @fsize"

# Find files modified in last 7 days
forfiles /p "C:\Users" /s /d +7 /c "cmd /c echo @path @fdate"
```

### macOS/Linux
```bash
# Search by name
find ~ -name "*report*.pdf" 2>/dev/null

# Search by extension
find ~ -name "*.jpg" 2>/dev/null

# Find large files (>100MB)
find / -size +100M 2>/dev/null | head -20

# Find files modified in last 7 days
find ~ -mtime -7 -type f 2>/dev/null
```

## Batch Rename

### Windows (PowerShell)
```powershell
# Add prefix
Get-ChildItem *.jpg | Rename-Item -NewName { "photo_$($_.Name)" }

# Replace text in filename
Get-ChildItem *.txt | Rename-Item -NewName { $_.Name -replace 'old', 'new' }

# Sequential numbering
$i = 1; Get-ChildItem *.png | ForEach-Object { Rename-Item $_ -NewName "image_$($i.ToString('000')).png"; $i++ }
```

### macOS/Linux
```bash
# Add prefix
for f in *.jpg; do mv "$f" "photo_$f"; done

# Replace text in filename
for f in *.txt; do mv "$f" "${f//old/new}"; done

# Sequential numbering
i=1; for f in *.png; do mv "$f" "image_$(printf '%03d' $i).png"; i=$((i+1)); done
```

## File Organization

```bash
# Organize by extension (create folders and move files)
# Windows PowerShell
Get-ChildItem -File | Group-Object Extension | ForEach-Object {
    $dir = $_.Name.TrimStart('.')
    if ($dir) { New-Item -ItemType Directory -Name $dir -Force | Out-Null; $_.Group | Move-Item -Destination $dir }
}

# macOS/Linux
for f in *.*; do ext="${f##*.}"; mkdir -p "$ext"; mv "$f" "$ext/"; done
```

## Disk Usage

```bash
# Windows
powershell -Command "Get-ChildItem -Recurse | Measure-Object -Property Length -Sum | Select-Object @{N='Size(MB)';E={[math]::Round($_.Sum/1MB,2)}}"

# macOS/Linux
du -sh */ | sort -rh | head -20
```

## Duplicate Detection

```bash
# Find duplicates by MD5 hash (macOS/Linux)
find . -type f -exec md5sum {} + | sort | uniq -w32 -dD

# Windows PowerShell
Get-ChildItem -Recurse -File | Get-FileHash | Group-Object Hash | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Group }
```

## Important Notes

- Always confirm with user before deleting or moving files
- Show a preview of changes before batch operations
- Back up important files before bulk modifications
- Use `-WhatIf` (PowerShell) or `echo` prefix to preview commands
