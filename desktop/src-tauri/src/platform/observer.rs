//! macOS Accessibility observer of the frontmost app's focus.
//!
//! The app watches two notifications: the focus moving to another element and
//! the focused element's text changing. The callback hands plain data to the
//! closure, so the checking logic never touches AppKit types.

use std::ptr::NonNull;

use objc2_application_services::{AXError, AXObserver, AXUIElement};
use objc2_core_foundation::{CFRunLoop, CFRunLoopSource, CFRetained, CFString, kCFRunLoopCommonModes};

/// Which notification arrived.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notice {
    FocusChanged,
    ValueChanged,
}

/// One installed observer for one application process.
pub struct Observation {
    observer: CFRetained<AXObserver>,
    run_loop_source: CFRetained<CFRunLoopSource>,
}

// The observer is only touched on the main thread where it was created.
unsafe impl Send for Observation {}

/// Starts observing `pid`'s focus and value changes on the main run loop.
/// `handler` runs on the main thread.
pub fn observe(pid: i32, handler: impl Fn(Notice) + Send + 'static) -> Option<Observation> {
    let context = Box::into_raw(Box::new(Context { handler: Box::new(handler) })) as *mut std::ffi::c_void;
    let mut out: *mut AXObserver = std::ptr::null_mut();
    // SAFETY: `out` is a valid pointer for the created observer; the callback
    // and its refcon stay alive until the observer is released below.
    let status = unsafe { AXObserver::create(pid, Some(callback), NonNull::from(&mut out)) };
    if status != AXError::Success {
        // SAFETY: the context was not handed to an observer.
        drop(unsafe { Box::from_raw(context.cast::<Context>()) });
        return None;
    }
    let observer = unsafe { CFRetained::from_raw(NonNull::new(out)?) };
    let focus = CFString::from_static_str("AXFocusedUIElementChangedNotification");
    let value = CFString::from_static_str("AXValueChangedNotification");
    // SAFETY: the observer, element and notification strings outlive the calls;
    // the refcon box is freed when the observation is booked.
    let run_loop_source = unsafe {
        let application = AXUIElement::new_application(pid);
        let _ = observer.add_notification(&application, &focus, context);
        let _ = observer.add_notification(&application, &value, context);
        observer.run_loop_source()
    };
    let modes = unsafe { kCFRunLoopCommonModes };
    CFRunLoop::main()?.add_source(Some(&run_loop_source), modes);
    Some(Observation { observer, run_loop_source })
}

impl Drop for Observation {
    fn drop(&mut self) {
        let modes = unsafe { kCFRunLoopCommonModes };
        if let Some(run_loop) = CFRunLoop::main() {
            run_loop.remove_source(Some(&self.run_loop_source), modes);
        }
        // The observer's refcon is freed with the context box by the caller.
        let _ = self.observer.clone();
    }
}

struct Context {
    handler: Box<dyn Fn(Notice) + Send>,
}

extern "C-unwind" fn callback(
    _observer: NonNull<AXObserver>,
    _element: NonNull<AXUIElement>,
    notification: NonNull<CFString>,
    refcon: *mut std::ffi::c_void,
) {
    if refcon.is_null() {
        return;
    }
    // SAFETY: the refcon is the box created in `observe`, still owned there.
    let context = unsafe { &*(refcon.cast::<Context>()) };
    // SAFETY: the notification name is a live string for the call.
    let name = unsafe { notification.as_ref() }.to_string();
    let notice = match name.as_str() {
        "AXFocusedUIElementChanged" => Notice::FocusChanged,
        "AXValueChanged" => Notice::ValueChanged,
        _ => return,
    };
    (context.handler)(notice);
}
