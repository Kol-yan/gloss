//! The two global shortcuts: check the selection, and hold to dictate.

use std::str::FromStr;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::settings::PUSH_TO_TALK_DICTATION;
use crate::state::{AppState, lock};
use crate::{check, dictation};

#[derive(Default)]
pub struct Registered {
    check: Option<u32>,
    dictation: Option<u32>,
    /// Why the saved shortcuts could not be registered, for the settings window.
    pub error: Option<String>,
}

pub fn parse(accelerator: &str) -> Result<Shortcut, String> {
    let shortcut = Shortcut::from_str(accelerator.trim()).map_err(|_| {
        format!("“{}” is not a shortcut gloss understands. Try something like Control+Alt+G.", accelerator.trim())
    })?;
    if shortcut.mods.is_empty() {
        return Err("Add at least one modifier key, such as Control or Alt, so typing is not interrupted.".into());
    }
    Ok(shortcut)
}

/// Registers both shortcuts, replacing the previous ones. On failure the
/// previous shortcuts stay registered.
pub fn apply(app: &AppHandle, check_accelerator: &str, dictation_accelerator: &str) -> Result<(), String> {
    let check = parse(check_accelerator)?;
    // The right Option key is watched by its own monitor (see
    // `crate::push_to_talk`), so it is not a global shortcut.
    if dictation_accelerator.trim().eq_ignore_ascii_case(PUSH_TO_TALK_DICTATION) {
        return apply_one(app, check, None);
    }
    let dictate = parse(dictation_accelerator)?;
    apply_both(app, check, dictate)
}

fn apply_both(app: &AppHandle, check: Shortcut, dictate: Shortcut) -> Result<(), String> {
    apply_one(app, check, Some(dictate))
}

fn apply_one(app: &AppHandle, check: Shortcut, dictate: Option<Shortcut>) -> Result<(), String> {
    if dictate.is_some_and(|dictate| check.id() == dictate.id()) {
        return Err("Use two different shortcuts for checking and dictation.".into());
    }

    let manager = app.global_shortcut();
    let state = app.state::<AppState>();
    let previous: Vec<Shortcut> = [state.settings().check_shortcut, state.settings().dictation_shortcut]
        .iter()
        .filter_map(|accelerator| parse(accelerator).ok())
        .collect();
    let _ = manager.unregister_all();

    let mut registered = manager.register(check);
    if registered.is_ok()
        && let Some(dictate) = dictate
    {
        registered = manager.register(dictate);
    }
    if registered.is_err() {
        let _ = manager.unregister_all();
        for shortcut in previous {
            let _ = manager.register(shortcut);
        }
        return Err("That shortcut is already used by another app. Choose a different one.".into());
    }
    let mut current = lock(&state.shortcuts);
    current.check = Some(check.id());
    current.dictation = dictate.map(|dictate| dictate.id());
    current.error = None;
    log::info!("[gloss] shortcuts registered");
    Ok(())
}

/// Registers the saved shortcuts at start-up and records any problem.
pub fn register_saved(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings();
    // The system reports a shortcut as registered even when another app
    // holds it, so a pressed shortcut that logs nothing means it never
    // reached gloss. Per key press `handle` logs the event id.
    log::info!(
        "[gloss] registering shortcuts: check {} ({}), dictate {}",
        label(&settings.check_shortcut),
        parse(&settings.check_shortcut).map(|shortcut| shortcut.id()).map_or("invalid".to_string(), |id| id.to_string()),
        label(&settings.dictation_shortcut),
    );
    if let Err(error) = apply(app, &settings.check_shortcut, &settings.dictation_shortcut) {
        log::warn!("[gloss] saved shortcuts could not be registered: {error}");
        lock(&state.shortcuts).error = Some(error);
    }
}

/// Pauses both shortcuts while the settings window records new keys.
pub fn suspend(app: &AppHandle) {
    let _ = app.global_shortcut().unregister_all();
    let state = app.state::<AppState>();
    let mut current = lock(&state.shortcuts);
    current.check = None;
    current.dictation = None;
}

pub fn handle(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    let state = app.state::<AppState>();
    if event.state() == ShortcutState::Pressed {
        log::info!("[gloss] shortcut event id {}", shortcut.id());
    }
    let (check_id, dictation_id) = {
        let current = lock(&state.shortcuts);
        (current.check, current.dictation)
    };
    let id = Some(shortcut.id());
    if id == check_id && event.state() == ShortcutState::Pressed {
        check::start(app);
    } else if id == dictation_id {
        match event.state() {
            ShortcutState::Pressed => dictation::on_press(app),
            ShortcutState::Released => dictation::on_release(app),
        }
    }
}

/// A shortcut as people read it: "⌃⌥G" on macOS, "Ctrl+Alt+G" elsewhere.
pub fn label(accelerator: &str) -> String {
    label_for(accelerator, cfg!(target_os = "macos"))
}

fn label_for(accelerator: &str, mac: bool) -> String {
    if accelerator.trim().eq_ignore_ascii_case(PUSH_TO_TALK_DICTATION) {
        return if mac { "Right Option".into() } else { "Right Alt".into() };
    }
    let mut modifiers = Vec::new();
    let mut key = String::new();
    for token in accelerator.split('+').map(str::trim).filter(|t| !t.is_empty()) {
        let upper = token.to_uppercase();
        let modifier = match upper.as_str() {
            "CONTROL" | "CTRL" => Some((0, if mac { "⌃" } else { "Ctrl" })),
            "OPTION" | "ALT" => Some((1, if mac { "⌥" } else { "Alt" })),
            "SHIFT" => Some((2, if mac { "⇧" } else { "Shift" })),
            "COMMAND" | "CMD" | "SUPER" => Some((3, if mac { "⌘" } else { "Super" })),
            "COMMANDORCONTROL" | "COMMANDORCTRL" | "CMDORCTRL" | "CMDORCONTROL" => {
                Some(if mac { (3, "⌘") } else { (0, "Ctrl") })
            }
            _ => None,
        };
        match modifier {
            Some(modifier) => modifiers.push(modifier),
            None => key = key_label(token),
        }
    }
    modifiers.sort_by_key(|(order, _)| *order);
    modifiers.dedup();
    let mut parts: Vec<String> = modifiers.into_iter().map(|(_, text)| text.to_string()).collect();
    parts.push(key);
    if mac { parts.concat() } else { parts.join("+") }
}

fn key_label(token: &str) -> String {
    let upper = token.to_uppercase();
    if let Some(letter) = upper.strip_prefix("KEY").filter(|rest| rest.len() == 1) {
        return letter.to_string();
    }
    if let Some(digit) = upper.strip_prefix("DIGIT").filter(|rest| rest.len() == 1) {
        return digit.to_string();
    }
    match upper.as_str() {
        "SPACE" => "Space".into(),
        "ENTER" => "Return".into(),
        "PERIOD" => ".".into(),
        "COMMA" => ",".into(),
        "SLASH" => "/".into(),
        "SEMICOLON" => ";".into(),
        "QUOTE" => "'".into(),
        _ if upper.len() == 1 => upper,
        _ => token.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{DEFAULT_CHECK_SHORTCUT, DEFAULT_DICTATION_SHORTCUT};

    #[test]
    fn parses_the_defaults_and_requires_a_modifier() {
        assert!(parse(DEFAULT_CHECK_SHORTCUT).is_ok());
        assert!(parse(DEFAULT_DICTATION_SHORTCUT).is_ok());
        assert_ne!(parse(DEFAULT_CHECK_SHORTCUT).unwrap().id(), parse(DEFAULT_DICTATION_SHORTCUT).unwrap().id());
        assert!(parse("G").is_err());
        assert!(parse("Control+Alt+").is_err());
        assert!(parse("Hyper+G").is_err());
    }

    #[test]
    fn reads_and_labels_the_push_to_talk_key() {
        assert_eq!(label_for(PUSH_TO_TALK_DICTATION, true), "Right Option");
        assert!(parse(PUSH_TO_TALK_DICTATION).is_err(), "it is not a global shortcut");
        assert_eq!(label("Control+Alt+G"), "⌃⌥G");
    }

    #[test]
    fn labels_shortcuts_per_platform() {
        assert_eq!(label_for("Control+Alt+G", true), "⌃⌥G");
        assert_eq!(label_for("Control+Alt+G", false), "Ctrl+Alt+G");
        assert_eq!(label_for("Shift+CommandOrControl+KeyK", true), "⇧⌘K");
        assert_eq!(label_for("Shift+CommandOrControl+KeyK", false), "Ctrl+Shift+K");
        assert_eq!(label_for("Alt+Space", false), "Alt+Space");
    }
}
