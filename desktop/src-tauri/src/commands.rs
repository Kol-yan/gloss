//! Commands the two windows call. Errors are short sentences for the learner.

use tauri::{AppHandle, Manager, State};

use crate::check::{self, PanelAction, PanelView};
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
    // The new server may not know this app yet, so it gets its own workspace.
    ensure_guest(&app).await;
    state::refresh_account(&app).await;
    Ok(state.overview())
}

/// Creates this app's guest workspace on the server when there is no session
/// for its address yet. There is no sign-in: the same guest learner the
/// website gives a first visitor, under the same per-IP limit and caps.
pub async fn ensure_guest(app: &AppHandle) {
    let state = app.state::<AppState>();
    let origin = settings::origin_string(&state.server());
    log::info!("[gloss] checking the workspace for {origin}");
    // A stored session is used when it still works; otherwise (a server that
    // changed its cookie name, an expired guest) a new guest is created.
    if state.session_or_guest().await.is_none() {
        *lock(&state.account) = state::AccountView {
            notice: Some("Can't reach the gloss server. Check your connection and try again.".into()),
            remembered: state.credentials.is_persistent(),
            ..state::AccountView::default()
        };
    }
}

/// Starts over with a fresh guest workspace, for example when today's demo
/// allowance is used up.
#[tauri::command]
pub async fn reset_workspace(app: AppHandle) -> Overview {
    let state = app.state::<AppState>();
    // Best effort: the old session is ended on the server when it can be reached.
    if let Some(session) = state.session()
        && session.owned
    {
        let _ = state.client.sign_out(&session).await;
    }
    state.credentials.delete(&state.origin());
    if state.create_guest().await.is_none() {
        log::info!("[gloss] new workspace could not be created");
    }
    state::refresh_account(&app).await;
    state.overview()
}

#[tauri::command]
pub fn save_shortcuts(app: AppHandle, check: String, dictation: String) -> CommandResult<Overview> {
    let dictation = dictation.trim().to_owned();
    let state = app.state::<AppState>();
    let previous = state.settings();
    // The right Option key is watched by the monitor, not registered as a
    // global shortcut, so it is not parsed here.
    shortcuts::apply(&app, &check, &dictation)?;
    let next =
        Settings { check_shortcut: check.trim().to_owned(), dictation_shortcut: dictation.clone(), ..previous.clone() };
    if let Err(error) = save(&state, next) {
        // Put the old shortcuts back rather than leaving them half applied.
        let _ = shortcuts::apply(&app, &previous.check_shortcut, &previous.dictation_shortcut);
        crate::push_to_talk::start(&app, &previous.dictation_shortcut);
        return Err(error);
    }
    crate::push_to_talk::start(&app, &dictation);
    state::publish(&app);
    Ok(state.overview())
}

/// Switches checking as the learner types on or off.
#[tauri::command]
pub fn set_check_as_you_type(app: AppHandle, enabled: bool) -> Overview {
    let state = app.state::<AppState>();
    let next = Settings { check_as_you_type: enabled, ..state.settings() };
    if let Err(error) = save(&state, next) {
        log::warn!("[gloss] check-as-you-type setting not saved: {error}");
    }
    crate::auto_check::runtime::settings_changed(&app);
    state.overview()
}

/// Manual check of the automatic checking: uses `text` as the field's text.
#[tauri::command]
pub fn simulate_typing(app: AppHandle, text: String) {
    crate::auto_check::runtime::simulate_typing(&app, &text);
}

/// Opens the panel for the field the automatic checker last saw.
#[tauri::command]
pub fn open_last_field(app: AppHandle) {
    crate::auto_check::runtime::badge_click(&app);
}

/// Test hook: applies every default suggestion through Accessibility, the
/// way the panel's Apply does, and reports the field text afterwards.
#[tauri::command]
pub fn apply_last_fixes(app: AppHandle) -> Result<String, String> {
    crate::check::apply_default_fixes(&app)
}

/// The badge was clicked: show the panel for the field it sits next to.
#[tauri::command]
pub fn badge_click(app: AppHandle) {
    crate::auto_check::runtime::badge_click(&app);
}

/// Records whether the dictation key is the right Option monitor; the
/// settings window shows a live line while it is held.
#[tauri::command]
pub fn shortcut_pressed(state: State<'_, AppState>) -> bool {
    state.overview().account.shortcut_pressed
}

#[tauri::command]
pub fn suspend_shortcuts(app: AppHandle) -> CommandResult<()> {
    // The Option monitor already ignores events in this app's windows.
    shortcuts::suspend(&app)
}

#[tauri::command]
pub fn resume_shortcuts(app: AppHandle) -> CommandResult<Overview> {
    // Coming back from recording a key: register what is saved again.
    crate::push_to_talk::start(&app, &app.state::<AppState>().settings().dictation_shortcut);
    let settings = app.state::<AppState>().settings();
    shortcuts::apply(&app, &settings.check_shortcut, &settings.dictation_shortcut)?;
    Ok(app.state::<AppState>().overview())
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
