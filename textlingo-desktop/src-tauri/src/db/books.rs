//! Books (Book / BookChapter / chapter Articles / BookProgress) and lyrics metadata
//! (LyricsMeta), sync-protocol-spec §2.2.
//!
//! On the desktop a book is one reader article (`source_type = "book"`, `book_path` = local
//! file) whose id is also the Book record id. Chapters are extra `article` rows with
//! `source_type = "book"` plus `book_chapter` rows; they never appear in the article list.

use super::repo::{record, Track};
use super::sql_err;
use crate::book_content::ParsedBook;
use crate::sync::payload::{self, get_bool, get_f64, get_i64, get_str, iso, now_iso, obj, opt_str};
use crate::sync::protocol::JsonObject;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BookRow {
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub language: Option<String>,
    pub format: String,
    pub total_chars: i64,
    pub default_mode: String,
    pub original_only: bool,
    pub file_sha256: Option<String>,
    pub file_size: Option<i64>,
    pub file_uploaded_sha: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_book(r: &Row) -> rusqlite::Result<BookRow> {
    Ok(BookRow {
        id: r.get("id")?,
        title: r.get("title")?,
        author: r.get("author")?,
        language: r.get("language")?,
        format: r.get("format")?,
        total_chars: r.get("total_chars")?,
        default_mode: r.get("default_mode")?,
        original_only: r.get::<_, i64>("original_only")? != 0,
        file_sha256: r.get("file_sha256")?,
        file_size: r.get("file_size")?,
        file_uploaded_sha: r.get("file_uploaded_sha")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

pub fn load_book(conn: &Connection, id: &str) -> Result<Option<BookRow>, String> {
    conn.query_row("select * from book where id = ?1", [id], row_to_book)
        .optional()
        .map_err(sql_err)
}

pub fn list_books(conn: &Connection) -> Result<Vec<BookRow>, String> {
    let mut stmt = conn
        .prepare("select * from book order by created_at, rowid")
        .map_err(sql_err)?;
    let rows = stmt
        .query_map([], row_to_book)
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    Ok(rows)
}

pub fn book_payload(b: &BookRow) -> JsonObject {
    obj(json!({
        "id": b.id.to_lowercase(),
        "title": b.title,
        "author": b.author,
        "language": b.language,
        "format": b.format,
        "dirName": b.id.to_lowercase(),
        "totalChars": b.total_chars,
        "defaultMode": b.default_mode,
        "originalOnly": b.original_only,
        "createdAt": iso(&b.created_at).unwrap_or_else(now_iso),
        "fileSha256": b.file_sha256,
        "fileSize": b.file_size,
    }))
}

fn upsert_book_row(conn: &Connection, b: &BookRow) -> Result<(), String> {
    conn.execute(
        "insert into book (id, title, author, language, format, total_chars, default_mode, original_only,
           file_sha256, file_size, file_uploaded_sha, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         on conflict(id) do update set title = excluded.title, author = excluded.author,
           language = excluded.language, format = excluded.format, total_chars = excluded.total_chars,
           default_mode = excluded.default_mode, original_only = excluded.original_only,
           file_sha256 = excluded.file_sha256, file_size = excluded.file_size,
           file_uploaded_sha = coalesce(excluded.file_uploaded_sha, book.file_uploaded_sha),
           created_at = excluded.created_at, updated_at = excluded.updated_at",
        params![
            b.id,
            b.title,
            b.author,
            b.language,
            b.format,
            b.total_chars,
            b.default_mode,
            b.original_only as i64,
            b.file_sha256,
            b.file_size,
            b.file_uploaded_sha,
            b.created_at,
            b.updated_at,
        ],
    )
    .map(|_| ())
    .map_err(sql_err)
}

/// Remote Book payload → row (the file counts as uploaded: another device did it).
pub fn apply_remote_book(conn: &Connection, id: &str, p: &JsonObject) -> Result<(), String> {
    let sha = get_str(p, "fileSha256");
    upsert_book_row(
        conn,
        &BookRow {
            id: id.to_lowercase(),
            title: get_str(p, "title").unwrap_or_default(),
            author: get_str(p, "author"),
            language: get_str(p, "language"),
            format: get_str(p, "format").unwrap_or_else(|| "txt".into()),
            total_chars: get_i64(p, "totalChars").unwrap_or(0),
            default_mode: get_str(p, "defaultMode").unwrap_or_else(|| "native".into()),
            original_only: get_bool(p, "originalOnly").unwrap_or(false),
            file_uploaded_sha: sha.clone(),
            file_sha256: sha,
            file_size: get_i64(p, "fileSize"),
            created_at: get_str(p, "createdAt").unwrap_or_else(now_iso),
            updated_at: now_iso(),
        },
    )
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChapterRow {
    pub article_id: String,
    pub book_id: String,
    pub index: i64,
    pub title: Option<String>,
    pub is_segmented: bool,
    pub char_count: i64,
}

pub fn chapter_payload(c: &ChapterRow) -> JsonObject {
    obj(json!({
        "articleId": c.article_id.to_lowercase(),
        "bookId": c.book_id.to_lowercase(),
        "index": c.index,
        "title": c.title,
        "isSegmented": c.is_segmented,
        "charCount": c.char_count,
    }))
}

pub fn upsert_chapter(conn: &Connection, c: &ChapterRow) -> Result<(), String> {
    conn.execute(
        "insert into book_chapter (article_id, book_id, chapter_index, title, is_segmented, char_count)
         values (?1, ?2, ?3, ?4, ?5, ?6)
         on conflict(article_id) do update set book_id = excluded.book_id,
           chapter_index = excluded.chapter_index, title = excluded.title,
           is_segmented = excluded.is_segmented, char_count = excluded.char_count",
        params![c.article_id, c.book_id, c.index, c.title, c.is_segmented as i64, c.char_count],
    )
    .map(|_| ())
    .map_err(sql_err)
}

pub fn apply_remote_chapter(
    conn: &Connection,
    article_id: &str,
    p: &JsonObject,
) -> Result<Option<String>, String> {
    let Some(book_id) = get_str(p, "bookId").map(|s| s.to_lowercase()) else {
        return Ok(None);
    };
    upsert_chapter(
        conn,
        &ChapterRow {
            article_id: article_id.to_lowercase(),
            book_id: book_id.clone(),
            index: get_i64(p, "index").unwrap_or(0),
            title: get_str(p, "title"),
            is_segmented: get_bool(p, "isSegmented").unwrap_or(false),
            char_count: get_i64(p, "charCount").unwrap_or(0),
        },
    )?;
    Ok(Some(book_id))
}

pub fn chapter_book_id(conn: &Connection, article_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "select book_id from book_chapter where article_id = ?1",
        [article_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(sql_err)
}

/// Chapters of a book with their text, in order.
pub fn chapters_with_text(
    conn: &Connection,
    book_id: &str,
) -> Result<Vec<(ChapterRow, String)>, String> {
    let mut stmt = conn
        .prepare(
            "select c.article_id, c.book_id, c.chapter_index, c.title, c.is_segmented, c.char_count,
                    coalesce(a.content, ''), a.title
             from book_chapter c left join article a on a.id = c.article_id
             where c.book_id = ?1 order by c.chapter_index, c.rowid",
        )
        .map_err(sql_err)?;
    let rows = stmt
        .query_map([book_id], |r| {
            let title: Option<String> = r.get(3)?;
            let article_title: Option<String> = r.get(7)?;
            Ok((
                ChapterRow {
                    article_id: r.get(0)?,
                    book_id: r.get(1)?,
                    index: r.get(2)?,
                    title: title.or(article_title),
                    is_segmented: r.get::<_, i64>(4)? != 0,
                    char_count: r.get(5)?,
                },
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    Ok(rows)
}

fn chapter_article_payload(id: &str, title: &str, content: &str, created_at: &str) -> JsonObject {
    obj(json!({
        "id": id.to_lowercase(),
        "title": title,
        "content": content,
        "sourceType": "book",
        "createdAt": iso(created_at).unwrap_or_else(now_iso),
    }))
}

/// Create the Book + chapters for a desktop book article `book_id` (records them for sync).
pub fn create_book(
    conn: &Connection,
    book_id: &str,
    parsed: &ParsedBook,
    file_sha256: &str,
    file_size: i64,
    created_at: &str,
    track: Track,
) -> Result<BookRow, String> {
    let total_chars: i64 = parsed
        .chapters
        .iter()
        .map(|c| c.text.chars().count() as i64)
        .sum();
    let book = BookRow {
        id: book_id.to_lowercase(),
        title: parsed.title.clone(),
        author: parsed.author.clone(),
        language: parsed.language.clone(),
        format: parsed.format.clone(),
        total_chars,
        default_mode: "native".into(),
        original_only: false,
        file_sha256: Some(file_sha256.to_string()),
        file_size: Some(file_size),
        file_uploaded_sha: None,
        created_at: created_at.to_string(),
        updated_at: created_at.to_string(),
    };
    upsert_book_row(conn, &book)?;
    record(
        conn,
        track,
        "Book",
        &book.id,
        Some(book_payload(&book)),
        created_at,
    )?;
    for (index, ch) in parsed.chapters.iter().enumerate() {
        let article_id = uuid::Uuid::new_v4().to_string();
        let fields = payload::ArticleFields {
            title: ch.title.clone(),
            content: ch.text.clone(),
            source_type: Some("book".into()),
            source_url: None,
            created_at: created_at.to_string(),
        };
        super::repo::upsert_article_row(conn, &article_id, &fields, created_at)?;
        record(
            conn,
            track,
            "Article",
            &article_id,
            Some(chapter_article_payload(
                &article_id,
                &ch.title,
                &ch.text,
                created_at,
            )),
            created_at,
        )?;
        let chapter = ChapterRow {
            article_id: article_id.clone(),
            book_id: book.id.clone(),
            index: index as i64,
            title: Some(ch.title.clone()),
            is_segmented: false,
            char_count: ch.text.chars().count() as i64,
        };
        upsert_chapter(conn, &chapter)?;
        record(
            conn,
            track,
            "BookChapter",
            &article_id,
            Some(chapter_payload(&chapter)),
            created_at,
        )?;
    }
    Ok(book)
}

/// Delete a book, its chapters (Article + BookChapter + Segments) and progress.
pub fn delete_book(conn: &Connection, book_id: &str, track: Track) -> Result<(), String> {
    let chapter_ids: Vec<String> = {
        let mut stmt = conn
            .prepare("select article_id from book_chapter where book_id = ?1")
            .map_err(sql_err)?;
        let ids = stmt
            .query_map([book_id], |r| r.get::<_, String>(0))
            .map_err(sql_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_err)?;
        ids
    };
    for id in chapter_ids {
        super::repo::delete_article(conn, &id, track)?;
    }
    conn.execute("delete from book where id = ?1", [book_id])
        .map_err(sql_err)?;
    conn.execute("delete from book_progress where book_id = ?1", [book_id])
        .map_err(sql_err)?;
    record(conn, track, "BookProgress", book_id, None, "")?;
    record(conn, track, "Book", book_id, None, "")?;
    if track == Track::Record {
        queue_file_delete(conn, book_id)?;
    }
    Ok(())
}

pub fn mark_file_uploaded(conn: &Connection, book_id: &str, sha: &str) -> Result<(), String> {
    conn.execute(
        "update book set file_uploaded_sha = ?2 where id = ?1",
        params![book_id, sha],
    )
    .map(|_| ())
    .map_err(sql_err)
}

const META_PENDING_FILE_DELETES: &str = "pendingBookFileDeletes";

fn queue_file_delete(conn: &Connection, book_id: &str) -> Result<(), String> {
    let mut ids = pending_file_deletes(conn)?;
    if !ids.iter().any(|i| i == book_id) {
        ids.push(book_id.to_string());
    }
    crate::sync::store::set_meta(
        conn,
        META_PENDING_FILE_DELETES,
        Some(&serde_json::to_string(&ids).unwrap_or_default()),
    )
}

pub fn pending_file_deletes(conn: &Connection) -> Result<Vec<String>, String> {
    Ok(
        crate::sync::store::get_meta(conn, META_PENDING_FILE_DELETES)?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
    )
}

pub fn clear_file_delete(conn: &Connection, book_id: &str) -> Result<(), String> {
    let ids: Vec<String> = pending_file_deletes(conn)?
        .into_iter()
        .filter(|i| i != book_id)
        .collect();
    crate::sync::store::set_meta(
        conn,
        META_PENDING_FILE_DELETES,
        if ids.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&ids).unwrap_or_default())
        }
        .as_deref(),
    )
}

// MARK: - BookProgress

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct BookProgress {
    pub book_id: String,
    pub chapter_article_id: Option<String>,
    pub chapter_index: i64,
    pub segment_order: Option<i64>,
    pub scroll_fraction: Option<f64>,
    pub mode: String,
    /// Desktop EPUB CFI (kept as an extra payload field).
    pub locator: Option<String>,
    /// Desktop PDF page (1-based).
    pub page_number: Option<i64>,
    pub updated_at: String,
}

pub fn load_progress(conn: &Connection, book_id: &str) -> Result<Option<BookProgress>, String> {
    conn.query_row(
        "select * from book_progress where book_id = ?1",
        [book_id],
        |r| {
            Ok(BookProgress {
                book_id: r.get("book_id")?,
                chapter_article_id: r.get("chapter_article_id")?,
                chapter_index: r.get("chapter_index")?,
                segment_order: r.get("segment_order")?,
                scroll_fraction: r.get("scroll_fraction")?,
                mode: r.get("mode")?,
                locator: r.get("locator")?,
                page_number: r.get("page_number")?,
                updated_at: r.get("updated_at")?,
            })
        },
    )
    .optional()
    .map_err(sql_err)
}

pub fn progress_payload(p: &BookProgress) -> JsonObject {
    obj(json!({
        "bookId": p.book_id.to_lowercase(),
        "chapterArticleId": p.chapter_article_id,
        "chapterIndex": p.chapter_index,
        "segmentOrder": p.segment_order,
        "scrollFraction": p.scroll_fraction,
        "mode": p.mode,
        "updatedAt": iso(&p.updated_at).unwrap_or_else(now_iso),
        "locator": p.locator,
        "pageNumber": p.page_number,
    }))
}

pub fn save_progress(conn: &Connection, p: &BookProgress, track: Track) -> Result<bool, String> {
    let existing = load_progress(conn, &p.book_id)?;
    let same = existing
        .as_ref()
        .map(|e| {
            e.chapter_index == p.chapter_index
                && e.locator == p.locator
                && e.page_number == p.page_number
                && e.chapter_article_id == p.chapter_article_id
                && e.segment_order == p.segment_order
                && e.scroll_fraction == p.scroll_fraction
                && e.mode == p.mode
        })
        .unwrap_or(false);
    if same {
        return Ok(false);
    }
    conn.execute(
        "insert into book_progress (book_id, chapter_article_id, chapter_index, segment_order, scroll_fraction,
           mode, locator, page_number, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         on conflict(book_id) do update set chapter_article_id = excluded.chapter_article_id,
           chapter_index = excluded.chapter_index, segment_order = excluded.segment_order,
           scroll_fraction = excluded.scroll_fraction, mode = excluded.mode, locator = excluded.locator,
           page_number = excluded.page_number, updated_at = excluded.updated_at",
        params![
            p.book_id,
            p.chapter_article_id,
            p.chapter_index,
            p.segment_order,
            p.scroll_fraction,
            p.mode,
            p.locator,
            p.page_number,
            p.updated_at,
        ],
    )
    .map_err(sql_err)?;
    if payload::is_uuid(&p.book_id) {
        record(
            conn,
            track,
            "BookProgress",
            &p.book_id,
            Some(progress_payload(p)),
            &p.updated_at,
        )?;
    }
    Ok(true)
}

pub fn progress_from_payload(book_id: &str, p: &JsonObject) -> BookProgress {
    BookProgress {
        book_id: book_id.to_lowercase(),
        chapter_article_id: get_str(p, "chapterArticleId").map(|s| s.to_lowercase()),
        chapter_index: get_i64(p, "chapterIndex").unwrap_or(0),
        segment_order: get_i64(p, "segmentOrder"),
        scroll_fraction: get_f64(p, "scrollFraction"),
        mode: get_str(p, "mode").unwrap_or_else(|| "native".into()),
        locator: get_str(p, "locator"),
        page_number: get_i64(p, "pageNumber"),
        updated_at: get_str(p, "updatedAt").unwrap_or_else(now_iso),
    }
}

// MARK: - LyricsMeta

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct LyricsMeta {
    pub article_id: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub language: Option<String>,
    pub lrc_offset_ms: Option<i64>,
    pub source_format: Option<String>,
    pub cover_url: Option<String>,
}

pub fn lyrics_meta_payload(m: &LyricsMeta) -> JsonObject {
    obj(json!({
        "articleId": m.article_id.to_lowercase(),
        "artist": opt_str(&m.artist),
        "album": opt_str(&m.album),
        "language": opt_str(&m.language),
        "lrcOffsetMs": m.lrc_offset_ms,
        "sourceFormat": opt_str(&m.source_format),
        "coverUrl": opt_str(&m.cover_url),
    }))
}

pub fn lyrics_meta_from_payload(article_id: &str, p: &JsonObject) -> LyricsMeta {
    LyricsMeta {
        article_id: article_id.to_lowercase(),
        artist: get_str(p, "artist"),
        album: get_str(p, "album"),
        language: get_str(p, "language"),
        lrc_offset_ms: get_i64(p, "lrcOffsetMs"),
        source_format: get_str(p, "sourceFormat"),
        cover_url: get_str(p, "coverUrl"),
    }
}

pub fn save_lyrics_meta(conn: &Connection, m: &LyricsMeta, track: Track) -> Result<(), String> {
    conn.execute(
        "insert into lyrics_meta (article_id, artist, album, language, lrc_offset_ms, source_format, cover_url)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         on conflict(article_id) do update set artist = excluded.artist, album = excluded.album,
           language = excluded.language, lrc_offset_ms = excluded.lrc_offset_ms,
           source_format = excluded.source_format, cover_url = excluded.cover_url",
        params![m.article_id, m.artist, m.album, m.language, m.lrc_offset_ms, m.source_format, m.cover_url],
    )
    .map_err(sql_err)?;
    if payload::is_uuid(&m.article_id) {
        record(
            conn,
            track,
            "LyricsMeta",
            &m.article_id,
            Some(lyrics_meta_payload(m)),
            &now_iso(),
        )?;
    }
    Ok(())
}

pub fn load_lyrics_meta(conn: &Connection, article_id: &str) -> Result<Option<LyricsMeta>, String> {
    conn.query_row(
        "select * from lyrics_meta where article_id = ?1",
        [article_id],
        |r| {
            Ok(LyricsMeta {
                article_id: r.get("article_id")?,
                artist: r.get("artist")?,
                album: r.get("album")?,
                language: r.get("language")?,
                lrc_offset_ms: r.get("lrc_offset_ms")?,
                source_format: r.get("source_format")?,
                cover_url: r.get("cover_url")?,
            })
        },
    )
    .optional()
    .map_err(sql_err)
}

pub fn delete_lyrics_meta(conn: &Connection, article_id: &str) -> Result<(), String> {
    conn.execute(
        "delete from lyrics_meta where article_id = ?1",
        [article_id],
    )
    .map(|_| ())
    .map_err(sql_err)
}

/// Desktop reader article path of a book (for remote bookmarks without `bookPath`).
pub fn book_path_for(conn: &Connection, book_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "select book_path from article where id = ?1",
        [book_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|o| o.flatten())
    .map_err(sql_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::book_content::{ParsedBook, ParsedChapter};
    use crate::db;
    use crate::sync::store;

    const B1: &str = "0b8e2c1a-5d4f-4e3a-9b2c-1d0e9f8a7b01";

    #[test]
    fn creating_and_deleting_a_book_records_everything() {
        let dir = db::test_util::temp_dir("books");
        let database = db::open(&dir).unwrap();
        let parsed = ParsedBook {
            title: "小说".into(),
            author: Some("作者".into()),
            language: Some("zh".into()),
            format: "txt".into(),
            chapters: vec![
                ParsedChapter {
                    title: "第一章".into(),
                    text: "正文一".into(),
                },
                ParsedChapter {
                    title: "第二章".into(),
                    text: "正文二".into(),
                },
            ],
        };
        database
            .write(|tx| {
                let book = create_book(
                    tx,
                    B1,
                    &parsed,
                    &"a".repeat(64),
                    12,
                    "2026-09-28T00:00:00Z",
                    Track::Record,
                )?;
                assert_eq!(book.total_chars, 6);
                let rec = store::get_record(tx, "Book", B1)?.unwrap();
                assert_eq!(rec.payload.as_ref().unwrap()["format"], "txt");
                assert_eq!(rec.payload.as_ref().unwrap()["defaultMode"], "native");
                let chapters = chapters_with_text(tx, B1)?;
                assert_eq!(chapters.len(), 2);
                assert_eq!(chapters[1].1, "正文二");
                let ch = store::get_record(tx, "BookChapter", &chapters[0].0.article_id)?.unwrap();
                assert_eq!(ch.payload.as_ref().unwrap()["bookId"], B1);
                let art = store::get_record(tx, "Article", &chapters[0].0.article_id)?.unwrap();
                assert_eq!(art.payload.as_ref().unwrap()["sourceType"], "book");

                save_progress(
                    tx,
                    &BookProgress {
                        book_id: B1.into(),
                        chapter_index: 1,
                        mode: "native".into(),
                        locator: Some("epubcfi(/6/4)".into()),
                        updated_at: "2026-09-28T01:00:00Z".into(),
                        ..Default::default()
                    },
                    Track::Record,
                )?;
                let p = store::get_record(tx, "BookProgress", B1)?.unwrap();
                assert_eq!(p.payload.as_ref().unwrap()["locator"], "epubcfi(/6/4)");

                super::super::repo::delete_article(tx, B1, Track::Record)?;
                assert!(store::get_record(tx, "Book", B1)?.unwrap().deleted);
                assert!(store::get_record(tx, "BookProgress", B1)?.unwrap().deleted);
                assert!(
                    store::get_record(tx, "BookChapter", &chapters[0].0.article_id)?
                        .unwrap()
                        .deleted
                );
                assert!(
                    store::get_record(tx, "Article", &chapters[1].0.article_id)?
                        .unwrap()
                        .deleted
                );
                assert_eq!(pending_file_deletes(tx)?, vec![B1.to_string()]);
                Ok(())
            })
            .unwrap();
        db::close(&dir);
        let _ = std::fs::remove_dir_all(dir);
    }
}
