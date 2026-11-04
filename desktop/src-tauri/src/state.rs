//! Everything the app keeps while it runs, plus the account view the
//! settings window shows.

use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

use crate::api::{self, ApiError, QuotaState, Session};
use crate::check::PanelSession;
use crate::credentials::Credentials;
use crate::dictation::DictationSession;
use crate::platform::{self, Permission, Platform};
use crate::settings::{self, Settings, SettingsStore};
use crate::shortcuts::Registered;
use crate::tray::TrayHandles;

pub struct AppState {
    pub store: SettingsStore,
    pub settings: Mutex<Settings>,
    pub credentials: Credentials,
    pub client: api::Client,
    pub platform: Arc<dyn Platform>,
    pub account: Mutex<AccountView>,
    pub panel: Mutex<PanelSession>,
    pub dictation: Mutex<DictationSession>,
    pub shortcuts: Mutex<Registered>,
    pub tray: Mutex<Option<TrayHandles>>,
}

/// Locks a mutex even if a thread panicked while holding it: the data is
/// plain state that stays usable.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub signed_in: bool,
    pub display_name: Option<String>,
    pub access_mode: Option<String>,
    pub ai_enabled: Option<bool>,
    pub checks: Option<QuotaState>,
    pub dictation_seconds: Option<QuotaState>,
    /// Something the learner should know, such as an unreachable server.
    pub notice: Option<String>,
    /// False when the session only lasts until the app quits.
    pub remembered: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub settings: Settings,
    pub account: AccountView,
    pub os: &'static str,
    pub accessibility: Permission,
    pub shortcut_error: Option<String>,
    pub version: &'static str,
}

impl AppState {
    pub fn new(store: SettingsStore) -> Self {
        let settings = store.load();
        Self {
            store,
            settings: Mutex::new(settings),
            credentials: Credentials::new(),
            client: api::Client::new(),
            platform: platform::current(),
            account: Mutex::new(AccountView::default()),
            panel: Mutex::new(PanelSession::default()),
            dictation: Mutex::new(DictationSession::default()),
            shortcuts: Mutex::new(Registered::default()),
            tray: Mutex::new(None),
        }
    }

    pub fn settings(&self) -> Settings {
        lock(&self.settings).clone()
    }

    pub fn server(&self) -> Url {
        settings::parse_server_url(&self.settings().server_url)
            .unwrap_or_else(|_| Url::parse(settings::DEFAULT_SERVER_URL).expect("default server URL is valid"))
    }

    pub fn origin(&self) -> String {
        settings::origin_string(&self.server())
    }

    pub fn session(&self) -> Option<Session> {
        let server = self.server();
        let stored = self.credentials.load(&settings::origin_string(&server))?;
        Some(Session { server, token: stored.token, cookie_name: stored.cookie_name, owned: stored.owned })
    }

    pub fn overview(&self) -> Overview {
        Overview {
            settings: self.settings(),
            account: lock(&self.account).clone(),
            os: platform::os_name(),
            accessibility: self.platform.accessibility(),
            shortcut_error: lock(&self.shortcuts).error.clone(),
            version: env!("CARGO_PKG_VERSION"),
        }
    }
}

/// Tells the settings window and the tray that something changed.
pub fn publish(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _ = app.emit_to("settings", "overview", state.overview());
    crate::tray::refresh(app);
}

/// Asks the server who the stored session belongs to and updates the view.
pub async fn refresh_account(app: &AppHandle) {
    let state = app.state::<AppState>();
    let origin = state.origin();
    let view = match state.session() {
        None => AccountView { remembered: state.credentials.is_persistent(), ..AccountView::default() },
        Some(session) => match state.client.me(&session).await {
            Ok(me) => signed_in_view(&me, state.credentials.is_persistent()),
            Err(error) if error.is_unauthorized() => {
                state.credentials.delete(&origin);
                AccountView {
                    notice: Some("Your session has ended. Paste a new invite link to sign in again.".into()),
                    remembered: state.credentials.is_persistent(),
                    ..AccountView::default()
                }
            }
            Err(error) => {
                let previous = lock(&state.account).clone();
                AccountView {
                    signed_in: true,
                    notice: Some(error.learner_message(&origin)),
                    remembered: state.credentials.is_persistent(),
                    ..previous
                }
            }
        },
    };
    *lock(&state.account) = view;
    publish(app);
}

fn signed_in_view(me: &api::MeResponse, remembered: bool) -> AccountView {
    let notice = if me.access_mode == "byok" {
        Some("This is a visitor workspace that uses your own OpenRouter key. The desktop app cannot send that key yet, so sign in with an invite link to use cloud checks.".into())
    } else if !me.ai_enabled {
        Some("Cloud checking is switched off on this server right now.".into())
    } else {
        None
    };
    AccountView {
        signed_in: true,
        display_name: Some(me.learner.display_name.clone()),
        access_mode: Some(me.access_mode.clone()),
        ai_enabled: Some(me.ai_enabled),
        checks: me.quotas.get("proofread").copied(),
        dictation_seconds: me.quotas.get("asrSeconds").copied(),
        notice,
        remembered,
    }
}

/// After a request answered `unauthorized`, the stored token is useless.
pub fn forget_session_if_unauthorized(app: &AppHandle, error: &ApiError) {
    if !error.is_unauthorized() {
        return;
    }
    let state = app.state::<AppState>();
    state.credentials.delete(&state.origin());
    *lock(&state.account) = AccountView {
        notice: Some("Your session has ended. Paste a new invite link to sign in again.".into()),
        remembered: state.credentials.is_persistent(),
        ..AccountView::default()
    };
    publish(app);
}
