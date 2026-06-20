/**
 * douyin —— 抖音创作者中心视频发布 driver。
 *
 * 抖音的 editor 是 Slate-like 富文本,#hashtag 要 commit 成 [data-mention] pill 才能被
 * 平台识别为话题(光打文字不算)。memory project_douyin_hashtag_paste.md 实测:
 *   - editor_paste_text 触发 dropdown + main_world_click 选第 1 项 = 稳
 *   - perChar / execCommand insertText / Enter 三条路【都坏】
 * 所以这里 tag 走「逐个粘贴 + 点击 dropdown 第 1 项」的三步法,正文走普通 editor_insert_text。
 *
 * 上传流程:
 *   1. 等创作者中心页面加载(input[type=file] 出现)
 *   2. 上传视频(file input,接受 mp4/mov/webm)
 *   3. 等转码进度条消失(上传/解析完成信号)
 *   4. 填标题(普通 input)
 *   5. 填描述 + tag(描述用 editor_insert_text,tag 走三步法)
 *   6. 点 [发布] 按钮
 *   7. 等跳转到「作品管理」(发布成功信号)
 */

import { checkPlatformLogin } from '../../scenario/platformLoginDriver';
import type { PublisherDriver, PublisherLoginStatus, PublishInput, PublishResult, PublishCtx } from './types';
import { uploadFileToInput, pubCmd, sleep, waitForSelector } from './publisherUtils';

const PLATFORM = 'douyin' as const;

async function checkLogin(): Promise<PublisherLoginStatus> {
  try {
    const r = await checkPlatformLogin('douyin');
    return r.loggedIn ? 'logged_in' : 'not_logged_in';
  } catch { return 'unknown'; }
}

/** 抖音 hashtag commit 三步法:粘 #tag → 等 dropdown → 点第 1 项变 pill。失败也继续(不阻塞)。 */
async function commitHashtagPill(editorSel: string, tag: string, tabId?: number): Promise<boolean> {
  const clean = tag.replace(/[#\s,，]+/g, '');
  if (!clean) return false;
  try {
    // 1. 粘 "#tag" 触发 dropdown
    await pubCmd(PLATFORM, 'editor_paste_text', {
      selector: editorSel,
      text: '#' + clean,
    }, 8000, tabId);
    await sleep(700); // 等 dropdown 渲染
    // 2. 点 dropdown 第 1 项(memory 记:只有点击 dropdown 第 1 项稳;Enter/perChar 都坏)
    const dropdownSel = '.tag-popover-item:first-child, .editor-mention-item:first-child, [data-mentionitem-index="0"]';
    try {
      await pubCmd(PLATFORM, 'main_world_click', { selector: dropdownSel }, 5000, tabId);
      return true;
    } catch {
      // dropdown 没出来 → 这个 tag 失败,继续后面的(已经有 #文字 在 editor 里,平台勉强能识别)
      return false;
    }
  } catch { return false; }
}

async function upload(input: PublishInput, onLog?: (msg: string) => void, ctx?: PublishCtx): Promise<PublishResult> {
  const log = (m: string) => { try { onLog && onLog(m); } catch { /* ignore */ } };
  const tabId = ctx?.tabId;

  try {
    // Step 1: 等创作者中心
    log('🎵 [抖音] 等创作者中心上传页…');
    const inputReady = await waitForSelector(PLATFORM,
      'input[type="file"][accept*="video"], input[type="file"][accept*="mp4"], .upload-content input[type="file"]',
      { timeoutMs: 15000, tabId });
    if (!inputReady) return { ok: false, reason: 'upload_input_not_found' };

    // Step 2: 上传
    log('📤 上传视频…');
    const upR = await uploadFileToInput({
      platform: PLATFORM,
      filePath: input.videoPath,
      targetSelector: 'input[type="file"][accept*="video"], input[type="file"][accept*="mp4"], .upload-content input[type="file"]',
      mimeType: 'video/mp4',
      tabId,
    });
    if (!upR.ok) return { ok: false, reason: 'video_upload_failed:' + upR.reason };
    log('✓ 视频已注入,等抖音解析…');

    // Step 3: 等转码进度条消失(标题输入框出现 = 转码完成可填表)
    const titleSel = '.title-input input, input[placeholder*="标题"], input[placeholder*="作品标题"]';
    const titleReady = await waitForSelector(PLATFORM, titleSel, { timeoutMs: 5 * 60 * 1000, intervalMs: 2000, tabId });
    if (!titleReady) return { ok: false, reason: 'title_input_not_appearing' };
    log('✓ 转码完成,准备填表');

    // Step 4: 填标题
    if (input.title) {
      log(`✏️ 填标题(${input.title.length} 字符)…`);
      try {
        await pubCmd(PLATFORM, 'set_input_value', {
          selector: titleSel, value: input.title.slice(0, 30),
        }, 5000, tabId);
      } catch { log('⚠️ 标题填入失败,继续'); }
    }

    // Step 5: 填描述 + tag
    const editorSel = '.editor-kit-container [contenteditable="true"], .zone-container [contenteditable="true"], [contenteditable="true"][data-slate-editor]';
    if (input.description) {
      log(`✏️ 填描述(${input.description.length} 字符)…`);
      try {
        await pubCmd(PLATFORM, 'main_world_click', { selector: editorSel }, 5000, tabId);
        await sleep(300);
        await pubCmd(PLATFORM, 'editor_insert_text', {
          selector: editorSel, text: input.description.slice(0, 600),
        }, 10000, tabId);
      } catch { log('⚠️ 描述填入失败,继续'); }
    }
    if (input.tags && input.tags.length) {
      log(`#️⃣ 添加 ${Math.min(input.tags.length, 5)} 个话题…`);
      for (const tag of input.tags.slice(0, 5)) {
        await commitHashtagPill(editorSel, tag, tabId);
        await sleep(250);
      }
    }

    // Step 6: 点发布
    log('🚀 点 [发布]…');
    let posted = false;
    for (let i = 0; i < 6; i++) {
      if (i > 0) await sleep(1500);
      try {
        const r: any = await pubCmd(PLATFORM, 'click_with_text', {
          containerSel: 'body',
          acceptedTexts: ['发布', '立即发布', 'Publish'],
          opts: { fuzzy: true, skipInactive: true, returnDebug: true },
        }, 8000, tabId);
        if (r && r.ok) { posted = true; break; }
      } catch { /* retry */ }
    }
    if (!posted) return { ok: false, reason: 'publish_click_failed' };

    // Step 7: 等跳转到「作品管理」(发布成功信号)
    await sleep(4000);
    log('✅ 抖音发布完成(请到作品管理确认)');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'unexpected:' + String(e?.message || e).slice(0, 100) };
  }
}

export const douyinDriver: PublisherDriver = {
  platform: PLATFORM,
  checkLogin,
  upload,
};
