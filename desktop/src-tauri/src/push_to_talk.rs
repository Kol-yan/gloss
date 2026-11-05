//! Push-to-talk on the right Option key.
//!
//! Holding Control+Option+D is hard to discover, and a global shortcut can
//! never take a key that is pressed on its own. On macOS the app therefore
//! watches the keyboard for the right Option key (virtual key code 61), the
//! usual push-to-talk key of dictation apps: hold it and speak, let go to
//! send, and a quick tap toggles hands-free recording.
//!
//! The monitor only asks for `FlagsChanged` events, the modifier state a
//! global monitor sees with the Accessibility permission gloss already needs
//! to read selections; no separate Input Monitoring permission is involved.
//! Keys pressed in other apps are only classified; nothing is recorded while
//! the key is not held. Only macOS is wired this way; on Windows and Linux
//! the dictation shortcut from the settings stays in use.

use tauri::{AppHandle, Manager};

use crate::dictation;
use crate::settings::PUSH_TO_TALK_DICTATION;

/// Virtual key code of the right Option key (`kVK_RightOption`).
pub const RIGHT_OPTION_KEYCODE: u16 = 61;

// The installed monitor, so a change of the key can stop the old one. AppKit
// monitors live on the main thread and are not `Send`, so they stay in a
// thread-local while the rest of the app is free to call in from anywhere.
#[cfg(target_os = "macos")]
thread_local! {
    static MONITOR: std::cell::RefCell<Option<macos::Installed>> = const { std::cell::RefCell::new(None) };
}

/// What one keyboard event means for dictation, kept free of side effects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    Pressed,
    Released,
    Ignored,
}

/// Classifies one event. `keycode` 61 is the right Option key; `down` is the
/// state of the Option flags after the event. Only a change counts, so a
/// repeat of the same state (or another modifier) is ignored.
pub fn transition(keycode: u16, down: bool, last: &mut Option<bool>) -> Transition {
    if keycode != RIGHT_OPTION_KEYCODE {
        return Transition::Ignored;
    }
    if *last == Some(down) {
        return Transition::Ignored;
    }
    *last = Some(down);
    if down { Transition::Pressed } else { Transition::Released }
}

/// What the app knows about the keyboard monitor, for the settings window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MonitorState {
    /// macOS only; the monitor is running.
    On,
    /// Not used on this platform, or the dictation shortcut is set instead.
    Off,
}

static STATE: std::sync::Mutex<MonitorState> = std::sync::Mutex::new(MonitorState::Off);

pub fn state() -> MonitorState {
    *STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn set_state(next: MonitorState) {
    *STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = next;
}

#[cfg(not(target_os = "macos"))]
mod macos {
    use super::Transition;

    /// Other platforms use the global shortcut from the settings instead.
    pub struct Installed;

    pub fn install(_: impl FnMut(Transition) + 'static) -> Option<Installed> {
        None
    }

    pub fn remove(_: Installed) {}

    pub fn suspend() {}
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};

    use super::Transition;

    /// The installed monitor with the block it calls; both stay alive until
    /// the monitor is removed.
    pub struct Installed {
        monitor: Retained<AnyObject>,
        _block: Box<dyn Fn(NonNull<NSEvent>)>,
    }

    pub fn install(handler: impl FnMut(Transition) + 'static) -> Option<Installed> {
        // The monitor's handler is a plain `Fn`, so the previous state lives in
        // a cell; AppKit calls it on this process's main run loop.
        let last = RefCell::new(None);
        let handler = RefCell::new(handler);
        let block = RcBlock::new(move |event: NonNull<NSEvent>| {
            // SAFETY: the system passes a live event for the length of the call.
            let event = unsafe { event.as_ref() };
            if event.r#type() != NSEventType::FlagsChanged {
                return;
            }
            // The Option flag is set for either Option key; the key code tells
            // left (58) from right (61), and the device bit is included in it.
            let down = event.modifierFlags().contains(NSEventModifierFlags::Option);
            let transition = super::transition(event.keyCode(), down, &mut last.borrow_mut());
            (handler.borrow_mut())(transition);
        });
        // Only modifier changes are requested, which a global monitor sees
        // with Accessibility alone, without Input Monitoring.
        let mask = NSEventMask::FlagsChanged;
        let monitor = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &block)?;
        Some(Installed { monitor, _block: Box::new(move |event| block.call((event,))) })
    }

    /// Removes a monitor installed by `install`. Removal happens on the main
    /// thread, where the callers start and stop the monitor.
    pub fn remove(installed: Installed) {
        // SAFETY: the monitor comes from `install` and is removed once.
        unsafe { NSEvent::removeMonitor(&installed.monitor) };
    }
}

fn enabled(accelerator: &str) -> bool {
    cfg!(target_os = "macos") && accelerator.trim().eq_ignore_ascii_case(PUSH_TO_TALK_DICTATION)
}

/// Starts or stops the right Option monitor to match the saved setting.
pub fn start(app: &AppHandle, dictation_accelerator: &str) {
    stop();
    if !enabled(dictation_accelerator) {
        set_state(MonitorState::Off);
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        match macos::install(move |transition| {
            log::info!("[gloss] push-to-talk: {transition:?}");
            dispatch(&handle, transition);
        }) {
            Some(installed) => {
                MONITOR.with(|current| *current.borrow_mut() = Some(installed));
                set_state(MonitorState::On);
                log::info!("[gloss] push-to-talk: watching the right Option key");
            }
            None => {
                set_state(MonitorState::Off);
                log::warn!("[gloss] push-to-talk: the keyboard monitor is not available");
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Stops the monitor; the settings window calls this while new keys are
/// recorded, so a key press there is not taken as dictation.
pub fn stop() {
    #[cfg(target_os = "macos")]
    MONITOR.with(|current| {
        if let Some(installed) = current.borrow_mut().take() {
            macos::remove(installed);
        }
    });
}

#[cfg(target_os = "macos")]
fn dispatch(app: &AppHandle, transition: Transition) {
    // Events from this app's own windows are not dictation.
    if app.webview_windows().values().any(|window| window.is_focused().unwrap_or(false)) {
        return;
    }
    match transition {
        Transition::Pressed => dictation::on_press(app),
        Transition::Released => dictation::on_release(app),
        Transition::Ignored => {}
    }
}

#[cfg(not(target_os = "macos"))]
fn dispatch(_: &AppHandle, _: Transition) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_change_of_the_right_option_key_presses_and_releases_once() {
        let mut last = None;
        assert_eq!(transition(61, true, &mut last), Transition::Pressed);
        // A repeated report of the same state is not a second press.
        assert_eq!(transition(61, true, &mut last), Transition::Ignored);
        assert_eq!(transition(61, false, &mut last), Transition::Released);
        assert_eq!(transition(61, false, &mut last), Transition::Ignored);
    }

    #[test]
    fn other_modifier_keys_are_not_dictation() {
        let mut last = None;
        assert_eq!(transition(58, true, &mut last), Transition::Ignored);
        assert_eq!(transition(56, true, &mut last), Transition::Ignored);
        assert_eq!(last, None, "their state is not remembered");
    }

    #[test]
    fn the_monitor_is_only_used_for_the_right_option_setting() {
        assert!(!enabled("Control+Alt+D"));
        assert!(!enabled("Alt+Space"));
        assert_eq!(enabled(PUSH_TO_TALK_DICTATION), cfg!(target_os = "macos"), "only macOS has the monitor");
    }
}
