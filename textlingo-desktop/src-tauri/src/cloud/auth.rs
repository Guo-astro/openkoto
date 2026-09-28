//! Desktop sign-in: authorization code + PKCE through the system browser (auth-spec §3.1).

use super::api::ApiClient;
use super::{CloudState, Tokens, DEEP_LINK_CALLBACK};
use base64::Engine as _;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::oneshot;

#[derive(Debug, Clone, PartialEq)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

fn random_url_token(bytes: usize) -> String {
    let mut buf = Vec::with_capacity(bytes + 16);
    while buf.len() < bytes {
        buf.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    buf.truncate(bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

pub fn challenge_for(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// RFC 7636 S256: 43-char verifier from 32 random bytes.
pub fn new_pkce() -> Pkce {
    let verifier = random_url_token(32);
    Pkce {
        challenge: challenge_for(&verifier),
        verifier,
        state: random_url_token(16),
    }
}

pub fn authorize_url(base_url: &str, redirect_uri: &str, pkce: &Pkce) -> String {
    let mut url = url::Url::parse(&format!("{base_url}/auth/native/authorize"))
        .unwrap_or_else(|_| url::Url::parse("https://openkoto.app/auth/native/authorize").unwrap());
    url.query_pairs_mut()
        .append_pair("client_id", "desktop")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &pkce.state);
    url.to_string()
}

#[derive(Debug, Clone, PartialEq)]
pub struct CallbackParams {
    pub code: String,
    pub state: Option<String>,
}

/// Parse `openkoto://auth/callback?code=…&state=…` or the loopback URL.
pub fn parse_callback(raw: &str) -> Result<CallbackParams, String> {
    let url = url::Url::parse(raw).map_err(|e| format!("Invalid callback URL: {e}"))?;
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.to_string()),
            "state" => state = Some(v.to_string()),
            "error" | "error_description" => {
                error.get_or_insert_with(|| v.to_string());
            }
            _ => {}
        }
    }
    if let Some(e) = error {
        return Err(format!("Sign-in failed: {e}"));
    }
    let code = code.ok_or_else(|| "Callback is missing the authorization code".to_string())?;
    Ok(CallbackParams { code, state })
}

/// Is this URL our OAuth callback (deep link form)?
pub fn is_deep_link_callback(raw: &str) -> bool {
    url::Url::parse(raw)
        .map(|u| {
            u.scheme() == super::DEEP_LINK_SCHEME
                && u.host_str() == Some("auth")
                && u.path().trim_end_matches('/') == "/callback"
        })
        .unwrap_or(false)
}

/// A sign-in waiting for its callback.
pub struct PendingLogin {
    pub pkce: Pkce,
    pub redirect_uri: String,
    pub sender: Option<oneshot::Sender<String>>,
    pub loopback_cancel: Option<Arc<AtomicBool>>,
}

impl Drop for PendingLogin {
    fn drop(&mut self) {
        if let Some(c) = &self.loopback_cancel {
            c.store(true, Ordering::SeqCst);
        }
    }
}

/// Deliver a deep-link callback to the pending sign-in (if its state matches).
pub fn deliver_deep_link(state: &CloudState, raw: &str) -> bool {
    if !is_deep_link_callback(raw) {
        return false;
    }
    let mut pending = state.pending_login.lock().unwrap();
    let Some(login) = pending.as_mut() else {
        return false;
    };
    if login.redirect_uri != DEEP_LINK_CALLBACK {
        return false;
    }
    if let Ok(params) = parse_callback(raw) {
        if params.state.as_deref() != Some(login.pkce.state.as_str()) {
            return false;
        }
    }
    match login.sender.take() {
        Some(tx) => tx.send(raw.to_string()).is_ok(),
        None => false,
    }
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

pub fn device_name() -> String {
    let from_env = std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .filter(|s| !s.trim().is_empty());
    let name = from_env.or_else(|| {
        std::process::Command::new("hostname")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    });
    let name = name.unwrap_or_else(|| "OpenKoto Desktop".to_string());
    name.trim_end_matches(".local").chars().take(80).collect()
}

/// Validate the callback against the pending PKCE state and exchange the code for tokens.
pub async fn complete_login(
    api: &ApiClient<'_>,
    callback_url: &str,
    pkce: &Pkce,
    redirect_uri: &str,
    app_version: &str,
) -> Result<Tokens, String> {
    let params = parse_callback(callback_url)?;
    if params.state.as_deref() != Some(pkce.state.as_str()) {
        return Err("Sign-in state mismatch; please try again".into());
    }
    let resp = api
        .token_grant(json!({
            "grant_type": "authorization_code",
            "code": params.code,
            "code_verifier": pkce.verifier,
            "redirect_uri": redirect_uri,
            "device": { "platform": platform(), "name": device_name(), "appVersion": app_version },
        }))
        .await
        .map_err(|e| format!("Sign-in failed: {}", e.message))?;
    Ok(resp.into_tokens(None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_is_rfc7636_s256() {
        // RFC 7636 appendix B test vector.
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let p = new_pkce();
        assert_eq!(p.verifier.len(), 43);
        assert!(p
            .verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(new_pkce().verifier, p.verifier);
    }

    #[test]
    fn builds_authorize_url() {
        let p = Pkce {
            verifier: "v".into(),
            challenge: "c".into(),
            state: "s t".into(),
        };
        let url = authorize_url("https://openkoto.app", "http://127.0.0.1:5555/callback", &p);
        assert!(url.starts_with("https://openkoto.app/auth/native/authorize?client_id=desktop"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcallback"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=s+t"));
    }

    #[test]
    fn parses_callbacks() {
        let p = parse_callback("openkoto://auth/callback?code=abc&state=xyz").unwrap();
        assert_eq!(p.code, "abc");
        assert_eq!(p.state.as_deref(), Some("xyz"));
        assert!(parse_callback("openkoto://auth/callback?error=access_denied").is_err());
        assert!(parse_callback("openkoto://auth/callback?state=x").is_err());
        assert!(is_deep_link_callback("openkoto://auth/callback?code=1"));
        assert!(!is_deep_link_callback("openkoto://other/callback?code=1"));
        assert!(!is_deep_link_callback("http://127.0.0.1:1/callback?code=1"));
    }

    #[test]
    fn deep_link_is_delivered_only_with_matching_state() {
        let state = CloudState::new(Box::new(super::super::MemoryTokenStore::default()));
        let (tx, mut rx) = oneshot::channel();
        *state.pending_login.lock().unwrap() = Some(PendingLogin {
            pkce: Pkce {
                verifier: "v".into(),
                challenge: "c".into(),
                state: "good".into(),
            },
            redirect_uri: DEEP_LINK_CALLBACK.into(),
            sender: Some(tx),
            loopback_cancel: None,
        });
        assert!(!deliver_deep_link(
            &state,
            "openkoto://auth/callback?code=1&state=bad"
        ));
        assert!(rx.try_recv().is_err());
        assert!(deliver_deep_link(
            &state,
            "openkoto://auth/callback?code=1&state=good"
        ));
        assert_eq!(
            rx.try_recv().unwrap(),
            "openkoto://auth/callback?code=1&state=good"
        );
        assert!(!platform().is_empty());
        assert!(!device_name().is_empty());
    }
}
