//! M6 mascot on Windows: the primary monitor's work area, DPI and taskbar, the full-screen
//! check and the "animation effects" setting. Window moves use `platform::overlay_window`.

use windows::Win32::Foundation::{POINT, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Shell::{
    SHAppBarMessage, SHQueryUserNotificationState, ABE_BOTTOM, ABE_LEFT, ABE_RIGHT, ABE_TOP, ABM_GETSTATE,
    ABM_GETTASKBARPOS, ABS_AUTOHIDE, APPBARDATA, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    SystemParametersInfoW, SPI_GETCLIENTAREAANIMATION, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
};

use super::geometry::{Display, Rect, Taskbar, TaskbarEdge};
use super::Env;

pub use crate::platform::overlay_window::{move_window, show_without_activation, window_rect};

fn rect(r: RECT) -> Rect {
    Rect { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

pub fn query_env() -> Env {
    Env { display: primary_display(), busy: fullscreen_busy(), animations: animations_enabled() }
}

fn primary_display() -> Option<Display> {
    // SAFETY: plain queries into locals; (0,0) is always on the primary monitor.
    unsafe {
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
        let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        Some(Display { work: rect(info.rcWork), scale: f64::from(dpi_x) / 96.0, taskbar: taskbar() })
    }
}

/// The primary taskbar's edge, rectangle and auto-hide state.
fn taskbar() -> Option<Taskbar> {
    let mut pos = APPBARDATA { cbSize: size_of::<APPBARDATA>() as u32, ..Default::default() };
    let mut state = APPBARDATA { cbSize: size_of::<APPBARDATA>() as u32, ..Default::default() };
    // SAFETY: both calls only fill the structs we pass.
    let (found, flags) =
        unsafe { (SHAppBarMessage(ABM_GETTASKBARPOS, &mut pos) != 0, SHAppBarMessage(ABM_GETSTATE, &mut state)) };
    if !found {
        return None;
    }
    let edge = match pos.uEdge {
        ABE_BOTTOM => TaskbarEdge::Bottom,
        ABE_TOP => TaskbarEdge::Top,
        ABE_LEFT => TaskbarEdge::Left,
        ABE_RIGHT => TaskbarEdge::Right,
        _ => return None,
    };
    Some(Taskbar { edge, rect: rect(pos.rc), auto_hide: (flags as u32) & ABS_AUTOHIDE != 0 })
}

/// A full-screen app, a D3D full-screen game or presentation mode is in front.
fn fullscreen_busy() -> bool {
    // SAFETY: no arguments.
    match unsafe { SHQueryUserNotificationState() } {
        Ok(s) => s == QUNS_BUSY || s == QUNS_RUNNING_D3D_FULL_SCREEN || s == QUNS_PRESENTATION_MODE,
        Err(_) => false,
    }
}

/// Windows' "Animation effects" setting (off = reduced motion).
fn animations_enabled() -> bool {
    let mut on = windows::core::BOOL(1);
    // SAFETY: SPI_GETCLIENTAREAANIMATION writes one BOOL into `on`.
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some(&mut on as *mut _ as *mut core::ffi::c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    ok.is_err() || on.as_bool()
}
