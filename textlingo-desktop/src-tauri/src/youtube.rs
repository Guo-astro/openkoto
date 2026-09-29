use crate::types::{Article, ArticleSegment};
use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use uuid::Uuid;

const VIDEOS_DIR: &str = "videos";

#[derive(Debug, Serialize, Deserialize)]
struct YtDlpOutput {
    id: String,
    title: String,
    #[serde(default)]
    ext: String,
}

/// Import a YouTube video: download, extract subs, create Article
/// 字幕下载是可选的，如果失败会继续导入视频（后续可用 TTS 识别）
/// Bilibili serves separate DASH audio/video streams, so it needs FFmpeg to merge them
/// (YouTube's pre-merged formats 22/18 don't exist there).
pub fn is_bilibili_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("bilibili.com/") || lower.contains("b23.tv/")
}

/// Bundled FFmpeg sidecar next to the app executable, for yt-dlp's `--ffmpeg-location`.
fn sidecar_ffmpeg_path() -> Option<std::path::PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let candidate = dir.join(name);
    candidate.exists().then_some(candidate)
}

/// yt-dlp arguments for a site; everything except the URL and output template.
pub fn yt_dlp_site_args(url: &str, ffmpeg: Option<&Path>) -> Vec<String> {
    let mut args: Vec<String> = vec!["--no-warnings".into(), "--ignore-errors".into(), "--write-auto-sub".into(), "--write-sub".into()];
    if is_bilibili_url(url) {
        args.extend([
            "--sub-lang".into(),
            "zh-Hans,zh-CN,zh,ai-zh,en".into(),
            "--convert-subs".into(),
            "srt".into(),
            // Prefer H.264 so the merged MP4 plays in the system webview.
            "-f".into(),
            "bv*[vcodec^=avc1]+ba/bv*+ba/b".into(),
            "--merge-output-format".into(),
            "mp4".into(),
        ]);
        if let Some(path) = ffmpeg {
            args.push("--ffmpeg-location".into());
            args.push(path.to_string_lossy().into_owned());
        }
    } else {
        args.extend([
            "--sub-lang".into(),
            "en,zh-Hans,zh-Hant".into(),
            "--convert-subs".into(),
            "srt".into(),
            "-f".into(),
            "22/18/best[ext=mp4][vcodec^=avc1]/best[ext=mp4]".into(),
            "--remux-video".into(),
            "mp4".into(),
        ]);
    }
    args
}

pub async fn import_youtube_video(app: AppHandle, url: String) -> Result<Article, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let videos_dir = app_data_dir.join(VIDEOS_DIR);
    if !videos_dir.exists() {
        fs::create_dir_all(&videos_dir)
            .map_err(|e| format!("Failed to create videos dir: {}", e))?;
    }

    // 1. Run yt-dlp to download video and subs
    // Output template: videos_dir/%(id)s.%(ext)s
    let output_template = videos_dir.join("%(id)s.%(ext)s");
    let output_template_str = output_template.to_str().ok_or("Invalid output path")?;

    let shell = app.shell();

    // 使用 --ignore-errors 让字幕下载失败时继续
    // 使用 --no-warnings 减少警告输出
    // 格式选择器说明:
    // - best[ext=mp4]: 优先选择已合并的 MP4（无需 FFmpeg）
    // - bestvideo+bestaudio: 如果没有合并格式，下载最佳并尝试合并
    // - best: 最后的回退选项
    // YouTube: 22/18 are pre-merged H.264 MP4s (no FFmpeg needed); see yt_dlp_site_args.
    let ffmpeg = sidecar_ffmpeg_path();
    let mut args = yt_dlp_site_args(&url, ffmpeg.as_deref());
    args.extend([
        "-o".to_string(),
        output_template_str.to_string(),
        "--print-json".to_string(),
        "--no-simulate".to_string(),
        url.clone(),
    ]);
    let output = shell
        .sidecar("yt-dlp")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Failed to execute yt-dlp: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // 检查是否有 JSON 输出（视频下载成功的标志）
    let json_line = stdout.lines().filter(|l| l.starts_with('{')).last();

    // 如果没有 JSON 输出，说明视频下载完全失败
    let json_line = match json_line {
        Some(line) => line,
        None => {
            // 检查 stderr 中是否有更具体的错误信息
            if is_bilibili_url(&url) && stderr.contains("412") {
                return Err("B 站暂时拒绝了请求（HTTP 412 风控）。请稍后重试，或更新到最新版 OpenKoto（内置更新的 yt-dlp）。".to_string());
            } else if stderr.contains("Video unavailable") {
                return Err("视频不可用，可能是私有视频或已被删除".to_string());
            } else if stderr.contains("Sign in") {
                return Err("此视频需要登录才能观看".to_string());
            } else if stderr.contains("ffmpeg") || stderr.contains("FFmpeg") {
                return Err("需要安装 FFmpeg 才能下载此视频。请安装后重试。".to_string());
            } else if !output.status.success() {
                return Err(format!("视频下载失败: {}", stderr));
            } else {
                return Err("无法获取视频信息".to_string());
            }
        }
    };

    let metadata: YtDlpOutput =
        serde_json::from_str(json_line).map_err(|e| format!("Failed to parse metadata: {}", e))?;

    let video_id = metadata.id;
    let video_title = metadata.title;

    // 查找实际下载的视频文件（可能是 .mp4, .webm 等）
    let video_path = find_video_file(&videos_dir, &video_id)?;

    // 验证视频格式是否能在 Mac/Win 平台播放
    verify_video_format(&video_path)?;

    // 2. 查找字幕文件（可选，失败不报错）
    // yt-dlp pattern: {id}.{lang}.srt
    let segments = match find_srt_file(&videos_dir, &video_id) {
        Ok(srt_path) => {
            // 字幕文件存在，解析它
            match parse_srt(&srt_path) {
                Ok(mut segs) => {
                    for segment in &mut segs {
                        segment.article_id = video_id.clone();
                    }
                    segs
                }
                Err(_) => {
                    // 字幕解析失败，返回空列表
                    Vec::new()
                }
            }
        }
        Err(_) => {
            // 没有找到字幕文件，返回空列表（后续可用 TTS 识别）
            Vec::new()
        }
    };

    // 3. 构建内容文本
    let content = if segments.is_empty() {
        // 没有字幕时，使用占位文本
        format!("[视频已导入，字幕待识别] {}", video_title)
    } else {
        segments
            .iter()
            .map(|s| s.text.clone())
            .collect::<Vec<_>>()
            .join(" ")
    };

    // 4. Create Article
    let article = Article {
        id: video_id.clone(),
        title: video_title,
        content,
        source_type: Some("youtube".to_string()),
        source_url: Some(url),
        media_path: Some(video_path.to_string_lossy().into_owned()),
        book_path: None,
        book_type: None,
        created_at: Utc::now().to_rfc3339(),
        translated: false,
        active_mind_map_artifact_id: None,
        segments,
    };

    Ok(article)
}

/// 验证视频格式是否能在 Mac/Win 平台播放
/// 检查文件是否为有效的 MP4 容器（而非 MPEG-TS 等不兼容格式）
fn verify_video_format(path: &Path) -> Result<(), String> {
    use std::io::Read;

    let mut file = fs::File::open(path).map_err(|e| format!("无法打开视频文件验证: {}", e))?;

    // 读取文件前 12 字节
    let mut header = [0u8; 12];
    file.read_exact(&mut header)
        .map_err(|e| format!("无法读取视频文件头: {}", e))?;

    // MP4 文件格式检查：
    // MP4 文件以 ftyp atom 开头，格式为：
    // [4字节大小][4字节 'ftyp'][4字节品牌标识]
    // 品牌标识常见值：isom, iso2, mp41, mp42, avc1, M4V, qt 等

    let ftyp_marker = &header[4..8];

    if ftyp_marker == b"ftyp" {
        // 有效的 MP4/M4V/MOV 容器
        let brand = String::from_utf8_lossy(&header[8..12]);
        println!("[VideoVerify] 有效的 MP4 容器，品牌: {}", brand);
        return Ok(());
    }

    // 检查 WebM 格式 (EBML 头)
    if header[0..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        println!("[VideoVerify] WebM 格式");
        return Ok(());
    }

    // 检查是否为 MPEG-TS（不兼容格式）
    // MPEG-TS 以 0x47 同步字节开头
    if header[0] == 0x47 {
        // 删除无效文件
        let _ = fs::remove_file(path);
        return Err(
            "视频格式不兼容：下载的是 MPEG-TS 格式，无法在 Mac/Win 播放。\n\
             请尝试重新导入，系统将自动选择兼容格式。"
                .to_string(),
        );
    }

    // 其他未知格式 - 给出警告但不阻止
    println!(
        "[VideoVerify] 未知视频格式，可能无法播放: {:?}",
        &header[0..8]
    );
    Ok(())
}

/// 查找实际下载的视频文件（可能是 .mp4, .webm, .mkv 等格式）
fn find_video_file(dir: &Path, video_id: &str) -> Result<PathBuf, String> {
    let video_extensions = ["mp4", "webm", "mkv", "m4a", "avi", "mov"];
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;

    // 优先查找完整的视频文件（不包含格式代码如 .f398.mp4）
    let mut all_matches: Vec<PathBuf> = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|os_err| os_err.to_string())?;
        let path = entry.path();
        if let Some(fname) = path.file_name().and_then(|f| f.to_str()) {
            // 文件名必须以 video_id 开头
            if fname.starts_with(video_id) {
                // 检查是否是视频文件
                for ext in &video_extensions {
                    if fname.ends_with(&format!(".{}", ext)) {
                        all_matches.push(path.clone());
                        break;
                    }
                }
            }
        }
    }

    // 优先选择不包含格式代码的文件（如 abc.mp4 优于 abc.f398.mp4）
    all_matches.sort_by(|a, b| {
        let a_name = a.file_name().unwrap_or_default().to_string_lossy();
        let b_name = b.file_name().unwrap_or_default().to_string_lossy();
        let a_has_format_code =
            a_name.contains(".f") && a_name.chars().filter(|c| *c == '.').count() > 1;
        let b_has_format_code =
            b_name.contains(".f") && b_name.chars().filter(|c| *c == '.').count() > 1;
        a_has_format_code.cmp(&b_has_format_code)
    });

    all_matches
        .into_iter()
        .next()
        .ok_or_else(|| format!("未找到视频文件: {}", video_id))
}

fn find_srt_file(dir: &Path, video_id: &str) -> Result<PathBuf, String> {
    // Check for common patterns: id.en.srt, id.zh-Hans.srt, etc.
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|os_err| os_err.to_string())?;
        let path = entry.path();
        if let Some(fname) = path.file_name().and_then(|f| f.to_str()) {
            if fname.starts_with(video_id) && fname.ends_with(".srt") {
                return Ok(path);
            }
        }
    }

    Err("No subtitle file found".to_string())
}

fn parse_srt(path: &Path) -> Result<Vec<ArticleSegment>, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut segments = Vec::new();

    // Simple SRT parser
    // Block format:
    // 1
    // 00:00:00,000 --> 00:00:02,000
    // Text line 1
    // Text line 2

    let blocks: Vec<&str> = content.split("\n\n").collect();
    let time_regex =
        Regex::new(r"(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})").unwrap();

    for block in blocks {
        let lines: Vec<&str> = block.lines().collect();
        if lines.len() >= 3 {
            // Line 0: Index
            // Line 1: Timestamp
            // Line 2+: Text
            if let Some(caps) = time_regex.captures(lines[1]) {
                let start_str = &caps[1];
                let end_str = &caps[2];

                let start_time = parse_srt_timestamp(start_str);
                let end_time = parse_srt_timestamp(end_str);

                let text = lines[2..].join(" ");

                // Clean text (remove HTML tags if any)
                let text = text
                    .replace("<i>", "")
                    .replace("</i>", "")
                    .trim()
                    .to_string();

                if !text.is_empty() {
                    segments.push(ArticleSegment {
                        id: Uuid::new_v4().to_string(),
                        article_id: String::new(), // Will be set by caller
                        order: segments.len() as i32,
                        text,
                        reading_text: None,
                        translation: None,
                        explanation: None,
                        start_time,
                        end_time,
                        created_at: Utc::now().to_rfc3339(),
                        is_new_paragraph: true, // SRT blocks usually separate sentences/phrases
                    });
                }
            }
        }
    }

    Ok(segments)
}

fn parse_srt_timestamp(ts: &str) -> Option<f64> {
    // format: 00:00:00,000
    let parts: Vec<&str> = ts.split(',').collect();
    if parts.len() != 2 {
        return None;
    }

    let time_parts: Vec<&str> = parts[0].split(':').collect();
    if time_parts.len() != 3 {
        return None;
    }

    let h: f64 = time_parts[0].parse().ok()?;
    let m: f64 = time_parts[1].parse().ok()?;
    let s: f64 = time_parts[2].parse().ok()?;
    let ms: f64 = parts[1].parse().ok()?;

    Some(h * 3600.0 + m * 60.0 + s + ms / 1000.0)
}

#[cfg(test)]
mod site_arg_tests {
    use super::*;

    #[test]
    fn detects_bilibili_urls() {
        assert!(is_bilibili_url("https://www.bilibili.com/video/BV1xx411c7mD"));
        assert!(is_bilibili_url("https://b23.tv/abc"));
        assert!(!is_bilibili_url("https://www.youtube.com/watch?v=x"));
    }

    #[test]
    fn bilibili_merges_streams_with_ffmpeg() {
        let args = yt_dlp_site_args("https://www.bilibili.com/video/BV1xx", Some(Path::new("/app/ffmpeg")));
        assert!(args.windows(2).any(|w| w[0] == "--merge-output-format" && w[1] == "mp4"));
        assert!(args.windows(2).any(|w| w[0] == "--ffmpeg-location" && w[1] == "/app/ffmpeg"));
        assert!(args.iter().any(|a| a.contains("ai-zh")));
    }

    #[test]
    fn youtube_keeps_premerged_formats() {
        let args = yt_dlp_site_args("https://youtu.be/x", None);
        assert!(args.iter().any(|a| a.starts_with("22/18")));
        assert!(!args.iter().any(|a| a == "--ffmpeg-location"));
    }
}
