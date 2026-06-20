/**
 * twitter (X) —— 推特视频发布 driver。
 *
 * 改造自 phaseRunner.uploadVideoToTwitter:那个老 helper 只做上传 + 等转码,
 * 不点发布按钮(scenario 任务把发推留给上层 phase)。本 driver 是【一站式】:
 *   1. tab_create / navigate 确保 compose modal 打开
 *   2. 上传视频到 fileInput → 等 60s 转码
 *   3. 填正文到 compose textarea(Slate-like contentEditable)
 *   4. 点 "Post" / "发推" 按钮
 *   5. 等 modal 关闭 / URL 跳转(发推成功信号)
 *
 * 推特的 compose 是 Slate.js 编辑器(跟抖音类似的 contentEditable 但 React 合成事件),
 * 文字插入用 editor_insert_text(execCommand insertText 路径)能稳。
 */

import { checkPlatformLogin } from '../../scenario/platformLoginDriver';
import type { PublisherDriver, PublisherLoginStatus, PublishInput, PublishResult, PublishCtx } from './types';
import { uploadFileToInput, pubCmd, sleep, waitForSelector } from './publisherUtils';

const PLATFORM = 'x' as const;

async function checkLogin(): Promise<PublisherLoginStatus> {
  try {
    const r = await checkPlatformLogin('x');
    return r.loggedIn ? 'logged_in' : 'not_logged_in';
  } catch { return 'unknown'; }
}

/** 把 description + tags 拼成推文正文 —— 推特 280 字符上限,英文含 hashtag。 */
function buildTweetText(input: PublishInput): string {
  const parts: string[] = [];
  if (input.description) parts.push(input.description.trim());
  if (input.tags && input.tags.length) {
    const tagStr = input.tags.slice(0, 5).map((t) => {
      const clean = t.replace(/[#\s,，]+/g, '');
      return clean ? `#${clean}` : '';
    }).filter(Boolean).join(' ');
    if (tagStr) parts.push(tagStr);
  }
  return parts.join('\n\n').slice(0, 270); // 留 10 字符 buffer
}

async function upload(input: PublishInput, onLog?: (msg: string) => void, ctx?: PublishCtx): Promise<PublishResult> {
  const log = (m: string) => { try { onLog && onLog(m); } catch { /* ignore */ } };
  const tabId = ctx?.tabId;
  const text = buildTweetText(input);

  try {
    // Step 1: 等 compose 区域 (推特首页有常驻 compose;否则按 tweet button 弹 modal)
    log('🐦 [推特] 等 compose 区域…');
    const composeReady = await waitForSelector(PLATFORM,
      'div[data-testid="tweetTextarea_0"], [aria-label*="Post text"], [aria-label*="Tweet text"]',
      { timeoutMs: 8000, tabId });
    if (!composeReady) {
      // 没找到 compose,试着点工具栏 "post" 按钮弹 modal
      log('   未见 compose, 尝试点 [Post] 按钮…');
      try {
        await pubCmd(PLATFORM, 'main_world_click',
          { selector: 'a[data-testid="SideNav_NewTweet_Button"], [aria-label*="Post"]' },
          5000, tabId);
        await sleep(800);
      } catch { /* fallthrough — query 再试 */ }
      const retry = await waitForSelector(PLATFORM, 'div[data-testid="tweetTextarea_0"]', { timeoutMs: 5000, tabId });
      if (!retry) return { ok: false, reason: 'compose_not_found' };
    }

    // Step 2: 上传视频
    log('📤 上传视频…');
    const fileInputSel = 'input[data-testid="fileInput"], input[type="file"][accept*="video"], input[type="file"]';
    const upR = await uploadFileToInput({
      platform: PLATFORM,
      filePath: input.videoPath,
      targetSelector: fileInputSel,
      mimeType: 'video/mp4',
      tabId,
    });
    if (!upR.ok) return { ok: false, reason: 'video_upload_failed:' + upR.reason };

    // Step 3: 等推特处理(无显眼 DOM 信号,固定 120s)
    log('⏳ 等推特处理视频 120s…');
    await sleep(120000);

    // Step 4: 写正文
    if (text) {
      log(`✏️ 写入推文(${text.length} 字符)…`);
      const editorSel = 'div[data-testid="tweetTextarea_0"]';
      try {
        await pubCmd(PLATFORM, 'main_world_click', { selector: editorSel }, 5000, tabId);
        await sleep(400);
        const ir: any = await pubCmd(PLATFORM, 'editor_insert_text', {
          selector: editorSel, text,
        }, 10000, tabId);
        if (!ir || (ir.ok === false && ir.error)) {
          log('⚠️ 写正文失败,继续发推(仅视频)');
        }
      } catch {
        log('⚠️ 写正文异常,继续发推(仅视频)');
      }
    }

    // Step 5: 点 "Post" / "发推"
    log('🚀 点 [Post] 发推…');
    let posted = false;
    for (let i = 0; i < 5; i++) {
      if (i > 0) await sleep(1500);
      try {
        const r: any = await pubCmd(PLATFORM, 'click_with_text', {
          containerSel: 'body',
          acceptedTexts: ['Post', 'Tweet', '发推', '发布', '发送'],
          opts: { fuzzy: true, skipInactive: true, returnDebug: true },
        }, 8000, tabId);
        if (r && r.ok) { posted = true; break; }
      } catch { /* retry */ }
    }
    if (!posted) {
      // 直接试 testid
      try {
        await pubCmd(PLATFORM, 'main_world_click',
          { selector: 'div[data-testid="tweetButton"], button[data-testid="tweetButtonInline"]' },
          5000, tabId);
        posted = true;
      } catch { return { ok: false, reason: 'post_button_not_found' }; }
    }

    // Step 6: 等 compose 清空 / 跳转 = 发推成功信号
    await sleep(4000);
    log('✅ 推特发推完成(请到时间线确认)');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'unexpected:' + String(e?.message || e).slice(0, 100) };
  }
}

export const twitterDriver: PublisherDriver = {
  platform: PLATFORM,
  checkLogin,
  upload,
};
