//! Commands the two windows call. Errors are short sentences for the learner.

use tauri::{AppHandle, Manager, State};

use crate::api::{self, Session};
use crate::check::{self, PanelAction, PanelView};
use crate::credentials::{StoredSession, looks_like_token};
use crate::platform::PrivacyPane;
use crate::settings::{self, Settings};
use crate::shortcuts;
use crate::state::{self, AppState, Overview, lock};
use crate::tray;

type CommandResult<T> = Result<T, String>;

#[tauri::command]
pub fn get_overview(state: State<'_, AppState>) -> Overview {
    state.overview()
}

#[tauri::command]
pub async fn refresh_account(app: AppHandle) -> Overview {
    state::refresh_account(&app).await;
    app.state::<AppState>().overview()
}

#[tauri::command]
pub async fn save_server_url(app: AppHandle, url: String) -> CommandResult<Overview> {
    let server = settings::parse_server_url(&url)?;
    let state = app.state::<AppState>();
    let next = Settings { server_url: settings::origin_string(&server), ..state.settings() };
    save(&state, next)?;
    // Sessions are stored per server, so the account view must be re-read.
    state::refresh_account(&app).await;
    Ok(state.overview())
}

#[tauri::command]
pub async fn sign_in_with_invite(app: AppHandle, link: String) -> CommandResult<Overview> {
    let state = app.state::<AppState>();
    let server = state.server();
    let origin = settings::origin_string(&server);
    let invite = api::invite_token_from_input(&link, &server)?;
    let token = state.client.redeem_invite(&server, &invite).await.map_err(|error| error.learner_message(&origin))?;
    replace_session(&app, Session { server, token, owned: true }).await;
    Ok(app.state::<AppState>().overview())
}

/// Uses a session the learner already has, for example from the browser
/// where they opened their invite, so the desktop app and the web editor
/// share one learner.
#[tauri::command]
pub async fn sign_in_with_session(app: AppHandle, token: String) -> CommandResult<Overview> {
    let state = app.state::<AppState>();
    let server = state.server();
    let origin = settings::origin_string(&server);
    let token = token.trim().trim_start_matches(&format!("{}=", api::SESSION_COOKIE)).trim().to_owned();
    if !looks_like_token(&token) {
        return Err("A session value is 43 letters, digits, - or _. Copy the whole value.".into());
    }
    let session = Session { server, token, owned: false };
    match state.client.me(&session).await {
        Ok(_) => {}
        Err(error) if error.is_unauthorized() => {
            return Err(format!("That session is not valid on {origin}. It may have expired."));
        }
        Err(error) => return Err(error.learner_message(&origin)),
    }
    replace_session(&app, session).await;
    Ok(app.state::<AppState>().overview())
}

async fn replace_session(app: &AppHandle, session: Session) {
    let state = app.state::<AppState>();
    let origin = settings::origin_string(&session.server);
    // A previous session this app created is ended, not left behind.
    if let Some(previous) = state.session()
        && previous.owned
        && previous.token != session.token
    {
        let _ = state.client.sign_out(&previous).await;
    }
    state.credentials.save(&origin, &StoredSession { token: session.token.clone(), owned: session.owned });
    state::refresh_account(app).await;
}

#[tauri::command]
pub async fn sign_out(app: AppHandle) -> Overview {
    let state = app.state::<AppState>();
    if let Some(session) = state.session() {
        // Best effort: the local token is forgotten even if the server is down.
        if session.owned {
            let _ = state.client.sign_out(&session).await;
        }
        state.credentials.delete(&state.origin());
    }
    state::refresh_account(&app).await;
    state.overview()
}

#[tauri::command]
pub fn save_shortcuts(app: AppHandle, check: String, dictation: String) -> CommandResult<Overview> {
    shortcuts::apply(&app, &check, &dictation)?;
    let state = app.state::<AppState>();
    let next = Settings {
        check_shortcut: check.trim().to_owned(),
        dictation_shortcut: dictation.trim().to_owned(),
        ..state.settings()
    };
    save(&state, next)?;
    state::publish(&app);
    Ok(state.overview())
}

#[tauri::command]
pub fn suspend_shortcuts(app: AppHandle) {
    shortcuts::suspend(&app);
}

#[tauri::command]
pub fn resume_shortcuts(app: AppHandle) {
    shortcuts::register_saved(&app);
}

fn save(state: &AppState, next: Settings) -> CommandResult<()> {
    state.store.save(&next).map_err(|_| "Settings could not be saved.".to_string())?;
    *lock(&state.settings) = next;
    Ok(())
}

#[tauri::command]
pub fn request_accessibility(state: State<'_, AppState>) -> Overview {
    state.platform.request_accessibility();
    state.platform.open_privacy_settings(PrivacyPane::Accessibility);
    state.overview()
}

#[tauri::command]
pub fn open_microphone_settings(state: State<'_, AppState>) {
    state.platform.open_privacy_settings(PrivacyPane::Microphone);
}

#[tauri::command]
pub fn open_editor(app: AppHandle) {
    tray::open_editor(&app);
}

#[tauri::command]
pub fn panel_state(state: State<'_, AppState>) -> PanelView {
    check::view(&state)
}

#[tauri::command]
pub fn panel_preview(state: State<'_, AppState>, chosen: Vec<String>) -> CommandResult<String> {
    check::preview(&state, &chosen)
}

#[tauri::command]
pub fn panel_apply(app: AppHandle, chosen: Vec<String>) -> CommandResult<()> {
    check::apply(&app, chosen)
}

#[tauri::command]
pub fn panel_copy(app: AppHandle, chosen: Vec<String>) -> CommandResult<()> {
    check::copy(&app, chosen)
}

#[tauri::command]
pub fn panel_fit(app: AppHandle, height: f64) {
    if height.is_finite() {
        crate::windows::fit_panel(&app, height);
    }
}

#[tauri::command]
pub fn panel_dismiss(app: AppHandle) {
    check::dismiss(&app, true);
}

#[tauri::command]
pub fn panel_action(app: AppHandle, action: PanelAction) {
    check::run_action(&app, action);
}
