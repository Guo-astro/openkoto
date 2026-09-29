//! Local SQLite database (rusqlite, bundled SQLite).
//!
//! Tables mirror the iOS schema (`openkoto-ios/.../OKPersistence/AppDatabase.swift`) so the two
//! clients map one-to-one onto the sync protocol record types, plus the sync bookkeeping tables
//! `sync_meta` / `sync_record` used by [`crate::sync`].
//!
//! One `Database` per data directory is cached process-wide ([`open`]); tests pass temp dirs.
//! The first open of a data directory imports the legacy JSON files (see [`legacy`]).

pub mod books;
pub mod legacy;
pub mod repo;

use rusqlite::{Connection, Transaction};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

pub const DB_FILE: &str = "openkoto.sqlite3";
const SCHEMA_VERSION: i64 = 2;

pub struct Database {
    conn: Mutex<Connection>,
    data_dir: PathBuf,
}

fn registry() -> &'static Mutex<HashMap<PathBuf, Arc<Database>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Arc<Database>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Open (or reuse) the database of `data_dir`, creating the schema and running the one-time
/// legacy JSON import on first use.
pub fn open(data_dir: &Path) -> Result<Arc<Database>, String> {
    let key = data_dir.to_path_buf();
    let mut map = registry()
        .lock()
        .map_err(|_| "database registry poisoned".to_string())?;
    if let Some(db) = map.get(&key) {
        return Ok(db.clone());
    }
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("Failed to create data directory: {e}"))?;
    let conn = Connection::open(data_dir.join(DB_FILE))
        .map_err(|e| format!("Failed to open database: {e}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;",
    )
    .map_err(|e| format!("Failed to configure database: {e}"))?;
    migrate_schema(&conn)?;
    let db = Arc::new(Database {
        conn: Mutex::new(conn),
        data_dir: key.clone(),
    });
    legacy::import_legacy_json_if_needed(&db)?;
    map.insert(key, db.clone());
    Ok(db)
}

/// Drop a cached handle (tests that delete their temp dir).
pub fn close(data_dir: &Path) {
    if let Ok(mut map) = registry().lock() {
        map.remove(data_dir);
    }
}

impl Database {
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Run `f` with the connection (auto-commit mode).
    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        f(&conn)
    }

    /// Run `f` in one IMMEDIATE transaction; commits on Ok, rolls back on Err.
    pub fn write<T>(&self, f: impl FnOnce(&Transaction) -> Result<T, String>) -> Result<T, String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("Failed to begin transaction: {e}"))?;
        let out = f(&tx)?;
        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {e}"))?;
        Ok(out)
    }
}

pub(crate) fn sql_err(e: rusqlite::Error) -> String {
    format!("Database error: {e}")
}

fn migrate_schema(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(sql_err)?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    if version < 1 {
        conn.execute_batch(SCHEMA_V1).map_err(sql_err)?;
    }
    if version < 2 {
        conn.execute_batch(SCHEMA_V2).map_err(sql_err)?;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))
        .map_err(sql_err)?;
    Ok(())
}

/// Schema v1. Column names follow iOS `AppDatabase.swift`; desktop-only columns are marked.
const SCHEMA_V1: &str = r#"
BEGIN;
CREATE TABLE IF NOT EXISTS article (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_type TEXT,
    source_url TEXT,
    -- desktop-only
    media_path TEXT,
    book_path TEXT,
    book_type TEXT,
    translated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS segment (
    id TEXT PRIMARY KEY NOT NULL,
    article_id TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    reading_text TEXT,
    translation TEXT,
    explanation_json TEXT,
    is_new_paragraph INTEGER NOT NULL DEFAULT 0,
    start_time REAL,
    end_time REAL,
    segmentation_revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS segment_article ON segment(article_id, order_index);
CREATE TABLE IF NOT EXISTS favorite_vocabulary (
    id TEXT PRIMARY KEY NOT NULL,
    word TEXT NOT NULL,
    normalized_word TEXT NOT NULL,
    meaning TEXT NOT NULL,
    usage TEXT,
    explanation TEXT,
    example TEXT,
    reading TEXT,
    source_article_id TEXT,
    source_article_title TEXT,
    source_segment_id TEXT,
    srs_state TEXT NOT NULL,
    stability REAL NOT NULL DEFAULT 0,
    difficulty REAL NOT NULL DEFAULT 0,
    scheduler_version TEXT,
    suspended_at TEXT,
    due_date TEXT NOT NULL DEFAULT '',
    last_reviewed_at TEXT,
    review_count INTEGER NOT NULL DEFAULT 0,
    -- desktop-only: frozen SM-2 fields and the SM-2 replay seed (sync spec §6)
    ease_factor REAL NOT NULL DEFAULT 2.5,
    repetitions INTEGER NOT NULL DEFAULT 0,
    interval_days INTEGER NOT NULL DEFAULT 0,
    replay_seed_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS favorite_vocabulary_normalized ON favorite_vocabulary(normalized_word);
CREATE TABLE IF NOT EXISTS word_pack (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    cover_url TEXT,
    author TEXT,
    language_from TEXT,
    language_to TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    version TEXT,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS word_pack_membership (
    vocabulary_id TEXT NOT NULL,
    pack_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (vocabulary_id, pack_id)
);
CREATE INDEX IF NOT EXISTS word_pack_membership_pack ON word_pack_membership(pack_id);
CREATE TABLE IF NOT EXISTS review_log (
    id TEXT PRIMARY KEY NOT NULL,
    vocabulary_id TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    date_local TEXT NOT NULL,
    grade INTEGER NOT NULL,
    elapsed_days INTEGER NOT NULL,
    previous_state TEXT NOT NULL,
    scheduler_version TEXT NOT NULL,
    desired_retention REAL NOT NULL,
    result_stability REAL NOT NULL,
    result_difficulty REAL NOT NULL,
    result_interval_days INTEGER NOT NULL,
    result_state TEXT NOT NULL,
    voids_event_id TEXT
);
CREATE INDEX IF NOT EXISTS review_log_vocabulary ON review_log(vocabulary_id);
CREATE INDEX IF NOT EXISTS review_log_date ON review_log(date_local);
CREATE TABLE IF NOT EXISTS book_progress (
    book_id TEXT PRIMARY KEY NOT NULL,
    chapter_article_id TEXT,
    chapter_index INTEGER NOT NULL DEFAULT 0,
    segment_order INTEGER,
    scroll_fraction REAL,
    mode TEXT NOT NULL DEFAULT 'native',
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS book_mark (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT,
    chapter_article_id TEXT,
    chapter_index INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'bookmark',
    segment_order INTEGER,
    char_start INTEGER,
    char_end INTEGER,
    locator TEXT,
    scroll_fraction REAL,
    selected_text TEXT,
    note TEXT,
    color TEXT,
    -- desktop-only: the desktop reader addresses books by file path
    book_path TEXT NOT NULL DEFAULT '',
    book_type TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    page_number INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS book_mark_path ON book_mark(book_path);
CREATE TABLE IF NOT EXISTS deleted_record (
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    deleted_at TEXT NOT NULL,
    PRIMARY KEY (table_name, record_id)
);
CREATE TABLE IF NOT EXISTS sync_meta (
    k TEXT PRIMARY KEY NOT NULL,
    v TEXT
);
CREATE TABLE IF NOT EXISTS sync_record (
    type TEXT NOT NULL,
    id TEXT NOT NULL,
    rev INTEGER NOT NULL DEFAULT 0,
    hlc TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    dirty INTEGER NOT NULL DEFAULT 0,
    op_id TEXT,
    payload_hash TEXT,
    payload TEXT,
    PRIMARY KEY (type, id)
);
CREATE INDEX IF NOT EXISTS sync_record_dirty ON sync_record(dirty) WHERE dirty = 1;
COMMIT;
"#;

/// Schema v2: books (Book / BookChapter records), lyrics metadata, desktop reading locators.
const SCHEMA_V2: &str = r#"
BEGIN;
CREATE TABLE IF NOT EXISTS book (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    language TEXT,
    format TEXT NOT NULL,
    total_chars INTEGER NOT NULL DEFAULT 0,
    default_mode TEXT NOT NULL DEFAULT 'native',
    original_only INTEGER NOT NULL DEFAULT 0,
    file_sha256 TEXT,
    file_size INTEGER,
    -- desktop-only: sha256 of the file last uploaded to /api/v1/books/:id/file
    file_uploaded_sha TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS book_chapter (
    article_id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    title TEXT,
    is_segmented INTEGER NOT NULL DEFAULT 0,
    char_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS book_chapter_book ON book_chapter(book_id, chapter_index);
CREATE TABLE IF NOT EXISTS lyrics_meta (
    article_id TEXT PRIMARY KEY NOT NULL,
    artist TEXT,
    album TEXT,
    language TEXT,
    lrc_offset_ms INTEGER,
    source_format TEXT,
    cover_url TEXT
);
ALTER TABLE book_progress ADD COLUMN locator TEXT;
ALTER TABLE book_progress ADD COLUMN page_number INTEGER;
COMMIT;
"#;

#[cfg(test)]
pub(crate) mod test_util {
    use std::path::PathBuf;

    pub fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "openkoto-db-test-{}-{}",
            name,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_schema_and_reuses_handles() {
        let dir = test_util::temp_dir("schema");
        let a = open(&dir).unwrap();
        let b = open(&dir).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        let tables: Vec<String> = a
            .read(|c| {
                let mut stmt = c
                    .prepare("select name from sqlite_master where type='table' order by name")
                    .map_err(sql_err)?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(sql_err)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(sql_err)?;
                Ok(rows)
            })
            .unwrap();
        for t in [
            "article",
            "segment",
            "favorite_vocabulary",
            "word_pack",
            "word_pack_membership",
            "review_log",
            "book_progress",
            "book_mark",
            "deleted_record",
            "sync_meta",
            "sync_record",
        ] {
            assert!(tables.iter().any(|x| x == t), "missing table {t}");
        }
        close(&dir);
        // Re-open from disk: schema migration is idempotent.
        let c = open(&dir).unwrap();
        assert!(!Arc::ptr_eq(&a, &c));
        close(&dir);
        let _ = std::fs::remove_dir_all(dir);
    }
}
