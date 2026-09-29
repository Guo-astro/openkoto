//! OpenKoto cloud account + sync for the desktop app (design doc §4.3, §9.2; auth-spec §3.1).
//!
//! - [`auth`]: PKCE authorization-code login via the system browser; the callback arrives
//!   through the `openkoto://auth/callback` deep link or a one-shot loopback listener
//!   ([`loopback`]).
//! - [`api`]: HTTP client with bearer auth and single-flight refresh; implements the sync
//!   [`crate::sync::engine::Transport`].
//! - [`secrets`]: keychain storage for session tokens and model API keys.
//! - [`scheduler`]: sync on start, 3 s after local writes, every 5 min, and on demand.
//! - [`commands`]: the Tauri commands used by the Settings → Account & Sync section.

pub mod api;
pub mod auth;
pub mod book_files;
pub mod commands;
pub mod loopback;
pub mod realtime;
pub mod scheduler;
pub mod secrets;
pub mod token_file;

use crate::sync::engine::SyncReport;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

pub const DEFAULT_API_BASE: &str = "https://openkoto.com";
pub const API_BASE_ENV: &str = "OPENKOTO_API_BASE";
pub const DEEP_LINK_SCHEME: &str = "openkoto";
pub const DEEP_LINK_CALLBACK: &str = "openkoto://auth/callback";

/// Events emitted to the frontend.
pub const EVENT_AUTH_CHANGED: &str = "cloud://auth-changed";
pub const EVENT_SYNC_STATUS: &str = "cloud://sync-status";
pub const EVENT_DATA_CHANGED: &str = "cloud://data-changed";

/// API origin: `OPENKOTO_API_BASE` > `config.cloud_api_base` > https://openkoto.com.
pub fn resolve_base_url(config_value: Option<&str>) -> String {
    let env = std::env::var(API_BASE_ENV).ok();
    let chosen = env
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| config_value.map(str::trim).filter(|s| !s.is_empty()))
        .unwrap_or(DEFAULT_API_BASE);
    chosen.trim_end_matches('/').to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUser {
    pub id: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Epoch ms after which the access token is considered expired.
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub user: Option<TokenUser>,
}

/// Refresh a minute before expiry.
pub const EXPIRY_SKEW_MS: i64 = 60_000;

impl Tokens {
    pub fn needs_refresh(&self, now_ms: i64) -> bool {
        self.refresh_token.is_some()
            && self
                .expires_at
                .map(|t| now_ms >= t - EXPIRY_SKEW_MS)
                .unwrap_or(false)
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub signed_in: bool,
    pub syncing: bool,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    pub pending_changes: i64,
    pub last_report: Option<SyncReport>,
    pub base_url: String,
    pub user: Option<TokenUser>,
    /// "keychain" | "file" (encrypted file fallback, shown as a warning).
    pub token_storage: String,
    /// Signed in to a different account than last time: waiting for the user to choose
    /// whether local data is uploaded (never done silently).
    pub pending_account_switch: Option<serde_json::Value>,
}

/// Process-wide cloud state.
pub struct CloudState {
    tokens: Mutex<Option<Option<Tokens>>>,
    pub refresh_lock: tokio::sync::Mutex<()>,
    pub sync_lock: tokio::sync::Mutex<()>,
    pub status: Mutex<SyncStatus>,
    pub pending_login: Mutex<Option<auth::PendingLogin>>,
    pub token_store: Box<dyn TokenStore>,
    pub http: reqwest::Client,
}

/// Session token persistence.
pub trait TokenStore: Send + Sync {
    fn load(&self) -> Result<Option<Tokens>, String>;
    fn save(&self, tokens: Option<&Tokens>) -> Result<(), String>;
}

const TOKENS_ACCOUNT: &str = "cloud-session";

/// Where the session tokens currently live.
pub fn token_storage_kind() -> &'static str {
    if TOKEN_FILE_IN_USE.load(std::sync::atomic::Ordering::SeqCst) {
        "file"
    } else {
        "keychain"
    }
}

static TOKEN_FILE_IN_USE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn data_dir_cell() -> &'static OnceLock<std::path::PathBuf> {
    static DIR: OnceLock<std::path::PathBuf> = OnceLock::new();
    &DIR
}

/// App data dir, set once at startup (used by the token-file fallback).
pub fn set_data_dir(dir: std::path::PathBuf) {
    let _ = data_dir_cell().set(dir);
}

/// Keychain entry `openkoto-desktop / cloud-session` (JSON). When the keychain is unusable
/// (e.g. Linux without a Secret Service) it falls back to an encrypted 0600 file
/// ([`token_file`]) and the UI shows a warning.
pub struct KeyringTokenStore;

impl KeyringTokenStore {
    fn file() -> Option<token_file::TokenFile> {
        data_dir_cell().get().map(|d| token_file::TokenFile::new(d))
    }
}

impl TokenStore for KeyringTokenStore {
    fn load(&self) -> Result<Option<Tokens>, String> {
        use secrets::SecretStore;
        let from_keychain = secrets::KeyringStore.get(TOKENS_ACCOUNT);
        if let Ok(Some(json)) = &from_keychain {
            return Ok(serde_json::from_str(json).ok());
        }
        if let Some(file) = Self::file() {
            if let Ok(Some(json)) = file.load() {
                TOKEN_FILE_IN_USE.store(true, std::sync::atomic::Ordering::SeqCst);
                return Ok(serde_json::from_str(&json).ok());
            }
        }
        from_keychain.map(|_| None)
    }

    fn save(&self, tokens: Option<&Tokens>) -> Result<(), String> {
        use secrets::SecretStore;
        match tokens {
            Some(t) => {
                let json = serde_json::to_string(t).map_err(|e| e.to_string())?;
                match secrets::KeyringStore.set(TOKENS_ACCOUNT, &json) {
                    Ok(()) => {
                        if let Some(file) = Self::file() {
                            file.delete();
                        }
                        TOKEN_FILE_IN_USE.store(false, std::sync::atomic::Ordering::SeqCst);
                        Ok(())
                    }
                    Err(keychain_error) => {
                        let file = Self::file().ok_or(keychain_error.clone())?;
                        file.save(&json)
                            .map_err(|e| format!("{keychain_error}; file fallback: {e}"))?;
                        TOKEN_FILE_IN_USE.store(true, std::sync::atomic::Ordering::SeqCst);
                        Ok(())
                    }
                }
            }
            None => {
                if let Some(file) = Self::file() {
                    file.delete();
                }
                TOKEN_FILE_IN_USE.store(false, std::sync::atomic::Ordering::SeqCst);
                let _ = secrets::KeyringStore.delete(TOKENS_ACCOUNT);
                Ok(())
            }
        }
    }
}

/// In-memory token store (tests).
#[derive(Default)]
pub struct MemoryTokenStore(pub Mutex<Option<Tokens>>);

impl TokenStore for MemoryTokenStore {
    fn load(&self) -> Result<Option<Tokens>, String> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn save(&self, tokens: Option<&Tokens>) -> Result<(), String> {
        *self.0.lock().unwrap() = tokens.cloned();
        Ok(())
    }
}

impl CloudState {
    pub fn new(token_store: Box<dyn TokenStore>) -> Self {
        Self {
            tokens: Mutex::new(None),
            refresh_lock: tokio::sync::Mutex::new(()),
            sync_lock: tokio::sync::Mutex::new(()),
            status: Mutex::new(SyncStatus::default()),
            pending_login: Mutex::new(None),
            token_store,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .connect_timeout(std::time::Duration::from_secs(15))
                .build()
                .unwrap_or_default(),
        }
    }

    /// Current tokens (loaded from the keychain on first use).
    pub fn tokens(&self) -> Option<Tokens> {
        let mut guard = self.tokens.lock().unwrap();
        if guard.is_none() {
            *guard = Some(self.token_store.load().ok().flatten());
        }
        guard.clone().flatten()
    }

    pub fn set_tokens(&self, tokens: Option<Tokens>) -> Result<(), String> {
        let saved = self.token_store.save(tokens.as_ref());
        *self.tokens.lock().unwrap() = Some(tokens);
        saved
    }

    pub fn signed_in(&self) -> bool {
        self.tokens().is_some()
    }
}

pub fn state() -> &'static CloudState {
    static STATE: OnceLock<CloudState> = OnceLock::new();
    STATE.get_or_init(|| CloudState::new(Box::new(KeyringTokenStore)))
}

/// `SyncEngine` (SRS spec §8) backed by the cloud engine. Blocking: must not be called from
/// inside the async runtime.
pub struct CloudSyncEngine {
    pub app: tauri::AppHandle,
}

impl crate::sync::SyncEngine for CloudSyncEngine {
    fn push(&self) -> Result<(), String> {
        tauri::async_runtime::block_on(scheduler::run_sync(&self.app)).map(|_| ())
    }
    fn pull(&self) -> Result<(), String> {
        tauri::async_runtime::block_on(scheduler::run_sync(&self.app)).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_resolution() {
        // The env var is not set in tests unless a developer exports it.
        if std::env::var(API_BASE_ENV).is_err() {
            assert_eq!(resolve_base_url(None), DEFAULT_API_BASE);
            assert_eq!(
                resolve_base_url(Some("http://localhost:8787/")),
                "http://localhost:8787"
            );
            assert_eq!(resolve_base_url(Some("  ")), DEFAULT_API_BASE);
        }
    }

    #[test]
    fn token_expiry() {
        let t = Tokens {
            access_token: "a".into(),
            refresh_token: Some("okr_x".into()),
            expires_at: Some(1_000_000),
            device_id: None,
            user: None,
        };
        assert!(!t.needs_refresh(900_000));
        assert!(t.needs_refresh(950_000));
        let api_key = Tokens {
            refresh_token: None,
            ..t.clone()
        };
        assert!(!api_key.needs_refresh(2_000_000));
    }

    #[test]
    fn state_caches_tokens() {
        let store = MemoryTokenStore::default();
        let state = CloudState::new(Box::new(store));
        assert!(!state.signed_in());
        state
            .set_tokens(Some(Tokens {
                access_token: "a".into(),
                refresh_token: None,
                expires_at: None,
                device_id: None,
                user: None,
            }))
            .unwrap();
        assert!(state.signed_in());
        state.set_tokens(None).unwrap();
        assert!(!state.signed_in());
    }
}
