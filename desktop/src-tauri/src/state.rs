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
    /// While the shortcut is held and the microphone is starting.
    pub shortcut_pressed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub settings: Settings,
    pub account: AccountView,
    pub os: &'static str,
    pub accessibility: Permission,
    pub shortcut_error: Option<String>,
    /// What the app knows about the permission the key monitor needs.
    pub input_monitoring: crate::push_to_talk::MonitorState,
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
        // A development cookie name no longer fits a production server (and
        // the other way round): the session is read with the name the server
        // uses for this address, which `getSessionCookieName` derives the same
        // way. A refusal then starts a fresh guest.
        let cookie_name = match (stored.cookie_name.as_str(), server.port()) {
            ("glossy_session_3000", Some(3000)) => "glossy_session".to_owned(),
            (name, _) => name.to_owned(),
        };
        Some(Session { server, token: stored.token, cookie_name, owned: stored.owned })
    }

    /// The session, or a new guest when the stored one no longer works. A
    /// server that changes its cookie name (a production build without the
    /// port suffix) or loses the guest must not leave the app stuck.
    pub async fn session_or_guest(&self) -> Option<Session> {
        let Some(session) = self.session() else {
            self.create_guest().await?;
            return self.session();
        };
        match self.client.me(&session).await {
            Err(error) if error.is_unauthorized() => {
                log::info!("[gloss] stored session refused ({}); creating a guest", session.cookie_name);
                self.credentials.delete(&settings::origin_string(&session.server));
                self.create_guest().await?;
                self.session()
            }
            _ => Some(session),
        }
    }

    /// Creates this app's guest workspace and stores the session it sets.
    pub async fn create_guest(&self) -> Option<Session> {
        let server = self.server();
        let origin = settings::origin_string(&server);
        match self.client.create_guest(&server).await {
            Ok((cookie_name, token)) => {
                log::info!("[gloss] guest workspace created (cookie {cookie_name})");
                self.credentials.save(&origin, &crate::credentials::StoredSession {
                    token: token.clone(),
                    cookie_name: cookie_name.clone(),
                    owned: true,
                });
                Some(Session { server, token, cookie_name, owned: true })
            }
            Err(error) => {
                log::info!("[gloss] guest workspace not created: {}", error.learner_message(&origin));
                None
            }
        }
    }

    /// Runs `change` on the account view and tells the windows, so a live
    /// state (the key being held) reaches the settings window at once.
    pub fn update_account(&self, change: impl FnOnce(&mut AccountView)) {
        change(&mut lock(&self.account));
    }

    pub fn overview(&self) -> Overview {
        Overview {
            settings: self.settings(),
            account: lock(&self.account).clone(),
            os: platform::os_name(),
            accessibility: self.platform.accessibility(),
            shortcut_error: lock(&self.shortcuts).error.clone(),
            input_monitoring: crate::push_to_talk::state(),
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
                    notice: Some("Your workspace has ended. Start a new one under Advanced.".into()),
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
        Some("This workspace uses your own OpenRouter key, which the desktop app cannot send yet.".into())
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
        ..AccountView::default()
    }
}

/// A session that works: the stored one, or a fresh guest when the server
/// refused it (a cookie name changed by a production build, a guest that
/// expired). `None` only when no workspace can be had at all.
pub async fn working_session(state: &AppState) -> Option<Session> {
    let session = state.session_or_guest().await?;
    state.credentials.save(
        &settings::origin_string(&session.server),
        &crate::credentials::StoredSession {
            token: session.token.clone(),
            cookie_name: session.cookie_name.clone(),
            owned: session.owned,
        },
    );
    Some(session)
}

/// After a request answered `unauthorized`, the stored token is useless.
pub fn forget_session_if_unauthorized(app: &AppHandle, error: &ApiError) {
    if !error.is_unauthorized() {
        return;
    }
    let state = app.state::<AppState>();
    state.credentials.delete(&state.origin());
    *lock(&state.account) = AccountView {
        notice: Some("Your workspace has ended. Start a new one under Advanced.".into()),
        remembered: state.credentials.is_persistent(),
        ..AccountView::default()
    };
    publish(app);
}
