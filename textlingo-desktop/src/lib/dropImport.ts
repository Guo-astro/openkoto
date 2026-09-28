import { invoke } from "@tauri-apps/api/core";
import type { Article } from "./tauri";

// 各类型可拖入导入的扩展名（与现有导入表单保持一致）
export const BOOK_EXTENSIONS = ["pdf", "epub", "txt"];
export const VIDEO_EXTENSIONS = ["mp4", "mkv", "webm", "mov", "avi"];
export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "wma"];
export const SUBTITLE_EXTENSIONS = ["srt", "lrc"];

const ALL_SUPPORTED = new Set([
  ...BOOK_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...SUBTITLE_EXTENSIONS,
]);

export function getExtension(path: string): string {
  const name = path.split(/[/\\]/).pop() || path;
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

export function getFileName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

export function isSupportedDropPath(path: string): boolean {
  return ALL_SUPPORTED.has(getExtension(path));
}

/**
 * 按扩展名把拖入的文件路由到对应的导入命令，复用现有后端命令。
 * 返回创建/导入的 Article。不支持的扩展名会抛错。
 */
export async function importDroppedPath(path: string): Promise<Article> {
  const ext = getExtension(path);

  if (BOOK_EXTENSIONS.includes(ext)) {
    return invoke<Article>("import_book_cmd", { filePath: path, title: null });
  }
  if (VIDEO_EXTENSIONS.includes(ext) || AUDIO_EXTENSIONS.includes(ext)) {
    // 后端按扩展名自动区分视频/音频
    return invoke<Article>("import_local_video_cmd", { filePath: path });
  }
  if (SUBTITLE_EXTENSIONS.includes(ext)) {
    return invoke<Article>("import_srt_file_cmd", { filePath: path, title: null });
  }

  throw new Error(`unsupported:${getFileName(path)}`);
}
