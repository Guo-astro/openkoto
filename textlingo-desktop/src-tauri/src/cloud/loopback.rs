//! One-shot loopback HTTP listener for the OAuth callback
//! (`http://127.0.0.1:<random>/callback`, allowed for `client_id=desktop`, auth-spec §3.1).
//! Used where the `openkoto://` deep link is not available (dev builds, some Linux desktops).

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const CALLBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub struct LoopbackListener {
    listener: TcpListener,
    pub port: u16,
    cancelled: Arc<AtomicBool>,
}

const SUCCESS_PAGE: &str =
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>OpenKoto</title></head>\
<body style=\"font-family:system-ui,sans-serif;text-align:center;padding:48px\">\
<h2>OpenKoto</h2><p>Sign-in complete. You can close this window and return to the app.</p>\
<p>登录完成，可以关闭此页面并回到应用。</p></body></html>";

impl LoopbackListener {
    pub fn bind() -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("Failed to start local callback listener: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        Ok(Self {
            listener,
            port,
            cancelled: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Setting the returned flag makes [`Self::wait_for_callback`] give up (a newer sign-in
    /// attempt replaced this one).
    pub fn cancel_handle(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/callback", self.port)
    }

    /// Block until a request for `/callback` arrives (other paths such as `/favicon.ico` get a
    /// 404 and are ignored) or `timeout` elapses. Returns the full callback URL.
    pub fn wait_for_callback(self, timeout: Duration) -> Result<String, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                return Err("Timed out waiting for the sign-in callback".into());
            }
            if self.cancelled.load(Ordering::SeqCst) {
                return Err("Sign-in cancelled".into());
            }
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if let Some(url) = self.handle(stream) {
                        return Ok(url);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(format!("Callback listener failed: {e}")),
            }
        }
    }

    fn handle(&self, mut stream: TcpStream) -> Option<String> {
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut reader = BufReader::new(stream.try_clone().ok()?);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).ok()?;
        // Drain headers.
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) if line == "\r\n" || line == "\n" => break,
                Ok(_) => continue,
                Err(_) => break,
            }
        }
        let target = request_line.split_whitespace().nth(1).unwrap_or("/");
        if !target.starts_with("/callback") {
            let _ = stream.write_all(
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return None;
        }
        let body = SUCCESS_PAGE.as_bytes();
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .as_bytes(),
        );
        let _ = stream.write_all(body);
        let _ = stream.flush();
        Some(format!("http://127.0.0.1:{}{}", self.port, target))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn receives_one_callback_and_ignores_other_paths() {
        let listener = LoopbackListener::bind().unwrap();
        let port = listener.port;
        assert!(listener.redirect_uri().ends_with("/callback"));
        let handle =
            std::thread::spawn(move || listener.wait_for_callback(Duration::from_secs(10)));

        let mut favicon = TcpStream::connect(("127.0.0.1", port)).unwrap();
        favicon
            .write_all(b"GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .unwrap();
        let mut out = String::new();
        favicon.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 404"));

        let mut cb = TcpStream::connect(("127.0.0.1", port)).unwrap();
        cb.write_all(b"GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .unwrap();
        let mut page = String::new();
        cb.read_to_string(&mut page).unwrap();
        assert!(page.starts_with("HTTP/1.1 200"));

        let url = handle.join().unwrap().unwrap();
        assert_eq!(
            url,
            format!("http://127.0.0.1:{port}/callback?code=abc&state=xyz")
        );
    }

    #[test]
    fn times_out() {
        let listener = LoopbackListener::bind().unwrap();
        assert!(listener
            .wait_for_callback(Duration::from_millis(200))
            .is_err());
    }
}
