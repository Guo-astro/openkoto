//! Engine tests against an in-memory server that follows spec §5.2 push rules.

use super::*;
use crate::db::{self, repo};
use crate::sync::hlc::format_hlc;
use crate::sync::hlc::HlcTimestamp;
use crate::types::{Article, ArticleSegment, FavoriteVocabulary};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
struct ServerState {
    records: HashMap<(String, String), SyncRecord>,
    seq: i64,
    pushes: Vec<PushRequest>,
    expire_cursor_once: bool,
}

#[derive(Default)]
struct MockServer {
    state: Mutex<ServerState>,
}

fn decode_cursor(c: &Option<String>) -> i64 {
    c.as_deref()
        .and_then(|c| c.strip_prefix("c_"))
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

impl MockServer {
    fn insert_remote(
        &self,
        record_type: &str,
        id: &str,
        hlc: &str,
        payload: Option<serde_json::Value>,
    ) -> i64 {
        let mut s = self.state.lock().unwrap();
        s.seq += 1;
        let rev = s.seq;
        s.records.insert(
            (record_type.to_string(), id.to_lowercase()),
            SyncRecord {
                record_type: record_type.to_string(),
                id: id.to_lowercase(),
                rev,
                hlc: hlc.to_string(),
                device_id: Some("d-remote".into()),
                deleted: payload.is_none(),
                payload: payload.map(|p| p.as_object().unwrap().clone()),
                blob_url: None,
            },
        );
        rev
    }

    fn get(&self, record_type: &str, id: &str) -> Option<SyncRecord> {
        self.state
            .lock()
            .unwrap()
            .records
            .get(&(record_type.to_string(), id.to_string()))
            .cloned()
    }
}

impl Transport for MockServer {
    fn pull(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> impl Future<Output = Result<PullResponse, TransportError>> + Send {
        async move {
            let mut s = self.state.lock().unwrap();
            if cursor.is_some() && s.expire_cursor_once {
                s.expire_cursor_once = false;
                return Err(TransportError::new(Some(410), "CURSOR_EXPIRED", "expired"));
            }
            let after = decode_cursor(&cursor);
            let mut records: Vec<SyncRecord> = s
                .records
                .values()
                .filter(|r| r.rev > after)
                .cloned()
                .collect();
            records.sort_by_key(|r| r.rev);
            let has_more = records.len() > limit as usize;
            records.truncate(limit as usize);
            let cursor = if has_more {
                records.last().unwrap().rev
            } else {
                s.seq.max(after)
            };
            Ok(PullResponse {
                records,
                cursor: format!("c_{cursor}"),
                has_more,
            })
        }
    }

    fn push(
        &self,
        request: PushRequest,
    ) -> impl Future<Output = Result<PushResponse, TransportError>> + Send {
        async move {
            let mut s = self.state.lock().unwrap();
            s.pushes.push(request.clone());
            let mut results = Vec::new();
            for op in request.ops {
                let k = (op.record_type.clone(), op.id.to_lowercase());
                let existing = s.records.get(&k).cloned();
                if op.record_type == "ReviewEvent" {
                    if let Some(e) = &existing {
                        results.push(PushResult::Applied {
                            op_id: op.op_id,
                            rev: e.rev,
                        });
                        continue;
                    }
                }
                let wins = match &existing {
                    None => true,
                    Some(e) => e.rev == op.base_rev || op.hlc > e.hlc,
                };
                if !wins {
                    let e = existing.unwrap();
                    results.push(PushResult::Conflict {
                        op_id: op.op_id,
                        rev: e.rev,
                        current: e,
                    });
                    continue;
                }
                s.seq += 1;
                let rev = s.seq;
                s.records.insert(
                    k,
                    SyncRecord {
                        record_type: op.record_type.clone(),
                        id: op.id.to_lowercase(),
                        rev,
                        hlc: op.hlc.clone(),
                        device_id: Some(request.device_id.clone()),
                        deleted: op.deleted,
                        payload: if op.deleted { None } else { op.payload.clone() },
                        blob_url: None,
                    },
                );
                results.push(PushResult::Applied {
                    op_id: op.op_id,
                    rev,
                });
            }
            let cursor = format!("c_{}", s.seq);
            Ok(PushResponse {
                results,
                cursor: Some(cursor),
            })
        }
    }

    fn fetch_blob(
        &self,
        _url: String,
    ) -> impl Future<Output = Result<Vec<u8>, TransportError>> + Send {
        async { Err(TransportError::new(Some(404), "NOT_FOUND", "no blobs")) }
    }

    fn upload_blob(
        &self,
        _record_type: String,
        _id: String,
        _gzip: Vec<u8>,
        _sha256: String,
    ) -> impl Future<Output = Result<String, TransportError>> + Send {
        async { Err(TransportError::new(Some(500), "INTERNAL", "no blobs")) }
    }
}

const V1: &str = "3f0c2a4e-1d2b-4c5d-9e8f-0a1b2c3d4e5f";
const P1: &str = "5a5b5c5d-0000-4000-8000-00000000abcd";

fn hlc(wall: i64, node: &str) -> String {
    format_hlc(&HlcTimestamp {
        wall,
        counter: 0,
        node: node.into(),
    })
}

fn card(id: &str, word: &str) -> FavoriteVocabulary {
    serde_json::from_value(json!({
        "id": id, "word": word, "meaning": "m", "usage": "",
        "example": null, "reading": null, "source_article_id": null, "source_article_title": null,
        "created_at": "2026-09-01T00:00:00Z", "scheduler_version": "fsrs6", "due_date": "2026-09-01"
    }))
    .unwrap()
}

fn setup(name: &str) -> (std::path::PathBuf, Arc<Database>) {
    let dir = db::test_util::temp_dir(name);
    let database = db::open(&dir).unwrap();
    (dir, database)
}

fn teardown(dir: std::path::PathBuf) {
    db::close(&dir);
    let _ = std::fs::remove_dir_all(dir);
}

fn opts() -> EngineOptions {
    EngineOptions {
        replay: ReplayOptions {
            desired_retention: 0.9,
            time_zone: crate::sync::replay::ReplayTimeZone::Utc,
        },
        ..EngineOptions::default()
    }
}

#[tokio::test]
async fn pushes_local_changes_and_acknowledges_the_echo() {
    let (dir, database) = setup("engine-push");
    database
        .write(|tx| {
            let mut c = card(V1, "猫");
            c.pack_ids = vec![P1.into()];
            repo::save_pack(
                tx,
                &serde_json::from_value(json!({"id": P1, "name": "N3", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"})).unwrap(),
                repo::Track::Record,
            )?;
            repo::save_vocabulary(tx, repo::VocabularyWrite { fav: &c, updated_at: None, memberships: true, track: repo::Track::Record })?;
            Ok(())
        })
        .unwrap();

    let server = MockServer::default();
    let engine = HttpSyncEngine::new(database.clone(), &server, opts());
    let report = engine.sync().await.unwrap();
    assert_eq!(report.pushed, 3, "{report:?}");
    assert!(server.get("Vocabulary", V1).is_some());
    assert!(server.get("WordPack", P1).is_some());
    assert!(server
        .get("WordPackMembership", &format!("{V1}_{P1}"))
        .is_some());
    // Ops were sent in merge order.
    let types: Vec<String> = server.state.lock().unwrap().pushes[0]
        .ops
        .iter()
        .map(|o| o.record_type.clone())
        .collect();
    assert_eq!(types, vec!["WordPack", "Vocabulary", "WordPackMembership"]);
    assert_eq!(database.read(|c| store::dirty_count(c)).unwrap(), 0);

    // Next cycle pulls our own writes back: equal HLC → acknowledge, nothing re-pushed.
    let report = engine.sync().await.unwrap();
    assert_eq!(report.pushed, 0);
    assert_eq!(report.pulled, 3);
    assert_eq!(database.read(|c| store::dirty_count(c)).unwrap(), 0);
    teardown(dir);
}

#[tokio::test]
async fn pulls_remote_records_projects_them_and_replays_events() {
    let (dir, database) = setup("engine-pull");
    let server = MockServer::default();
    // iOS uppercases ids and uses its own system-pack UUID.
    server.insert_remote("WordPack", P1, &hlc(1790000000000, "bbbbbbbb"), Some(json!({
        "name": "N3", "tags": ["jlpt"], "isSystem": false, "createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-01T00:00:00Z"
    })));
    server.insert_remote(
        "Vocabulary",
        &V1.to_uppercase(),
        &hlc(1790000000001, "bbbbbbbb"),
        Some(json!({
            "id": V1.to_uppercase(), "word": "懐かしい", "meaning": "nostalgic", "srsState": "new",
            "stability": 0, "difficulty": 0, "dueDate": "2026-09-01", "reviewCount": 0,
            "createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-01T00:00:00Z",
            "sourceSegmentId": "11111111-0000-4000-8000-000000000001"
        })),
    );
    server.insert_remote(
        "WordPackMembership",
        &format!("{V1}_{P1}"),
        &hlc(1790000000002, "bbbbbbbb"),
        Some(json!({
            "vocabularyId": V1, "packId": P1
        })),
    );
    server.insert_remote(
        "WordPackMembership",
        &format!("{V1}_00000000-0000-4000-8000-0000756e6772"),
        &hlc(1790000000002, "bbbbbbbb"),
        Some(json!({
            "vocabularyId": V1, "packId": "00000000-0000-4000-8000-0000756E6772"
        })),
    );
    server.insert_remote("ReviewEvent", "e1000000-0000-4000-8000-000000000001", &hlc(1788256800000, "bbbbbbbb"), Some(json!({
        "vocabularyId": V1, "reviewedAt": "2026-09-01T10:00:00Z", "dateLocal": "2026-09-01", "grade": 3,
        "elapsedDays": 0, "previousState": "new", "schedulerVersion": "fsrs6", "desiredRetention": 0.9,
        "resultStability": 2.3065, "resultDifficulty": 2.11810397, "resultIntervalDays": 3, "resultState": "review"
    })));
    // Undo of an event that is itself voided later: both skipped by replay and stats.
    server.insert_remote("ReviewEvent", "e1000000-0000-4000-8000-000000000002", &hlc(1788516000000, "bbbbbbbb"), Some(json!({
        "vocabularyId": V1, "reviewedAt": "2026-09-04T10:00:00Z", "dateLocal": "2026-09-04", "grade": 1,
        "elapsedDays": 3, "previousState": "review", "schedulerVersion": "fsrs6", "desiredRetention": 0.9,
        "resultStability": 1.0, "resultDifficulty": 5.0, "resultIntervalDays": 1, "resultState": "learning"
    })));
    server.insert_remote("ReviewEvent", "e1000000-0000-4000-8000-000000000003", &hlc(1788516005000, "bbbbbbbb"), Some(json!({
        "vocabularyId": V1, "reviewedAt": "2026-09-04T10:00:05Z", "dateLocal": "2026-09-04", "grade": 0,
        "voidsEventId": "E1000000-0000-4000-8000-000000000002",
        "elapsedDays": 0, "previousState": "learning", "schedulerVersion": "fsrs6", "desiredRetention": 0.9,
        "resultStability": 0, "resultDifficulty": 0, "resultIntervalDays": 0, "resultState": "review"
    })));
    server.insert_remote(
        "Book",
        "99999999-0000-4000-8000-000000000001",
        &hlc(1790000000003, "bbbbbbbb"),
        Some(json!({"title": "kept"})),
    );
    server.insert_remote(
        "FutureType",
        "x",
        &hlc(1790000000003, "bbbbbbbb"),
        Some(json!({})),
    );

    let engine = HttpSyncEngine::new(database.clone(), &server, opts());
    let report = engine.sync().await.unwrap();
    assert_eq!(report.replayed_cards, vec![V1.to_string()]);
    assert!(report.diagnostics.iter().any(|d| d.contains("FutureType")));

    database
        .read(|c| {
            let fav = repo::load_vocabulary(c, V1)?.unwrap();
            assert_eq!(fav.word, "懐かしい");
            assert_eq!(
                fav.pack_ids,
                vec![P1.to_string(), "system-ungrouped".to_string()]
            );
            // Replayed from the single effective event (single-good fixture values).
            assert_eq!(fav.srs_state, "review");
            assert!((fav.stability - 2.3065).abs() < 1e-9);
            assert_eq!(fav.due_date, "2026-09-04");
            assert_eq!(fav.review_count, 1);
            // Stats see only the effective event.
            assert_eq!(repo::list_review_events(c)?.len(), 1);
            // Unknown payload fields survive locally, replay fields were written, nothing dirty.
            let rec = store::get_record(c, "Vocabulary", V1)?.unwrap();
            assert_eq!(
                rec.payload.as_ref().unwrap()["sourceSegmentId"],
                "11111111-0000-4000-8000-000000000001"
            );
            assert_eq!(rec.payload.as_ref().unwrap()["reviewCount"], 1);
            assert!(!rec.dirty);
            assert!(
                store::get_record(c, "Book", "99999999-0000-4000-8000-000000000001")?.is_some()
            );
            assert_eq!(store::dirty_count(c)?, 0);
            Ok(())
        })
        .unwrap();

    // A local edit keeps the unknown field when pushed.
    database
        .write(|tx| {
            let mut fav = repo::load_vocabulary(tx, V1)?.unwrap();
            fav.meaning = "longing".into();
            repo::save_vocabulary(
                tx,
                repo::VocabularyWrite {
                    fav: &fav,
                    updated_at: None,
                    memberships: true,
                    track: repo::Track::Record,
                },
            )?;
            Ok(())
        })
        .unwrap();
    engine.sync().await.unwrap();
    let pushed = server.get("Vocabulary", V1).unwrap();
    let p = pushed.payload.unwrap();
    assert_eq!(p["meaning"], "longing");
    assert_eq!(p["sourceSegmentId"], "11111111-0000-4000-8000-000000000001");
    // The iOS system-pack membership is not re-uploaded as a desktop membership.
    assert!(server
        .get("WordPackMembership", &format!("{V1}_system-ungrouped"))
        .is_none());
    teardown(dir);
}

#[tokio::test]
async fn conflict_is_merged_and_repushed_at_most_twice() {
    let (dir, database) = setup("engine-conflict");
    let server = MockServer::default();
    // Local card pushed once.
    database
        .write(|tx| {
            repo::save_vocabulary(
                tx,
                repo::VocabularyWrite {
                    fav: &card(V1, "a"),
                    updated_at: None,
                    memberships: false,
                    track: repo::Track::Record,
                },
            )?;
            Ok(())
        })
        .unwrap();
    let engine = HttpSyncEngine::new(database.clone(), &server, opts());
    engine.sync().await.unwrap();

    // Another device writes a newer version (far-future HLC within skew); local edits offline.
    let remote_hlc = hlc(
        chrono::Utc::now().timestamp_millis() + 60 * 60 * 1000,
        "bbbbbbbb",
    );
    let mut remote_payload = server.get("Vocabulary", V1).unwrap().payload.unwrap();
    remote_payload.insert("meaning".into(), json!("remote wins"));
    server.insert_remote(
        "Vocabulary",
        V1,
        &remote_hlc,
        Some(serde_json::Value::Object(remote_payload)),
    );
    database
        .write(|tx| {
            let mut fav = repo::load_vocabulary(tx, V1)?.unwrap();
            fav.meaning = "local loses".into();
            repo::save_vocabulary(
                tx,
                repo::VocabularyWrite {
                    fav: &fav,
                    updated_at: None,
                    memberships: false,
                    track: repo::Track::Record,
                },
            )?;
            Ok(())
        })
        .unwrap();
    // Push without pulling first to force a conflict.
    let mut cycle = Cycle {
        report: SyncReport::default(),
        cards: BTreeSet::new(),
        touched: crate::sync::apply::Touched::default(),
    };
    engine.push_all(&mut cycle).await.unwrap();
    assert_eq!(cycle.report.conflicts, 1);
    assert!(cycle.report.repush_rounds <= 2);
    database
        .read(|c| {
            assert_eq!(
                repo::load_vocabulary(c, V1)?.unwrap().meaning,
                "remote wins"
            );
            assert_eq!(store::dirty_count(c)?, 0);
            Ok(())
        })
        .unwrap();
    teardown(dir);
}

#[tokio::test]
async fn cursor_expired_triggers_full_rebuild() {
    let (dir, database) = setup("engine-410");
    let server = MockServer::default();
    database
        .write(|tx| {
            repo::save_vocabulary(
                tx,
                repo::VocabularyWrite {
                    fav: &card(V1, "a"),
                    updated_at: None,
                    memberships: false,
                    track: repo::Track::Record,
                },
            )?;
            Ok(())
        })
        .unwrap();
    let engine = HttpSyncEngine::new(database.clone(), &server, opts());
    engine.sync().await.unwrap();
    // Server lost our record (tombstone floor passed) and expires the cursor.
    {
        let mut s = server.state.lock().unwrap();
        s.records.clear();
        s.expire_cursor_once = true;
    }
    let report = engine.sync().await.unwrap();
    assert!(report.rebuilt);
    assert_eq!(report.pushed, 1);
    assert!(server.get("Vocabulary", V1).is_some());
    teardown(dir);
}

#[tokio::test]
async fn remote_resegmentation_replaces_local_segments_and_rewrites_article_file() {
    let (dir, database) = setup("engine-segments");
    let article_id = "0b8e2c1a-5d4f-4e3a-9b2c-1d0e9f8a7b6c";
    let seg = |id: &str, order: i32| ArticleSegment {
        id: id.into(),
        article_id: article_id.into(),
        order,
        text: format!("s{order}"),
        reading_text: None,
        translation: Some(format!("t{order}")),
        explanation: None,
        start_time: None,
        end_time: None,
        created_at: "2026-09-28T00:00:00Z".into(),
        is_new_paragraph: order == 0,
    };
    let article = Article {
        id: article_id.into(),
        title: "T".into(),
        content: "s0 s1".into(),
        source_type: Some("article".into()),
        source_url: None,
        media_path: None,
        book_path: None,
        book_type: None,
        created_at: "2026-09-28T00:00:00Z".into(),
        translated: true,
        active_mind_map_artifact_id: Some("artifact-1".into()),
        segments: vec![
            seg("11111111-0000-4000-8000-000000000001", 0),
            seg("11111111-0000-4000-8000-000000000002", 1),
        ],
    };
    crate::storage::save_article_in_dir(
        &dir,
        article_id,
        &serde_json::to_string(&article).unwrap(),
    )
    .unwrap();
    let server = MockServer::default();
    let engine = HttpSyncEngine::new(database.clone(), &server, opts());
    engine.sync().await.unwrap();

    // Another device re-segments (revision 1) into one segment.
    server.insert_remote("Segment", "22222222-0000-4000-8000-000000000001", &hlc(1790000000000, "bbbbbbbb"), Some(json!({
        "id": "22222222-0000-4000-8000-000000000001", "articleId": article_id, "order": 0, "text": "s0 s1",
        "isNewParagraph": true, "createdAt": "2026-09-28T00:00:00Z", "segmentationRevision": 1,
        "explanation": {"translation": "T", "explanation": "E", "vocabulary": [], "grammarPoints": [{"point": "p", "explanation": "x"}]}
    })));
    engine.sync().await.unwrap();

    let file: Article = serde_json::from_str(
        &std::fs::read_to_string(dir.join("articles").join(article_id)).unwrap(),
    )
    .unwrap();
    assert_eq!(file.segments.len(), 1);
    assert_eq!(file.segments[0].text, "s0 s1");
    assert_eq!(
        file.segments[0]
            .explanation
            .as_ref()
            .unwrap()
            .grammar_points[0]
            .point,
        "p"
    );
    // Desktop-only fields of the file survive.
    assert_eq!(
        file.active_mind_map_artifact_id.as_deref(),
        Some("artifact-1")
    );
    assert!(file.translated);
    database
        .read(|c| {
            let old =
                store::get_record(c, "Segment", "11111111-0000-4000-8000-000000000001")?.unwrap();
            assert!(old.deleted && !old.dirty);
            Ok(())
        })
        .unwrap();

    // Remote article delete removes the file.
    server.insert_remote(
        "Article",
        article_id,
        &hlc(chrono::Utc::now().timestamp_millis() + 1000, "bbbbbbbb"),
        None,
    );
    engine.sync().await.unwrap();
    assert!(!dir.join("articles").join(article_id).exists());
    teardown(dir);
}

#[test]
fn chunking_respects_op_limit() {
    let ops: Vec<PushOp> = (0..1201)
        .map(|i| PushOp {
            op_id: i.to_string(),
            record_type: "Vocabulary".into(),
            id: i.to_string(),
            base_rev: 0,
            hlc: hlc(1, "aaaaaaaa"),
            deleted: true,
            payload: None,
            blob_key: None,
        })
        .collect();
    let chunks = chunk_ops(ops, 500);
    assert_eq!(
        chunks.iter().map(Vec::len).collect::<Vec<_>>(),
        vec![500, 500, 201]
    );
    assert_eq!(gunzip(&gzip(b"hello").unwrap()).unwrap(), b"hello");
}

#[tokio::test]
async fn remote_books_become_readable_and_bookmarks_push_once_the_book_exists() {
    let (dir, database) = setup("engine-books");
    let server = MockServer::default();
    let book = "0b8e2c1a-5d4f-4e3a-9b2c-1d0e9f8a7b99";
    let ch1 = "c1000000-0000-4000-8000-000000000001";
    let ch2 = "c1000000-0000-4000-8000-000000000002";
    server.insert_remote(
        "Book",
        book,
        &hlc(1790000000000, "bbbbbbbb"),
        Some(json!({
            "id": book, "title": "Remote Novel", "format": "epub", "totalChars": 6,
            "defaultMode": "native", "originalOnly": false, "createdAt": "2026-09-28T00:00:00Z"
        })),
    );
    for (i, (id, text)) in [(ch1, "第一章正文"), (ch2, "第二章正文")]
        .iter()
        .enumerate()
    {
        server.insert_remote("Article", id, &hlc(1790000000001, "bbbbbbbb"), Some(json!({
            "id": id, "title": format!("Ch{}", i + 1), "content": text, "sourceType": "book", "createdAt": "2026-09-28T00:00:00Z"
        })));
        server.insert_remote("BookChapter", id, &hlc(1790000000002, "bbbbbbbb"), Some(json!({
            "articleId": id, "bookId": book, "index": i, "title": format!("Ch{}", i + 1), "isSegmented": false, "charCount": 5
        })));
    }
    server.insert_remote(
        "BookProgress",
        book,
        &hlc(1790000000003, "bbbbbbbb"),
        Some(json!({
            "bookId": book, "chapterIndex": 1, "mode": "native", "updatedAt": "2026-09-28T01:00:00Z"
        })),
    );
    // A lyrics article from iOS with its LyricsMeta.
    let song = "5c000000-0000-4000-8000-000000000001";
    server.insert_remote("Article", song, &hlc(1790000000004, "bbbbbbbb"), Some(json!({
        "id": song, "title": "Song", "content": "la la", "sourceType": "lyrics", "createdAt": "2026-09-28T00:00:00Z"
    })));
    server.insert_remote("Segment", "5c000000-0000-4000-8000-0000000000a1", &hlc(1790000000005, "bbbbbbbb"), Some(json!({
        "id": "5c000000-0000-4000-8000-0000000000a1", "articleId": song, "order": 0, "text": "la la",
        "isNewParagraph": true, "startTime": 1.5, "endTime": 3.0, "createdAt": "2026-09-28T00:00:00Z"
    })));
    server.insert_remote(
        "LyricsMeta",
        song,
        &hlc(1790000000006, "bbbbbbbb"),
        Some(json!({
            "articleId": song, "artist": "Singer", "lrcOffsetMs": 200, "sourceFormat": "lrc"
        })),
    );

    let engine = HttpSyncEngine::new(database.clone(), &server, opts());
    engine.sync().await.unwrap();

    // The book shows up as a desktop book article, readable from its chapters.
    let article: Article =
        serde_json::from_str(&std::fs::read_to_string(dir.join("articles").join(book)).unwrap())
            .unwrap();
    assert_eq!(article.source_type.as_deref(), Some("book"));
    assert_eq!(article.book_type.as_deref(), Some("txt"));
    assert!(article.content.contains("第二章正文"));
    assert!(std::path::Path::new(article.book_path.as_deref().unwrap()).exists());
    // Chapters do not appear as separate articles.
    assert!(!dir.join("articles").join(ch1).exists());
    let lyrics: Article =
        serde_json::from_str(&std::fs::read_to_string(dir.join("articles").join(song)).unwrap())
            .unwrap();
    assert_eq!(lyrics.source_type.as_deref(), Some("lyrics"));
    assert_eq!(lyrics.segments[0].start_time, Some(1.5));
    database
        .read(|c| {
            assert_eq!(
                crate::db::books::load_progress(c, book)?
                    .unwrap()
                    .chapter_index,
                1
            );
            assert_eq!(
                crate::db::books::load_lyrics_meta(c, song)?
                    .unwrap()
                    .artist
                    .as_deref(),
                Some("Singer")
            );
            Ok(())
        })
        .unwrap();

    // A bookmark on that book is now pushable (its Book record exists).
    let bookmark = crate::types::Bookmark {
        id: "b0000000-0000-4000-8000-000000000001".into(),
        book_path: article.book_path.clone().unwrap(),
        book_type: "txt".into(),
        title: "mark".into(),
        note: None,
        selected_text: None,
        page_number: Some(2),
        epub_cfi: None,
        created_at: "2026-09-28T02:00:00Z".into(),
        color: None,
    };
    database
        .write(|tx| repo::save_bookmark(tx, &bookmark, None, repo::Track::Record).map(|_| ()))
        .unwrap();
    engine.sync().await.unwrap();
    let pushed = server
        .get("BookMark", &bookmark.id)
        .expect("bookmark pushed");
    assert_eq!(pushed.payload.unwrap()["bookId"], book);

    // Remote delete removes the desktop book.
    server.insert_remote(
        "Book",
        book,
        &hlc(chrono::Utc::now().timestamp_millis() + 1000, "bbbbbbbb"),
        None,
    );
    engine.sync().await.unwrap();
    assert!(!dir.join("articles").join(book).exists());
    teardown(dir);
}
