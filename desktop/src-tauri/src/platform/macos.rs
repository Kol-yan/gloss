//! macOS: the Accessibility API reads selections, Quartz events send Copy and
//! Paste, and NSPasteboard is saved and restored with every representation.
//!
//! Reading another app's selection and posting keystrokes both require the
//! Accessibility permission (System Settings → Privacy & Security →
//! Accessibility).

use std::ptr::NonNull;
use std::thread::sleep;
use std::time::{Duration, Instant};

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{
    NSApplicationActivationOptions, NSPasteboard, NSPasteboardItem, NSPasteboardTypeString, NSPasteboardWriting,
    NSRunningApplication, NSWorkspace,
};
use objc2_application_services::{
    AXError, AXIsProcessTrusted, AXIsProcessTrustedWithOptions, AXUIElement, kAXTrustedCheckOptionPrompt,
};
use objc2_core_foundation::{CFBoolean, CFDictionary, CFRetained, CFString, CFType};
use objc2_core_graphics::{CGEvent, CGEventFlags, CGEventSource, CGEventSourceStateID, CGEventTapLocation};
use objc2_foundation::{NSArray, NSData, NSString, NSURL};

use super::{ClipItem, ClipSnapshot, Clipboard, EditKey, FocusedApp, Permission, Platform, PlatformError, PrivacyPane};

// Virtual key codes of the ANSI C and V keys. Command shortcuts in non-Latin
// layouts resolve through these positions too.
const KEY_C: u16 = 8;
const KEY_V: u16 = 9;

// Pasteboard markers from nspasteboard.org that clipboard managers honour.
const TRANSIENT_TYPE: &str = "org.nspasteboard.TransientType";

pub struct MacPlatform;

impl Platform for MacPlatform {
    fn focused_app(&self) -> Option<FocusedApp> {
        let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
        Some(FocusedApp { pid: app.processIdentifier() })
    }

    fn is_own_app(&self, app: FocusedApp) -> bool {
        app.pid == std::process::id() as i32
    }

    fn activate(&self, app: FocusedApp) -> bool {
        let Some(running) = NSRunningApplication::runningApplicationWithProcessIdentifier(app.pid) else {
            return false;
        };
        running.activateWithOptions(NSApplicationActivationOptions::empty());
        let deadline = Instant::now() + Duration::from_millis(600);
        while Instant::now() < deadline {
            if self.focused_app() == Some(app) {
                // Give the app a moment to restore its key window and caret.
                sleep(Duration::from_millis(60));
                return true;
            }
            sleep(Duration::from_millis(20));
        }
        false
    }

    fn selected_text(&self) -> Option<String> {
        // SAFETY: the AX functions are called with valid elements and
        // attribute names; returned values are retained by `copy_attribute`.
        unsafe {
            let system = AXUIElement::new_system_wide();
            // An app that hangs must not hang the shortcut.
            let _ = system.set_messaging_timeout(0.4);
            let focused = copy_attribute(&system, "AXFocusedUIElement")?.downcast::<AXUIElement>().ok()?;
            let selected = copy_attribute(&focused, "AXSelectedText")?.downcast::<CFString>().ok()?;
            Some(selected.to_string())
        }
    }

    fn wait_for_modifier_release(&self) {
        let modifiers = CGEventFlags::MaskCommand
            | CGEventFlags::MaskControl
            | CGEventFlags::MaskAlternate
            | CGEventFlags::MaskShift;
        let deadline = Instant::now() + Duration::from_millis(800);
        while Instant::now() < deadline {
            if (CGEventSource::flags_state(CGEventSourceStateID::HIDSystemState) & modifiers).is_empty() {
                return;
            }
            sleep(Duration::from_millis(15));
        }
    }

    fn send_edit_key(&self, key: EditKey) -> Result<(), PlatformError> {
        let code = match key {
            EditKey::Copy => KEY_C,
            EditKey::Paste => KEY_V,
        };
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState);
        let down = CGEvent::new_keyboard_event(source.as_deref(), code, true).ok_or(PlatformError::Keystroke)?;
        let up = CGEvent::new_keyboard_event(source.as_deref(), code, false).ok_or(PlatformError::Keystroke)?;
        // Explicit flags: the event is Command+key even if other modifiers
        // of the shortcut are still held down.
        CGEvent::set_flags(Some(&down), CGEventFlags::MaskCommand);
        CGEvent::set_flags(Some(&up), CGEventFlags::MaskCommand);
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&down));
        sleep(Duration::from_millis(12));
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&up));
        Ok(())
    }

    fn clipboard(&self) -> Result<Box<dyn Clipboard>, PlatformError> {
        Ok(Box::new(MacClipboard { board: NSPasteboard::generalPasteboard() }))
    }

    fn accessibility(&self) -> Permission {
        // SAFETY: a plain query without arguments.
        if unsafe { AXIsProcessTrusted() } { Permission::Granted } else { Permission::Missing }
    }

    fn request_accessibility(&self) {
        // SAFETY: the options dictionary holds the documented prompt key.
        unsafe {
            let options = CFDictionary::<CFString, CFBoolean>::from_slices(
                &[kAXTrustedCheckOptionPrompt],
                &[CFBoolean::new(true)],
            );
            AXIsProcessTrustedWithOptions(Some(options.as_opaque()));
        }
    }

    fn open_privacy_settings(&self, pane: PrivacyPane) -> bool {
        let anchor = match pane {
            PrivacyPane::Accessibility => "Privacy_Accessibility",
            PrivacyPane::Microphone => "Privacy_Microphone",
        };
        let link = format!("x-apple.systempreferences:com.apple.preference.security?{anchor}");
        match NSURL::URLWithString(&NSString::from_str(&link)) {
            Some(url) => NSWorkspace::sharedWorkspace().openURL(&url),
            None => false,
        }
    }
}

unsafe fn copy_attribute(element: &AXUIElement, name: &'static str) -> Option<CFRetained<CFType>> {
    let attribute = CFString::from_static_str(name);
    let mut value: *const CFType = std::ptr::null();
    // SAFETY: `value` is a valid out pointer; on success it holds a +1 reference.
    let status = unsafe { element.copy_attribute_value(&attribute, NonNull::from(&mut value)) };
    if status != AXError::Success {
        return None;
    }
    let value = NonNull::new(value.cast_mut())?;
    // SAFETY: the Copy rule gives us ownership of the returned reference.
    Some(unsafe { CFRetained::from_raw(value) })
}

struct MacClipboard {
    board: Retained<NSPasteboard>,
}

impl Clipboard for MacClipboard {
    fn snapshot(&mut self) -> ClipSnapshot {
        let Some(items) = self.board.pasteboardItems() else {
            return Vec::new();
        };
        items
            .iter()
            .map(|item| ClipItem {
                representations: item
                    .types()
                    .iter()
                    .filter_map(|kind| item.dataForType(&kind).map(|data| (kind.to_string(), data.to_vec())))
                    .collect(),
            })
            .collect()
    }

    fn restore(&mut self, snapshot: ClipSnapshot) {
        self.board.clearContents();
        if snapshot.is_empty() {
            return;
        }
        let objects: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = snapshot
            .iter()
            .map(|item| {
                let pasteboard_item = NSPasteboardItem::new();
                for (kind, bytes) in &item.representations {
                    pasteboard_item.setData_forType(&NSData::with_bytes(bytes), &NSString::from_str(kind));
                }
                ProtocolObject::from_retained(pasteboard_item)
            })
            .collect();
        self.board.writeObjects(&NSArray::from_retained_slice(&objects));
    }

    fn clear(&mut self) {
        self.board.clearContents();
    }

    fn read_text(&mut self) -> Option<String> {
        // SAFETY: NSPasteboardTypeString is a constant provided by AppKit.
        let kind = unsafe { NSPasteboardTypeString };
        self.board.stringForType(kind).map(|text| text.to_string())
    }

    fn write_text(&mut self, text: &str, transient: bool) -> bool {
        self.board.clearContents();
        let item = NSPasteboardItem::new();
        // SAFETY: NSPasteboardTypeString is a constant provided by AppKit.
        let kind = unsafe { NSPasteboardTypeString };
        let ok = item.setString_forType(&NSString::from_str(text), kind);
        if transient {
            item.setData_forType(&NSData::new(), &NSString::from_str(TRANSIENT_TYPE));
        }
        ok && self.board.writeObjects(&NSArray::from_retained_slice(&[ProtocolObject::from_retained(item)]))
    }

    fn change_count(&mut self) -> Option<i64> {
        Some(self.board.changeCount() as i64)
    }
}
