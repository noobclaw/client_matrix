/**
 * kuaishou —— 快手创作者服务平台视频发布 driver。
 *
 * 入口:cp.kuaishou.com/article/publish/video。快手把标题 + 描述合并成一个「作品描述」
 * 字段(150 字符),没有独立标题输入框。富文本编辑器是 contentEditable。
 */

import { checkPlatformLogin } from '../../scenario/platformLoginDriver';
import type { PublisherDriver, PublisherLoginStatus, PublishInput, PublishResult, PublishCtx } from './types';
import { uploadFileToInput, pubCmd, sleep, waitForSelector } from './publisherUtils';

const PLATFORM = 'kuaishou' as const;

async function checkLogin(): Promise<PublisherLoginStatus> {
  try {
    const r = await checkPlatformLogin('kuaishou');
    return r.loggedIn ? 'logged_in' : 'not_logged_in';
  } catch { return 'unknown'; }
}

async function upload(input: PublishInput, onLog?: (msg: string) => void, ctx?: PublishCtx): Promise<PublishResult> {
  const log = (m: string) => { try { onLog && onLog(m); } catch { /* ignore */ } };
  const tabId = ctx?.tabId;

  try {
    log('⚡ [快手] 等创作中心…');
    const ready = await waitForSelector(PLATFORM,
      'input[type="file"][accept*="video"], .upload-button input[type="file"], input[type="file"]',
      { timeoutMs: 15000, tabId });
    if (!ready) return { ok: false, reason: 'upload_input_not_found' };

    log('📤 上传视频…');
    const upR = await uploadFileToInput({
      platform: PLATFORM,
      filePath: input.videoPath,
      targetSelector: 'input[type="file"][accept*="video"], .upload-button input[type="file"], input[type="file"]',
      mimeType: 'video/mp4',
      tabId,
    });
    if (!upR.ok) return { ok: false, reason: 'video_upload_failed:' + upR.reason };
    log('✓ 视频已上传,等快手处理…');

    // 等描述输入框出现
    const descSel = '.editor [contenteditable="true"], div[contenteditable="true"][data-placeholder*="描述"], textarea[placeholder*="描述"]';
    const descReady = await waitForSelector(PLATFORM, descSel, { timeoutMs: 5 * 60 * 1000, intervalMs: 2000, tabId });
    if (!descReady) return { ok: false, reason: 'desc_input_not_appearing' };

    // 拼描述(快手:title + description + tags 一起塞描述字段,150 字符上限)
    const parts: string[] = [];
    if (input.title) parts.push(input.title.slice(0, 50));
    if (input.description) parts.push(input.description.slice(0, 80));
    if (input.tags && input.tags.length) {
      const tagStr = input.tags.slice(0, 5).map((t) => {
        const clean = t.replace(/[#\s,，]+/g, '');
        return clean ? `#${clean}` : '';
      }).filter(Boolean).join(' ');
      if (tagStr) parts.push(tagStr);
    }
    const desc = parts.join(' ').slice(0, 145);
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

    log('🚀 点 [发布]…');
    let posted = false;
    for (let i = 0; i < 6; i++) {
      if (i > 0) await sleep(1500);
      try {
        const r: any = await pubCmd(PLATFORM, 'click_with_text', {
          containerSel: 'body',
          acceptedTexts: ['发布', '立即发布', '发表'],
          opts: { fuzzy: true, skipInactive: true, returnDebug: true },
        }, 8000, tabId);
        if (r && r.ok) { posted = true; break; }
      } catch { /* retry */ }
    }
    if (!posted) return { ok: false, reason: 'publish_click_failed' };

    await sleep(3000);
    log('✅ 快手发布完成');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'unexpected:' + String(e?.message || e).slice(0, 100) };
  }
}

export const kuaishouDriver: PublisherDriver = {
  platform: PLATFORM,
  checkLogin,
  upload,
};
