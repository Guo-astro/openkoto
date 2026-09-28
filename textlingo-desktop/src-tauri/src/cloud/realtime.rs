//! Realtime change notifications: `GET {base}/api/v1/sync/ws` (bearer auth). On
//! `{"type":"changed"}` a sync runs (debounced 300 ms). Sends `ping` every 30 s and
//! reconnects with exponential backoff (1 s … 5 min).

use super::api::ApiClient;
use super::scheduler::{self, api_base, app_version};
use super::state;
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

pub const PING_INTERVAL: Duration = Duration::from_secs(30);
pub const CHANGE_DEBOUNCE: Duration = Duration::from_millis(300);
const MAX_BACKOFF: Duration = Duration::from_secs(5 * 60);
/// While signed out / waiting for the account choice, re-check this often.
const IDLE_CHECK: Duration = Duration::from_secs(30);

fn reconnect_notify() -> &'static Notify {
    static N: std::sync::OnceLock<Notify> = std::sync::OnceLock::new();
    N.get_or_init(Notify::new)
}

/// Drop the current connection and reconnect (sign-in / sign-out / account change).
pub fn reconnect() {
    reconnect_notify().notify_one();
}

/// `https://host` → `wss://host/api/v1/sync/ws`.
pub fn ws_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_string()
    };
    format!("{ws}/api/v1/sync/ws")
}

/// Is this server message a change notification?
pub fn is_changed_message(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| {
            v.get("type")
                .and_then(|t| t.as_str())
                .map(|t| t == "changed")
        })
        .unwrap_or(false)
}

fn next_backoff(previous: Option<Duration>) -> Duration {
    previous
        .map(|d| (d * 2).min(MAX_BACKOFF))
        .unwrap_or(Duration::from_secs(1))
}

fn ready(app: &AppHandle) -> bool {
    state().signed_in()
        && crate::storage::database(app)
            .map(|db| scheduler::pending_switch(&db).is_none())
            .unwrap_or(false)
}

/// One connection; returns Ok(()) when it ended normally (or was asked to reconnect).
async fn run_connection(app: &AppHandle) -> Result<(), String> {
    let version = app_version(app);
    let api = ApiClient::new(state(), api_base(app), &version);
    let tokens = api.access_tokens().await.map_err(|e| e.to_string())?;
    let mut request = ws_url(&api.base_url)
        .into_client_request()
        .map_err(|e| e.to_string())?;
    let headers = request.headers_mut();
    headers.insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", tokens.access_token))
            .map_err(|e| e.to_string())?,
    );
    headers.insert("X-OpenKoto-Protocol", HeaderValue::from_static("1"));
    if let Ok(v) = HeaderValue::from_str(&api.client_name) {
        headers.insert("X-OpenKoto-Client", v);
    }
    let (ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| e.to_string())?;
    let (mut write, mut read) = ws.split();
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await; // first tick is immediate
    let mut pending_change: Option<tokio::time::Instant> = None;

    loop {
        let debounce = async {
            match pending_change {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            msg = read.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    if is_changed_message(&text) {
                        pending_change = Some(tokio::time::Instant::now() + CHANGE_DEBOUNCE);
                    }
                }
                Some(Ok(Message::Ping(payload))) => {
                    let _ = write.send(Message::Pong(payload)).await;
                }
                Some(Ok(Message::Close(_))) | None => return Ok(()),
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(e.to_string()),
            },
            _ = debounce => {
                pending_change = None;
                scheduler::notify_remote_change();
            }
            _ = ping.tick() => {
                if !ready(app) {
                    let _ = write.send(Message::Close(None)).await;
                    return Ok(());
                }
                write.send(Message::Text("ping".into())).await.map_err(|e| e.to_string())?;
            }
            _ = reconnect_notify().notified() => {
                let _ = write.send(Message::Close(None)).await;
                return Ok(());
            }
        }
    }
}

/// Background task: keep one connection while signed in.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut backoff: Option<Duration> = None;
        loop {
            if !ready(&app) {
                backoff = None;
                tokio::select! {
                    _ = reconnect_notify().notified() => {}
                    _ = tokio::time::sleep(IDLE_CHECK) => {}
                }
                continue;
            }
            let started = tokio::time::Instant::now();
            let result = run_connection(&app).await;
            // A connection that stayed up for a while resets the backoff.
            if started.elapsed() > Duration::from_secs(60) {
                backoff = None;
            }
            let wait = match result {
                Ok(()) if backoff.is_none() => Duration::from_millis(500),
                Ok(()) => next_backoff(backoff),
                Err(e) => {
                    eprintln!("[cloud-realtime] {e}");
                    next_backoff(backoff)
                }
            };
            backoff = Some(wait);
            tokio::select! {
                _ = reconnect_notify().notified() => { backoff = None; }
                _ = tokio::time::sleep(wait) => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_messages() {
        assert_eq!(
            ws_url("https://openkoto.app/"),
            "wss://openkoto.app/api/v1/sync/ws"
        );
        assert_eq!(
            ws_url("http://localhost:8787"),
            "ws://localhost:8787/api/v1/sync/ws"
        );
        assert!(is_changed_message(r#"{"type":"changed","rev":1051}"#));
        assert!(!is_changed_message("pong"));
        assert!(!is_changed_message(r#"{"type":"hello"}"#));
        assert_eq!(next_backoff(None), Duration::from_secs(1));
        assert_eq!(next_backoff(Some(Duration::from_secs(200))), MAX_BACKOFF);
    }
}
