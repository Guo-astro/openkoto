//! `sync_meta` / `sync_record` access (the engine's LocalStore, spec §8) and the HLC clock
//! persisted in `sync_meta`.

use super::hlc::{hex_node, HybridClock};
use super::protocol::{canonical_id, JsonObject, LocalRecord};
use crate::db::sql_err;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const META_CURSOR: &str = "cursor";
pub const META_HLC: &str = "hlc";
pub const META_DEVICE_ID: &str = "deviceId";
pub const META_ACCOUNT_USER: &str = "accountUserId";
pub const META_LAST_SYNC_AT: &str = "lastSyncAt";
pub const META_LAST_ERROR: &str = "lastError";
pub const META_LEGACY_IMPORTED: &str = "legacyJsonImported";

pub fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("select v from sync_meta where k = ?1", [key], |r| {
        r.get::<_, Option<String>>(0)
    })
    .optional()
    .map(|v| v.flatten())
    .map_err(sql_err)
}

pub fn set_meta(conn: &Connection, key: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(v) => conn
            .execute(
                "insert into sync_meta (k, v) values (?1, ?2) on conflict(k) do update set v = excluded.v",
                params![key, v],
            )
            .map(|_| ())
            .map_err(sql_err),
        None => conn
            .execute("delete from sync_meta where k = ?1", [key])
            .map(|_| ())
            .map_err(sql_err),
    }
}

/// Local device id (random UUID, generated once). Its first 8 hex chars are the HLC node id.
pub fn ensure_device_id(conn: &Connection) -> Result<String, String> {
    if let Some(id) = get_meta(conn, META_DEVICE_ID)? {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    set_meta(conn, META_DEVICE_ID, Some(&id))?;
    Ok(id)
}

pub fn load_clock(conn: &Connection) -> Result<HybridClock, String> {
    let device = ensure_device_id(conn)?;
    let saved = get_meta(conn, META_HLC)?;
    Ok(HybridClock::new(&hex_node(&device), saved.as_deref()))
}

pub fn save_clock(conn: &Connection, clock: &HybridClock) -> Result<(), String> {
    set_meta(conn, META_HLC, Some(&clock.current()))
}

/// Fresh HLC for one local change (loads + saves the persisted clock).
pub fn tick(conn: &Connection) -> Result<String, String> {
    let mut clock = load_clock(conn)?;
    let hlc = clock.tick();
    save_clock(conn, &clock)?;
    Ok(hlc)
}

fn canonical_value(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(k.clone(), canonical_value(&map[k]));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical_value).collect()),
        other => other.clone(),
    }
}

/// Stable hash of a payload (keys sorted), used to skip no-op writes and to detect changes
/// that must be projected into the domain tables.
pub fn payload_hash(payload: Option<&JsonObject>) -> Option<String> {
    let payload = payload?;
    let canonical = canonical_value(&Value::Object(payload.clone()));
    let text = serde_json::to_string(&canonical).ok()?;
    let digest = Sha256::digest(text.as_bytes());
    Some(digest.iter().map(|b| format!("{b:02x}")).collect())
}

fn row_to_record(r: &rusqlite::Row) -> rusqlite::Result<(LocalRecord, Option<String>)> {
    let payload_text: Option<String> = r.get("payload")?;
    let payload = payload_text
        .as_deref()
        .and_then(|t| serde_json::from_str::<Value>(t).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        });
    Ok((
        LocalRecord {
            record_type: r.get("type")?,
            id: r.get("id")?,
            rev: r.get("rev")?,
            hlc: r.get("hlc")?,
            deleted: r.get::<_, i64>("deleted")? != 0,
            payload,
            dirty: r.get::<_, i64>("dirty")? != 0,
            op_id: r.get("op_id")?,
        },
        r.get("payload_hash")?,
    ))
}

pub fn get_record(
    conn: &Connection,
    record_type: &str,
    id: &str,
) -> Result<Option<LocalRecord>, String> {
    get_record_with_hash(conn, record_type, id).map(|o| o.map(|(r, _)| r))
}

pub fn get_record_with_hash(
    conn: &Connection,
    record_type: &str,
    id: &str,
) -> Result<Option<(LocalRecord, Option<String>)>, String> {
    conn.query_row(
        "select * from sync_record where type = ?1 and id = ?2",
        params![record_type, canonical_id(id)],
        row_to_record,
    )
    .optional()
    .map_err(sql_err)
}

pub fn put_record(conn: &Connection, record: &LocalRecord) -> Result<(), String> {
    let payload = if record.deleted {
        None
    } else {
        record.payload.as_ref()
    };
    let payload_text = payload
        .map(|p| serde_json::to_string(p))
        .transpose()
        .map_err(|e| format!("Failed to serialize payload: {e}"))?;
    conn.execute(
        "insert into sync_record (type, id, rev, hlc, deleted, dirty, op_id, payload_hash, payload)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         on conflict(type, id) do update set rev = excluded.rev, hlc = excluded.hlc,
           deleted = excluded.deleted, dirty = excluded.dirty, op_id = excluded.op_id,
           payload_hash = excluded.payload_hash, payload = excluded.payload",
        params![
            record.record_type,
            canonical_id(&record.id),
            record.rev,
            record.hlc,
            record.deleted as i64,
            record.dirty as i64,
            record.op_id,
            payload_hash(payload),
            payload_text,
        ],
    )
    .map(|_| ())
    .map_err(sql_err)
}

pub fn dirty_records(conn: &Connection) -> Result<Vec<LocalRecord>, String> {
    let mut stmt = conn
        .prepare("select * from sync_record where dirty = 1")
        .map_err(sql_err)?;
    let rows = stmt
        .query_map([], row_to_record)
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    Ok(rows.into_iter().map(|(r, _)| r).collect())
}

pub fn dirty_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "select count(*) from sync_record where dirty = 1",
        [],
        |r| r.get(0),
    )
    .map_err(sql_err)
}

pub fn list_by_type(conn: &Connection, record_type: &str) -> Result<Vec<LocalRecord>, String> {
    let mut stmt = conn
        .prepare("select * from sync_record where type = ?1")
        .map_err(sql_err)?;
    let rows = stmt
        .query_map([record_type], row_to_record)
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    Ok(rows.into_iter().map(|(r, _)| r).collect())
}

/// Live records of `record_type` whose payload field `field` equals `value` (case-insensitive).
pub fn list_by_payload_field(
    conn: &Connection,
    record_type: &str,
    field: &str,
    value: &str,
) -> Result<Vec<LocalRecord>, String> {
    let sql = format!(
        "select * from sync_record where type = ?1 and deleted = 0 and lower(json_extract(payload, '$.{field}')) = lower(?2)"
    );
    let mut stmt = conn.prepare(&sql).map_err(sql_err)?;
    let rows = stmt
        .query_map(params![record_type, value], row_to_record)
        .map_err(sql_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_err)?;
    Ok(rows.into_iter().map(|(r, _)| r).collect())
}

/// Max `segmentationRevision` among the live Segment records of an article (None = none).
pub fn max_segment_revision(conn: &Connection, article_id: &str) -> Result<Option<i64>, String> {
    conn.query_row(
        "select max(coalesce(cast(json_extract(payload, '$.segmentationRevision') as integer), 0)), count(*)
         from sync_record where type = 'Segment' and deleted = 0
           and lower(json_extract(payload, '$.articleId')) = lower(?1)",
        [article_id],
        |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, i64>(1)?)),
    )
    .map(|(max, count)| if count == 0 { None } else { max.or(Some(0)) })
    .map_err(sql_err)
}

/// Result of [`record_local_change`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordChange {
    Recorded,
    Unchanged,
}

/// Record a local create/update/delete: fresh HLC (or `legacy_hlc`), dirty, new opId.
///
/// - `payload` is overlaid on the previous payload so unknown fields from other clients
///   round-trip (spec §2.2); keys whose new value is `null` are removed (Swift omits nils).
/// - No-op writes (same payload, same liveness) are skipped.
/// - ReviewEvents are immutable: an existing live event is never modified or deleted.
pub fn record_local_change(
    conn: &Connection,
    record_type: &str,
    id: &str,
    payload: Option<JsonObject>,
    legacy_hlc: Option<String>,
) -> Result<RecordChange, String> {
    let id = canonical_id(id);
    let existing = get_record(conn, record_type, &id)?;
    let deleted = payload.is_none();

    if record_type == "ReviewEvent" {
        if deleted || existing.as_ref().map(|r| !r.deleted).unwrap_or(false) {
            return Ok(RecordChange::Unchanged);
        }
    }

    let merged = match payload {
        Some(new) => {
            let mut base = existing
                .as_ref()
                .filter(|r| !r.deleted)
                .and_then(|r| r.payload.clone())
                .unwrap_or_default();
            for (k, v) in new {
                if v.is_null() {
                    base.remove(&k);
                } else {
                    base.insert(k, v);
                }
            }
            Some(base)
        }
        None => None,
    };

    if let Some(existing) = existing.as_ref() {
        let same_liveness = existing.deleted == deleted;
        if same_liveness
            && (deleted || payload_hash(existing.payload.as_ref()) == payload_hash(merged.as_ref()))
        {
            return Ok(RecordChange::Unchanged);
        }
    } else if deleted {
        // Deleting something the sync layer never knew about: nothing to propagate.
        return Ok(RecordChange::Unchanged);
    }

    let hlc = match legacy_hlc {
        Some(h) => h,
        None => tick(conn)?,
    };
    put_record(
        conn,
        &LocalRecord {
            record_type: record_type.to_string(),
            id,
            rev: existing.as_ref().map(|r| r.rev).unwrap_or(0),
            hlc,
            deleted,
            payload: merged,
            dirty: true,
            op_id: Some(uuid::Uuid::new_v4().to_string()),
        },
    )?;
    Ok(RecordChange::Recorded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn obj(v: Value) -> JsonObject {
        match v {
            Value::Object(m) => m,
            _ => panic!(),
        }
    }

    #[test]
    fn record_local_change_dedupes_and_preserves_unknown_fields() {
        let dir = db::test_util::temp_dir("record-local");
        let database = db::open(&dir).unwrap();
        database
            .write(|tx| {
                let id = "3F0C2A4E-1D2B-4C5D-9E8F-0A1B2C3D4E5F";
                let first = record_local_change(
                    tx,
                    "Vocabulary",
                    id,
                    Some(obj(serde_json::json!({"word": "a", "futureField": 1}))),
                    None,
                )?;
                assert_eq!(first, RecordChange::Recorded);
                let rec = get_record(tx, "Vocabulary", id)?.unwrap();
                assert_eq!(rec.id, id.to_lowercase());
                assert!(rec.dirty);
                // Overlay: futureField survives, null removes a key.
                let second = record_local_change(
                    tx,
                    "Vocabulary",
                    id,
                    Some(obj(serde_json::json!({"word": "b", "reading": null}))),
                    None,
                )?;
                assert_eq!(second, RecordChange::Recorded);
                let rec2 = get_record(tx, "Vocabulary", id)?.unwrap();
                assert_eq!(rec2.payload.as_ref().unwrap()["futureField"], 1);
                assert!(rec2.hlc > rec.hlc);
                // Same payload again → no-op.
                let third = record_local_change(
                    tx,
                    "Vocabulary",
                    id,
                    Some(obj(serde_json::json!({"word": "b"}))),
                    None,
                )?;
                assert_eq!(third, RecordChange::Unchanged);
                // Delete → tombstone.
                assert_eq!(
                    record_local_change(tx, "Vocabulary", id, None, None)?,
                    RecordChange::Recorded
                );
                let tomb = get_record(tx, "Vocabulary", id)?.unwrap();
                assert!(tomb.deleted && tomb.payload.is_none());
                // ReviewEvents are immutable.
                let ev = "e1000000-0000-4000-8000-000000000001";
                record_local_change(
                    tx,
                    "ReviewEvent",
                    ev,
                    Some(obj(serde_json::json!({"grade": 3}))),
                    None,
                )?;
                assert_eq!(
                    record_local_change(
                        tx,
                        "ReviewEvent",
                        ev,
                        Some(obj(serde_json::json!({"grade": 1}))),
                        None
                    )?,
                    RecordChange::Unchanged
                );
                assert_eq!(
                    record_local_change(tx, "ReviewEvent", ev, None, None)?,
                    RecordChange::Unchanged
                );
                Ok(())
            })
            .unwrap();
        db::close(&dir);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn payload_hash_ignores_key_order() {
        let a = obj(serde_json::json!({"a": 1, "b": {"x": 1, "y": 2}}));
        let b = obj(serde_json::json!({"b": {"y": 2, "x": 1}, "a": 1}));
        assert_eq!(payload_hash(Some(&a)), payload_hash(Some(&b)));
    }
}
