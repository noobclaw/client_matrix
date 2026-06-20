---
name: cursor-control
description: Control code editors (VS Code, Cursor, Windsurf) via their CLI and extension APIs. Open files, run tasks, manage extensions, and automate development workflows.
name_zh: "编辑器控制"
description_zh: "通过 CLI 和扩展 API 控制代码编辑器（VS Code、Cursor、Windsurf）。打开文件、运行任务、管理扩展。"
name_ja: "エディタ制御"
description_ja: "CLI と拡張 API でコードエディタ（VS Code、Cursor、Windsurf）を制御。ファイル操作、タスク実行、拡張管理。"
name_ko: "편집기 제어"
description_ko: "CLI 및 확장 API로 코드 편집기(VS Code, Cursor, Windsurf)를 제어. 파일 열기, 작업 실행, 확장 관리."
official: true
version: 1.0.0
---

# Cursor / VS Code Control Skill

## When to Use This Skill

Use this skill when the user wants to:
- Open files or projects in their code editor
- Install or manage editor extensions
- Run editor tasks or commands
- Set up development environments
- Navigate code (go to definition, find references)

## Editor CLI Commands

### VS Code / Cursor / Windsurf

All three editors share the same CLI interface:

```bash
# Detect which editor is available
which code 2>/dev/null || which cursor 2>/dev/null || which windsurf 2>/dev/null

# Open a file
code /path/to/file.ts
cursor /path/to/file.ts

# Open a folder as project
code /path/to/project
cursor /path/to/project

# Open file at specific line
code --goto /path/to/file.ts:42

# Diff two files
code --diff file1.ts file2.ts

# Install extension
code --install-extension ms-python.python
cursor --install-extension ms-python.python

# List installed extensions
code --list-extensions

# Uninstall extension
code --uninstall-extension extension-id

# Open new window
code --new-window

# Open settings
code --open-settings
```

### Detecting the Active Editor

```bash
# Windows
tasklist | findstr /i "code.exe cursor.exe windsurf.exe"

# macOS/Linux
ps aux | grep -E "code|cursor|windsurf" | grep -v grep
```

### Recommended Extensions to Install

When setting up a development environment, suggest these based on the project:

**Web Development:**
- `dbaeumer.vscode-eslint` — ESLint
- `esbenp.prettier-vscode` — Prettier
- `bradlc.vscode-tailwindcss` — Tailwind CSS

**Python:**
- `ms-python.python` — Python
- `ms-python.vscode-pylance` — Pylance

**General:**
- `eamodio.gitlens` — GitLens
- `usernamehw.errorlens` — Error Lens
- `christian-kohler.path-intellisense` — Path Intellisense

## Workflow Pattern

1. Detect which editor the user has installed
2. Use the appropriate CLI command
3. Verify the action completed successfully
4. Provide next steps or suggestions
