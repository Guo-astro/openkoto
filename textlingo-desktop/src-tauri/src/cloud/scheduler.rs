//! When to sync (sync-protocol-spec §8): app start, 3 s after the last local write, every
//! 5 minutes, and on demand. Transient failures back off exponentially (1 s … 5 min);
//! `429` honours `Retry-After`.

use super::api::ApiClient;
use super::{
    resolve_base_url, state, SyncStatus, EVENT_AUTH_CHANGED, EVENT_DATA_CHANGED, EVENT_SYNC_STATUS,
};
use crate::sync::engine::{EngineOptions, HttpSyncEngine, SyncError, SyncReport};
use crate::sync::replay::{ReplayOptions, ReplayTimeZone};
use crate::sync::store::{
    self, META_ACCOUNT_USER, META_CURSOR, META_LAST_ERROR, META_LAST_SYNC_AT,
};
use serde_json::json;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const PERIODIC: Duration = Duration::from_secs(5 * 60);
pub const DEBOUNCE: Duration = Duration::from_secs(3);
const MAX_BACKOFF: Duration = Duration::from_secs(5 * 60);

/// Record types the desktop projects into its own tables; anything else in `sync_record`
/// belongs to the previous account and is dropped on an account switch.
const DESKTOP_TYPES: &str =
    "'Vocabulary','WordPack','WordPackMembership','ReviewEvent','Article','Segment','BookMark'";

pub fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

pub fn api_base(app: &AppHandle) -> String {
    let config = crate::storage::load_config(app).ok().flatten();
    resolve_base_url(config.as_ref().and_then(|c| c.cloud_api_base.as_deref()))
}

/// Status snapshot for the UI.
pub fn current_status(app: &AppHandle) -> SyncStatus {
    let st = state();
    let tokens = st.tokens();
    let mut status = st.status.lock().unwrap().clone();
    status.signed_in = tokens.is_some();
    status.user = tokens.and_then(|t| t.user);
    status.base_url = api_base(app);
    if let Ok(db) = crate::storage::database(app) {
        let _ = db.read(|c| {
            status.pending_changes = store::dirty_count(c)?;
            status.last_sync_at = store::get_meta(c, META_LAST_SYNC_AT)?;
            status.last_error = store::get_meta(c, META_LAST_ERROR)?;
            Ok(())
        });
    }
    status
}

pub fn emit_status(app: &AppHandle) {
    let _ = app.emit(EVENT_SYNC_STATUS, current_status(app));
}

/// First sign-in on this device, or a different account than last time: start the account's
/// sync from scratch (full pull, then everything local is pushed — spec §9).
pub fn prepare_for_account(app: &AppHandle, user_id: &str) -> Result<(), String> {
    let db = crate::storage::database(app)?;
    db.write(|tx| {
        let previous = store::get_meta(tx, META_ACCOUNT_USER)?;
        if previous.as_deref() == Some(user_id) {
            return Ok(());
        }
        store::set_meta(tx, META_CURSOR, None)?;
        tx.execute("delete from sync_record where deleted = 1", [])
            .map_err(crate::db::sql_err)?;
        tx.execute(
            &format!("delete from sync_record where type not in ({DESKTOP_TYPES})"),
            [],
        )
        .map_err(crate::db::sql_err)?;
        tx.execute(
            "update sync_record set rev = 0, dirty = 1, op_id = NULL",
            [],
        )
        .map_err(crate::db::sql_err)?;
        store::set_meta(tx, META_ACCOUNT_USER, Some(user_id))?;
        store::set_meta(tx, META_LAST_ERROR, None)?;
        Ok(())
    })
}

async fn run_sync_inner(app: &AppHandle) -> Result<SyncReport, SyncError> {
    let st = state();
    let Some(tokens) = st.tokens() else {
        return Err(SyncError::Local("NOT_SIGNED_IN".into()));
    };
    let _guard = st.sync_lock.lock().await;
    st.status.lock().unwrap().syncing = true;
    emit_status(app);

    let config = crate::storage::load_config(app)
        .ok()
        .flatten()
        .unwrap_or_default();
    let api = ApiClient::new(
        st,
        resolve_base_url(config.cloud_api_base.as_deref()),
        &app_version(app),
    );
    let db = crate::storage::database(app)?;
    let engine = HttpSyncEngine::new(
        db.clone(),
        &api,
        EngineOptions {
            device_id: tokens.device_id.clone(),
            replay: ReplayOptions {
                desired_retention: config.srs_desired_retention,
                time_zone: ReplayTimeZone::Local,
            },
            ..EngineOptions::default()
        },
    );
    let result = engine.sync().await;

    let now = chrono::Utc::now().to_rfc3339();
    let _ = db.write(|tx| {
        match &result {
            Ok(_) => {
                store::set_meta(tx, META_LAST_SYNC_AT, Some(&now))?;
                store::set_meta(tx, META_LAST_ERROR, None)?;
            }
            Err(e) => store::set_meta(tx, META_LAST_ERROR, Some(&e.to_string()))?,
        }
        Ok(())
    });
    {
        let mut status = st.status.lock().unwrap();
        status.syncing = false;
        if let Ok(report) = &result {
            status.last_report = Some(report.clone());
        }
    }
    if let Ok(report) = &result {
        if report.applied > 0 || !report.replayed_cards.is_empty() {
            let _ = app.emit(EVENT_DATA_CHANGED, json!({ "applied": report.applied }));
        }
    }
    if let Err(SyncError::Transport(e)) = &result {
        if e.status == Some(401) && !st.signed_in() {
            let _ = app.emit(
                EVENT_AUTH_CHANGED,
                json!({ "signedIn": false, "error": e.message }),
            );
        }
    }
    emit_status(app);
    result
}

/// One sync cycle now (serialised with any running cycle).
pub async fn run_sync(app: &AppHandle) -> Result<SyncReport, String> {
    run_sync_inner(app).await.map_err(|e| e.to_string())
}

fn next_backoff(error: &SyncError, previous: Option<Duration>) -> Option<Duration> {
    match error {
        SyncError::Transport(e) => match e.status {
            Some(429) => {
                Some(Duration::from_secs(e.retry_after_secs.unwrap_or(60)).min(MAX_BACKOFF))
            }
            None | Some(500..=599) => Some(
                previous
                    .map(|d| (d * 2).min(MAX_BACKOFF))
                    .unwrap_or(Duration::from_secs(1)),
            ),
            _ => None,
        },
        SyncError::Local(_) => None,
    }
}

async fn attempt(app: &AppHandle, backoff: &mut Option<Duration>) {
    if !state().signed_in() {
        *backoff = None;
        return;
    }
    match run_sync_inner(app).await {
        Ok(_) => *backoff = None,
        Err(e) => {
            *backoff = next_backoff(&e, *backoff);
            eprintln!("[cloud-sync] {e}");
        }
    }
}

fn has_dirty(app: &AppHandle) -> bool {
    crate::storage::database(app)
        .and_then(|db| db.read(store::dirty_count))
        .map(|n| n > 0)
        .unwrap_or(false)
}

/// Start the background scheduler (call once after the database is ready).
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut backoff: Option<Duration> = None;
        attempt(&app, &mut backoff).await; // app start
        loop {
            let wait = backoff.unwrap_or(PERIODIC);
            let local = tokio::select! {
                _ = crate::sync::local_change() => true,
                _ = tokio::time::sleep(wait) => false,
            };
            if local {
                // Debounce: sync 3 s after the last write.
                loop {
                    tokio::select! {
                        _ = crate::sync::local_change() => continue,
                        _ = tokio::time::sleep(DEBOUNCE) => break,
                    }
                }
                emit_status(&app);
                if !has_dirty(&app) {
                    continue;
                }
            }
            attempt(&app, &mut backoff).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::engine::TransportError;

    #[test]
    fn backoff_policy() {
        let net = SyncError::Transport(TransportError::new(None, "NETWORK", "down"));
        assert_eq!(next_backoff(&net, None), Some(Duration::from_secs(1)));
        assert_eq!(
            next_backoff(&net, Some(Duration::from_secs(4))),
            Some(Duration::from_secs(8))
        );
        assert_eq!(
            next_backoff(&net, Some(Duration::from_secs(200))),
            Some(MAX_BACKOFF)
        );
        let mut limited = TransportError::new(Some(429), "RATE_LIMITED", "slow");
        limited.retry_after_secs = Some(30);
        assert_eq!(
            next_backoff(&SyncError::Transport(limited), None),
            Some(Duration::from_secs(30))
        );
        let auth = SyncError::Transport(TransportError::new(Some(401), "UNAUTHENTICATED", "x"));
        assert_eq!(next_backoff(&auth, Some(Duration::from_secs(4))), None);
    }
}
