//! U-3: macOS app lifecycle. A Dock click brings the main window back (it may be hidden
//! by "keep running in the tray", D-058), and Cmd+Q goes through the window's close path
//! (the frontend's `CloseGuard`: unsaved-changes prompt, tray) instead of Tauri's default
//! menu item, which terminates the app at once (`terminate:` → `RunEvent::Exit`). Other
//! systems: nothing changes.

use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime};

/// Main window label (`tauri.conf.json`).
const MAIN: &str = "main";
/// Menu id of the app menu's Quit item (macOS).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const QUIT_ID: &str = "app-quit";
/// Emitted to the main window when Quit is chosen while "keep running in the tray" is on:
/// the frontend answers with its tray Quit (`requestQuit`), since a plain close would only
/// hide the window.
pub const QUIT_REQUESTED_EVENT: &str = "app:quit-requested";

/// Installs the macOS app menu (Tauri's default one, with Quit routed through
/// [`request_quit`] and without "Close Window": its Cmd+W would close the whole app
/// window instead of reaching the app's own tab shortcut).
pub fn configure<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(target_os = "macos")]
    {
        builder.menu(macos_menu::<R>).on_menu_event(|app, event| {
            if event.id().0 == QUIT_ID {
                request_quit(app);
            }
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder
    }
}

/// Run-loop events this layer handles (macOS: `Reopen` from a Dock click).
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    #[cfg(target_os = "macos")]
    if let RunEvent::Reopen { .. } = event {
        show_main_window(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

/// Shows, restores and focuses the main window.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Quit from the app menu: the same path as closing the window. With "keep running in the
/// tray" on, the window comes back and the frontend runs its tray Quit.
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN) else {
        app.exit(0);
        return;
    };
    let close_to_tray = app
        .try_state::<crate::settings::SettingsStore>()
        .is_some_and(|s| close_to_tray(&s.get().extra));
    if close_to_tray {
        show_main_window(app);
        let _ = window.emit(QUIT_REQUESTED_EVENT, ());
    } else {
        let _ = window.close();
    }
}

/// `settings.window.closeToTray` (kept by the frontend; Rust carries it in `extra`).
pub fn close_to_tray(extra: &serde_json::Map<String, serde_json::Value>) -> bool {
    extra
        .get("window")
        .and_then(|w| w.get("closeToTray"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn macos_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        ..Default::default()
    };
    let quit = MenuItem::with_id(app, QUIT_ID, format!("Quit {}", pkg.name), true, Some("Cmd+Q"))?;
    let app_menu = Submenu::with_items(
        app,
        pkg.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    // Cut/copy/paste/select-all/undo need these items to reach the webview on macOS.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_to_tray_reads_the_window_setting() {
        let parse = |v: serde_json::Value| v.as_object().cloned().unwrap_or_default();
        assert!(close_to_tray(&parse(serde_json::json!({"window": {"closeToTray": true}}))));
        assert!(!close_to_tray(&parse(serde_json::json!({"window": {"closeToTray": false}}))));
        assert!(!close_to_tray(&parse(serde_json::json!({"window": {}}))));
        assert!(!close_to_tray(&parse(serde_json::json!({}))));
    }
}
