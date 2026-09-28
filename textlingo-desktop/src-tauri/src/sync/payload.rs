//! Desktop types ↔ sync payloads (iOS `OKModels` Codable JSON: camelCase keys, ISO-8601 UTC
//! dates, lowercase UUIDs; see packages/core/src/models.ts).
//!
//! Builders return objects where `Value::Null` means "absent" — [`super::store::record_local_change`]
//! overlays them onto the previous payload (keeping unknown fields) and drops the nulls.

use super::protocol::JsonObject;
use crate::types::{
    Article, ArticleSegment, Bookmark, FavoriteVocabulary, GrammarPoint, ReviewEvent,
    SegmentExplanation, VocabularyItem, WordPack,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};

/// Desktop system pack ("未分组"); never synced.
pub const DESKTOP_SYSTEM_PACK_ID: &str = "system-ungrouped";
/// iOS `WordPack.systemUngroupedID`, same meaning.
pub const IOS_SYSTEM_PACK_ID: &str = "00000000-0000-4000-8000-0000756e6772";

pub fn is_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

/// Map a pack id from the wire to the desktop id (the iOS system pack → desktop system pack).
pub fn desktop_pack_id(wire: &str) -> String {
    let lower = wire.to_lowercase();
    if lower == IOS_SYSTEM_PACK_ID {
        DESKTOP_SYSTEM_PACK_ID.to_string()
    } else {
        lower
    }
}

pub fn is_syncable_pack_id(id: &str) -> bool {
    id != DESKTOP_SYSTEM_PACK_ID && is_uuid(id) && id.to_lowercase() != IOS_SYSTEM_PACK_ID
}

/// ISO-8601 UTC with millisecond precision (`toISOString()` shape). Unparsable → None.
pub fn iso(raw: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(raw).ok().map(|d| {
        d.with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    })
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn opt_str(v: &Option<String>) -> Value {
    match v {
        Some(s) => Value::String(s.clone()),
        None => Value::Null,
    }
}

fn non_empty(s: &str) -> Value {
    if s.trim().is_empty() {
        Value::Null
    } else {
        Value::String(s.to_string())
    }
}

fn opt_f64(v: Option<f64>) -> Value {
    v.and_then(serde_json::Number::from_f64)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn obj(v: Value) -> JsonObject {
    match v {
        Value::Object(m) => m,
        _ => JsonObject::new(),
    }
}

fn get_str(p: &JsonObject, key: &str) -> Option<String> {
    p.get(key).and_then(Value::as_str).map(str::to_string)
}

fn get_f64(p: &JsonObject, key: &str) -> Option<f64> {
    p.get(key).and_then(Value::as_f64)
}

fn get_i64(p: &JsonObject, key: &str) -> Option<i64> {
    p.get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
}

fn get_bool(p: &JsonObject, key: &str) -> Option<bool> {
    p.get(key).and_then(Value::as_bool)
}

// MARK: - Vocabulary

pub fn map_srs_state(raw: &str) -> &'static str {
    match raw {
        "learning" => "learning",
        "review" => "review",
        _ => "new",
    }
}

/// `pack_ids` are *not* part of the synced state (memberships are separate records); the
/// payload still carries `packIds` as a convenience for iOS, like `TransferVocabulary`.
pub fn vocabulary_payload(fav: &FavoriteVocabulary, updated_at: &str) -> Option<JsonObject> {
    if !is_uuid(&fav.id) {
        return None;
    }
    let created_at =
        iso(&fav.created_at).unwrap_or_else(|| iso(updated_at).unwrap_or_else(now_iso));
    let pack_ids: Vec<String> = fav
        .pack_ids
        .iter()
        .filter(|id| is_syncable_pack_id(id))
        .map(|id| id.to_lowercase())
        .collect();
    Some(obj(json!({
        "id": fav.id.to_lowercase(),
        "word": fav.word,
        "meaning": fav.meaning,
        "usage": non_empty(&fav.usage),
        "explanation": opt_str(&fav.explanation),
        "example": opt_str(&fav.example),
        "reading": opt_str(&fav.reading),
        "sourceArticleId": fav.source_article_id.as_deref().filter(|id| is_uuid(id)).map(str::to_lowercase),
        "sourceArticleTitle": opt_str(&fav.source_article_title),
        "packIds": pack_ids,
        "srsState": map_srs_state(&fav.srs_state),
        "stability": fav.stability,
        "difficulty": fav.difficulty,
        "schedulerVersion": opt_str(&fav.scheduler_version),
        "suspendedAt": fav.suspended_at.as_deref().and_then(iso),
        "dueDate": fav.due_date,
        "lastReviewedAt": fav.last_reviewed_at.as_deref().and_then(iso),
        "reviewCount": fav.review_count,
        "createdAt": created_at,
        "updatedAt": iso(updated_at).unwrap_or_else(now_iso),
    })))
}

/// Remote payload → desktop card. Desktop-only fields (frozen SM-2 state, pack ids) are kept
/// from `existing`.
pub fn vocabulary_from_payload(
    id: &str,
    p: &JsonObject,
    existing: Option<&FavoriteVocabulary>,
) -> FavoriteVocabulary {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    FavoriteVocabulary {
        id: id.to_lowercase(),
        word: get_str(p, "word").unwrap_or_default(),
        meaning: get_str(p, "meaning").unwrap_or_default(),
        usage: get_str(p, "usage").unwrap_or_default(),
        explanation: get_str(p, "explanation"),
        example: get_str(p, "example"),
        reading: get_str(p, "reading"),
        source_article_id: get_str(p, "sourceArticleId").map(|s| s.to_lowercase()),
        source_article_title: get_str(p, "sourceArticleTitle"),
        pack_ids: existing.map(|e| e.pack_ids.clone()).unwrap_or_default(),
        srs_state: map_srs_state(&get_str(p, "srsState").unwrap_or_default()).to_string(),
        ease_factor: existing.map(|e| e.ease_factor).unwrap_or(2.5),
        repetitions: existing.map(|e| e.repetitions).unwrap_or(0),
        interval_days: existing.map(|e| e.interval_days).unwrap_or(0),
        stability: get_f64(p, "stability").unwrap_or(0.0),
        difficulty: get_f64(p, "difficulty").unwrap_or(0.0),
        scheduler_version: get_str(p, "schedulerVersion")
            .or_else(|| Some(crate::fsrs::SCHEDULER_VERSION.to_string())),
        suspended_at: get_str(p, "suspendedAt"),
        due_date: get_str(p, "dueDate")
            .filter(|d| !d.is_empty())
            .unwrap_or(today),
        last_reviewed_at: get_str(p, "lastReviewedAt"),
        review_count: get_i64(p, "reviewCount").unwrap_or(0) as i32,
        created_at: get_str(p, "createdAt").unwrap_or_else(now_iso),
    }
}

// MARK: - WordPack

pub fn pack_payload(pack: &WordPack) -> Option<JsonObject> {
    if !is_syncable_pack_id(&pack.id) || pack.is_system {
        return None;
    }
    let created_at = iso(&pack.created_at).unwrap_or_else(now_iso);
    Some(obj(json!({
        "id": pack.id.to_lowercase(),
        "name": pack.name,
        "packDescription": opt_str(&pack.description),
        "coverURL": opt_str(&pack.cover_url),
        "author": opt_str(&pack.author),
        "languageFrom": opt_str(&pack.language_from),
        "languageTo": opt_str(&pack.language_to),
        "tags": pack.tags,
        "version": opt_str(&pack.version),
        "isSystem": false,
        "createdAt": created_at,
        "updatedAt": iso(&pack.updated_at).unwrap_or_else(|| created_at.clone()),
    })))
}

pub fn pack_from_payload(id: &str, p: &JsonObject) -> WordPack {
    WordPack {
        id: desktop_pack_id(id),
        name: get_str(p, "name").unwrap_or_default(),
        description: get_str(p, "packDescription").or_else(|| get_str(p, "description")),
        cover_url: get_str(p, "coverURL").or_else(|| get_str(p, "coverUrl")),
        author: get_str(p, "author"),
        language_from: get_str(p, "languageFrom"),
        language_to: get_str(p, "languageTo"),
        tags: p
            .get("tags")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        version: get_str(p, "version"),
        created_at: get_str(p, "createdAt").unwrap_or_else(now_iso),
        updated_at: get_str(p, "updatedAt").unwrap_or_else(now_iso),
        is_system: get_bool(p, "isSystem").unwrap_or(false),
    }
}

// MARK: - WordPackMembership

pub fn membership_id(vocabulary_id: &str, pack_id: &str) -> String {
    format!(
        "{}_{}",
        vocabulary_id.to_lowercase(),
        pack_id.to_lowercase()
    )
}

pub fn parse_membership_id(id: &str) -> Option<(String, String)> {
    let i = id.find('_')?;
    if i == 0 || i == id.len() - 1 {
        return None;
    }
    Some((id[..i].to_lowercase(), id[i + 1..].to_lowercase()))
}

pub fn membership_payload(
    vocabulary_id: &str,
    pack_id: &str,
    created_at: &str,
) -> Option<JsonObject> {
    if !is_uuid(vocabulary_id) || !is_syncable_pack_id(pack_id) {
        return None;
    }
    Some(obj(json!({
        "vocabularyId": vocabulary_id.to_lowercase(),
        "packId": pack_id.to_lowercase(),
        "createdAt": iso(created_at).unwrap_or_else(now_iso),
    })))
}

// MARK: - ReviewEvent

pub fn review_event_payload(
    event: &ReviewEvent,
    voids_event_id: Option<&str>,
) -> Option<JsonObject> {
    if !is_uuid(&event.id) || !is_uuid(&event.card_id) {
        return None;
    }
    let mut p = obj(json!({
        "id": event.id.to_lowercase(),
        "vocabularyId": event.card_id.to_lowercase(),
        "reviewedAt": iso(&event.reviewed_at)?,
        "dateLocal": event.date_local,
        "grade": event.grade,
        "elapsedDays": event.elapsed_days,
        "previousState": map_srs_state(&event.previous_state),
        "schedulerVersion": event.scheduler_version,
        "desiredRetention": event.desired_retention,
        "resultStability": event.result_stability,
        "resultDifficulty": event.result_difficulty,
        "resultIntervalDays": event.result_interval_days,
        "resultState": map_srs_state(&event.result_state),
    }));
    if let Some(v) = voids_event_id {
        p.insert("voidsEventId".into(), Value::String(v.to_lowercase()));
    }
    Some(p)
}

/// Remote payload → desktop event + optional `voidsEventId`.
pub fn review_event_from_payload(
    id: &str,
    p: &JsonObject,
) -> Option<(ReviewEvent, Option<String>)> {
    let vocabulary_id = get_str(p, "vocabularyId")?.to_lowercase();
    let reviewed_at = get_str(p, "reviewedAt")?;
    let date_local = get_str(p, "dateLocal").unwrap_or_else(|| {
        DateTime::parse_from_rfc3339(&reviewed_at)
            .map(|d| {
                d.with_timezone(&chrono::Local)
                    .format("%Y-%m-%d")
                    .to_string()
            })
            .unwrap_or_default()
    });
    let grade = get_i64(p, "grade").unwrap_or(0).clamp(0, 255) as u8;
    Some((
        ReviewEvent {
            id: id.to_lowercase(),
            card_id: vocabulary_id,
            reviewed_at,
            date_local,
            grade,
            elapsed_days: get_i64(p, "elapsedDays").unwrap_or(0),
            previous_state: get_str(p, "previousState").unwrap_or_else(|| "review".into()),
            scheduler_version: get_str(p, "schedulerVersion")
                .unwrap_or_else(|| crate::fsrs::SCHEDULER_VERSION.to_string()),
            desired_retention: get_f64(p, "desiredRetention")
                .unwrap_or(crate::fsrs::DEFAULT_DESIRED_RETENTION),
            result_stability: get_f64(p, "resultStability").unwrap_or(0.0),
            result_difficulty: get_f64(p, "resultDifficulty").unwrap_or(0.0),
            result_interval_days: get_i64(p, "resultIntervalDays").unwrap_or(0) as i32,
            result_state: get_str(p, "resultState").unwrap_or_else(|| "review".into()),
        },
        get_str(p, "voidsEventId").map(|s| s.to_lowercase()),
    ))
}

// MARK: - Article / Segment

/// Only text articles sync (video/audio/book materials reference local files).
pub fn is_syncable_article(article_id: &str, source_type: Option<&str>) -> bool {
    is_uuid(article_id)
        && matches!(
            source_type,
            None | Some("article") | Some("web") | Some("lyrics")
        )
}

pub fn article_payload(article: &Article, updated_at: &str) -> Option<JsonObject> {
    if !is_syncable_article(&article.id, article.source_type.as_deref()) {
        return None;
    }
    let created_at = iso(&article.created_at).unwrap_or_else(now_iso);
    Some(obj(json!({
        "id": article.id.to_lowercase(),
        "title": article.title,
        "content": article.content,
        "sourceType": article.source_type.clone().unwrap_or_else(|| "article".into()),
        "sourceURL": opt_str(&article.source_url),
        "createdAt": created_at,
        "updatedAt": iso(updated_at).unwrap_or_else(|| created_at.clone()),
    })))
}

pub struct ArticleFields {
    pub title: String,
    pub content: String,
    pub source_type: Option<String>,
    pub source_url: Option<String>,
    pub created_at: String,
}

pub fn article_fields_from_payload(p: &JsonObject) -> ArticleFields {
    ArticleFields {
        title: get_str(p, "title").unwrap_or_default(),
        content: get_str(p, "content").unwrap_or_default(),
        source_type: get_str(p, "sourceType"),
        source_url: get_str(p, "sourceURL").or_else(|| get_str(p, "sourceUrl")),
        created_at: get_str(p, "createdAt").unwrap_or_else(now_iso),
    }
}

fn explanation_payload(e: &SegmentExplanation) -> Value {
    json!({
        "translation": e.translation,
        "explanation": e.explanation,
        "readingText": e.reading_text,
        "vocabulary": e.vocabulary.iter().map(|v| json!({
            "word": v.word,
            "meaning": v.meaning,
            "usage": if v.usage.trim().is_empty() { Value::Null } else { Value::String(v.usage.clone()) },
            "example": v.example,
            "reading": v.reading,
        })).collect::<Vec<_>>(),
        "grammarPoints": e.grammar_points.iter().map(|g| json!({
            "point": g.point,
            "explanation": g.explanation,
            "example": g.example,
        })).collect::<Vec<_>>(),
        "culturalContext": e.cultural_context,
        "difficultyLevel": e.difficulty_level,
        "learningTips": e.learning_tips,
    })
}

pub fn explanation_from_payload(v: &Value) -> Option<SegmentExplanation> {
    let p = v.as_object()?;
    let items = |key: &str| -> Vec<&JsonObject> {
        p.get(key)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_object).collect())
            .unwrap_or_default()
    };
    Some(SegmentExplanation {
        translation: get_str(p, "translation").unwrap_or_default(),
        explanation: get_str(p, "explanation").unwrap_or_default(),
        reading_text: get_str(p, "readingText").or_else(|| get_str(p, "reading_text")),
        vocabulary: items("vocabulary")
            .into_iter()
            .map(|v| VocabularyItem {
                word: get_str(v, "word").unwrap_or_default(),
                meaning: get_str(v, "meaning").unwrap_or_default(),
                usage: get_str(v, "usage").unwrap_or_default(),
                example: get_str(v, "example"),
                reading: get_str(v, "reading"),
            })
            .collect(),
        grammar_points: {
            let mut g = items("grammarPoints");
            if g.is_empty() {
                g = items("grammar_points");
            }
            g.into_iter()
                .map(|g| GrammarPoint {
                    point: get_str(g, "point").unwrap_or_default(),
                    explanation: get_str(g, "explanation").unwrap_or_default(),
                    example: get_str(g, "example"),
                })
                .collect()
        },
        cultural_context: get_str(p, "culturalContext").or_else(|| get_str(p, "cultural_context")),
        difficulty_level: get_str(p, "difficultyLevel").or_else(|| get_str(p, "difficulty_level")),
        learning_tips: get_str(p, "learningTips").or_else(|| get_str(p, "learning_tips")),
    })
}

pub fn segment_payload(segment: &ArticleSegment, revision: i64) -> Option<JsonObject> {
    if !is_uuid(&segment.id) || !is_uuid(&segment.article_id) {
        return None;
    }
    Some(obj(json!({
        "id": segment.id.to_lowercase(),
        "articleId": segment.article_id.to_lowercase(),
        "order": segment.order,
        "text": segment.text,
        "readingText": opt_str(&segment.reading_text),
        "translation": opt_str(&segment.translation),
        "explanation": segment.explanation.as_ref().map(explanation_payload).unwrap_or(Value::Null),
        "isNewParagraph": segment.is_new_paragraph,
        "startTime": opt_f64(segment.start_time),
        "endTime": opt_f64(segment.end_time),
        "createdAt": iso(&segment.created_at).unwrap_or_else(now_iso),
        "segmentationRevision": revision,
    })))
}

pub fn segment_from_payload(id: &str, p: &JsonObject) -> Option<(ArticleSegment, i64)> {
    let article_id = get_str(p, "articleId")?.to_lowercase();
    Some((
        ArticleSegment {
            id: id.to_lowercase(),
            article_id,
            order: get_i64(p, "order").unwrap_or(0) as i32,
            text: get_str(p, "text").unwrap_or_default(),
            reading_text: get_str(p, "readingText"),
            translation: get_str(p, "translation"),
            explanation: p.get("explanation").and_then(explanation_from_payload),
            start_time: get_f64(p, "startTime"),
            end_time: get_f64(p, "endTime"),
            created_at: get_str(p, "createdAt").unwrap_or_else(now_iso),
            is_new_paragraph: get_bool(p, "isNewParagraph").unwrap_or(false),
        },
        get_i64(p, "segmentationRevision").unwrap_or(0),
    ))
}

// MARK: - BookMark

/// The desktop reader addresses books by file path, so a desktop bookmark carries its
/// path-based locator as extra fields (`bookPath`, `bookType`, `title`, `pageNumber`). `bookId`
/// is the desktop book-article id when one exists for that path.
pub fn bookmark_payload(
    b: &Bookmark,
    book_id: Option<&str>,
    updated_at: &str,
) -> Option<JsonObject> {
    if !is_uuid(&b.id) {
        return None;
    }
    let created_at = iso(&b.created_at).unwrap_or_else(now_iso);
    Some(obj(json!({
        "id": b.id.to_lowercase(),
        "bookId": book_id.map(str::to_lowercase),
        "chapterIndex": b.page_number.map(|p| (p - 1).max(0)).unwrap_or(0),
        "kind": if b.selected_text.as_deref().map(|s| !s.is_empty()).unwrap_or(false) { "highlight" } else { "bookmark" },
        "locator": opt_str(&b.epub_cfi),
        "selectedText": opt_str(&b.selected_text),
        "note": opt_str(&b.note),
        "color": opt_str(&b.color),
        "createdAt": created_at,
        "updatedAt": iso(updated_at).unwrap_or_else(|| created_at.clone()),
        "bookPath": b.book_path,
        "bookType": b.book_type,
        "title": b.title,
        "pageNumber": b.page_number,
    })))
}

/// Only bookmarks created by a desktop (they carry `bookPath`) can be shown by the desktop reader.
pub fn bookmark_from_payload(id: &str, p: &JsonObject) -> Option<Bookmark> {
    let book_path = get_str(p, "bookPath")?;
    Some(Bookmark {
        id: id.to_lowercase(),
        book_path,
        book_type: get_str(p, "bookType").unwrap_or_default(),
        title: get_str(p, "title").unwrap_or_default(),
        note: get_str(p, "note"),
        selected_text: get_str(p, "selectedText"),
        page_number: get_i64(p, "pageNumber").map(|v| v as i32),
        epub_cfi: get_str(p, "locator"),
        created_at: get_str(p, "createdAt").unwrap_or_else(now_iso),
        color: get_str(p, "color"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fav() -> FavoriteVocabulary {
        serde_json::from_value(json!({
            "id": "3F0C2A4E-1D2B-4C5D-9E8F-0A1B2C3D4E5F",
            "word": "懐かしい", "meaning": "nostalgic", "usage": "",
            "source_article_id": "not-a-uuid", "source_article_title": null,
            "example": null, "reading": "なつかしい",
            "pack_ids": ["system-ungrouped", "5A5B5C5D-0000-4000-8000-00000000ABCD"],
            "srs_state": "review", "stability": 3.5, "difficulty": 5.0,
            "scheduler_version": "fsrs6", "due_date": "2026-10-01",
            "last_reviewed_at": "2026-09-28T10:00:00.123456+00:00",
            "review_count": 2, "created_at": "2026-09-01T00:00:00+08:00"
        }))
        .unwrap()
    }

    #[test]
    fn vocabulary_payload_is_camel_case_ios_shape() {
        let p = vocabulary_payload(&fav(), "2026-09-28T12:00:00Z").unwrap();
        assert_eq!(p["id"], "3f0c2a4e-1d2b-4c5d-9e8f-0a1b2c3d4e5f");
        assert_eq!(p["srsState"], "review");
        assert_eq!(p["dueDate"], "2026-10-01");
        assert_eq!(p["reviewCount"], 2);
        assert_eq!(p["createdAt"], "2026-08-31T16:00:00.000Z");
        assert_eq!(p["lastReviewedAt"], "2026-09-28T10:00:00.123Z");
        assert_eq!(p["updatedAt"], "2026-09-28T12:00:00.000Z");
        assert_eq!(p["usage"], Value::Null);
        assert_eq!(p["sourceArticleId"], Value::Null);
        assert_eq!(
            p["packIds"],
            json!(["5a5b5c5d-0000-4000-8000-00000000abcd"])
        );
        assert!(!p.contains_key("srs_state"));
    }

    #[test]
    fn vocabulary_roundtrip_keeps_desktop_only_fields() {
        let original = fav();
        let p = vocabulary_payload(&original, "2026-09-28T12:00:00Z").unwrap();
        let back = vocabulary_from_payload(&original.id, &p, Some(&original));
        assert_eq!(back.word, original.word);
        assert_eq!(back.pack_ids, original.pack_ids);
        assert_eq!(back.stability, 3.5);
        assert_eq!(back.ease_factor, original.ease_factor);
        assert_eq!(back.review_count, 2);
    }

    #[test]
    fn non_uuid_and_system_records_are_not_synced() {
        let mut f = fav();
        f.id = "old-1".into();
        assert!(vocabulary_payload(&f, "2026-09-28T12:00:00Z").is_none());
        assert!(membership_payload(
            "3f0c2a4e-1d2b-4c5d-9e8f-0a1b2c3d4e5f",
            "system-ungrouped",
            "2026-09-28T00:00:00Z"
        )
        .is_none());
        assert_eq!(
            desktop_pack_id("00000000-0000-4000-8000-0000756E6772"),
            "system-ungrouped"
        );
        assert!(!is_syncable_article(
            "3f0c2a4e-1d2b-4c5d-9e8f-0a1b2c3d4e5f",
            Some("youtube")
        ));
        assert!(is_syncable_article(
            "3f0c2a4e-1d2b-4c5d-9e8f-0a1b2c3d4e5f",
            None
        ));
        assert_eq!(
            parse_membership_id("AA_BB"),
            Some(("aa".to_string(), "bb".to_string()))
        );
    }

    #[test]
    fn segment_explanation_is_camel_case_and_roundtrips() {
        let seg = ArticleSegment {
            id: "7c6d5e4f-3a2b-4c1d-8e9f-0a1b2c3d4e5f".into(),
            article_id: "0b8e2c1a-5d4f-4e3a-9b2c-1d0e9f8a7b6c".into(),
            order: 3,
            text: "猫が好きです。".into(),
            reading_text: None,
            translation: Some("I like cats.".into()),
            explanation: Some(SegmentExplanation {
                translation: "I like cats.".into(),
                explanation: "が".into(),
                reading_text: None,
                vocabulary: vec![VocabularyItem {
                    word: "猫".into(),
                    meaning: "cat".into(),
                    usage: "".into(),
                    example: None,
                    reading: Some("ねこ".into()),
                }],
                grammar_points: vec![GrammarPoint {
                    point: "が好き".into(),
                    explanation: "like".into(),
                    example: None,
                }],
                cultural_context: Some("c".into()),
                difficulty_level: None,
                learning_tips: None,
            }),
            start_time: Some(1.5),
            end_time: None,
            created_at: "2026-09-28T00:00:00Z".into(),
            is_new_paragraph: true,
        };
        let p = segment_payload(&seg, 2).unwrap();
        assert_eq!(p["segmentationRevision"], 2);
        assert_eq!(p["explanation"]["grammarPoints"][0]["point"], "が好き");
        assert_eq!(p["explanation"]["culturalContext"], "c");
        assert_eq!(p["startTime"], 1.5);
        let (back, rev) = segment_from_payload(&seg.id, &p).unwrap();
        assert_eq!(rev, 2);
        assert_eq!(back.order, 3);
        let exp = back.explanation.unwrap();
        assert_eq!(exp.grammar_points[0].point, "が好き");
        assert_eq!(exp.vocabulary[0].reading.as_deref(), Some("ねこ"));
    }
}
