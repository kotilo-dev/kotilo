//! Folder picker for "Add workspace".
//!
//! Why not the dialog plugin's JS `open()`: it shows the dialog *owned* by the main
//! window. An owned window shares the owner's input state, and when the dialog was
//! opened by a keystroke (command palette + Enter) Windows' "hide pointer while typing"
//! keeps the mouse pointer hidden for the whole life of the dialog — moving the mouse
//! doesn't bring it back. Measured with `GetCursorInfo`: owned → hidden, unowned →
//! visible. So the dialog is shown without an owner, and the main window is disabled
//! meanwhile so it still behaves like a modal dialog; afterwards the main window is
//! re-enabled and brought back to the front.
//!
//! Being unowned has its own downside (review item 3): Windows can still activate the
//! main window (taskbar click, Alt+Tab) even while `ModalGuard` holds it disabled, which
//! then sits *on top of* the actually-modal picker instead of the other way around — the
//! app looks hung. [`PICKER_OPEN`] + [`refocus_picker_if_open`] paper over that: while a
//! picker is open, a watcher thread (started by `ModalGuard`) brings it back to the front
//! whenever the main window becomes the foreground window.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// Set for as long as an unowned picker dialog is on screen (review item 3). Read by
/// the `ModalGuard` watcher thread (it runs while this is set) and
/// [`refocus_picker_if_open`].
#[cfg(windows)]
pub(crate) static PICKER_OPEN: AtomicBool = AtomicBool::new(false);

/// Guards against two concurrent pickers (review item 4) — e.g. a double command-palette
/// invocation before the first dialog has opened. A second `pick_folders` call while one
/// is already open returns `[]` immediately rather than opening a second native dialog:
/// [`PICKER_OPEN`]/`ModalGuard` only ever track one picker at a time, so a second one
/// would fight it.
static IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Resets [`IN_FLIGHT`] on drop, tied to a guard object so a panic anywhere inside
/// `pick_folders` can't leave the flag stuck `true` for the rest of the app's life.
struct InFlightGuard;

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

/// Disables `window` while alive; re-enables and refocuses it on drop (also on panic).
#[cfg(windows)]
// Stored as an integer so the guard is `Send` across the command's `.await`.
struct ModalGuard(isize);

#[cfg(windows)]
impl ModalGuard {
    fn new(window: &WebviewWindow) -> Option<Self> {
        use windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
        let raw = window.hwnd().ok()?.0;
        let hwnd = windows::Win32::Foundation::HWND(raw);
        // SAFETY: `hwnd` is our live main window handle.
        unsafe {
            let _ = EnableWindow(hwnd, false);
        }
        // Review item 3: from here until `Drop`, a stray main-window activation should
        // bring the picker back to the front instead of leaving it hidden behind it.
        // A disabled window never gets a focus event (measured: `WindowEvent::Focused`
        // doesn't fire), so a small watcher polls the foreground window instead — it
        // lives only while the picker is open.
        PICKER_OPEN.store(true, Ordering::SeqCst);
        let main = raw as isize;
        std::thread::spawn(move || {
            use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
            while PICKER_OPEN.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(150));
                // SAFETY: read-only query of the current foreground window.
                if unsafe { GetForegroundWindow() }.0 as isize == main {
                    refocus_picker_if_open();
                }
            }
        });
        Some(Self(main))
    }
}

#[cfg(windows)]
impl Drop for ModalGuard {
    fn drop(&mut self) {
        use windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
        use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
        // Cleared first: re-enabling the main window just below can itself generate a
        // focus event, which must not try to refocus a picker that's already closing.
        PICKER_OPEN.store(false, Ordering::SeqCst);
        let hwnd = windows::Win32::Foundation::HWND(self.0 as *mut core::ffi::c_void);
        // SAFETY: see `new`; re-enabling before refocusing, as for a real modal dialog.
        unsafe {
            let _ = EnableWindow(hwnd, true);
            let _ = SetForegroundWindow(hwnd);
        }
    }
}

/// Review item 3: brings a currently-open unowned picker dialog back to the foreground.
/// Called by the `ModalGuard` watcher when the main window is in front. Finds this process's own visible top-level window of class `#32770` (the
/// standard Windows common-dialog class — folder/file pickers, message boxes) and
/// focuses it; a no-op if no picker is open, or none is found (e.g. it just closed).
#[cfg(windows)]
pub(crate) fn refocus_picker_if_open() {
    if !PICKER_OPEN.load(Ordering::SeqCst) {
        return;
    }

    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow,
    };

    /// `EnumWindows` callback: stops at the first visible, this-process, `#32770` window
    /// and hands it back through `lparam` (a raw pointer at a live `HWND` on the caller's
    /// stack — see the `EnumWindows` call below).
    unsafe extern "system" fn find_our_dialog(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        let mut pid: u32 = 0;
        // SAFETY: `hwnd` comes from `EnumWindows` itself; both calls below only read
        // window metadata for it.
        unsafe {
            let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        if pid != std::process::id() || !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            return true.into(); // keep enumerating
        }
        let mut class_name = [0u16; 32];
        let len = unsafe { GetClassNameW(hwnd, &mut class_name) };
        if len <= 0 || String::from_utf16_lossy(&class_name[..len as usize]) != "#32770" {
            return true.into();
        }
        // SAFETY: `lparam` was set below to point at a `HWND` that outlives this call.
        unsafe {
            *(lparam.0 as *mut HWND) = hwnd;
        }
        false.into() // found it, stop enumerating
    }

    let mut found = HWND::default();
    unsafe {
        // SAFETY: `found` stays alive on this stack frame for the whole call, and
        // `EnumWindows` doesn't retain the pointer past it.
        let _ = EnumWindows(Some(find_our_dialog), LPARAM(&mut found as *mut HWND as isize));
    }
    if !found.is_invalid() {
        // SAFETY: `find_our_dialog` just confirmed this window is ours and visible.
        unsafe {
            let _ = SetForegroundWindow(found);
        }
    }
}

/// Shows a multi-select folder picker; returns the chosen absolute paths (empty when
/// cancelled). Review item 4: a second concurrent call returns `[]` immediately (see
/// [`IN_FLIGHT`]) instead of opening a second native dialog.
#[tauri::command]
pub async fn pick_folders(window: WebviewWindow, title: String) -> Vec<String> {
    if IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Vec::new();
    }
    let _in_flight = InFlightGuard;

    let app = window.app_handle().clone();
    #[cfg(windows)]
    let _guard = ModalGuard::new(&window);
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title(title).blocking_pick_folders()
    })
    .await
    .ok()
    .flatten()
    .unwrap_or_default();
    picked
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}
