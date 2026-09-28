use crate::agent_worker::{
    default_base_url, resolve_runtime_provider_config, AgentWorkerManager, AgentWorkerStatusSnapshot,
};
use crate::ai_service::{get_ai_service, get_or_create_ai_service, AIServiceCache};
use crate::ffmpeg::run_ffmpeg;
use crate::ktv_export::{export_ktv_video, prepare_ktv_segments, KtvExportConfig, KtvExportResult};
use crate::moonshot::is_moonshot_provider;
use crate::storage::{
    delete_article,
    delete_bookmark,
    delete_favorite_grammar,
    delete_favorite_vocabulary,
    delete_word_pack,
    ensure_app_dirs,
    ensure_favorites_dirs,
    list_articles,
    list_bookmarks_for_book,
    list_favorite_grammars,
    list_word_packs,
    load_agent_task,
    load_article,
    load_artifact,
    load_bookmark,
    load_config,
    load_favorite_grammar,
    load_favorite_vocabulary,
    load_word_pack,
    save_agent_task,
    save_article,
    save_artifact,
    // 书签存储函数
    save_bookmark,
    save_config,
    save_favorite_grammar,
    // 收藏夹存储函数
    save_favorite_vocabulary,
    save_word_pack,
    update_article_active_mind_map_artifact,
};
use crate::subtitle_import::{create_article_from_srt, import_subtitles_into_article};
use crate::types::{
    AgentTask, AgentTaskInput, AgentTaskStatus, AgentTaskType, AnalysisRequest, AnalysisResponse,
    AnalysisType, Article, ArticleEvidenceItem, ArticleEvidenceResult, ArticleOverview,
    ArticleSearchHit, ArticleSearchResult, ArticleSegment, ArticleTextWindow, Artifact,
    ArtifactType, AssistantConversationMessage, Bookmark, ChatRequest, ChatResponse,
    FavoriteGrammar, FavoriteVocabulary, ModelConfig, TimeRange, TranslationRequest,
    TranslationResponse, WordPack,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

pub type AppState<'a> = State<'a, AIServiceCache>;

pub use crate::types::MaterialSummary;

// Helper function to create segments from content
// 按句子分隔内容（使用.或。作为分隔符），并标记是否需要换行
fn create_segments_from_content(article_id: &str, content: &str) -> Vec<ArticleSegment> {
    let mut segments = Vec::new();
    let mut order = 0;

    // 首先按段落分割（双换行或单换行）
    let paragraphs: Vec<&str> = content
        .split('\n')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    for paragraph in paragraphs {
        // 将段落按句子分割（使用 . 或 。 作为分隔符）
        // 使用正则表达式保留分隔符
        let sentences = split_into_sentences(paragraph);

        for (sentence_index, sentence) in sentences.iter().enumerate() {
            let text = sentence.trim();
            if text.is_empty() {
                continue;
            }

            segments.push(ArticleSegment {
                id: Uuid::new_v4().to_string(),
                article_id: article_id.to_string(),
                order,
                text: text.to_string(),
                reading_text: None,
                translation: None,
                explanation: None,
                start_time: None,
                end_time: None,
                created_at: chrono::Utc::now().to_rfc3339(),
                // 段落的第一个句子需要换行显示，后续句子紧跟前一个显示
                is_new_paragraph: sentence_index == 0,
            });
            order += 1;
        }
    }

    segments
}

/// 将段落拆分成句子，保留句末标点
/// 支持英文句号(.)、中文句号(。)、问号(?/？)、感叹号(!/！)
fn split_into_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = text.chars().collect();

    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        current.push(c);

        // 检查是否是句子结束符
        let is_sentence_end = c == '。'
            || c == '？'
            || c == '！'
            || (c == '.' && !is_abbreviation(&chars, i))
            || c == '?'
            || c == '!';

        if is_sentence_end {
            // 处理引号闭合情况：如 ... said." 这种情况
            // 向后看，如果下一个字符是引号，把它也加进来
            if i + 1 < chars.len() {
                let next = chars[i + 1];
                if next == '"'
                    || next == '\u{201D}'
                    || next == '\''
                    || next == '\u{2019}'
                    || next == ')'
                    || next == '）'
                {
                    i += 1;
                    current.push(next);
                }
            }

            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                sentences.push(trimmed);
            }
            current = String::new();
        }

        i += 1;
    }

    // 处理剩余内容（没有句号结尾的情况）
    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        sentences.push(trimmed);
    }

    // 如果整个段落没有分割成功（没有找到分隔符），返回整段
    if sentences.is_empty() && !text.trim().is_empty() {
        sentences.push(text.trim().to_string());
    }

    sentences
}

/// 检查句点是否是缩写的一部分（如 Mr. Mrs. Dr. U.S. 等）
/// 简单的启发式规则
fn is_abbreviation(chars: &[char], pos: usize) -> bool {
    // 如果句点后面紧跟字母，可能是缩写 (如 U.S.A)
    if pos + 1 < chars.len() && chars[pos + 1].is_alphabetic() {
        return true;
    }

    // 检查句点前是否是常见缩写
    // 向前查找单词
    let mut word = String::new();
    let mut j = pos as i32 - 1;
    while j >= 0 && chars[j as usize].is_alphabetic() {
        word.insert(0, chars[j as usize]);
        j -= 1;
    }

    let word_lower = word.to_lowercase();
    let abbreviations = [
        "mr", "mrs", "ms", "dr", "jr", "sr", "vs", "etc", "inc", "ltd", "no", "st", "ave", "rd",
    ];

    if abbreviations.contains(&word_lower.as_str()) {
        return true;
    }

    // 单字母后跟句点通常是缩写（如 A. B. C.）
    if word.chars().count() == 1 && word.chars().next().unwrap().is_uppercase() {
        return true;
    }

    false
}

pub fn build_article_overview(article: &Article) -> ArticleOverview {
    ArticleOverview {
        article_id: article.id.clone(),
        title: article.title.clone(),
        source_type: article.source_type.clone(),
        content_length: article.content.chars().count(),
        segment_count: article.segments.len(),
        has_timestamps: article
            .segments
            .iter()
            .any(|segment| segment.start_time.is_some() || segment.end_time.is_some()),
        has_segments: !article.segments.is_empty(),
        language_hint: None,
        book_type: article.book_type.clone(),
    }
}

pub fn material_summary_from_article(article: &Article) -> MaterialSummary {
    let material_type = article
        .book_type
        .clone()
        .or_else(|| match article.source_type.as_deref() {
            Some("youtube") | Some("local_video") => Some("video".to_string()),
            Some(source_type) => Some(source_type.to_string()),
            None => None,
        })
        .unwrap_or_else(|| "article".to_string());

    MaterialSummary {
        id: article.id.clone(),
        title: article.title.clone(),
        material_type,
        created_at: article.created_at.clone(),
        translated: article.translated,
    }
}

pub fn filter_material_summaries(
    items: &[MaterialSummary],
    keyword: Option<&str>,
    material_type: Option<&str>,
    limit: usize,
) -> Vec<MaterialSummary> {
    let normalized_keyword = keyword
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    let normalized_type = material_type
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());

    items
        .iter()
        .filter(|item| {
            normalized_keyword
                .as_ref()
                .map(|keyword| item.title.to_lowercase().contains(keyword))
                .unwrap_or(true)
        })
        .filter(|item| {
            normalized_type
                .as_ref()
                .map(|material_type| item.material_type.to_lowercase() == *material_type)
                .unwrap_or(true)
        })
        .take(limit)
        .cloned()
        .collect()
}

pub fn read_article_window(
    article: &Article,
    cursor: usize,
    max_chars: usize,
) -> ArticleTextWindow {
    let total_chars = article.content.chars().count();
    let safe_cursor = cursor.min(total_chars);
    let requested_end = (safe_cursor + max_chars).min(total_chars);
    let text: String = article
        .content
        .chars()
        .skip(safe_cursor)
        .take(requested_end.saturating_sub(safe_cursor))
        .collect();

    let mut source_segment_ids = Vec::new();
    let mut min_start: Option<f64> = None;
    let mut max_end: Option<f64> = None;
    let mut segment_cursor = 0usize;

    for (index, segment) in article.segments.iter().enumerate() {
        if index > 0 {
            segment_cursor += 1;
        }
        let segment_start = segment_cursor;
        let segment_end = segment_start + segment.text.chars().count();
        segment_cursor = segment_end;

        let overlaps = segment_end > safe_cursor && segment_start < requested_end;
        if overlaps {
            source_segment_ids.push(segment.id.clone());
            if let Some(start) = segment.start_time {
                min_start = Some(min_start.map_or(start, |current| current.min(start)));
            }
            if let Some(end) = segment.end_time {
                max_end = Some(max_end.map_or(end, |current| current.max(end)));
            }
        }
    }

    ArticleTextWindow {
        cursor: safe_cursor,
        next_cursor: requested_end,
        has_more: requested_end < total_chars,
        text,
        start_offset: safe_cursor,
        end_offset: requested_end,
        source_segment_ids,
        time_range: match (min_start, max_end) {
            (Some(start), Some(end)) => Some(TimeRange { start, end }),
            _ => None,
        },
    }
}

pub fn search_article_segments(
    article: &Article,
    query: &str,
    limit: usize,
) -> ArticleSearchResult {
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return ArticleSearchResult {
            results: Vec::new(),
        };
    }

    let mut results = Vec::new();
    for segment in &article.segments {
        let text_lower = segment.text.to_lowercase();
        if text_lower.contains(&normalized_query) {
            let score = normalized_query.len() as f64 / segment.text.len().max(1) as f64;
            results.push(ArticleSearchHit {
                segment_id: segment.id.clone(),
                text: segment.text.clone(),
                score,
                start_time: segment.start_time,
                end_time: segment.end_time,
            });
        }
        if results.len() >= limit {
            break;
        }
    }

    ArticleSearchResult { results }
}

pub fn collect_article_evidence(
    article: &Article,
    segment_ids: &[String],
) -> ArticleEvidenceResult {
    let index: HashMap<&str, &ArticleSegment> = article
        .segments
        .iter()
        .map(|segment| (segment.id.as_str(), segment))
        .collect();

    let items = segment_ids
        .iter()
        .filter_map(|segment_id| index.get(segment_id.as_str()))
        .map(|segment| ArticleEvidenceItem {
            segment_id: segment.id.clone(),
            text: segment.text.clone(),
            start_time: segment.start_time,
            end_time: segment.end_time,
        })
        .collect();

    ArticleEvidenceResult { items }
}

pub fn update_agent_task_progress_in_dir(
    data_dir: &std::path::Path,
    task_id: &str,
    stage: String,
    progress: f64,
    message: Option<String>,
) -> Result<AgentTask, String> {
    let mut task = crate::storage::load_agent_task_in_dir(data_dir, task_id)?;
    task.status = AgentTaskStatus::Running;
    task.stage = Some(stage);
    task.progress = progress.clamp(0.0, 1.0);
    task.message = message;
    task.updated_at = chrono::Utc::now().to_rfc3339();
    if task.started_at.is_none() {
        task.started_at = Some(task.updated_at.clone());
    }
    crate::storage::save_agent_task_in_dir(data_dir, &task)?;
    Ok(task)
}

pub fn save_mind_map_artifact_in_dir(
    data_dir: &std::path::Path,
    task_id: &str,
    article_id: &str,
    content: serde_json::Value,
) -> Result<Artifact, String> {
    let artifact = Artifact {
        id: Uuid::new_v4().to_string(),
        task_id: task_id.to_string(),
        article_id: article_id.to_string(),
        artifact_type: ArtifactType::MindMap,
        version: "1".to_string(),
        content,
        metadata: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    };
    crate::storage::save_artifact_in_dir(data_dir, &artifact)?;
    Ok(artifact)
}

#[tauri::command]
pub async fn article_get_overview_cmd(
    app_handle: AppHandle,
    article_id: String,
) -> Result<ArticleOverview, String> {
    let article = get_article(app_handle, article_id).await?;
    Ok(build_article_overview(&article))
}

#[tauri::command]
pub async fn article_read_window_cmd(
    app_handle: AppHandle,
    article_id: String,
    cursor: usize,
    max_chars: usize,
) -> Result<ArticleTextWindow, String> {
    let article = get_article(app_handle, article_id).await?;
    Ok(read_article_window(&article, cursor, max_chars))
}

#[tauri::command]
pub async fn article_search_cmd(
    app_handle: AppHandle,
    article_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<ArticleSearchResult, String> {
    let article = get_article(app_handle, article_id).await?;
    Ok(search_article_segments(
        &article,
        &query,
        limit.unwrap_or(8),
    ))
}

#[tauri::command]
pub async fn article_get_evidence_cmd(
    app_handle: AppHandle,
    article_id: String,
    segment_ids: Vec<String>,
) -> Result<ArticleEvidenceResult, String> {
    let article = get_article(app_handle, article_id).await?;
    Ok(collect_article_evidence(&article, &segment_ids))
}

#[tauri::command]
pub async fn task_report_progress_cmd(
    app_handle: AppHandle,
    task_id: String,
    stage: String,
    progress: f64,
    message: Option<String>,
) -> Result<AgentTask, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let task = update_agent_task_progress_in_dir(&data_dir, &task_id, stage, progress, message)?;
    save_agent_task(&app_handle, &task)?;
    Ok(task)
}

#[tauri::command]
pub async fn artifact_save_cmd(
    app_handle: AppHandle,
    task_id: String,
    article_id: String,
    content: serde_json::Value,
) -> Result<Artifact, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let artifact = save_mind_map_artifact_in_dir(&data_dir, &task_id, &article_id, content)?;
    save_artifact(&app_handle, &artifact)?;
    let _ = update_article_active_mind_map_artifact(
        &app_handle,
        &article_id,
        Some(artifact.id.clone()),
    )?;
    Ok(artifact)
}

#[tauri::command]
pub async fn create_mind_map_task_cmd(
    app_handle: AppHandle,
    worker_manager: State<'_, AgentWorkerManager>,
    article_id: String,
    display_language: Option<String>,
    max_depth: Option<i32>,
) -> Result<AgentTask, String> {
    let article = get_article(app_handle.clone(), article_id.clone()).await?;
    let active_model = require_active_agent_model_config(load_config(&app_handle)?)?;
    let provider_config = resolve_runtime_provider_config(&active_model);
    let now = chrono::Utc::now().to_rfc3339();
    let task = AgentTask {
        id: Uuid::new_v4().to_string(),
        task_type: AgentTaskType::MindMapGenerate,
        status: AgentTaskStatus::Queued,
        article_id: article_id.clone(),
        input: AgentTaskInput {
            article_id: article_id.clone(),
            display_language: display_language.unwrap_or_else(|| "zh-CN".to_string()),
            max_depth: max_depth.unwrap_or(3),
            evidence_mode: "strict".to_string(),
            prefer_structure: "topic_tree".to_string(),
        },
        progress: 0.0,
        stage: Some("queued".to_string()),
        message: None,
        error: None,
        worker_session_id: None,
        artifact_ids: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
        started_at: None,
        finished_at: None,
    };
    save_agent_task(&app_handle, &task)?;
    if let Err(error) =
        worker_manager.submit_mind_map_task(&app_handle, &task, &article, &provider_config)
    {
        let mut failed_task = load_agent_task(&app_handle, &task.id)?;
        failed_task.status = AgentTaskStatus::Failed;
        failed_task.error = Some(error.clone());
        failed_task.stage = Some("failed_to_start".to_string());
        failed_task.updated_at = chrono::Utc::now().to_rfc3339();
        failed_task.finished_at = Some(failed_task.updated_at.clone());
        save_agent_task(&app_handle, &failed_task)?;
        return Err(error);
    }
    load_agent_task(&app_handle, &task.id)
}

#[tauri::command]
pub async fn run_agent_turn_cmd(
    app_handle: AppHandle,
    worker_manager: State<'_, AgentWorkerManager>,
    task_id: String,
    article_id: String,
    user_message: String,
    conversation: Vec<AssistantConversationMessage>,
    display_language: Option<String>,
) -> Result<AgentTask, String> {
    let article = get_article(app_handle.clone(), article_id.clone()).await?;
    let articles = list_articles_cmd(app_handle.clone()).await?;
    let active_model = require_active_agent_model_config(load_config(&app_handle)?)?;
    let provider_config = resolve_runtime_provider_config(&active_model);
    let now = chrono::Utc::now().to_rfc3339();
    let task = AgentTask {
        id: task_id,
        task_type: AgentTaskType::AssistantAgentTurn,
        status: AgentTaskStatus::Queued,
        article_id: article_id.clone(),
        input: AgentTaskInput {
            article_id: article_id.clone(),
            display_language: display_language.unwrap_or_else(|| "zh-CN".to_string()),
            max_depth: 0,
            evidence_mode: "none".to_string(),
            prefer_structure: "none".to_string(),
        },
        progress: 0.0,
        stage: Some("queued".to_string()),
        message: None,
        error: None,
        worker_session_id: None,
        artifact_ids: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
        started_at: None,
        finished_at: None,
    };
    save_agent_task(&app_handle, &task)?;

    let current_material = material_summary_from_article(&article);
    let available_materials = articles
        .iter()
        .map(material_summary_from_article)
        .collect::<Vec<_>>();

    if let Err(error) = worker_manager.submit_assistant_turn(
        &app_handle,
        &task,
        user_message,
        conversation,
        current_material,
        available_materials,
        &provider_config,
    ) {
        let mut failed_task = load_agent_task(&app_handle, &task.id)?;
        failed_task.status = AgentTaskStatus::Failed;
        failed_task.error = Some(error.clone());
        failed_task.stage = Some("failed_to_start".to_string());
        failed_task.updated_at = chrono::Utc::now().to_rfc3339();
        failed_task.finished_at = Some(failed_task.updated_at.clone());
        save_agent_task(&app_handle, &failed_task)?;
        return Err(error);
    }

    load_agent_task(&app_handle, &task.id)
}

pub fn require_active_agent_model_config(
    config: Option<crate::types::AppConfig>,
) -> Result<ModelConfig, String> {
    let config = config.ok_or_else(|| "未配置 API，请先在设置中配置 AI 模型".to_string())?;
    config
        .get_active_config()
        .cloned()
        .ok_or_else(|| "未设置活动模型配置，请先在设置中配置 AI 模型".to_string())
}

#[tauri::command]
pub async fn get_agent_task_cmd(
    app_handle: AppHandle,
    task_id: String,
) -> Result<AgentTask, String> {
    load_agent_task(&app_handle, &task_id)
}

#[tauri::command]
pub async fn get_artifact_cmd(
    app_handle: AppHandle,
    article_id: String,
    artifact_id: String,
) -> Result<Artifact, String> {
    load_artifact(&app_handle, &article_id, &artifact_id)
}

#[tauri::command]
pub async fn get_agent_worker_status_cmd(
    worker_manager: State<'_, AgentWorkerManager>,
) -> Result<AgentWorkerStatusSnapshot, String> {
    Ok(worker_manager.status_snapshot())
}

#[tauri::command]
pub async fn stop_agent_worker_cmd(
    worker_manager: State<'_, AgentWorkerManager>,
) -> Result<(), String> {
    worker_manager.stop()
}

const DEFAULT_UNGROUPED_PACK_ID: &str = "system-ungrouped";
const DEFAULT_UNGROUPED_PACK_NAME: &str = "未分组";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WordPackExportMeta {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    cover_url: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    language_from: Option<String>,
    #[serde(default)]
    language_to: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WordPackExportEntry {
    word: String,
    meaning: String,
    #[serde(default)]
    usage: Option<String>,
    #[serde(default)]
    example: Option<String>,
    #[serde(default)]
    reading: Option<String>,
    #[serde(default)]
    explanation: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WordPackExportFile {
    schema_version: String,
    pack: WordPackExportMeta,
    entries: Vec<WordPackExportEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportWordPackResult {
    pub file_name: String,
    pub json_content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportWordPackResult {
    pub created_pack_id: String,
    pub total: usize,
    pub imported: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

fn favorite_to_word_pack_export_entry(fav: FavoriteVocabulary) -> WordPackExportEntry {
    WordPackExportEntry {
        word: fav.word,
        meaning: fav.meaning,
        usage: if fav.usage.trim().is_empty() {
            None
        } else {
            Some(fav.usage)
        },
        example: fav.example,
        reading: fav.reading,
        explanation: fav.explanation,
        tags: Vec::new(),
    }
}

fn build_word_pack_export_result(
    pack_meta: WordPackExportMeta,
    mut entries: Vec<WordPackExportEntry>,
) -> Result<ExportWordPackResult, String> {
    entries.sort_by(|a, b| a.word.cmp(&b.word));

    let export_file = WordPackExportFile {
        schema_version: "openkoto-word-pack-v1".to_string(),
        pack: pack_meta.clone(),
        entries,
    };

    let json_content = serde_json::to_string_pretty(&export_file)
        .map_err(|e| format!("Failed to serialize export file: {}", e))?;
    let file_name = format!("{}.okpack.json", sanitize_file_name(&pack_meta.name));

    Ok(ExportWordPackResult {
        file_name,
        json_content,
    })
}

fn normalize_word(word: &str) -> String {
    word.trim().to_lowercase()
}

fn parse_import_word_pack_json(json_content: &str) -> Result<WordPackExportFile, String> {
    let normalized = json_content.trim_start_matches('\u{feff}').trim();
    if normalized.is_empty() {
        return Err("Word pack JSON is empty".to_string());
    }

    let parsed = serde_json::from_str::<WordPackExportFile>(normalized)
        .map_err(|e| format!("Invalid word pack JSON: {}", e))?;

    if parsed.schema_version != "openkoto-word-pack-v1" {
        return Err(format!(
            "Unsupported word pack schema_version: {} (expected openkoto-word-pack-v1)",
            parsed.schema_version
        ));
    }

    Ok(parsed)
}

fn parse_local_date(date_local: &str) -> Result<chrono::NaiveDate, String> {
    chrono::NaiveDate::parse_from_str(date_local, "%Y-%m-%d")
        .map_err(|_| format!("Invalid local date format: {}", date_local))
}

fn today_local_date() -> chrono::NaiveDate {
    chrono::Local::now().date_naive()
}

fn ensure_default_word_pack(app_handle: &AppHandle) -> Result<WordPack, String> {
    ensure_favorites_dirs(app_handle)?;
    let now = chrono::Utc::now().to_rfc3339();
    let default_pack = WordPack {
        id: DEFAULT_UNGROUPED_PACK_ID.to_string(),
        name: DEFAULT_UNGROUPED_PACK_NAME.to_string(),
        description: Some("系统默认合集".to_string()),
        cover_url: None,
        author: Some("OpenKoto".to_string()),
        language_from: None,
        language_to: None,
        tags: vec!["system".to_string()],
        version: Some("1.0.0".to_string()),
        created_at: now.clone(),
        updated_at: now,
        is_system: true,
    };

    let existing = load_word_pack(app_handle, DEFAULT_UNGROUPED_PACK_ID)
        .ok()
        .and_then(|json| serde_json::from_str::<WordPack>(&json).ok());

    if let Some(pack) = existing {
        return Ok(pack);
    }

    let json = serde_json::to_string(&default_pack)
        .map_err(|e| format!("Failed to serialize default pack: {}", e))?;
    save_word_pack(app_handle, &default_pack.id, &json)?;
    Ok(default_pack)
}

fn load_all_word_packs(app_handle: &AppHandle) -> Result<Vec<WordPack>, String> {
    let mut packs = crate::storage::load_all_word_packs(app_handle)?;
    packs.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(packs)
}

fn load_all_favorite_vocabularies_internal(
    app_handle: &AppHandle,
) -> Result<Vec<FavoriteVocabulary>, String> {
    crate::storage::load_all_favorite_vocabularies(app_handle)
}

fn persist_favorite_vocabulary(
    app_handle: &AppHandle,
    favorite: &FavoriteVocabulary,
) -> Result<(), String> {
    let json = serde_json::to_string(favorite)
        .map_err(|e| format!("Failed to serialize favorite vocabulary: {}", e))?;
    save_favorite_vocabulary(app_handle, &favorite.id, &json)
}

fn sanitize_pack_ids(pack_ids: Option<Vec<String>>) -> Vec<String> {
    let mut seen = HashSet::new();
    pack_ids
        .unwrap_or_default()
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

fn filter_existing_pack_ids(
    pack_ids: Vec<String>,
    existing_pack_ids: &HashSet<String>,
    default_pack_id: &str,
) -> Vec<String> {
    let mut result: Vec<String> = pack_ids
        .into_iter()
        .filter(|id| existing_pack_ids.contains(id))
        .collect();

    if result.is_empty() {
        result.push(default_pack_id.to_string());
    }

    result
}

fn sort_by_due_then_last_review(
    a: &FavoriteVocabulary,
    b: &FavoriteVocabulary,
) -> std::cmp::Ordering {
    match a.due_date.cmp(&b.due_date) {
        std::cmp::Ordering::Equal => a.last_reviewed_at.cmp(&b.last_reviewed_at),
        ord => ord,
    }
}

fn is_due_on_or_before(due_date: &str, target_date: chrono::NaiveDate) -> bool {
    parse_local_date(due_date)
        .map(|due| due <= target_date)
        .unwrap_or(true)
}

fn sanitize_file_name(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | '?' | '%' | '*' | ':' | '|' | '"' | '<' | '>' => '-',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .to_string();

    if sanitized.is_empty() {
        "openkoto_word_pack".to_string()
    } else {
        sanitized
    }
}

/// 距上次复习的本地日期差(规范 §2.7):
/// last_reviewed_at(UTC)转本地日期作差,下限 0;
/// 缺失时回退 due_date - interval_days(旧 SM-2 字段)推算;仍失败则 0。
pub fn elapsed_days_for_review(
    favorite: &FavoriteVocabulary,
    review_date: chrono::NaiveDate,
) -> i64 {
    if let Some(last) = favorite
        .last_reviewed_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
    {
        let last_local = last.with_timezone(&chrono::Local).date_naive();
        return (review_date - last_local).num_days().max(0);
    }
    if let Ok(due) = parse_local_date(&favorite.due_date) {
        let implied_last = due - chrono::Duration::days(favorite.interval_days.max(0) as i64);
        return (review_date - implied_last).num_days().max(0);
    }
    0
}

pub fn build_due_vocabulary_queue(
    mut all: Vec<FavoriteVocabulary>,
    pack_id: &str,
    date_local: &str,
    new_limit: i32,
    review_limit: i32,
) -> Result<Vec<FavoriteVocabulary>, String> {
    let target_date = parse_local_date(date_local)?;
    let new_limit = new_limit.max(0) as usize;
    let review_limit = review_limit.max(0) as usize;

    // 已掌握/暂停的卡片不进队列(规范 §3)
    all.retain(|fav| fav.suspended_at.is_none());
    if pack_id != "all" {
        all.retain(|fav| fav.pack_ids.iter().any(|id| id == pack_id));
    }
    all.retain(|fav| is_due_on_or_before(&fav.due_date, target_date));

    let (mut new_learning, mut review): (Vec<_>, Vec<_>) = all
        .into_iter()
        .partition(|fav| fav.srs_state == "new" || fav.srs_state == "learning");

    new_learning.sort_by(sort_by_due_then_last_review);
    review.sort_by(sort_by_due_then_last_review);

    let mut queue = Vec::new();
    queue.extend(new_learning.into_iter().take(new_limit));
    queue.extend(review.into_iter().take(review_limit));
    Ok(queue)
}

fn migrate_favorite_vocabularies(app_handle: &AppHandle) -> Result<(), String> {
    let default_pack = ensure_default_word_pack(app_handle)?;
    let favorites = load_all_favorite_vocabularies_internal(app_handle)?;
    let today = today_local_date().format("%Y-%m-%d").to_string();

    for mut favorite in favorites {
        let mut changed = false;

        if favorite.pack_ids.is_empty() {
            favorite.pack_ids = vec![default_pack.id.clone()];
            changed = true;
        } else {
            let dedup = sanitize_pack_ids(Some(favorite.pack_ids.clone()));
            if dedup != favorite.pack_ids {
                favorite.pack_ids = dedup;
                changed = true;
            }
        }

        if favorite.srs_state != "new"
            && favorite.srs_state != "learning"
            && favorite.srs_state != "review"
        {
            favorite.srs_state = "new".to_string();
            changed = true;
        }

        if favorite.ease_factor < 1.3 {
            favorite.ease_factor = 2.5;
            changed = true;
        }

        if favorite.due_date.trim().is_empty() {
            favorite.due_date = today.clone();
            changed = true;
        } else if parse_local_date(&favorite.due_date).is_err() {
            favorite.due_date = today.clone();
            changed = true;
        }

        if favorite.interval_days < 0 {
            favorite.interval_days = 0;
            changed = true;
        }

        if favorite.repetitions < 0 {
            favorite.repetitions = 0;
            changed = true;
        }

        if favorite.review_count < 0 {
            favorite.review_count = 0;
            changed = true;
        }

        if seed_fsrs_if_needed(&mut favorite) {
            changed = true;
        }

        if changed {
            persist_favorite_vocabulary(app_handle, &favorite)?;
        }
    }

    Ok(())
}

/// SM-2 → FSRS 一次性种子(规范 §4)。返回是否有修改。
/// 迁移 fix-up 在 init_app 与每次 list 都会执行,必须以 scheduler_version
/// 守卫保证幂等:已迁移的卡片(包括已被 FSRS 复习过的)绝不能被重新种子。
pub fn seed_fsrs_if_needed(favorite: &mut FavoriteVocabulary) -> bool {
    if favorite.scheduler_version.is_some() {
        return false;
    }
    if favorite.srs_state != "new" && favorite.review_count > 0 {
        let (stability, difficulty) =
            crate::fsrs::seed_from_sm2(favorite.interval_days, favorite.ease_factor);
        favorite.stability = stability;
        favorite.difficulty = difficulty;
    }
    favorite.scheduler_version = Some(crate::fsrs::SCHEDULER_VERSION.to_string());
    true
}

/// 复习统计(规范 §6)。纯函数,便于测试。
/// events 需为全量事件;pack_id == "all" 表示不过滤词包。
pub fn build_review_stats(
    cards: &[FavoriteVocabulary],
    events: &[crate::types::ReviewEvent],
    pack_id: &str,
    date_local: &str,
) -> crate::types::ReviewStats {
    use std::collections::BTreeSet;

    let in_pack = |card: &FavoriteVocabulary| {
        pack_id == "all" || card.pack_ids.iter().any(|id| id == pack_id)
    };
    let card_ids: HashSet<&str> = cards
        .iter()
        .filter(|c| in_pack(c))
        .map(|c| c.id.as_str())
        .collect();

    // 今日新学 / 今日复习:按卡去重,新学优先(同一卡当日先 new 后复习只计新学)
    let mut new_cards: HashSet<&str> = HashSet::new();
    let mut review_cards: HashSet<&str> = HashSet::new();
    for event in events {
        if event.date_local != date_local || !card_ids.contains(event.card_id.as_str()) {
            continue;
        }
        if event.previous_state == "new" {
            new_cards.insert(event.card_id.as_str());
        } else {
            review_cards.insert(event.card_id.as_str());
        }
    }
    let review_today = review_cards.difference(&new_cards).count() as i32;

    // 连续打卡:从今日(或昨日,若今日无事件)起向前连续有事件的天数。
    // 打卡不过滤词包(打卡是全局习惯指标)。
    let event_days: BTreeSet<&str> = events.iter().map(|e| e.date_local.as_str()).collect();
    let mut streak_days = 0;
    if let Ok(today) = parse_local_date(date_local) {
        let mut cursor = if event_days.contains(date_local) {
            today
        } else {
            today - chrono::Duration::days(1)
        };
        loop {
            let key = cursor.format("%Y-%m-%d").to_string();
            if event_days.contains(key.as_str()) {
                streak_days += 1;
                cursor -= chrono::Duration::days(1);
            } else {
                break;
            }
        }
    }

    let mut stats = crate::types::ReviewStats {
        new_today: new_cards.len() as i32,
        review_today,
        streak_days,
        total: 0,
        count_new: 0,
        count_learning: 0,
        count_review: 0,
        count_suspended: 0,
    };
    for card in cards.iter().filter(|c| in_pack(c)) {
        stats.total += 1;
        if card.suspended_at.is_some() {
            stats.count_suspended += 1;
        } else {
            match card.srs_state.as_str() {
                "learning" => stats.count_learning += 1,
                "review" => stats.count_review += 1,
                _ => stats.count_new += 1,
            }
        }
    }
    stats
}

// Initialize the app (ensure directories exist)
#[tauri::command]
pub async fn init_app(app_handle: AppHandle) -> Result<String, String> {
    ensure_app_dirs(&app_handle)?;
    ensure_favorites_dirs(&app_handle)?;
    let _ = ensure_default_word_pack(&app_handle)?;
    migrate_favorite_vocabularies(&app_handle)?;
    Ok("App initialized successfully".to_string())
}

// Configuration commands
#[tauri::command]
pub async fn get_config(
    app_handle: AppHandle,
    state: AppState<'_>,
) -> Result<Option<crate::types::AppConfig>, String> {
    let config = load_config(&app_handle)?;

    // If we have a config and an active model, ensure AI service is initialized
    if let Some(ref app_config) = config {
        if let Some(active_id) = &app_config.active_model_id {
            if let Some(model_config) = app_config.get_config(active_id) {
                // We don't fail here if init fails, just log it or ignore
                // real errors will bubble up when user tries to use AI features
                let _ = get_or_create_ai_service(
                    &state,
                    model_config.api_key.clone(),
                    model_config.api_provider.clone(),
                    model_config.model.clone(),
                    model_config.base_url.clone(),
                )
                .await;
            }
        }
    }

    Ok(config)
}

#[tauri::command]
pub async fn save_config_cmd(
    app_handle: AppHandle,
    config: crate::types::AppConfig,
) -> Result<String, String> {
    save_config(&app_handle, &config)?;
    Ok("Configuration saved".to_string())
}

/// Add or update a model configuration
#[tauri::command]
pub async fn save_model_config(
    app_handle: AppHandle,
    state: AppState<'_>,
    config: ModelConfig,
) -> Result<ModelConfig, String> {
    let mut app_config = load_config(&app_handle)?.unwrap_or_default();

    // Check if this is an update or new config
    let existing_index = app_config
        .model_configs
        .iter()
        .position(|c| c.id == config.id);

    if let Some(idx) = existing_index {
        // Update existing config
        app_config.model_configs[idx] = config.clone();
    } else {
        // Add new config
        app_config.model_configs.push(config.clone());
    }

    // Set as active if it's the first one or marked as default
    if app_config.model_configs.len() == 1 || config.is_default {
        app_config.active_model_id = Some(config.id.clone());
        // Unset other defaults
        for c in &mut app_config.model_configs {
            if c.id != config.id {
                c.is_default = false;
            }
        }
    }

    save_config(&app_handle, &app_config)?;

    // Update AI service cache if this is the active config
    if app_config.active_model_id.as_ref() == Some(&config.id) {
        get_or_create_ai_service(
            &state,
            config.api_key.clone(),
            config.api_provider.clone(),
            config.model.clone(),
            config.base_url.clone(),
        )
        .await?;
    }

    Ok(config)
}

/// Delete a model configuration
#[tauri::command]
pub async fn delete_model_config(app_handle: AppHandle, config_id: String) -> Result<(), String> {
    let mut app_config = load_config(&app_handle)?.unwrap_or_default();

    // Remove the config
    let original_len = app_config.model_configs.len();
    app_config.model_configs.retain(|c| c.id != config_id);

    if app_config.model_configs.len() == original_len {
        return Err("Configuration not found".to_string());
    }

    // If we deleted the active config, set a new active one
    if app_config.active_model_id.as_ref() == Some(&config_id) {
        app_config.active_model_id = app_config.model_configs.first().map(|c| c.id.clone());
    }

    save_config(&app_handle, &app_config)?;
    Ok(())
}

/// Set the active model configuration
#[tauri::command]
pub async fn set_active_model_config(
    app_handle: AppHandle,
    state: AppState<'_>,
    config_id: String,
) -> Result<ModelConfig, String> {
    let mut app_config = load_config(&app_handle)?.unwrap_or_default();

    let config = app_config
        .get_config(&config_id)
        .ok_or("Configuration not found")?
        .clone();

    app_config.active_model_id = Some(config_id.clone());

    save_config(&app_handle, &app_config)?;

    // Update AI service cache
    get_or_create_ai_service(
        &state,
        config.api_key.clone(),
        config.api_provider.clone(),
        config.model.clone(),
        config.base_url.clone(),
    )
    .await?;

    Ok(config)
}

/// Get the active model configuration
#[tauri::command]
pub async fn get_active_model_config(app_handle: AppHandle) -> Result<Option<ModelConfig>, String> {
    let app_config = load_config(&app_handle)?.unwrap_or_default();
    Ok(app_config.get_active_config().cloned())
}

/// Legacy command for backward compatibility - redirects to new model config system
#[tauri::command]
pub async fn set_api_key(
    app_handle: AppHandle,
    state: AppState<'_>,
    api_key: String,
    provider: String,
    model: String,
) -> Result<String, String> {
    let mut app_config = load_config(&app_handle)?.unwrap_or_default();

    // Create a default config name
    let config_name = format!("{} - {}", provider, model);

    // Check if a config with same provider/model already exists
    let existing = app_config
        .model_configs
        .iter()
        .find(|c| c.api_provider == provider && c.model == model);

    let config = if let Some(existing) = existing {
        // Update existing
        ModelConfig {
            api_key,
            ..existing.clone()
        }
    } else {
        // Create new
        ModelConfig::new(config_name, api_key, provider, model)
    };

    let config_id = config.id.clone();

    // Add or update
    let existing_index = app_config
        .model_configs
        .iter()
        .position(|c| c.id == config.id);
    if let Some(idx) = existing_index {
        app_config.model_configs[idx] = config.clone();
    } else {
        app_config.model_configs.push(config.clone());
    }

    // Set as active
    app_config.active_model_id = Some(config_id.clone());

    save_config(&app_handle, &app_config)?;

    // Update AI service cache
    get_or_create_ai_service(
        &state,
        config.api_key.clone(),
        config.api_provider.clone(),
        config.model.clone(),
        config.base_url.clone(),
    )
    .await?;

    Ok("API key saved successfully".to_string())
}

// Article commands
#[tauri::command]
pub async fn create_article(
    app_handle: AppHandle,
    title: String,
    content: String,
    source_url: Option<String>,
) -> Result<Article, String> {
    let id = Uuid::new_v4().to_string();
    let created_at = chrono::Utc::now().to_rfc3339();

    let segments = create_segments_from_content(&id, &content);

    let article = Article {
        id: id.clone(),
        title: title.clone(),
        content: content.clone(),
        source_type: Some("article".to_string()),
        source_url: source_url.clone(),
        media_path: None,
        book_path: None,
        book_type: None,
        created_at: created_at.clone(),
        translated: false,
        active_mind_map_artifact_id: None,
        segments,
    };

    // Save article metadata and content
    let article_json = serde_json::to_string(&article).unwrap();
    save_article(&app_handle, &id, &article_json)?;

    Ok(article)
}

#[tauri::command]
pub async fn resegment_article(
    app_handle: AppHandle,
    article_id: String,
) -> Result<Article, String> {
    let article_json = load_article(&app_handle, &article_id)?;
    let mut article: Article = serde_json::from_str(&article_json)
        .map_err(|e| format!("Failed to parse article: {}", e))?;

    article.segments = create_segments_from_content(&article.id, &article.content);

    let updated_json = serde_json::to_string(&article).unwrap();
    save_article(&app_handle, &article.id, &updated_json)?;

    Ok(article)
}

#[tauri::command]
pub async fn get_article(app_handle: AppHandle, id: String) -> Result<Article, String> {
    let article_json = load_article(&app_handle, &id)?;
    let article: Article = serde_json::from_str(&article_json)
        .map_err(|e| format!("Failed to parse article: {}", e))?;
    Ok(article)
}

#[tauri::command]
pub async fn list_articles_cmd(app_handle: AppHandle) -> Result<Vec<Article>, String> {
    let article_ids = list_articles(&app_handle)?;

    let mut articles = Vec::new();
    for id in article_ids {
        if let Ok(article_json) = load_article(&app_handle, &id) {
            if let Ok(article) = serde_json::from_str::<Article>(&article_json) {
                articles.push(article);
            }
        }
    }

    // Sort by created_at (newest first)
    articles.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(articles)
}

#[tauri::command]
pub async fn update_article(
    app_handle: AppHandle,
    id: String,
    title: Option<String>,
    content: Option<String>,
    source_url: Option<String>,
    translated: Option<bool>,
) -> Result<Article, String> {
    let article_json = load_article(&app_handle, &id)?;
    let mut article: Article = serde_json::from_str(&article_json)
        .map_err(|e| format!("Failed to parse article: {}", e))?;

    if let Some(t) = title {
        article.title = t;
    }
    if let Some(c) = content {
        article.content = c;
    }
    if let Some(s) = source_url {
        article.source_url = Some(s);
    }
    if let Some(t) = translated {
        article.translated = t;
    }

    let updated_json = serde_json::to_string(&article).unwrap();
    save_article(&app_handle, &id, &updated_json)?;

    Ok(article)
}

#[tauri::command]
pub async fn delete_article_cmd(app_handle: AppHandle, id: String) -> Result<(), String> {
    delete_article(&app_handle, &id)?;
    Ok(())
}

#[tauri::command]
pub async fn update_article_segment(
    app_handle: AppHandle,
    article_id: String,
    segment_id: String,
    explanation: Option<crate::types::SegmentExplanation>,
    reading: Option<String>,
    translation: Option<String>,
) -> Result<Article, String> {
    let article_json = load_article(&app_handle, &article_id)?;
    let mut article: Article = serde_json::from_str(&article_json)
        .map_err(|e| format!("Failed to parse article: {}", e))?;

    if let Some(segment) = article.segments.iter_mut().find(|s| s.id == segment_id) {
        if let Some(exp) = explanation {
            segment.explanation = Some(exp);
        }
        if let Some(read) = reading {
            segment.reading_text = Some(read);
        }
        if let Some(trans) = translation {
            segment.translation = Some(trans);
        }
    } else {
        return Err("Segment not found".to_string());
    }

    let updated_json = serde_json::to_string(&article).unwrap();
    save_article(&app_handle, &article_id, &updated_json)?;

    Ok(article)
}

// AI commands
#[tauri::command]
pub async fn translate_text(
    state: AppState<'_>,
    request: TranslationRequest,
) -> Result<TranslationResponse, String> {
    let ai_service = get_ai_service(&state).await?;
    ai_service.translate(request).await
}

#[tauri::command]
pub async fn analyze_text(
    state: AppState<'_>,
    request: AnalysisRequest,
) -> Result<AnalysisResponse, String> {
    let ai_service = get_ai_service(&state).await?;
    ai_service.analyze(request).await
}

#[tauri::command]
pub async fn chat_completion(
    state: AppState<'_>,
    request: ChatRequest,
) -> Result<ChatResponse, String> {
    let ai_service = get_ai_service(&state).await?;
    ai_service.chat(request).await
}

#[tauri::command]
pub async fn stream_chat_completion(
    app_handle: AppHandle,
    state: AppState<'_>,
    request: ChatRequest,
    event_id: String,
) -> Result<String, String> {
    let ai_service = get_ai_service(&state).await?;

    // Create a callback that emits events to the frontend
    let app_handle_clone = app_handle.clone();
    let event_name = format!("chat-stream://{}", event_id);

    ai_service
        .stream_chat(request, move |chunk| {
            // Emit the chunk to the frontend
            // We ignore errors here as we can't do much if emission fails
            let _ = app_handle_clone.emit(&event_name, chunk);
        })
        .await
}

#[tauri::command]
pub async fn segment_translate_explain_cmd(
    state: AppState<'_>,
    text: String,
    target_language: String,
) -> Result<crate::types::SegmentExplanation, String> {
    let ai_service = get_ai_service(&state).await?;
    ai_service
        .segment_translate_explain(text, target_language)
        .await
}

#[tauri::command]
pub async fn translate_article(
    app_handle: AppHandle,
    state: AppState<'_>,
    article_id: String,
    target_language: String,
) -> Result<Article, String> {
    let mut article = get_article(app_handle.clone(), article_id.clone()).await?;

    // Ensure segments exist
    if article.segments.is_empty() {
        article.segments = create_segments_from_content(&article.id, &article.content);
    }

    // 收集需要翻译的段落（没有翻译的）
    let untranslated: Vec<(String, String)> = article
        .segments
        .iter()
        .filter(|s| s.translation.is_none())
        .map(|s| (s.id.clone(), s.text.clone()))
        .collect();

    if !untranslated.is_empty() {
        let ai_service = get_ai_service(&state).await?;

        // 批量翻译（每批最多30条）
        const BATCH_SIZE: usize = 30;
        let total_count = untranslated.len();
        let total_chunks = (total_count + BATCH_SIZE - 1) / BATCH_SIZE;

        println!(
            "[Article] Starting quick translation for article: {}, items: {}",
            article_id, total_count
        );

        for (i, chunk) in untranslated.chunks(BATCH_SIZE).enumerate() {
            println!(
                "[Article] Translating chunk {}/{} ({} items)...",
                i + 1,
                total_chunks,
                chunk.len()
            );
            let batch_items: Vec<(String, String)> = chunk.to_vec();

            match ai_service
                .batch_translate(batch_items, &target_language)
                .await
            {
                Ok(translations) => {
                    // 将翻译结果写回对应的 segment
                    for (id, translation) in translations {
                        if let Some(seg) = article.segments.iter_mut().find(|s| s.id == id) {
                            seg.translation = Some(translation);
                        }
                    }
                    println!(
                        "[Article] Chunk {}/{} completed successfully",
                        i + 1,
                        total_chunks
                    );

                    // Emit progress event
                    let progress = serde_json::json!({
                        "current": (i + 1) * BATCH_SIZE,
                        "total": total_count,
                        "message": format!("Translating chunk {}/{}", i + 1, total_chunks)
                    });
                    let _ = app_handle
                        .emit(&format!("translation-progress://{}", article_id), progress);
                }
                Err(e) => {
                    // 批量翻译失败，记录错误但继续
                    eprintln!(
                        "[Article] Batch translation error in chunk {}/{}: {}",
                        i + 1,
                        total_chunks,
                        e
                    );
                }
            }
        }
    }

    // Emit complete event
    let _ = app_handle.emit(
        &format!("translation-progress://{}", article_id),
        serde_json::json!({
            "current": untranslated.len(),
            "total": untranslated.len(),
            "message": "Translation completed"
        }),
    );

    println!(
        "[Article] Quick translation completed for article: {}",
        article_id
    );
    article.translated = true;

    let article_json = serde_json::to_string(&article).unwrap();
    save_article(&app_handle, &article_id, &article_json)?;

    Ok(article)
}

#[tauri::command]
pub async fn analyze_article(
    app_handle: AppHandle,
    state: AppState<'_>,
    article_id: String,
    analysis_type: String,
) -> Result<String, String> {
    let article = get_article(app_handle.clone(), article_id.clone()).await?;

    let analysis_type = match analysis_type.as_str() {
        "summary" => AnalysisType::Summary,
        "key_points" => AnalysisType::KeyPoints,
        "vocabulary" => AnalysisType::Vocabulary,
        "grammar" => AnalysisType::Grammar,
        "full" => AnalysisType::FullAnalysis,
        _ => return Err("Invalid analysis type".to_string()),
    };

    let request = AnalysisRequest {
        text: article.content,
        analysis_type,
    };

    let response = analyze_text(state, request).await?;
    Ok(response.result)
}

// Return type for fetch_url_content
#[derive(serde::Serialize)]
pub struct FetchedContent {
    pub title: String,
    pub content: String,
}

// Fetch content from a URL
#[tauri::command]
pub async fn fetch_url_content(url: String) -> Result<FetchedContent, String> {
    // Validate URL
    let parsed_url = url::Url::parse(&url).map_err(|_| "Invalid URL format".to_string())?;

    // Only allow http/https
    if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
        return Err("Only HTTP and HTTPS URLs are supported".to_string());
    }

    // Create HTTP client with timeout
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Fetch the page with better headers to avoid blocking
    let response = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch URL: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }

    // Get HTML content
    // Note: readability prefers a "Cursor" or string. We'll get text first.
    let html = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    // Pre-process HTML to handle common issues (optional)
    // For now, feed directly to readability.

    // Extract content using readability
    // This removes ads, sidebars, navigation, and JS.
    let mut cursor = std::io::Cursor::new(html.as_bytes());
    let mut title = String::new();
    let mut content = String::new();

    // Try readability first
    if let Ok(extracted) =
        readability::extractor::extract(&mut cursor, &url::Url::parse(&url).unwrap())
    {
        title = extracted.title;
        content = html_to_text_preserving_layout(&extracted.content);
    }

    // Check if we got meaningful content. If not, try fallback selectors.
    // Uta-net returns very short content (e.g. "Voting thanks") via readability.
    if content.trim().len() < 200 {
        if let Some(fallback_content) = try_fallback_extraction(&html) {
            // If fallback found something substantial, use it
            if fallback_content.len() > content.len() {
                content = html_to_text_preserving_layout(&fallback_content);
                // If title was missing, try to get it again or keep old one
                if title.is_empty() {
                    title = extract_title_from_html(&html, &url);
                }
            }
        }
    }

    // Final check
    if content.trim().len() < 10 {
        if content.trim().is_empty() {
            return Err("Could not extract meaningful content. The page might be empty or require JavaScript interaction that is not supported.".to_string());
        }
    }

    // If title is still empty
    if title.is_empty() {
        title = extract_title_from_html(&html, &url);
    }

    Ok(FetchedContent { title, content })
}

// ---------------- 网页素材智能清洗 ----------------
//
// 经典模式（fetch_url_content）走 readability + 兜底选择器，规则固定，
// 遇到导航、推荐位、评论区多的站点仍会带进一堆无关文本。
// 智能模式在经典模式的结果上再过一遍模型：模型只判定"这一行是不是正文"，
// 返回要删掉的行号，正文本身一个字都不经过模型改写。

/// 送审时每行保留的字符数。噪音行通常很短，正文段落很长，
/// 截断后判断几乎不受影响，token 却能省一大截。
const WEB_CLEAN_PREVIEW_CHARS: usize = 120;
/// 单批送审的预览文本字符预算
const WEB_CLEAN_BATCH_CHARS: usize = 4000;
/// 单批送审的最大行数
const WEB_CLEAN_BATCH_LINES: usize = 80;
/// 并发请求数，兼顾速度和第三方接口的限流
const WEB_CLEAN_CONCURRENCY: usize = 3;

#[derive(serde::Serialize)]
pub struct CleanedWebContent {
    pub title: String,
    pub content: String,
    pub removed_lines: usize,
    pub removed_chars: usize,
    pub kept_lines: usize,
    /// 部分批次失败时为 true，表示只清洗了一部分
    pub partial: bool,
}

/// 行预览：截断长行并附上真实长度，让模型知道"这是一大段正文"
fn build_line_preview(line: &str) -> String {
    let trimmed = line.trim();
    let len = trimmed.chars().count();
    if len <= WEB_CLEAN_PREVIEW_CHARS {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(WEB_CLEAN_PREVIEW_CHARS).collect();
    format!("{}… (len={})", head, len)
}

/// 拼回正文：连续空行压成一个，避免整段被删后留下大片空白
fn collapse_blank_lines(lines: &[&str]) -> String {
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut blank_run = 0usize;
    for &line in lines {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        out.push(line);
    }
    out.join("\n").trim().to_string()
}

/// 把待审行按字符预算切批
fn split_clean_batches(candidates: Vec<(usize, String)>) -> Vec<Vec<(usize, String)>> {
    let mut batches: Vec<Vec<(usize, String)>> = Vec::new();
    let mut current: Vec<(usize, String)> = Vec::new();
    let mut current_chars = 0usize;

    for item in candidates {
        // +8 是行号前缀 "[123] " 和换行的粗略开销
        let cost = item.1.chars().count() + 8;
        if !current.is_empty()
            && (current.len() >= WEB_CLEAN_BATCH_LINES
                || current_chars + cost > WEB_CLEAN_BATCH_CHARS)
        {
            batches.push(std::mem::take(&mut current));
            current_chars = 0;
        }
        current_chars += cost;
        current.push(item);
    }

    if !current.is_empty() {
        batches.push(current);
    }

    batches
}

/// 用模型清洗抓取到的网页正文，只删除无关行，不改写原文。
/// `event_id` 非空时会向 `web-clean://{event_id}` 推送 `{done, total}` 进度。
#[tauri::command]
pub async fn clean_web_content_cmd(
    app_handle: AppHandle,
    state: AppState<'_>,
    title: Option<String>,
    content: String,
    event_id: Option<String>,
) -> Result<CleanedWebContent, String> {
    use futures::StreamExt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    let ai_service = get_ai_service(&state).await?;

    let lines: Vec<&str> = content.lines().collect();
    // 空行不送审，原样保留用来维持段落结构
    let candidates: Vec<(usize, String)> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(idx, line)| (idx, build_line_preview(line)))
        .collect();

    if candidates.is_empty() {
        return Err("WEB_CLEAN_NO_CONTENT".to_string());
    }

    let batches = split_clean_batches(candidates);
    let total_batches = batches.len();
    let completed = AtomicUsize::new(0);
    let progress_event = event_id.map(|id| format!("web-clean://{}", id));

    let results: Vec<Result<(Vec<usize>, Option<String>), String>> =
        futures::stream::iter(batches.into_iter().enumerate().map(|(index, batch)| {
            let ai_service = &ai_service;
            let completed = &completed;
            let progress_event = progress_event.as_ref();
            let app_handle = app_handle.clone();
            async move {
                // 只让第一批顺带给出干净标题，避免每批都重复要一次
                let result = ai_service.detect_web_noise_lines(&batch, index == 0).await;
                let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
                if let Some(event) = progress_event {
                    let _ = app_handle
                        .emit(event, serde_json::json!({ "done": done, "total": total_batches }));
                }
                result
            }
        }))
        .buffered(WEB_CLEAN_CONCURRENCY)
        .collect()
        .await;

    let mut drop_set: HashSet<usize> = HashSet::new();
    let mut suggested_title: Option<String> = None;
    let mut failures = 0usize;
    let mut last_error: Option<String> = None;

    for result in results {
        match result {
            Ok((drop, batch_title)) => {
                if suggested_title.is_none() {
                    suggested_title = batch_title;
                }
                drop_set.extend(drop);
            }
            Err(err) => {
                eprintln!("[WebClean] 批次清洗失败: {}", err);
                failures += 1;
                last_error = Some(err);
            }
        }
    }

    // 全军覆没多半是模型没配好或网络不通，报错让前端保留原文
    if failures == total_batches {
        return Err(last_error.unwrap_or_else(|| "WEB_CLEAN_FAILED".to_string()));
    }

    let mut kept: Vec<&str> = Vec::with_capacity(lines.len());
    let mut removed_lines = 0usize;
    let mut removed_chars = 0usize;
    let mut kept_lines = 0usize;

    for (idx, line) in lines.iter().enumerate() {
        if drop_set.contains(&idx) {
            removed_lines += 1;
            removed_chars += line.trim().chars().count();
            continue;
        }
        if !line.trim().is_empty() {
            kept_lines += 1;
        }
        kept.push(line);
    }

    let cleaned = collapse_blank_lines(&kept);
    if cleaned.trim().chars().count() < 10 {
        return Err("WEB_CLEAN_TOO_SHORT".to_string());
    }

    let final_title = suggested_title
        .or_else(|| {
            title
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
        })
        .unwrap_or_default();

    Ok(CleanedWebContent {
        title: final_title,
        content: cleaned,
        removed_lines,
        removed_chars,
        kept_lines,
        partial: failures > 0,
    })
}

/// Fallback extraction using CSS selectors for known difficult sites
fn try_fallback_extraction(html: &str) -> Option<String> {
    use scraper::{Html, Selector};

    let document = Html::parse_document(html);

    // List of selectors to try, in order of preference
    // #kashi_area: Uta-net
    // .lyrics_box: common lyrics class
    // #lyrics: common lyrics id
    let selectors = vec![
        "#kashi_area",
        "div[itemprop='text']", // Generic schema.org text
        ".lyrics",
        "#lyrics",
        ".post-content",
        "article",
        "main",
    ];

    for selector_str in selectors {
        if let Ok(selector) = Selector::parse(selector_str) {
            if let Some(element) = document.select(&selector).next() {
                let html_content = element.html();
                // Simple heuristic: must be at least somewhat long
                if html_content.len() > 100 {
                    return Some(html_content);
                }
            }
        }
    }

    None
}

/// Convert HTML to text, preserving significant layout (newlines)
/// Ideal for lyrics, poems, and clean articles.
fn html_to_text_preserving_layout(html: &str) -> String {
    use regex::Regex;

    // 1. Normalize newlines in source to spaces (browser behavior), we will re-add them based on tags.
    let normalized = html.replace("\r", " ").replace("\n", " ");

    // 2. Replace block tags with sentinel newlines
    // <br>, <br/> -> \n
    // <p>, <div>, <li>, <h1>-<h6>, <blockquote>, <pre> -> \n\n (surround with breaks)
    // </tr> -> \n (table rows)
    let re_br = Regex::new(r"(?i)<br\s*/?>").unwrap();
    let with_br = re_br.replace_all(&normalized, "\n");

    let re_block_start = Regex::new(r"(?i)<(p|div|h[1-6]|li|blockquote|pre|tr)[^>]*>").unwrap();
    let with_block_start = re_block_start.replace_all(&with_br, "\n"); // Add newline before block

    let re_block_end = Regex::new(r"(?i)</(p|div|h[1-6]|li|blockquote|pre|tr)>").unwrap();
    let with_block_end = re_block_end.replace_all(&with_block_start, "\n\n"); // Add double newline after block

    // 3. Strip all other tags
    let re_tags = Regex::new(r"<[^>]*>").unwrap();
    let stripped = re_tags.replace_all(&with_block_end, "");

    // 4. Decode HTML entities
    let decoded = html_escape::decode_html_entities(&stripped);

    // 5. Clean up whitespace
    // Split by newline, trim each line, filter empty lines if they are excessive (more than 2)
    // But for lyrics, we want to keep single empty lines (stanza breaks).
    let lines: Vec<&str> = decoded.lines().collect();
    let mut clean_lines = Vec::new();
    let mut empty_count = 0;

    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            empty_count += 1;
            // Allow up to 2 consecutive empty lines (paragraph break)
            if empty_count <= 2 {
                clean_lines.push("");
            }
        } else {
            empty_count = 0;
            clean_lines.push(trimmed);
        }
    }

    let result = clean_lines.join("\n");

    // Final trim of the whole text
    result.trim().to_string()
}

// Extract title from HTML
fn extract_title_from_html(html: &str, url: &str) -> String {
    let html_lower = html.to_lowercase();

    // Find <title> tag
    if let Some(start) = html_lower.find("<title>") {
        let start = start + 7; // len("<title>")
        if let Some(end) = html_lower[start..].find("</title>") {
            let title_html = &html[start..start + end];
            // Decode basic HTML entities
            let decoded = html_escape::decode_html_entities(title_html).to_string();
            let trimmed = decoded.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }

    // Fallback: extract from URL
    if let Ok(parsed) = url::Url::parse(url) {
        if let Some(segments) = parsed.path_segments() {
            let last = segments.last().unwrap_or("");
            if !last.is_empty() {
                return last
                    .replace('-', " ")
                    .replace('_', " ")
                    .split(' ')
                    .map(|s| {
                        let mut chars = s.chars();
                        match chars.next() {
                            None => String::new(),
                            Some(first) => {
                                if !first.is_alphabetic() {
                                    String::new()
                                } else {
                                    first.to_uppercase().collect::<String>() + chars.as_str()
                                }
                            }
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
            }
            return parsed.host_str().unwrap_or("Untitled").to_string();
        }
    }

    "Untitled".to_string()
}

// ============================================================================
// Favorites Commands - 收藏夹命令
// ============================================================================

/// 创建单词包
#[tauri::command]
pub async fn create_word_pack_cmd(
    app_handle: AppHandle,
    name: String,
    description: Option<String>,
    cover_url: Option<String>,
    author: Option<String>,
    language_from: Option<String>,
    language_to: Option<String>,
    tags: Option<Vec<String>>,
    version: Option<String>,
) -> Result<WordPack, String> {
    ensure_default_word_pack(&app_handle)?;

    let now = chrono::Utc::now().to_rfc3339();
    let pack = WordPack {
        id: Uuid::new_v4().to_string(),
        name: name.trim().to_string(),
        description,
        cover_url,
        author,
        language_from,
        language_to,
        tags: tags.unwrap_or_default(),
        version,
        created_at: now.clone(),
        updated_at: now,
        is_system: false,
    };

    if pack.name.is_empty() {
        return Err("Pack name is required".to_string());
    }

    let json = serde_json::to_string(&pack)
        .map_err(|e| format!("Failed to serialize word pack: {}", e))?;
    save_word_pack(&app_handle, &pack.id, &json)?;
    Ok(pack)
}

/// 更新单词包
#[tauri::command]
pub async fn update_word_pack_cmd(
    app_handle: AppHandle,
    id: String,
    name: Option<String>,
    description: Option<String>,
    cover_url: Option<String>,
    author: Option<String>,
    language_from: Option<String>,
    language_to: Option<String>,
    tags: Option<Vec<String>>,
    version: Option<String>,
) -> Result<WordPack, String> {
    let json = load_word_pack(&app_handle, &id)?;
    let mut pack: WordPack =
        serde_json::from_str(&json).map_err(|e| format!("Failed to parse word pack: {}", e))?;

    if let Some(name) = name {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Pack name is required".to_string());
        }
        pack.name = trimmed.to_string();
    }
    if description.is_some() {
        pack.description = description;
    }
    if cover_url.is_some() {
        pack.cover_url = cover_url;
    }
    if author.is_some() {
        pack.author = author;
    }
    if language_from.is_some() {
        pack.language_from = language_from;
    }
    if language_to.is_some() {
        pack.language_to = language_to;
    }
    if tags.is_some() {
        pack.tags = tags.unwrap_or_default();
    }
    if version.is_some() {
        pack.version = version;
    }

    pack.updated_at = chrono::Utc::now().to_rfc3339();

    let updated_json = serde_json::to_string(&pack)
        .map_err(|e| format!("Failed to serialize word pack: {}", e))?;
    save_word_pack(&app_handle, &pack.id, &updated_json)?;
    Ok(pack)
}

/// 列出所有单词包
#[tauri::command]
pub async fn list_word_packs_cmd(app_handle: AppHandle) -> Result<Vec<WordPack>, String> {
    ensure_default_word_pack(&app_handle)?;
    let mut packs = load_all_word_packs(&app_handle)?;
    packs.sort_by(|a, b| a.name.cmp(&b.name));
    packs.sort_by(|a, b| b.is_system.cmp(&a.is_system));
    Ok(packs)
}

/// 删除单词包（系统包不可删除）
#[tauri::command]
pub async fn delete_word_pack_cmd(app_handle: AppHandle, id: String) -> Result<(), String> {
    if id == DEFAULT_UNGROUPED_PACK_ID {
        return Err("System pack cannot be deleted".to_string());
    }

    let default_pack = ensure_default_word_pack(&app_handle)?;
    let _ = load_word_pack(&app_handle, &id)?;

    delete_word_pack(&app_handle, &id)?;

    let mut favorites = load_all_favorite_vocabularies_internal(&app_handle)?;
    for favorite in &mut favorites {
        if favorite.pack_ids.iter().any(|pack_id| pack_id == &id) {
            favorite.pack_ids.retain(|pack_id| pack_id != &id);
            if favorite.pack_ids.is_empty() {
                favorite.pack_ids.push(default_pack.id.clone());
            }
            persist_favorite_vocabulary(&app_handle, favorite)?;
        }
    }

    Ok(())
}

/// 添加单词收藏
#[tauri::command]
pub async fn add_favorite_vocabulary_cmd(
    app_handle: AppHandle,
    word: String,
    meaning: String,
    usage: String,
    explanation: Option<String>,
    example: Option<String>,
    reading: Option<String>,
    source_article_id: Option<String>,
    source_article_title: Option<String>,
    pack_ids: Option<Vec<String>>,
) -> Result<FavoriteVocabulary, String> {
    let default_pack = ensure_default_word_pack(&app_handle)?;
    let packs = load_all_word_packs(&app_handle)?;
    let existing_pack_ids: HashSet<String> = packs.into_iter().map(|p| p.id).collect();

    let normalized_input = normalize_word(&word);
    if normalized_input.is_empty() || meaning.trim().is_empty() {
        return Err("Word and meaning are required".to_string());
    }

    let mut pack_ids = filter_existing_pack_ids(
        sanitize_pack_ids(pack_ids),
        &existing_pack_ids,
        &default_pack.id,
    );

    let mut favorites = load_all_favorite_vocabularies_internal(&app_handle)?;
    if let Some(existing) = favorites
        .iter_mut()
        .find(|fav| normalize_word(&fav.word) == normalized_input)
    {
        let mut merged = existing.pack_ids.clone();
        merged.append(&mut pack_ids);
        existing.pack_ids = sanitize_pack_ids(Some(merged));
        if existing.pack_ids.is_empty() {
            existing.pack_ids.push(default_pack.id.clone());
        }

        if existing.meaning.trim().is_empty() {
            existing.meaning = meaning.clone();
        }
        if existing.usage.trim().is_empty() {
            existing.usage = usage.clone();
        }
        if existing.example.is_none() {
            existing.example = example.clone();
        }
        if existing.reading.is_none() {
            existing.reading = reading.clone();
        }
        if existing.explanation.is_none() {
            existing.explanation = explanation.clone();
        }
        if existing.source_article_id.is_none() {
            existing.source_article_id = source_article_id.clone();
        }
        if existing.source_article_title.is_none() {
            existing.source_article_title = source_article_title.clone();
        }

        persist_favorite_vocabulary(&app_handle, existing)?;
        return Ok(existing.clone());
    }

    let favorite = FavoriteVocabulary {
        id: Uuid::new_v4().to_string(),
        word: word.trim().to_string(),
        meaning: meaning.trim().to_string(),
        usage: usage.trim().to_string(),
        explanation,
        example,
        reading,
        source_article_id,
        source_article_title,
        pack_ids,
        srs_state: "new".to_string(),
        ease_factor: 2.5,
        repetitions: 0,
        interval_days: 0,
        stability: 0.0,
        difficulty: 0.0,
        scheduler_version: Some(crate::fsrs::SCHEDULER_VERSION.to_string()),
        suspended_at: None,
        due_date: today_local_date().format("%Y-%m-%d").to_string(),
        last_reviewed_at: None,
        review_count: 0,
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    persist_favorite_vocabulary(&app_handle, &favorite)?;
    Ok(favorite)
}

/// 列出所有单词收藏
#[tauri::command]
pub async fn list_favorite_vocabularies_cmd(
    app_handle: AppHandle,
) -> Result<Vec<FavoriteVocabulary>, String> {
    ensure_default_word_pack(&app_handle)?;
    migrate_favorite_vocabularies(&app_handle)?;
    let mut favorites = load_all_favorite_vocabularies_internal(&app_handle)?;

    // 按创建时间降序排列
    favorites.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(favorites)
}

/// 删除单词收藏
#[tauri::command]
pub async fn delete_favorite_vocabulary_cmd(
    app_handle: AppHandle,
    id: String,
) -> Result<(), String> {
    delete_favorite_vocabulary(&app_handle, &id)?;
    Ok(())
}

/// 设置单词收藏所属合集
#[tauri::command]
pub async fn set_vocabulary_pack_ids_cmd(
    app_handle: AppHandle,
    vocabulary_id: String,
    pack_ids: Vec<String>,
) -> Result<FavoriteVocabulary, String> {
    let default_pack = ensure_default_word_pack(&app_handle)?;
    let existing_pack_ids: HashSet<String> = list_word_packs(&app_handle)?.into_iter().collect();

    let json = load_favorite_vocabulary(&app_handle, &vocabulary_id)?;
    let mut favorite: FavoriteVocabulary = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse favorite vocabulary: {}", e))?;

    favorite.pack_ids = filter_existing_pack_ids(
        sanitize_pack_ids(Some(pack_ids)),
        &existing_pack_ids,
        &default_pack.id,
    );
    persist_favorite_vocabulary(&app_handle, &favorite)?;
    Ok(favorite)
}

/// 按合集列出单词收藏
#[tauri::command]
pub async fn list_favorite_vocabularies_by_pack_cmd(
    app_handle: AppHandle,
    pack_id: String,
) -> Result<Vec<FavoriteVocabulary>, String> {
    let mut favorites = list_favorite_vocabularies_cmd(app_handle).await?;
    if pack_id != "all" {
        favorites.retain(|fav| fav.pack_ids.iter().any(|id| id == &pack_id));
    }
    favorites.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(favorites)
}

/// 获取指定日期到期的背诵队列
#[tauri::command]
pub async fn get_due_vocabulary_queue_cmd(
    app_handle: AppHandle,
    pack_id: String,
    date_local: String,
) -> Result<Vec<FavoriteVocabulary>, String> {
    let config = load_config(&app_handle)?.unwrap_or_default();
    let all = list_favorite_vocabularies_cmd(app_handle).await?;
    build_due_vocabulary_queue(
        all,
        &pack_id,
        &date_local,
        config.srs_daily_new_limit,
        config.srs_daily_review_limit,
    )
}

/// 复习单词并更新 FSRS 状态(规范 §2.5),同时追加一条不可变复习事件(§1.3)。
#[tauri::command]
pub async fn review_vocabulary_cmd(
    app_handle: AppHandle,
    vocabulary_id: String,
    grade: String,
    date_local: String,
) -> Result<FavoriteVocabulary, String> {
    let review_date = parse_local_date(&date_local)?;
    let config = load_config(&app_handle)?.unwrap_or_default();
    let desired_retention = config.srs_desired_retention;

    let json = load_favorite_vocabulary(&app_handle, &vocabulary_id)?;
    let mut favorite: FavoriteVocabulary = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse favorite vocabulary: {}", e))?;

    let grade_value = crate::fsrs::grade_from_str(&grade)?;
    let previous_state = favorite.srs_state.clone();
    let elapsed_days = if favorite.stability == 0.0 && favorite.difficulty == 0.0 {
        0 // new 卡首评
    } else {
        elapsed_days_for_review(&favorite, review_date)
    };

    let next = crate::fsrs::next_review(
        favorite.stability,
        favorite.difficulty,
        elapsed_days,
        grade_value,
        desired_retention,
    )?;

    favorite.srs_state = next.srs_state.clone();
    favorite.stability = next.stability;
    favorite.difficulty = next.difficulty;
    favorite.scheduler_version = Some(crate::fsrs::SCHEDULER_VERSION.to_string());
    // 同日巩固步骤(规范 §2.8):只有 Good/Easy 才把到期日推到未来,
    // 与同步重放(sync::replay::due_date_for)保持一致。
    favorite.due_date =
        crate::sync::replay::due_date_for(grade_value, next.interval_days, review_date);
    let reviewed_at = chrono::Utc::now().to_rfc3339();
    favorite.last_reviewed_at = Some(reviewed_at.clone());
    favorite.review_count += 1;

    let event = crate::types::ReviewEvent {
        id: Uuid::new_v4().to_string(),
        card_id: favorite.id.clone(),
        reviewed_at,
        date_local: date_local.clone(),
        grade: grade_value,
        elapsed_days,
        previous_state,
        scheduler_version: crate::fsrs::SCHEDULER_VERSION.to_string(),
        desired_retention,
        result_stability: next.stability,
        result_difficulty: next.difficulty,
        result_interval_days: next.interval_days,
        result_state: next.srs_state,
    };
    crate::storage::append_review_event(&app_handle, &event)?;

    persist_favorite_vocabulary(&app_handle, &favorite)?;
    Ok(favorite)
}

/// 编辑单词收藏(手动编辑词形/释义/例句等)。
/// 改词形时:若与其他卡片撞 normalized_word,报错让用户改用合并(删除+加入既有卡)。
#[tauri::command]
pub async fn update_favorite_vocabulary_cmd(
    app_handle: AppHandle,
    vocabulary_id: String,
    word: String,
    meaning: String,
    usage: Option<String>,
    explanation: Option<String>,
    example: Option<String>,
    reading: Option<String>,
) -> Result<FavoriteVocabulary, String> {
    let normalized_input = normalize_word(&word);
    if normalized_input.is_empty() || meaning.trim().is_empty() {
        return Err("Word and meaning are required".to_string());
    }

    let json = load_favorite_vocabulary(&app_handle, &vocabulary_id)?;
    let mut favorite: FavoriteVocabulary = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse favorite vocabulary: {}", e))?;

    if normalize_word(&favorite.word) != normalized_input {
        let favorites = load_all_favorite_vocabularies_internal(&app_handle)?;
        if favorites
            .iter()
            .any(|fav| fav.id != vocabulary_id && normalize_word(&fav.word) == normalized_input)
        {
            return Err("DUPLICATE_WORD".to_string());
        }
    }

    favorite.word = word.trim().to_string();
    favorite.meaning = meaning.trim().to_string();
    favorite.usage = usage.unwrap_or_default().trim().to_string();
    favorite.explanation = explanation.filter(|s| !s.trim().is_empty());
    favorite.example = example.filter(|s| !s.trim().is_empty());
    favorite.reading = reading.filter(|s| !s.trim().is_empty());

    persist_favorite_vocabulary(&app_handle, &favorite)?;
    Ok(favorite)
}

/// 标记已掌握(暂停复习)/ 恢复复习。FSRS 状态不动(规范 §3)。
#[tauri::command]
pub async fn set_vocabulary_suspended_cmd(
    app_handle: AppHandle,
    vocabulary_id: String,
    suspended: bool,
) -> Result<FavoriteVocabulary, String> {
    let json = load_favorite_vocabulary(&app_handle, &vocabulary_id)?;
    let mut favorite: FavoriteVocabulary = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse favorite vocabulary: {}", e))?;

    favorite.suspended_at = if suspended {
        Some(chrono::Utc::now().to_rfc3339())
    } else {
        None
    };

    persist_favorite_vocabulary(&app_handle, &favorite)?;
    Ok(favorite)
}

/// 复习统计(规范 §6):今日新学/复习、连续打卡、状态分布。
#[tauri::command]
pub async fn get_review_stats_cmd(
    app_handle: AppHandle,
    pack_id: String,
    date_local: String,
) -> Result<crate::types::ReviewStats, String> {
    parse_local_date(&date_local)?;
    let cards = list_favorite_vocabularies_cmd(app_handle.clone()).await?;
    let events = crate::storage::list_review_events(&app_handle)?;
    Ok(build_review_stats(&cards, &events, &pack_id, &date_local))
}

/// 导出单词包为 OpenKoto JSON 包
#[tauri::command]
pub async fn export_word_pack_cmd(
    app_handle: AppHandle,
    pack_id: String,
) -> Result<ExportWordPackResult, String> {
    if pack_id == "all" {
        let entries = load_all_favorite_vocabularies_internal(&app_handle)?
            .into_iter()
            .map(favorite_to_word_pack_export_entry)
            .collect();

        return build_word_pack_export_result(
            WordPackExportMeta {
                name: "全部单词".to_string(),
                description: Some("所有收藏单词".to_string()),
                cover_url: None,
                author: None,
                language_from: None,
                language_to: None,
                tags: Vec::new(),
                version: Some("1.0.0".to_string()),
            },
            entries,
        );
    }

    let pack_json = load_word_pack(&app_handle, &pack_id)?;
    let pack: WordPack = serde_json::from_str(&pack_json)
        .map_err(|e| format!("Failed to parse word pack: {}", e))?;

    let entries: Vec<WordPackExportEntry> =
        list_favorite_vocabularies_by_pack_cmd(app_handle.clone(), pack_id)
            .await?
            .into_iter()
            .map(favorite_to_word_pack_export_entry)
            .collect();

    build_word_pack_export_result(
        WordPackExportMeta {
            name: pack.name.clone(),
            description: pack.description.clone(),
            cover_url: pack.cover_url.clone(),
            author: pack.author.clone(),
            language_from: pack.language_from.clone(),
            language_to: pack.language_to.clone(),
            tags: pack.tags.clone(),
            version: pack.version.clone(),
        },
        entries,
    )
}

/// 导入 OpenKoto JSON 单词包
#[tauri::command]
pub async fn import_word_pack_cmd(
    app_handle: AppHandle,
    json_content: String,
) -> Result<ImportWordPackResult, String> {
    let default_pack = ensure_default_word_pack(&app_handle)?;
    let parsed = parse_import_word_pack_json(&json_content)?;

    if parsed.entries.len() > 20000 {
        return Err("Word pack is too large (max 20000 entries)".to_string());
    }

    let now = chrono::Utc::now().to_rfc3339();
    let pack = WordPack {
        id: Uuid::new_v4().to_string(),
        name: if parsed.pack.name.trim().is_empty() {
            "Imported Pack".to_string()
        } else {
            parsed.pack.name.trim().to_string()
        },
        description: parsed.pack.description.clone(),
        cover_url: parsed.pack.cover_url.clone(),
        author: parsed.pack.author.clone(),
        language_from: parsed.pack.language_from.clone(),
        language_to: parsed.pack.language_to.clone(),
        tags: parsed.pack.tags.clone(),
        version: parsed.pack.version.clone(),
        created_at: now.clone(),
        updated_at: now,
        is_system: false,
    };

    let pack_json = serde_json::to_string(&pack)
        .map_err(|e| format!("Failed to serialize word pack: {}", e))?;
    save_word_pack(&app_handle, &pack.id, &pack_json)?;

    let mut existing_by_word: HashMap<String, FavoriteVocabulary> =
        load_all_favorite_vocabularies_internal(&app_handle)?
            .into_iter()
            .filter_map(|fav| {
                let normalized = normalize_word(&fav.word);
                if normalized.is_empty() {
                    None
                } else {
                    Some((normalized, fav))
                }
            })
            .collect();
    let mut file_seen_words = HashSet::new();

    let total = parsed.entries.len();
    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut errors = Vec::new();

    for (index, entry) in parsed.entries.into_iter().enumerate() {
        let word = entry.word.trim().to_string();
        let meaning = entry.meaning.trim().to_string();
        if word.is_empty() || meaning.is_empty() {
            skipped += 1;
            errors.push(format!("Entry {} missing required word/meaning", index + 1));
            continue;
        }

        let normalized = normalize_word(&word);
        if file_seen_words.contains(&normalized) {
            skipped += 1;
            continue;
        }

        file_seen_words.insert(normalized.clone());

        let usage = entry.usage.unwrap_or_default();
        let example = entry.example;
        let reading = entry.reading;
        let explanation = entry.explanation;

        if let Some(existing) = existing_by_word.get_mut(&normalized) {
            let mut merged_pack_ids = existing.pack_ids.clone();
            merged_pack_ids.push(pack.id.clone());
            existing.pack_ids = sanitize_pack_ids(Some(merged_pack_ids));
            if existing.pack_ids.is_empty() {
                existing.pack_ids.push(default_pack.id.clone());
            }

            if existing.meaning.trim().is_empty() {
                existing.meaning = meaning;
            }
            if existing.usage.trim().is_empty() {
                existing.usage = usage;
            }
            if existing.example.is_none() {
                existing.example = example;
            }
            if existing.reading.is_none() {
                existing.reading = reading;
            }
            if existing.explanation.is_none() {
                existing.explanation = explanation;
            }

            if let Err(e) = persist_favorite_vocabulary(&app_handle, existing) {
                skipped += 1;
                errors.push(format!("Entry {} failed to merge: {}", index + 1, e));
                continue;
            }

            imported += 1;
            continue;
        }

        let favorite = FavoriteVocabulary {
            id: Uuid::new_v4().to_string(),
            word,
            meaning,
            usage,
            explanation,
            example,
            reading,
            source_article_id: None,
            source_article_title: None,
            pack_ids: vec![pack.id.clone()],
            srs_state: "new".to_string(),
            ease_factor: 2.5,
            repetitions: 0,
            interval_days: 0,
            stability: 0.0,
            difficulty: 0.0,
            scheduler_version: Some(crate::fsrs::SCHEDULER_VERSION.to_string()),
            suspended_at: None,
            due_date: today_local_date().format("%Y-%m-%d").to_string(),
            last_reviewed_at: None,
            review_count: 0,
            created_at: chrono::Utc::now().to_rfc3339(),
        };

        if let Err(e) = persist_favorite_vocabulary(&app_handle, &favorite) {
            skipped += 1;
            errors.push(format!("Entry {} failed to import: {}", index + 1, e));
            continue;
        }

        existing_by_word.insert(normalized, favorite.clone());
        imported += 1;
    }

    Ok(ImportWordPackResult {
        created_pack_id: pack.id,
        total,
        imported,
        skipped,
        errors,
    })
}

/// 添加语法收藏
#[tauri::command]
pub async fn add_favorite_grammar_cmd(
    app_handle: AppHandle,
    point: String,
    explanation: String,
    example: Option<String>,
    source_article_id: Option<String>,
    source_article_title: Option<String>,
) -> Result<FavoriteGrammar, String> {
    let favorite = FavoriteGrammar {
        id: Uuid::new_v4().to_string(),
        point,
        explanation,
        example,
        source_article_id,
        source_article_title,
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    let json = serde_json::to_string(&favorite)
        .map_err(|e| format!("Failed to serialize favorite: {}", e))?;
    save_favorite_grammar(&app_handle, &favorite.id, &json)?;

    Ok(favorite)
}

/// 列出所有语法收藏
#[tauri::command]
pub async fn list_favorite_grammars_cmd(
    app_handle: AppHandle,
) -> Result<Vec<FavoriteGrammar>, String> {
    let ids = list_favorite_grammars(&app_handle)?;
    let mut favorites = Vec::new();

    for id in ids {
        if let Ok(json) = load_favorite_grammar(&app_handle, &id) {
            if let Ok(favorite) = serde_json::from_str::<FavoriteGrammar>(&json) {
                favorites.push(favorite);
            }
        }
    }

    // 按创建时间降序排列
    favorites.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(favorites)
}

/// 删除语法收藏
#[tauri::command]
pub async fn delete_favorite_grammar_cmd(app_handle: AppHandle, id: String) -> Result<(), String> {
    delete_favorite_grammar(&app_handle, &id)?;
    Ok(())
}

// YouTube Import
#[tauri::command]
pub async fn import_youtube_video_cmd(
    app_handle: AppHandle,
    url: String,
) -> Result<Article, String> {
    let article = crate::youtube::import_youtube_video(app_handle.clone(), url).await?;

    let article_json = serde_json::to_string(&article)
        .map_err(|e| format!("Failed to serialize article: {}", e))?;
    save_article(&app_handle, &article.id, &article_json)?;

    Ok(article)
}

/// 判断容器格式是否无法被 WebView(macOS WebKit / Windows WebView2)直接播放,
/// 需要在导入时用 FFmpeg 转封装为 MP4。mp4/mov/webm 等不在此列。
fn needs_remux_container(ext: &str) -> bool {
    matches!(
        ext.to_lowercase().as_str(),
        "mkv" | "avi" | "wmv" | "flv" | "ts" | "m2ts" | "mpg" | "mpeg" | "vob"
    )
}

/// 用打包的 FFmpeg 将 WebView 不支持的容器转封装为 MP4:
/// 视频流 copy(不重编码),音频转 AAC 保证浏览器兼容,多音轨取第一条。
async fn remux_video_to_mp4(
    app_handle: &AppHandle,
    src: &std::path::Path,
    dest: &std::path::Path,
) -> Result<(), String> {
    let src_str = src.to_str().ok_or("Invalid source file path")?;
    let dest_str = dest.to_str().ok_or("Invalid destination file path")?;

    let output = run_ffmpeg(
        app_handle,
        vec![
            "-y".to_string(),
            "-i".to_string(),
            src_str.to_string(),
            "-map".to_string(),
            "0:v:0".to_string(),
            "-map".to_string(),
            "0:a:0?".to_string(),
            "-c:v".to_string(),
            "copy".to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            "192k".to_string(),
            "-movflags".to_string(),
            "+faststart".to_string(),
            dest_str.to_string(),
        ],
    )
    .await?;

    if !output.success {
        let _ = std::fs::remove_file(dest);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail = stderr
            .lines()
            .rev()
            .take(5)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!(
            "Failed to convert video to MP4 (the video codec may not be supported). FFmpeg output: {}",
            tail
        ));
    }

    if !dest.exists() {
        return Err("Failed to convert video to MP4: output file was not created".to_string());
    }

    Ok(())
}

/// 尝试从源视频中抽取第一条内嵌文本字幕流为 SRT。
/// 失败(无字幕流/图像字幕等)仅记录日志,不阻塞导入。
async fn try_extract_embedded_subtitles(
    app_handle: &AppHandle,
    src: &std::path::Path,
    dest: &std::path::Path,
) -> Option<PathBuf> {
    let (Some(src_str), Some(dest_str)) = (src.to_str(), dest.to_str()) else {
        return None;
    };

    let output = run_ffmpeg(
        app_handle,
        vec![
            "-y".to_string(),
            "-i".to_string(),
            src_str.to_string(),
            "-map".to_string(),
            "0:s:0".to_string(),
            "-c:s".to_string(),
            "srt".to_string(),
            dest_str.to_string(),
        ],
    )
    .await;

    match output {
        Ok(out)
            if out.success
                && dest.exists()
                && std::fs::metadata(dest).map(|m| m.len() > 0).unwrap_or(false) =>
        {
            Some(dest.to_path_buf())
        }
        Ok(out) => {
            let _ = std::fs::remove_file(dest);
            println!(
                "[Import] No extractable embedded text subtitle stream: {}",
                String::from_utf8_lossy(&out.stderr)
                    .lines()
                    .last()
                    .unwrap_or("")
            );
            None
        }
        Err(e) => {
            println!("[Import] Failed to extract embedded subtitles: {}", e);
            None
        }
    }
}

#[tauri::command]
pub async fn import_local_video_cmd(
    app_handle: AppHandle,
    file_path: String,
    subtitle_path: Option<String>,
) -> Result<Article, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let videos_dir = app_data_dir.join("videos");
    if !videos_dir.exists() {
        std::fs::create_dir_all(&videos_dir)
            .map_err(|e| format!("Failed to create videos dir: {}", e))?;
    }

    let src_path = std::path::Path::new(&file_path);
    if !src_path.exists() {
        return Err("Source file does not exist".to_string());
    }

    let file_name = src_path
        .file_name()
        .ok_or("Invalid file name")?
        .to_string_lossy();

    let ext = src_path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_else(|| "mp4".to_string());

    let id = Uuid::new_v4().to_string();

    let is_audio = matches!(
        ext.to_lowercase().as_str(),
        "mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" | "wma"
    );

    let mut subtitle_path = subtitle_path;

    let dest_path = if !is_audio && needs_remux_container(&ext) {
        // WebView 不支持该容器(如 mkv/avi):转封装为 mp4,标题仍用原文件名
        let dest_path = videos_dir.join(format!("{}.mp4", id));
        remux_video_to_mp4(&app_handle, src_path, &dest_path).await?;

        // 用户未手动选字幕时,尝试抽取内嵌字幕并复用现有字幕导入管线
        if subtitle_path.is_none() {
            let srt_path = videos_dir.join(format!("{}.srt", id));
            if let Some(path) =
                try_extract_embedded_subtitles(&app_handle, src_path, &srt_path).await
            {
                subtitle_path = Some(path.to_string_lossy().into_owned());
            }
        }

        dest_path
    } else {
        let dest_name = format!("{}.{}", id, ext);
        let dest_path = videos_dir.join(&dest_name);
        std::fs::copy(src_path, &dest_path).map_err(|e| format!("Failed to copy file: {}", e))?;
        dest_path
    };

    let created_at = chrono::Utc::now().to_rfc3339();

    // Initial content placeholder
    let content = if is_audio {
        format!("[Audio Import] {}", file_name)
    } else {
        format!("[Local Import] {}", file_name)
    };

    let mut article = Article {
        id: id.clone(),
        title: file_name.into_owned(),
        content,
        source_type: Some(if is_audio {
            "audio".to_string()
        } else {
            "local_video".to_string()
        }),
        source_url: Some(format!("file://{}", file_path)),
        media_path: Some(dest_path.to_string_lossy().into_owned()),
        book_path: None,
        book_type: None,
        created_at,
        translated: false,
        active_mind_map_artifact_id: None,
        segments: Vec::new(),
    };

    if let Some(subtitle_path) = subtitle_path {
        import_subtitles_into_article(&mut article, std::path::Path::new(&subtitle_path))?;
    }

    let article_json = serde_json::to_string(&article)
        .map_err(|e| format!("Failed to serialize article: {}", e))?;
    save_article(&app_handle, &id, &article_json)?;

    Ok(article)
}

#[tauri::command]
pub async fn import_article_subtitles_cmd(
    app_handle: AppHandle,
    article_id: String,
    subtitle_path: String,
) -> Result<Article, String> {
    let article_json = load_article(&app_handle, &article_id)?;
    let mut article: Article = serde_json::from_str(&article_json)
        .map_err(|e| format!("Failed to parse article: {}", e))?;

    if article.media_path.is_none() {
        return Err("仅媒体素材支持导入字幕".to_string());
    }

    import_subtitles_into_article(&mut article, std::path::Path::new(&subtitle_path))?;

    let article_json = serde_json::to_string(&article)
        .map_err(|e| format!("Failed to serialize article: {}", e))?;
    save_article(&app_handle, &article_id, &article_json)?;

    Ok(article)
}

#[tauri::command]
pub async fn import_srt_file_cmd(
    app_handle: AppHandle,
    file_path: String,
    title: Option<String>,
) -> Result<Article, String> {
    let path = std::path::Path::new(&file_path);
    let is_lrc = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("lrc"))
        .unwrap_or(false);
    if is_lrc {
        return import_lrc_file(&app_handle, path, title);
    }
    let article = create_article_from_srt(path, title)?;
    let article_json = serde_json::to_string(&article)
        .map_err(|e| format!("Failed to serialize article: {}", e))?;
    save_article(&app_handle, &article.id, &article_json)?;
    Ok(article)
}

/// .lrc → lyrics article (timed segments) + LyricsMeta (artist / album / offset), both synced.
fn import_lrc_file(
    app_handle: &AppHandle,
    path: &std::path::Path,
    title: Option<String>,
) -> Result<Article, String> {
    let (article, parsed) = crate::lyrics::create_article_from_lrc(path, title)?;
    let article_json = serde_json::to_string(&article)
        .map_err(|e| format!("Failed to serialize article: {}", e))?;
    save_article(app_handle, &article.id, &article_json)?;
    let meta = crate::db::books::LyricsMeta {
        article_id: article.id.clone(),
        artist: parsed.meta.artist.clone(),
        album: parsed.meta.album.clone(),
        language: None,
        lrc_offset_ms: parsed.meta.offset_ms,
        source_format: Some(parsed.format.clone()),
        cover_url: None,
    };
    crate::storage::database(app_handle)?.write(|tx| {
        crate::db::books::save_lyrics_meta(tx, &meta, crate::db::repo::Track::Record)
    })?;
    crate::sync::notify_local_change();
    Ok(article)
}

/// Reading position of a book (`book_id` = the desktop book article id).
#[tauri::command]
pub async fn get_book_progress_cmd(
    app_handle: AppHandle,
    book_id: String,
) -> Result<Option<crate::db::books::BookProgress>, String> {
    crate::storage::database(&app_handle)?
        .read(|c| crate::db::books::load_progress(c, &book_id.to_lowercase()))
}

/// Save the reading position (EPUB CFI and/or PDF page); synced as BookProgress.
#[tauri::command]
pub async fn save_book_progress_cmd(
    app_handle: AppHandle,
    book_id: String,
    locator: Option<String>,
    page_number: Option<i64>,
    chapter_index: Option<i64>,
) -> Result<(), String> {
    let book_id = book_id.to_lowercase();
    let db = crate::storage::database(&app_handle)?;
    let changed = db.write(|tx| {
        let previous = crate::db::books::load_progress(tx, &book_id)?;
        let progress = crate::db::books::BookProgress {
            book_id: book_id.clone(),
            chapter_index: chapter_index
                .or_else(|| page_number.map(|p| (p - 1).max(0)))
                .or(previous.as_ref().map(|p| p.chapter_index))
                .unwrap_or(0),
            mode: previous.as_ref().map(|p| p.mode.clone()).unwrap_or_else(|| "native".into()),
            locator: locator.clone().or(previous.as_ref().and_then(|p| p.locator.clone())),
            page_number: page_number.or(previous.as_ref().and_then(|p| p.page_number)),
            updated_at: chrono::Utc::now().to_rfc3339(),
            ..Default::default()
        };
        crate::db::books::save_progress(tx, &progress, crate::db::repo::Track::Record)
    })?;
    if changed {
        crate::sync::notify_local_change();
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
pub struct LegacyProgressEntry {
    pub key: String,
    pub value: String,
}

/// Book id from a reader URL / path: `…/book/<id>.<ext>` → `<id>` (UUIDs only).
pub fn book_id_from_path(path: &str) -> Option<String> {
    let decoded = urlencoding::decode(path).map(|c| c.into_owned()).unwrap_or_else(|_| path.to_string());
    let file = decoded.rsplit(['/', '\\']).next()?;
    let stem = file.split('.').next()?;
    uuid::Uuid::parse_str(stem).ok().map(|u| u.to_string())
}

/// One-time import of the old localStorage progress (`epub-location-<url>`, `pdf-page-<url>`).
/// Existing (e.g. synced) progress is never overwritten. Returns how many were imported.
#[tauri::command]
pub async fn migrate_book_progress_cmd(
    app_handle: AppHandle,
    entries: Vec<LegacyProgressEntry>,
) -> Result<usize, String> {
    let db = crate::storage::database(&app_handle)?;
    let imported = db.write(|tx| {
        let mut n = 0;
        for e in &entries {
            let (book_path, locator, page) = if let Some(p) = e.key.strip_prefix("epub-location-") {
                (p, Some(e.value.clone()), None)
            } else if let Some(p) = e.key.strip_prefix("pdf-page-") {
                (p, None, e.value.trim().parse::<i64>().ok())
            } else {
                continue;
            };
            let Some(book_id) = book_id_from_path(book_path) else { continue };
            if crate::db::books::load_progress(tx, &book_id)?.is_some() {
                continue;
            }
            let progress = crate::db::books::BookProgress {
                book_id,
                chapter_index: page.map(|p| (p - 1).max(0)).unwrap_or(0),
                mode: "native".into(),
                locator,
                page_number: page,
                updated_at: chrono::Utc::now().to_rfc3339(),
                ..Default::default()
            };
            if crate::db::books::save_progress(tx, &progress, crate::db::repo::Track::Record)? {
                n += 1;
            }
        }
        Ok(n)
    })?;
    if imported > 0 {
        crate::sync::notify_local_change();
    }
    Ok(imported)
}

#[tauri::command]
pub async fn prepare_ktv_segments_cmd(
    app_handle: AppHandle,
    article_id: String,
    language_hint: Option<String>,
) -> Result<Article, String> {
    let article_json = load_article(&app_handle, &article_id)?;
    let article: Article = serde_json::from_str(&article_json)
        .map_err(|e| format!("Failed to parse article: {}", e))?;

    let prepared = prepare_ktv_segments(article, language_hint.as_deref())?;
    let prepared_json = serde_json::to_string(&prepared)
        .map_err(|e| format!("Failed to serialize article: {}", e))?;

    save_article(&app_handle, &article_id, &prepared_json)?;

    Ok(prepared)
}

#[tauri::command]
pub async fn export_ktv_video_cmd(
    app_handle: AppHandle,
    article_id: String,
    output_path: String,
    config: KtvExportConfig,
) -> Result<KtvExportResult, String> {
    let article_json = load_article(&app_handle, &article_id)?;
    let article: Article = serde_json::from_str(&article_json)
        .map_err(|e| format!("Failed to parse article: {}", e))?;

    export_ktv_video(
        &app_handle,
        &article,
        &config,
        std::path::Path::new(&output_path),
    )
    .await
}

// 字幕提取
/// 提取视频字幕
/// 使用 Gemini 多模态 API 从视频中提取音频并转录为字幕
#[tauri::command]
pub async fn extract_subtitles_cmd(
    app_handle: AppHandle,
    article_id: String,
    transcription_config_id: Option<String>,
) -> Result<Article, String> {
    println!(
        "[ExtractSubtitles] 开始提取字幕: {} (transcription_config_id={:?})",
        article_id, transcription_config_id
    );

    // 1. 加载文章
    let article_json = load_article(&app_handle, &article_id)?;
    let mut article: Article = serde_json::from_str(&article_json)
        .map_err(|e| format!("Failed to parse article: {}", e))?;

    // 2. 验证是视频并获取视频路径
    let video_path = article
        .media_path
        .as_ref()
        .ok_or("该文章不是视频，无法提取字幕")?;
    let video_path = std::path::Path::new(video_path);

    if !video_path.exists() {
        return Err(format!("视频文件不存在: {:?}", video_path));
    }

    // 3. 获取 API 配置
    let mut config = load_config(&app_handle)?.ok_or("未配置 API，请先在设置中配置 AI 模型")?;

    // 旧的 Gemini/Kimi「LLM 听写」回退路径解析（沿用激活对话模型 + 白名单校验）
    let resolve_llm = |config: &crate::types::AppConfig| -> Result<(String, String, String, Option<String>, bool), String> {
        let active_config = config.get_active_config().ok_or(
            "未配置字幕转写模型。请在 设置 → 字幕转写 添加一个转写模型（推荐 302ai whisper-1），或切换到 Gemini/Kimi 模型。",
        )?;
        let provider = active_config.api_provider.clone();
        let model = active_config.model.clone();
        if provider == "ollama" || provider == "lmstudio" {
            return Err(
                "字幕提取暂不支持 Ollama / LM Studio 本地模型。请在 设置 → 字幕转写 配置转写模型，或切换到 Gemini/Kimi。"
                    .to_string(),
            );
        }
        let is_supported = model.contains("gemini")
            || model.starts_with("google/gemini")
            || provider == "google"
            || provider == "google-ai-studio"
            || (is_moonshot_provider(&provider) && model.contains("kimi"))
            || model.contains("kimi");
        if !is_supported {
            return Err(
                "未配置字幕转写模型。请在 设置 → 字幕转写 添加一个转写模型（推荐 302ai whisper-1），或切换到 Gemini/Kimi 模型。"
                    .to_string(),
            );
        }
        Ok((provider, active_config.api_key.clone(), model, active_config.base_url.clone(), false))
    };

    // "__llm__" 哨兵 = 强制走旧的 Gemini/Kimi 听写；真实 id = 指定 ASR 配置；None = 默认。
    const LLM_SENTINEL: &str = "__llm__";
    let force_llm = transcription_config_id.as_deref() == Some(LLM_SENTINEL);
    let explicit_asr_id: Option<String> = match transcription_config_id.as_deref() {
        Some(LLM_SENTINEL) | None => None,
        Some(id) if id.is_empty() => None,
        Some(id) => Some(id.to_string()),
    };

    let (provider, api_key, model, base_url, use_asr): (String, String, String, Option<String>, bool) =
        if let Some(id) = explicit_asr_id {
            // 菜单显式选了某个转写模型
            let asr = config
                .asr_configs
                .iter()
                .find(|c| c.id == id)
                .ok_or("所选转写模型不存在，请在 设置 → 字幕转写 重新选择。")?;
            let picked = (
                asr.api_provider.clone(),
                asr.api_key.clone(),
                asr.model.clone(),
                asr.base_url.clone(),
                true,
            );
            // 记为默认（设为激活）并落盘
            if config.active_asr_model_id.as_deref() != Some(id.as_str()) {
                config.active_asr_model_id = Some(id.clone());
                if let Err(e) = save_config(&app_handle, &config) {
                    println!("[ExtractSubtitles] 保存激活转写配置失败: {}", e);
                }
            }
            picked
        } else if force_llm {
            resolve_llm(&config)?
        } else if let Some(asr) = config.get_active_asr_config() {
            (
                asr.api_provider.clone(),
                asr.api_key.clone(),
                asr.model.clone(),
                asr.base_url.clone(),
                true,
            )
        } else {
            resolve_llm(&config)?
        };

    // 4. 调用字幕提取模块 (使用 article_id 作为 event_id)
    let segments = crate::subtitle_extraction::extract_subtitles(
        app_handle.clone(),
        video_path,
        &article_id,
        &provider,
        &api_key,
        &model,
        base_url.as_deref(),
        use_asr,
        &article_id, // event_id 用于进度事件
    )
    .await?;

    if segments.is_empty() {
        return Err("未能从视频中提取到字幕内容".to_string());
    }

    println!("[ExtractSubtitles] 提取到 {} 个字幕片段", segments.len());

    // 5. 更新文章内容
    article.segments = segments;
    article.content = article
        .segments
        .iter()
        .map(|s| s.text.clone())
        .collect::<Vec<_>>()
        .join(" ");

    // 6. 保存文章
    let updated_json = serde_json::to_string(&article)
        .map_err(|e| format!("Failed to serialize article: {}", e))?;
    save_article(&app_handle, &article_id, &updated_json)?;

    println!("[ExtractSubtitles] 字幕提取完成并保存");

    Ok(article)
}

// ============================================================================
// 书籍导入功能 - 支持 EPUB、TXT 和 PDF 格式
// ============================================================================

const BOOKS_DIR: &str = "books";

/// 读取 TXT 文件内容，UTF-8 优先，非 UTF-8 时自动检测编码（GBK/GB2312/Big5 等）。
/// 中文小说 txt 常见 GBK 编码，直接 read_to_string 会失败。
pub(crate) fn read_txt_decoded(path: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败: {}", e))?;

    // 去掉 UTF-8 BOM 的快速路径
    if let Some(s) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]) {
        return Ok(String::from_utf8_lossy(s).into_owned());
    }
    if let Ok(s) = std::str::from_utf8(&bytes) {
        return Ok(s.to_string());
    }
    // GB18030 与 Big5 的双字节编码区间重叠，固定顺序解码会把 Big5 误判成 GBK，
    // 因此用 chardetng 做频率分析检测；检测解码失败再回退 GB18030 宽松解码。
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(&bytes, true);
    let encoding = detector.guess(None, true);
    let (cow, _, had_errors) = encoding.decode(&bytes);
    if had_errors {
        let (cow, _, _) = encoding_rs::GB18030.decode(&bytes);
        return Ok(cow.into_owned());
    }
    Ok(cow.into_owned())
}

/// 读取已导入书籍的纯文本内容（供前端自愈旧占位符数据）
#[tauri::command]
pub async fn read_book_text_cmd(book_path: String) -> Result<String, String> {
    let path = std::path::Path::new(&book_path);
    if !path.exists() {
        return Err(format!("文件不存在: {}", book_path));
    }
    read_txt_decoded(path)
}

/// 确保书籍存储目录存在
fn ensure_books_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;

    let books_dir = app_data_dir.join(BOOKS_DIR);
    if !books_dir.exists() {
        std::fs::create_dir_all(&books_dir).map_err(|e| format!("创建书籍目录失败: {}", e))?;
    }

    Ok(books_dir)
}

/// 导入书籍文件 (EPUB/TXT/PDF)
/// 将文件复制到应用数据目录并创建 Article 记录
#[tauri::command]
pub async fn import_book_cmd(
    app_handle: AppHandle,
    file_path: String,
    title: Option<String>,
) -> Result<Article, String> {
    use std::path::Path;

    let src_path = Path::new(&file_path);

    // 验证文件存在
    if !src_path.exists() {
        return Err(format!("文件不存在: {}", file_path));
    }

    // 获取文件扩展名并验证格式
    let ext = src_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .ok_or("无法识别文件格式")?;

    let book_type = match ext.as_str() {
        "epub" => "epub",
        "txt" => "txt",
        "pdf" => "pdf",
        _ => return Err(format!("不支持的文件格式: {}", ext)),
    };

    // 获取文件名作为默认标题
    let file_name = src_path
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("未命名书籍");

    let book_title = title.unwrap_or_else(|| file_name.to_string());

    // 确保书籍目录存在
    let books_dir = ensure_books_dir(&app_handle)?;

    // 生成唯一 ID 和目标路径
    let id = Uuid::new_v4().to_string();
    let dest_name = format!("{}.{}", id, ext);
    let dest_path = books_dir.join(&dest_name);

    // 复制文件到应用数据目录
    std::fs::copy(src_path, &dest_path).map_err(|e| format!("复制文件失败: {}", e))?;

    let created_at = chrono::Utc::now().to_rfc3339();

    // 读取 TXT 文件内容作为 content，EPUB/PDF 使用占位符
    let content = match book_type {
        "txt" => read_txt_decoded(&dest_path)
            .unwrap_or_else(|_| format!("[书籍已导入] {}", book_title)),
        "epub" => format!("[EPUB 书籍] {}", book_title),
        "pdf" => format!("[PDF 书籍] {}", book_title),
        _ => format!("[书籍已导入] {}", book_title),
    };

    // 创建 Article 记录
    let article = Article {
        id: id.clone(),
        title: book_title,
        content,
        source_type: Some("book".to_string()),
        source_url: Some(format!("file://{}", file_path)),
        media_path: None,
        book_path: Some(dest_path.to_string_lossy().into_owned()),
        book_type: Some(book_type.to_string()),
        created_at,
        translated: false,
        active_mind_map_artifact_id: None,
        segments: Vec::new(), // 书籍不预分段，由阅读器处理
    };

    // 保存文章记录
    let article_json =
        serde_json::to_string(&article).map_err(|e| format!("序列化文章失败: {}", e))?;
    save_article(&app_handle, &id, &article_json)?;

    // EPUB/TXT 书籍同步为 Book + 章节记录(同步规范 §2.2);失败不影响本地导入
    if book_type == "epub" || book_type == "txt" {
        if let Ok(data_dir) = crate::storage::get_app_data_dir(&app_handle) {
            if let Err(e) = crate::storage::register_local_book_in_dir(&data_dir, &id) {
                eprintln!("[ImportBook] 书籍同步记录创建失败: {}", e);
            }
        }
    }

    println!(
        "[ImportBook] 书籍导入成功: {} ({})",
        article.title, book_type
    );

    Ok(article)
}

#[tauri::command]
pub async fn import_web_material_cmd(
    app_handle: AppHandle,
    url: String,
    title: Option<String>,
    content: String,
) -> Result<Article, String> {
    let parsed_url = url::Url::parse(&url).map_err(|_| "Invalid URL format".to_string())?;
    if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
        return Err("Only HTTP and HTTPS URLs are supported".to_string());
    }

    if content.trim().len() < 10 {
        return Err(
            "Extracted content is too short. Please check the URL and try again.".to_string(),
        );
    }

    let id = Uuid::new_v4().to_string();
    let created_at = chrono::Utc::now().to_rfc3339();
    let final_title = title.unwrap_or_else(|| "Untitled Web Material".to_string());
    let segments = create_segments_from_content(&id, &content);

    let article = Article {
        id: id.clone(),
        title: final_title,
        content,
        source_type: Some("web".to_string()),
        source_url: Some(url),
        media_path: None,
        book_path: None,
        book_type: None,
        created_at,
        translated: false,
        active_mind_map_artifact_id: None,
        segments,
    };

    let article_json = serde_json::to_string(&article)
        .map_err(|e| format!("Failed to serialize article: {}", e))?;
    save_article(&app_handle, &id, &article_json)?;

    Ok(article)
}

// File System Commands
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    use std::fs;
    fs::write(path, content).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
pub async fn write_binary_file(path: String, content: Vec<u8>) -> Result<(), String> {
    use std::fs;
    fs::write(path, content).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
pub async fn delete_article_subtitles_cmd(app_handle: AppHandle, id: String) -> Result<(), String> {
    let article_json = load_article(&app_handle, &id)?;
    let mut article: Article = serde_json::from_str(&article_json)
        .map_err(|e| format!("Failed to parse article: {}", e))?;

    article.segments = Vec::new();
    article.translated = false;

    let updated_json = serde_json::to_string(&article).unwrap();
    save_article(&app_handle, &id, &updated_json)?;

    Ok(())
}

#[tauri::command]
pub async fn delete_article_analysis_cmd(app_handle: AppHandle, id: String) -> Result<(), String> {
    let article_json = load_article(&app_handle, &id)?;
    let mut article: Article = serde_json::from_str(&article_json)
        .map_err(|e| format!("Failed to parse article: {}", e))?;

    for segment in &mut article.segments {
        segment.translation = None;
        segment.explanation = None;
    }
    article.translated = false;

    let updated_json = serde_json::to_string(&article).unwrap();
    save_article(&app_handle, &id, &updated_json)?;

    Ok(())
}

/// PDF全文翻译命令
/// 调用 Python PDF翻译插件进行翻译，生成纯译文和双语对照PDF
#[tauri::command]
pub async fn translate_pdf_document(
    app_handle: AppHandle,
    pdf_path: String,
    lang_in: String,
    lang_out: String,
    provider: String,
    api_key: String,
    model: String,
    base_url: Option<String>,
) -> Result<serde_json::Value, String> {
    use crate::logging::{self, LogLevel};
    use crate::pdf_sidecar;
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    let started_at = Instant::now();
    logging::log(LogLevel::Info, "pdf", "==================== PDF translation started ====================");
    logging::log(
        LogLevel::Info,
        "pdf",
        format!(
            "request: lang_in={lang_in}, lang_out={lang_out}, provider={provider}, model={model}, base_url={}, api_key={}",
            base_url.as_deref().unwrap_or("<none>"),
            if api_key.trim().is_empty() {
                "<empty>".to_string()
            } else {
                format!("<set, {} chars>", api_key.trim().len())
            }
        ),
    );
    logging::log(LogLevel::Info, "pdf", format!("source pdf: {pdf_path}"));

    println!(
        "[PDF Translate] Starting translation: {} -> {}",
        lang_in, lang_out
    );
    println!("[PDF Translate] Provider: {}, Model: {}", provider, model);

    // 获取输出目录（与原PDF相同目录）
    let pdf_path_buf = PathBuf::from(&pdf_path);
    let output_dir = pdf_path_buf
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());

    let filename_stem = pdf_path_buf
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".to_string());

    // The sidecar writes <stem>-mono.pdf / -dual.pdf into output_dir but does not
    // create it; make sure it exists so writing the result never fails.
    let _ = std::fs::create_dir_all(&output_dir);

    // 构建环境变量
    let mut envs: Vec<(&str, String)> = vec![
        ("OPENKOTO_PROVIDER", provider.clone()),
        ("OPENKOTO_API_KEY", api_key.clone()),
        ("OPENKOTO_MODEL", model.clone()),
    ];

    // Resolve the base URL with the same provider defaults used by the other AI
    // features, so providers whose URL is derived rather than stored (e.g.
    // Moonshot/Kimi) still work when the active model config has no explicit
    // base_url. Without this the sidecar receives no OPENKOTO_BASE_URL and dies
    // with `KeyError: 'OPENAI_BASE_URL'`.
    let resolved_base_url = base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| default_base_url(&provider).map(ToOwned::to_owned));

    if let Some(url) = resolved_base_url {
        envs.push(("OPENKOTO_BASE_URL", url));
    }

    // Point the sidecar at bundled offline assets (DocLayout model + CJK fonts)
    // so the first translation doesn't block on a network download. Absent in
    // dev builds, in which case the sidecar falls back to on-demand download.
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        for candidate in ["resources/pdf-assets", "pdf-assets"] {
            let dir = resource_dir.join(candidate);
            if dir.join("models").is_dir() || dir.join("fonts").is_dir() {
                envs.push((
                    "OPENKOTO_OFFLINE_ASSETS_DIR",
                    dir.to_string_lossy().to_string(),
                ));
                break;
            }
        }
    }

    let sidecar = pdf_sidecar::resolve_pdf_sidecar(&app_handle)
        .map_err(|e| format!("PDF sidecar error: {e}"))?;
    let cmd = sidecar.program;
    let mut args = sidecar.args;
    let plugin_dir = sidecar.working_dir;

    args.extend([
        pdf_path.clone(),
        "-li".to_string(),
        lang_in,
        "-lo".to_string(),
        lang_out,
        "-s".to_string(),
        "openkoto".to_string(),
        "-o".to_string(),
        output_dir.clone(),
    ]);

    println!("[PDF Sidecar] Executing: {} {:?}", cmd, args);
    println!("[PDF Sidecar] CWD: {:?}", plugin_dir);
    logging::log(LogLevel::Info, "pdf", format!("spawn: {} {:?}", cmd, args));
    logging::log(LogLevel::Info, "pdf", format!("cwd: {:?}", plugin_dir));
    logging::log(
        LogLevel::Info,
        "pdf",
        format!(
            "offline assets: {}",
            envs.iter()
                .find(|(k, _)| *k == "OPENKOTO_OFFLINE_ASSETS_DIR")
                .map(|(_, v)| v.as_str())
                .unwrap_or("<none — sidecar may download on first run>")
        ),
    );

    // 在插件目录下执行，以确保 Python 模块导入正确 (如果是 Dev 模式)
    // 或者对于 Prod 模式，通常也不影响
    let mut command = Command::new(&cmd);
    command
        .args(&args)
        .envs(envs.iter().map(|(k, v)| (*k, v.as_str())))
        .current_dir(&plugin_dir) // 关键：设置工作目录为插件目录
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    pdf_sidecar::hide_console_window(&mut command); // Windows: 避免弹出黑色 cmd 窗口

    // Stream the sidecar output instead of blocking on .output(): this lets us
    // forward per-page progress to the UI and log lines to the console live,
    // so a long translation no longer looks frozen.
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to execute PDF sidecar '{}': {}", cmd, e))?;

    let child_stdout = child
        .stdout
        .take()
        .ok_or_else(|| "PDF sidecar stdout unavailable".to_string())?;
    let child_stderr = child
        .stderr
        .take()
        .ok_or_else(|| "PDF sidecar stderr unavailable".to_string())?;

    // Shared "last time the sidecar said anything" clock. A stall (the classic
    // "stuck at 50%") shows up as a long gap with no new line; the watchdog
    // below turns that silent gap into an explicit warning in the log.
    let last_activity = Arc::new(Mutex::new(Instant::now()));

    // stdout: parse progress markers -> emit events + console log; pass the rest through.
    let app_for_stdout = app_handle.clone();
    let activity_stdout = last_activity.clone();
    let stdout_handle = std::thread::spawn(move || {
        let reader = BufReader::new(child_stdout);
        for line in reader.lines().map_while(Result::ok) {
            *activity_stdout.lock().unwrap() = Instant::now();
            if let Some(rest) = line.strip_prefix("OPENKOTO_PROGRESS ") {
                match serde_json::from_str::<serde_json::Value>(rest) {
                    Ok(payload) => {
                        let current = payload.get("current").and_then(|v| v.as_i64()).unwrap_or(0);
                        let total = payload.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
                        let percent = payload.get("percent").and_then(|v| v.as_i64()).unwrap_or(0);
                        println!(
                            "[PDF Translate] progress {}/{} ({}%)",
                            current, total, percent
                        );
                        logging::log(
                            LogLevel::Info,
                            "pdf",
                            format!("progress: page {current}/{total} ({percent}%)"),
                        );
                        let _ = app_for_stdout.emit("pdf-translation-progress", payload);
                    }
                    Err(_) => {
                        println!("[PDF Sidecar] {}", line);
                        logging::log(LogLevel::Info, "python", format!("[stdout] {line}"));
                    }
                }
            } else {
                println!("[PDF Sidecar] {}", line);
                logging::log(LogLevel::Info, "python", format!("[stdout] {line}"));
            }
        }
    });

    // stderr: log live and accumulate so a failure still surfaces a useful message.
    // The Python side writes its detailed per-page / per-paragraph trace here.
    let activity_stderr = last_activity.clone();
    let stderr_handle = std::thread::spawn(move || {
        let reader = BufReader::new(child_stderr);
        let mut collected = String::new();
        for line in reader.lines().map_while(Result::ok) {
            *activity_stderr.lock().unwrap() = Instant::now();
            eprintln!("[PDF Sidecar:err] {}", line);
            let lower = line.to_ascii_lowercase();
            let level = if lower.contains("traceback")
                || lower.contains("error")
                || lower.contains("exception")
                || lower.contains("failed")
            {
                LogLevel::Error
            } else if lower.contains("retry") || lower.contains("warn") {
                LogLevel::Warn
            } else {
                LogLevel::Info
            };
            logging::log(level, "python", line.clone());
            collected.push_str(&line);
            collected.push('\n');
        }
        collected
    });

    // Watchdog: if the sidecar goes quiet for too long, say so explicitly so a
    // hang is visible in the log instead of just a frozen progress bar.
    let watchdog_done = Arc::new(AtomicBool::new(false));
    let watchdog_flag = watchdog_done.clone();
    let activity_watchdog = last_activity.clone();
    let watchdog_handle = std::thread::spawn(move || {
        const STALL_WARN_SECS: u64 = 20;
        let mut warned_at = 0u64;
        while !watchdog_flag.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_secs(5));
            if watchdog_flag.load(Ordering::Relaxed) {
                break;
            }
            let idle = activity_watchdog.lock().unwrap().elapsed().as_secs();
            if idle >= STALL_WARN_SECS && idle != warned_at {
                warned_at = idle;
                logging::log(
                    LogLevel::Warn,
                    "pdf",
                    format!(
                        "no sidecar output for {idle}s — translation may be stalled (hung API call or retry loop?)"
                    ),
                );
            }
        }
    });

    let status = child
        .wait()
        .map_err(|e| format!("Failed to wait for PDF sidecar: {}", e))?;
    let _ = stdout_handle.join();
    let stderr_output = stderr_handle.join().unwrap_or_default();
    watchdog_done.store(true, Ordering::Relaxed);
    let _ = watchdog_handle.join();

    let elapsed_secs = started_at.elapsed().as_secs_f64();
    logging::log(
        LogLevel::Info,
        "pdf",
        format!(
            "sidecar exited: success={}, code={:?}, elapsed={:.1}s",
            status.success(),
            status.code(),
            elapsed_secs
        ),
    );

    if status.success() {
        // Settle the UI at 100% once the files are written.
        let _ = app_handle.emit(
            "pdf-translation-progress",
            serde_json::json!({"type": "progress", "current": 0, "total": 0, "percent": 100}),
        );

        let mono_path = format!("{}/{}-mono.pdf", output_dir, filename_stem);
        let dual_path = format!("{}/{}-dual.pdf", output_dir, filename_stem);

        logging::log(
            LogLevel::Info,
            "pdf",
            format!("translation OK in {elapsed_secs:.1}s -> {mono_path} / {dual_path}"),
        );

        Ok(serde_json::json!({
            "success": true,
            "mono_pdf": mono_path,
            "dual_pdf": dual_path,
            "original_pdf": pdf_path,
        }))
    } else {
        logging::log(
            LogLevel::Error,
            "pdf",
            format!(
                "translation FAILED (code={:?}). Tail of sidecar stderr:\n{}",
                status.code(),
                stderr_output
                    .lines()
                    .rev()
                    .take(20)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        );
        Err(format!("PDF translation failed: {}", stderr_output))
    }
}

#[derive(serde::Serialize)]
pub struct TranslationFiles {
    pub mono_path: Option<String>,
    pub dual_path: Option<String>,
}

#[tauri::command]
pub async fn check_pdf_translation_files(pdf_path: String) -> Result<TranslationFiles, String> {
    use std::path::Path;
    let path = Path::new(&pdf_path);
    if !path.exists() {
        return Ok(TranslationFiles {
            mono_path: None,
            dual_path: None,
        });
    }

    let parent = path.parent().unwrap_or(Path::new("."));

    // Safety check: ensure file stem exists
    let stem = match path.file_stem() {
        Some(s) => s.to_string_lossy(),
        None => {
            return Ok(TranslationFiles {
                mono_path: None,
                dual_path: None,
            })
        }
    };

    let mono_name = format!("{}-mono.pdf", stem);
    let dual_name = format!("{}-dual.pdf", stem);

    let mono_path = parent.join(&mono_name);
    let dual_path = parent.join(&dual_name);

    Ok(TranslationFiles {
        mono_path: if mono_path.exists() {
            Some(mono_path.to_string_lossy().into_owned())
        } else {
            None
        },
        dual_path: if dual_path.exists() {
            Some(dual_path.to_string_lossy().into_owned())
        } else {
            None
        },
    })
}

#[tauri::command]
pub async fn export_file_cmd(src_path: String, dest_path: String) -> Result<(), String> {
    std::fs::copy(&src_path, &dest_path).map_err(|e| format!("Failed to export file: {}", e))?;
    Ok(())
}

// ============================================================================
// Bookmarks Commands - 书签命令
// ============================================================================

/// 添加书签
#[tauri::command]
pub async fn add_bookmark_cmd(
    app_handle: AppHandle,
    book_path: String,
    book_type: String,
    title: String,
    note: Option<String>,
    selected_text: Option<String>,
    page_number: Option<i32>,
    epub_cfi: Option<String>,
    color: Option<String>,
) -> Result<Bookmark, String> {
    let bookmark = Bookmark {
        id: Uuid::new_v4().to_string(),
        book_path,
        book_type,
        title,
        note,
        selected_text,
        page_number,
        epub_cfi,
        created_at: chrono::Utc::now().to_rfc3339(),
        color,
    };

    let json = serde_json::to_string(&bookmark)
        .map_err(|e| format!("Failed to serialize bookmark: {}", e))?;
    save_bookmark(&app_handle, &bookmark.id, &json)?;

    Ok(bookmark)
}

/// 列出所有书签
#[tauri::command]
pub async fn list_bookmarks_cmd(app_handle: AppHandle) -> Result<Vec<Bookmark>, String> {
    let mut bookmarks = crate::storage::load_all_bookmarks(&app_handle)?;

    // 按创建时间降序排列
    bookmarks.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(bookmarks)
}

/// 列出指定书籍的书签
#[tauri::command]
pub async fn list_bookmarks_for_book_cmd(
    app_handle: AppHandle,
    book_path: String,
) -> Result<Vec<Bookmark>, String> {
    let ids = list_bookmarks_for_book(&app_handle, &book_path)?;
    let mut bookmarks = Vec::new();

    for id in ids {
        if let Ok(json) = load_bookmark(&app_handle, &id) {
            if let Ok(bookmark) = serde_json::from_str::<Bookmark>(&json) {
                bookmarks.push(bookmark);
            }
        }
    }

    // 按创建时间降序排列
    bookmarks.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(bookmarks)
}

/// 更新书签
#[tauri::command]
pub async fn update_bookmark_cmd(
    app_handle: AppHandle,
    id: String,
    title: Option<String>,
    note: Option<String>,
    color: Option<String>,
) -> Result<Bookmark, String> {
    let json = load_bookmark(&app_handle, &id)?;
    let mut bookmark: Bookmark =
        serde_json::from_str(&json).map_err(|e| format!("Failed to parse bookmark: {}", e))?;

    if let Some(t) = title {
        bookmark.title = t;
    }
    if let Some(n) = note {
        bookmark.note = Some(n);
    }
    if let Some(c) = color {
        bookmark.color = Some(c);
    }

    let updated_json = serde_json::to_string(&bookmark)
        .map_err(|e| format!("Failed to serialize bookmark: {}", e))?;
    save_bookmark(&app_handle, &id, &updated_json)?;

    Ok(bookmark)
}

/// 删除书签
#[tauri::command]
pub async fn delete_bookmark_cmd(app_handle: AppHandle, id: String) -> Result<(), String> {
    delete_bookmark(&app_handle, &id)?;
    Ok(())
}

#[cfg(test)]
mod word_pack_import_tests {
    use super::*;

    #[test]
    fn export_builder_uses_pack_name_for_filename_and_sorts_entries() {
        let result = build_word_pack_export_result(
            WordPackExportMeta {
                name: "全部单词".to_string(),
                description: None,
                cover_url: None,
                author: None,
                language_from: None,
                language_to: None,
                tags: Vec::new(),
                version: Some("1.0.0".to_string()),
            },
            vec![
                WordPackExportEntry {
                    word: "zebra".to_string(),
                    meaning: "斑马".to_string(),
                    usage: None,
                    example: None,
                    reading: None,
                    explanation: None,
                    tags: Vec::new(),
                },
                WordPackExportEntry {
                    word: "apple".to_string(),
                    meaning: "苹果".to_string(),
                    usage: None,
                    example: None,
                    reading: None,
                    explanation: None,
                    tags: Vec::new(),
                },
            ],
        )
        .expect("should build export result");

        assert_eq!(result.file_name, "全部单词.okpack.json");
        assert!(
            result.json_content.find("apple").unwrap() < result.json_content.find("zebra").unwrap()
        );
    }

    #[test]
    fn import_parser_accepts_standard_pack_schema() {
        let json = r#"{
          "schema_version":"openkoto-word-pack-v1",
          "pack":{"name":"Core 100","description":"desc"},
          "entries":[{"word":"abandon","meaning":"放弃"}]
        }"#;

        let parsed = parse_import_word_pack_json(json).expect("should parse standard schema");
        assert_eq!(parsed.pack.name, "Core 100");
        assert_eq!(parsed.entries.len(), 1);
        assert_eq!(parsed.entries[0].word, "abandon");
    }

    #[test]
    fn import_parser_rejects_legacy_array_schema() {
        let json = r#"[
          {"word":"abandon","meaning":"放弃","usage":"v."},
          {"word":"ability","meaning":"能力"}
        ]"#;

        let error =
            parse_import_word_pack_json(json).expect_err("legacy array schema should be rejected");
        assert!(error.contains("Invalid word pack JSON"));
    }

    #[test]
    fn import_parser_rejects_unknown_schema_version() {
        let json = r#"{
          "schema_version":"openkoto-word-pack-v2",
          "pack":{"name":"Core 100"},
          "entries":[{"word":"abandon","meaning":"放弃"}]
        }"#;

        let error =
            parse_import_word_pack_json(json).expect_err("unknown schema should be rejected");
        assert!(error.contains("Unsupported word pack schema_version"));
    }

    #[test]
    fn import_parser_accepts_json_with_bom() {
        let json = "\u{feff}{\"schema_version\":\"openkoto-word-pack-v1\",\"pack\":{\"name\":\"BOM Pack\"},\"entries\":[{\"word\":\"apple\",\"meaning\":\"苹果\"}]}";

        let parsed = parse_import_word_pack_json(json).expect("should parse BOM-prefixed json");
        assert_eq!(parsed.pack.name, "BOM Pack");
        assert_eq!(parsed.entries.len(), 1);
    }

    #[test]
    fn line_preview_keeps_short_lines_and_truncates_long_ones() {
        assert_eq!(build_line_preview("  首页 登录 注册  "), "首页 登录 注册");

        let long_line = "あ".repeat(WEB_CLEAN_PREVIEW_CHARS + 50);
        let preview = build_line_preview(&long_line);
        // 截断后必须带上真实长度，模型才知道这是一大段正文
        assert!(preview.ends_with(&format!("(len={})", WEB_CLEAN_PREVIEW_CHARS + 50)));
        assert!(preview.chars().count() < long_line.chars().count());
    }

    #[test]
    fn collapse_blank_lines_squeezes_gaps_left_by_removed_blocks() {
        let lines = vec!["", "", "第一段", "", "", "", "第二段", "", ""];
        assert_eq!(collapse_blank_lines(&lines), "第一段\n\n第二段");
    }

    #[test]
    fn batches_respect_the_line_and_char_budget() {
        let candidates: Vec<(usize, String)> = (0..WEB_CLEAN_BATCH_LINES * 2 + 5)
            .map(|i| (i, "短行".to_string()))
            .collect();
        let batches = split_clean_batches(candidates);
        assert_eq!(batches.len(), 3);
        assert!(batches.iter().all(|b| b.len() <= WEB_CLEAN_BATCH_LINES));

        // 长行按字符预算切，行数没到上限也要分批，一批不会撑爆上下文
        let long_line = "x".repeat(WEB_CLEAN_PREVIEW_CHARS);
        let candidates: Vec<(usize, String)> = (0..WEB_CLEAN_BATCH_LINES / 2)
            .map(|i| (i, long_line.clone()))
            .collect();
        let batches = split_clean_batches(candidates);
        assert!(batches.len() > 1);
        assert!(batches.iter().all(|b| b.len() < WEB_CLEAN_BATCH_LINES));
        for batch in &batches {
            let chars: usize = batch.iter().map(|(_, t)| t.chars().count() + 8).sum();
            assert!(chars <= WEB_CLEAN_BATCH_CHARS + WEB_CLEAN_PREVIEW_CHARS + 8);
        }
    }

    #[test]
    fn batching_preserves_every_line_index_in_order() {
        let candidates: Vec<(usize, String)> = (0..200).map(|i| (i, format!("line {}", i))).collect();
        let flattened: Vec<usize> = split_clean_batches(candidates)
            .into_iter()
            .flatten()
            .map(|(idx, _)| idx)
            .collect();
        assert_eq!(flattened, (0..200).collect::<Vec<_>>());
    }
}

// ============================================================================
// 传输包导出（跨设备同步 P2）
// ============================================================================

/// 导出结果。文件内容交给前端去写盘（复用既有的保存对话框），
/// 命令本身只负责把库读成 JSON。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportTransferBundleResult {
    pub file_name: String,
    pub json_content: String,
    pub vocabulary: usize,
    pub packs: usize,
    pub articles: usize,
    pub segments: usize,
    pub review_events: usize,
    /// 因 id 非 UUID、时间戳无法解析等原因被丢掉的条数。
    /// **必须报出来**：静默丢数据是最糟的失败方式。
    pub skipped: usize,
}

/// 把桌面端的词库/素材导出成 `.okdata` 传输包，供 iOS / iPadOS / macOS 导入。
///
/// 桌面版是另一个 App，进不了 iOS 那边的 CloudKit 容器，所以这条通道是**单向**的：
/// 桌面加工素材 → 文件 → Apple 生态学习。Apple 三平台之间由 CloudKit 自动同步。
///
/// - `include_content`: 是否带上文章正文与精讲。词库通常几百 KB，
///   而全部正文＋精讲可能几十 MB。
#[tauri::command]
pub async fn export_transfer_bundle_cmd(
    app_handle: AppHandle,
    include_content: bool,
) -> Result<ExportTransferBundleResult, String> {
    use crate::transfer_export::{
        build_article, build_pack, build_review_event, build_vocabulary, export_file_name,
        TransferBundle, TransferSkipped, TRANSFER_FORMAT_ID, TRANSFER_SCHEMA_VERSION,
    };

    ensure_favorites_dirs(&app_handle)?;
    let mut skipped = TransferSkipped::default();

    let favorites = load_all_favorite_vocabularies_internal(&app_handle)?;
    let mut vocabulary = Vec::with_capacity(favorites.len());
    for favorite in &favorites {
        let modified = crate::storage::favorite_vocabulary_modified_at(&app_handle, &favorite.id);
        match build_vocabulary(favorite, modified) {
            Some(item) => vocabulary.push(item),
            None => skipped.vocabulary += 1,
        }
    }

    let mut packs = Vec::new();
    for pack in load_all_word_packs(&app_handle)? {
        match build_pack(&pack) {
            Some(item) => packs.push(item),
            // 系统包是刻意不导出的，不计入"被丢掉"
            None if pack.is_system => {}
            None => skipped.packs += 1,
        }
    }

    let mut articles = Vec::new();
    let mut segments = Vec::new();
    if include_content {
        for id in list_articles(&app_handle)? {
            let Ok(json) = load_article(&app_handle, &id) else {
                skipped.articles += 1;
                continue;
            };
            let Ok(article) = serde_json::from_str::<Article>(&json) else {
                skipped.articles += 1;
                continue;
            };
            let total_segments = article.segments.len();
            match build_article(&article) {
                Some((item, mut its_segments)) => {
                    skipped.segments += total_segments.saturating_sub(its_segments.len());
                    articles.push(item);
                    segments.append(&mut its_segments);
                }
                None => {
                    skipped.articles += 1;
                    skipped.segments += total_segments;
                }
            }
        }
    }

    let mut review_events = Vec::new();
    for event in crate::storage::list_review_events(&app_handle)? {
        match build_review_event(&event) {
            Some(item) => review_events.push(item),
            None => skipped.review_events += 1,
        }
    }

    let exported_at = chrono::Utc::now();
    let bundle = TransferBundle {
        format: TRANSFER_FORMAT_ID.to_string(),
        schema_version: TRANSFER_SCHEMA_VERSION,
        exported_at: exported_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        source_app: "textlingo-desktop".to_string(),
        vocabulary,
        packs,
        articles,
        segments,
        review_events,
        tombstones: Vec::new(),
    };

    let json_content = serde_json::to_string_pretty(&bundle)
        .map_err(|e| format!("Failed to serialize transfer bundle: {}", e))?;

    Ok(ExportTransferBundleResult {
        file_name: export_file_name(&exported_at),
        json_content,
        vocabulary: bundle.vocabulary.len(),
        packs: bundle.packs.len(),
        articles: bundle.articles.len(),
        segments: bundle.segments.len(),
        review_events: bundle.review_events.len(),
        skipped: skipped.total(),
    })
}

#[cfg(test)]
mod txt_decode_tests {
    use super::read_txt_decoded;

    #[test]
    fn decodes_utf8() {
        let dir = std::env::temp_dir().join("openkoto_txt_decode_utf8.txt");
        std::fs::write(&dir, "中文小说\n第一章").unwrap();
        assert_eq!(read_txt_decoded(&dir).unwrap(), "中文小说\n第一章");
        std::fs::remove_file(&dir).ok();
    }

    #[test]
    fn decodes_utf8_bom() {
        let dir = std::env::temp_dir().join("openkoto_txt_decode_bom.txt");
        std::fs::write(&dir, [0xEF, 0xBB, 0xBF].iter().copied()
            .chain("中文".bytes()).collect::<Vec<u8>>()).unwrap();
        assert_eq!(read_txt_decoded(&dir).unwrap(), "中文");
        std::fs::remove_file(&dir).ok();
    }

    #[test]
    fn decodes_gbk() {
        let dir = std::env::temp_dir().join("openkoto_txt_decode_gbk.txt");
        // "这是一本简体中文的小说，用来测试编码检测功能是否正常运作。" 的 GBK 编码字节
        let gbk: Vec<u8> = vec![
            0xD5, 0xE2, 0xCA, 0xC7, 0xD2, 0xBB, 0xB1, 0xBE, 0xBC, 0xF2, 0xCC, 0xE5, 0xD6, 0xD0,
            0xCE, 0xC4, 0xB5, 0xC4, 0xD0, 0xA1, 0xCB, 0xB5, 0xA3, 0xAC, 0xD3, 0xC3, 0xC0, 0xB4,
            0xB2, 0xE2, 0xCA, 0xD4, 0xB1, 0xE0, 0xC2, 0xEB, 0xBC, 0xEC, 0xB2, 0xE2, 0xB9, 0xA6,
            0xC4, 0xDC, 0xCA, 0xC7, 0xB7, 0xF1, 0xD5, 0xFD, 0xB3, 0xA3, 0xD4, 0xCB, 0xD7, 0xF7,
            0xA1, 0xA3,
        ];
        std::fs::write(&dir, &gbk).unwrap();
        assert_eq!(
            read_txt_decoded(&dir).unwrap(),
            "这是一本简体中文的小说，用来测试编码检测功能是否正常运作。"
        );
        std::fs::remove_file(&dir).ok();
    }

    #[test]
    fn decodes_big5() {
        let dir = std::env::temp_dir().join("openkoto_txt_decode_big5.txt");
        // "這是一本繁體中文的小說，用來測試編碼偵測功能是否正常運作。" 的 Big5 编码字节
        let big5: Vec<u8> = vec![
            0xB3, 0x6F, 0xAC, 0x4F, 0xA4, 0x40, 0xA5, 0xBB, 0xC1, 0x63, 0xC5, 0xE9, 0xA4, 0xA4,
            0xA4, 0xE5, 0xAA, 0xBA, 0xA4, 0x70, 0xBB, 0xA1, 0xA1, 0x41, 0xA5, 0xCE, 0xA8, 0xD3,
            0xB4, 0xFA, 0xB8, 0xD5, 0xBD, 0x73, 0xBD, 0x58, 0xB0, 0xBB, 0xB4, 0xFA, 0xA5, 0x5C,
            0xAF, 0xE0, 0xAC, 0x4F, 0xA7, 0x5F, 0xA5, 0xBF, 0xB1, 0x60, 0xB9, 0x42, 0xA7, 0x40,
            0xA1, 0x43,
        ];
        std::fs::write(&dir, &big5).unwrap();
        assert_eq!(
            read_txt_decoded(&dir).unwrap(),
            "這是一本繁體中文的小說，用來測試編碼偵測功能是否正常運作。"
        );
        std::fs::remove_file(&dir).ok();
    }
}

#[cfg(test)]
mod video_remux_tests {
    use super::needs_remux_container;

    #[test]
    fn remux_required_for_webview_unsupported_containers() {
        for ext in ["mkv", "MKV", "avi", "wmv", "flv", "ts", "m2ts", "mpg", "mpeg", "vob"] {
            assert!(needs_remux_container(ext), "{} should need remux", ext);
        }
    }

    #[test]
    fn remux_skipped_for_webview_supported_containers() {
        for ext in ["mp4", "MP4", "mov", "webm", "m4v", "mp3", "m4a"] {
            assert!(!needs_remux_container(ext), "{} should not need remux", ext);
        }
    }
}

#[cfg(test)]
mod sentence_split_tests {
    use super::{is_abbreviation, split_into_sentences};

    #[test]
    fn closing_curly_quote_stays_with_its_sentence() {
        // U+201D RIGHT DOUBLE QUOTATION MARK used to start the next sentence.
        let s = split_into_sentences("He said \u{201C}Stop.\u{201D} Then he left.");
        assert_eq!(s, vec!["He said \u{201C}Stop.\u{201D}", "Then he left."]);
        let ascii = split_into_sentences("He said \"Stop.\" Then he left.");
        assert_eq!(ascii, vec!["He said \"Stop.\"", "Then he left."]);
    }

    #[test]
    fn single_multibyte_letter_is_an_initial() {
        // `word.len()` counted bytes, so a non-ASCII capital initial ("É.") was missed.
        let chars: Vec<char> = "Dr. É. Zola wrote.".chars().collect();
        let pos = chars.iter().position(|c| *c == 'É').unwrap() + 1;
        assert!(is_abbreviation(&chars, pos));
        assert_eq!(
            split_into_sentences("Dr. É. Zola wrote. Then Mr. A. Smith read."),
            vec!["Dr. É. Zola wrote.", "Then Mr. A. Smith read."]
        );
    }
}

#[cfg(test)]
mod book_progress_tests {
    use super::book_id_from_path;

    #[test]
    fn book_ids_from_reader_urls() {
        assert_eq!(
            book_id_from_path("http://127.0.0.1:19420/book/0b8e2c1a-5d4f-4e3a-9b2c-1d0e9f8a7b99.epub").as_deref(),
            Some("0b8e2c1a-5d4f-4e3a-9b2c-1d0e9f8a7b99")
        );
        assert_eq!(
            book_id_from_path("/data/books/0b8e2c1a-5d4f-4e3a-9b2c-1d0e9f8a7b99.chapters.txt").as_deref(),
            Some("0b8e2c1a-5d4f-4e3a-9b2c-1d0e9f8a7b99")
        );
        assert_eq!(book_id_from_path("http://127.0.0.1:19420/book/translated-mono.pdf"), None);
    }
}
