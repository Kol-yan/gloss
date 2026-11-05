//! Settings the learner can change, stored as JSON in the app's config folder.
//! Credentials never go here; see `credentials.rs`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use url::{Host, Url};

// A release build talks to the public server; a debug build to this computer.
pub const DEFAULT_SERVER_URL: &str =
    if cfg!(debug_assertions) { "http://localhost:3000" } else { "https://gloss.li" };
// Control+Option on macOS and Control+Alt elsewhere are rarely taken by
// system or app shortcuts, and the same keys work on every platform.
pub const DEFAULT_CHECK_SHORTCUT: &str = "Control+Alt+G";
// macOS dictates with a push-to-talk monitor of the right Option key (see
// `push_to_talk`), so the shortcut is only the fallback everywhere else.
pub const DEFAULT_DICTATION_SHORTCUT: &str = "Control+Alt+D";
// The push-to-talk accelerator, kept in settings so old files keep loading; a
// stored Control+Alt+D is replaced by the right Option key on macOS.
pub const PUSH_TO_TALK_DICTATION: &str = "RightOption";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Origin of the gloss server, without a trailing slash.
    pub server_url: String,
    pub check_shortcut: String,
    pub dictation_shortcut: String,
    /// Check text while the learner types in another app.
    #[serde(default = "default_true")]
    pub check_as_you_type: bool,
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server_url: DEFAULT_SERVER_URL.to_owned(),
            check_shortcut: DEFAULT_CHECK_SHORTCUT.to_owned(),
            dictation_shortcut: default_dictation_shortcut(),
            check_as_you_type: true,
        }
    }
}

// macOS uses the push-to-talk monitor of the right Option key; other
// platforms keep the shortcut that works with the global shortcut plugin.
pub fn default_dictation_shortcut() -> String {
    if cfg!(target_os = "macos") { PUSH_TO_TALK_DICTATION } else { DEFAULT_DICTATION_SHORTCUT }.to_owned()
}

/// Accepts an HTTPS origin, or HTTP on this computer only: the session token
/// travels with every request and must not cross a network in clear text.
/// Paths, queries, fragments and embedded credentials are rejected, the same
/// rule the browser extension applies to its editor address.
pub fn parse_server_url(input: &str) -> Result<Url, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Enter the address of your gloss server.".into());
    }
    let url = Url::parse(trimmed).map_err(|_| "Enter a full address, such as http://localhost:3000.".to_string())?;
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(&url) => {}
        "http" => return Err("Use https:// for a server on another computer.".into()),
        _ => return Err("The address must start with https:// or http://.".into()),
    }
    if url.host().is_none() {
        return Err("The address needs a host name.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Leave sign-in details out of the address.".into());
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("Enter only the server address, without a path.".into());
    }
    // The origin keeps scheme, host and a non-default port only.
    Url::parse(&url.origin().ascii_serialization()).map_err(|_| "That address is not valid.".into())
}

/// The origin string used as the settings value and the credential key.
pub fn origin_string(url: &Url) -> String {
    url.origin().ascii_serialization()
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join("settings.json") }
    }

    /// A missing or unreadable file gives the defaults; a value that no
    /// longer validates falls back to its default rather than blocking start.
    pub fn load(&self) -> Settings {
        let existed = self.path.exists();
        let mut settings: Settings =
            fs::read(&self.path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        match parse_server_url(&settings.server_url) {
            Ok(url) => settings.server_url = origin_string(&url),
            Err(_) => settings.server_url = DEFAULT_SERVER_URL.to_owned(),
        }
        if cfg!(target_os = "macos") && settings.dictation_shortcut == "Control+Alt+D" {
            settings.dictation_shortcut = PUSH_TO_TALK_DICTATION.to_owned();
        }
        // An older file can hold the development server address; a release
        // build starts on the public server instead.
        if existed && !cfg!(debug_assertions) && settings.server_url == "http://localhost:3000" {
            settings.server_url = DEFAULT_SERVER_URL.to_owned();
        }
        settings
    }

    /// Writes a temporary file and renames it, so a crash never leaves half a file.
    pub fn save(&self, settings: &Settings) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        {
            let mut file = fs::File::create(&tmp)?;
            file.write_all(&serde_json::to_vec_pretty(settings)?)?;
            file.sync_all()?;
        }
        fs::rename(&tmp, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_and_loopback_http() {
        assert_eq!(origin_string(&parse_server_url("http://localhost:3000").unwrap()), "http://localhost:3000");
        assert_eq!(origin_string(&parse_server_url(" http://127.0.0.1:3000/ ").unwrap()), "http://127.0.0.1:3000");
        assert_eq!(origin_string(&parse_server_url("http://[::1]:8080").unwrap()), "http://[::1]:8080");
        assert_eq!(origin_string(&parse_server_url("https://gloss.example").unwrap()), "https://gloss.example");
        assert_eq!(origin_string(&parse_server_url("HTTPS://Gloss.Example:443/").unwrap()), "https://gloss.example");
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_addresses() {
        for input in [
            "",
            "localhost:3000",
            "http://192.168.1.20:3000",
            "http://gloss.example",
            "ftp://gloss.example",
            "https://user:pass@gloss.example",
            "https://gloss.example/app",
            "https://gloss.example/?x=1",
            "https://gloss.example/#text",
            "file:///tmp/gloss",
        ] {
            assert!(parse_server_url(input).is_err(), "accepted {input:?}");
        }
    }

    #[test]
    fn loads_defaults_and_survives_bad_files() {
        let dir = std::env::temp_dir().join(format!("gloss-settings-{}", uuid::Uuid::new_v4()));
        let store = SettingsStore::new(&dir);
        assert_eq!(store.load(), Settings::default());

        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("settings.json"), b"{ not json").unwrap();
        assert_eq!(store.load(), Settings::default());

        fs::write(dir.join("settings.json"), br#"{"serverUrl":"http://evil.example"}"#).unwrap();
        assert_eq!(store.load().server_url, DEFAULT_SERVER_URL);
        // A file from an older build gets the right Option key on macOS.
        fs::write(dir.join("settings.json"), br#"{"dictationShortcut":"Control+Alt+D"}"#).unwrap();
        let migrated = store.load().dictation_shortcut;
        assert_eq!(migrated, if cfg!(target_os = "macos") { PUSH_TO_TALK_DICTATION } else { DEFAULT_DICTATION_SHORTCUT });

        let custom = Settings {
            server_url: "https://gloss.example".into(),
            check_shortcut: "Alt+Shift+K".into(),
            dictation_shortcut: default_dictation_shortcut(),
            check_as_you_type: true,
        };
        store.save(&custom).unwrap();
        assert_eq!(store.load(), custom);
        fs::remove_dir_all(&dir).unwrap();
    }
}
