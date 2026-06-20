---
name: translator
description: Translate text, documents, and files between languages. Supports 50+ languages with AI-powered translation that preserves formatting and context.
name_zh: "翻译助手"
description_zh: "翻译文本、文档和文件。AI 驱动的翻译支持 50+ 种语言，保留格式和上下文。"
name_ja: "翻訳アシスタント"
description_ja: "テキスト、文書、ファイルを翻訳。50以上の言語に対応し、フォーマットとコンテキストを保持。"
name_ko: "번역 도우미"
description_ko: "텍스트, 문서, 파일을 번역. 50개 이상 언어를 지원하며 형식과 맥락을 유지."
official: true
version: 1.0.0
---

# Translator Skill

## When to Use This Skill

Use this skill when the user needs to:
- Translate text between languages
- Translate entire documents (keeping formatting)
- Translate code comments
- Localize content for different regions
- Proofread translations for accuracy

## How It Works

This skill uses the AI's built-in multilingual capabilities to translate. No external API needed.

## Translation Guidelines

### Text Translation
When translating text:
1. Preserve the original meaning and tone
2. Adapt idioms and cultural references appropriately
3. Keep technical terms consistent
4. Maintain formatting (markdown, HTML, etc.)
5. If unsure about a term, provide alternatives in parentheses

### Document Translation
When translating documents:
1. Read the entire document first to understand context
2. Translate section by section
3. Keep headings, lists, and code blocks formatted correctly
4. Preserve links and references
5. Add translator notes for culturally specific content

### Code Comment Translation
When translating code comments:
1. Only translate comments, never modify code
2. Keep variable names and function names unchanged
3. Preserve comment style (// or /* */ or #)
4. Keep TODO, FIXME, HACK markers in English

## Supported Languages

The AI natively supports translation between these languages (and more):

| Language | Code |
|----------|------|
| English | en |
| Chinese (Simplified) | zh-CN |
| Chinese (Traditional) | zh-TW |
| Japanese | ja |
| Korean | ko |
| Spanish | es |
| French | fr |
| German | de |
| Russian | ru |
| Portuguese | pt |
| Arabic | ar |
| Hindi | hi |
| Thai | th |
| Vietnamese | vi |
| Indonesian | id |
| Turkish | tr |
| Italian | it |
| Dutch | nl |
| Polish | pl |
| Swedish | sv |

## Translation Patterns

### Simple Text
```
User: Translate to Japanese: "Hello, how are you?"
AI: "こんにちは、お元気ですか？"
```

### File Translation
```
User: Translate README.md to Chinese
AI:
1. Read README.md
2. Translate content preserving markdown formatting
3. Write to README_zh.md
```

### Batch Translation (i18n)
```
User: Translate these i18n keys to French and German

Source (en):
{
  "welcome": "Welcome to NoobClaw",
  "login": "Connect Wallet",
  "logout": "Disconnect"
}

French (fr):
{
  "welcome": "Bienvenue sur NoobClaw",
  "login": "Connecter le portefeuille",
  "logout": "Déconnecter"
}

German (de):
{
  "welcome": "Willkommen bei NoobClaw",
  "login": "Wallet verbinden",
  "logout": "Trennen"
}
```

## Quality Checks

After translation, verify:
- [ ] No untranslated segments remain
- [ ] Technical terms are consistent throughout
- [ ] Numbers, dates, and units are localized correctly
- [ ] Links and references still work
- [ ] Formatting is preserved
- [ ] The translation reads naturally (not word-by-word)

## Important Notes

- Always ask the user for target language if not specified
- For ambiguous text, provide context or ask for clarification
- Respect regional language differences (zh-CN vs zh-TW, pt-BR vs pt-PT)
- Keep brand names untranslated (NoobClaw, BNB, etc.)
