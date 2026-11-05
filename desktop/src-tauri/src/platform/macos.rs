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
    AXError, AXIsProcessTrusted, AXIsProcessTrustedWithOptions, AXUIElement, AXValue, AXValueType,
    kAXTrustedCheckOptionPrompt,
};
use objc2_core_foundation::{CFArray, CFBoolean, CFDictionary, CFRange, CFRetained, CFString, CFType};
use objc2_core_foundation::{CGPoint, CGSize};
use objc2_core_graphics::{CGEvent, CGEventFlags, CGEventSource, CGEventSourceStateID, CGEventTapLocation};
use objc2_foundation::{NSArray, NSData, NSString, NSURL};

use super::{
    ClipItem, ClipSnapshot, Clipboard, EditKey, FocusedApp, Permission, Platform, PlatformError, PrivacyPane,
    TextField,
};

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
        // Menu bar apps are never frontmost, so the system-wide focused
        // element is looked up in the frontmost window server application;
        // the application element alone does not answer for a text area.
        // SAFETY: the AX functions are called with valid elements and
        // attribute names; returned values are retained by `copy_attribute`.
        unsafe {
            let system = AXUIElement::new_system_wide();
            // An app that hangs must not hang the shortcut.
            let _ = system.set_messaging_timeout(0.4);
            let frontmost = NSWorkspace::sharedWorkspace().frontmostApplication()?;
            let application = AXUIElement::new_application(frontmost.processIdentifier());
            let focused = ["AXFocusedUIElement", "AXFocusedWindow"]
                .iter()
                .find_map(|name| copy_attribute(&application, name))
                .or_else(|| copy_attribute(&system, "AXFocusedUIElement"))?;
            let element = focused.downcast::<AXUIElement>().ok()?;
            let selected = copy_attribute(&element, "AXSelectedText")?.downcast::<CFString>().ok()?;
            let text = selected.to_string();
            log::info!("[gloss] selection read through accessibility ({} chars)", text.chars().count());
            Some(text)
        }
    }

    fn focused_text_field(&self) -> Option<TextField> {
        // SAFETY: the AX helpers check every status.
        unsafe { read_focused_field() }
    }

    fn write_field_text(&self, field: &TextField, text: &str) -> bool {
        if !field.editable {
            return false;
        }
        // SAFETY: the element is the one read for this field.
        let written = unsafe { write_field(field, text) };
        if written {
            // A view can accept the attribute and not redraw; the value tells.
            log::info!("[gloss] apply: wrote {} characters through accessibility", text.chars().count());
        }
        written
    }

    fn release_text_field(&self, field: &TextField) {
        release(field.token);
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
        log::info!("[gloss] sending the {} keystroke", if matches!(key, EditKey::Copy) { "copy" } else { "paste" });
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
        if unsafe { AXIsProcessTrusted() } {
            log::info!("[gloss] accessibility: granted");
            Permission::Granted
        } else {
            log::info!("[gloss] accessibility: missing (System Settings, Privacy and Security, Accessibility)");
            Permission::Missing
        }
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

// Elements handed to the rest of the app are named by a number, so the panel
// and the background checker can write into the field they read without the
// unsafe pointers crossing module boundaries. An entry is removed once the
// field it points to is dismissed or checked anew, which releases it.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

struct Registry {
    elements: HashMap<u64, *mut AXUIElement>,
}

// SAFETY: the pointers are only used as opaque handles for AX calls, which the
// Accessibility server serialises per element; the registry itself is locked.
unsafe impl Send for Registry {}

static ELEMENTS: std::sync::LazyLock<std::sync::Mutex<Registry>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(Registry { elements: HashMap::new() }));
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

/// Narrows an element to one that carries text, used when the selection does
/// not expose `AXSelectedText` itself.
unsafe fn text_subtree(element: CFRetained<AXUIElement>) -> CFRetained<AXUIElement> {
    // SAFETY: an element without children answers with an error, ignored.
    unsafe {
        let Some(children) = copy_attribute(&element, "AXChildren")
            .and_then(|value| value.downcast::<CFArray>().ok())
        else {
            return element;
        };
        // SAFETY: the index stays inside the array the value came from.
        for index in 0..children.count() {
            let raw = children.value_at_index(index);
            let Some(pointer) = NonNull::new(raw.cast_mut()) else { continue };
            let item = CFRetained::retain(pointer.cast::<CFType>());
            let Ok(child) = item.downcast::<AXUIElement>() else { continue };
            if copy_attribute(&child, "AXValue").or_else(|| copy_attribute(&child, "AXStringValue")).is_some() {
                return child;
            }
        }
        element
    }
}

fn register(element: CFRetained<AXUIElement>) -> u64 {
    let mut registry = ELEMENTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // The registry never grows past a handful of fields.
    if registry.elements.len() >= 32 {
        for (_, raw) in registry.elements.drain() {
            // SAFETY: the registry owned the +1 reference until this line.
            drop(unsafe { CFRetained::from_raw(NonNull::new(raw).unwrap()) });
        }
    }
    let token = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
    registry.elements.insert(token, CFRetained::into_raw(element).as_ptr() as *mut AXUIElement);
    token
}

fn element_for(token: u64) -> Option<CFRetained<AXUIElement>> {
    let registry = ELEMENTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let raw = *registry.elements.get(&token)?;
    let pointer = NonNull::new(raw)?;
    // SAFETY: the registry holds the +1 reference until the token is released.
    Some(unsafe { CFRetained::retain(pointer) })
}

fn release(token: u64) {
    let mut registry = ELEMENTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(raw) = registry.elements.remove(&token)
        && let Some(pointer) = NonNull::new(raw)
    {
        // SAFETY: the registry's +1 reference is dropped exactly once.
        drop(unsafe { CFRetained::from_raw(pointer) });
    }
}

/// The text field at the frontmost app's focus, when it holds text.
unsafe fn read_focused_field() -> Option<TextField> {
    // SAFETY: every AX call below uses valid elements and attribute names and
    // checks its status; the frontmost app answers for its own focus.
    unsafe {
        let frontmost = NSWorkspace::sharedWorkspace().frontmostApplication()?;
        let application = AXUIElement::new_application(frontmost.processIdentifier());
        let _ = application.set_messaging_timeout(0.4);
        let focused = ["AXFocusedUIElement", "AXFocusedWindow"]
            .iter()
            .find_map(|name| copy_attribute(&application, name))?;
        // Safari, Mail and other rich text views put the text on a child
        // element; the number is registered on the element that holds it.
        let element = text_subtree(focused.downcast::<AXUIElement>().ok()?);
        let role = copy_attribute(&element, "AXRole").and_then(|value| value.downcast::<CFString>().ok());
        let role = role.map(|role| role.to_string()).unwrap_or_default();
        // Secure fields never expose their text; leave them alone.
        if role.contains("Secure") || is_secure(&element) {
            return None;
        }
        let value = copy_attribute(&element, "AXValue")
            .or_else(|| copy_attribute(&element, "AXStringValue"))
            .and_then(|value| value.downcast::<CFString>().ok())
            .map(|value| value.to_string())?;
        let selection = copy_attribute(&element, "AXSelectedTextRange")
            .and_then(|value| value.downcast::<AXValue>().ok())
            .and_then(|value| ax_range(&value))
            .map(|range| (range.location.max(0) as usize, range.length.max(0) as usize));
        let frame = copy_attribute(&element, "AXPosition")
            .and_then(|value| value.downcast::<AXValue>().ok())
            .and_then(|position| ax_point(&position))
            .zip(
                copy_attribute(&element, "AXSize")
                    .and_then(|value| value.downcast::<AXValue>().ok())
                    .and_then(|size| ax_size(&size)),
            )
            .map(|((x, y), (width, height))| (x, y, width, height));
        let editable = is_true(&element, "AXEditable") || value_is_settable(&element);
        let token = register(element);
        Some(TextField { value, selection, frame, editable, token })
    }
}

unsafe fn value_is_settable(element: &AXUIElement) -> bool {
    // AXUIElementIsAttributeSettable answers unsigned char: 0 or 1.
    let mut settable: u8 = 0;
    let attribute = CFString::from_static_str("AXValue");
    // SAFETY: `settable` is a valid out pointer for one byte.
    let status = unsafe { element.is_attribute_settable(&attribute, NonNull::from(&mut settable)) };
    status == AXError::Success && settable != 0
}

unsafe fn is_true(element: &AXUIElement, name: &'static str) -> bool {
    unsafe {
        copy_attribute(element, name)
            .and_then(|value| value.downcast::<CFBoolean>().ok())
            .map(|value| value.as_bool())
            .unwrap_or(false)
    }
}

unsafe fn is_secure(element: &AXUIElement) -> bool {
    // A password field reports its role as AXTextField but refuses AXValue;
    // the subrole "AXSecureTextField" is the documented marker.
    unsafe {
        copy_attribute(element, "AXSubrole")
            .and_then(|value| value.downcast::<CFString>().ok())
            .map(|subrole| subrole.to_string() == "AXSecureTextField")
            .unwrap_or(false)
    }
}

// SAFETY: the out pointers are plain C structs of the requested type.
unsafe fn ax_range(value: &AXValue) -> Option<CFRange> {
    let mut out = CFRange { location: 0, length: 0 };
    unsafe { value.value(AXValueType::CFRange, NonNull::from(&mut out).cast()) }.then_some(out)
}

unsafe fn ax_point(value: &AXValue) -> Option<(f64, f64)> {
    let mut out = CGPoint { x: 0.0, y: 0.0 };
    unsafe { value.value(AXValueType::CGPoint, NonNull::from(&mut out).cast()) }.then_some((out.x, out.y))
}

unsafe fn ax_size(value: &AXValue) -> Option<(f64, f64)> {
    let mut out = CGSize { width: 0.0, height: 0.0 };
    unsafe { value.value(AXValueType::CGSize, NonNull::from(&mut out).cast()) }.then_some((out.width, out.height))
}

unsafe fn ax_range_value(range: CFRange) -> Option<CFRetained<AXValue>> {
    unsafe { AXValue::new(AXValueType::CFRange, NonNull::from(&range).cast()) }
}

/// Sets `AXValue` (or `AXSelectedText`) on the element to `text`, keeping
/// the caret at the end. True when the app accepted it.
unsafe fn write_field(field: &TextField, text: &str) -> bool {
    let Some(element) = element_for(field.token) else { return false };
    let string = CFString::from_str(text);
    // SAFETY: the element is the one read for this field; the strings, ranges
    // and values are plain values that outlive each call.
    unsafe {
        // Select the whole value first, so a view that does not take AXValue
        // replaces its text through the selection instead.
        let length = field.value.encode_utf16().count() as isize;
        if let Some(range) = ax_range_value(CFRange { location: 0, length }) {
            let _ = element.set_attribute_value(&CFString::from_static_str("AXSelectedTextRange"), range.as_ref());
        }
        let selected = element.set_attribute_value(
            &CFString::from_static_str("AXSelectedText"),
            string.as_ref(),
        );
        let value = element.set_attribute_value(&CFString::from_static_str("AXValue"), string.as_ref());
        if selected == AXError::Success || value == AXError::Success {
            // Leave the caret at the end of what was written.
            if let Some(range) = ax_range_value(CFRange { location: length, length: 0 }) {
                let _ = element.set_attribute_value(
                    &CFString::from_static_str("AXSelectedTextRange"),
                    range.as_ref(),
                );
            }
            return true;
        }
        false
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
