/**
 * storyboardAnchor — 故事板【视觉锚】生成器(纯 AI 模式,无用户参考图时用)。
 *
 * 痛点:纯 AI 模式下,pipeline 把 character 字段写成 `"${persona} · ${track}"`
 * 这种两词拼接(如「日常分享博主 · 咖啡探店」),Seedream 拿到这种泛指 prompt
 * 必然出默认套路图(亚洲女性看手机/电脑那种)。第 1 帧锚定方向就跑偏,后续每镜
 * 用它作 referenceImage,整片都跟着错。
 *
 * 修法(抄市面 image2 主流做法):LLM 把脚本扩成【5 字段结构化视觉描述】,强制
 * 具体(shot_type / subject / environment / lighting / style)—— 跟 Higgsfield /
 * Invideo 的 6 要素公式 + MoneyPrinterTurbo verbatim prompt 思路一致。强约束 5 字段
 * 让 AI 没法回「亚洲女性看手机」这种模板话(必须填具体场景/光线/胶片质感)。
 *
 * 接口:1 次 DeepSeek chat 调用,~500 token,~$0.001。失败/JSON 解析错 → 返回 null,
 * 上游(pipeline.ts)降级到老 persona+track 逻辑,绝不阻塞出片。
 */

import { getNoobClawAuthToken } from '../claudeSettings';
import type { ContentLang } from './scriptWriter';

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

export interface AnchorInput {
  /** 视频脚本(取前 200-300 字给 AI;长脚本省 token)。 */
  script: string;
  /** 人设(兜底参考,AI 不一定用)。 */
  persona?: string;
  /** 赛道(兜底参考,AI 不一定用)。 */
  track?: string;
  /** 内容语言。zh/ja/ko 时 AI 用对应文化的视觉元素;en/其它 走通用电影感。 */
  lang: ContentLang;
}

export interface AnchorResult {
  /** 拼好的 character 字符串,直接喂给 generateStoryboard 的 character 字段。 */
  character: string;
  /** 5 字段原始数据(给详情页诊断用,选填)。 */
  fields: {
    shot_type: string;
    subject: string;
    environment: string;
    lighting: string;
    style: string;
  };
  /** AI 实扣积分(含 cache 折扣)。计入「本次消耗」。 */
  tokens: number;
  /** USD 成本(从服务端权威 _noobclaw.costUsd 来)。 */
  costUsd: number;
}

const SYSTEM_PROMPT = [
  '# Role: Cinematic Anchor Generator (json)',
  '## Goal',
  'Given a short video script, produce ONE establishing-shot visual prompt that locks the visual identity (character + environment + lighting + style) for the entire video. This prompt will be used as the reference image for ALL subsequent shots — so it must be CONCRETE, not abstract.',
  '',
  '## Output JSON schema (EXACTLY these 5 keys, no more no less):',
  '{ "shot_type": str, "subject": str, "environment": str, "lighting": str, "style": str }',
  '',
  '## Hard rules (violate any → fail):',
  '1. EVERY field 8–28 词 / 字。CONCRETE not abstract — describe what is IN the frame, not the meta.',
  '2. FORBIDDEN words(出现即失败):"博主"/"主播"/"vlogger"/"camera"/"镜头"/"拍摄"/"shooting"/"video"/"film maker"。只描述画面内容,不描述拍摄行为或角色身份标签。',
  '3. shot_type 必须从 { "wide establishing shot", "medium close-up", "over-the-shoulder", "low-angle hero shot", "dutch tilt" } 五选一。',
  '4. subject 必须给具体外观锚点(年龄段 + 服饰材质/颜色 + 当下动作 + 手持物);不能只写"a young woman"或"博主"这种泛指。',
  '5. environment 必须给地理/室内细节 + 时段(早晨/午后/黄昏/夜晚);不能只写"a café"或"街道"。',
  '6. lighting 必须给光源方向 + 色温(如 "warm amber side-light through gauze curtain")。',
  '7. style 必须给胶片/数字 + 风格关键词(如 "35mm kodak portra 400, shallow DOF, slight film grain")。',
  '8. 内容语言:script 是中文 → 字段用中文(可夹少量英文术语如 "DOF");script 是英/日/韩 → 字段用该语言。',
  '9. JSON only。NO markdown 围栏,NO 解释,NO emoji。',
  '',
  '## Bad example (套路化,会 reject):',
  '{ "subject": "A young Asian woman holding a phone in a café" }',
  '',
  '## Good example:',
  '{',
  '  "shot_type": "medium close-up",',
  '  "subject": "一名 25 岁亚洲女性,身穿米白色 oversized 针织衫,双手捧一杯手绘陶瓷拉花拿铁,目光朝向窗外",',
  '  "environment": "东京涩谷一家木质装潢小众咖啡馆,黑胶唱片整齐立在背景墙,午后,玻璃窗外是雾蒙的街道",',
  '  "lighting": "暖琥珀色侧光透过纱帘进入,头发上有柔和轮廓光,整体偏低对比度",',
  '  "style": "35mm 胶片质感,浅景深,Kodak Portra 400 色调,微颗粒,电影感"',
  '}',
].join('\n');

/** 从夹带文字/围栏的输出里抠出第一个 JSON 对象(跟 templateHtmlWriter 同款宽松解析)。 */
function extractJsonObject(raw: string): string {
  let t = (raw || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  const start = t.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return t.slice(start, i + 1); }
      }
    }
  }
  return t;
}

/** 5 字段做基本清洗 + 长度兜底,任一字段缺/空就判失败。 */
function cleanFields(raw: any): AnchorResult['fields'] | null {
  if (!raw || typeof raw !== 'object') return null;
  const pick = (k: string): string => {
    const v = raw[k];
    if (typeof v !== 'string') return '';
    const t = v.trim();
    if (!t) return '';
    return t.slice(0, 240);
  };
  const shot_type = pick('shot_type');
  const subject = pick('subject');
  const environment = pick('environment');
  const lighting = pick('lighting');
  const style = pick('style');
  if (!shot_type || !subject || !environment || !lighting || !style) return null;
  return { shot_type, subject, environment, lighting, style };
}

/**
 * 调 DeepSeek 出 5 字段 JSON,拼成 character 字符串。
 *
 * 失败路径(任一命中 → 返回 null,上游降级):
 *   · 未登录 / token 无效
 *   · API 网络/HTTP 错
 *   · 返回的不是合法 JSON / 字段不齐
 *   · 任何抛错(包括 AI 编造模板话被 prompt 拒)
 *
 * 绝不抛错出去(出片绝不能阻塞)。AI_AUTH_FAILED / CREDITS_INSUFFICIENT 这种需要
 * 用户感知的错由上游 generateScript 那次调用先暴露过了,本函数静默退化即可。
 */
export async function generateStoryboardAnchor(input: AnchorInput): Promise<AnchorResult | null> {
  const token = getNoobClawAuthToken();
  if (!token) return null;

  const userParts: string[] = [];
  userParts.push(`# script (前 300 字):`);
  userParts.push((input.script || '').slice(0, 300));
  if (input.persona) userParts.push(`\n# persona_hint(可参考,但不要直接出现在字段里): ${input.persona}`);
  if (input.track) userParts.push(`# track_hint(可参考,但不要直接出现在字段里): ${input.track}`);
  userParts.push(`\n输出 5 字段 JSON,严格按 schema。`);
  const user = userParts.join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const resp = await fetch(`${apiBase()}/api/ai/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: 'noobclawai-reasoner',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
        stream: false,
        max_tokens: 800,
        // 适度提温,避免每个任务都被锁到同一类视觉(0.9 比默认略高,但还在受控范围)
        temperature: 0.9,
        // 不带 response_format=json_object:reasoner(Pro)不支持该开关(带上会被拒/失效),
        //   JSON 契约靠 prompt(「输出 5 字段 JSON,严格按 schema」)+ extractJsonObject 宽松解析兜底。
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const json: any = await resp.json();
    const content = json?.choices?.[0]?.message?.content || '';
    if (!content) return null;
    let parsed: any;
    try { parsed = JSON.parse(extractJsonObject(content)); }
    catch { return null; }
    const fields = cleanFields(parsed);
    if (!fields) return null;

    // 计费(同 scriptWriter 口径)
    const costUsd = Number(json?._noobclaw?.costUsd) || 0;
    const price = Number(json?._noobclaw?.priceUsdPerMillion) || 0;
    let tokens = Number(json?._noobclaw?.billableTokens) || 0;
    if (!tokens && costUsd > 0 && price > 0) tokens = Math.round((costUsd / price) * 1_000_000);

    // 5 字段拼成单行 character 字符串(用逗号 + 空格分隔,Seedream 端按词组解析得很好)。
    // 顺序 = shot_type → subject → environment → lighting → style,从「这是个什么镜头」
    // 推到「画面里有什么」再到「光怎么打」再到「整体调色风格」—— 这跟 Higgsfield 的 6 要素
    // 顺序一致,业界验证过的金字塔结构。
    const character = [
      fields.shot_type,
      fields.subject,
      fields.environment,
      fields.lighting,
      fields.style,
    ].join(', ');

    return { character, fields, tokens, costUsd };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
