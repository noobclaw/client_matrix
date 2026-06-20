/**
 * bilibili —— B 站创作中心(member.bilibili.com)视频投稿 driver。
 *
 * 投稿 URL: member.bilibili.com/platform/upload/video/frame(也兼容老的 /article/up.html)。
 *
 * 注意:B 站投稿强制要求选「分区」(category)+ 「类型」+ tags(至少 1 个)。这里:
 *   - 分区 / 类型保持平台默认值(用户首次登录时选过,B 站会记忆)
 *   - 标签如果用户没传,从 description 头部抓中文短词凑一个,避免「请添加标签」拦截
 *
 * B 站 editor 是 contentEditable rich textarea,简介(description)的写入走 editor_insert_text。
 */

import { checkPlatformLogin } from '../../scenario/platformLoginDriver';
import type { PublisherDriver, PublisherLoginStatus, PublishInput, PublishResult, PublishCtx } from './types';
import { uploadFileToInput, pubCmd, sleep, waitForSelector, setInputValue } from './publisherUtils';

const PLATFORM = 'bilibili' as const;

async function checkLogin(): Promise<PublisherLoginStatus> {
  try {
    const r = await checkPlatformLogin('bilibili');
    return r.loggedIn ? 'logged_in' : 'not_logged_in';
  } catch { return 'unknown'; }
}

/** 没传 tags 时,从 title/description 抓 1 个中文短词作 fallback,避免 B 站「请添加标签」拦截。 */
function fallbackTag(input: PublishInput): string {
  const src = (input.title || input.description || '').slice(0, 30);
  const m = src.match(/[一-龥a-zA-Z0-9]{2,8}/);
  return m ? m[0] : 'noobclaw';
}

async function upload(input: PublishInput, onLog?: (msg: string) => void, ctx?: PublishCtx): Promise<PublishResult> {
  const log = (m: string) => { try { onLog && onLog(m); } catch { /* ignore */ } };
  const tabId = ctx?.tabId;

  try {
    log('📺 [B 站] 等创作中心投稿页…');
    const ready = await waitForSelector(PLATFORM,
      'input[type="file"][accept*="video"], .bcc-upload input[type="file"], input[type="file"]',
      { timeoutMs: 15000, tabId });
    if (!ready) return { ok: false, reason: 'upload_input_not_found' };

    log('📤 上传视频…');
    const upR = await uploadFileToInput({
      platform: PLATFORM,
      filePath: input.videoPath,
      targetSelector: 'input[type="file"][accept*="video"], .bcc-upload input[type="file"], input[type="file"]',
      mimeType: 'video/mp4',
      tabId,
    });
    if (!upR.ok) return { ok: false, reason: 'video_upload_failed:' + upR.reason };
    log('✓ 视频已上传,等 B 站转码…');

    // 等标题输入框(转码完成)
    const titleSel = '.bcc-input input.input-val, input[placeholder*="标题"], input[placeholder*="请输入稿件标题"]';
    const titleReady = await waitForSelector(PLATFORM, titleSel, { timeoutMs: 8 * 60 * 1000, intervalMs: 3000, tabId });
    if (!titleReady) return { ok: false, reason: 'title_input_not_appearing' };

    // 标题(B 站 80 字符上限)
    if (input.title) {
      log(`✏️ 填标题(${input.title.length} 字符)…`);
      await setInputValue(PLATFORM, titleSel, input.title.slice(0, 80), tabId);
    }

    // 简介(contentEditable rich editor)
    if (input.description) {
      const descSel = '.ql-editor[contenteditable="true"], div[contenteditable="true"][data-v]';
      log(`✏️ 填简介(${input.description.length} 字符)…`);
      try {
        await pubCmd(PLATFORM, 'main_world_click', { selector: descSel }, 5000, tabId);
        await sleep(400);
        await pubCmd(PLATFORM, 'editor_insert_text', {
          selector: descSel, text: input.description.slice(0, 230), // 250 字符上限
        }, 10000, tabId);
      } catch { log('⚠️ 简介填入失败,继续'); }
    }

    // 标签:B 站 12 个上限,每个 < 20 字符
    const tags = (input.tags && input.tags.length ? input.tags : [fallbackTag(input)]).slice(0, 12);
    log(`#️⃣ 添加 ${tags.length} 个标签…`);
    const tagInputSel = '.tag-container input, input[placeholder*="标签"]';
    for (const tag of tags) {
      const clean = tag.replace(/[#\s,，]+/g, '').slice(0, 20);
      if (!clean) continue;
      try {
        await pubCmd(PLATFORM, 'main_world_click', { selector: tagInputSel }, 5000, tabId);
        await sleep(200);
        await setInputValue(PLATFORM, tagInputSel, clean, tabId);
        await sleep(200);
        // 按 Enter 确认添加
        await pubCmd(PLATFORM, 'press_key', { selector: tagInputSel, key: 'Enter' }, 5000, tabId);
        await sleep(300);
      } catch { /* 单 tag 失败继续 */ }
    }

    // 点「立即投稿」
    log('🚀 点 [立即投稿]…');
    let posted = false;
    for (let i = 0; i < 6; i++) {
      if (i > 0) await sleep(1500);
      try {
        const r: any = await pubCmd(PLATFORM, 'click_with_text', {
          containerSel: 'body',
          acceptedTexts: ['立即投稿', '投稿', '发布', 'Publish'],
          opts: { fuzzy: true, skipInactive: true, returnDebug: true },
        }, 8000, tabId);
        if (r && r.ok) { posted = true; break; }
      } catch { /* retry */ }
    }
    if (!posted) return { ok: false, reason: 'publish_click_failed' };

    await sleep(3000);
    log('✅ B 站投稿提交完成(审核通过后可见)');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'unexpected:' + String(e?.message || e).slice(0, 100) };
  }
}

export const bilibiliDriver: PublisherDriver = {
  platform: PLATFORM,
  checkLogin,
  upload,
};
