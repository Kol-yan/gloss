//! Windows and Linux fallback: the selection is copied through the clipboard
//! with a synthesized Ctrl+C, and text is pasted with Ctrl+V. Only plain text
//! survives the clipboard round trip here; native selection access and focus
//! tracking are the next step for these platforms.
//!
//! Linux needs an X11 session (or XWayland) for synthesized keystrokes and
//! global shortcuts.

use std::thread::sleep;
use std::time::Duration;

use enigo::{Direction, Enigo, Key, Keyboard, Settings};

use super::{ClipItem, ClipSnapshot, Clipboard, EditKey, FocusedApp, Permission, Platform, PlatformError, PrivacyPane};

const TEXT_TYPE: &str = "text/plain;charset=utf-8";

pub struct PortablePlatform;

impl Platform for PortablePlatform {
    fn focused_app(&self) -> Option<FocusedApp> {
        None
    }

    fn is_own_app(&self, _app: FocusedApp) -> bool {
        false
    }

    fn activate(&self, _app: FocusedApp) -> bool {
        false
    }

    fn selected_text(&self) -> Option<String> {
        None
    }

    fn wait_for_modifier_release(&self) {
        // Without a portable way to read the key state, wait for a typical
        // release instead; `send_edit_key` also lifts stray modifiers.
        sleep(Duration::from_millis(250));
    }

    fn send_edit_key(&self, key: EditKey) -> Result<(), PlatformError> {
        let mut enigo = Enigo::new(&Settings::default()).map_err(|_| PlatformError::Keystroke)?;
        for modifier in [Key::Alt, Key::Shift, Key::Meta] {
            let _ = enigo.key(modifier, Direction::Release);
        }
        let letter = match key {
            EditKey::Copy => 'c',
            EditKey::Paste => 'v',
        };
        let result =
            enigo.key(Key::Control, Direction::Press).and_then(|_| enigo.key(Key::Unicode(letter), Direction::Click));
        let released = enigo.key(Key::Control, Direction::Release);
        result.and(released).map_err(|_| PlatformError::Keystroke)
    }

    fn clipboard(&self) -> Result<Box<dyn Clipboard>, PlatformError> {
        let board = arboard::Clipboard::new().map_err(|_| PlatformError::Clipboard)?;
        Ok(Box::new(TextClipboard { board }))
    }

    fn accessibility(&self) -> Permission {
        Permission::NotRequired
    }

    fn request_accessibility(&self) {}

    fn open_privacy_settings(&self, _pane: PrivacyPane) -> bool {
        false
    }
}

struct TextClipboard {
    board: arboard::Clipboard,
}

impl Clipboard for TextClipboard {
    fn snapshot(&mut self) -> ClipSnapshot {
        match self.board.get_text() {
            Ok(text) => vec![ClipItem { representations: vec![(TEXT_TYPE.into(), text.into_bytes())] }],
            Err(_) => Vec::new(),
        }
    }

    fn restore(&mut self, snapshot: ClipSnapshot) {
        let text = snapshot
            .into_iter()
            .flat_map(|item| item.representations)
            .find(|(kind, _)| kind == TEXT_TYPE)
            .and_then(|(_, bytes)| String::from_utf8(bytes).ok());
        let _ = match text {
            Some(text) => self.board.set_text(text),
            None => self.board.clear(),
        };
    }

    fn clear(&mut self) {
        let _ = self.board.clear();
    }

    fn read_text(&mut self) -> Option<String> {
        self.board.get_text().ok()
    }

    fn write_text(&mut self, text: &str, _transient: bool) -> bool {
        self.board.set_text(text).is_ok()
    }

    fn change_count(&mut self) -> Option<i64> {
        None
    }
}
