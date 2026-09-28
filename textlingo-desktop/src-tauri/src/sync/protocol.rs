//! Sync protocol v1 wire types (docs/specs/sync-protocol-spec.md §2, §5).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const PROTOCOL_VERSION: u32 = 1;
pub const INLINE_PAYLOAD_LIMIT: usize = 512 * 1024;
pub const MAX_PUSH_OPS: usize = 500;
/// Stay under the server's 4 MB request limit with some headroom.
pub const MAX_PUSH_BYTES: usize = 3_500_000;
pub const DEFAULT_PULL_LIMIT: u32 = 500;

pub type JsonObject = Map<String, Value>;

/// Every record type of spec §2.2 (unknown types are skipped but advance the cursor).
pub const RECORD_TYPES: &[&str] = &[
    "Book",
    "Media",
    "Article",
    "LyricsMeta",
    "BookChapter",
    "MediaPart",
    "Segment",
    "WordPack",
    "Vocabulary",
    "WordPackMembership",
    "BookMark",
    "BookProgress",
    "ReviewEvent",
    "WordGloss",
    "ReadingSession",
    "Setting",
    "MediaProgress",
];

pub fn is_record_type(value: &str) -> bool {
    RECORD_TYPES.contains(&value)
}

/// Spec §2.3 merge order (foreign keys first).
pub fn merge_order(record_type: &str) -> u32 {
    match record_type {
        "Book" => 0,
        "Media" => 1,
        "Article" => 2,
        "LyricsMeta" => 3,
        "BookChapter" => 4,
        "MediaPart" => 5,
        "Segment" => 6,
        "WordPack" => 7,
        "Vocabulary" => 8,
        "WordPackMembership" => 9,
        "BookMark" => 10,
        "BookProgress" => 11,
        "ReviewEvent" => 12,
        _ => 99,
    }
}

pub fn canonical_id(id: &str) -> String {
    id.to_lowercase()
}

/// Wire record (spec §2.1).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncRecord {
    #[serde(rename = "type")]
    pub record_type: String,
    pub id: String,
    #[serde(default)]
    pub rev: i64,
    pub hlc: String,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub payload: Option<JsonObject>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob_url: Option<String>,
}

/// A record as held by this client (the `sync_record` table).
#[derive(Debug, Clone, PartialEq)]
pub struct LocalRecord {
    pub record_type: String,
    /// Canonical (lowercase) id.
    pub id: String,
    /// Last server rev seen; 0 = never on the server. Sent as `baseRev`.
    pub rev: i64,
    pub hlc: String,
    pub deleted: bool,
    /// None for tombstones.
    pub payload: Option<JsonObject>,
    /// Has a local change the server has not acknowledged.
    pub dirty: bool,
    /// opId of the pending push; reused on network retries so the server can dedupe.
    pub op_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResponse {
    pub records: Vec<SyncRecord>,
    pub cursor: String,
    #[serde(default)]
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOp {
    pub op_id: String,
    #[serde(rename = "type")]
    pub record_type: String,
    pub id: String,
    pub base_rev: i64,
    pub hlc: String,
    pub deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    pub device_id: String,
    pub ops: Vec<PushOp>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum PushResult {
    Applied {
        #[serde(rename = "opId")]
        op_id: String,
        rev: i64,
    },
    Conflict {
        #[serde(rename = "opId")]
        op_id: String,
        rev: i64,
        current: SyncRecord,
    },
    Rejected {
        #[serde(rename = "opId")]
        op_id: String,
        code: String,
        #[serde(default)]
        message: Option<String>,
    },
}

impl PushResult {
    pub fn op_id(&self) -> &str {
        match self {
            PushResult::Applied { op_id, .. }
            | PushResult::Conflict { op_id, .. }
            | PushResult::Rejected { op_id, .. } => op_id,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct PushResponse {
    pub results: Vec<PushResult>,
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobUploadTicket {
    pub blob_key: String,
    pub upload_url: String,
}
