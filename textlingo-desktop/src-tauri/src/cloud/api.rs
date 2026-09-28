//! OpenKoto HTTP API client (auth-spec §3, sync-protocol-spec §5).

use super::{CloudState, TokenUser, Tokens};
use crate::sync::engine::{Transport, TransportError};
use crate::sync::protocol::{
    BlobUploadTicket, PullResponse, PushRequest, PushResponse, PROTOCOL_VERSION,
};
use reqwest::{Method, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};
use std::future::Future;

pub struct ApiClient<'a> {
    pub base_url: String,
    /// `X-OpenKoto-Client`, e.g. `desktop/0.7.0`.
    pub client_name: String,
    pub state: &'a CloudState,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    #[serde(default)]
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub user: Option<TokenUser>,
}

impl TokenResponse {
    pub fn into_tokens(self, previous_user: Option<TokenUser>) -> Tokens {
        Tokens {
            access_token: self.access_token,
            refresh_token: Some(self.refresh_token),
            expires_at: self
                .expires_in
                .map(|s| chrono::Utc::now().timestamp_millis() + s * 1000),
            device_id: self.device_id,
            user: self.user.or(previous_user),
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Map a non-2xx response to a TransportError (`{ "error": { "code", "message" } }`).
pub async fn error_from_response(resp: reqwest::Response) -> TransportError {
    let status = resp.status().as_u16();
    let retry_after = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    let text = resp.text().await.unwrap_or_default();
    let body: Option<Value> = serde_json::from_str(&text).ok();
    let err = body.as_ref().and_then(|b| b.get("error"));
    let code = err
        .and_then(|e| e.get("code"))
        .and_then(Value::as_str)
        .or_else(|| err.and_then(Value::as_str))
        .unwrap_or(match status {
            401 => "UNAUTHENTICATED",
            403 => "FORBIDDEN",
            410 => "CURSOR_EXPIRED",
            413 => "PAYLOAD_TOO_LARGE",
            426 => "CLIENT_TOO_OLD",
            429 => "RATE_LIMITED",
            s if s >= 500 => "INTERNAL",
            _ => "BAD_REQUEST",
        })
        .to_string();
    let message = err
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .or_else(|| {
            body.as_ref()
                .and_then(|b| b.get("message"))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
        .unwrap_or_else(|| text.chars().take(200).collect());
    TransportError {
        status: Some(status),
        code,
        message,
        retry_after_secs: retry_after,
    }
}

fn network_error(e: reqwest::Error) -> TransportError {
    TransportError::new(None, "NETWORK", e.to_string())
}

impl<'a> ApiClient<'a> {
    pub fn new(state: &'a CloudState, base_url: String, app_version: &str) -> Self {
        Self {
            base_url,
            client_name: format!("desktop/{app_version}"),
            state,
        }
    }

    fn url(&self, path: &str) -> String {
        if path.starts_with("http://") || path.starts_with("https://") {
            path.to_string()
        } else {
            format!("{}{}", self.base_url, path)
        }
    }

    fn request(&self, method: Method, path: &str, bearer: Option<&str>) -> reqwest::RequestBuilder {
        let mut req = self
            .state
            .http
            .request(method, self.url(path))
            .header("X-OpenKoto-Protocol", PROTOCOL_VERSION.to_string())
            .header("X-OpenKoto-Client", &self.client_name);
        if let Some(token) = bearer {
            req = req.bearer_auth(token);
        }
        req
    }

    /// POST /api/v1/auth/token (no auth).
    pub async fn token_grant(&self, body: Value) -> Result<TokenResponse, TransportError> {
        let resp = self
            .request(Method::POST, "/api/v1/auth/token", None)
            .json(&body)
            .send()
            .await
            .map_err(network_error)?;
        if !resp.status().is_success() {
            return Err(error_from_response(resp).await);
        }
        resp.json::<TokenResponse>()
            .await
            .map_err(|e| TransportError::new(None, "BAD_RESPONSE", e.to_string()))
    }

    /// Rotate the refresh token (single-flight; a second refresh with an already-rotated token
    /// would trip the server's reuse detection and revoke the device).
    async fn refresh_with(&self, used: &Tokens) -> Result<Tokens, TransportError> {
        let _guard = self.state.refresh_lock.lock().await;
        // Someone else refreshed while we waited.
        if let Some(current) = self.state.tokens() {
            if current.refresh_token != used.refresh_token {
                return Ok(current);
            }
        } else {
            return Err(TransportError::new(
                Some(401),
                "UNAUTHENTICATED",
                "signed out",
            ));
        }
        let Some(refresh_token) = used.refresh_token.clone() else {
            return Err(TransportError::new(
                Some(401),
                "UNAUTHENTICATED",
                "no refresh token",
            ));
        };
        match self
            .token_grant(json!({ "grant_type": "refresh_token", "refresh_token": refresh_token }))
            .await
        {
            Ok(resp) => {
                let tokens = resp.into_tokens(used.user.clone());
                let tokens = Tokens {
                    device_id: tokens.device_id.clone().or(used.device_id.clone()),
                    ..tokens
                };
                self.state
                    .set_tokens(Some(tokens.clone()))
                    .map_err(|e| TransportError::new(None, "KEYCHAIN", e))?;
                Ok(tokens)
            }
            Err(e) if matches!(e.status, Some(400) | Some(401)) => {
                // Refresh token invalid / revoked: the user must sign in again.
                let _ = self.state.set_tokens(None);
                Err(TransportError::new(
                    Some(401),
                    "UNAUTHENTICATED",
                    format!("session expired, please sign in again ({})", e.message),
                ))
            }
            Err(e) => Err(e),
        }
    }

    async fn access_tokens(&self) -> Result<Tokens, TransportError> {
        let Some(tokens) = self.state.tokens() else {
            return Err(TransportError::new(
                Some(401),
                "UNAUTHENTICATED",
                "not signed in",
            ));
        };
        if tokens.needs_refresh(now_ms()) {
            return self.refresh_with(&tokens).await;
        }
        Ok(tokens)
    }

    /// Authenticated request with one transparent refresh-and-retry on 401.
    pub async fn send_authed(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
        content_type: Option<&str>,
    ) -> Result<reqwest::Response, TransportError> {
        let tokens = self.access_tokens().await?;
        let build = |token: &str| {
            let mut req = self.request(method.clone(), path, Some(token));
            if let Some(b) = body.clone() {
                req = req.body(b);
            }
            if let Some(ct) = content_type {
                req = req.header(reqwest::header::CONTENT_TYPE, ct);
            }
            req
        };
        let resp = build(&tokens.access_token)
            .send()
            .await
            .map_err(network_error)?;
        if resp.status() != StatusCode::UNAUTHORIZED || tokens.refresh_token.is_none() {
            return Ok(resp);
        }
        let fresh = self.refresh_with(&tokens).await?;
        build(&fresh.access_token)
            .send()
            .await
            .map_err(network_error)
    }

    pub async fn json_authed<T: serde::de::DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<T, TransportError> {
        let bytes = body.map(|b| serde_json::to_vec(b).unwrap_or_default());
        let resp = self
            .send_authed(method, path, bytes, body.map(|_| "application/json"))
            .await?;
        if !resp.status().is_success() {
            return Err(error_from_response(resp).await);
        }
        resp.json::<T>()
            .await
            .map_err(|e| TransportError::new(None, "BAD_RESPONSE", e.to_string()))
    }

    /// GET /api/v1/me
    pub async fn me(&self) -> Result<Value, TransportError> {
        self.json_authed(Method::GET, "/api/v1/me", None).await
    }

    /// POST /api/v1/auth/logout (revokes this device).
    pub async fn logout(&self, refresh_token: &str) -> Result<(), TransportError> {
        let resp = self
            .request(Method::POST, "/api/v1/auth/logout", None)
            .json(&json!({ "refreshToken": refresh_token }))
            .send()
            .await
            .map_err(network_error)?;
        if !resp.status().is_success() {
            return Err(error_from_response(resp).await);
        }
        Ok(())
    }
}

impl<'a> Transport for ApiClient<'a> {
    fn pull(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> impl Future<Output = Result<PullResponse, TransportError>> + Send {
        async move {
            let mut path = format!("/api/v1/sync/pull?limit={limit}");
            if let Some(c) = cursor {
                path.push_str("&cursor=");
                path.push_str(&urlencoding::encode(&c));
            }
            self.json_authed(Method::GET, &path, None).await
        }
    }

    fn push(
        &self,
        request: PushRequest,
    ) -> impl Future<Output = Result<PushResponse, TransportError>> + Send {
        async move {
            let body = serde_json::to_value(&request)
                .map_err(|e| TransportError::new(None, "LOCAL", e.to_string()))?;
            self.json_authed(Method::POST, "/api/v1/sync/push", Some(&body))
                .await
        }
    }

    fn fetch_blob(
        &self,
        url: String,
    ) -> impl Future<Output = Result<Vec<u8>, TransportError>> + Send {
        async move {
            let resp = self.send_authed(Method::GET, &url, None, None).await?;
            if !resp.status().is_success() {
                return Err(error_from_response(resp).await);
            }
            resp.bytes()
                .await
                .map(|b| b.to_vec())
                .map_err(network_error)
        }
    }

    fn upload_blob(
        &self,
        record_type: String,
        id: String,
        gzip: Vec<u8>,
        sha256: String,
    ) -> impl Future<Output = Result<String, TransportError>> + Send {
        async move {
            let ticket: BlobUploadTicket = self
                .json_authed(
                    Method::POST,
                    "/api/v1/sync/blobs",
                    Some(&json!({ "type": record_type, "id": id, "size": gzip.len(), "sha256": sha256 })),
                )
                .await?;
            let resp = self
                .send_authed(
                    Method::PUT,
                    &ticket.upload_url,
                    Some(gzip),
                    Some("application/gzip"),
                )
                .await?;
            if !resp.status().is_success() {
                return Err(error_from_response(resp).await);
            }
            Ok(ticket.blob_key)
        }
    }
}
