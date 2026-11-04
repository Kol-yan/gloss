//! Session tokens live in the operating system's credential store (Keychain on
//! macOS, Credential Manager on Windows, Secret Service on Linux), one entry per
//! server origin, so a token is only ever sent to the server that issued it.
//! Without a usable store the token is kept in memory for this run only.

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
    memory: Mutex<HashMap<String, StoredSession>>,
    // Set once the system store fails, so later calls do not retry a broken store.
    store_unavailable: AtomicBool,
}

impl Credentials {
    pub fn new() -> Self {
        Self { memory: Mutex::new(HashMap::new()), store_unavailable: AtomicBool::new(false) }
    }

    /// False when tokens only last until the app quits.
    pub fn is_persistent(&self) -> bool {
        !self.store_unavailable.load(Ordering::Relaxed)
    }

    pub fn load(&self, origin: &str) -> Option<StoredSession> {
        if let Some(session) = self.memory.lock().ok().and_then(|map| map.get(origin).cloned()) {
            return Some(session);
        }
        if !self.is_persistent() {
            return None;
        }
        match keyring::Entry::new(SERVICE, origin).and_then(|entry| entry.get_password()) {
            Ok(stored) => {
                let session =
                    serde_json::from_str::<StoredSession>(&stored).ok().filter(|s| looks_like_token(&s.token))?;
                self.remember(origin, &session);
                Some(session)
            }
            Err(keyring::Error::NoEntry) => None,
            Err(error) => {
                self.mark_unavailable(&error);
                None
            }
        }
    }

    pub fn save(&self, origin: &str, session: &StoredSession) {
        self.remember(origin, session);
        if !self.is_persistent() {
            return;
        }
        let Ok(stored) = serde_json::to_string(session) else { return };
        if let Err(error) = keyring::Entry::new(SERVICE, origin).and_then(|entry| entry.set_password(&stored)) {
            self.mark_unavailable(&error);
        }
    }

    pub fn delete(&self, origin: &str) {
        if let Ok(mut map) = self.memory.lock() {
            map.remove(origin);
        }
        if !self.is_persistent() {
            return;
        }
        match keyring::Entry::new(SERVICE, origin).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => self.mark_unavailable(&error),
        }
    }

    fn remember(&self, origin: &str, session: &StoredSession) {
        if let Ok(mut map) = self.memory.lock() {
            map.insert(origin.to_owned(), session.clone());
        }
    }

    fn mark_unavailable(&self, error: &keyring::Error) {
        // The variant name is enough to diagnose; platform details may include
        // account names.
        let kind = format!("{error:?}");
        let kind = kind.split(['(', ' ', '{']).next().unwrap_or("unknown");
        log::warn!("system credential store unavailable ({kind}); keeping the session in memory");
        self.store_unavailable.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
