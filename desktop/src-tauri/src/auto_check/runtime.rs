//! Wires the watcher to macOS: observer on the frontmost app, AX reads, the
//! proofread call and the floating badge.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::platform::observer::{self, Notice};
use crate::platform::{self, TextField};
use crate::state::AppState;
use crate::windows;

use super::{Watcher, MAX_CHARS};

/// The installed observation for one app; replaced when the frontmost app
/// changes. The refcon it holds is freed with the observation.
#[cfg(target_os = "macos")]
struct Observed {
    pid: i32,
    // Dropping the observation removes the notifications.
    _observation: observer::Observation,
}

#[cfg(target_os = "macos")]
unsafe impl Send for Observed {}

static OBSERVED: Mutex<Option<Observed>> = Mutex::new(None);
static WATCHER: Mutex<Option<Watcher>> = Mutex::new(None);

/// The watcher, shared by the notification callback and the timer.
fn with_watcher<T>(change: impl FnOnce(&mut Watcher) -> T) -> T {
    let mut slot = WATCHER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    change(slot.get_or_insert_with(Watcher::default))
}

/// Starts the feature, if the learner has it on and there is a session.
pub fn start(app: &AppHandle) {
    stop();
    let state = app.state::<AppState>();
    if !state.settings().check_as_you_type || state.session().is_none() {
        return;
    }
    #[cfg(target_os = "macos")]
    if state.platform.accessibility() != platform::Permission::Granted {
        log::info!("[gloss] as-you-type: Accessibility is off, not watching");
        return;
    }
    #[cfg(target_os = "macos")]
    {
        focus_changed(app);
        watch_typing(app);
        poll(app);
        log::info!("[gloss] as-you-type: watching the frontmost text field");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn stop() {
    #[cfg(target_os = "macos")]
    {
        *OBSERVED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
    with_watcher(|watcher| {
        *watcher = Watcher::default();
    });
}

// One poller per app run, even after the feature is switched off and on.
static POLLING: Mutex<bool> = Mutex::new(false);

fn poll(app: &AppHandle) {
    let mut polling = POLLING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if *polling {
        return;
    }
    *polling = true;
    let handle = app.clone();
    // Polls for the debounce, so no timer is created per keystroke.
    std::thread::spawn(move || {
        let mut ticker = 0u32;
        loop {
            std::thread::sleep(Duration::from_millis(200));
            ticker = ticker.wrapping_add(1);
            if handle.try_state::<AppState>().is_none() {
                return;
            }
            if !handle.state::<AppState>().settings().check_as_you_type {
                continue;
            }
            let due = with_watcher(|watcher| watcher.due(Instant::now()));
            if ticker % 25 == 0 {
                let armed = with_watcher(|watcher| watcher.due_at.is_some());
                log::info!("[gloss] as-you-type: poll due={due} armed={armed}");
            }
            if due {
                log::info!("[gloss] as-you-type: debounce over");
                if let Some(action) = with_watcher(|watcher| watcher.take_due(Instant::now())) {
                    run_action(&handle, action);
                }
            }
            // Another app can come forward without a notification from the
            // app being watched.
            if ticker % 3 == 0 {
                focus_changed(&handle);
            }
        }
    });
}

/// Reads the field and asks the watcher what to do; a focus change also
/// installs the observer on the frontmost app when it changed.
#[cfg(target_os = "macos")]
fn focus_changed(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(frontmost) = state.platform.focused_app() else { return };
    if state.platform.is_own_app(frontmost) {
        // The panel or a settings window has focus: nothing to watch.
        return;
    }
    let needs_observer = {
        let observed = OBSERVED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        observed.as_ref().map(|observed| observed.pid) != Some(frontmost.pid)
    };
    if needs_observer {
        let handle = app.clone();
        let installed = observer::observe(frontmost.pid, move |notice| {
            log::info!("[gloss] as-you-type: {notice:?}");
            match notice {
                Notice::FocusChanged => focus_changed(&handle),
                Notice::ValueChanged => watch_typing(&handle),
            }
        });
        match installed {
            Some(observation) => {
                let mut observed = OBSERVED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                *observed = Some(Observed { pid: frontmost.pid, _observation: observation });
                log::info!("[gloss] as-you-type: observing pid {}", frontmost.pid);
            }
            None => log::warn!("[gloss] as-you-type: could not observe pid {}", frontmost.pid),
        }
        liveness(app);
    }
    let field = state.platform.focused_text_field();
    let value = field.as_ref().map(|field| (field.value.clone(), field.token));
    if let Some(field) = field.as_ref() {
        log::info!(
            "[gloss] as-you-type: focus on a text field ({:?}, {} chars, editable {})",
            field.frame,
            field.value.chars().count(),
            field.editable
        );
        keep_field(field);
    }
    // The same field re-read (the polling and the notifications both call
    // this) does not reset a debounce that is still pending.
    with_watcher(|watcher| {
        let same = match (&value, watcher.field.as_ref()) {
            (Some((_, token)), Some(field)) => field.token == *token,
            (None, None) => true,
            _ => false,
        };
        if !same {
            watcher.focus(value, Instant::now());
        } else if let Some((text, _)) = value {
            // Re-reading the same text keeps a pending debounce as it is, so
            // the polling and the notifications cannot cancel each other.
            if watcher.field.as_ref().is_some_and(|field| field.value != text) {
                let _ = watcher.typed(text, Instant::now());
            }
        }
    });
}

/// A value notification: re-reads the field and restarts the debounce.
fn watch_typing(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(field) = state.platform.focused_text_field() else { return };
    let actions = with_watcher(|watcher| {
        // A new element under the same focus starts a fresh field.
        if watcher.shows(field.token) {
            watcher.typed(field.value.clone(), Instant::now())
        } else {
            watcher.focus(Some((field.value.clone(), field.token)), Instant::now())
        }
    });
    for action in actions {
        run_action(app, action);
    }
    keep_field(&field);
}

/// Keeps the field's element so the panel can apply its fixes later.
static LAST_FIELD: Mutex<Option<TextField>> = Mutex::new(None);

fn keep_field(field: &TextField) {
    let mut last = LAST_FIELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *last = Some(field.clone());
}

/// Notifications for the field's text can stop when another app comes front;
/// this checks that the observed app is still frontmost.
fn liveness(app: &AppHandle) {
    let state = app.state::<AppState>();
    let observed = OBSERVED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(current) = state.platform.focused_app() else { return };
    if let Some(observed) = observed.as_ref()
        && observed.pid != current.pid
    {
        log::info!("[gloss] as-you-type: pid {} left the front", observed.pid);
    }
}

fn run_action(app: &AppHandle, action: super::Action) {
    match action {
        super::Action::HideBadge => windows::hide_badge(app),
        super::Action::ShowBadge { fixes, .. } => {
            // The badge window shows the same number the watcher reports.
            let _ = with_watcher(|watcher| watcher.badge_text());
            windows::show_badge(app, fixes);
            let _ = app.emit_to("badge", "badge", fixes);
        }
        super::Action::Arm(_) => log::info!("[gloss] as-you-type: check armed"),
        super::Action::Check => check(app),
    }
}

/// Checks the current field text in the background.
fn check(app: &AppHandle) {
    let state = app.state::<AppState>();
    // The field the watcher was armed for; the frontmost app may have changed
    // in the meantime (the settings window, a menu), which must not stop it.
    let Some(field) = state.platform.focused_text_field().or_else(last_field) else {
        log::info!("[gloss] as-you-type: no field to check");
        return;
    };
    let text = field.value.clone();
    if text.trim().is_empty() || text.chars().count() > MAX_CHARS {
        log::info!("[gloss] as-you-type: nothing to check ({} chars)", text.chars().count());
        return;
    }
    keep_field(&field);
    log::info!("[gloss] as-you-type: checking {} characters", text.chars().count());
    let Some(fixes) = proofread(&state, &text) else { return };
    let actions = with_watcher(|watcher| {
        // The field may already show the answer, or a newer text; then the
        // watcher keeps its state, but the badge still follows this answer.
        let current = watcher.field.as_ref().map(|field| (field.value.clone(), field.token));
        let actions = watcher.answered(&text, fixes);
        if actions.is_empty() {
            if fixes == 0 {
                vec![super::Action::HideBadge]
            } else if let Some((_, token)) = current {
                vec![super::Action::ShowBadge { fixes, token }]
            } else {
                Vec::new()
            }
        } else {
            actions
        }
    });
    log::info!("[gloss] as-you-type: {} fix(es) for {} characters", fixes, text.chars().count());
    for action in actions {
        run_action(app, action);
    }
}

/// The same call the panel makes; None when the server could not answer.
fn proofread(state: &AppState, text: &str) -> Option<usize> {
    match tauri::async_runtime::block_on(crate::check::proofread_with_recovery(state, text)) {
        Ok(response) => Some(response.suggestions.len()),
        Err(error) => {
            log::info!("[gloss] as-you-type: check failed ({error:?})");
            None
        }
    }
}

/// The learner clicked the badge: open the panel with the current field.
/// Manual test hook: treats `text` as the typed value of the frontmost text
/// field, the same way a value notification does. Used by the owner check and
/// the documentation; the normal path never calls it.
pub fn simulate_typing(app: &AppHandle, text: &str) {
    let state = app.state::<AppState>();
    // The test does not need the real frontmost app: it uses the field the
    // watcher last saw, so an open settings window does not break it.
    let focused = state.platform.focused_text_field();
    let remembered = last_field();
    log::info!(
        "[gloss] as-you-type: test field focused={:?} remembered={:?}",
        focused.as_ref().map(|field| field.frame),
        remembered.as_ref().map(|field| field.frame)
    );
    let Some(field) = focused.or(remembered) else {
        log::info!("[gloss] as-you-type: no focused text field to test");
        return;
    };
    if let Some(frontmost) = state.platform.focused_app()
        && state.platform.is_own_app(frontmost)
    {
        // Bring the app under test forward again for the badge and Apply.
        log::info!("[gloss] as-you-type: test continues with the last field");
    }
    log::info!("[gloss] as-you-type: test input of {} characters", text.chars().count());
    let actions = with_watcher(|watcher| watcher.focused_for_test(text, &field, Instant::now()));
    log::info!("[gloss] as-you-type: test input from field {:?}, actions {actions:?}", field.frame);
    // Run the check in the test hook directly: the poller may be paused while
    // another app is frontmost, and the owner's own typing never is.
    check(app);
    keep_field(&field);
    for action in actions {
        run_action(app, action);
    }
}

pub fn badge_click(app: &AppHandle) {
    windows::hide_badge(app);
    let Some(field) = last_field() else { return };
    crate::check::open_field(app, field);
}

/// Re-reads the setting after it changed in the settings window.
pub fn last_field() -> Option<TextField> {
    LAST_FIELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

pub fn settings_changed(app: &AppHandle) {
    if app.state::<AppState>().settings().check_as_you_type {
        start(app);
    } else {
        stop();
        windows::hide_badge(app);
    }
}
