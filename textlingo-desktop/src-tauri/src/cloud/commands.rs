//! Tauri commands for Settings → Account & Sync.

use super::api::ApiClient;
use super::auth::{self, PendingLogin};
use super::loopback::{LoopbackListener, CALLBACK_TIMEOUT};
use super::scheduler::{self, api_base, app_version, current_status};
use super::{state, SyncStatus, DEEP_LINK_CALLBACK, EVENT_AUTH_CHANGED};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    pub authorize_url: String,
    pub redirect_uri: String,
    /// "deep-link" | "loopback"
    pub method: String,
}

/// Can the `openkoto://` scheme reach this process? Override with
/// `OPENKOTO_AUTH_CALLBACK=loopback|deeplink`.
fn deep_link_available(_app: &AppHandle) -> bool {
    match std::env::var("OPENKOTO_AUTH_CALLBACK").as_deref() {
        Ok("loopback") => return false,
        Ok("deeplink") | Ok("deep-link") => return true,
        _ => {}
    }
    #[cfg(target_os = "macos")]
    {
        // The scheme is registered through the bundle's Info.plist; a bare dev binary has none.
        std::env::current_exe()
            .map(|p| p.to_string_lossy().contains(".app/Contents/MacOS"))
            .unwrap_or(false)
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        _app.deep_link()
            .is_registered(super::DEEP_LINK_SCHEME)
            .unwrap_or(false)
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        false
    }
}

fn open_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Failed to open the browser: {e}"))
}

/// Start sign-in: opens the system browser at `{base}/auth/native/authorize` (PKCE). The
/// result arrives later as the `cloud://auth-changed` event.
#[tauri::command]
pub async fn cloud_login_start(app: AppHandle) -> Result<LoginStart, String> {
    let st = state();
    let base = api_base(&app);
    let pkce = auth::new_pkce();
    let (tx, rx) = oneshot::channel::<String>();

    let use_deep_link = deep_link_available(&app);
    let (redirect_uri, sender, cancel) = if use_deep_link {
        (DEEP_LINK_CALLBACK.to_string(), Some(tx), None)
    } else {
        let listener = LoopbackListener::bind()?;
        let uri = listener.redirect_uri();
        let cancel = listener.cancel_handle();
        std::thread::spawn(move || {
            if let Ok(url) = listener.wait_for_callback(CALLBACK_TIMEOUT) {
                let _ = tx.send(url);
            }
        });
        (uri, None, Some(cancel))
    };

    // Replaces (and cancels) any earlier attempt.
    *st.pending_login.lock().unwrap() = Some(PendingLogin {
        pkce: pkce.clone(),
        redirect_uri: redirect_uri.clone(),
        sender,
        loopback_cancel: cancel,
    });

    let authorize_url = auth::authorize_url(&base, &redirect_uri, &pkce);
    if let Err(e) = open_browser(&app, &authorize_url) {
        st.pending_login.lock().unwrap().take();
        return Err(e);
    }

    let task_app = app.clone();
    let task_redirect = redirect_uri.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = tokio::time::timeout(CALLBACK_TIMEOUT, rx).await;
        let still_current = |s: &str| {
            state()
                .pending_login
                .lock()
                .unwrap()
                .as_ref()
                .map(|p| p.pkce.state == s)
                .unwrap_or(false)
        };
        let callback = match outcome {
            Ok(Ok(url)) => url,
            Ok(Err(_)) => return, // replaced by a newer attempt or cancelled
            Err(_) => {
                if still_current(&pkce.state) {
                    state().pending_login.lock().unwrap().take();
                    let _ = task_app.emit(
                        EVENT_AUTH_CHANGED,
                        json!({ "signedIn": false, "error": "Timed out waiting for the browser sign-in" }),
                    );
                }
                return;
            }
        };
        if !still_current(&pkce.state) {
            return;
        }
        state().pending_login.lock().unwrap().take();

        let version = app_version(&task_app);
        let api = ApiClient::new(state(), api_base(&task_app), &version);
        let result = auth::complete_login(&api, &callback, &pkce, &task_redirect, &version).await;
        match result {
            Ok(tokens) => {
                let user = tokens.user.clone();
                if let Err(e) = state().set_tokens(Some(tokens)) {
                    let _ = task_app.emit(
                        EVENT_AUTH_CHANGED,
                        json!({ "signedIn": false, "error": format!("Could not save the session to the keychain: {e}") }),
                    );
                    return;
                }
                if let Some(u) = &user {
                    if let Err(e) = scheduler::prepare_for_account(&task_app, &u.id) {
                        eprintln!("[cloud] prepare_for_account: {e}");
                    }
                }
                let _ = task_app.emit(
                    EVENT_AUTH_CHANGED,
                    json!({ "signedIn": true, "user": user }),
                );
                let _ = scheduler::run_sync(&task_app).await;
            }
            Err(e) => {
                let _ = task_app.emit(EVENT_AUTH_CHANGED, json!({ "signedIn": false, "error": e }));
            }
        }
    });

    Ok(LoginStart {
        authorize_url,
        redirect_uri,
        method: if use_deep_link {
            "deep-link"
        } else {
            "loopback"
        }
        .to_string(),
    })
}

/// Abandon a pending browser sign-in.
#[tauri::command]
pub async fn cloud_login_cancel() -> Result<(), String> {
    state().pending_login.lock().unwrap().take();
    Ok(())
}

/// Sign out: revoke this device server-side (best effort) and forget the tokens. Local data
/// and sync bookkeeping stay (signing in again with the same account resumes).
#[tauri::command]
pub async fn cloud_logout(app: AppHandle) -> Result<(), String> {
    let st = state();
    if let Some(tokens) = st.tokens() {
        if let Some(refresh) = tokens.refresh_token.as_deref() {
            let version = app_version(&app);
            let api = ApiClient::new(st, api_base(&app), &version);
            let _ = api.logout(refresh).await;
        }
    }
    st.set_tokens(None)?;
    {
        let mut status = st.status.lock().unwrap();
        status.last_report = None;
    }
    let _ = app.emit(EVENT_AUTH_CHANGED, json!({ "signedIn": false }));
    scheduler::emit_status(&app);
    Ok(())
}

/// `GET /api/v1/me` (user, plan, entitlements, credits). Offline: the cached user.
#[tauri::command]
pub async fn cloud_account(app: AppHandle) -> Result<Value, String> {
    let st = state();
    let Some(tokens) = st.tokens() else {
        return Ok(json!({ "signedIn": false }));
    };
    let version = app_version(&app);
    let api = ApiClient::new(st, api_base(&app), &version);
    match api.me().await {
        Ok(mut me) => {
            if let Some(obj) = me.as_object_mut() {
                obj.insert("signedIn".into(), json!(true));
                obj.insert("offline".into(), json!(false));
            }
            Ok(me)
        }
        Err(e) if e.status == Some(401) && !st.signed_in() => {
            let _ = app.emit(
                EVENT_AUTH_CHANGED,
                json!({ "signedIn": false, "error": e.message }),
            );
            Ok(json!({ "signedIn": false }))
        }
        Err(e) => Ok(json!({
            "signedIn": true,
            "offline": true,
            "error": e.to_string(),
            "user": tokens.user,
            "plan": tokens.user.as_ref().and_then(|u| u.plan.clone()),
        })),
    }
}

/// Run one sync cycle now and return the resulting status.
#[tauri::command]
pub async fn cloud_sync_now(app: AppHandle) -> Result<SyncStatus, String> {
    scheduler::run_sync(&app).await?;
    Ok(current_status(&app))
}

#[tauri::command]
pub async fn cloud_sync_status(app: AppHandle) -> Result<SyncStatus, String> {
    Ok(current_status(&app))
}
