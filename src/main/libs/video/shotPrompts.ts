/**
 * shotPrompts — 一镜两套 prompt:给【图像模型】的首帧描述,给【视频模型】的运动描述。
 *
 * ## 为什么要拆
 * 老链路只有一个 `buildSeedancePrompt()`,它的输出【同时】被喂给两个模型:
 *   · Seedream 出故事板首帧(seedanceProvider.generateStoryboard 的 shots 参数)
 *   · Seedance 出视频片段(SeedanceSceneSpec.prompt)
 * 于是图像模型收到的是 "运镜:镜头缓慢推近(全程只用这一种,平稳不抖)…避免画面抖动、
 * 肢体扭曲、时间闪烁" 这种【视频专属指令】—— 它完全不知道要画什么。而真正该给它的
 * 画面描述反而没传。这是首帧画错的根因,首帧错了 i2v 再稳也只是忠实地让一张错图动起来。
 *
 * ## 方法论来源
 * 抄 OpenMontage 的 seedance skill(`.agents/skills/seedance-2-0/SKILL.md`)里的
 * Higgsfield 方法论 —— 它把「prompt 开头先声明镜头结构」列为【单个最大的质量杠杆】:
 *   1. 开头先声明镜头结构/格式(景别 + 拍摄方式),再写创作内容
 *   2. 用具体摄影术语(35mm / film grain / halation / 浅景深),不用「电影感」这类空词
 *   3. 显式否定你不要的(no 3D / no cartoon / no cuts / no zoom)—— 模型在意图模糊时会乱来
 *   4. 运动描述带时间轴标记(0-3s / 3-6s)
 *   5. i2v 的 prompt 只写运动,不复述首帧已有的画面(否则主体漂移)
 *
 * ## 契约
 * · buildFramePrompt() 的输出【只】给图像模型,绝不含运镜/视频否定项。
 * · buildMotionPrompt() 的输出【只】给视频模型,绝不复述画面内容。
 * 两者共享同一份 styleLock(摄影术语),保证图和视频的调性一致。
 */

import type { StoryShot, ShotType } from './storyboardScript';
import { shotAllowsText } from './storyboardScript';

/** 内容语言 → 人物/实景的本地化区域名。非 zh/ja/ko 返回空(走通用)。 */
const REGION: Record<string, string> = { zh: '中国', ja: '日本', ko: '韩国' };

function regionOf(lang?: string): string {
  return REGION[(lang || '').slice(0, 2).toLowerCase()] || '';
}

/**
 * 全片统一的摄影/画质术语(styleLock)。图和视频都带,保证调性一致。
 * 用具体术语而不是「电影感」——后者对模型是无效 token。
 */
export const DEFAULT_STYLE_LOCK =
  '35mm 胶片质感,浅景深,柔和高光滚降,轻微颗粒,自然肤色,真实材质,构图稳定';

/** type → 首帧的镜头结构声明(prompt 开头第一句,最大的质量杠杆)。 */
function frameOpener(type: ShotType, shotSize?: string): string {
  const size = (shotSize || '').trim();
  switch (type) {
    case 'chart':
      return `信息图表画面,正视角,画面平整清晰,${size || '中景'},数据可视化`;
    case 'textcard':
      return `标题版式画面,正视角,居中构图,${size || '中景'},排版规整`;
    case 'logo':
      return `产品/标识特写,正视角,干净背景,${size || '特写'}`;
    case 'person':
      return `写实人像摄影,${size || '中景'},眼平机位,主体清晰、背景虚化`;
    case 'transition':
      return `抽象过渡画面,${size || '全景'},简洁构图,低信息密度`;
    case 'scene':
    default:
      return `写实实景摄影,${size || '中景'},眼平机位,有前后景层次`;
  }
}

/** 首帧的否定项。带文字的镜(图表/文字卡/Logo)不能禁文字,否则出来是空白板。 */
function frameNegatives(type: ShotType): string {
  const base = '不要 3D 渲染感、不要卡通、不要插画风、不要塑料质感;不要水印、不要 logo 角标';
  return shotAllowsText(type)
    ? `${base};画面里的文字必须清晰、拼写正确、排版工整`
    : `${base};画面里不要出现任何文字或字幕`;
}

export interface FramePromptOptions {
  /** 内容语言,决定人物/实景的本地化。 */
  lang?: string;
  /** 全片统一摄影术语。不传用 DEFAULT_STYLE_LOCK。 */
  styleLock?: string;
  /** 景别(来自分镜表 shot_size,可空)。 */
  shotSize?: string;
  /** 画幅,写进 prompt 帮助模型出对构图。'9:16' | '16:9' | '1:1'。 */
  aspect?: string;
  /** 尾帧模式:描述的是镜头【结束时】的画面。 */
  isLastFrame?: boolean;
}

/**
 * 给【图像模型】的首帧(或尾帧)描述。
 * 只写画面:镜头结构 → 画面内容 → 光线/质感 → 本地化 → 否定项。
 */
export function buildFramePrompt(shot: StoryShot, opts: FramePromptOptions = {}): string {
  const visual = (opts.isLastFrame ? shot.visualLast : shot.visualFirst) || shot.visualFirst || '';
  const parts: string[] = [];

  // 1. 镜头结构声明(开头第一句 —— 最大的质量杠杆)
  parts.push(frameOpener(shot.type, opts.shotSize));
  if (opts.aspect) parts.push(`画幅 ${opts.aspect}`);
  if (opts.isLastFrame) parts.push('这是镜头结束时刻的画面');

  // 2. 画面内容(用户脚本写的,或 AI 设计的)
  if (visual) parts.push(`画面:${visual}`);

  // 3. 图内文字(只有 allowText 的镜才给)
  if (shotAllowsText(shot.type) && shot.onScreenText) {
    parts.push(`画面中的文字内容:「${shot.onScreenText}」`);
  }

  // 4. 摄影/画质术语
  parts.push(opts.styleLock || DEFAULT_STYLE_LOCK);

  // 5. 本地化(有人物或实景时才有意义)
  const region = regionOf(opts.lang);
  if (region && (shot.type === 'person' || shot.type === 'scene')) {
    parts.push(`若出现人物,为亚洲/${region}人面孔与气质;若为街景/室内/商业空间等实景,呈现当代${region}的环境风格;通用物体与自然风景保持中性`);
  }

  // 6. 否定项
  parts.push(frameNegatives(shot.type));

  return parts.join('。') + '。';
}

/** 运镜词表 —— 逐镜轮换,避免全片同一种推近。分镜表给了 motion 时优先用它。 */
const CAM_ROTATION = [
  '镜头极缓慢推近',
  '镜头极缓慢左移',
  '镜头极缓慢上摇',
  '固定机位,只有主体自然轻微动作',
  '镜头极缓慢拉远',
];

export interface MotionPromptOptions {
  /** 第几镜(用于运镜轮换)。 */
  shotIndex?: number;
  /** 该镜时长(秒),用于写时间轴标记。 */
  durationSec?: number;
  /** 是否有首帧参考图(i2v)。有 → 强调不改变画面,只加运动。 */
  hasKeyframe?: boolean;
  /** 是否首尾帧模式(两张参考图)。 */
  hasLastFrame?: boolean;
  /** 全片统一摄影术语(与首帧共享,保证调性一致)。 */
  styleLock?: string;
  /** 内容语言。 */
  lang?: string;
}

/**
 * 给【视频模型】的运动描述。
 * 只写运动:结构声明 → 运镜 → 主体动作 → 时间轴 → 否定项。
 * 有首帧参考图时【绝不复述画面内容】(复述会导致主体漂移 —— Seedance 官方与社区共识)。
 */
export function buildMotionPrompt(shot: StoryShot, opts: MotionPromptOptions = {}): string {
  const parts: string[] = [];
  const dur = Math.max(1, Math.round(opts.durationSec || shot.seconds || 5));

  // 1. 结构声明
  if (opts.hasLastFrame) {
    parts.push('单一连续镜头,无剪切,从首帧画面自然过渡到尾帧画面');
  } else if (opts.hasKeyframe) {
    parts.push('单一连续镜头,无剪切,严格保持参考图的主体、构图、配色与光线不变,只为画面添加自然、轻微的运动');
  } else {
    parts.push('单一连续镜头,无剪切,写实拍摄');
    // 没有首帧图时,视频模型是唯一知道画面的地方 —— 这时才把画面描述带上
    if (shot.visualFirst) parts.push(`画面:${shot.visualFirst}`);
  }

  // 2. 运镜(分镜表的 motion 优先;没有则按镜序轮换,避免全片同一种)
  const cam = shot.motion?.trim() || CAM_ROTATION[(opts.shotIndex ?? 0) % CAM_ROTATION.length];
  parts.push(`运动:${cam}(全程只用这一种运镜,平稳不抖)`);

  // 3. 时间轴标记(Higgsfield 方法论:模型对时间分段有明确响应)
  if (dur >= 6) {
    const mid = Math.round(dur / 2);
    parts.push(`0-${mid}s:运动缓慢起势;${mid}-${dur}s:延续同一方向,速度保持一致,结尾自然收住`);
  } else {
    parts.push(`0-${dur}s:匀速完成这一次运动,不要中途变向`);
  }

  // 4. 质感(与首帧共享,保证调性一致)
  parts.push(opts.styleLock || DEFAULT_STYLE_LOCK);

  // 5. 否定项(视频专属)
  parts.push('不要剪切、不要变焦跳变、不要镜头抖动;不要肢体扭曲或多余手指、不要画面闪烁或时间跳变;不要出现文字、字幕、水印、台标');

  return parts.join('。') + '。';
}

/**
 * 兼容旧链路的单 prompt(没有分镜表时用)。
 * 语义等价于老的 buildSeedancePrompt:把一句口播当画面依据丢给视频模型。
 * 【只在降级路径用】—— 正常链路应该走 buildFramePrompt + buildMotionPrompt。
 */
export function buildLegacyPrompt(
  sentence: string,
  opts: { track?: string; persona?: string; lang?: string; isI2V?: boolean; shotIndex?: number },
): string {
  const region = regionOf(opts.lang);
  const styleBits = [opts.track, opts.persona].filter(Boolean).join('、');
  const cam = CAM_ROTATION[(opts.shotIndex ?? 0) % CAM_ROTATION.length];
  const parts: string[] = [];
  if (opts.isI2V) {
    parts.push('保持参考图的主体、构图与配色不变,只为画面添加自然、轻微的运动');
  } else {
    parts.push(`写实竖屏空镜,画面贴合这句旁白(具体、可拍,有明确主体与单一动作):「${sentence}」`);
  }
  parts.push('环境真实、自然光、有空间层次与景深');
  parts.push(`运动:${cam}(全程只用这一种,平稳不抖)`);
  parts.push(`${DEFAULT_STYLE_LOCK}${styleBits ? `,贴合「${styleBits}」` : ''}`);
  if (region) {
    parts.push(`本地化:若出现人物,为亚洲/${region}人面孔与气质;若为街景/室内/餐厅/商店/交通等实景,呈现当代${region}城市的环境与风格;通用物体、纯自然风景保持中性`);
  }
  parts.push('不要任何文字、字幕、水印、logo;避免画面抖动、肢体扭曲、时间闪烁');
  return parts.join('。') + '。';
}
