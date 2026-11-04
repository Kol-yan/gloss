//! The check shortcut: take the selection from the focused app, send it to
//! `POST /api/proofread`, show the suggestions in the floating panel, and
//! paste the corrected text back when the learner applies them.

use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::api::{ProofreadResponse, QuotaState, Session, Suggestion};
use crate::platform::{FocusedApp, PrivacyPane};
use crate::selection::{self, CaptureError};
use crate::shortcuts;
use crate::state::{self, AppState, lock};
use crate::text::{self, Edit, MAX_TEXT_UTF16};
use crate::windows;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PanelAction {
    OpenSettings,
    GrantAccessibility,
    OpenMicrophoneSettings,
}

/// What the panel shows. The panel window renders exactly this.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum PanelView {
    #[default]
    Idle,
    #[serde(rename_all = "camelCase")]
    Checking { preview: String },
    #[serde(rename_all = "camelCase")]
    Ready { text: String, suggestions: Vec<Suggestion>, quota: QuotaState },
    #[serde(rename_all = "camelCase")]
    Notice { title: String, detail: String, action: Option<PanelAction> },
}

struct CheckResult {
    text: String,
    response: ProofreadResponse,
    session: Session,
}

#[derive(Default)]
pub struct PanelSession {
    // Bumped by every new check and every dismissal; work that finishes for
    // an older generation is dropped.
    generation: u64,
    view: PanelView,
    focus: Option<FocusedApp>,
    result: Option<CheckResult>,
}

pub fn view(state: &AppState) -> PanelView {
    lock(&state.panel).view.clone()
}

/// Called by the shortcut and the tray menu.
pub fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    let platform = state.platform.clone();
    let focus = platform.focused_app();

    // Pressing the shortcut while the panel has focus closes it.
    if let Some(app_focus) = focus
        && platform.is_own_app(app_focus)
    {
        if windows::panel_visible(app) {
            dismiss(app, true);
        } else {
            let key = shortcuts::label(&state.settings().check_shortcut);
            notice(
                app,
                next_generation(&state, None),
                "Select text in another app",
                &format!("gloss checks text you select in other apps. Select some, then press {key}."),
                None,
            );
        }
        return;
    }

    let generation = next_generation(&state, focus);
    let app = app.clone();
    thread::spawn(move || run(app, generation));
}

fn next_generation(state: &AppState, focus: Option<FocusedApp>) -> u64 {
    let mut panel = lock(&state.panel);
    panel.generation += 1;
    panel.focus = focus;
    panel.result = None;
    panel.generation
}

fn run(app: AppHandle, generation: u64) {
    let state = app.state::<AppState>();
    let key = shortcuts::label(&state.settings().check_shortcut);

    let Some(session) = state.session() else {
        notice(
            &app,
            generation,
            "Sign in to check text",
            "Open gloss settings and paste your invite link.",
            Some(PanelAction::OpenSettings),
        );
        return;
    };

    let captured = match selection::capture(state.platform.as_ref()) {
        Ok(text) => text,
        Err(CaptureError::PermissionNeeded) => {
            notice(
                &app,
                generation,
                "Allow gloss to read your selection",
                "Turn on gloss in System Settings → Privacy & Security → Accessibility, then try again.",
                Some(PanelAction::GrantAccessibility),
            );
            return;
        }
        Err(CaptureError::NothingSelected) => {
            notice(
                &app,
                generation,
                "Select some text first",
                &format!("Highlight the text you want to check, then press {key}."),
                None,
            );
            return;
        }
        Err(CaptureError::Failed) => {
            notice(
                &app,
                generation,
                "Couldn't read the selection",
                "Copy the text into the gloss editor to check it there.",
                None,
            );
            return;
        }
    };

    let text = text::normalize(&captured);
    let length = text::utf16_len(&text);
    if length > MAX_TEXT_UTF16 {
        notice(
            &app,
            generation,
            "That selection is too long",
            &format!(
                "gloss checks up to {MAX_TEXT_UTF16} characters at a time, and this has {length}. Select a shorter part."
            ),
            None,
        );
        return;
    }

    if !set_view(&app, generation, PanelView::Checking { preview: text::preview(&text, 140) }) {
        return;
    }
    windows::show_panel(&app);

    let result = tauri::async_runtime::block_on(state.client.proofread(&session, &text));
    match result {
        Ok(response) => {
            let view = PanelView::Ready {
                text: text.clone(),
                suggestions: response.suggestions.clone(),
                quota: response.quota,
            };
            {
                let mut panel = lock(&state.panel);
                if panel.generation != generation {
                    return;
                }
                panel.result = Some(CheckResult { text, response, session });
            }
            set_view(&app, generation, view);
        }
        Err(error) => {
            state::forget_session_if_unauthorized(&app, &error);
            let action = error.is_unauthorized().then_some(PanelAction::OpenSettings);
            notice(&app, generation, "Couldn't check this text", &error.learner_message(&state.origin()), action);
        }
    }
}

/// Shows a message in the panel. Messages always need the panel in front.
pub fn notice(app: &AppHandle, generation: u64, title: &str, detail: &str, action: Option<PanelAction>) {
    let view = PanelView::Notice { title: title.into(), detail: detail.into(), action };
    if set_view(app, generation, view) {
        windows::show_panel(app);
    }
}

/// A message that is not tied to a check, such as a dictation failure.
pub fn standalone_notice(app: &AppHandle, title: &str, detail: &str, action: Option<PanelAction>) {
    let state = app.state::<AppState>();
    let generation = next_generation(&state, None);
    notice(app, generation, title, detail, action);
}

fn set_view(app: &AppHandle, generation: u64, view: PanelView) -> bool {
    let state = app.state::<AppState>();
    {
        let mut panel = lock(&state.panel);
        if panel.generation != generation {
            return false;
        }
        panel.view = view.clone();
    }
    let _ = app.emit_to("panel", "panel", view);
    true
}

/// The corrected text for the chosen suggestions.
pub fn corrected_text(text: &str, suggestions: &[Suggestion], chosen: &[String]) -> Result<String, String> {
    let edits: Vec<Edit<'_>> = suggestions
        .iter()
        .filter(|suggestion| chosen.contains(&suggestion.id))
        .map(|s| Edit { start: s.start, end: s.end, original: &s.original, replacement: &s.replacement })
        .collect();
    text::apply_edits(text, &edits).map_err(|error| match error {
        text::ApplyError::Overlap => "Two of the chosen suggestions change the same words. Choose one of them.".into(),
        text::ApplyError::Stale => "These suggestions no longer match the text. Check it again.".into(),
    })
}

pub fn preview(state: &AppState, chosen: &[String]) -> Result<String, String> {
    let panel = lock(&state.panel);
    let result = panel.result.as_ref().ok_or("Nothing to apply.")?;
    corrected_text(&result.text, &result.response.suggestions, chosen)
}

/// Pastes the corrected text over the selection in the original app and
/// records the applied suggestions as accepted.
pub fn apply(app: &AppHandle, chosen: Vec<String>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let (original, corrected, focus, session, text_hash) = {
        let panel = lock(&state.panel);
        let result = panel.result.as_ref().ok_or("Nothing to apply.")?;
        let corrected = corrected_text(&result.text, &result.response.suggestions, &chosen)?;
        (result.text.clone(), corrected, panel.focus, result.session.clone(), result.response.text_hash.clone())
    };
    if corrected == original {
        dismiss(app, true);
        return Ok(());
    }
    end_session(&state);
    windows::hide_panel(app);

    let app = app.clone();
    thread::spawn(move || {
        let state = app.state::<AppState>();
        let platform = state.platform.clone();
        if let Some(focus) = focus
            && !platform.activate(focus)
        {
            standalone_notice(
                &app,
                "Couldn't return to your app",
                "The corrected text is on the clipboard instead. Paste it where you need it.",
                None,
            );
            copy_to_clipboard(&state, &corrected);
            return;
        }
        // When the app exposes its selection, make sure the learner did not
        // select something else in the meantime before replacing it.
        if let Some(current) = platform.selected_text().filter(|current| !current.trim().is_empty())
            && text::normalize(&current) != original
        {
            standalone_notice(
                &app,
                "The selection changed",
                "Nothing was replaced. Select the text and check it again.",
                None,
            );
            return;
        }
        if selection::insert(platform.as_ref(), &corrected).is_err() {
            copy_to_clipboard(&state, &corrected);
            standalone_notice(
                &app,
                "Couldn't paste the text",
                "The corrected text is on the clipboard. Paste it with Command-V or Ctrl+V.",
                None,
            );
            return;
        }
        tauri::async_runtime::block_on(record_accepted(&state, &session, &chosen, &text_hash));
    });
    Ok(())
}

pub fn copy(app: &AppHandle, chosen: Vec<String>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let corrected = preview(&state, &chosen)?;
    if !copy_to_clipboard(&state, &corrected) {
        return Err("The clipboard is not available.".into());
    }
    dismiss(app, true);
    Ok(())
}

fn copy_to_clipboard(state: &AppState, text: &str) -> bool {
    state.platform.clipboard().map(|mut clipboard| clipboard.write_text(text, false)).unwrap_or(false)
}

async fn record_accepted(state: &AppState, session: &Session, chosen: &[String], text_hash: &str) {
    for id in chosen {
        if state.client.record_decision(session, id, "accepted", text_hash).await.is_err() {
            log::warn!("could not record an accepted suggestion");
        }
    }
}

fn end_session(state: &AppState) {
    let mut panel = lock(&state.panel);
    panel.generation += 1;
    panel.view = PanelView::Idle;
    panel.result = None;
}

/// Closes the panel. With `return_focus`, the app the selection came from
/// gets focus back, as if the panel had never opened.
pub fn dismiss(app: &AppHandle, return_focus: bool) {
    let state = app.state::<AppState>();
    let focus = lock(&state.panel).focus.take();
    end_session(&state);
    windows::hide_panel(app);
    if return_focus && let Some(focus) = focus {
        let platform = state.platform.clone();
        thread::spawn(move || {
            platform.activate(focus);
        });
    }
}

/// Clicking elsewhere closes a panel that is only showing a result or a
/// message; a running check keeps its panel until the answer arrives.
pub fn on_blur(app: &AppHandle) {
    let state = app.state::<AppState>();
    let closable = matches!(lock(&state.panel).view, PanelView::Ready { .. } | PanelView::Notice { .. });
    if closable {
        dismiss(app, false);
    }
}

pub fn run_action(app: &AppHandle, action: PanelAction) {
    let state = app.state::<AppState>();
    dismiss(app, false);
    match action {
        PanelAction::OpenSettings => windows::show_settings(app),
        PanelAction::GrantAccessibility => {
            state.platform.request_accessibility();
            state.platform.open_privacy_settings(PrivacyPane::Accessibility);
        }
        PanelAction::OpenMicrophoneSettings => {
            state.platform.open_privacy_settings(PrivacyPane::Microphone);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::SuggestionCategory;

    fn suggestion(id: &str, start: usize, end: usize, original: &str, replacement: &str) -> Suggestion {
        Suggestion {
            id: id.into(),
            source: "ai".into(),
            category: SuggestionCategory::Error,
            start,
            end,
            original: original.into(),
            replacement: replacement.into(),
            reason: String::new(),
            meaning_change: false,
            meaning: None,
            ipa: None,
        }
    }

    #[test]
    fn applies_only_the_chosen_suggestions() {
        let text = "She go to work and eat lunch.";
        let suggestions = [suggestion("a", 4, 6, "go", "goes"), suggestion("b", 19, 22, "eat", "eats")];
        assert_eq!(corrected_text(text, &suggestions, &["a".into()]).unwrap(), "She goes to work and eat lunch.");
        assert_eq!(
            corrected_text(text, &suggestions, &["a".into(), "b".into()]).unwrap(),
            "She goes to work and eats lunch."
        );
        assert_eq!(corrected_text(text, &suggestions, &[]).unwrap(), text);
    }

    #[test]
    fn explains_stale_and_overlapping_choices() {
        let suggestions = [suggestion("a", 0, 3, "abc", "x"), suggestion("b", 1, 4, "bcd", "y")];
        assert!(corrected_text("abcd", &suggestions, &["a".into(), "b".into()]).unwrap_err().contains("same words"));
        assert!(corrected_text("zzzz", &suggestions, &["a".into()]).unwrap_err().contains("Check it again"));
    }

    #[test]
    fn serializes_views_for_the_panel() {
        let view = PanelView::Notice { title: "T".into(), detail: "D".into(), action: Some(PanelAction::OpenSettings) };
        assert_eq!(
            serde_json::to_value(view).unwrap(),
            serde_json::json!({ "phase": "notice", "title": "T", "detail": "D", "action": "openSettings" })
        );
        let view =
            PanelView::Ready { text: "t".into(), suggestions: vec![], quota: QuotaState { used: 1.0, limit: 20.0 } };
        let value = serde_json::to_value(view).unwrap();
        assert_eq!(value["phase"], "ready");
        assert_eq!(value["quota"]["limit"], 20.0);
        assert_eq!(serde_json::to_value(PanelView::Idle).unwrap(), serde_json::json!({ "phase": "idle" }));
    }
}
