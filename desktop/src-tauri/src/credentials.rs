//! Low-value guest sessions live in an atomically replaced, owner-only file
//! in the app config directory, isolated by server origin. Keychain is queried
//! once for silent migration only; normal reads, saves and sign-out use files.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

const SERVICE: &str = "gloss desktop session";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredSession {
    pub token: String,
    /// The cookie name the server issued (`glossy_session`, or
    /// `glossy_session_<port>` on a development server). Sessions saved before
    /// this field existed keep working with the production name.
    #[serde(default = "default_session_cookie_name")]
    pub cookie_name: String,
    /// True when this app created the session from an invite, so signing out
    /// ends it on the server. A session borrowed from the browser is only
    /// forgotten here, which keeps the browser signed in.
    pub owned: bool,
}

fn default_session_cookie_name() -> String {
    "glossy_session".to_owned()
}

/// Tokens issued by the server are 43 base64url characters
/// (`looksLikeToken` in `src/server/auth/tokens.ts`). Checking the shape keeps
/// anything else out of the Cookie header and the credential store.
pub fn looks_like_token(value: &str) -> bool {
    value.len() == 43 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub struct Credentials {
    path: std::path::PathBuf,
    memory: Mutex<HashMap<String, StoredSession>>,
    store_unavailable: AtomicBool,
}

impl Credentials {
    pub fn new(dir: &std::path::Path) -> Self {
        Self {
            path: dir.join("guest-sessions.json"),
            memory: Mutex::new(HashMap::new()),
            store_unavailable: AtomicBool::new(false),
        }
    }

    pub fn is_persistent(&self) -> bool {
        !self.store_unavailable.load(Ordering::Relaxed)
    }

    pub fn load(&self, origin: &str) -> Option<StoredSession> {
        let mut memory = self.memory.lock().ok()?;
        if let Some(session) = memory.get(origin) {
            return Some(session.clone());
        }
        let mut sessions = self.read_file();
        // Persist the attempt before querying Security.framework: even a crash,
        // refusal or inaccessible old item must not retry on the next launch.
        if !sessions.contains_key(origin) {
            sessions.insert(origin.to_owned(), None);
            if self.write_file(&sessions).is_ok() {
                if let Some(session) = migrate_without_prompt(origin) {
                    sessions.insert(origin.to_owned(), Some(session));
                    self.persist(&sessions);
                }
            } else {
                self.store_unavailable.store(true, Ordering::Relaxed);
            }
        }
        let session = sessions.get(origin)?.clone().filter(valid_session)?;
        memory.insert(origin.to_owned(), session.clone());
        Some(session)
    }

    pub fn save(&self, origin: &str, session: &StoredSession) {
        if !valid_session(session) {
            return;
        }
        let Ok(mut memory) = self.memory.lock() else { return };
        memory.insert(origin.to_owned(), session.clone());
        let mut sessions = self.read_file();
        sessions.insert(origin.to_owned(), Some(session.clone()));
        self.persist(&sessions);
    }

    pub fn delete(&self, origin: &str) {
        let Ok(mut memory) = self.memory.lock() else { return };
        memory.remove(origin);
        let mut sessions = self.read_file();
        // Keep the migration tombstone after sign-out, too.
        sessions.insert(origin.to_owned(), None);
        self.persist(&sessions);
    }

    fn read_file(&self) -> HashMap<String, Option<StoredSession>> {
        std::fs::read(&self.path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    fn persist(&self, sessions: &HashMap<String, Option<StoredSession>>) {
        let failed = self.write_file(sessions).is_err();
        self.store_unavailable.store(failed, Ordering::Relaxed);
        if failed {
            log::warn!("guest session file unavailable; keeping the session in memory");
        }
    }

    fn write_file(&self, sessions: &HashMap<String, Option<StoredSession>>) -> std::io::Result<()> {
        use std::io::Write;
        let dir = self.path.parent().expect("session file has a config directory");
        std::fs::create_dir_all(dir)?;
        // A unique, exclusively created sibling prevents following a preexisting
        // symlink and preserves atomic replacement on the same filesystem.
        let temporary = dir.join(format!(".guest-session-{}", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| {
            let mut file = options.open(&temporary)?;
            file.write_all(&serde_json::to_vec(sessions)?)?;
            file.sync_all()?;
            std::fs::rename(&temporary, &self.path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
}

fn valid_session(session: &StoredSession) -> bool {
    looks_like_token(&session.token)
        && !session.cookie_name.is_empty()
        && session.cookie_name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// This is the only Keychain access in the application, for one-time migration.
/// Both legacy Keychain UI and authenticated-item UI are disabled. A locked or
/// signature-protected item is skipped; guest enrollment handles the absence.
#[cfg(target_os = "macos")]
fn migrate_without_prompt(origin: &str) -> Option<StoredSession> {
    use security_framework::item::{ItemClass, ItemSearchOptions, SearchResult};
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainGetUserInteractionAllowed(state: *mut u8) -> i32;
        fn SecKeychainSetUserInteractionAllowed(state: u8) -> i32;
    }
    // Security.framework's interaction flag is process-wide. Serialize migration
    // and restore the previous state on every return, including unwinding.
    static MIGRATION: Mutex<()> = Mutex::new(());
    let _lock = MIGRATION.lock().ok()?;
    let mut previous = 0u8;
    // SAFETY: Security.framework writes one Boolean into a valid pointer.
    if unsafe { SecKeychainGetUserInteractionAllowed(&mut previous) } != 0 {
        return None;
    }
    // SAFETY: disabling UI means denied access fails instead of opening a prompt.
    if unsafe { SecKeychainSetUserInteractionAllowed(0) } != 0 {
        return None;
    }
    struct Restore(u8);
    impl Drop for Restore {
        fn drop(&mut self) {
            // SAFETY: restore the flag read before the migration.
            unsafe {
                SecKeychainSetUserInteractionAllowed(self.0);
            }
        }
    }
    let _restore = Restore(previous);
    let results = ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(SERVICE)
        .account(origin)
        .load_data(true)
        .skip_authenticated_items(true)
        .search()
        .ok()?;
    results.into_iter().find_map(|result| {
        let SearchResult::Data(bytes) = result else { return None };
        serde_json::from_slice::<StoredSession>(&bytes).ok().filter(valid_session)
    })
}

#[cfg(not(target_os = "macos"))]
fn migrate_without_prompt(_origin: &str) -> Option<StoredSession> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn persists_private_origin_scoped_sessions_and_keeps_migration_tombstones() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::path::PathBuf::from("/tmp").join(format!("gloss-session-test-{}", uuid::Uuid::new_v4()));
        let origin = "https://gloss.example";
        let store = Credentials::new(&dir);
        // Seed a tombstone so tests never query a real credential store.
        store.delete(origin);
        let session = StoredSession {
            token: ["abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJ0123-_Q"].concat(),
            cookie_name: "glossy_session".into(),
            owned: true,
        };
        store.save(origin, &session);
        assert_eq!(std::fs::metadata(&store.path).unwrap().permissions().mode() & 0o777, 0o600);
        let restarted = Credentials::new(&dir);
        assert_eq!(restarted.load(origin), Some(session));
        restarted.delete(origin);
        assert_eq!(Credentials::new(&dir).load(origin), None);
        assert!(restarted.read_file().contains_key(origin));
        assert_eq!(restarted.read_file().len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_tokens_and_cookie_names_that_could_inject_headers() {
        let session = StoredSession {
            token: ["abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJ0123-_Q"].concat(),
            cookie_name: "glossy_session; other=x".into(),
            owned: true,
        };
        assert!(!valid_session(&session));
    }

    #[test]
    fn reads_older_sessions_without_a_cookie_name() {
        let old = r#"{"token":"abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_Q","owned":true}"#;
        let session: StoredSession = serde_json::from_str(old).unwrap();
        assert_eq!(session.cookie_name, "glossy_session");
        assert!(session.owned);

        let port_session = StoredSession { cookie_name: "glossy_session_3000".into(), ..session };
        let stored = serde_json::to_string(&port_session).unwrap();
        let read_back: StoredSession = serde_json::from_str(&stored).unwrap();
        assert_eq!(read_back.cookie_name, "glossy_session_3000");
    }

    #[test]
    fn checks_the_server_token_shape() {
        assert!(looks_like_token("abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_Q"));
        assert!(!looks_like_token("too-short"));
        assert!(!looks_like_token("abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_Q="));
        assert!(!looks_like_token("abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-;Q"));
    }
}
