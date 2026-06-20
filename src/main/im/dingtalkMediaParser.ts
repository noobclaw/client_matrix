/**
 * DingTalk Media Marker Parser
 * Parses media markers in text
 */
import type { MediaMarker } from './types';

// File extension categories
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'amr', 'm4a', 'aac'];
const VIDEO_EXTENSIONS = ['mp4', 'mov'];
// Document/file extensions (not media types, but need to be sent as files)
const FILE_EXTENSIONS = [
  'txt', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip', 'rar', '7z', 'tar', 'gz',
  'json', 'xml', 'csv', 'md', 'html', 'htm',
  'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'sh',
];

// Regex patterns
// Markdown image: ![alt](path) - matches local paths
// Supports: file:/// protocol, common system paths, and user directory paths like ~/.noobclaw
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(((?:file:\/\/\/|\/(?:tmp|var|private|Users|home|root)|~\/|[A-Za-z]:)[^)]+)\)/g;

// Markdown link: [text](path) - matches local media file paths
// Used to identify audio/video files in regular links
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(((?:file:\/\/\/|\/(?:tmp|var|private|Users|home|root)|~\/|[A-Za-z]:)[^)]+)\)/g;

// Bare path image: /path/to/image.png
const BARE_IMAGE_PATH_RE = /(?:^|\s)((?:\/(?:tmp|var|private|Users|home|root)\/[^\s`'",)]+|~\/[^\s`'",)]+|[A-Za-z]:[\\/][^\s`'",)]+)\.(?:png|jpg|jpeg|gif|bmp|webp))(?:\s|$|[,.])/gi;

// Bare path audio/video: /path/to/audio.mp3 or /path/to/video.mp4
const BARE_MEDIA_PATH_RE = /(?:^|\s)((?:\/(?:tmp|var|private|Users|home|root)\/[^\s`'",)]+|~\/[^\s`'",)]+|[A-Za-z]:[\\/][^\s`'",)]+)\.(?:mp3|wav|ogg|amr|m4a|aac|mp4|mov))(?:\s|$|[,.])/gi;

// Bare path file: /path/to/file.txt, /path/to/file.pdf etc.
const BARE_FILE_PATH_RE = /(?:^|\s)((?:\/(?:tmp|var|private|Users|home|root)\/[^\s`'",)]+|~\/[^\s`'",)]+|[A-Za-z]:[\\/][^\s`'",)]+)\.(?:txt|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z|tar|gz|json|xml|csv|md|html|htm|js|ts|py|java|c|cpp|h|cs|go|rs|rb|php|sh))(?:\s|$|[,.])/gi;

// Video marker: [DINGTALK_VIDEO]{"path":"..."}[/DINGTALK_VIDEO]
const VIDEO_MARKER_RE = /\[DINGTALK_VIDEO\](\{[\s\S]*?\})\[\/DINGTALK_VIDEO\]/g;

// Audio marker: [DINGTALK_AUDIO]{"path":"..."}[/DINGTALK_AUDIO]
const AUDIO_MARKER_RE = /\[DINGTALK_AUDIO\](\{[\s\S]*?\})\[\/DINGTALK_AUDIO\]/g;

// File marker: [DINGTALK_FILE]{"path":"...","name":"..."}[/DINGTALK_FILE]
const FILE_MARKER_RE = /\[DINGTALK_FILE\](\{[\s\S]*?\})\[\/DINGTALK_FILE\]/g;

/**
 * Determine media type by file extension
 */
function getMediaTypeByExtension(filePath: string): 'image' | 'audio' | 'video' | 'file' | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (FILE_EXTENSIONS.includes(ext)) return 'file';
  return null;
}

/**
 * Clean path (remove file:// protocol, handle escaped spaces)
 */
function cleanPath(rawPath: string): string {
  let path = rawPath.replace(/\\ /g, ' ');
  if (path.startsWith('file:///')) {
    path = decodeURIComponent(path.replace('file://', ''));
  }
  return path;
}

/**
 * Parse all media markers in text
 */
export function parseMediaMarkers(text: string): MediaMarker[] {
  const markers: MediaMarker[] = [];
  const processedPaths = new Set<string>();

  console.log(`[DingTalk MediaParser] 开始解析媒体标记, 文本长度: ${text.length}`);

  // 1. Parse Markdown images ![alt](path)
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    const [fullMatch, altText, rawPath] = match;
    const path = cleanPath(rawPath);
    // Use alt text as file name (if available), otherwise extract from path
    const name = altText?.trim() || undefined;
    console.log(`[DingTalk MediaParser] 发现 Markdown 图片:`, JSON.stringify({ rawPath, cleanedPath: path, name, fullMatch }));
    if (!processedPaths.has(path)) {
      processedPaths.add(path);
      markers.push({
        type: 'image',
        path,
        name,
        originalMarker: fullMatch,
      });
    }
  }

  // 2. Parse media files in regular Markdown links [text](path)
  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    const [fullMatch, linkText, rawPath] = match;
    const path = cleanPath(rawPath);
    const mediaType = getMediaTypeByExtension(path);
    // Use link text as file name (if available)
    const name = linkText?.trim() || undefined;
    console.log(`[DingTalk MediaParser] 发现 Markdown 链接:`, JSON.stringify({ rawPath, cleanedPath: path, mediaType, name, fullMatch }));
    if (mediaType && !processedPaths.has(path)) {
      processedPaths.add(path);
      markers.push({
        type: mediaType,
        path,
        name,
        originalMarker: fullMatch,
      });
    }
  }

  // 3. Parse bare image paths
  for (const match of text.matchAll(BARE_IMAGE_PATH_RE)) {
    const [fullMatch, rawPath] = match;
    const path = cleanPath(rawPath.trim());
    console.log(`[DingTalk MediaParser] 发现裸图片路径:`, JSON.stringify({ rawPath, cleanedPath: path, fullMatch: fullMatch.trim() }));
    if (!processedPaths.has(path)) {
      processedPaths.add(path);
      markers.push({
        type: 'image',
        path,
        originalMarker: fullMatch.trim(),
      });
    }
  }

  // 4. Parse bare audio/video paths
  for (const match of text.matchAll(BARE_MEDIA_PATH_RE)) {
    const [fullMatch, rawPath] = match;
    const path = cleanPath(rawPath.trim());
    const mediaType = getMediaTypeByExtension(path);
    console.log(`[DingTalk MediaParser] 发现裸音视频路径:`, JSON.stringify({ rawPath, cleanedPath: path, mediaType, fullMatch: fullMatch.trim() }));
    if (mediaType && !processedPaths.has(path)) {
      processedPaths.add(path);
      markers.push({
        type: mediaType,
        path,
        originalMarker: fullMatch.trim(),
      });
    }
  }

  // 5. Parse bare file paths (txt, pdf, doc, etc.)
  for (const match of text.matchAll(BARE_FILE_PATH_RE)) {
    const [fullMatch, rawPath] = match;
    const path = cleanPath(rawPath.trim());
    console.log(`[DingTalk MediaParser] 发现裸文件路径:`, JSON.stringify({ rawPath, cleanedPath: path, fullMatch: fullMatch.trim() }));
    if (!processedPaths.has(path)) {
      processedPaths.add(path);
      markers.push({
        type: 'file',
        path,
        originalMarker: fullMatch.trim(),
      });
    }
  }

  // 6. Parse video markers [DINGTALK_VIDEO]
  for (const match of text.matchAll(VIDEO_MARKER_RE)) {
    try {
      const info = JSON.parse(match[1]);
      console.log(`[DingTalk MediaParser] 发现视频标记:`, JSON.stringify({ info, fullMatch: match[0] }));
      if (info.path && !processedPaths.has(info.path)) {
        processedPaths.add(info.path);
        markers.push({
          type: 'video',
          path: info.path,
          name: info.title || info.name,
          originalMarker: match[0],
        });
      }
    } catch (e) {
      console.warn(`[DingTalk MediaParser] 解析视频标记失败:`, match[0], e);
    }
  }

  // 7. Parse audio markers [DINGTALK_AUDIO]
  for (const match of text.matchAll(AUDIO_MARKER_RE)) {
    try {
      const info = JSON.parse(match[1]);
      console.log(`[DingTalk MediaParser] 发现音频标记:`, JSON.stringify({ info, fullMatch: match[0] }));
      if (info.path && !processedPaths.has(info.path)) {
        processedPaths.add(info.path);
        markers.push({
          type: 'audio',
          path: info.path,
          originalMarker: match[0],
        });
      }
    } catch (e) {
      console.warn(`[DingTalk MediaParser] 解析音频标记失败:`, match[0], e);
    }
  }

  // 8. Parse file markers [DINGTALK_FILE]
  for (const match of text.matchAll(FILE_MARKER_RE)) {
    try {
      const info = JSON.parse(match[1]);
      console.log(`[DingTalk MediaParser] 发现文件标记:`, JSON.stringify({ info, fullMatch: match[0] }));
      if (info.path && !processedPaths.has(info.path)) {
        processedPaths.add(info.path);
        markers.push({
          type: 'file',
          path: info.path,
          name: info.name || info.fileName,
          originalMarker: match[0],
        });
      }
    } catch (e) {
      console.warn(`[DingTalk MediaParser] 解析文件标记失败:`, match[0], e);
    }
  }

  console.log(`[DingTalk MediaParser] 解析完成, 共发现 ${markers.length} 个媒体标记:`, JSON.stringify(markers, null, 2));

  return markers;
}

/**
 * Remove processed media markers from text
 */
export function stripMediaMarkers(text: string, markers: MediaMarker[]): string {
  let result = text;
  for (const marker of markers) {
    result = result.replace(marker.originalMarker, '');
  }
  // Clean up extra blank lines
  return result.replace(/\n{3,}/g, '\n\n').trim();
}
