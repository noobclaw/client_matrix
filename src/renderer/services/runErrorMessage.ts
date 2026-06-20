/**
 * runErrorMessage — translate scenario orchestrator reason codes into
 * user-friendly Chinese / English messages for run-failure / skip toasts
 * and the run-history detail page.
 *
 * Background:
 *   Orchestrators throw machine-readable reason codes like 'type_failed',
 *   'nav_failed', 'search_input_click_failed', 'follow_gate_post_overlay_timeout'
 *   when something goes wrong. Until v2.6.x these were rendered raw to the
 *   user as "运行失败: type_failed" — basically meaningless to a non-engineer.
 *
 *   This function keeps the codes intact in the orchestrator + cowork.log
 *   (so support and devs can still grep / track / retry on specific
 *   conditions) while presenting a humanized line to the user. The raw
 *   code is appended in parens as a debugging anchor when no friendly
 *   text is found.
 *
 * Maintenance:
 *   When you add a new reason code in a scenario orchestrator, also add
 *   (or extend a prefix rule) here. Run-grep:
 *     grep -rEoh "reason:\s*'[a-z_:]+'" backend/scenarios | sort -u
 *   to refresh the universe of codes worth covering.
 */

type Lang = 'zh' | 'en';

interface Translation { zh: string; en: string }

// Exact-match table — most common user-visible reasons. Order doesn't
// matter, lookup is by key.
const EXACT: Record<string, Translation> = {
  // ── 任务调度 / 资源 ───────────────────────────────────────────
  concurrency_limit_reached: { zh: '同时运行的任务已达上限,请先停一个再启动', en: 'Concurrent task limit reached — stop one before starting another' },
  task_not_found:            { zh: '任务未找到', en: 'Task not found' },
  scenario_pack_not_found:   { zh: '场景包未找到,可能需要更新客户端', en: 'Scenario pack not found — client may need an update' },
  user_stopped:              { zh: '已被用户手动停止', en: 'Stopped manually' },
  stopped:                   { zh: '已被用户手动停止', en: 'Stopped manually' },

  // ── 浏览器扩展 / 登录 ────────────────────────────────────────
  not_logged_in:             { zh: '检测到未登录该平台,请先在浏览器里登录后重试', en: 'Not logged in to platform — please log in first' },
  extension_too_old:         { zh: '浏览器扩展版本过旧,请更新到最新版', en: 'Browser extension too old, please update' },
  tab_precheck_failed:       { zh: '所需浏览器标签页校验失败,请确认目标平台已打开并登录', en: 'Required browser tabs check failed — open + login to target platforms' },
  js_unsupported:            { zh: '浏览器扩展不支持本场景所需的能力,请更新扩展', en: 'Browser extension lacks required capability — please update' },

  // ── 风控 / 验证码 / 限频 ─────────────────────────────────────
  captcha_detected:          { zh: '触发平台验证码,任务暂停 — 在浏览器里手动通过验证后再跑一次', en: 'Captcha detected — solve in browser then retry' },
  rate_limited:              { zh: '被平台限频,请稍后再试', en: 'Rate-limited by platform, try again later' },
  source_banned_phrase:      { zh: '源内容含违禁词,已自动跳过', en: 'Source contains banned phrase, skipped' },
  // anomaly:* 是 phase runner 探测页面状态后抛的标准化标签,任务详情页
  // 之前是分别 includes() 匹的;现在统一收到这。具体平台名通过 context.platform 传入。
  'anomaly:captcha':         { zh: '遇到验证码,请手动处理后重试', en: 'Captcha encountered — solve manually then retry' },
  'anomaly:rate_limited':    { zh: '操作过于频繁,请稍后再试', en: 'Too many operations — wait and retry' },
  'anomaly:login_wall':      { zh: '检测到需要重新登录,请到对应平台登录后再跑', en: 'Login wall detected — log in again to the platform' },
  'anomaly:account_flag':    { zh: '账号异常,请检查目标平台账号状态', en: 'Account flagged — check status on target platform' },

  // ── 导航 / 页面 / 输入 ───────────────────────────────────────
  nav_failed:                { zh: '页面加载失败,可能是网络问题或平台改版', en: 'Page navigation failed (network or platform change)' },
  nav_timeout:               { zh: '页面加载超时', en: 'Page load timeout' },
  search_input_click_failed: { zh: '搜索框点击失败,平台可能改了页面结构', en: 'Search input click failed — platform DOM may have changed' },
  type_failed:               { zh: '搜索关键词输入失败,可能扩展掉线或页面状态异常', en: 'Search keyword typing failed — extension or page may be off' },
  click_failed:              { zh: '页面元素点击失败', en: 'Click failed' },
  enter_failed:              { zh: '回车键提交失败', en: 'Enter key submit failed' },
  focus_failed:              { zh: '元素聚焦失败', en: 'Focus failed' },
  editor_focus_failed:       { zh: '编辑器聚焦失败', en: 'Editor focus failed' },
  editor_not_found:          { zh: '找不到编辑器,平台可能改版了', en: 'Editor not found — platform layout may have changed' },
  editor_write_failed:       { zh: '编辑器写入失败', en: 'Editor write failed' },
  editor_text_empty_after_type: { zh: '正文写入后校验为空,任务放弃以免发空帖', en: 'Editor empty after write — aborted to avoid blank post' },
  publish_btn_not_found:     { zh: '找不到发布按钮,可能平台改版', en: 'Publish button not found' },
  submit_failed:             { zh: '提交失败', en: 'Submit failed' },
  submit_did_not_clear:      { zh: '提交后输入框没清空,可能没真发出去', en: 'Submit did not clear input — likely did not actually post' },
  submit_failed_textarea_still_has_text: { zh: '提交后输入框仍有内容,任务标记失败', en: 'Submit failed: text remains in editor' },
  submit_no_effect:          { zh: '提交无响应', en: 'Submit had no effect' },

  // ── 关注 / 互动子流程 ────────────────────────────────────────
  follow_btn_not_found:      { zh: '找不到关注按钮', en: 'Follow button not found' },
  follow_gate_click_failed:  { zh: '关注弹窗点击失败', en: 'Follow gate click failed' },
  follow_gate_no_dismiss:    { zh: '关注弹窗无法关闭', en: 'Follow gate did not dismiss' },
  follow_gate_post_overlay_timeout: { zh: '关注后等待发文 overlay 超时', en: 'Follow gate post-overlay timeout' },
  follow_gate_post_submit_click_failed: { zh: '关注后提交按钮点击失败', en: 'Follow gate submit click failed' },
  follow_gate_resubmit_close_timeout: { zh: '关注后重提交关闭超时', en: 'Follow gate resubmit close timeout' },
  follow_ok_resubmit_failed: { zh: '关注成功后重提交失败', en: 'Resubmit after follow failed' },
  already_following:         { zh: '已经在关注,无需重复', en: 'Already following' },
  click_comments_icon_failed:{ zh: '评论图标点击失败', en: 'Comment icon click failed' },
  click_reply_failed:        { zh: '回复点击失败', en: 'Reply click failed' },
  reply_too_short:           { zh: '生成的回复太短被丢弃,本轮跳过', en: 'Reply too short — discarded this round' },
  post_no_longer_visible:    { zh: '目标帖子已不可见,可能被删', en: 'Target post no longer visible (likely deleted)' },

  // ── AI 生成 ──────────────────────────────────────────────────
  ai_call_failed:            { zh: 'AI 调用失败,请检查 API Key 和网络', en: 'AI call failed — check API key and network' },
  ai_compose_failed:         { zh: 'AI 生成内容失败', en: 'AI compose failed' },
  ai_rewrite_failed:         { zh: 'AI 改写内容失败', en: 'AI rewrite failed' },
  ai_output_too_short:       { zh: 'AI 输出过短,本轮跳过', en: 'AI output too short — skipped this round' },
  ai_output_too_long:        { zh: 'AI 输出过长,本轮跳过', en: 'AI output too long — skipped this round' },
  ai_boilerplate_after_retry:{ zh: 'AI 输出仍是套话,放弃本次', en: 'AI keeps producing boilerplate — gave up' },
  rewrite_empty:             { zh: 'AI 改写结果为空', en: 'Rewrite produced empty output' },
  rewrite_too_short:         { zh: 'AI 改写过短', en: 'Rewrite too short' },
  rewrite_malformed:         { zh: 'AI 改写格式错误', en: 'Rewrite malformed' },
  reply_malformed_json_unsalvageable: { zh: 'AI 回复 JSON 格式错误且无法修复', en: 'Reply JSON malformed and unrecoverable' },
  content_malformed_json_unsalvageable: { zh: 'AI 输出 JSON 格式错误且无法修复', en: 'Content JSON malformed and unrecoverable' },

  // ── 视频上传 / 发布 ──────────────────────────────────────────
  video_upload_timeout:      { zh: '视频上传超时', en: 'Video upload timeout' },
  video_failed_no_image_fallback: { zh: '视频帖失败且没有备用配图,任务放弃', en: 'Video post failed and no image fallback available' },
  viral_video_publish_failed:{ zh: '爆款视频发布失败', en: 'Viral video publish failed' },
  viral_video_publish_exception: { zh: '爆款视频发布异常', en: 'Viral video publish exception' },
  modal_not_appearing:       { zh: '上传弹窗没出现,可能扩展或网络异常', en: 'Upload modal did not appear' },
  modal_loading_timeout:     { zh: '上传弹窗加载超时', en: 'Upload modal load timeout' },
  modal_publish_btn_inactive:{ zh: '发布按钮一直未激活,可能上传未完成', en: 'Publish button stayed inactive — upload may have failed' },
  modal_lingered_after_publish: { zh: '发布后弹窗未消失,可能没真发出去', en: 'Modal lingered after publish — likely did not post' },
  modal_text_verify_failed_editor_empty: { zh: '弹窗内文字校验为空,放弃以免发空视频帖', en: 'Modal text verify empty — aborted to avoid blank video post' },

  // ── 候选 / 数据 ──────────────────────────────────────────────
  no_candidates:             { zh: '没有可用的候选,本批跳过', en: 'No candidates available' },
  no_posts:                  { zh: '没有可用的帖子', en: 'No posts available' },
  no_targets:                { zh: '没有可用目标', en: 'No targets available' },
  no_kol_pool:               { zh: '配置的 KOL 池为空', en: 'KOL pool is empty' },
  no_keywords:               { zh: '配置的关键词为空', en: 'Keyword list is empty' },
  no_feed_tweets:            { zh: '推特 feed 里没抓到推文', en: 'No tweets found in feed' },
  no_feed_posts:             { zh: 'feed 里没抓到帖子', en: 'No posts found in feed' },
  no_likeable_tweets:        { zh: '没有可点赞的推文', en: 'No likeable tweets' },
  no_likeable_posts:         { zh: '没有可点赞的帖子', en: 'No likeable posts' },
  no_quotable_tweets_found:  { zh: '没找到可引用的推文', en: 'No quotable tweets found' },
  no_viral_tweet:            { zh: '没找到爆款推文', en: 'No viral tweet found' },
  no_viral_long_tweets_found:{ zh: '没找到爆款长推', en: 'No viral long tweets found' },
  no_qualified:              { zh: '没有符合条件的对象', en: 'No qualified items' },
  no_urls_provided:          { zh: '没填写要处理的 URL', en: 'No URLs provided' },
  no_valid_images:           { zh: '没有有效配图', en: 'No valid images' },
  no_images:                 { zh: '没有图片可用', en: 'No images available' },
  no_source_segments:        { zh: '没填灵感来源段落,请编辑任务补上 1-3 段参考文案', en: 'No source segments provided. Please edit the task and add 1-3 reference snippets.' },
  no_path_available:         { zh: '没有可用执行路径', en: 'No execution path available' },
  no_confirmation:           { zh: '没收到平台确认信号', en: 'No confirmation from platform' },
  collect_failed:            { zh: '采集失败', en: 'Collection failed' },
  tweet_nav_failed:          { zh: '导航到推文失败', en: 'Tweet navigation failed' },
  tweet_text_empty:          { zh: '抓到的推文正文为空', en: 'Tweet text empty' },
  discover_page_failed:      { zh: '打开 Discover 页面失败', en: 'Discover page navigation failed' },
  x_feed_scrape_failed:      { zh: '推特 feed 抓取失败', en: 'Twitter feed scrape failed' },
  image_download_failed:     { zh: '图片下载失败', en: 'Image download failed' },
  image_upload_failed:       { zh: '图片上传失败', en: 'Image upload failed' },
  saved_as_draft:            { zh: '已保存为草稿(未直接发布)', en: 'Saved as draft (not published)' },
  missing_draft:             { zh: '草稿丢失', en: 'Draft missing' },
  bad_index:                 { zh: '索引越界', en: 'Bad index' },
  all_failed:                { zh: '所有候选都失败,本次任务无产出', en: 'All candidates failed — no output this run' },
  timeout:                   { zh: '操作超时', en: 'Operation timeout' },
  unknown:                   { zh: '未知错误', en: 'Unknown error' },
};

// Prefix rules — applied if exact match misses. First match wins.
// Pattern: { prefix, mapper(suffix) -> Translation }
const PREFIX_RULES: Array<{ prefix: string; toMessage: (rest: string) => Translation }> = [
  { prefix: 'video_upload_failed:', toMessage: (rest) => ({ zh: `视频上传失败 (${rest})`, en: `Video upload failed (${rest})` }) },
  { prefix: 'video_upload_exception:', toMessage: (rest) => ({ zh: `视频上传异常 (${rest})`, en: `Video upload exception (${rest})` }) },
  { prefix: 'video_icon_click_failed:', toMessage: (rest) => ({ zh: `视频图标点击失败 (${rest})`, en: `Video icon click failed (${rest})` }) },
  { prefix: 'modal_text_insert_failed:', toMessage: (rest) => ({ zh: `弹窗内文字写入失败 (${rest})`, en: `Modal text insert failed (${rest})` }) },
  { prefix: 'modal_text_insert_exception:', toMessage: (rest) => ({ zh: `弹窗内文字写入异常 (${rest})`, en: `Modal text insert exception (${rest})` }) },
  { prefix: 'click_comments_icon_', toMessage: () => ({ zh: '评论图标点击失败', en: 'Comment icon click failed' }) },
  { prefix: 'mechanism_failed:', toMessage: (rest) => ({ zh: `机制不可用 (${rest})`, en: `Mechanism unavailable (${rest})` }) },
  { prefix: 'submit_', toMessage: () => ({ zh: '提交失败', en: 'Submit failed' }) },
  { prefix: 'binance_', toMessage: () => ({ zh: '币安广场操作失败', en: 'Binance Square operation failed' }) },
  { prefix: 'x_', toMessage: () => ({ zh: '推特操作失败', en: 'Twitter operation failed' }) },
  { prefix: 'anomaly:', toMessage: (rest) => ({ zh: `平台异常 (${rest})`, en: `Platform anomaly (${rest})` }) },
  { prefix: 'exception:', toMessage: (rest) => ({ zh: `异常 (${rest})`, en: `Exception (${rest})` }) },
  { prefix: 'top_exception:', toMessage: (rest) => ({ zh: `顶层异常 (${rest})`, en: `Top-level exception (${rest})` }) },
  { prefix: 'unknown_action_type:', toMessage: (rest) => ({ zh: `未知动作类型 (${rest})`, en: `Unknown action type (${rest})` }) },
  { prefix: 'resource_busy:', toMessage: () => ({ zh: '所需资源被其他任务占用', en: 'Required resource is busy' }) },
];

// Substring rules — last-resort, looser matching (also unchanged from
// the inline behavior in TaskDetailPage so we don't regress).
const SUBSTRING_RULES: Array<{ contains: string; message: Translation }> = [
  { contains: 'BROWSER',     message: { zh: '浏览器插件未连接,请先打开 NoobClaw 桌面端 + 安装扩展', en: 'Browser extension not connected — open NoobClaw and install extension' } },
  { contains: 'API_KEY',     message: { zh: 'AI 模型 API Key 未配置,请到设置里填一下', en: 'AI API key not set — configure in settings' } },
  { contains: 'scenario_pack', message: { zh: '场景包未找到,可能需要更新客户端', en: 'Scenario pack not found — client may need update' } },
];

interface FriendlyContext {
  /** Platform display name (e.g. "抖音", "Twitter") — substituted into
   *  anomaly:login_wall / anomaly:account_flag messages so they read more
   *  specific than the generic version. Optional. */
  platform?: string;
}

/**
 * Translate a raw reason code to a friendly user-facing message.
 * Falls back to "操作失败 (raw_code)" when nothing matches, so the user
 * still sees something actionable + the raw code is preserved for support.
 */
export function friendlyRunError(rawReason: string | null | undefined, lang: Lang = 'zh', ctx?: FriendlyContext): string {
  const r = String(rawReason || '').trim();
  if (!r) return lang === 'zh' ? '未知错误' : 'Unknown error';
  const platform = ctx?.platform || '';

  // Special-case anomaly:login_wall / anomaly:account_flag with platform
  // substitution before the generic exact-match path — gives users a more
  // specific instruction than the platform-less default.
  if (platform) {
    if (r === 'anomaly:login_wall') {
      return lang === 'zh' ? `需要重新登录 ${platform},请打开浏览器登录后再跑` : `Login required for ${platform} — log in then retry`;
    }
    if (r === 'anomaly:account_flag') {
      return lang === 'zh' ? `账号异常,请检查 ${platform} 账号状态` : `Account flagged — check ${platform} account status`;
    }
  }

  // Try exact match
  if (EXACT[r]) return EXACT[r][lang];

  // Try prefix match
  for (const rule of PREFIX_RULES) {
    if (r.startsWith(rule.prefix)) {
      const rest = r.slice(rule.prefix.length).slice(0, 60); // truncate noise
      return rule.toMessage(rest)[lang];
    }
  }

  // Try substring match
  for (const rule of SUBSTRING_RULES) {
    if (r.includes(rule.contains)) return rule.message[lang];
  }

  // Generic *_failed → "操作失败 (raw)"
  if (/_failed$/i.test(r)) {
    return lang === 'zh' ? `操作失败 (${r})` : `Operation failed (${r})`;
  }

  // Last-resort fallback — keep the raw code so support can still help
  return lang === 'zh' ? `运行异常 (${r})` : `Run error (${r})`;
}
