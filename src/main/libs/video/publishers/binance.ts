/**
 * binance —— 币安广场视频发布 driver(改造自 phaseRunner.publishVideoToBinance)。
 *
 * 流程(6 步,sendBrowserCommand 直接驱动 chrome-extension 内的页面 DOM):
 *   1. 点工具栏视频图标 → 等弹出 modal
 *   2. 把本地 mp4 注入 modal 里的 file input(走 sidecar 本地 HTTP)
 *   3. polling 等「发文」按钮变 active(转码完成的信号)
 *   4. 写正文到 modal 内 ProseMirror
 *   5. 点「发文」按钮
 *   6. 等 modal 关闭(发文成功的信号)
 *
 * 跟 phaseRunner.publishVideoToBinance 的关系:逻辑 1:1 抄过来,但去掉 ctx.report
 * (改 onLog 回调)+ 去掉 ctx.uploadVideoFromDisk(改 publisherUtils.uploadFileToInput)+
 * 去掉 getBridgeOpts(改 publisherUtils.pubCmd/bridgeOptsFor)。phaseRunner 那份不动,scenario
 * 任务还能用。
 */

import { checkPlatformLogin } from '../../scenario/platformLoginDriver';
import type { PublisherDriver, PublisherLoginStatus, PublishInput, PublishResult, PublishCtx } from './types';
import { uploadFileToInput, pubCmd, sleep } from './publisherUtils';

const PLATFORM = 'binance' as const;

async function checkLogin(): Promise<PublisherLoginStatus> {
  try {
    const r = await checkPlatformLogin('binance');
    if (r.loggedIn) return 'logged_in';
    // browser_not_connected / tab_not_reachable → 当未登录处理(让 pipeline 跳过)
    return 'not_logged_in';
  } catch {
    return 'unknown';
  }
}

async function upload(input: PublishInput, onLog?: (msg: string) => void, ctx?: PublishCtx): Promise<PublishResult> {
  const log = (m: string) => { try { onLog && onLog(m); } catch { /* ignore */ } };
  const tabId = ctx?.tabId;
  const content = (input.description || input.title || '').trim();
  if (!content) {
    return { ok: false, reason: 'binance_needs_content' };
  }

  try {
    // Step 1: 点视频图标 → 等 modal
    log('🟡 [币安] 点视频图标 → 等弹出 modal…');
    const videoIconSel = '.icon-box:has(svg path[d^="M8.6 8.883"])';
    try {
      await pubCmd(PLATFORM, 'main_world_click', { selector: videoIconSel }, 8000, tabId);
    } catch (e: any) {
      return { ok: false, reason: 'video_icon_click_failed:' + String(e?.message || e).slice(0, 80) };
    }
    const modalSel = '.short-editor-inner.quote-mode';
    let modalReady = false;
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      try {
        const r: any = await pubCmd(PLATFORM, 'query_selector', { selector: modalSel, limit: 1 }, 5000, tabId);
        const els = (r && r.elements) || (r && r.data && r.data.elements) || [];
        if (els.length > 0) { modalReady = true; break; }
      } catch { /* keep polling */ }
    }
    if (!modalReady) return { ok: false, reason: 'modal_not_appearing' };
    log('✓ modal 出现');

    // Step 2: 上传视频
    const fileInputSel = '.short-editor-inner.quote-mode input[type="file"][accept*="mp4"]';
    log('📤 上传视频文件…');
    const upR = await uploadFileToInput({
      platform: PLATFORM,
      filePath: input.videoPath,
      targetSelector: fileInputSel,
      mimeType: 'video/mp4',
      tabId,
    });
    if (!upR.ok) return { ok: false, reason: 'video_upload_failed:' + upR.reason };
    log('✓ 视频字节已注入 · 等币安处理转码…');

    // Step 3: polling 等「发文」按钮 active
    const publishBtnSel = '.short-editor-inner.quote-mode button';
    const uploadTimeoutMs = 3 * 60 * 1000;
    let publishReady = false;
    const startWait = Date.now();
    let lastBtnTexts = '';
    while (Date.now() - startWait < uploadTimeoutMs) {
      await sleep(1500);
      try {
        const r: any = await pubCmd(PLATFORM, 'query_selector', {
          selector: publishBtnSel, limit: 5, attrs: 'class',
        }, 5000, tabId);
        const els = (r && r.elements) || (r && r.data && r.data.elements) || [];
        const btns = els as Array<{ text?: string; class?: string }>;
        lastBtnTexts = btns.map((b) => `[${b.text || ''}|${(b.class || '').slice(0, 30)}]`).join(' ');
        const ready = btns.find((b) => /^发文$/.test((b.text || '').trim()) && !/inactive/.test(b.class || ''));
        if (ready) { publishReady = true; break; }
      } catch { /* keep polling */ }
      if ((Date.now() - startWait) % 30000 < 1500) {
        log(`⏳ 等视频处理中… ${Math.round((Date.now() - startWait) / 1000)}s`);
      }
    }
    if (!publishReady) {
      return { ok: false, reason: 'publish_btn_never_active:' + lastBtnTexts.slice(0, 150) };
    }
    log('✓ 视频处理完成,发文按钮已激活');

    // Step 4: 写正文(ProseMirror)
    const editorSel = '.short-editor-inner.quote-mode .ProseMirror[contenteditable="true"]';
    log(`✏️ 写入正文(${content.length} 字符)…`);
    try {
      await pubCmd(PLATFORM, 'main_world_click', { selector: editorSel }, 5000, tabId);
      await sleep(400);
      const ir: any = await pubCmd(PLATFORM, 'editor_insert_text', {
        selector: editorSel, text: content,
      }, 10000, tabId);
      if (!ir || (ir.ok === false && ir.error)) {
        return { ok: false, reason: 'editor_insert_failed:' + (ir?.error || 'unknown') };
      }
    } catch (e: any) {
      return { ok: false, reason: 'editor_failed:' + String(e?.message || e).slice(0, 80) };
    }

    // Step 5: 点「发文」按钮(retry 6 次)
    log('🚀 点击 [发文]…');
    let published = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) await sleep(1500);
      try {
        const r: any = await pubCmd(PLATFORM, 'click_with_text', {
          containerSel: modalSel,
          acceptedTexts: ['发文', '发布', 'Post', 'Publish'],
          opts: { fuzzy: true, skipInactive: true, returnDebug: true },
        }, 8000, tabId);
        if (r && r.ok) { published = true; break; }
        if (r && r.error && !/inactive/i.test(String(r.error))) break;
      } catch { /* retry */ }
    }
    if (!published) return { ok: false, reason: 'publish_click_failed' };

    // Step 6: 等 modal 关闭(发文成功信号)
    let modalClosed = false;
    const closeWait = Date.now();
    while (Date.now() - closeWait < 15000) {
      await sleep(800);
      try {
        const r: any = await pubCmd(PLATFORM, 'query_selector', { selector: modalSel, limit: 1 }, 5000, tabId);
        const els = (r && r.elements) || (r && r.data && r.data.elements) || [];
        if (els.length === 0) { modalClosed = true; break; }
      } catch { /* keep polling */ }
    }
    if (modalClosed) log('✅ 币安广场发布完成');
    else log('⚠️ 已点发文,但 modal 未及时关闭(可能仍在后台提交)');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'unexpected:' + String(e?.message || e).slice(0, 100) };
  }
}

export const binanceDriver: PublisherDriver = {
  platform: PLATFORM,
  checkLogin,
  upload,
};
