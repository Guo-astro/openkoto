//! OpenKoto cloud sync (docs/specs/sync-protocol-spec.md).
//!
//! - [`hlc`] / [`merge`] / [`replay`]: pure protocol rules, contract-tested against
//!   `docs/specs/fixtures/sync/*.json`.
//! - [`store`]: `sync_record` / `sync_meta` in SQLite; [`payload`]: desktop ↔ wire JSON.
//! - [`engine`]: the pull → merge → push → replay cycle over a [`engine::Transport`].
//! - Scheduling and auth live in [`crate::cloud`].

pub mod apply;
pub mod dedupe;
pub mod engine;
pub mod hlc;
pub mod merge;
pub mod payload;
pub mod protocol;
pub mod replay;
pub mod store;

use std::sync::OnceLock;
use tokio::sync::Notify;

/// Sync placeholder interface from the SRS spec §8. [`NoopSyncEngine`] is the offline default;
/// [`crate::cloud::CloudSyncEngine`] is the OpenKoto cloud implementation (blocking wrappers
/// around the async engine — do not call from inside the async runtime).
pub trait SyncEngine {
    fn push(&self) -> Result<(), String>;
    fn pull(&self) -> Result<(), String>;
}

/// Does nothing (not signed in / open-source default).
pub struct NoopSyncEngine;

impl SyncEngine for NoopSyncEngine {
    fn push(&self) -> Result<(), String> {
        Ok(())
    }
    fn pull(&self) -> Result<(), String> {
        Ok(())
    }
}

fn local_change_notify() -> &'static Notify {
    static NOTIFY: OnceLock<Notify> = OnceLock::new();
    NOTIFY.get_or_init(Notify::new)
}

/// Called after every local write; the scheduler syncs 3 s after the last one.
pub fn notify_local_change() {
    local_change_notify().notify_one();
}

/// Resolves on the next [`notify_local_change`] (a stored permit resolves immediately).
pub async fn local_change() {
    local_change_notify().notified().await;
}
