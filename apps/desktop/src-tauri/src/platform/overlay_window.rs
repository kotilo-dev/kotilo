//! Windows helpers for our small always-on-top windows that must never take focus (the
//! dictation overlay, the M6 mascot): show without activation and move without activation.

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, GetWindowRect, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, GWL_STYLE, HWND_TOPMOST,
    SWP_ASYNCWINDOWPOS, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_SHOWNOACTIVATE,
    WS_CAPTION, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_SYSMENU,
    WS_THICKFRAME,
};

fn hwnd(handle: isize) -> HWND {
    HWND(handle as *mut core::ffi::c_void)
}

/// Window-style bits that draw a caption or frame. The windows are created undecorated, but the
/// windowing layer can keep or re-apply caption bits on hide/show; together with
/// `WS_EX_TOOLWINDOW` they show a small "Dictation ×" title bar that pushes the page down.
const CHROME_STYLES: u32 = WS_CAPTION.0 | WS_SYSMENU.0 | WS_THICKFRAME.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0;

/// `style` without any caption or frame bits.
fn chromeless(style: isize) -> isize {
    style & !(CHROME_STYLES as isize)
}

/// Shows the window on top without activating it. Every call (re)applies the no-activate /
/// tool-window styles (no focus, no Alt-Tab entry) and strips caption and frame bits, then
/// lets Windows recompute the frame so no title bar is drawn.
pub fn show_without_activation(handle: isize) {
    let hwnd = hwnd(handle);
    // SAFETY: style and position calls on our own window.
    unsafe {
        let mut changed = false;
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        if chromeless(style) != style {
            SetWindowLongPtrW(hwnd, GWL_STYLE, chromeless(style));
            changed = true;
        }
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let wanted = ex_style | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0 | WS_EX_TOPMOST.0) as isize;
        if wanted != ex_style {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted);
            changed = true;
        }
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let mut flags = SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE;
        if changed {
            flags |= SWP_FRAMECHANGED;
        }
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, flags);
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

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::{WS_CLIPCHILDREN, WS_POPUP, WS_VISIBLE};

    #[test]
    fn chromeless_drops_caption_and_frame_bits_only() {
        let keep = (WS_POPUP.0 | WS_VISIBLE.0 | WS_CLIPCHILDREN.0) as isize;
        let style = keep | (WS_CAPTION.0 | WS_SYSMENU.0 | WS_THICKFRAME.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0) as isize;
        assert_eq!(chromeless(style), keep);
        assert_eq!(chromeless(keep), keep);
    }
}
