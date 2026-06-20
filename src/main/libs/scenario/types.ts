/**
 * Scenario automation — shared types between Electron main process libs.
 *
 * Keep this file dependency-free (no runtime imports) so both renderer
 * (via a type-only import) and main can use it.
 */

export type Platform = 'xhs' | 'x' | 'binance' | 'douyin' | 'tiktok' | 'youtube' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao' | 'video';

export type WorkflowType =
  | 'viral_production'
  | 'auto_reply'
  | 'mass_comment'
  | 'dm_reply'
  | 'data_monitor'
  | 'xhs_video_download'
  | 'douyin_video_download'
  | 'tiktok_video_download'
  | 'kuaishou_auto_engage'
  | 'kuaishou_video_download'
  | 'kuaishou_reply_fans_comment'
  | 'bilibili_auto_engage'
  | 'bilibili_video_download'
  | 'bilibili_reply_fans_comment'
  | 'shipinhao_image_text_creation'
  | 'shipinhao_reply_fans_comment'
  | 'toutiao_image_text_creation'
  | 'toutiao_reply_fans_comment';

export interface ScenarioManifest {
  id: string;                // e.g. "xhs_viral_production_career"
  version: string;           // "1.0.0"
  platform: Platform;
  workflow_type: WorkflowType;
  category: string;
  name_zh: string;
  name_en: string;
  description_zh: string;
  description_en: string;
  icon: string;
  default_config: ScenarioDefaultConfig;
  qualify?: {
    min_likes?: number;
    max_age_hours?: number;
    exclude_types?: string[];
  };
  risk_caps: RiskCaps;
  required_login_url: string;
  entry_urls: Record<string, string>;
  creator_urls?: Record<string, string>;
  skills: Record<string, any>;      // key → filename or nested object
  /**
   * Optional URL pattern (regex string) identifying which Chrome tab this
   * scenario's commands should be routed to. Introduced for multi-tab
   * concurrency (Twitter v1) so XHS tasks talk to xiaohongshu.com tabs
   * and Twitter tasks talk to x.com tabs without stepping on each other.
   *
   * Examples:
   *   '^https?://(www\\.)?xiaohongshu\\.com/'       — XHS scenarios
   *   '^https?://(www\\.)?(twitter|x)\\.com/'       — Twitter scenarios
   *
   * When omitted (legacy XHS scenarios pre-v4.18.5), commands route to
   * whichever tab the extension considers active — same behavior as before
   * this field existed. Backward compatible.
   */
  tab_url_pattern?: string;
  /**
   * Anchor URL for `tab_url_pattern`. Used by phaseRunner's pre-flight: if
   * NO open tab matches `tab_url_pattern` when about to send a routed
   * command (navigate / scroll / browser), the runner first opens this
   * URL via `tab_create`, waits, then proceeds with the original command.
   * Replaces the chrome-extension's hardcoded `anchorUrlFor` table — new
   * platforms (douyin / tiktok / youtube) ship a manifest with
   * `anchor_url` and don't need an extension republish to work without
   * a pre-opened tab.
   *
   * Optional but recommended whenever `tab_url_pattern` is set. Without
   * it, the extension's legacy `anchorUrlFor` is the only fallback (only
   * covers xhs / x / binance — other platforms throw "no anchor URL
   * known" if the user runs the task with no matching tab open).
   */
  anchor_url?: string;
  /**
   * Cross-tab scenarios (binance_from_x_repost / binance_from_x_link)
   * declare a secondary tab via `secondary_tab_url_pattern` /
   * `additional_tab_patterns`. This is its anchor — same role as
   * `anchor_url` but for the secondary pattern.
   */
  secondary_anchor_url?: string;
  /**
   * v4.25+ multi-tab patterns this scenario also touches. The pre-flight
   * walks each one and ensures a matching tab exists before the run.
   * Read by resourceKeysForPack today; pre-flight uses the same field.
   */
  additional_tab_patterns?: string[];
  /**
   * Single-string variant of additional_tab_patterns (used by
   * binance_from_x_repost). Kept here so types match runtime shape.
   */
  secondary_tab_url_pattern?: string;

  /**
   * v6.x window-routing rework (PR6): sub_platform ids the scenario
   * touches at any point during its run, e.g. ['xhs_creator', 'xhs_main'].
   * Used by scenarioManager.resourceKeysForPack as mutex keys (scenario
   * acquires `platform:${each}` lock per entry, blocks any other scenario
   * holding the same lock). Validated against SUB_PLATFORM_REGISTRY in
   * client/src/main/libs/scenario/subPlatformRegistry.ts — unknown ids
   * get a WARN log and still produce a standalone lock.
   */
  platforms?: string[];

  /**
   * v6.x (PR9): role names whose tabs should be closed at task end by
   * phaseRunner's _releaseAllWindows cleanup hook. Long-lived roles (e.g.
   * 'creator', 'main', 'home') are NOT listed here — they survive in the
   * windowRegistry so the next task hitting the same sub_platform reuses
   * them. Throwaway roles (e.g. 'explore' in xhs_reply_fans_comment) ARE
   * listed so the user's screen doesn't pile up dead tabs.
   * Only matched against ctx.openTab / ctx.waitChildTab calls that took
   * the v6 sub_platform path; v1.5.3-style tabs aren't tracked for cleanup.
   */
  transient_roles?: string[];
}

export interface ScenarioDefaultConfig {
  keywords: string[];
  persona: string;
  daily_count: number;
  variants_per_post: number;
  schedule_window: string;          // 'HH:MM-HH:MM'
}

export interface RiskCaps {
  max_daily_runs: number;
  max_scroll_per_run: number;
  min_scroll_delay_ms: number;
  max_scroll_delay_ms: number;
  read_dwell_min_ms: number;
  read_dwell_max_ms: number;
  max_run_duration_ms: number;
  min_interval_hours: number;
  weekly_rest_days: number;
  cooldown_captcha_hours: number;
  cooldown_rate_limit_hours: number;
  cooldown_account_flag_hours: number;
}

/** Config for discovery behavior (from config.json on server) */
export interface DiscoveryConfig {
  strategy: 'search_first' | 'explore_first';
  search_filters: {
    tab: string;
    sort: string;
    time: string;
    open_filter_panel: boolean;
  };
  qualify: {
    min_likes: number;
    exclude_types: string[];
    require_keyword_on_search: boolean;
    require_keyword_on_explore: boolean;
  };
  behavior: {
    first_screen_pause: [number, number];
    scroll_pause: [number, number];
    detail_page_pause: [number, number];
    filter_click_pause: [number, number];
    max_scrolls_no_new: number;
  };
}

/**
 * ScenarioPack — downloaded from server on each run.
 * Contains everything needed to execute a scenario:
 *   - scripts: browser-injected JS code (hot-updatable)
 *   - prompts: AI system prompts (hot-updatable)
 *   - config: discovery strategy/thresholds (hot-updatable)
 *   - manifest: metadata + risk caps
 */
export interface ScenarioPack {
  manifest: ScenarioManifest;
  scripts: Record<string, string>;
  prompts: Record<string, string>;
  config: DiscoveryConfig;
  orchestrator: string;           // JS code downloaded from server
  /** JS code for uploading a single already-generated draft. Used by
   *  TaskDetailPage "📤 上传" per-draft button. Downloaded from
   *  scenario pack's upload_draft_script slot. */
  upload_draft_script?: string;
  draft_uploader?: any;
}

// ── Task (a user's configured instance of a scenario) ──

export interface ScenarioTask {
  id: string;                       // local uuid
  scenario_id: string;              // references a scenario manifest id
  /** Fine-grained niche id (e.g. "career_side_hustle") — used for
   *  on-disk artifact organization and default keywords. */
  track: string;
  keywords: string[];
  /** Link-mode: if set, orchestrator skips keyword search and visits
   *  these XHS article URLs directly. 1-3 URLs. */
  urls?: string[];
  persona: string;
  daily_count: number;
  variants_per_post: number;
  /** Preferred run time in HH:MM (24h local). Used when interval is 'daily'. */
  daily_time: string;
  /** Run interval. `daily_random` = once per day at a random hour (no fixed time);
   *  used by auto-reply scenarios where pinning to the same hour would trip XHS risk-control. */
  run_interval: '30min' | '1h' | '3h' | '6h' | 'daily' | 'daily_random' | 'once';
  /** Pre-picked timestamp (ms epoch) of when the scheduler should fire
   *  this task next. Computed AFTER each successful run (or on the first
   *  scheduler tick if no last run yet) using the interval + jitter, then
   *  stored so the user can SEE the exact wall-clock time the next run
   *  will happen — without it daily_random just shows "in ~24-27h".
   *  The scheduler uses this as the authoritative fire time. */
  next_planned_run_at?: number;
  /** 任务末步是否自动上传到 XHS 草稿箱。
   *  true（默认）= 跑完改写+生图后自动调上传 orchestrator；
   *  false = 停在 step 3，草稿留本地待用户人工上传，降低封号风险。
   *  任务创建时用户在 wizard/modal 里选。 */
  auto_upload?: boolean;
  /** Legacy field */
  schedule_window?: string;
  /** Twitter v1: content language mode for tweet generation. zh/en/mixed.
   *  Optional — XHS scenarios ignore this. */
  language?: 'zh' | 'en' | 'mixed';
  /** Twitter v1: user's "real-experience pool" — free-form notes about
   *  recent activity, positions, opinions. AI scenarios (post_creator /
   *  link_rewrite) inject this into rewrite/original prompts so generated
   *  tweets have real substance instead of generic templates. Optional. */
  user_context?: string;
  /** douyin_image_text: 用户填的 3 段灵感来源。每次任务运行随机抽 1 段交给
   *  AI 改写。允许少于 3 段（最少 1 段）。空段被 orchestrator 过滤掉。 */
  source_segments?: string[];
  /** douyin_image_text: true → 跑完直接走"发布"按钮; false → 走"存草稿"。
   *  仅当 auto_upload=true 时生效。默认 true(抖音图文草稿只 1 篇上限,
   *  多篇任务用草稿模式只剩最后一篇)。 */
  auto_publish?: boolean;
  /** Twitter v1.x: x_auto_engage daily action ranges (min/max). System
   *  picks random in [min,max] each day. Optional — old tasks default to
   *  (0,3) follows / (1,daily_count) replies. */
  daily_follow_min?: number;
  daily_follow_max?: number;
  daily_reply_min?: number;
  daily_reply_max?: number;
  /** v4.22.x: XHS auto-reply article-count range. Each scheduled run
   *  picks random in [min, max]. Defaults: 1-6 if absent. Authoritative
   *  for auto_reply scenarios — when set, supersedes the legacy single
   *  daily_count field. */
  daily_count_min?: number;
  daily_count_max?: number;
  /** Twitter v2.4.27: is the user's X account a Blue V (subscribed)?
   *  Default false. Drives the per-tweet length cap that orchestrators
   *  inject into AI generation prompts:
   *    false → AI must keep generated tweets ≤ 140 chars (non-Blue cap)
   *    true  → AI free to pick short / medium / long (Blue gets 25k chars)
   *  Affects post_creator, link_rewrite, and auto_engage reply lengths. */
  is_blue_v?: boolean;
  enabled: boolean;
  /** v4.25.4 (语义变更):"当前选中的任务" — UI 高亮用,不再驱动调度。
   *  之前是"only active 可以 scheduler 自动运行"的单选闸门,导致多任务时
   *  其他任务到点不跑。现在 scheduler 看的是 enabled,active 仅供 UI 显示
   *  "starred / current" 状态。setActiveTask 仍可用,只影响 UI 不影响调度。 */
  active: boolean;
  created_at: number;
  updated_at: number;
}

// ── Track preset catalogue ──
// Hard-coded list of fine-grained XHS tracks. Each preset seeds the
// wizard's default keywords and suggests a persona direction. The UI
// renders an icon grid of these; the user picks one and can still tweak
// keywords afterwards.

export interface TrackPreset {
  id: string;
  platform: Platform;
  icon: string;
  name_zh: string;
  name_en: string;
  keywords: string[];
  persona_hint: string;
}

export const XHS_TRACK_PRESETS: TrackPreset[] = [
  {
    id: 'career_side_hustle', platform: 'xhs', icon: '💼',
    name_zh: '副业 · 打工人赚钱', name_en: 'Side Hustle',
    keywords: ['副业', '下班变现', '兼职', '月入过万', '副业赚钱', '在家赚钱', '被动收入', '低成本创业', '搞钱', '线上兼职', '自由职业', '零成本副业', '副业推荐', '宝妈副业', '学生兼职'],
    persona_hint: '一个想在下班后搞点副业的普通打工人，真诚不装',
  },
  {
    id: 'indie_dev', platform: 'xhs', icon: '👩‍💻',
    name_zh: '独立开发 · 程序员记录', name_en: 'Indie Dev',
    keywords: ['独立开发', '程序员副业', 'indie hacker', '个人开发者', '出海', 'SaaS', '开源项目', '技术变现', '远程工作', '自由开发者', 'AI 工具', '产品上线', '月收入', '技术栈', '全栈开发'],
    persona_hint: '独立开发者，前后端都写，真诚记录产品和收入',
  },
  {
    id: 'personal_finance', platform: 'xhs', icon: '💰',
    name_zh: '理财 · 记账攻略', name_en: 'Personal Finance',
    keywords: ['理财', '攒钱', '记账', '定投', '资产配置', '基金', '存钱', '月光族', '理财小白', '被动收入', '复利', '财务自由', '工资分配', '年度理财', '省钱技巧'],
    persona_hint: '月薪 1 万的普通白领，认真记账、稳健理财',
  },
  {
    id: 'travel', platform: 'xhs', icon: '✈️',
    name_zh: '旅行 · 攻略分享', name_en: 'Travel',
    keywords: ['旅行攻略', '穷游', '周末游', '小众目的地', '自驾游', '国内旅行', '民宿推荐', '拍照打卡', '三天两夜', '亲子出游', '一日游', '旅行清单', '避坑指南', '预算旅行', '城市漫步'],
    persona_hint: '爱说走就走的旅行爱好者，分享性价比攻略',
  },
  {
    id: 'food', platform: 'xhs', icon: '🍲',
    name_zh: '美食 · 探店做饭', name_en: 'Food',
    keywords: ['探店', '做饭', '日常晚餐', '健康餐', '家常菜', '减脂餐', '一人食', '烘焙', '厨房好物', '快手菜', '下饭菜', '早餐', '便当', '减肥食谱', '宝宝辅食'],
    persona_hint: '喜欢折腾吃喝的上班族，每天做饭给自己',
  },
  {
    id: 'outfit', platform: 'xhs', icon: '👗',
    name_zh: '穿搭 · 风格分享', name_en: 'Outfit',
    keywords: ['穿搭', 'OOTD', '通勤穿搭', '小个子穿搭', '显瘦穿搭', '日系穿搭', '韩系穿搭', '秋冬穿搭', '平价穿搭', '微胖穿搭', '极简穿搭', '一衣多穿', '衣橱整理', '氛围感', '配色技巧'],
    persona_hint: '小个子职场穿搭爱好者',
  },
  {
    id: 'beauty', platform: 'xhs', icon: '💄',
    name_zh: '美妆 · 产品测评', name_en: 'Beauty',
    keywords: ['美妆', '护肤', '平价彩妆', '粉底液测评', '防晒', '眼影盘', '口红推荐', '敏感肌', '抗老', '成分党', '素颜霜', '面膜', '卸妆', '美白', '学生党美妆'],
    persona_hint: '敏感肌护肤爱好者，只买成分党认证的',
  },
  {
    id: 'fitness', platform: 'xhs', icon: '💪',
    name_zh: '健身 · 减脂日记', name_en: 'Fitness',
    keywords: ['健身', '减脂', '塑形', '居家健身', '瑜伽', '跑步', '马甲线', '体态矫正', '拉伸', '帕梅拉', '增肌', '体重管理', '运动饮食', '健身打卡', '小基数减脂'],
    persona_hint: '上班族，边工作边坚持居家健身一年',
  },
  {
    id: 'reading', platform: 'xhs', icon: '📚',
    name_zh: '读书 · 书单笔记', name_en: 'Reading',
    keywords: ['读书', '书单', '读书笔记', '年度书单', '自我提升', '心理学', '小说推荐', '个人成长', '思维方式', '认知升级', '经典必读', '碎片阅读', '电子书', '知识管理', '笔记方法'],
    persona_hint: '一年读 50 本书的普通读者',
  },
  {
    id: 'parenting', platform: 'xhs', icon: '🧸',
    name_zh: '育儿 · 亲子日常', name_en: 'Parenting',
    keywords: ['育儿', '亲子', '早教', '母婴好物', '宝宝辅食', '绘本推荐', '儿童教育', '亲子游', '带娃', '幼儿园', '宝妈日常', '育儿心得', '儿童玩具', '亲子阅读', '幼小衔接'],
    persona_hint: '3 岁娃妈妈，理性育儿不焦虑',
  },
  {
    id: 'exam_prep', platform: 'xhs', icon: '🎓',
    name_zh: '考研 · 备考党', name_en: 'Exam Prep',
    keywords: ['考研', '考研经验', '英语学习', '备考', '考公', '雅思', '四六级', '学习方法', '时间管理', '背单词', '笔记整理', '自习室', '上岸经验', '复习计划', '刷题技巧'],
    persona_hint: '二战考研人，记录每日学习节奏',
  },
  {
    id: 'pets', platform: 'xhs', icon: '🐱',
    name_zh: '宠物 · 猫狗日常', name_en: 'Pets',
    keywords: ['猫咪', '狗狗', '宠物日常', '宠物用品', '养猫', '养狗', '宠物食品', '猫粮推荐', '宠物健康', '铲屎官', '猫咪日常', '遛狗', '宠物玩具', '领养', '宠物医院'],
    persona_hint: '一只中华田园猫的主人，真实养宠记录',
  },
  {
    id: 'home_decor', platform: 'xhs', icon: '🏠',
    name_zh: '家居 · 小屋布置', name_en: 'Home Decor',
    keywords: ['家居', '小户型', '租房改造', '收纳', '装修', '好物推荐', '桌面布置', '氛围灯', '绿植', '极简生活', '断舍离', '家居好物', '出租屋改造', '软装', '卧室布置'],
    persona_hint: '租房党，用 2000 预算把小公寓改舒服',
  },
  {
    id: 'study_method', platform: 'xhs', icon: '🏆',
    name_zh: '学习 · 效率工具', name_en: 'Study Method',
    keywords: ['效率', '时间管理', '学习方法', 'Notion', '高效学习', '番茄钟', '知识管理', '目标管理', '习惯养成', '自律', '效率工具', '思维导图', '复盘', '日程管理', '专注力'],
    persona_hint: '热爱效率工具的产品经理',
  },
  {
    id: 'career_growth', platform: 'xhs', icon: '🎯',
    name_zh: '职场 · 升级打怪', name_en: 'Career Growth',
    keywords: ['职场', '升职', '面试', '跳槽', '简历', '职场新人', '向上管理', '汇报技巧', '职业规划', '转行', '涨薪', '职场沟通', '领导力', 'offer', '职场干货'],
    persona_hint: '互联网行业工作 5 年的打工人',
  },
  {
    id: 'emotional_wellness', platform: 'xhs', icon: '🧘',
    name_zh: '情感 · 心理疗愈', name_en: 'Emotional Wellness',
    keywords: ['情感', '心理', 'MBTI', '自我成长', '情绪管理', '冥想', '焦虑', '内耗', '人际关系', '自愈', '正念', '心理学', '独处', '能量', '疗愈'],
    persona_hint: '正在做自我探索的 30 岁女性',
  },
  {
    id: 'photography', platform: 'xhs', icon: '📷',
    name_zh: '摄影 · 日常记录', name_en: 'Photography',
    keywords: ['摄影', '手机摄影', '胶片', '构图', '调色', '人像', '风光', '街拍', '日系', '修图', 'Lightroom', '摄影技巧', '照片墙', '拍照姿势', '镜头推荐'],
    persona_hint: '业余摄影爱好者，周末扫街',
  },
  {
    id: 'crafts', platform: 'xhs', icon: '🎨',
    name_zh: '手工 · DIY', name_en: 'Crafts',
    keywords: ['手工', 'DIY', '手账', '手工教程', '编织', '刺绣', '黏土', '插花', '蜡烛', '饰品制作', '拼贴', '纸艺', '手作', '创意', '手工材料'],
    persona_hint: '热爱动手做点小东西的文艺青年',
  },
];

export function findTrackPreset(track_id: string): TrackPreset | null {
  return XHS_TRACK_PRESETS.find(t => t.id === track_id) || null;
}

// ── Discovery output ──

export interface DiscoveredNote {
  external_post_id: string;
  external_url: string;
  title: string;
  body: string;
  images: string[];
  hashtags: string[];
  publish_time?: string;
  author_name?: string;
  author_followers?: number;
  metrics: {
    likes: number;
    comments: number;
    collects?: number;
    collected_at: number;
  };
}

// ── Extraction / composition output ──

export interface ExtractionResult {
  hook_type: string;
  hook_first_sentence: string;
  body_structure: string[];
  emotion_arc: string;
  core_value_prop: string;
  cta_type: string;
  cta_sentence: string;
  hashtag_strategy: {
    big_traffic: string[];
    niche: string[];
    count_total: number;
  };
  visual_pattern: string;
  length_char_count: number;
  paragraph_count: number;
  emoji_density: string;
  signature_phrases: string[];
}

export interface ComposedVariant {
  title: string;
  body: string;
  hashtags: string[];
  suggested_cover_text: string;
  route: string;
  notes_for_user: string;
  /** LLM-generated image prompt for the XHS cover. Saved to local md
   *  and passed to /api/image/generate as `cover_prompt`. */
  cover_image_prompt?: string;
  /** Same, for the inline content image. */
  content_image_prompt?: string;
}

export interface Draft {
  id: string;
  task_id: string;
  source_post: DiscoveredNote;
  extraction: ExtractionResult;
  variant: ComposedVariant;
  status: 'pending' | 'pushed' | 'ignored';
  created_at: number;
  pushed_at?: number;
}

// ── Run record (for riskGuard + UI status) ──

export interface TaskRun {
  task_id: string;
  started_at: number;
  ended_at?: number;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  reason?: string;
  collected_count?: number;
  draft_count?: number;
  /** Per-action successful counts (like / follow / comment / reply / post).
   *  Populated from ctx.addActionCount() in the orchestrator. Drives the
   *  TaskDetailPage "累计完成" + "上次完成" stat cards. Undefined for
   *  pre-rollout runs — UI shows '-' in that case. */
  action_counts?: Record<string, number>;
  /** Credits consumed by this run (LLM + image gen + interaction charges). */
  tokens_used?: number;
  /** USD cost at the time of the run, from system_config.token_price_per_million. */
  cost_usd?: number;
}
