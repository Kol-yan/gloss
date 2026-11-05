//! The few operating-system services the app needs, behind small traits so
//! each platform can be filled in separately. macOS has a native
//! implementation; Windows and Linux use the portable fallback for now.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub mod observer;
#[cfg(not(target_os = "macos"))]
mod portable;


use std::sync::Arc;

/// An application that had keyboard focus, so it can get focus back after the
/// panel was used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FocusedApp {
    pub pid: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditKey {
    Copy,
    Paste,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Granted,
    Missing,
    /// The platform does not ask for this permission.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    NotRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivacyPane {
    Accessibility,
    Microphone,
}

#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    #[error("keystrokes could not be sent")]
    Keystroke,
    #[error("the clipboard is not available")]
    Clipboard,
}

/// One clipboard entry with all of its representations (plain text, rich
/// text, images…), so a temporary use of the clipboard can be undone.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClipItem {
    pub representations: Vec<(String, Vec<u8>)>,
}

pub type ClipSnapshot = Vec<ClipItem>;

pub trait Clipboard {
    fn snapshot(&mut self) -> ClipSnapshot;
    fn restore(&mut self, snapshot: ClipSnapshot);
    fn clear(&mut self);
    fn read_text(&mut self) -> Option<String>;
    /// Writes plain text. A transient write is marked, where the platform
    /// supports it, so clipboard history tools skip it.
    fn write_text(&mut self, text: &str, transient: bool) -> bool;
    /// A counter that changes on every write, when the platform has one.
    fn change_count(&mut self) -> Option<i64>;
}

/// A text field another app exposes through Accessibility: the element
/// itself, what it holds, and where its selection is (UTF-16 text).
#[derive(Debug, Clone, PartialEq)]
pub struct TextField {
    /// The text right now, read from `AXValue` or `AXSelectedText` fallback.
    pub value: String,
    /// Selection as `(location, length)` in UTF-16 units, when known.
    pub selection: Option<(usize, usize)>,
    /// Top-left and size of the element on screen, in global points.
    pub frame: Option<(f64, f64, f64, f64)>,
    /// The element accepts typing (`AXEditable` or `AXValue` is settable).
    pub editable: bool,
    /// Placeholder for the platform to keep the element handle; opaque here.
    pub token: u64,
}

pub trait Platform: Send + Sync {
    fn focused_app(&self) -> Option<FocusedApp>;
    /// The focused text field of the frontmost app, if it exposes one.
    /// Not implemented for the portable fallback (returns None).
    fn focused_text_field(&self) -> Option<TextField> {
        None
    }
    /// Writes `text` into the field previously read as `field`, replacing the
    /// whole value or the field's own selection (see `selection`). False when
    /// the app does not accept it.
    fn write_field_text(&self, _field: &TextField, _text: &str) -> bool {
        false
    }
    /// Forgets a field the app no longer uses, so its element is released.
    fn release_text_field(&self, _field: &TextField) {}
    fn is_own_app(&self, app: FocusedApp) -> bool;
    /// Gives focus back to `app`; true once it is frontmost again.
    fn activate(&self, app: FocusedApp) -> bool;
    /// The selection in the focused text field, read through the
    /// accessibility API. None when the app does not expose it.
    fn selected_text(&self) -> Option<String>;
    /// Waits briefly until the shortcut's modifier keys are up, so a
    /// synthesized Copy or Paste is not combined with them.
    fn wait_for_modifier_release(&self);
    fn send_edit_key(&self, key: EditKey) -> Result<(), PlatformError>;
    fn clipboard(&self) -> Result<Box<dyn Clipboard>, PlatformError>;
    /// Reading other apps' selections and sending keystrokes.
    fn accessibility(&self) -> Permission;
    /// Shows the system prompt that leads to the accessibility setting.
    fn request_accessibility(&self);
    fn open_privacy_settings(&self, pane: PrivacyPane) -> bool;
}

pub fn current() -> Arc<dyn Platform> {
    #[cfg(target_os = "macos")]
    {
        Arc::new(macos::MacPlatform)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Arc::new(portable::PortablePlatform)
    }
}

/// The operating system name shown in settings.
pub fn os_name() -> &'static str {
    std::env::consts::OS
}
