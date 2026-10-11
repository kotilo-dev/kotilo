//! WebView settings shared by the app's focusable windows (main, M7 assistant).

/// D18: WebView2 has browser-like accelerator keys enabled by default (Ctrl+P print,
/// Ctrl+F find, F5 reload, Ctrl+Shift+J devtools, ...), which collide with Kotilo's
/// own shortcuts (`Ctrl+P` file search, `Ctrl+Shift+F` terminal search, ...).
///
/// Tauri 2.12 / wry 0.57 have no `tauri.conf.json` flag for this (checked the vendored
/// crate sources — see DECISIONS.md D18); wry itself supports it only through
/// `WebViewBuilderExtWindows::with_browser_accelerator_keys`, which isn't wired up by
/// Tauri's `WebviewWindowBuilder`. The documented escape hatch is
/// `WebviewWindow::with_webview`, which hands us the raw `ICoreWebView2Controller` so we
/// can call the underlying COM API (`ICoreWebView2Settings3::SetAreBrowserAcceleratorKeysEnabled`)
/// directly. Other systems: nothing to do.
#[cfg(windows)]
pub fn disable_browser_accelerator_keys<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> tauri::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    window.with_webview(|webview| {
        let controller = webview.controller();
        // SAFETY: `controller` is a valid, live ICoreWebView2Controller for this window
        // (handed to us by Tauri inside `with_webview`, which runs on the main thread
        // before the window is dropped). All calls below are plain COM getters/setters.
        unsafe {
            let Ok(core_webview) = controller.CoreWebView2() else {
                return;
            };
            let Ok(settings) = core_webview.Settings() else {
                return;
            };
            let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() else {
                return;
            };
            let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    })
}

#[cfg(not(windows))]
pub fn disable_browser_accelerator_keys<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) -> tauri::Result<()> {
    Ok(())
}
