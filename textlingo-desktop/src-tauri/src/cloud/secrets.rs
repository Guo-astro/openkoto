//! Secrets in the OS keychain (`keyring`, service `openkoto-desktop`; auth-spec §6):
//! the cloud session tokens and the model provider API keys (moved out of `config.json`,
//! design doc §9.2).

use crate::types::AppConfig;
use std::collections::HashMap;
use std::sync::Mutex;

pub const KEYRING_SERVICE: &str = "openkoto-desktop";
/// Stored in `config.json` instead of a key that now lives in the keychain.
pub const API_KEY_PLACEHOLDER: &str = "@keyring";

pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// OS keychain (macOS Keychain, Windows Credential Manager, Secret Service on Linux), with a
/// process-wide cache so hot paths (config loads) do not hit the keychain every time.
pub struct KeyringStore;

fn keyring_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, Option<String>>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        if let Some(v) = keyring_cache()
            .lock()
            .ok()
            .and_then(|c| c.get(account).cloned())
        {
            return Ok(v);
        }
        let entry = keyring::Entry::new(KEYRING_SERVICE, account).map_err(|e| e.to_string())?;
        let value = match entry.get_password() {
            Ok(v) => Some(v),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => return Err(e.to_string()),
        };
        if let Ok(mut c) = keyring_cache().lock() {
            c.insert(account.to_string(), value.clone());
        }
        Ok(value)
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        if keyring_cache()
            .lock()
            .ok()
            .and_then(|c| c.get(account).cloned())
            .flatten()
            .as_deref()
            == Some(value)
        {
            return Ok(());
        }
        let entry = keyring::Entry::new(KEYRING_SERVICE, account).map_err(|e| e.to_string())?;
        entry.set_password(value).map_err(|e| e.to_string())?;
        if let Ok(mut c) = keyring_cache().lock() {
            c.insert(account.to_string(), Some(value.to_string()));
        }
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, account).map_err(|e| e.to_string())?;
        let result = match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        };
        if let Ok(mut c) = keyring_cache().lock() {
            c.insert(account.to_string(), None);
        }
        result
    }
}

/// In-memory store (tests).
#[derive(Default)]
pub struct MemoryStore {
    values: Mutex<HashMap<String, String>>,
    pub fail: bool,
}

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        if self.fail {
            return Err("keychain unavailable".into());
        }
        Ok(self.values.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        if self.fail {
            return Err("keychain unavailable".into());
        }
        self.values
            .lock()
            .unwrap()
            .insert(account.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.values.lock().unwrap().remove(account);
        Ok(())
    }
}

pub fn model_key_account(config_id: &str) -> String {
    format!("model-api-key:{config_id}")
}

pub fn asr_key_account(config_id: &str) -> String {
    format!("asr-api-key:{config_id}")
}

/// Load-time: replace placeholders with the keychain value. Plaintext keys still in the file
/// are copied into the keychain; returns true when the file should be rewritten (migration).
pub fn hydrate_api_keys(config: &mut AppConfig, store: &dyn SecretStore) -> bool {
    let mut migrated = false;
    let mut visit = |id: &str, key: &mut String, account: String| {
        if key == API_KEY_PLACEHOLDER {
            *key = store.get(&account).ok().flatten().unwrap_or_default();
        } else if !key.is_empty() && store.set(&account, key).is_ok() {
            migrated = true;
        }
        let _ = id;
    };
    for c in config.model_configs.iter_mut() {
        let account = model_key_account(&c.id);
        visit(&c.id.clone(), &mut c.api_key, account);
    }
    for c in config.asr_configs.iter_mut() {
        let account = asr_key_account(&c.id);
        visit(&c.id.clone(), &mut c.api_key, account);
    }
    migrated
}

/// Save-time: the copy written to `config.json`. Keys go to the keychain and are replaced by
/// the placeholder; if the keychain is unavailable the key stays in the file (never lost).
pub fn config_for_disk(config: &AppConfig, store: &dyn SecretStore) -> AppConfig {
    let mut out = config.clone();
    let strip = |key: &mut String, account: String| {
        if key == API_KEY_PLACEHOLDER {
            return;
        }
        if key.is_empty() {
            let _ = store.delete(&account);
            return;
        }
        if store.set(&account, key).is_ok() {
            *key = API_KEY_PLACEHOLDER.to_string();
        }
    };
    for c in out.model_configs.iter_mut() {
        let account = model_key_account(&c.id);
        strip(&mut c.api_key, account);
    }
    for c in out.asr_configs.iter_mut() {
        let account = asr_key_account(&c.id);
        strip(&mut c.api_key, account);
    }
    out
}

/// Remove keychain entries of configs that no longer exist.
pub fn forget_removed_keys(previous: &AppConfig, next: &AppConfig, store: &dyn SecretStore) {
    for c in &previous.model_configs {
        if !next.model_configs.iter().any(|n| n.id == c.id) {
            let _ = store.delete(&model_key_account(&c.id));
        }
    }
    for c in &previous.asr_configs {
        if !next.asr_configs.iter().any(|n| n.id == c.id) {
            let _ = store.delete(&asr_key_account(&c.id));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ModelConfig;

    fn config() -> AppConfig {
        let mut c = AppConfig::default();
        c.model_configs.push(ModelConfig {
            id: "m1".into(),
            name: "Primary".into(),
            api_key: "sk-secret".into(),
            api_provider: "openai".into(),
            model: "gpt".into(),
            is_default: true,
            created_at: None,
            base_url: None,
        });
        c.model_configs.push(ModelConfig {
            id: "local".into(),
            name: "Ollama".into(),
            api_key: "".into(),
            api_provider: "ollama".into(),
            model: "llama".into(),
            is_default: false,
            created_at: None,
            base_url: None,
        });
        c.asr_configs.push(ModelConfig {
            id: "a1".into(),
            name: "ASR".into(),
            api_key: "asr-secret".into(),
            api_provider: "openai".into(),
            model: "whisper".into(),
            is_default: false,
            created_at: None,
            base_url: None,
        });
        c
    }

    #[test]
    fn migrates_plaintext_keys_into_the_keychain() {
        let store = MemoryStore::default();
        let mut loaded = config();
        assert!(hydrate_api_keys(&mut loaded, &store));
        assert_eq!(loaded.model_configs[0].api_key, "sk-secret");
        assert_eq!(
            store.get("model-api-key:m1").unwrap().as_deref(),
            Some("sk-secret")
        );
        assert_eq!(
            store.get("asr-api-key:a1").unwrap().as_deref(),
            Some("asr-secret")
        );

        let disk = config_for_disk(&loaded, &store);
        assert_eq!(disk.model_configs[0].api_key, API_KEY_PLACEHOLDER);
        assert_eq!(disk.model_configs[1].api_key, "");
        assert_eq!(disk.asr_configs[0].api_key, API_KEY_PLACEHOLDER);
        let text = serde_json::to_string(&disk).unwrap();
        assert!(!text.contains("sk-secret") && !text.contains("asr-secret"));

        // Next launch: placeholders are hydrated, nothing left to migrate.
        let mut again = disk.clone();
        assert!(!hydrate_api_keys(&mut again, &store));
        assert_eq!(again.model_configs[0].api_key, "sk-secret");
        assert_eq!(again.asr_configs[0].api_key, "asr-secret");

        forget_removed_keys(&again, &AppConfig::default(), &store);
        assert!(store.get("model-api-key:m1").unwrap().is_none());
    }

    #[test]
    fn keychain_failure_keeps_keys_in_the_file() {
        let store = MemoryStore {
            fail: true,
            ..Default::default()
        };
        let mut loaded = config();
        assert!(!hydrate_api_keys(&mut loaded, &store));
        let disk = config_for_disk(&loaded, &store);
        assert_eq!(disk.model_configs[0].api_key, "sk-secret");
    }
}
