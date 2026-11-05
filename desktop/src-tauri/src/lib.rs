//! gloss desktop: a tray app that checks the text selected in any app and
//! dictates into any text field, using a gloss server for both.

mod api;
mod audio;
mod auto_check;
mod check;
mod commands;
mod credentials;
mod dictation;
mod platform;
mod push_to_talk;
mod selection;
mod settings;
mod shortcuts;
mod state;
#[cfg(debug_assertions)]
mod test_hook;
mod text;
mod tray;
mod wav;
mod windows;

use tauri::{Manager, RunEvent, WindowEvent};

use crate::settings::SettingsStore;
use crate::state::AppState;

/// A tiny loopback endpoint that runs the manual tests of the automatic
/// checker, because macOS refuses synthetic keystrokes to a terminal here.
/// It exists only in debug builds and only answers on 127.0.0.1.
#[cfg(all(target_os = "macos", debug_assertions))]
fn start_test_hook(app: tauri::AppHandle) {
    let Ok(store_dir) = app.path().app_config_dir() else { return };
    let marker = store_dir.join("test-hook.json");
    let Some(token) = std::fs::read(&marker).ok().and_then(|bytes| test_hook::marker_token(&bytes)) else { return };
    std::thread::spawn(move || {
        use std::io::{Read, Write};
        let Ok(listener) = std::net::TcpListener::bind("127.0.0.1:4211") else { return };
        log::info!("[gloss] test hook on 127.0.0.1:4211");
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 1024];
            while bytes.len() < 8192 && !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => bytes.extend_from_slice(&buffer[..read]),
                }
            }
            let request = String::from_utf8_lossy(&bytes);
            if !test_hook::authorized(&request, &token) {
                let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
                continue;
            }
            let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
            let text = path
                .split_once("text=")
                .and_then(|(_, rest)| url_decode(&rest.split('&').next().unwrap_or("")))
                .unwrap_or_else(|| "He go to school yesterday.".to_string());
            if request.starts_with("POST /simulate_typing") {
                commands::simulate_typing(app.clone(), text);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
            } else if request.starts_with("POST /apply_last_fixes") {
                let outcome = commands::apply_last_fixes(app.clone());
                let body = match outcome {
                    Ok(text) => format!("ok: {text}"),
                    Err(error) => format!("err: {error}"),
                };
                let _ = stream.write_all(
                    format!("HTTP/1.1 200 OK\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}", body.len()).as_bytes(),
                );
            } else if request.starts_with("POST /open_last_field") {
                commands::open_last_field(app.clone());
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
            } else if request.starts_with("POST /badge_click") {
                commands::badge_click(app.clone());
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
            } else {
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
            }
        }
    });
}

#[cfg(all(target_os = "macos", debug_assertions))]
fn url_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Must come first: a second launch only opens the settings window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| windows::show_settings(app)))
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(shortcuts::handle).build())
        .setup(|app| {
            // A menu-bar app: no Dock icon and no app menu.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(all(target_os = "macos", debug_assertions))]
            start_test_hook(app.handle().clone());

            let config_dir = app.path().app_config_dir()?;
            app.manage(AppState::new(SettingsStore::new(&config_dir)));

            let handle = app.handle().clone();
            tray::build(&handle)?;
            // The right Option monitor first: on macOS the dictation setting
            // is the key itself, not a global shortcut.
            push_to_talk::start(&handle, &app.state::<AppState>().settings().dictation_shortcut);
            shortcuts::register_saved(&handle);

            // There is no sign-in: the first launch creates a guest
            // workspace, and the settings window opens on first launch only.
            let first_launch = app.state::<AppState>().session().is_none();
            if first_launch {
                windows::show_settings(&handle);
            }
            let auto = handle.clone();
            tauri::async_runtime::spawn(async move {
                commands::ensure_guest(&auto).await;
                state::refresh_account(&auto).await;
                // Checking as you type needs the session the guest creation
                // just stored.
                auto_check::runtime::start(&auto);
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing hides; the tray keeps the app running.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.label() == "panel" {
                    check::dismiss(window.app_handle(), true);
                } else {
                    let _ = window.hide();
                    windows::settings_closed(window.app_handle());
                }
            }
            WindowEvent::Focused(false) if window.label() == "panel" => check::on_blur(window.app_handle()),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_overview,
            commands::refresh_account,
            commands::save_server_url,
            commands::save_shortcuts,
            commands::suspend_shortcuts,
            commands::shortcut_pressed,
            commands::set_check_as_you_type,
            commands::badge_click,
            #[cfg(debug_assertions)]
            commands::simulate_typing,
            #[cfg(debug_assertions)]
            commands::open_last_field,
            #[cfg(debug_assertions)]
            commands::apply_last_fixes,
            commands::resume_shortcuts,
            commands::request_accessibility,
            commands::open_microphone_settings,
            commands::open_editor,
            commands::panel_state,
            commands::panel_preview,
            commands::panel_apply,
            commands::panel_copy,
            commands::panel_fit,
            commands::panel_dismiss,
            commands::panel_action,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the gloss desktop app");

    app.run(|_app, event| {
        // Hiding the last window must not quit a tray app; only Quit does.
        if let RunEvent::ExitRequested { code: None, api, .. } = event {
            api.prevent_exit();
        }
    });
}
