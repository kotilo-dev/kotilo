//! M7 assistant popup on Windows: the work area and DPI of the monitor under the cursor, and
//! the tool-window style (no Alt+Tab entry; unlike the overlay and mascot it can take focus).

use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};

use super::geometry::Rect;

/// Work area (physical px) and DPI scale of the monitor under the mouse cursor.
pub fn cursor_display() -> Option<(Rect, f64)> {
    let mut point = POINT::default();
    // SAFETY: plain queries into locals; MonitorFromPoint falls back to the nearest monitor.
    unsafe {
        GetCursorPos(&mut point).ok()?;
        let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
        let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        let work = info.rcWork;
        Some((Rect { left: work.left, top: work.top, right: work.right, bottom: work.bottom }, f64::from(dpi_x) / 96.0))
    }
}

/// Gives the window the tool-window style so it has no Alt+Tab entry.
pub fn make_tool_window(handle: isize) {
    let hwnd = HWND(handle as *mut core::ffi::c_void);
    // SAFETY: style calls on our own window.
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let wanted = (style | WS_EX_TOOLWINDOW.0 as isize) & !(WS_EX_APPWINDOW.0 as isize);
        if wanted != style {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted);
        }
    }
}
