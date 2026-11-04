//! The menu-bar (macOS) or tray (Windows, Linux) icon and its menu. It is the
//! app's only permanent surface; there is no Dock icon.

use std::thread;
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::state::{AppState, lock};
use crate::{check, dictation, shortcuts, windows};

const ICON: &[u8] = include_bytes!("../icons/tray.png");
const ICON_ACTIVE: &[u8] = include_bytes!("../icons/tray-active.png");

// Cheap handles; they are cloned out of the state so no lock is held while a
// call waits for the main thread.
#[derive(Clone)]
pub struct TrayHandles {
    tray: TrayIcon,
    status: MenuItem<tauri::Wry>,
    check: MenuItem<tauri::Wry>,
    dictate: MenuItem<tauri::Wry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    Idle,
    Listening,
    Transcribing,
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Not signed in", false, None::<&str>)?;
    let check = MenuItem::with_id(app, "check", "Check selected text", true, None::<&str>)?;
    let dictate = MenuItem::with_id(app, "dictate", "Start dictation", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open gloss editor", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit gloss", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &check,
            &dictate,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let tray = TrayIconBuilder::with_id("gloss")
        .icon(Image::from_bytes(ICON)?)
        // A template image follows the menu bar's light or dark appearance.
        .icon_as_template(true)
        .tooltip("gloss")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "check" => check::start(app),
            "dictate" => dictation::toggle(app),
            "open" => open_editor(app),
            "settings" => windows::show_settings(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    *lock(&app.state::<AppState>().tray) = Some(TrayHandles { tray, status, check, dictate });
    refresh(app);
    Ok(())
}

/// Updates the menu texts from the account and the shortcuts.
pub fn refresh(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let account = lock(&state.account).clone();
    let recording = dictation::is_recording(&state);
    let Some(handles) = handles(app) else { return };

    let status = match (account.signed_in, account.display_name) {
        (true, Some(name)) => format!("Signed in as {name}"),
        (true, None) => "Signed in".to_string(),
        (false, _) => "Not signed in".to_string(),
    };
    let _ = handles.status.set_text(status);
    // Shown at the right edge of the menu; it is not registered from here.
    let _ = handles.check.set_accelerator(Some(settings.check_shortcut.as_str()));
    let dictate = if recording {
        "Stop dictation".to_string()
    } else {
        format!("Start dictation (or hold {})", shortcuts::label(&settings.dictation_shortcut))
    };
    let _ = handles.dictate.set_text(dictate);
}

pub fn set_activity(app: &AppHandle, activity: Activity) {
    let (title, icon) = match activity {
        Activity::Idle => (None, ICON),
        Activity::Listening => (Some("Listening…"), ICON_ACTIVE),
        Activity::Transcribing => (Some("Transcribing…"), ICON_ACTIVE),
    };
    show(app, title, icon);
    refresh(app);
}

/// A short status next to the icon that clears itself.
pub fn flash(app: &AppHandle, message: &'static str) {
    show(app, Some(message), ICON);
    refresh(app);
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(2500));
        let state = app.state::<AppState>();
        if !dictation::is_recording(&state) {
            show(&app, None, ICON);
        }
    });
}

fn handles(app: &AppHandle) -> Option<TrayHandles> {
    lock(&app.state::<AppState>().tray).clone()
}

fn show(app: &AppHandle, title: Option<&str>, icon: &[u8]) {
    let Some(handles) = handles(app) else { return };
    // The title appears next to the icon on macOS and Linux; Windows shows
    // the tooltip instead.
    let _ = handles.tray.set_title(title);
    let _ = handles.tray.set_tooltip(Some(title.map(|t| format!("gloss: {t}")).unwrap_or_else(|| "gloss".into())));
    if let Ok(image) = Image::from_bytes(icon) {
        let _ = handles.tray.set_icon(Some(image));
        let _ = handles.tray.set_icon_as_template(true);
    }
}

pub fn open_editor(app: &AppHandle) {
    let origin = app.state::<AppState>().origin();
    if app.opener().open_url(format!("{origin}/"), None::<&str>).is_err() {
        log::warn!("could not open the editor in the browser");
    }
}
