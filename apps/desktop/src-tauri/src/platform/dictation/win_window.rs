//! Window helpers for dictation on Windows: the foreground window (the dictation target),
//! the overlay's place (bottom-centre of the target's monitor work area) and showing it
//! without ever taking focus (WS_EX_NOACTIVATE + SW_SHOWNOACTIVATE), and sound playback.

use windows::core::PCWSTR;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

use crate::dictation::WindowId;

pub fn foreground_window() -> Option<WindowId> {
    // SAFETY: no arguments.
    let hwnd = unsafe { GetForegroundWindow() };
    (!hwnd.is_invalid()).then_some(hwnd.0 as WindowId)
}

/// Physical-pixel rectangle `(x, y, width, height)` for an overlay of `size` DIPs, centred
/// at the bottom of the work area of the monitor showing `target` (primary as fallback).
pub fn overlay_rect(target: Option<WindowId>, size: (f64, f64), bottom_margin: f64) -> Option<(i32, i32, u32, u32)> {
    let hwnd = HWND(target.unwrap_or(0) as *mut core::ffi::c_void);
    // SAFETY: MonitorFromWindow accepts any handle and falls back to the primary monitor.
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
        let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        let scale = f64::from(dpi_x) / 96.0;
        let work = info.rcWork;
        let (w, h) = ((size.0 * scale).round() as i32, (size.1 * scale).round() as i32);
        let x = work.left + (work.right - work.left - w) / 2;
        let y = work.bottom - h - (bottom_margin * scale).round() as i32;
        Some((x, y, w as u32, h as u32))
    }
}

/// Shared with the mascot window (M6).
pub use crate::platform::overlay_window::show_without_activation;

/// Plays an in-memory WAV asynchronously; `wav` must stay alive (it is `'static`).
pub fn play_wav(wav: &'static [u8]) {
    // SAFETY: with SND_MEMORY the "name" is a pointer to the WAV bytes, which are static.
    unsafe {
        let _ = PlaySoundW(PCWSTR(wav.as_ptr() as *const u16), None, SND_MEMORY | SND_ASYNC | SND_NODEFAULT);
    }
}
