//! One-time import of the pre-SQLite JSON storage (desktop ≤ 0.6).
//!
//! - `favorites/vocabulary/<id>`, `favorites/packs/<id>`, `favorites/review_log/*.jsonl` and
//!   `bookmarks/<id>` are imported into SQLite and then moved to `legacy-json-backup/`.
//! - `articles/<id>` stay where they are (they remain the reader's full-fidelity store) and are
//!   mirrored into the `article` / `segment` tables.
//! - `pack_ids` become `word_pack_membership` rows.
//! - Every imported record is marked dirty with a legacy HLC (`<updatedAt ms>-0000-00000000`,
//!   sync spec §3) so the first sign-in uploads it.
//!
//! Idempotent: guarded by `sync_meta.legacyJsonImported`; re-running after a crash between the
//! import commit and the directory move only finishes the move.

use super::repo::{self, Track, VocabularyWrite};
use super::Database;
use crate::sync::store::{get_meta, set_meta, META_LEGACY_IMPORTED};
use crate::types::{Article, Bookmark, FavoriteVocabulary, ReviewEvent, WordPack};
use std::fs;
use std::path::{Path, PathBuf};

pub const BACKUP_DIR: &str = "legacy-json-backup";
/// Directories that are fully replaced by SQLite (relative to the data dir).
pub const MOVED_DIRS: &[&str] = &[
    "favorites/vocabulary",
    "favorites/packs",
    "favorites/review_log",
    "bookmarks",
];

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ImportReport {
    pub vocabulary: usize,
    pub packs: usize,
    pub review_events: usize,
    pub bookmarks: usize,
    pub articles: usize,
    pub skipped: usize,
}

fn files_in(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| !n.starts_with('.'))
                .unwrap_or(false)
        })
        .collect();
    paths.sort();
    paths
}

fn mtime_iso(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339())
}

pub fn import_legacy_json_if_needed(db: &Database) -> Result<Option<ImportReport>, String> {
    let data_dir = db.data_dir().to_path_buf();
    let already = db.read(|c| get_meta(c, META_LEGACY_IMPORTED))?.is_some();
    let report = if already {
        None
    } else {
        let report = import(db, &data_dir)?;
        Some(report)
    };
    move_to_backup(&data_dir)?;
    Ok(report)
}

fn import(db: &Database, data_dir: &Path) -> Result<ImportReport, String> {
    let mut report = ImportReport::default();

    // Parse outside the transaction.
    let mut packs: Vec<WordPack> = Vec::new();
    for path in files_in(&data_dir.join("favorites/packs")) {
        match fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<WordPack>(&s).ok())
        {
            Some(p) => packs.push(p),
            None => report.skipped += 1,
        }
    }
    let mut cards: Vec<(FavoriteVocabulary, String)> = Vec::new();
    for path in files_in(&data_dir.join("favorites/vocabulary")) {
        match fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<FavoriteVocabulary>(&s).ok())
        {
            Some(f) => {
                let updated = mtime_iso(&path).unwrap_or_else(|| f.created_at.clone());
                cards.push((f, updated));
            }
            None => report.skipped += 1,
        }
    }
    let mut events: Vec<ReviewEvent> = Vec::new();
    for path in files_in(&data_dir.join("favorites/review_log")) {
        if path.extension().map(|e| e != "jsonl").unwrap_or(true) {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        for line in content.lines().map(str::trim).filter(|l| !l.is_empty()) {
            match serde_json::from_str::<ReviewEvent>(line) {
                Ok(e) => events.push(e),
                Err(_) => report.skipped += 1,
            }
        }
    }
    let mut bookmarks: Vec<(Bookmark, String)> = Vec::new();
    for path in files_in(&data_dir.join("bookmarks")) {
        match fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Bookmark>(&s).ok())
        {
            Some(b) => {
                let updated = mtime_iso(&path).unwrap_or_else(|| b.created_at.clone());
                bookmarks.push((b, updated));
            }
            None => report.skipped += 1,
        }
    }
    let mut articles: Vec<Article> = Vec::new();
    for path in files_in(&data_dir.join("articles")) {
        if let Some(a) = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Article>(&s).ok())
        {
            articles.push(a);
        }
    }

    db.write(|tx| {
        // Articles first so bookmarks can resolve their book article.
        for a in &articles {
            repo::mirror_article(tx, a, Track::Legacy)?;
            report.articles += 1;
        }
        for p in &packs {
            repo::save_pack(tx, p, Track::Legacy)?;
            report.packs += 1;
        }
        for (f, updated) in &cards {
            repo::save_vocabulary(
                tx,
                VocabularyWrite {
                    fav: f,
                    updated_at: Some(updated),
                    memberships: true,
                    track: Track::Legacy,
                },
            )?;
            report.vocabulary += 1;
        }
        for e in &events {
            if repo::insert_review_event(tx, e, None, Track::Legacy)? {
                report.review_events += 1;
            }
        }
        for (b, updated) in &bookmarks {
            repo::save_bookmark(tx, b, Some(updated), Track::Legacy)?;
            report.bookmarks += 1;
        }
        // Replay seeds for cards converted from SM-2 before this import (sync spec §6):
        // S/D from the frozen SM-2 fields, and the review count / last review day as of the
        // first FSRS event.
        for (f, _) in &cards {
            if f.scheduler_version.is_none() || f.srs_state == "new" {
                continue;
            }
            let mut own: Vec<&ReviewEvent> = events
                .iter()
                .filter(|e| e.card_id.eq_ignore_ascii_case(&f.id))
                .collect();
            let fsrs_events = own.len() as i32;
            if f.review_count <= fsrs_events {
                continue; // no SM-2 history: replay starts from a new card
            }
            own.sort_by(|a, b| a.reviewed_at.cmp(&b.reviewed_at));
            let (stability, difficulty) =
                crate::fsrs::seed_from_sm2(f.interval_days, f.ease_factor);
            let last_date_local = own.first().and_then(|e| {
                chrono::NaiveDate::parse_from_str(&e.date_local, "%Y-%m-%d")
                    .ok()
                    .map(|d| {
                        (d - chrono::Duration::days(e.elapsed_days.max(0)))
                            .format("%Y-%m-%d")
                            .to_string()
                    })
            });
            let seed = serde_json::json!({
                "stability": stability,
                "difficulty": difficulty,
                "srsState": "review",
                "reviewCount": f.review_count - fsrs_events,
                "lastReviewedAt": if own.is_empty() { f.last_reviewed_at.clone() } else { None },
                "lastDateLocal": last_date_local,
                "dueDate": if own.is_empty() { Some(f.due_date.clone()) } else { None },
            });
            repo::set_vocabulary_replay_seed(tx, &f.id, Some(&seed.to_string()))?;
        }
        set_meta(
            tx,
            META_LEGACY_IMPORTED,
            Some(&chrono::Utc::now().to_rfc3339()),
        )?;
        Ok(())
    })?;
    Ok(report)
}

fn move_to_backup(data_dir: &Path) -> Result<(), String> {
    for rel in MOVED_DIRS {
        let src = data_dir.join(rel);
        if !src.exists() {
            continue;
        }
        let mut dest = data_dir.join(BACKUP_DIR).join(rel);
        if dest.exists() {
            // A previous partial run: keep both copies.
            let stamp = chrono::Utc::now().format("%Y%m%d%H%M%S").to_string();
            dest = data_dir
                .join(BACKUP_DIR)
                .join(format!("{rel}-{stamp}-{}", uuid::Uuid::new_v4().simple()));
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create backup dir: {e}"))?;
        }
        if fs::rename(&src, &dest).is_err() {
            copy_dir(&src, &dest)?;
            fs::remove_dir_all(&src).map_err(|e| format!("Failed to remove legacy dir: {e}"))?;
        }
    }
    Ok(())
}

fn copy_dir(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("Failed to create {}: {e}", dest.display()))?;
    for entry in fs::read_dir(src).map_err(|e| format!("Failed to read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let target = dest.join(entry.file_name());
        if path.is_dir() {
            copy_dir(&path, &target)?;
        } else {
            fs::copy(&path, &target)
                .map_err(|e| format!("Failed to copy {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, repo};
    use crate::sync::store;

    const V1: &str = "3f0c2a4e-1d2b-4c5d-9e8f-0a1b2c3d4e5f";
    const V2: &str = "4f0c2a4e-1d2b-4c5d-9e8f-0a1b2c3d4e5f";
    const P1: &str = "5a5b5c5d-0000-4000-8000-00000000abcd";
    const A1: &str = "0b8e2c1a-5d4f-4e3a-9b2c-1d0e9f8a7b6c";

    fn write(dir: &Path, rel: &str, content: &str) {
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn seed_legacy(dir: &Path) {
        write(
            dir,
            &format!("favorites/packs/{P1}"),
            &format!(
                r#"{{"id":"{P1}","name":"N3","tags":["jlpt"],"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-02T00:00:00Z"}}"#
            ),
        );
        write(
            dir,
            "favorites/packs/system-ungrouped",
            r#"{"id":"system-ungrouped","name":"未分组","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","is_system":true}"#,
        );
        write(
            dir,
            &format!("favorites/vocabulary/{V1}"),
            &format!(
                r#"{{"id":"{V1}","word":"猫","meaning":"cat","usage":"n.","example":null,"reading":"ねこ","source_article_id":null,"source_article_title":null,"pack_ids":["{P1}","system-ungrouped"],"srs_state":"review","scheduler_version":"fsrs6","stability":3.0,"difficulty":5.0,"review_count":4,"interval_days":6,"ease_factor":2.5,"due_date":"2026-09-10","created_at":"2026-01-01T00:00:00Z"}}"#
            ),
        );
        // A pre-pack_ids legacy card (old schema, non-UUID id).
        write(
            dir,
            "favorites/vocabulary/old-1",
            r#"{"id":"old-1","word":"apple","meaning":"苹果","usage":"n.","example":null,"reading":null,"source_article_id":null,"source_article_title":null,"created_at":"2026-02-16T00:00:00Z"}"#,
        );
        write(
            dir,
            &format!("favorites/vocabulary/{V2}"),
            &format!(
                r#"{{"id":"{V2}","word":"犬","meaning":"dog","usage":"","example":null,"reading":null,"source_article_id":null,"source_article_title":null,"created_at":"2026-02-16T00:00:00Z"}}"#
            ),
        );
        write(dir, "favorites/vocabulary/broken", "{not json");
        write(
            dir,
            "favorites/review_log/2026-09.jsonl",
            &format!(
                "{}\n{{half\n",
                serde_json::json!({
                    "id": "e1000000-0000-4000-8000-000000000001", "card_id": V1,
                    "reviewed_at": "2026-09-04T10:00:00Z", "date_local": "2026-09-04", "grade": 3,
                    "elapsed_days": 3, "previous_state": "review", "scheduler_version": "fsrs6",
                    "desired_retention": 0.9, "result_stability": 3.0, "result_difficulty": 5.0,
                    "result_interval_days": 6, "result_state": "review"
                })
            ),
        );
        write(
            dir,
            "bookmarks/b1",
            r#"{"id":"6a6b6c6d-0000-4000-8000-00000000abcd","book_path":"/books/a.epub","book_type":"epub","title":"Ch 1","page_number":3,"created_at":"2026-03-01T00:00:00Z"}"#,
        );
        write(
            dir,
            &format!("articles/{A1}"),
            &serde_json::json!({
                "id": A1, "title": "T", "content": "a. b.", "source_type": "article",
                "source_url": null, "media_path": null, "created_at": "2026-03-01T00:00:00Z",
                "translated": false,
                "segments": [{"id": "11111111-0000-4000-8000-000000000001", "article_id": A1, "order": 0,
                  "text": "a.", "reading_text": null, "translation": "A", "explanation": null,
                  "created_at": "2026-03-01T00:00:00Z", "is_new_paragraph": true}]
            })
            .to_string(),
        );
        write(dir, "favorites/grammar/g1", r#"{"id":"g1"}"#);
    }

    #[test]
    fn imports_legacy_json_once_and_backs_it_up() {
        let dir = db::test_util::temp_dir("legacy");
        seed_legacy(&dir);
        let database = db::open(&dir).unwrap();

        database
            .read(|c| {
                let cards = repo::list_vocabularies(c)?;
                assert_eq!(cards.len(), 3);
                let cat = repo::load_vocabulary(c, V1)?.unwrap();
                assert_eq!(
                    cat.pack_ids,
                    vec![P1.to_string(), "system-ungrouped".to_string()]
                );
                assert_eq!(cat.reading.as_deref(), Some("ねこ"));
                assert_eq!(
                    repo::load_vocabulary(c, "old-1")?.unwrap().pack_ids,
                    vec!["system-ungrouped".to_string()]
                );
                assert_eq!(repo::list_packs(c)?.len(), 2);
                assert_eq!(repo::list_review_events(c)?.len(), 1);
                assert_eq!(repo::list_bookmarks(c)?.len(), 1);
                assert_eq!(
                    repo::load_article(c, A1)?.unwrap().segments[0]
                        .translation
                        .as_deref(),
                    Some("A")
                );

                // Records are dirty with legacy HLCs; non-UUID / system records are local-only.
                let rec = store::get_record(c, "Vocabulary", V1)?.unwrap();
                assert!(rec.dirty && rec.rev == 0);
                assert!(rec.hlc.ends_with("-0000-00000000"));
                assert!(store::get_record(c, "Vocabulary", "old-1")?.is_none());
                assert!(store::get_record(c, "WordPack", P1)?.is_some());
                assert!(store::get_record(c, "WordPack", "system-ungrouped")?.is_none());
                assert!(
                    store::get_record(c, "WordPackMembership", &format!("{V1}_{P1}"))?.is_some()
                );
                assert!(store::get_record(
                    c,
                    "ReviewEvent",
                    "e1000000-0000-4000-8000-000000000001"
                )?
                .is_some());
                assert!(store::get_record(c, "Article", A1)?.is_some());
                assert!(
                    store::get_record(c, "Segment", "11111111-0000-4000-8000-000000000001")?
                        .is_some()
                );
                assert!(
                    store::get_record(c, "BookMark", "6a6b6c6d-0000-4000-8000-00000000abcd")?
                        .is_some()
                );
                // SM-2 history before the first FSRS event → replay seed.
                let seed = repo::vocabulary_replay_seed(c, V1)?.unwrap();
                let seed: serde_json::Value = serde_json::from_str(&seed).unwrap();
                assert_eq!(seed["reviewCount"], 3);
                assert_eq!(seed["lastDateLocal"], "2026-09-01");
                Ok(())
            })
            .unwrap();

        for rel in MOVED_DIRS {
            assert!(!dir.join(rel).exists(), "{rel} should be moved");
            assert!(
                dir.join(BACKUP_DIR).join(rel).exists(),
                "{rel} backup missing"
            );
        }
        assert!(dir.join("favorites/grammar/g1").exists());
        assert!(dir.join(format!("articles/{A1}")).exists());

        // Idempotent: a second open (fresh handle) does not re-import or duplicate.
        db::close(&dir);
        let again = db::open(&dir).unwrap();
        assert_eq!(again.read(|c| repo::list_vocabularies(c)).unwrap().len(), 3);
        assert!(import_legacy_json_if_needed(&again).unwrap().is_none());

        // A crash after the commit but before the move: the move is finished on next open.
        write(&dir, "bookmarks/late", "{}");
        db::close(&dir);
        let third = db::open(&dir).unwrap();
        assert!(!dir.join("bookmarks").exists());
        assert_eq!(third.read(|c| repo::list_bookmarks(c)).unwrap().len(), 1);
        db::close(&dir);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn empty_data_dir_is_fine() {
        let dir = db::test_util::temp_dir("legacy-empty");
        let database = db::open(&dir).unwrap();
        assert!(database
            .read(|c| repo::list_vocabularies(c))
            .unwrap()
            .is_empty());
        assert!(!dir.join(BACKUP_DIR).exists());
        db::close(&dir);
        let _ = fs::remove_dir_all(dir);
    }
}
