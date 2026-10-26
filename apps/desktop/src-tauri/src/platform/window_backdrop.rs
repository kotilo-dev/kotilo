//! D-065: what shows through a translucent main window. The window itself is always created
//! transparent (`tauri.conf.json`); the page paints its background with the chosen opacity.
//! On Windows the system acrylic backdrop can blur what is behind it (like Windows Terminal);
//! elsewhere the desktop shows through unblurred.

use tauri::WebviewWindow;

/// Turns the blurred backdrop on or off.
pub fn apply(window: &WebviewWindow, blur: bool) {
    #[cfg(windows)]
    {
        use tauri::window::{Effect, EffectsBuilder};
        let effects = blur.then(|| EffectsBuilder::new().effect(Effect::Acrylic).build());
        if let Err(err) = window.set_effects(effects) {
            log::warn!("window backdrop could not be changed: {err}");
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (window, blur);
    }
}
