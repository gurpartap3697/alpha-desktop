//! Where the gateway API key lives: the OS credential store (macOS Keychain, Windows
//! Credential Manager, Linux Secret Service), or a 0600 file in the app data directory when
//! that store is unavailable. The key is never written anywhere else.
//!
//! All methods block (a keychain may show an unlock prompt), so call them off the async runtime.

use std::io::ErrorKind as IoErrorKind;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;

const SERVICE: &str = "com.alpha.desktop";
const ACCOUNT: &str = "gateway-api-key";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StorageKind {
    Keychain,
    /// Plain file readable only by the user. The UI warns about this.
    File,
}

pub trait SecretStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, secret: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

pub struct KeyringStore;

impl KeyringStore {
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
    }
}

impl SecretStore for KeyringStore {
    fn get(&self) -> Result<Option<String>, String> {
        match Self::entry()?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, secret: &str) -> Result<(), String> {
        Self::entry()?.set_password(secret).map_err(|e| e.to_string())
    }

    fn delete(&self) -> Result<(), String> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

pub struct FileStore {
    path: PathBuf,
}

impl FileStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl SecretStore for FileStore {
    fn get(&self) -> Result<Option<String>, String> {
        match std::fs::read_to_string(&self.path) {
            Ok(s) if s.trim().is_empty() => Ok(None),
            Ok(s) => Ok(Some(s.trim().to_owned())),
            Err(e) if e.kind() == IoErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("{}: {e}", self.path.display())),
        }
    }

    fn set(&self, secret: &str) -> Result<(), String> {
        let err = |e: std::io::Error| format!("{}: {e}", self.path.display());
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        // Write a 0600 temp file, then rename over the old one.
        let tmp = self.path.with_extension("tmp");
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        let mut f = opts.open(&tmp).map_err(err)?;
        std::io::Write::write_all(&mut f, secret.as_bytes()).map_err(err)?;
        f.sync_all().map_err(err)?;
        drop(f);
        std::fs::rename(&tmp, &self.path).map_err(err)
    }

    fn delete(&self) -> Result<(), String> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == IoErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("{}: {e}", self.path.display())),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Loaded {
    pub key: Option<String>,
    pub storage: Option<StorageKind>,
    /// Set when the OS credential store could not be read.
    pub error: Option<String>,
}

/// The OS store with a file fallback, plus an in-memory copy so the store is read once.
pub struct Credentials {
    keychain: Box<dyn SecretStore>,
    file: Box<dyn SecretStore>,
    cache: Mutex<Option<Loaded>>,
}

impl Credentials {
    pub fn new(keychain: Box<dyn SecretStore>, file: Box<dyn SecretStore>) -> Self {
        Self { keychain, file, cache: Mutex::new(None) }
    }

    pub fn cached_key(&self) -> Option<String> {
        self.cache.lock().unwrap().as_ref().and_then(|l| l.key.clone())
    }

    pub fn load(&self) -> Loaded {
        let mut cache = self.cache.lock().unwrap();
        if let Some(l) = cache.as_ref() {
            return l.clone();
        }
        let mut loaded = Loaded::default();
        match self.keychain.get() {
            Ok(Some(key)) => {
                loaded.key = Some(key);
                loaded.storage = Some(StorageKind::Keychain);
            }
            Ok(None) => {}
            Err(e) => loaded.error = Some(e),
        }
        if loaded.key.is_none() {
            if let Ok(Some(key)) = self.file.get() {
                loaded.key = Some(key);
                loaded.storage = Some(StorageKind::File);
            }
        }
        *cache = Some(loaded.clone());
        loaded
    }

    /// Save to the OS store, or to the file if the OS store fails.
    pub fn save(&self, key: &str) -> Result<StorageKind, String> {
        let storage = match self.keychain.set(key) {
            Ok(()) => {
                // Don't leave an older copy lying around in the file.
                let _ = self.file.delete();
                StorageKind::Keychain
            }
            Err(keychain_err) => {
                self.file.set(key).map_err(|file_err| {
                    format!("Couldn't save the key to the system keychain ({keychain_err}) or to a file ({file_err})")
                })?;
                StorageKind::File
            }
        };
        *self.cache.lock().unwrap() =
            Some(Loaded { key: Some(key.to_owned()), storage: Some(storage), error: None });
        Ok(storage)
    }

    /// Remove the key from both stores. Reports a failure only for the store that held it.
    pub fn clear(&self) -> Result<(), String> {
        let held = self.cache.lock().unwrap().take().and_then(|l| l.storage);
        let keychain = self.keychain.delete();
        let file = self.file.delete();
        match held {
            Some(StorageKind::Keychain) => keychain,
            Some(StorageKind::File) => file,
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[derive(Default, Clone)]
    struct Memory {
        value: Arc<Mutex<Option<String>>>,
        broken: bool,
    }

    impl Memory {
        fn broken() -> Self {
            Self { broken: true, ..Default::default() }
        }
        fn value(&self) -> Option<String> {
            self.value.lock().unwrap().clone()
        }
    }

    impl SecretStore for Memory {
        fn get(&self) -> Result<Option<String>, String> {
            if self.broken { return Err("no store".into()) }
            Ok(self.value())
        }
        fn set(&self, s: &str) -> Result<(), String> {
            if self.broken { return Err("no store".into()) }
            *self.value.lock().unwrap() = Some(s.into());
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            if self.broken { return Err("no store".into()) }
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    #[test]
    fn prefers_keychain_and_removes_stale_file_copy() {
        let (kc, file) = (Memory::default(), Memory::default());
        *file.value.lock().unwrap() = Some("old".into());
        let c = Credentials::new(Box::new(kc.clone()), Box::new(file.clone()));
        assert_eq!(c.save("sk-1"), Ok(StorageKind::Keychain));
        assert_eq!(kc.value().as_deref(), Some("sk-1"));
        assert_eq!(file.value(), None);

        // A fresh instance reads it back from the store.
        let c2 = Credentials::new(Box::new(kc.clone()), Box::new(file));
        let l = c2.load();
        assert_eq!((l.key.as_deref(), l.storage), (Some("sk-1"), Some(StorageKind::Keychain)));

        c2.clear().unwrap();
        assert_eq!(kc.value(), None);
        assert_eq!(c2.load().key, None);
    }

    #[test]
    fn falls_back_to_file_when_keychain_is_unavailable() {
        let file = Memory::default();
        let c = Credentials::new(Box::new(Memory::broken()), Box::new(file.clone()));
        let l = c.load();
        assert_eq!(l.key, None);
        assert!(l.error.is_some());

        assert_eq!(c.save("sk-2"), Ok(StorageKind::File));
        assert_eq!(c.cached_key().as_deref(), Some("sk-2"));

        let c2 = Credentials::new(Box::new(Memory::broken()), Box::new(file.clone()));
        let l = c2.load();
        assert_eq!((l.key.as_deref(), l.storage), (Some("sk-2"), Some(StorageKind::File)));
        c2.clear().unwrap();
        assert_eq!(file.value(), None);
    }

    #[test]
    fn save_fails_when_both_stores_fail() {
        let c = Credentials::new(Box::new(Memory::broken()), Box::new(Memory::broken()));
        assert!(c.save("sk").is_err());
        assert_eq!(c.cached_key(), None);
    }

    #[test]
    fn file_store_round_trip_with_private_permissions() {
        let dir = std::env::temp_dir().join(format!("alpha-test-{}", std::process::id()));
        let store = FileStore::new(dir.join("nested").join("key"));
        assert_eq!(store.get(), Ok(None));
        store.set("sk-file").unwrap();
        assert_eq!(store.get().unwrap().as_deref(), Some("sk-file"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("nested").join("key")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        store.delete().unwrap();
        store.delete().unwrap();
        assert_eq!(store.get(), Ok(None));
        let _ = std::fs::remove_dir_all(dir);
    }
}
