/**
 * Intent Classifier — routes user prompts to the most relevant Skills.
 *
 * Two-layer approach:
 *   Layer 1: Keyword/regex matching (instant, zero latency)
 *   Layer 2: LLM classification (async, ~300ms, used when layer 1 returns empty)
 *
 * Returns at most MAX_MATCHED_SKILLS skill IDs, or empty array when nothing matches.
 * Callers should treat an empty result as "no skill injection needed".
 */

import { resolveCurrentApiConfig } from './claudeSettings';

export type IntentResult = {
  skillIds: string[];
  source: 'keyword' | 'llm' | 'none';
};

type KeywordEntry = {
  id: string;
  patterns: RegExp[];
};

// Maps skill IDs to regex patterns that indicate user wants that skill.
// Patterns are tested case-insensitively against the full user prompt.
const KEYWORD_MAP: KeywordEntry[] = [
  {
    id: 'desktop-control',
    patterns: [
      /微信|wechat|钉钉|飞书/i,
      /截图|截屏|screenshot/i,
      /鼠标.*点击|点击.*鼠标|mouse.?click|right.?click/i,
      /打开.*(应用|软件|程序)|启动.*(应用|软件|程序)|launch.*app|open.*app/i,
      /桌面.*(打开|操作|控制)|desktop.*(control|open)/i,
      /sendkeys|键盘.*输入|type.*(into|in).*window/i,
      /窗口.*(切换|激活|最小化|最大化)|window.*(switch|activate|minimize|maximize)/i,
      /发消息给|给.*发.*消息|给.*发.*话/i,
    ],
  },
  {
    id: 'web-search',
    patterns: [
      /帮我(搜索|查一下|查找|找一下)|搜索一下|搜一下/i,
      /search.*(for|online|the web)|google.*for/i,
      /最新(消息|新闻|资讯)|latest.*(news|updates)/i,
      /现在.*价格|.*最新价格|coin.*price|token.*price/i,
      /实时.*(行情|汇率)|market.*(cap|data)/i,
    ],
  },
  {
    id: 'pdf',
    patterns: [
      /\.pdf\b/i,
      /pdf.*(文件|文档|读取|打开|转换|合并|分割|split|merge)/i,
      /(读取|打开|转换|合并|分割).*pdf/i,
    ],
  },
  {
    id: 'xlsx',
    patterns: [
      /\.xlsx?\b/i,
      /excel|电子表格|spreadsheet/i,
      /(读取|打开|处理|分析|生成).*(表格|excel)|(create|read|open|process).*(spreadsheet|excel)/i,
    ],
  },
  {
    id: 'docx',
    patterns: [
      /\.docx?\b/i,
      /word.*(文件|文档|doc)|word文档/i,
    ],
  },
  {
    id: 'pptx',
    patterns: [
      /\.pptx?\b/i,
      /\bppt\b|幻灯片|演示文稿|\bpresentation\b/i,
    ],
  },
  {
    id: 'translator',
    patterns: [
      /翻译|translate|翻成.*(文|语)/i,
      /中.*英|英.*中|中.*日|日.*中|中.*韩|韩.*中/i,
      /to (english|chinese|japanese|korean|french|german|spanish|russian|arabic|hindi)/i,
      /用(英文|日文|韩文|法文|德文|俄文|中文).*(说|写|回|表达)/i,
    ],
  },
  {
    id: 'image-editor',
    patterns: [
      /图片.*(编辑|裁剪|压缩|调整|处理|转换)|edit.*image/i,
      /crop.*image|resize.*image|compress.*image|convert.*image/i,
    ],
  },
  {
    id: 'imap-smtp-email',
    patterns: [
      /发邮件|收邮件|查邮件|邮箱.*(查看|发送|接收)/i,
      /send.*email|check.*email|read.*email/i,
      /\bsmtp\b|\bimap\b/i,
    ],
  },
  {
    id: 'system-monitor',
    patterns: [
      /cpu.*(占用|使用率)|内存.*(占用|使用率)|磁盘.*(空间|使用)/i,
      /cpu usage|memory usage|disk.*(space|usage)/i,
      /哪个.*(进程|程序|应用).*占|占用.*资源|系统.*监控/i,
      /清理.*(缓存|临时文件)|temp.*(files|folder)/i,
    ],
  },
  {
    id: 'scheduled-task',
    patterns: [
      /定时.*(执行|运行|发送|提醒)|每天.*自动|每周|每月/i,
      /schedule.*(task|job)|cron.*(job|expression)|recurring.*task/i,
    ],
  },
  {
    id: 'weather',
    patterns: [
      /天气|weather|气温|下雨|下雪|forecast|今天.*温度|温度.*今天/i,
    ],
  },
  {
    id: 'file-manager',
    patterns: [
      /批量.*(重命名|移动|复制|整理)|rename.*files.*batch/i,
      /整理.*文件夹|文件.*批量|organize.*files/i,
    ],
  },
  {
    id: 'clipboard-manager',
    patterns: [
      /剪贴板|clipboard/i,
    ],
  },
  {
    id: 'playwright',
    patterns: [
      /\bplaywright\b|\bpuppeteer\b/i,
      /自动化测试|end.?to.?end.*test|e2e.*test/i,
      /爬虫|爬取.*数据|web.*scraping|scrape.*website/i,
    ],
  },
  {
    id: 'remotion',
    patterns: [
      /\bremotion\b/i,
      /制作.*视频.*代码|用代码.*生成.*动画/i,
    ],
  },
  {
    id: 'develop-web-game',
    patterns: [
      /开发.*游戏|做.*游戏|web.*game|html.*game|game.*develop/i,
    ],
  },
  {
    id: 'seedream',
    patterns: [
      /\bseedream\b/i,
      /ai.*绘图|生成.*图片|image.*gen(eration)?|text.*to.*image|文生图/i,
    ],
  },
  {
    id: 'seedance',
    patterns: [
      /\bseedance\b/i,
      /视频.*生成.*ai|ai.*生成.*视频|generate.*video|text.*to.*video/i,
    ],
  },
  {
    id: 'films-search',
    patterns: [
      /电影.*(推荐|搜索|查找)|找.*电影|movie.*(search|recommend|find)/i,
    ],
  },
  {
    id: 'music-search',
    patterns: [
      /音乐.*(搜索|推荐|查找)|找.*歌曲?|music.*(search|recommend|find)/i,
    ],
  },
];

const INTENT_CLASSIFY_TIMEOUT_MS = 1200;
const MAX_MATCHED_SKILLS = 2;

/**
 * Layer 1: keyword/regex matching, returns up to MAX_MATCHED_SKILLS IDs
 * sorted by number of matched patterns (higher = more relevant).
 */
function matchByKeywords(prompt: string, enabledIds: Set<string>): string[] {
  const scores = new Map<string, number>();
  for (const entry of KEYWORD_MAP) {
    if (!enabledIds.has(entry.id)) continue;
    let matched = 0;
    for (const pattern of entry.patterns) {
      if (pattern.test(prompt)) matched++;
    }
    if (matched > 0) scores.set(entry.id, matched);
  }
  if (scores.size === 0) return [];
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_MATCHED_SKILLS)
    .map(([id]) => id);
}

/**
 * Layer 2: LLM-based classification for prompts that keywords couldn't match.
 * Uses the current API config, returns empty array on any failure.
 */
async function classifyByLlm(
  prompt: string,
  skills: Array<{ id: string; description: string }>
): Promise<string[]> {
  const { config } = resolveCurrentApiConfig();
  if (!config) return [];

  const base = config.baseURL.trim().replace(/\/+$/, '');
  const url = base.endsWith('/v1/messages') ? base
    : base.endsWith('/v1') ? `${base}/messages`
    : `${base}/v1/messages`;

  const skillList = skills.map(s => `- ${s.id}: ${s.description}`).join('\n');
  const classifyPrompt = [
    'Classify the user intent. Reply with skill IDs only (comma-separated) or "none".',
    'Return at most 2 IDs. When in doubt, return "none". Never guess.',
    '',
    'Available skills:',
    skillList,
    '',
    `User: ${prompt}`,
  ].join('\n');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), INTENT_CLASSIFY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 30,
        temperature: 0,
        messages: [{ role: 'user', content: classifyPrompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) return [];

    const payload = await response.json() as Record<string, unknown>;
    const content = payload.content;
    if (!Array.isArray(content)) return [];

    const text = content
      .map((item: unknown) => {
        if (item && typeof item === 'object') {
          const block = item as Record<string, unknown>;
          return typeof block.text === 'string' ? block.text : '';
        }
        return '';
      })
      .join('')
      .trim()
      .toLowerCase();

    if (!text || text === 'none') return [];
    return text.split(/[,\s]+/).map((s: string) => s.trim()).filter(Boolean).slice(0, MAX_MATCHED_SKILLS);
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Main entry point.
 *
 * @param prompt         The user's message.
 * @param enabledSkills  List of currently enabled skills (from skillManager.listSkills()).
 * @param hasManualSkill Whether the user manually selected a skill — if true, skip classification.
 * @returns IntentResult with matched skillIds and the source ('keyword' | 'llm' | 'none').
 */
export async function classifyIntent(
  prompt: string,
  enabledSkills: Array<{ id: string; name: string; description: string }>,
  hasManualSkill = false
): Promise<IntentResult> {
  if (hasManualSkill || !prompt?.trim() || enabledSkills.length === 0) {
    return { skillIds: [], source: 'none' };
  }

  const enabledIds = new Set(enabledSkills.map(s => s.id));

  // Layer 1: instant keyword matching
  const keywordMatches = matchByKeywords(prompt, enabledIds);
  if (keywordMatches.length > 0) {
    return { skillIds: keywordMatches, source: 'keyword' };
  }

  // Layer 2: LLM fallback (async, ~300ms)
  try {
    const llmMatches = await classifyByLlm(prompt, enabledSkills);
    const valid = llmMatches.filter(id => enabledIds.has(id));
    if (valid.length > 0) return { skillIds: valid, source: 'llm' };
  } catch {
    // silent fallback
  }

  return { skillIds: [], source: 'none' };
}
