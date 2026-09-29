//! Fallback token storage for systems without a usable keychain (typically Linux without a
//! Secret Service): `cloud-session.enc` in the app data dir, mode 0600, encrypted with
//! ChaCha20-Poly1305.
//!
//! The key is derived from a random per-install secret (`cloud-session.key`, 0600) plus the
//! machine id and user name, so a copied file (backup, sync folder) is useless on its own.
//! This is weaker than a keychain — anyone who can read both files as this user can decrypt —
//! which is why the Settings panel shows a warning while it is in use.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const TOKEN_FILE: &str = "cloud-session.enc";
pub const KEY_FILE: &str = "cloud-session.key";
const MAGIC: &[u8] = b"OKT1";

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().ok();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(n + 16);
    while out.len() < n {
        out.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    out.truncate(n);
    out
}

fn machine_id() -> String {
    for p in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(s) = fs::read_to_string(p) {
            if !s.trim().is_empty() {
                return s.trim().to_string();
            }
        }
    }
    String::new()
}

fn user_name() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default()
}

pub struct TokenFile {
    dir: PathBuf,
}

impl TokenFile {
    pub fn new(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(TOKEN_FILE)
    }

    fn key(&self, create: bool) -> Result<Option<Key>, String> {
        let key_path = self.dir.join(KEY_FILE);
        let secret = match fs::read(&key_path) {
            Ok(b) if b.len() == 32 => b,
            _ if create => {
                let b = random_bytes(32);
                write_private(&key_path, &b)?;
                b
            }
            _ => return Ok(None),
        };
        let mut h = Sha256::new();
        h.update(b"openkoto-desktop/token-file/v1");
        h.update(&secret);
        h.update(machine_id().as_bytes());
        h.update(user_name().as_bytes());
        Ok(Some(*Key::from_slice(&h.finalize())))
    }

    pub fn exists(&self) -> bool {
        self.path().exists()
    }

    pub fn save(&self, plaintext: &str) -> Result<(), String> {
        let key = self.key(true)?.ok_or("no key")?;
        let cipher = ChaCha20Poly1305::new(&key);
        let nonce_bytes = random_bytes(12);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ct = cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|_| "encryption failed".to_string())?;
        let mut out = Vec::with_capacity(4 + 12 + ct.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ct);
        write_private(&self.path(), &out)
    }

    pub fn load(&self) -> Result<Option<String>, String> {
        let Ok(bytes) = fs::read(self.path()) else {
            return Ok(None);
        };
        if bytes.len() < 16 || &bytes[..4] != MAGIC {
            return Err("token file is corrupt".into());
        }
        let Some(key) = self.key(false)? else {
            return Err("token key file is missing".into());
        };
        let cipher = ChaCha20Poly1305::new(&key);
        let pt = cipher
            .decrypt(Nonce::from_slice(&bytes[4..16]), &bytes[16..])
            .map_err(|_| "token file cannot be decrypted on this machine".to_string())?;
        String::from_utf8(pt).map(Some).map_err(|e| e.to_string())
    }

    pub fn delete(&self) {
        let _ = fs::remove_file(self.path());
        let _ = fs::remove_file(self.dir.join(KEY_FILE));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_encrypted_and_private() {
        let dir = std::env::temp_dir().join(format!("openkoto-tokenfile-{}", uuid::Uuid::new_v4()));
        let f = TokenFile::new(&dir);
        assert_eq!(f.load().unwrap(), None);
        f.save(r#"{"accessToken":"secret-token"}"#).unwrap();
        let raw = fs::read(f.path()).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("secret-token"));
        assert_eq!(
            f.load().unwrap().as_deref(),
            Some(r#"{"accessToken":"secret-token"}"#)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(f.path()).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(dir.join(KEY_FILE))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        // Tampering is detected.
        let mut bad = raw.clone();
        let last = bad.len() - 1;
        bad[last] ^= 1;
        fs::write(f.path(), bad).unwrap();
        assert!(f.load().is_err());
        f.delete();
        assert!(!f.exists());
        let _ = fs::remove_dir_all(dir);
    }
}
