//! Taking the selected text from the focused app and putting text back, built
//! on the platform traits. The clipboard is borrowed only for a moment and
//! restored afterwards.

use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::platform::{EditKey, Permission, Platform, PlatformError, TextField};

// How long an app may take to put the copied selection on the clipboard.
const COPY_TIMEOUT: Duration = Duration::from_millis(700);
const COPY_POLL: Duration = Duration::from_millis(25);
// The target app reads the clipboard while it handles Paste, which can take
// a moment; restoring the old content sooner would paste that instead.
const PASTE_SETTLE: Duration = Duration::from_millis(450);

/// The selected part of `value`, by UTF-16 range. None when the range is
/// unknown, empty or outside the text.
pub fn selected_range(value: &str, selection: Option<(usize, usize)>) -> Option<String> {
    let (location, length) = selection?;
    if length == 0 {
        return None;
    }
    let units: Vec<u16> = value.encode_utf16().collect();
    let end = location.checked_add(length)?;
    if end > units.len() {
        return None;
    }
    String::from_utf16(&units[location..end]).ok()
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CaptureError {
    #[error("accessibility permission is missing")]
    PermissionNeeded,
    #[error("nothing is selected")]
    NothingSelected,
    #[error("the selection could not be read")]
    Failed,
}

/// Reads the selection through the accessibility API, or copies it through
/// the clipboard when the app does not expose it. `field` is the focused text
/// field the caller already read, so its own selection is used first.
pub fn capture(platform: &dyn Platform, field: Option<&TextField>) -> Result<String, CaptureError> {
    log::info!("[gloss] check: reading the selection");
    if platform.accessibility() == Permission::Missing {
        return Err(CaptureError::PermissionNeeded);
    }
    if let Some(field) = field
        && let Some(text) = selected_range(&field.value, field.selection)
        && !text.trim().is_empty()
    {
        log::info!("[gloss] check: the selection is {} characters of the field", text.chars().count());
        return Ok(text);
    }
    if let Some(text) = platform.selected_text()
        && !text.trim().is_empty()
    {
        return Ok(text);
    }
    log::info!("[gloss] check: no selection through accessibility, copying it");
    platform.wait_for_modifier_release();
    copy_through_clipboard(platform, COPY_TIMEOUT)
}

fn copy_through_clipboard(platform: &dyn Platform, timeout: Duration) -> Result<String, CaptureError> {
    let mut clipboard = platform.clipboard().map_err(|_| CaptureError::Failed)?;
    let saved = clipboard.snapshot();
    // Clearing first tells a fresh copy apart from what was already there.
    clipboard.clear();
    let cleared = clipboard.change_count();

    if platform.send_edit_key(EditKey::Copy).is_err() {
        clipboard.restore(saved);
        return Err(CaptureError::Failed);
    }

    let deadline = Instant::now() + timeout;
    let mut copied = None;
    while Instant::now() < deadline {
        sleep(COPY_POLL);
        let changed = match (cleared, clipboard.change_count()) {
            (Some(before), Some(now)) => before != now,
            _ => true,
        };
        if changed && let Some(text) = clipboard.read_text().filter(|text| !text.is_empty()) {
            copied = Some(text);
            break;
        }
    }
    clipboard.restore(saved);
    log::info!(
        "[gloss] check: copy through the clipboard {} ({} chars)",
        if copied.as_deref().is_some_and(|text| !text.trim().is_empty()) { "worked" } else { "found nothing" },
        copied.as_deref().map(|text| text.chars().count()).unwrap_or(0)
    );
    copied.filter(|text| !text.trim().is_empty()).ok_or(CaptureError::NothingSelected)
}

/// Pastes `text` into the focused field, replacing its selection, and puts
/// the previous clipboard content back unless something else changed it.
pub fn insert(platform: &dyn Platform, text: &str) -> Result<(), PlatformError> {
    insert_with(platform, text, PASTE_SETTLE)
}

fn insert_with(platform: &dyn Platform, text: &str, settle: Duration) -> Result<(), PlatformError> {
    platform.wait_for_modifier_release();
    let mut clipboard = platform.clipboard()?;
    let saved = clipboard.snapshot();
    if !clipboard.write_text(text, true) {
        clipboard.restore(saved);
        return Err(PlatformError::Clipboard);
    }
    let written = clipboard.change_count();
    let result = platform.send_edit_key(EditKey::Paste);
    sleep(settle);
    let untouched = match written {
        Some(count) => clipboard.change_count() == Some(count),
        None => clipboard.read_text().as_deref() == Some(text),
    };
    if untouched {
        clipboard.restore(saved);
    }
    result
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::platform::{ClipItem, ClipSnapshot, Clipboard, FocusedApp, PrivacyPane};

    #[derive(Default)]
    struct Board {
        items: ClipSnapshot,
        count: i64,
        // What the "focused app" holds as its selection, and what it received.
        selection: Option<String>,
        pasted: Vec<String>,
    }

    struct FakeClipboard(Arc<Mutex<Board>>);

    fn text_item(text: &str) -> ClipItem {
        ClipItem { representations: vec![("text".into(), text.as_bytes().to_vec())] }
    }

    impl Clipboard for FakeClipboard {
        fn snapshot(&mut self) -> ClipSnapshot {
            self.0.lock().unwrap().items.clone()
        }
        fn restore(&mut self, snapshot: ClipSnapshot) {
            let mut board = self.0.lock().unwrap();
            board.items = snapshot;
            board.count += 1;
        }
        fn clear(&mut self) {
            let mut board = self.0.lock().unwrap();
            board.items.clear();
            board.count += 1;
        }
        fn read_text(&mut self) -> Option<String> {
            let board = self.0.lock().unwrap();
            let item = board.items.first()?;
            String::from_utf8(item.representations.first()?.1.clone()).ok()
        }
        fn write_text(&mut self, text: &str, _transient: bool) -> bool {
            let mut board = self.0.lock().unwrap();
            board.items = vec![text_item(text)];
            board.count += 1;
            true
        }
        fn change_count(&mut self) -> Option<i64> {
            Some(self.0.lock().unwrap().count)
        }
    }

    struct FakePlatform {
        board: Arc<Mutex<Board>>,
        accessible_selection: Option<String>,
        permission: Permission,
    }

    impl FakePlatform {
        fn new(clipboard: &str, selection: Option<&str>) -> Self {
            let board = Board {
                items: vec![text_item(clipboard), text_item("second item")],
                selection: selection.map(str::to_owned),
                ..Board::default()
            };
            Self { board: Arc::new(Mutex::new(board)), accessible_selection: None, permission: Permission::Granted }
        }
    }

    impl Platform for FakePlatform {
        fn focused_app(&self) -> Option<FocusedApp> {
            None
        }
        fn is_own_app(&self, _app: FocusedApp) -> bool {
            false
        }
        fn activate(&self, _app: FocusedApp) -> bool {
            true
        }
        fn selected_text(&self) -> Option<String> {
            self.accessible_selection.clone()
        }
        fn wait_for_modifier_release(&self) {}
        fn send_edit_key(&self, key: EditKey) -> Result<(), PlatformError> {
            let mut board = self.board.lock().unwrap();
            match key {
                EditKey::Copy => {
                    if let Some(selection) = board.selection.clone() {
                        board.items = vec![text_item(&selection)];
                        board.count += 1;
                    }
                }
                EditKey::Paste => {
                    let item = board.items.first().cloned().unwrap_or_default();
                    let text = String::from_utf8(item.representations[0].1.clone()).unwrap();
                    board.pasted.push(text);
                }
            }
            Ok(())
        }
        fn clipboard(&self) -> Result<Box<dyn Clipboard>, PlatformError> {
            Ok(Box::new(FakeClipboard(self.board.clone())))
        }
        fn accessibility(&self) -> Permission {
            self.permission
        }
        fn request_accessibility(&self) {}
        fn open_privacy_settings(&self, _pane: PrivacyPane) -> bool {
            false
        }
    }

    #[test]
    fn uses_the_selection_of_the_read_field_first() {
        let platform = FakePlatform::new("kept", Some("copied"));
        let field = TextField {
            value: "He go to school.".into(),
            selection: Some((3, 2)),
            frame: None,
            editable: true,
            token: 1,
        };
        assert_eq!(capture(&platform, Some(&field)).unwrap(), "go");
        // Unknown, empty or out-of-range selections fall through to the app.
        for selection in [None, Some((0, 0)), Some((100, 2))] {
            let field = TextField { selection, ..field.clone() };
            assert_eq!(capture(&platform, Some(&field)).unwrap(), "copied");
        }
        assert_eq!(selected_range("héllo", Some((1, 1))), Some("é".into()));
    }

    #[test]
    fn prefers_the_accessibility_selection() {
        let mut platform = FakePlatform::new("kept", Some("copied"));
        platform.accessible_selection = Some("from AX".into());
        assert_eq!(capture(&platform, None).unwrap(), "from AX");
        assert_eq!(platform.board.lock().unwrap().count, 0, "clipboard untouched");
    }

    #[test]
    fn copies_through_the_clipboard_and_restores_every_item() {
        let platform = FakePlatform::new("kept", Some("He go home."));
        assert_eq!(copy_through_clipboard(&platform, Duration::from_millis(200)).unwrap(), "He go home.");
        let board = platform.board.lock().unwrap();
        assert_eq!(board.items, vec![text_item("kept"), text_item("second item")]);
    }

    #[test]
    fn reports_an_empty_selection_and_still_restores() {
        let platform = FakePlatform::new("kept", None);
        assert_eq!(copy_through_clipboard(&platform, Duration::from_millis(100)), Err(CaptureError::NothingSelected));
        assert_eq!(platform.board.lock().unwrap().items[0], text_item("kept"));
    }

    #[test]
    fn asks_for_permission_before_touching_anything() {
        let mut platform = FakePlatform::new("kept", Some("text"));
        platform.permission = Permission::Missing;
        assert_eq!(capture(&platform, None), Err(CaptureError::PermissionNeeded));
        assert_eq!(platform.board.lock().unwrap().count, 0);
    }

    #[test]
    fn pastes_and_restores_the_clipboard() {
        let platform = FakePlatform::new("kept", None);
        insert_with(&platform, "He went home.", Duration::ZERO).unwrap();
        let board = platform.board.lock().unwrap();
        assert_eq!(board.pasted, vec!["He went home.".to_string()]);
        assert_eq!(board.items, vec![text_item("kept"), text_item("second item")]);
    }
}
