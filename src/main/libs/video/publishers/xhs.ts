/**
 * xhs —— 小红书创作中心视频发布 driver。
 *
 * 注意 vs 现有 scenario/xhsDriver.ts:那个是【图文 multi-image draft】流程,这里是
 * 【视频上传】流程。两条入口在小红书是【两个不同 tab】:
 *   · 图文:creator.xiaohongshu.com/publish 默认 tab
 *   · 视频:同 URL,但需要先点「上传视频」tab 切换
 *
 * memory project_xhs_comment_input_contenteditable.md:小红书富文本(评论框 / 描述区)
 * #content-textarea 名为 textarea 实为 contentEditable,fill/setNativeValue 是空操作,
 * 写入只能走 execCommand insertText —— 我们的 editor_insert_text 就是这条路径。
 *
 * 流程:
 *   1. 等创作中心页加载
 *   2. 切到「上传视频」tab(如果默认是图文)
 *   3. 上传视频文件
 *   4. 等转码完成(标题输入框出现)
 *   5. 填标题(.title-input input)
 *   6. 填描述 + tag(contentEditable,走 editor_insert_text)
 *   7. 点 [发布]
 */

import { checkPlatformLogin } from '../../scenario/platformLoginDriver';
import type { PublisherDriver, PublisherLoginStatus, PublishInput, PublishResult, PublishCtx } from './types';
import { uploadFileToInput, pubCmd, sleep, waitForSelector } from './publisherUtils';

const PLATFORM = 'xhs' as const;

async function checkLogin(): Promise<PublisherLoginStatus> {
  try {
    const r = await checkPlatformLogin('xhs');
    return r.loggedIn ? 'logged_in' : 'not_logged_in';
  } catch { return 'unknown'; }
}

async function upload(input: PublishInput, onLog?: (msg: string) => void, ctx?: PublishCtx): Promise<PublishResult> {
  const log = (m: string) => { try { onLog && onLog(m); } catch { /* ignore */ } };
  const tabId = ctx?.tabId;

  try {
    // Step 1: 等创作中心
    log('📕 [小红书] 等创作中心…');
    const pageReady = await waitForSelector(PLATFORM,
      '.creator-tab, .creator-aside, .header-creator, input[type="file"]',
      { timeoutMs: 15000, tabId });
    if (!pageReady) return { ok: false, reason: 'creator_page_not_ready' };

    // Step 2: 切到「上传视频」tab(可能默认是图文)。失败不阻塞 —— 也许默认就是视频 tab。
    log('🎬 切到「上传视频」tab…');
    try {
      await pubCmd(PLATFORM, 'click_with_text', {
        containerSel: '.creator-tab, .header-tabs, body',
        acceptedTexts: ['上传视频', '视频', 'Video'],
        opts: { fuzzy: true, skipInactive: true },
      }, 6000, tabId);
      await sleep(800);
    } catch { /* 也许已经在视频 tab */ }

    // Step 3: 上传视频
    log('📤 上传视频…');
    const fileInputSel = 'input[type="file"][accept*="video"], input[type="file"][accept*="mp4"], input[type="file"]';
    const upR = await uploadFileToInput({
      platform: PLATFORM,
      filePath: input.videoPath,
      targetSelector: fileInputSel,
      mimeType: 'video/mp4',
      tabId,
    });
    if (!upR.ok) return { ok: false, reason: 'video_upload_failed:' + upR.reason };
    log('✓ 视频已注入,等小红书解析…');

    // Step 4: 等标题输入框出现(转码完成信号)
    const titleSel = '.title-input input, input[placeholder*="标题"], input[placeholder*="填写标题"]';
    const titleReady = await waitForSelector(PLATFORM, titleSel, { timeoutMs: 5 * 60 * 1000, intervalMs: 2000, tabId });
    if (!titleReady) return { ok: false, reason: 'title_input_not_appearing' };
    log('✓ 解析完成,准备填表');

    // Step 5: 填标题
    if (input.title) {
      log(`✏️ 填标题(${input.title.length} 字符)…`);
      try {
        await pubCmd(PLATFORM, 'set_input_value', {
          selector: titleSel, value: input.title.slice(0, 20), // 小红书标题 20 字符上限
        }, 5000, tabId);
      } catch { log('⚠️ 标题填入失败,继续'); }
    }

    // Step 6: 填描述(contentEditable,memory:必须走 execCommand insertText = editor_insert_text)
    const editorSel = '.content-input [contenteditable="true"], #content-textarea, [contenteditable="true"][role="textbox"]';
    const descParts: string[] = [];
    if (input.description) descParts.push(input.description.slice(0, 800)); // 小红书正文 1000 字符,留 buffer
    if (input.tags && input.tags.length) {
      const tagStr = input.tags.slice(0, 8).map((t) => {
        const clean = t.replace(/[#\s,，]+/g, '');
        return clean ? `#${clean}` : '';
      }).filter(Boolean).join(' ');
      if (tagStr) descParts.push(tagStr);
    }
    const desc = descParts.join('\n\n');
    if (desc) {
      log(`✏️ 填描述(${desc.length} 字符)…`);
      try {
        await pubCmd(PLATFORM, 'main_world_click', { selector: editorSel }, 5000, tabId);
        await sleep(400);
        await pubCmd(PLATFORM, 'editor_insert_text', {
          selector: editorSel, text: desc,
        }, 10000, tabId);
      } catch { log('⚠️ 描述填入失败,继续'); }
    }

    // Step 7: 点「发布」(小红书是 [发布笔记] / [发布] / [Publish])
    log('🚀 点 [发布]…');
    let posted = false;
    for (let i = 0; i < 6; i++) {
      if (i > 0) await sleep(1500);
      try {
        const r: any = await pubCmd(PLATFORM, 'click_with_text', {
          containerSel: 'body',
          acceptedTexts: ['发布', '发布笔记', 'Publish'],
          opts: { fuzzy: true, skipInactive: true, returnDebug: true },
        }, 8000, tabId);
        if (r && r.ok) { posted = true; break; }
      } catch { /* retry */ }
    }
    if (!posted) return { ok: false, reason: 'publish_click_failed' };

    await sleep(3000);
    log('✅ 小红书发布完成');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'unexpected:' + String(e?.message || e).slice(0, 100) };
  }
}

export const xhsDriver: PublisherDriver = {
  platform: PLATFORM,
  checkLogin,
  upload,
};
