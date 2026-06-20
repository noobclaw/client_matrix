/**
 * shipinhao —— 微信视频号助手 driver。
 *
 * 入口:channels.weixin.qq.com/platform/post/create。视频号扫码登录,所以 checkLogin
 * 走 platformLoginDriver 的 tab pattern(已登录的会话会带 cookie)。
 *
 * 视频号字段:
 *   - 短标题(6-16 字,必填)
 *   - 描述(任意,1000 字符上限)
 *   - 话题(#tag → 触发 dropdown 选词)
 *   - 「发表」按钮
 */

import { checkPlatformLogin } from '../../scenario/platformLoginDriver';
import type { PublisherDriver, PublisherLoginStatus, PublishInput, PublishResult, PublishCtx } from './types';
import { uploadFileToInput, pubCmd, sleep, waitForSelector, setInputValue } from './publisherUtils';

const PLATFORM = 'shipinhao' as const;

async function checkLogin(): Promise<PublisherLoginStatus> {
  try {
    const r = await checkPlatformLogin('shipinhao');
    return r.loggedIn ? 'logged_in' : 'not_logged_in';
  } catch { return 'unknown'; }
}

async function upload(input: PublishInput, onLog?: (msg: string) => void, ctx?: PublishCtx): Promise<PublishResult> {
  const log = (m: string) => { try { onLog && onLog(m); } catch { /* ignore */ } };
  const tabId = ctx?.tabId;

  try {
    log('🟢 [视频号] 等创作助手…');
    const ready = await waitForSelector(PLATFORM,
      'input[type="file"][accept*="video"], .post-create input[type="file"], input[type="file"]',
      { timeoutMs: 15000, tabId });
    if (!ready) return { ok: false, reason: 'upload_input_not_found' };

    log('📤 上传视频…');
    const upR = await uploadFileToInput({
      platform: PLATFORM,
      filePath: input.videoPath,
      targetSelector: 'input[type="file"][accept*="video"], .post-create input[type="file"], input[type="file"]',
      mimeType: 'video/mp4',
      tabId,
    });
    if (!upR.ok) return { ok: false, reason: 'video_upload_failed:' + upR.reason };
    log('✓ 视频已上传,等微信处理…');

    // 等短标题输入框(必填,转码完成信号)
    const titleSel = 'input[placeholder*="标题"], input[placeholder*="短标题"], .short-title-input input';
    const titleReady = await waitForSelector(PLATFORM, titleSel, { timeoutMs: 5 * 60 * 1000, intervalMs: 2000, tabId });
    if (!titleReady) return { ok: false, reason: 'title_input_not_appearing' };

    // 短标题(6-16 字必填)
    const shortTitle = (input.title || input.description || '小视频').slice(0, 16).padEnd(6, ' ').trim();
    log(`✏️ 填短标题:${shortTitle}`);
    await setInputValue(PLATFORM, titleSel, shortTitle, tabId);

    // 描述(contentEditable)
    const descSel = '.input-editor [contenteditable="true"], div[contenteditable="true"][data-placeholder*="描述"]';
    const parts: string[] = [];
    if (input.description) parts.push(input.description.slice(0, 800));
    if (input.tags && input.tags.length) {
      const tagStr = input.tags.slice(0, 5).map((t) => {
        const clean = t.replace(/[#\s,，]+/g, '');
        return clean ? `#${clean}` : '';
      }).filter(Boolean).join(' ');
      if (tagStr) parts.push(tagStr);
    }
    const desc = parts.join('\n\n');
    if (desc) {
      log(`✏️ 填描述(${desc.length} 字符)…`);
      try {
        await pubCmd(PLATFORM, 'main_world_click', { selector: descSel }, 5000, tabId);
        await sleep(400);
        await pubCmd(PLATFORM, 'editor_insert_text', {
          selector: descSel, text: desc,
        }, 10000, tabId);
      } catch { log('⚠️ 描述填入失败,继续'); }
    }

    log('🚀 点 [发表]…');
    let posted = false;
    for (let i = 0; i < 6; i++) {
      if (i > 0) await sleep(1500);
      try {
        const r: any = await pubCmd(PLATFORM, 'click_with_text', {
          containerSel: 'body',
          acceptedTexts: ['发表', '发布', 'Publish'],
          opts: { fuzzy: true, skipInactive: true, returnDebug: true },
        }, 8000, tabId);
        if (r && r.ok) { posted = true; break; }
      } catch { /* retry */ }
    }
    if (!posted) return { ok: false, reason: 'publish_click_failed' };

    await sleep(3000);
    log('✅ 视频号发表完成(请到「发表记录」确认)');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'unexpected:' + String(e?.message || e).slice(0, 100) };
  }
}

export const shipinhaoDriver: PublisherDriver = {
  platform: PLATFORM,
  checkLogin,
  upload,
};
