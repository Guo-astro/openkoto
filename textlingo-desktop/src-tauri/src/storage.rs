use crate::types::{merge_missing_builtin_prompt_features, AgentTask, AppConfig, Artifact, Article};
use serde_json;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const CONFIG_FILE: &str = "config.json";
const ARTICLES_DIR: &str = "articles";
const AGENT_TASKS_DIR: &str = "agent_tasks";
const ARTIFACTS_DIR: &str = "artifacts/articles";

pub fn get_app_data_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))
}

pub fn ensure_app_dirs(app_handle: &AppHandle) -> Result<(), String> {
    let data_dir = get_app_data_dir(app_handle)?;
    let articles_dir = data_dir.join(ARTICLES_DIR);
    let agent_tasks_dir = data_dir.join(AGENT_TASKS_DIR);
    let artifacts_dir = data_dir.join(ARTIFACTS_DIR);

    fs::create_dir_all(&articles_dir)
        .map_err(|e| format!("Failed to create articles directory: {}", e))?;
    fs::create_dir_all(&agent_tasks_dir)
        .map_err(|e| format!("Failed to create agent tasks directory: {}", e))?;
    fs::create_dir_all(&artifacts_dir)
        .map_err(|e| format!("Failed to create artifacts directory: {}", e))?;

    Ok(())
}

pub fn save_config(app_handle: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let data_dir = get_app_data_dir(app_handle)?;
    save_config_in_dir(&data_dir, config, &crate::cloud::secrets::KeyringStore)
}

/// Write `config.json`. Model / ASR API keys go to the OS keychain and the file keeps a
/// placeholder (design doc §9.2); keys of removed configs are deleted from the keychain.
pub fn save_config_in_dir(
    data_dir: &Path,
    config: &AppConfig,
    secrets: &dyn crate::cloud::secrets::SecretStore,
) -> Result<(), String> {
    let config_path = data_dir.join(CONFIG_FILE);
    if let Some(previous) = read_config_file(&config_path).ok().flatten() {
        crate::cloud::secrets::forget_removed_keys(&previous, config, secrets);
    }
    let on_disk = crate::cloud::secrets::config_for_disk(config, secrets);

    let config_json = serde_json::to_string_pretty(&on_disk)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    fs::write(config_path, config_json).map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(())
}

fn read_config_file(config_path: &Path) -> Result<Option<AppConfig>, String> {
    if !config_path.exists() {
        return Ok(None);
    }

    let config_content =
        fs::read_to_string(config_path).map_err(|e| format!("Failed to read config: {}", e))?;

    let mut deserializer = serde_json::Deserializer::from_str(&config_content);
    let mut config: AppConfig = match serde::Deserialize::deserialize(&mut deserializer) {
        Ok(c) => c,
        Err(e) => {
            return Err(format!("FATAL_CONFIG_CORRUPTION: {}", e));
        }
    };

    config.prompt_features = merge_missing_builtin_prompt_features(config.prompt_features);
    Ok(Some(config))
}

pub fn load_config(app_handle: &AppHandle) -> Result<Option<AppConfig>, String> {
    let data_dir = get_app_data_dir(app_handle)?;
    load_config_in_dir(&data_dir, &crate::cloud::secrets::KeyringStore)
}

/// Read `config.json` with API keys filled in from the keychain. Plaintext keys left by older
/// versions are migrated into the keychain and the file is rewritten without them.
pub fn load_config_in_dir(
    data_dir: &Path,
    secrets: &dyn crate::cloud::secrets::SecretStore,
) -> Result<Option<AppConfig>, String> {
    let config_path = data_dir.join(CONFIG_FILE);
    let Some(mut config) = read_config_file(&config_path)? else {
        return Ok(None);
    };
    if crate::cloud::secrets::hydrate_api_keys(&mut config, secrets) {
        let on_disk = crate::cloud::secrets::config_for_disk(&config, secrets);
        if let Ok(json) = serde_json::to_string_pretty(&on_disk) {
            let _ = fs::write(&config_path, json);
        }
    }
    Ok(Some(config))
}

fn db_for(app_handle: &AppHandle) -> Result<std::sync::Arc<crate::db::Database>, String> {
    crate::db::open(&get_app_data_dir(app_handle)?)
}

/// Open the SQLite database of the app data dir (runs the one-time legacy JSON import).
pub fn database(app_handle: &AppHandle) -> Result<std::sync::Arc<crate::db::Database>, String> {
    db_for(app_handle)
}

pub fn save_article(app_handle: &AppHandle, article_id: &str, content: &str) -> Result<(), String> {
    let data_dir = get_app_data_dir(app_handle)?;
    save_article_in_dir(&data_dir, article_id, content)
}

/// Write the article JSON file (the reader's full-fidelity store) and mirror the article and its
/// segments into SQLite, recording the changes for sync.
pub fn save_article_in_dir(data_dir: &Path, article_id: &str, content: &str) -> Result<(), String> {
    let articles_dir = data_dir.join(ARTICLES_DIR);
    ensure_dir(&articles_dir, "articles directory")?;
    fs::write(articles_dir.join(article_id), content)
        .map_err(|e| format!("Failed to save article: {}", e))?;

    if let Ok(article) = serde_json::from_str::<Article>(content) {
        let db = crate::db::open(data_dir)?;
        let changed = db.write(|tx| {
            crate::db::repo::mirror_article(tx, &article, crate::db::repo::Track::Record)
        })?;
        if changed {
            crate::sync::notify_local_change();
        }
    }
    Ok(())
}

pub fn load_article(app_handle: &AppHandle, article_id: &str) -> Result<String, String> {
    let data_dir = get_app_data_dir(app_handle)?;
    let article_path = data_dir.join(ARTICLES_DIR).join(article_id);

    if !article_path.exists() {
        return Err("Article not found".to_string());
    }

    fs::read_to_string(article_path).map_err(|e| format!("Failed to read article: {}", e))
}

pub fn list_articles(app_handle: &AppHandle) -> Result<Vec<String>, String> {
    let data_dir = get_app_data_dir(app_handle)?;
    let articles_dir = data_dir.join(ARTICLES_DIR);

    if !articles_dir.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(articles_dir)
        .map_err(|e| format!("Failed to read articles directory: {}", e))?;

    let article_ids: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.'))
        .collect();

    Ok(article_ids)
}

pub fn delete_article(app_handle: &AppHandle, article_id: &str) -> Result<(), String> {
    let data_dir = get_app_data_dir(app_handle)?;
    delete_article_in_dir(&data_dir, article_id)
}

pub fn delete_article_in_dir(data_dir: &Path, article_id: &str) -> Result<(), String> {
    let article_path = data_dir.join(ARTICLES_DIR).join(article_id);

    if article_path.exists() {
        fs::remove_file(article_path).map_err(|e| format!("Failed to delete article: {}", e))?;
    }

    let db = crate::db::open(data_dir)?;
    db.write(|tx| crate::db::repo::delete_article(tx, article_id, crate::db::repo::Track::Record))?;
    crate::sync::notify_local_change();
    Ok(())
}

/// Rewrite `articles/<id>` from SQLite after remote changes (sync), keeping the desktop-only
/// fields of an existing file (media/book paths, mind map, translated flag).
pub fn materialize_article_in_dir(data_dir: &Path, article_id: &str) -> Result<(), String> {
    let db = crate::db::open(data_dir)?;
    let path = data_dir.join(ARTICLES_DIR).join(article_id);
    let Some(from_db) = db.read(|c| crate::db::repo::load_article(c, article_id))? else {
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("Failed to delete article: {}", e))?;
        }
        return Ok(());
    };
    // Book chapters live in SQLite only; the book itself is materialized by
    // `materialize_book_in_dir`.
    if from_db.source_type.as_deref() == Some("book") {
        return Ok(());
    }
    let merged = match fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Article>(&s).ok())
    {
        Some(existing) => Article {
            title: from_db.title,
            content: from_db.content,
            source_type: from_db.source_type.or(existing.source_type),
            source_url: from_db.source_url,
            created_at: from_db.created_at,
            segments: from_db.segments,
            ..existing
        },
        None => from_db,
    };
    ensure_dir(&data_dir.join(ARTICLES_DIR), "articles directory")?;
    let json = serde_json::to_string(&merged)
        .map_err(|e| format!("Failed to serialize article: {}", e))?;
    fs::write(path, json).map_err(|e| format!("Failed to save article: {}", e))
}

pub const BOOKS_DIR: &str = "books";

/// Original file of a synced book: `books/<id>.<format>`.
pub fn book_file_path(data_dir: &Path, book_id: &str, format: &str) -> PathBuf {
    data_dir.join(BOOKS_DIR).join(format!("{book_id}.{format}"))
}

/// Readable stand-in built from the chapter records when the original file is not available.
pub fn book_fallback_path(data_dir: &Path, book_id: &str) -> PathBuf {
    data_dir.join(BOOKS_DIR).join(format!("{book_id}.chapters.txt"))
}

/// Create/refresh/remove the desktop reader article (`articles/<bookId>`) of a synced book.
/// Without the original file, a TXT is assembled from the chapter articles so the book is
/// readable right away; the scheduler downloads the original later.
pub fn materialize_book_in_dir(data_dir: &Path, book_id: &str) -> Result<(), String> {
    let db = crate::db::open(data_dir)?;
    let article_path = data_dir.join(ARTICLES_DIR).join(book_id);
    let Some(book) = db.read(|c| crate::db::books::load_book(c, book_id))? else {
        if article_path.exists() {
            let _ = fs::remove_file(&article_path);
        }
        for p in [
            book_file_path(data_dir, book_id, "epub"),
            book_file_path(data_dir, book_id, "txt"),
            book_fallback_path(data_dir, book_id),
        ] {
            let _ = fs::remove_file(p);
        }
        db.write(|tx| crate::db::repo::delete_article(tx, book_id, crate::db::repo::Track::Skip))?;
        return Ok(());
    };
    let chapters = db.read(|c| crate::db::books::chapters_with_text(c, book_id))?;
    let original = book_file_path(data_dir, book_id, &book.format);
    let (book_path, book_type) = if original.exists() {
        (original, book.format.clone())
    } else {
        let fallback = book_fallback_path(data_dir, book_id);
        if !chapters.is_empty() {
            ensure_dir(&data_dir.join(BOOKS_DIR), "books directory")?;
            let text = chapters
                .iter()
                .map(|(c, t)| match &c.title {
                    Some(title) if !t.starts_with(title.as_str()) => format!("{title}\n\n{t}"),
                    _ => t.clone(),
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            fs::write(&fallback, text).map_err(|e| format!("Failed to write book text: {e}"))?;
        }
        (fallback, "txt".to_string())
    };
    let content = if book_type == "txt" {
        fs::read_to_string(&book_path).unwrap_or_else(|_| format!("[书籍已导入] {}", book.title))
    } else {
        format!("[EPUB 书籍] {}", book.title)
    };
    let existing = fs::read_to_string(&article_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Article>(&s).ok());
    let article = Article {
        id: book_id.to_string(),
        title: book.title.clone(),
        content,
        source_type: Some("book".into()),
        source_url: existing.as_ref().and_then(|e| e.source_url.clone()),
        media_path: None,
        book_path: Some(book_path.to_string_lossy().into_owned()),
        book_type: Some(book_type),
        created_at: book.created_at.clone(),
        translated: existing.as_ref().map(|e| e.translated).unwrap_or(false),
        active_mind_map_artifact_id: existing.and_then(|e| e.active_mind_map_artifact_id),
        segments: Vec::new(),
    };
    let json = serde_json::to_string(&article).map_err(|e| format!("Failed to serialize article: {e}"))?;
    save_article_in_dir(data_dir, book_id, &json)
}

/// Turn a desktop book article (EPUB/TXT file) into Book + BookChapter + chapter Article
/// records (same shape as apps/web LibraryPage). No-op when the book is already registered.
pub fn register_local_book_in_dir(data_dir: &Path, article_id: &str) -> Result<bool, String> {
    let db = crate::db::open(data_dir)?;
    if !crate::sync::payload::is_uuid(article_id)
        || db.read(|c| crate::db::books::load_book(c, article_id))?.is_some()
    {
        return Ok(false);
    }
    let Some(article) = db.read(|c| crate::db::repo::load_article(c, article_id))? else {
        return Ok(false);
    };
    let (Some(book_path), Some(book_type)) = (article.book_path.clone(), article.book_type.clone()) else {
        return Ok(false);
    };
    let path = Path::new(&book_path);
    if !path.exists() || !(book_type == "epub" || book_type == "txt") {
        return Ok(false);
    }
    let parsed = if book_type == "epub" {
        crate::book_content::parse_epub_book(path, &article.title)?
    } else {
        let text = crate::commands::read_txt_decoded(path)?;
        crate::book_content::parse_txt_book(&text, &article.title)
    };
    let bytes = fs::read(path).map_err(|e| format!("Failed to read book: {e}"))?;
    use sha2::Digest;
    let sha: String = sha2::Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    // The desktop title (user-editable at import) wins over the file metadata.
    let parsed = crate::book_content::ParsedBook { title: article.title.clone(), ..parsed };
    db.write(|tx| {
        crate::db::books::create_book(
            tx,
            &article_id.to_lowercase(),
            &parsed,
            &sha,
            bytes.len() as i64,
            &article.created_at,
            crate::db::repo::Track::Record,
        )
    })?;
    crate::sync::notify_local_change();
    Ok(true)
}

/// One-time: register books imported before book sync existed.
pub fn backfill_books_in_dir(data_dir: &Path) -> Result<usize, String> {
    let db = crate::db::open(data_dir)?;
    let ids: Vec<String> = db.read(|c| {
        let mut stmt = c
            .prepare("select id from article where source_type = 'book' and book_type in ('epub','txt') and book_path is not null and id not in (select id from book) and id not in (select article_id from book_chapter)")
            .map_err(crate::db::sql_err)?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(crate::db::sql_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(crate::db::sql_err)?;
        Ok(ids)
    })?;
    let mut n = 0;
    for id in ids {
        match register_local_book_in_dir(data_dir, &id) {
            Ok(true) => n += 1,
            Ok(false) => {}
            Err(e) => eprintln!("[books] could not register {id}: {e}"),
        }
    }
    Ok(n)
}

fn ensure_dir(path: &Path, name: &str) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("Failed to create {}: {}", name, e))
}

pub fn save_agent_task_in_dir(data_dir: &Path, task: &AgentTask) -> Result<(), String> {
    let dir = data_dir.join(AGENT_TASKS_DIR);
    ensure_dir(&dir, "agent task directory")?;
    let content = serde_json::to_string(task)
        .map_err(|e| format!("Failed to serialize agent task: {}", e))?;
    fs::write(dir.join(format!("{}.json", task.id)), content)
        .map_err(|e| format!("Failed to save agent task: {}", e))?;
    Ok(())
}

pub fn load_agent_task_in_dir(data_dir: &Path, task_id: &str) -> Result<AgentTask, String> {
    let path = data_dir.join(AGENT_TASKS_DIR).join(format!("{}.json", task_id));
    let content =
        fs::read_to_string(path).map_err(|e| format!("Failed to read agent task: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse agent task: {}", e))
}

pub fn list_agent_tasks_in_dir(data_dir: &Path) -> Result<Vec<String>, String> {
    let dir = data_dir.join(AGENT_TASKS_DIR);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let entries =
        fs::read_dir(dir).map_err(|e| format!("Failed to read agent task directory: {}", e))?;
    let mut ids: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .map(|file_name| file_name.trim_end_matches(".json").to_string())
        .collect();
    ids.sort();
    Ok(ids)
}

pub fn save_agent_task(app_handle: &AppHandle, task: &AgentTask) -> Result<(), String> {
    let data_dir = get_app_data_dir(app_handle)?;
    save_agent_task_in_dir(&data_dir, task)
}

pub fn load_agent_task(app_handle: &AppHandle, task_id: &str) -> Result<AgentTask, String> {
    let data_dir = get_app_data_dir(app_handle)?;
    load_agent_task_in_dir(&data_dir, task_id)
}

pub fn save_artifact_in_dir(data_dir: &Path, artifact: &Artifact) -> Result<(), String> {
    let dir = data_dir.join(ARTIFACTS_DIR).join(&artifact.article_id);
    ensure_dir(&dir, "artifact directory")?;
    let content = serde_json::to_string(artifact)
        .map_err(|e| format!("Failed to serialize artifact: {}", e))?;
    fs::write(dir.join(format!("{}.json", artifact.id)), content)
        .map_err(|e| format!("Failed to save artifact: {}", e))?;
    Ok(())
}

pub fn load_artifact_in_dir(
    data_dir: &Path,
    article_id: &str,
    artifact_id: &str,
) -> Result<Artifact, String> {
    let path = data_dir
        .join(ARTIFACTS_DIR)
        .join(article_id)
        .join(format!("{}.json", artifact_id));
    let content = fs::read_to_string(path).map_err(|e| format!("Failed to read artifact: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse artifact: {}", e))
}

pub fn save_artifact(app_handle: &AppHandle, artifact: &Artifact) -> Result<(), String> {
    let data_dir = get_app_data_dir(app_handle)?;
    save_artifact_in_dir(&data_dir, artifact)
}

pub fn load_artifact(
    app_handle: &AppHandle,
    article_id: &str,
    artifact_id: &str,
) -> Result<Artifact, String> {
    let data_dir = get_app_data_dir(app_handle)?;
    load_artifact_in_dir(&data_dir, article_id, artifact_id)
}

pub fn update_article_active_mind_map_artifact_in_dir(
    data_dir: &Path,
    article_id: &str,
    artifact_id: Option<String>,
) -> Result<Article, String> {
    let path = data_dir.join(ARTICLES_DIR).join(article_id);
    let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read article: {}", e))?;
    let mut article: Article =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse article: {}", e))?;
    article.active_mind_map_artifact_id = artifact_id;
    let updated = serde_json::to_string(&article)
        .map_err(|e| format!("Failed to serialize article: {}", e))?;
    fs::write(path, updated).map_err(|e| format!("Failed to save article: {}", e))?;
    Ok(article)
}

pub fn update_article_active_mind_map_artifact(
    app_handle: &AppHandle,
    article_id: &str,
    artifact_id: Option<String>,
) -> Result<Article, String> {
    let data_dir = get_app_data_dir(app_handle)?;
    update_article_active_mind_map_artifact_in_dir(&data_dir, article_id, artifact_id)
}

// ============================================================================
// Favorites Storage - 独立于文章存储，删除文章不会影响收藏
//
// 生词、词包、复习日志与书签存放在 SQLite(见 crate::db);语法收藏仍是 JSON 文件。
// 这里保留原有的 JSON 字符串接口,命令层无需改动。所有写入都会标记同步脏记录。
// ============================================================================

use crate::db::repo::{self, Track, VocabularyWrite};
use crate::types::{Bookmark, FavoriteVocabulary, ReviewEvent, WordPack};

const FAVORITES_GRAMMAR_DIR: &str = "favorites/grammar";

fn write_db<T>(
    app_handle: &AppHandle,
    f: impl FnOnce(&rusqlite::Transaction) -> Result<T, String>,
) -> Result<T, String> {
    let db = db_for(app_handle)?;
    let out = db.write(f)?;
    crate::sync::notify_local_change();
    Ok(out)
}

fn read_db<T>(
    app_handle: &AppHandle,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    db_for(app_handle)?.read(f)
}

/// 确保收藏夹存储就绪(SQLite + 语法收藏目录)
pub fn ensure_favorites_dirs(app_handle: &AppHandle) -> Result<(), String> {
    let data_dir = get_app_data_dir(app_handle)?;
    fs::create_dir_all(data_dir.join(FAVORITES_GRAMMAR_DIR))
        .map_err(|e| format!("Failed to create grammar favorites directory: {}", e))?;
    db_for(app_handle)?;
    Ok(())
}

// ----------------------------------------------------------------------------
// 复习事件日志(append-only;规范 §1.3)
// ----------------------------------------------------------------------------

/// 追加一条复习事件。事件不可变:只追加,永不改写。
pub fn append_review_event(app_handle: &AppHandle, event: &ReviewEvent) -> Result<(), String> {
    write_db(app_handle, |tx| {
        repo::insert_review_event(tx, event, None, Track::Record).map(|_| ())
    })
}

/// 读取全部有效复习事件(撤销标记与被撤销的事件已剔除,同步规范 §6)。
pub fn list_review_events(app_handle: &AppHandle) -> Result<Vec<ReviewEvent>, String> {
    read_db(app_handle, repo::list_review_events)
}

// ----------------------------------------------------------------------------
// 生词
// ----------------------------------------------------------------------------

/// 保存单词收藏(JSON 为 FavoriteVocabulary)
pub fn save_favorite_vocabulary(
    app_handle: &AppHandle,
    id: &str,
    content: &str,
) -> Result<(), String> {
    let mut favorite: FavoriteVocabulary = serde_json::from_str(content)
        .map_err(|e| format!("Failed to parse vocabulary favorite: {}", e))?;
    favorite.id = id.to_string();
    write_db(app_handle, |tx| {
        repo::save_vocabulary(
            tx,
            VocabularyWrite {
                fav: &favorite,
                updated_at: None,
                memberships: true,
                track: Track::Record,
            },
        )
        .map(|_| ())
    })
}

/// 加载单词收藏
pub fn load_favorite_vocabulary(app_handle: &AppHandle, id: &str) -> Result<String, String> {
    let favorite = read_db(app_handle, |c| repo::load_vocabulary(c, id))?
        .ok_or_else(|| "Vocabulary favorite not found".to_string())?;
    serde_json::to_string(&favorite)
        .map_err(|e| format!("Failed to serialize vocabulary favorite: {}", e))
}

/// 一次性读取全部单词收藏(含 pack_ids)
pub fn load_all_favorite_vocabularies(
    app_handle: &AppHandle,
) -> Result<Vec<FavoriteVocabulary>, String> {
    read_db(app_handle, repo::list_vocabularies)
}

/// 列出所有单词收藏ID
pub fn list_favorite_vocabularies(app_handle: &AppHandle) -> Result<Vec<String>, String> {
    read_db(app_handle, repo::list_vocabulary_ids)
}

/// 删除单词收藏(复习事件保留,规范 §1.3)
pub fn delete_favorite_vocabulary(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    write_db(app_handle, |tx| {
        repo::delete_vocabulary(tx, id, Track::Record).map(|_| ())
    })
}

// ----------------------------------------------------------------------------
// 语法收藏(仍为 JSON 文件)
// ----------------------------------------------------------------------------

/// 保存语法收藏
pub fn save_favorite_grammar(
    app_handle: &AppHandle,
    id: &str,
    content: &str,
) -> Result<(), String> {
    ensure_favorites_dirs(app_handle)?;
    let data_dir = get_app_data_dir(app_handle)?;
    let path = data_dir.join(FAVORITES_GRAMMAR_DIR).join(id);

    fs::write(path, content).map_err(|e| format!("Failed to save grammar favorite: {}", e))?;

    Ok(())
}

/// 加载语法收藏
pub fn load_favorite_grammar(app_handle: &AppHandle, id: &str) -> Result<String, String> {
    let data_dir = get_app_data_dir(app_handle)?;
    let path = data_dir.join(FAVORITES_GRAMMAR_DIR).join(id);

    if !path.exists() {
        return Err("Grammar favorite not found".to_string());
    }

    fs::read_to_string(path).map_err(|e| format!("Failed to read grammar favorite: {}", e))
}

/// 列出所有语法收藏ID
pub fn list_favorite_grammars(app_handle: &AppHandle) -> Result<Vec<String>, String> {
    let data_dir = get_app_data_dir(app_handle)?;
    let dir = data_dir.join(FAVORITES_GRAMMAR_DIR);

    if !dir.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(dir)
        .map_err(|e| format!("Failed to read grammar favorites directory: {}", e))?;

    let ids: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();

    Ok(ids)
}

/// 删除语法收藏
pub fn delete_favorite_grammar(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    let data_dir = get_app_data_dir(app_handle)?;
    let path = data_dir.join(FAVORITES_GRAMMAR_DIR).join(id);

    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("Failed to delete grammar favorite: {}", e))?;
    }

    Ok(())
}

// ----------------------------------------------------------------------------
// 单词包
// ----------------------------------------------------------------------------

/// 保存单词包
pub fn save_word_pack(app_handle: &AppHandle, id: &str, content: &str) -> Result<(), String> {
    let mut pack: WordPack =
        serde_json::from_str(content).map_err(|e| format!("Failed to parse word pack: {}", e))?;
    pack.id = id.to_string();
    write_db(app_handle, |tx| repo::save_pack(tx, &pack, Track::Record).map(|_| ()))
}

/// 加载单词包
pub fn load_word_pack(app_handle: &AppHandle, id: &str) -> Result<String, String> {
    let pack = read_db(app_handle, |c| repo::load_pack(c, id))?
        .ok_or_else(|| "Word pack not found".to_string())?;
    serde_json::to_string(&pack).map_err(|e| format!("Failed to serialize word pack: {}", e))
}

/// 一次性读取全部单词包
pub fn load_all_word_packs(app_handle: &AppHandle) -> Result<Vec<WordPack>, String> {
    read_db(app_handle, repo::list_packs)
}

/// 列出所有单词包ID
pub fn list_word_packs(app_handle: &AppHandle) -> Result<Vec<String>, String> {
    Ok(load_all_word_packs(app_handle)?
        .into_iter()
        .map(|p| p.id)
        .collect())
}

/// 删除单词包
pub fn delete_word_pack(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    write_db(app_handle, |tx| repo::delete_pack(tx, id, Track::Record).map(|_| ()))
}

// ============================================================================
// Bookmarks Storage - 书签存储(SQLite book_mark 表)
// ============================================================================

/// 书签存储就绪(SQLite)
pub fn ensure_bookmarks_dir(app_handle: &AppHandle) -> Result<(), String> {
    db_for(app_handle).map(|_| ())
}

/// 保存书签
pub fn save_bookmark(app_handle: &AppHandle, id: &str, content: &str) -> Result<(), String> {
    let mut bookmark: Bookmark =
        serde_json::from_str(content).map_err(|e| format!("Failed to parse bookmark: {}", e))?;
    bookmark.id = id.to_string();
    write_db(app_handle, |tx| {
        repo::save_bookmark(tx, &bookmark, None, Track::Record).map(|_| ())
    })
}

/// 加载书签
pub fn load_bookmark(app_handle: &AppHandle, id: &str) -> Result<String, String> {
    let bookmark = read_db(app_handle, |c| repo::load_bookmark(c, id))?
        .ok_or_else(|| "Bookmark not found".to_string())?;
    serde_json::to_string(&bookmark).map_err(|e| format!("Failed to serialize bookmark: {}", e))
}

/// 一次性读取全部书签
pub fn load_all_bookmarks(app_handle: &AppHandle) -> Result<Vec<Bookmark>, String> {
    read_db(app_handle, repo::list_bookmarks)
}

/// 列出所有书签ID
pub fn list_bookmarks(app_handle: &AppHandle) -> Result<Vec<String>, String> {
    Ok(load_all_bookmarks(app_handle)?
        .into_iter()
        .map(|b| b.id)
        .collect())
}

/// 删除书签
pub fn delete_bookmark(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    write_db(app_handle, |tx| repo::delete_bookmark(tx, id, Track::Record).map(|_| ()))
}

/// 列出指定书籍的所有书签
pub fn list_bookmarks_for_book(
    app_handle: &AppHandle,
    book_path: &str,
) -> Result<Vec<String>, String> {
    Ok(load_all_bookmarks(app_handle)?
        .into_iter()
        .filter(|b| b.book_path == book_path)
        .map(|b| b.id)
        .collect())
}

/// 单条生词收藏最后一次被修改的时间(SQLite `updated_at`)。
pub fn favorite_vocabulary_modified_at(
    app_handle: &AppHandle,
    id: &str,
) -> Option<std::time::SystemTime> {
    let updated = read_db(app_handle, |c| repo::vocabulary_updated_at(c, id)).ok()??;
    let dt = chrono::DateTime::parse_from_rfc3339(&updated).ok()?;
    Some(std::time::SystemTime::from(dt.with_timezone(&chrono::Utc)))
}

#[cfg(test)]
mod config_secret_tests {
    use super::*;
    use crate::cloud::secrets::{MemoryStore, API_KEY_PLACEHOLDER};

    #[test]
    fn plaintext_api_keys_move_to_the_keychain_on_load() {
        let dir = std::env::temp_dir().join(format!("openkoto-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(CONFIG_FILE),
            r#"{"target_language":"zh-CN","active_model_id":"m1","model_configs":[{"id":"m1","name":"n","api_key":"sk-live-123","api_provider":"openai","model":"gpt","is_default":true}]}"#,
        )
        .unwrap();
        let store = MemoryStore::default();

        let config = load_config_in_dir(&dir, &store).unwrap().unwrap();
        // The app (and get_config for the frontend) still sees the real key…
        assert_eq!(config.model_configs[0].api_key, "sk-live-123");
        // …but the file no longer contains it.
        let on_disk = fs::read_to_string(dir.join(CONFIG_FILE)).unwrap();
        assert!(!on_disk.contains("sk-live-123"));
        assert!(on_disk.contains(API_KEY_PLACEHOLDER));

        // Saving round-trips through the keychain; deleting a config forgets its key.
        let mut next = config.clone();
        next.model_configs.clear();
        save_config_in_dir(&dir, &next, &store).unwrap();
        use crate::cloud::secrets::SecretStore;
        assert!(store.get("model-api-key:m1").unwrap().is_none());
        let _ = fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod book_registration_tests {
    use super::*;

    #[test]
    fn existing_txt_books_are_backfilled_into_book_records() {
        let dir = std::env::temp_dir().join(format!("openkoto-books-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join(BOOKS_DIR)).unwrap();
        let id = "0b8e2c1a-5d4f-4e3a-9b2c-1d0e9f8a7b42";
        let file = dir.join(BOOKS_DIR).join(format!("{id}.txt"));
        fs::write(&file, "第一章 起\n正文一\n第二章 承\n正文二\n").unwrap();
        let article = Article {
            id: id.into(),
            title: "我的小说".into(),
            content: "…".into(),
            source_type: Some("book".into()),
            source_url: None,
            media_path: None,
            book_path: Some(file.to_string_lossy().into_owned()),
            book_type: Some("txt".into()),
            created_at: "2026-09-28T00:00:00Z".into(),
            translated: false,
            active_mind_map_artifact_id: None,
            segments: vec![],
        };
        save_article_in_dir(&dir, id, &serde_json::to_string(&article).unwrap()).unwrap();
        assert_eq!(backfill_books_in_dir(&dir).unwrap(), 1);
        assert_eq!(backfill_books_in_dir(&dir).unwrap(), 0);
        let db = crate::db::open(&dir).unwrap();
        db.read(|c| {
            let book = crate::db::books::load_book(c, id)?.unwrap();
            assert_eq!(book.title, "我的小说");
            assert_eq!(book.format, "txt");
            assert_eq!(book.file_size, Some(fs::metadata(&file).unwrap().len() as i64));
            assert!(book.file_uploaded_sha.is_none());
            assert_eq!(crate::db::books::chapters_with_text(c, id)?.len(), 2);
            assert!(crate::sync::store::get_record(c, "Book", id)?.unwrap().dirty);
            Ok(())
        })
        .unwrap();
        // Chapter articles never become list items.
        assert_eq!(fs::read_dir(dir.join(ARTICLES_DIR)).unwrap().count(), 1);
        crate::db::close(&dir);
        let _ = fs::remove_dir_all(dir);
    }
}
