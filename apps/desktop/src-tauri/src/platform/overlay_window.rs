//! Windows helpers for our small always-on-top windows that must never take focus (the
//! dictation overlay, the M6 mascot): show without activation and move without activation.

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, GetWindowRect, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST,
    SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_SHOWNOACTIVATE, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
};

fn hwnd(handle: isize) -> HWND {
    HWND(handle as *mut core::ffi::c_void)
}

/// Shows the window on top without activating it; the first call also gives it the
/// no-activate / tool-window styles (no focus, no Alt-Tab entry).
pub fn show_without_activation(handle: isize) {
    let hwnd = hwnd(handle);
    // SAFETY: style and position calls on our own window.
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let wanted = style | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0 | WS_EX_TOPMOST.0) as isize;
        if wanted != style {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted);
        }
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
    }
}

/// Moves (and, with `size`, resizes) the window without activating it or changing its
/// z-order. Without `wait` the move is asynchronous (the walker thread never waits for the
/// UI thread); with it the move is done before the call returns (before a show).
pub fn move_window(handle: isize, x: i32, y: i32, size: Option<(i32, i32)>, wait: bool) {
    let (w, h) = size.unwrap_or((0, 0));
    let mut flags = SWP_NOACTIVATE | SWP_NOZORDER;
    if size.is_none() {
        flags |= SWP_NOSIZE;
    }
    if !wait {
        flags |= SWP_ASYNCWINDOWPOS;
    }
    // SAFETY: a position call on our own window.
    unsafe {
        let _ = SetWindowPos(hwnd(handle), None, x, y, w, h, flags);
    }
}

/// The window's current outer rectangle `(left, top, right, bottom)` in physical px.
pub fn window_rect(handle: isize) -> Option<(i32, i32, i32, i32)> {
    let mut rect = RECT::default();
    // SAFETY: reads our own window's rectangle into a local.
    unsafe { GetWindowRect(hwnd(handle), &mut rect) }.ok()?;
    Some((rect.left, rect.top, rect.right, rect.bottom))
}
