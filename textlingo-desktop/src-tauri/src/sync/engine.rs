//! Sync cycle over SQLite (sync-protocol-spec §8). Port of
//! `packages/client/src/sync/engine.ts` with the desktop domain projection.

use super::apply;
use super::hlc::{parse_hlc, HybridClock, MAX_CLOCK_SKEW_MS};
use super::merge::{merge_remote, MergeContext, MergeOutcome};
use super::protocol::{
    canonical_id, is_record_type, merge_order, JsonObject, LocalRecord, PullResponse, PushOp,
    PushRequest, PushResponse, PushResult, SyncRecord, DEFAULT_PULL_LIMIT, INLINE_PAYLOAD_LIMIT,
    MAX_PUSH_BYTES, MAX_PUSH_OPS,
};
use super::replay::ReplayOptions;
use super::store::{self, META_CURSOR};
use crate::db::Database;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};
use std::future::Future;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

/// HTTP-level failure (spec §5.5).
#[derive(Debug, Clone, PartialEq)]
pub struct TransportError {
    pub status: Option<u16>,
    pub code: String,
    pub message: String,
    pub retry_after_secs: Option<u64>,
}

impl TransportError {
    pub fn new(status: Option<u16>, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.to_string(),
            message: message.into(),
            retry_after_secs: None,
        }
    }
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(s) => write!(f, "{} ({}): {}", self.code, s, self.message),
            None => write!(f, "{}: {}", self.code, self.message),
        }
    }
}

/// Network side of the engine. Implemented by [`crate::cloud::api::ApiClient`]; tests use a mock.
pub trait Transport: Send + Sync {
    fn pull(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> impl Future<Output = Result<PullResponse, TransportError>> + Send;
    fn push(
        &self,
        request: PushRequest,
    ) -> impl Future<Output = Result<PushResponse, TransportError>> + Send;
    /// Download a gzip blob (`blobUrl` of a pulled record).
    fn fetch_blob(
        &self,
        url: String,
    ) -> impl Future<Output = Result<Vec<u8>, TransportError>> + Send;
    /// Upload a gzip blob for a payload over 512 KB; returns the `blobKey` (spec §5.4).
    fn upload_blob(
        &self,
        record_type: String,
        id: String,
        gzip: Vec<u8>,
        sha256: String,
    ) -> impl Future<Output = Result<String, TransportError>> + Send;
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RejectedOp {
    #[serde(rename = "type")]
    pub record_type: String,
    pub id: String,
    pub code: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pulled: usize,
    pub applied: usize,
    pub pushed: usize,
    pub conflicts: usize,
    pub repush_rounds: usize,
    pub rejected: Vec<RejectedOp>,
    pub rebuilt: bool,
    pub replayed_cards: Vec<String>,
    pub diagnostics: Vec<String>,
    /// Same-word cards merged on the first sync (spec §9).
    pub deduped: usize,
}

#[derive(Debug, Clone)]
pub enum SyncError {
    Transport(TransportError),
    Local(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::Transport(e) => write!(f, "{e}"),
            SyncError::Local(e) => write!(f, "{e}"),
        }
    }
}

impl From<String> for SyncError {
    fn from(e: String) -> Self {
        SyncError::Local(e)
    }
}

impl From<TransportError> for SyncError {
    fn from(e: TransportError) -> Self {
        SyncError::Transport(e)
    }
}

pub struct EngineOptions {
    pub pull_limit: u32,
    pub push_batch_size: usize,
    /// Spec §5.2: at most 2 re-push rounds per cycle.
    pub max_repush_rounds: usize,
    pub replay: ReplayOptions,
    /// Server-issued device id sent with pushes (the local id is used when absent).
    pub device_id: Option<String>,
    /// First sync of an account on this device: merge same-word cards after the pull (§9).
    pub dedupe: bool,
}

impl Default for EngineOptions {
    fn default() -> Self {
        Self {
            pull_limit: DEFAULT_PULL_LIMIT,
            push_batch_size: MAX_PUSH_OPS,
            max_repush_rounds: 2,
            replay: ReplayOptions::default(),
            device_id: None,
            dedupe: false,
        }
    }
}

pub struct HttpSyncEngine<'a, T: Transport> {
    db: Arc<Database>,
    data_dir: PathBuf,
    transport: &'a T,
    opts: EngineOptions,
}

fn key(record_type: &str, id: &str) -> String {
    format!("{record_type}\u{0}{id}")
}

fn new_op_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn lower_str(p: Option<&JsonObject>, field: &str) -> Option<String> {
    p.and_then(|p| p.get(field))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(canonical_id)
}

pub fn gzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(bytes).map_err(|e| e.to_string())?;
    enc.finish().map_err(|e| e.to_string())
}

pub fn gunzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Can this dirty record be pushed now? BookMarks / BookProgress need their Book record
/// (PDF books have none: server-side books are EPUB/TXT only), so those stay local-dirty.
fn pushable(conn: &Connection, r: &LocalRecord) -> Result<bool, String> {
    if (r.record_type == "BookMark" || r.record_type == "BookProgress") && !r.deleted {
        let Some(book_id) = lower_str(r.payload.as_ref(), "bookId") else {
            return Ok(false);
        };
        return Ok(store::get_record(conn, "Book", &book_id)?
            .map(|b| !b.deleted)
            .unwrap_or(false));
    }
    Ok(true)
}

struct Cycle {
    report: SyncReport,
    cards: BTreeSet<String>,
    touched: apply::Touched,
}

impl<'a, T: Transport> HttpSyncEngine<'a, T> {
    pub fn new(db: Arc<Database>, transport: &'a T, opts: EngineOptions) -> Self {
        let data_dir = db.data_dir().to_path_buf();
        Self {
            db,
            data_dir,
            transport,
            opts,
        }
    }

    /// One sync cycle (spec §8). Callers serialise cycles (see `crate::cloud`).
    pub async fn sync(&self) -> Result<SyncReport, SyncError> {
        self.run_cycle(false).await
    }

    /// Spec §8 fullRebuild(), then a normal push.
    pub async fn full_rebuild(&self) -> Result<SyncReport, SyncError> {
        self.run_cycle(true).await
    }

    async fn run_cycle(&self, rebuild: bool) -> Result<SyncReport, SyncError> {
        let mut cycle = Cycle {
            report: SyncReport::default(),
            cards: BTreeSet::new(),
            touched: apply::Touched::default(),
        };
        if rebuild {
            self.rebuild(&mut cycle).await?;
        } else {
            match self.pull_all(&mut cycle, None).await {
                Ok(()) => {}
                Err(SyncError::Transport(e)) if e.status == Some(410) => {
                    self.rebuild(&mut cycle).await?;
                }
                Err(e) => {
                    self.materialize(&mut cycle);
                    return Err(e);
                }
            }
        }
        if self.opts.dedupe {
            let opts = &self.opts.replay;
            cycle.report.deduped = self
                .db
                .write(|tx| super::dedupe::dedupe_vocabulary(tx, opts))?;
        }
        let pushed = self.push_all(&mut cycle).await;
        self.materialize(&mut cycle);
        pushed?;

        let cards: Vec<String> = cycle.cards.iter().cloned().collect();
        if !cards.is_empty() {
            let opts = &self.opts.replay;
            self.db.write(|tx| {
                for card in &cards {
                    apply::replay_card(tx, card, opts)?;
                }
                Ok(())
            })?;
        }
        cycle.report.replayed_cards = cards;
        Ok(cycle.report)
    }

    fn materialize(&self, cycle: &mut Cycle) {
        let touched = std::mem::take(&mut cycle.touched);
        for book_id in touched.books {
            if let Err(e) = crate::storage::materialize_book_in_dir(&self.data_dir, &book_id) {
                cycle
                    .report
                    .diagnostics
                    .push(format!("materialize book {book_id}: {e}"));
            }
        }
        for article_id in touched.articles {
            if let Err(e) = crate::storage::materialize_article_in_dir(&self.data_dir, &article_id)
            {
                cycle
                    .report
                    .diagnostics
                    .push(format!("materialize {article_id}: {e}"));
            }
        }
    }

    async fn rebuild(&self, cycle: &mut Cycle) -> Result<(), SyncError> {
        cycle.report.rebuilt = true;
        self.db.write(|tx| store::set_meta(tx, META_CURSOR, None))?;
        let mut seen = HashSet::new();
        self.pull_all(cycle, Some(&mut seen)).await?;
        // Local live records the server no longer knows → treat as new.
        self.db.write(|tx| {
            let mut stmt = tx
                .prepare("select type, id from sync_record where deleted = 0")
                .map_err(crate::db::sql_err)?;
            let ids: Vec<(String, String)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(crate::db::sql_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(crate::db::sql_err)?;
            for (t, id) in ids {
                if seen.contains(&key(&t, &id)) {
                    continue;
                }
                let Some(mut r) = store::get_record(tx, &t, &id)? else {
                    continue;
                };
                if t == "WordPack"
                    && r.payload.as_ref().and_then(|p| p.get("isSystem"))
                        == Some(&Value::Bool(true))
                {
                    continue;
                }
                r.rev = 0;
                r.dirty = true;
                r.op_id = Some(new_op_id());
                store::put_record(tx, &r)?;
            }
            Ok(())
        })?;
        Ok(())
    }

    async fn pull_all(
        &self,
        cycle: &mut Cycle,
        mut seen: Option<&mut HashSet<String>>,
    ) -> Result<(), SyncError> {
        let mut cursor = self.db.read(|c| store::get_meta(c, META_CURSOR))?;
        loop {
            let mut page = self
                .transport
                .pull(cursor.clone(), self.opts.pull_limit)
                .await?;
            cycle.report.pulled += page.records.len();
            self.resolve_blobs(&mut page, &mut cycle.report).await;
            let next_cursor = page.cursor.clone();
            let records = std::mem::take(&mut page.records);
            self.db.write(|tx| {
                let mut clock = store::load_clock(tx)?;
                self.apply_batch(tx, &mut clock, records, cycle, seen.as_deref_mut())?;
                store::set_meta(tx, META_CURSOR, Some(&next_cursor))?;
                store::save_clock(tx, &clock)?;
                Ok(())
            })?;
            cursor = Some(next_cursor);
            if !page.has_more {
                break;
            }
        }
        Ok(())
    }

    async fn resolve_blobs(&self, page: &mut PullResponse, report: &mut SyncReport) {
        for r in page.records.iter_mut() {
            if r.deleted || r.payload.is_some() {
                continue;
            }
            let Some(url) = r.blob_url.clone() else {
                continue;
            };
            let fetched = self
                .transport
                .fetch_blob(url)
                .await
                .map_err(|e| e.to_string())
                .and_then(|gz| gunzip(&gz))
                .and_then(|raw| serde_json::from_slice::<Value>(&raw).map_err(|e| e.to_string()));
            match fetched {
                Ok(Value::Object(map)) => r.payload = Some(map),
                Ok(_) => report
                    .diagnostics
                    .push(format!("blob {}/{}: not an object", r.record_type, r.id)),
                Err(e) => report
                    .diagnostics
                    .push(format!("blob {}/{}: {e}", r.record_type, r.id)),
            }
        }
    }

    /// Apply remote records in mergeOrder (spec §2.3).
    fn apply_batch(
        &self,
        conn: &Connection,
        clock: &mut HybridClock,
        records: Vec<SyncRecord>,
        cycle: &mut Cycle,
        mut seen: Option<&mut HashSet<String>>,
    ) -> Result<(), String> {
        let mut known: Vec<SyncRecord> = Vec::with_capacity(records.len());
        for r in records {
            if !is_record_type(&r.record_type) {
                cycle
                    .report
                    .diagnostics
                    .push(format!("skipped unknown type {}", r.record_type));
                continue;
            }
            known.push(r);
        }
        // Stable sort keeps rev order within a type.
        known.sort_by_key(|r| merge_order(&r.record_type));
        for remote in known {
            if let Some(seen) = seen.as_deref_mut() {
                seen.insert(key(&remote.record_type, &canonical_id(&remote.id)));
            }
            // A live record whose payload could not be fetched is retried next cycle.
            if !remote.deleted && remote.payload.is_none() {
                continue;
            }
            if !self.accept_clock(clock, &remote, &mut cycle.report) {
                continue;
            }
            self.apply_remote(conn, clock, &remote, cycle)?;
        }
        Ok(())
    }

    /// HLC receive + 24 h skew guard (spec §3).
    fn accept_clock(
        &self,
        clock: &mut HybridClock,
        remote: &SyncRecord,
        report: &mut SyncReport,
    ) -> bool {
        match parse_hlc(&remote.hlc) {
            Err(_) => {
                report.diagnostics.push(format!(
                    "invalid hlc {} on {}/{}",
                    remote.hlc, remote.record_type, remote.id
                ));
                false
            }
            Ok(ts) if ts.wall > clock.now() + MAX_CLOCK_SKEW_MS => {
                report.diagnostics.push(format!(
                    "CLOCK_SKEW: {}/{} hlc {} is more than 24h ahead",
                    remote.record_type, remote.id, remote.hlc
                ));
                false
            }
            Ok(_) => clock.receive(&remote.hlc).is_ok(),
        }
    }

    fn apply_remote(
        &self,
        conn: &Connection,
        clock: &mut HybridClock,
        remote: &SyncRecord,
        cycle: &mut Cycle,
    ) -> Result<MergeOutcome, String> {
        let id = canonical_id(&remote.id);
        let local = store::get_record_with_hash(conn, &remote.record_type, &id)?;
        let mut ctx = MergeContext::default();
        if remote.record_type == "Segment" && !remote.deleted {
            if let Some(article_id) = lower_str(remote.payload.as_ref(), "articleId") {
                ctx.local_segment_revision = store::max_segment_revision(conn, &article_id)?;
            }
        }
        let (local_record, local_hash) = match &local {
            Some((r, h)) => (Some(r), h.clone()),
            None => (None, None),
        };
        let decision = merge_remote(local_record, remote, &ctx);
        let Some(mut record) = decision.record else {
            return Ok(decision.outcome);
        };
        if decision.retick {
            record.hlc = clock.tick();
        }
        if record.dirty {
            record.op_id = Some(new_op_id());
        }
        store::put_record(conn, &record)?;
        cycle.report.applied += 1;

        if let Some(purge) = &decision.purge_segments_below {
            for seg in
                store::list_by_payload_field(conn, "Segment", "articleId", &purge.article_id)?
            {
                if seg.id == id
                    || super::merge::segment_revision_of(seg.payload.as_ref()) >= purge.revision
                {
                    continue;
                }
                // Local-only removal: the re-segmenting device pushes the tombstones.
                store::put_record(
                    conn,
                    &LocalRecord {
                        deleted: true,
                        payload: None,
                        dirty: false,
                        op_id: None,
                        ..seg.clone()
                    },
                )?;
                crate::db::repo::delete_segment(conn, &seg.id)?;
            }
            cycle.touched.articles.insert(purge.article_id.clone());
        }

        let new_hash = store::payload_hash(record.payload.as_ref());
        let liveness_changed = local_record
            .map(|l| l.deleted != record.deleted)
            .unwrap_or(true);
        if liveness_changed || new_hash != local_hash {
            apply::project(
                conn,
                &record,
                local_record.and_then(|l| l.payload.as_ref()),
                &mut cycle.touched,
            )?;
        }

        if matches!(
            decision.outcome,
            MergeOutcome::Remote | MergeOutcome::Merged
        ) {
            if record.record_type == "ReviewEvent" {
                if let Some(card) = lower_str(record.payload.as_ref(), "vocabularyId") {
                    cycle.cards.insert(card);
                }
            } else if record.record_type == "Vocabulary" && !record.deleted {
                // Remote payload SRS fields never override the local replay (spec §6).
                cycle.cards.insert(record.id.clone());
            }
        }
        Ok(decision.outcome)
    }

    async fn build_op(&self, r: &LocalRecord) -> Result<Option<PushOp>, TransportError> {
        let mut op = PushOp {
            op_id: r.op_id.clone().unwrap_or_else(new_op_id),
            record_type: r.record_type.clone(),
            id: r.id.clone(),
            base_rev: r.rev,
            hlc: r.hlc.clone(),
            deleted: r.deleted,
            payload: None,
            blob_key: None,
        };
        if !r.deleted {
            let payload = r.payload.clone().unwrap_or_default();
            let text = serde_json::to_vec(&payload).unwrap_or_default();
            if text.len() > INLINE_PAYLOAD_LIMIT {
                let gz = gzip(&text).map_err(|e| TransportError::new(None, "LOCAL", e))?;
                let sha = sha256_hex(&gz);
                let blob_key = self
                    .transport
                    .upload_blob(r.record_type.clone(), r.id.clone(), gz, sha)
                    .await?;
                op.blob_key = Some(blob_key);
            } else {
                op.payload = Some(payload);
            }
        }
        Ok(Some(op))
    }

    async fn push_all(&self, cycle: &mut Cycle) -> Result<(), SyncError> {
        let device_id = match &self.opts.device_id {
            Some(d) => d.clone(),
            None => self.db.write(|tx| store::ensure_device_id(tx))?,
        };
        let mut skip: HashSet<String> = HashSet::new();
        let mut round = 0usize;
        loop {
            // Collect this round's batch.
            let batch: Vec<LocalRecord> = self.db.write(|tx| {
                let mut dirty = store::dirty_records(tx)?;
                dirty.retain(|r| !skip.contains(&key(&r.record_type, &r.id)));
                dirty.sort_by_key(|r| merge_order(&r.record_type));
                let mut batch = Vec::new();
                for mut r in dirty {
                    if r.record_type == "WordPack"
                        && r.payload.as_ref().and_then(|p| p.get("isSystem"))
                            == Some(&Value::Bool(true))
                    {
                        // System packs are never uploaded (spec §2.2).
                        r.dirty = false;
                        r.op_id = None;
                        store::put_record(tx, &r)?;
                        continue;
                    }
                    if !pushable(tx, &r)? {
                        skip.insert(key(&r.record_type, &r.id));
                        continue;
                    }
                    if r.op_id.is_none() {
                        r.op_id = Some(new_op_id());
                        store::put_record(tx, &r)?;
                    }
                    batch.push(r);
                }
                Ok(batch)
            })?;
            if batch.is_empty() {
                break;
            }
            if round > 0 {
                cycle.report.repush_rounds += 1;
            }

            let mut ops: Vec<PushOp> = Vec::with_capacity(batch.len());
            for r in &batch {
                match self.build_op(r).await {
                    Ok(Some(op)) => ops.push(op),
                    Ok(None) => {}
                    Err(e) => {
                        if e.status == Some(401) {
                            return Err(e.into());
                        }
                        skip.insert(key(&r.record_type, &r.id));
                        cycle.report.rejected.push(RejectedOp {
                            record_type: r.record_type.clone(),
                            id: r.id.clone(),
                            code: e.code.clone(),
                            message: Some(e.message.clone()),
                        });
                    }
                }
            }

            let mut conflicts = 0usize;
            for chunk in chunk_ops(ops, self.opts.push_batch_size.min(MAX_PUSH_OPS)) {
                let request = PushRequest {
                    device_id: device_id.clone(),
                    ops: chunk.clone(),
                };
                let response = match self.transport.push(request).await {
                    Ok(r) => r,
                    Err(e) if e.status == Some(413) && chunk.len() > 1 => {
                        // Split and retry halves (spec §5.5 PAYLOAD_TOO_LARGE).
                        let mut merged = PushResponse {
                            results: Vec::new(),
                            cursor: None,
                        };
                        let mid = chunk.len() / 2;
                        for half in [chunk[..mid].to_vec(), chunk[mid..].to_vec()] {
                            let r = self
                                .transport
                                .push(PushRequest {
                                    device_id: device_id.clone(),
                                    ops: half,
                                })
                                .await?;
                            merged.results.extend(r.results);
                        }
                        merged
                    }
                    Err(e) => return Err(e.into()),
                };
                conflicts += self.handle_push_results(&chunk, response, cycle, &mut skip)?;
            }
            if conflicts == 0 || round >= self.opts.max_repush_rounds {
                break;
            }
            round += 1;
        }
        Ok(())
    }

    fn handle_push_results(
        &self,
        ops: &[PushOp],
        response: PushResponse,
        cycle: &mut Cycle,
        skip: &mut HashSet<String>,
    ) -> Result<usize, String> {
        let mut conflicts = 0usize;
        self.db.write(|tx| {
            let mut clock = store::load_clock(tx)?;
            for op in ops {
                let Some(result) = response.results.iter().find(|r| r.op_id() == op.op_id) else {
                    continue;
                };
                match result {
                    PushResult::Applied { rev, .. } => {
                        cycle.report.pushed += 1;
                        let Some(mut cur) = store::get_record(tx, &op.record_type, &op.id)? else {
                            continue;
                        };
                        cur.rev = *rev;
                        if cur.hlc == op.hlc {
                            cur.dirty = false;
                            cur.op_id = None;
                        }
                        // else: a newer local edit made during the push stays dirty on the new rev.
                        store::put_record(tx, &cur)?;
                    }
                    PushResult::Conflict { current, .. } => {
                        conflicts += 1;
                        cycle.report.conflicts += 1;
                        cycle.report.pulled += 1;
                        let mut current = current.clone();
                        if current.deleted || current.payload.is_some() {
                            if self.accept_clock(&mut clock, &current, &mut cycle.report) {
                                self.apply_remote(tx, &mut clock, &current, cycle)?;
                            }
                        } else {
                            // Blob-backed current: rebase only; the next pull brings the payload.
                            current.payload = None;
                        }
                        if let Some(mut cur) = store::get_record(tx, &op.record_type, &op.id)? {
                            if cur.dirty {
                                // Rebase on the server's rev with a fresh opId (the old one is
                                // cached server-side as a conflict).
                                cur.rev = cur.rev.max(current.rev);
                                cur.op_id = Some(new_op_id());
                                store::put_record(tx, &cur)?;
                            }
                        }
                    }
                    PushResult::Rejected { code, message, .. } => {
                        skip.insert(key(&op.record_type, &op.id));
                        cycle.report.rejected.push(RejectedOp {
                            record_type: op.record_type.clone(),
                            id: op.id.clone(),
                            code: code.clone(),
                            message: message.clone(),
                        });
                        // Keep the data dirty for a later cycle; a fresh opId so the retry is
                        // evaluated again.
                        if let Some(mut cur) = store::get_record(tx, &op.record_type, &op.id)? {
                            if cur.dirty && cur.op_id.as_deref() == Some(op.op_id.as_str()) {
                                cur.op_id = Some(new_op_id());
                                store::put_record(tx, &cur)?;
                            }
                        }
                    }
                }
            }
            store::save_clock(tx, &clock)?;
            Ok(())
        })?;
        Ok(conflicts)
    }
}

/// Split ops into requests of at most `max_ops` ops and ~`MAX_PUSH_BYTES` bytes.
fn chunk_ops(ops: Vec<PushOp>, max_ops: usize) -> Vec<Vec<PushOp>> {
    let mut chunks = Vec::new();
    let mut current: Vec<PushOp> = Vec::new();
    let mut bytes = 0usize;
    for op in ops {
        let size = serde_json::to_vec(&op).map(|v| v.len()).unwrap_or(0) + 1;
        if !current.is_empty() && (current.len() >= max_ops.max(1) || bytes + size > MAX_PUSH_BYTES)
        {
            chunks.push(std::mem::take(&mut current));
            bytes = 0;
        }
        bytes += size;
        current.push(op);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

#[cfg(test)]
mod tests;
