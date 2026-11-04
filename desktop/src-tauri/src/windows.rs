//! The settings window and the floating panel. Both are declared in
//! `tauri.conf.json`, created hidden at start-up and reused.

use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition};

const SETTINGS: &str = "settings";
const PANEL: &str = "panel";
// Distance between the pointer and the panel's corner.
const POINTER_GAP: f64 = 14.0;
const PANEL_WIDTH: f64 = 440.0;
const PANEL_MIN_HEIGHT: f64 = 150.0;
const PANEL_MAX_HEIGHT: f64 = 560.0;

pub fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SETTINGS) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn panel_visible(app: &AppHandle) -> bool {
    app.get_webview_window(PANEL).and_then(|window| window.is_visible().ok()).unwrap_or(false)
}

/// Shows the panel next to the pointer, kept inside the screen's usable area.
/// An already visible panel stays where it is.
pub fn show_panel(app: &AppHandle) {
    let Some(window) = app.get_webview_window(PANEL) else { return };
    if !window.is_visible().unwrap_or(false)
        && let Some(position) = position_near_pointer(app)
    {
        let _ = window.set_position(position);
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Resizes the panel to the height its content needs (in logical pixels) and
/// keeps it on screen.
pub fn fit_panel(app: &AppHandle, height: f64) {
    let Some(window) = app.get_webview_window(PANEL) else { return };
    let height = height.clamp(PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT);
    if window.set_size(LogicalSize::new(PANEL_WIDTH, height)).is_err() {
        return;
    }
    let (Ok(position), Ok(size), Ok(Some(monitor))) =
        (window.outer_position(), window.outer_size(), window.current_monitor())
    else {
        return;
    };
    let area = monitor.work_area();
    let bottom = area.position.y + area.size.height as i32;
    if position.y + size.height as i32 > bottom {
        let y = (bottom - size.height as i32).max(area.position.y);
        let _ = window.set_position(PhysicalPosition::new(position.x, y));
    }
}

pub fn hide_panel(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PANEL) {
        let _ = window.hide();
    }
}

fn position_near_pointer(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let window = app.get_webview_window(PANEL)?;
    let pointer = app.cursor_position().ok()?;
    let monitor = app.monitor_from_point(pointer.x, pointer.y).ok().flatten()?;
    let size = window.outer_size().ok()?;
    let area = monitor.work_area();
    let gap = POINTER_GAP * monitor.scale_factor();
    let (left, top) = (area.position.x as f64, area.position.y as f64);
    let (right, bottom) = (left + area.size.width as f64, top + area.size.height as f64);
    let (width, height) = (size.width as f64, size.height as f64);

    // Below and to the right of the pointer, flipped when that would not fit.
    let mut x = pointer.x + gap;
    if x + width > right {
        x = pointer.x - gap - width;
    }
    let mut y = pointer.y + gap;
    if y + height > bottom {
        y = pointer.y - gap - height;
    }
    let x = x.clamp(left, (right - width).max(left));
    let y = y.clamp(top, (bottom - height).max(top));
    Some(PhysicalPosition::new(x.round() as i32, y.round() as i32))
}
