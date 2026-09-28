//! Pure merge rules, sync-protocol-spec §4 (+ §6 ReviewEvent immutability).
//! Port of `packages/client/src/sync/merge.ts`; contract fixture
//! `docs/specs/fixtures/sync/merge-cases.json`.

use super::hlc::compare_hlc;
use super::protocol::{canonical_id, JsonObject, LocalRecord, SyncRecord};
use serde_json::Value;
use std::cmp::Ordering;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeOutcome {
    /// Remote version replaces local (dirty = false).
    Remote,
    /// Local version wins; stays/becomes dirty with baseRev = remote.rev so it is (re)pushed.
    Local,
    /// Remote won LWW but local contributed fields (Segment fill); dirty, needs a fresh HLC.
    Merged,
    /// Same write (equal HLC) or an existing immutable record: keep local payload, adopt rev.
    Acknowledge,
    /// Drop the remote record, no local write.
    Ignore,
}

impl MergeOutcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            MergeOutcome::Remote => "remote",
            MergeOutcome::Local => "local",
            MergeOutcome::Merged => "merged",
            MergeOutcome::Acknowledge => "acknowledge",
            MergeOutcome::Ignore => "ignore",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct MergeContext {
    /// Segment only: max `segmentationRevision` among the live local segments of the remote
    /// segment's article (None = none locally). Defaults to the same-id local record's revision.
    pub local_segment_revision: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PurgeSegments {
    pub article_id: String,
    pub revision: i64,
}

#[derive(Debug, Clone)]
pub struct MergeDecision {
    pub outcome: MergeOutcome,
    /// New local state to write; None for `Ignore`. Never carries an opId.
    pub record: Option<LocalRecord>,
    /// `Merged`: the engine must assign a new local HLC before pushing.
    pub retick: bool,
    /// Segment revision increased: drop local live segments of this article with a lower revision.
    pub purge_segments_below: Option<PurgeSegments>,
}

const SEGMENT_FILL_FIELDS: [&str; 3] = ["translation", "readingText", "explanation"];

pub fn segment_revision_of(payload: Option<&JsonObject>) -> i64 {
    match payload.and_then(|p| p.get("segmentationRevision")) {
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f as i64))
            .unwrap_or(0),
        _ => 0,
    }
}

fn is_empty(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        _ => false,
    }
}

/// Fill `target`'s empty translation/readingText/explanation from `source`.
pub fn fill_segment_fields(target: &JsonObject, source: Option<&JsonObject>) -> (JsonObject, bool) {
    let mut out = target.clone();
    let Some(source) = source else {
        return (out, false);
    };
    let mut changed = false;
    for key in SEGMENT_FILL_FIELDS {
        if is_empty(out.get(key)) && !is_empty(source.get(key)) {
            out.insert(
                key.to_string(),
                source.get(key).cloned().unwrap_or(Value::Null),
            );
            changed = true;
        }
    }
    (out, changed)
}

pub fn from_remote(remote: &SyncRecord) -> LocalRecord {
    LocalRecord {
        record_type: remote.record_type.clone(),
        id: canonical_id(&remote.id),
        rev: remote.rev,
        hlc: remote.hlc.clone(),
        deleted: remote.deleted,
        payload: if remote.deleted {
            None
        } else {
            remote.payload.clone()
        },
        dirty: false,
        op_id: None,
    }
}

fn strip(local: &LocalRecord) -> LocalRecord {
    LocalRecord {
        op_id: None,
        ..local.clone()
    }
}

fn decision(outcome: MergeOutcome, record: Option<LocalRecord>) -> MergeDecision {
    MergeDecision {
        outcome,
        record,
        retick: false,
        purge_segments_below: None,
    }
}

/// Decide how a pulled (or conflict `current`) record combines with the local copy.
pub fn merge_remote(
    local: Option<&LocalRecord>,
    remote: &SyncRecord,
    ctx: &MergeContext,
) -> MergeDecision {
    let incoming = from_remote(remote);

    // §6: ReviewEvent is append-only. An existing id is never modified or deleted.
    if remote.record_type == "ReviewEvent" {
        if remote.deleted {
            return decision(MergeOutcome::Ignore, None);
        }
        if let Some(local) = local.filter(|l| !l.deleted) {
            let mut rec = strip(local);
            rec.rev = local.rev.max(remote.rev);
            rec.dirty = false;
            return decision(MergeOutcome::Acknowledge, Some(rec));
        }
        return decision(MergeOutcome::Remote, Some(incoming));
    }

    // A server record only ever moves forward; a lower rev than we already know is stale.
    if let Some(local) = local {
        if remote.rev < local.rev {
            return decision(MergeOutcome::Ignore, None);
        }
    }

    // §4.3 Segment revision gate (live remote segments only; tombstones use plain LWW).
    let mut fill_segment = false;
    if remote.record_type == "Segment" && !remote.deleted {
        let remote_revision = segment_revision_of(remote.payload.as_ref());
        let local_revision = ctx.local_segment_revision.or_else(|| {
            local
                .filter(|l| !l.deleted)
                .map(|l| segment_revision_of(l.payload.as_ref()))
        });
        if let Some(local_revision) = local_revision {
            if remote_revision < local_revision {
                return decision(MergeOutcome::Ignore, None);
            }
            if remote_revision > local_revision {
                let article_id = remote
                    .payload
                    .as_ref()
                    .and_then(|p| p.get("articleId"))
                    .and_then(Value::as_str)
                    .map(canonical_id);
                let mut d = decision(MergeOutcome::Remote, Some(incoming));
                d.purge_segments_below = article_id.map(|article_id| PurgeSegments {
                    article_id,
                    revision: remote_revision,
                });
                return d;
            }
            fill_segment = local.map(|l| !l.deleted).unwrap_or(false);
        }
    }

    let Some(local) = local else {
        return decision(MergeOutcome::Remote, Some(incoming));
    };

    match compare_hlc(&remote.hlc, &local.hlc) {
        Ordering::Equal => {
            // Same write (HLC embeds the node id): our own push echoed back, or already applied.
            let mut rec = strip(local);
            rec.rev = local.rev.max(remote.rev);
            rec.dirty = false;
            decision(MergeOutcome::Acknowledge, Some(rec))
        }
        Ordering::Greater => {
            if fill_segment {
                if let Some(payload) = incoming.payload.as_ref() {
                    let (filled, changed) = fill_segment_fields(payload, local.payload.as_ref());
                    if changed {
                        let mut rec = incoming.clone();
                        rec.payload = Some(filled);
                        rec.dirty = true;
                        let mut d = decision(MergeOutcome::Merged, Some(rec));
                        d.retick = true;
                        return d;
                    }
                }
            }
            decision(MergeOutcome::Remote, Some(incoming))
        }
        Ordering::Less => {
            // Local is newer by HLC: keep it and (re)push on top of the server's current rev.
            let mut payload = local.payload.clone();
            if fill_segment {
                if let Some(lp) = local.payload.as_ref() {
                    payload = Some(fill_segment_fields(lp, incoming.payload.as_ref()).0);
                }
            }
            let mut rec = strip(local);
            rec.payload = payload;
            rec.rev = remote.rev;
            rec.dirty = true;
            decision(MergeOutcome::Local, Some(rec))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    const FIXTURE: &str = include_str!("../../../../docs/specs/fixtures/sync/merge-cases.json");

    #[derive(Deserialize)]
    struct FixtureLocal {
        #[serde(rename = "type")]
        record_type: String,
        id: String,
        rev: i64,
        hlc: String,
        deleted: bool,
        payload: Option<JsonObject>,
        dirty: bool,
    }

    impl FixtureLocal {
        fn into_local(self) -> LocalRecord {
            LocalRecord {
                record_type: self.record_type,
                id: self.id,
                rev: self.rev,
                hlc: self.hlc,
                deleted: self.deleted,
                payload: self.payload,
                dirty: self.dirty,
                op_id: None,
            }
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Ctx {
        local_segment_revision: Option<i64>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Purge {
        article_id: String,
        revision: i64,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Expected {
        outcome: String,
        record: Option<FixtureLocal>,
        retick: bool,
        purge_segments_below: Option<Purge>,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        local: Option<FixtureLocal>,
        remote: SyncRecord,
        context: Option<Ctx>,
        expected: Expected,
    }

    #[derive(Deserialize)]
    struct Fixture {
        cases: Vec<Case>,
    }

    #[test]
    fn passes_merge_contract_fixture() {
        let fixture: Fixture = serde_json::from_str(FIXTURE).unwrap();
        assert!(fixture.cases.len() >= 20);
        for case in fixture.cases {
            let local = case.local.map(FixtureLocal::into_local);
            let ctx = MergeContext {
                local_segment_revision: case.context.and_then(|c| c.local_segment_revision),
            };
            let got = merge_remote(local.as_ref(), &case.remote, &ctx);
            assert_eq!(got.outcome.as_str(), case.expected.outcome, "{}", case.name);
            assert_eq!(got.retick, case.expected.retick, "{} retick", case.name);
            let expected_record = case.expected.record.map(FixtureLocal::into_local);
            assert_eq!(got.record, expected_record, "{} record", case.name);
            let expected_purge = case.expected.purge_segments_below.map(|p| PurgeSegments {
                article_id: p.article_id,
                revision: p.revision,
            });
            assert_eq!(
                got.purge_segments_below, expected_purge,
                "{} purge",
                case.name
            );
        }
    }
}
