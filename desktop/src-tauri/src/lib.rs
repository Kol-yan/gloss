//! gloss desktop: a tray app that checks the text selected in any app and
//! dictates into any text field, using a gloss server for both.

mod api;
mod audio;
mod check;
mod commands;
mod credentials;
mod dictation;
mod platform;
mod selection;
mod settings;
mod shortcuts;
mod state;
mod text;
mod tray;
mod wav;
mod windows;

use tauri::{Manager, RunEvent, WindowEvent};

use crate::settings::SettingsStore;
use crate::state::AppState;

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

            let config_dir = app.path().app_config_dir()?;
            app.manage(AppState::new(SettingsStore::new(&config_dir)));

            let handle = app.handle().clone();
            tray::build(&handle)?;
            shortcuts::register_saved(&handle);

            let signed_in = app.state::<AppState>().session().is_some();
            if !signed_in {
                windows::show_settings(&handle);
            }
            tauri::async_runtime::spawn(async move {
                state::refresh_account(&handle).await;
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
                }
            }
            WindowEvent::Focused(false) if window.label() == "panel" => check::on_blur(window.app_handle()),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_overview,
            commands::refresh_account,
            commands::save_server_url,
            commands::sign_in_with_invite,
            commands::sign_in_with_session,
            commands::sign_out,
            commands::save_shortcuts,
            commands::suspend_shortcuts,
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
