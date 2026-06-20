/**
 * tiktok —— TikTok Studio 视频发布 driver。
 *
 * 上传入口:tiktok.com/tiktokstudio/upload(也兼容老的 /upload)。Studio 改版后
 * caption 输入框是 Slate-like contentEditable(data-contents="true"),写入走
 * editor_insert_text(execCommand insertText)能稳。
 */

import { checkPlatformLogin } from '../../scenario/platformLoginDriver';
import type { PublisherDriver, PublisherLoginStatus, PublishInput, PublishResult, PublishCtx } from './types';
import { uploadFileToInput, pubCmd, sleep, waitForSelector } from './publisherUtils';

const PLATFORM = 'tiktok' as const;

async function checkLogin(): Promise<PublisherLoginStatus> {
  try {
    const r = await checkPlatformLogin('tiktok');
    return r.loggedIn ? 'logged_in' : 'not_logged_in';
  } catch { return 'unknown'; }
}

async function upload(input: PublishInput, onLog?: (msg: string) => void, ctx?: PublishCtx): Promise<PublishResult> {
  const log = (m: string) => { try { onLog && onLog(m); } catch { /* ignore */ } };
  const tabId = ctx?.tabId;

  try {
    log('🎬 [TikTok] 等 Studio 上传页…');
    const inputReady = await waitForSelector(PLATFORM,
      'input[type="file"][accept*="video"], input[type="file"][accept*="mp4"], input[type="file"]',
      { timeoutMs: 15000, tabId });
    if (!inputReady) return { ok: false, reason: 'upload_input_not_found' };

    log('📤 上传视频…');
    const upR = await uploadFileToInput({
      platform: PLATFORM,
      filePath: input.videoPath,
      targetSelector: 'input[type="file"][accept*="video"], input[type="file"][accept*="mp4"], input[type="file"]',
      mimeType: 'video/mp4',
      tabId,
    });
    if (!upR.ok) return { ok: false, reason: 'video_upload_failed:' + upR.reason };
    log('✓ 视频已注入,等 TikTok 处理…');

    // 等 caption 输入框出现(转码完成信号)
    const captionSel = 'div[contenteditable="true"][data-contents="true"], div[contenteditable="true"][role="textbox"]';
    const captionReady = await waitForSelector(PLATFORM, captionSel, { timeoutMs: 5 * 60 * 1000, intervalMs: 2000, tabId });
    if (!captionReady) return { ok: false, reason: 'caption_input_not_appearing' };

    // 写 caption(title + description + tags 拼一起,TikTok 没有独立标题字段)
    const captionParts: string[] = [];
    if (input.title) captionParts.push(input.title.slice(0, 100));
    if (input.description) captionParts.push(input.description.slice(0, 1800)); // 2200 字符上限留 buffer
    if (input.tags && input.tags.length) {
      const tagStr = input.tags.slice(0, 5).map((t) => {
        const clean = t.replace(/[#\s,，]+/g, '');
        return clean ? `#${clean}` : '';
      }).filter(Boolean).join(' ');
      if (tagStr) captionParts.push(tagStr);
    }
    const caption = captionParts.join('\n\n');
    if (caption) {
      log(`✏️ 写 caption(${caption.length} 字符)…`);
      try {
        await pubCmd(PLATFORM, 'main_world_click', { selector: captionSel }, 5000, tabId);
        await sleep(400);
        await pubCmd(PLATFORM, 'editor_insert_text', {
          selector: captionSel, text: caption,
        }, 10000, tabId);
      } catch { log('⚠️ caption 填入失败,继续'); }
    }

    log('🚀 点 [Post]…');
    let posted = false;
    for (let i = 0; i < 6; i++) {
      if (i > 0) await sleep(1500);
      try {
        const r: any = await pubCmd(PLATFORM, 'click_with_text', {
          containerSel: 'body',
          acceptedTexts: ['Post', 'Publish', '发布'],
          opts: { fuzzy: true, skipInactive: true, returnDebug: true },
        }, 8000, tabId);
        if (r && r.ok) { posted = true; break; }
      } catch { /* retry */ }
    }
    if (!posted) return { ok: false, reason: 'publish_click_failed' };

    await sleep(3000);
    log('✅ TikTok 发布完成');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'unexpected:' + String(e?.message || e).slice(0, 100) };
  }
}

export const tiktokDriver: PublisherDriver = {
  platform: PLATFORM,
  checkLogin,
  upload,
};
