/**
 * toutiao —— 头条号(西瓜视频后台)视频发布 driver。
 *
 * 入口:mp.toutiao.com/profile_v4/xigua/upload-video。头条号后台的视频字段:
 *   - 视频标题(必填,30 字符上限)
 *   - 视频简介(可选,长文本)
 *   - 标签(动态加,可多个)
 *   - 「发布」按钮
 */

import { checkPlatformLogin } from '../../scenario/platformLoginDriver';
import type { PublisherDriver, PublisherLoginStatus, PublishInput, PublishResult, PublishCtx } from './types';
import { uploadFileToInput, pubCmd, sleep, waitForSelector, setInputValue } from './publisherUtils';

const PLATFORM = 'toutiao' as const;

async function checkLogin(): Promise<PublisherLoginStatus> {
  try {
    const r = await checkPlatformLogin('toutiao');
    return r.loggedIn ? 'logged_in' : 'not_logged_in';
  } catch { return 'unknown'; }
}

async function upload(input: PublishInput, onLog?: (msg: string) => void, ctx?: PublishCtx): Promise<PublishResult> {
  const log = (m: string) => { try { onLog && onLog(m); } catch { /* ignore */ } };
  const tabId = ctx?.tabId;

  try {
    log('🟠 [头条号] 等创作中心…');
    const ready = await waitForSelector(PLATFORM,
      'input[type="file"][accept*="video"], .byte-upload input[type="file"], input[type="file"]',
      { timeoutMs: 15000, tabId });
    if (!ready) return { ok: false, reason: 'upload_input_not_found' };

    log('📤 上传视频…');
    const upR = await uploadFileToInput({
      platform: PLATFORM,
      filePath: input.videoPath,
      targetSelector: 'input[type="file"][accept*="video"], .byte-upload input[type="file"], input[type="file"]',
      mimeType: 'video/mp4',
      tabId,
    });
    if (!upR.ok) return { ok: false, reason: 'video_upload_failed:' + upR.reason };
    log('✓ 视频已上传,等头条号处理…');

    // 等标题输入框
    const titleSel = '.title-input input, input[placeholder*="标题"], input.byte-input';
    const titleReady = await waitForSelector(PLATFORM, titleSel, { timeoutMs: 5 * 60 * 1000, intervalMs: 2000, tabId });
    if (!titleReady) return { ok: false, reason: 'title_input_not_appearing' };

    // 标题(必填,30 字符上限)
    const title = (input.title || input.description || '小视频').slice(0, 30);
    log(`✏️ 填标题:${title.slice(0, 20)}…`);
    await setInputValue(PLATFORM, titleSel, title, tabId);

    // 简介(rich editor;头条号是 Slate 派生编辑器)
    const descSel = '.editor-content [contenteditable="true"], div[contenteditable="true"][data-slate-editor], .ck-editor__editable';
    if (input.description) {
      log(`✏️ 填简介(${input.description.length} 字符)…`);
      try {
        await pubCmd(PLATFORM, 'main_world_click', { selector: descSel }, 5000, tabId);
        await sleep(400);
        await pubCmd(PLATFORM, 'editor_insert_text', {
          selector: descSel, text: input.description.slice(0, 1000),
        }, 10000, tabId);
      } catch { log('⚠️ 简介填入失败,继续'); }
    }

    // 标签 —— 头条号有独立 tag input,按 Enter 加 chip
    if (input.tags && input.tags.length) {
      const tagInputSel = '.label-input input, input[placeholder*="标签"], input[placeholder*="添加标签"]';
      const tags = input.tags.slice(0, 5);
      log(`#️⃣ 添加 ${tags.length} 个标签…`);
      for (const tag of tags) {
        const clean = tag.replace(/[#\s,，]+/g, '').slice(0, 20);
        if (!clean) continue;
        try {
          await pubCmd(PLATFORM, 'main_world_click', { selector: tagInputSel }, 5000, tabId);
          await sleep(200);
          await setInputValue(PLATFORM, tagInputSel, clean, tabId);
          await sleep(200);
          await pubCmd(PLATFORM, 'press_key',
            { selector: tagInputSel, key: 'Enter' }, 5000, tabId);
          await sleep(300);
        } catch { /* 单 tag 失败继续 */ }
      }
    }

    log('🚀 点 [发布]…');
    let posted = false;
    for (let i = 0; i < 6; i++) {
      if (i > 0) await sleep(1500);
      try {
        const r: any = await pubCmd(PLATFORM, 'click_with_text', {
          containerSel: 'body',
          acceptedTexts: ['发布', '立即发布', '发表', 'Publish'],
          opts: { fuzzy: true, skipInactive: true, returnDebug: true },
        }, 8000, tabId);
        if (r && r.ok) { posted = true; break; }
      } catch { /* retry */ }
    }
    if (!posted) return { ok: false, reason: 'publish_click_failed' };

    await sleep(3000);
    log('✅ 头条号发布完成(审核通过后可见)');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'unexpected:' + String(e?.message || e).slice(0, 100) };
  }
}

export const toutiaoDriver: PublisherDriver = {
  platform: PLATFORM,
  checkLogin,
  upload,
};
