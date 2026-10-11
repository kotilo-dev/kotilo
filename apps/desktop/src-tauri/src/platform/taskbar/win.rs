//! D-056 on Windows: `ITaskbarList3::SetOverlayIcon` with an icon built from the badge's RGBA
//! pixels. Tauri's own `set_overlay_icon` takes no description, so the call is made here.
//! Must run on the window's UI thread (COM is already initialised there).

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Shell::{ITaskbarList3, TaskbarList};
use windows::Win32::UI::WindowsAndMessaging::{CreateIcon, DestroyIcon, HICON};

use super::SIZE;

/// `icon` = straight-alpha RGBA pixels (`SIZE`×`SIZE`) and the screen-reader text; `None`
/// removes the overlay.
pub fn set_overlay(hwnd: isize, icon: Option<(&[u8], &str)>) -> windows::core::Result<()> {
    let hwnd = HWND(hwnd as *mut core::ffi::c_void);
    // SAFETY: plain COM calls on this (UI) thread; the icon handle is ours and destroyed after
    // the call (the taskbar keeps its own copy).
    unsafe {
        let list: ITaskbarList3 = CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)?;
        list.HrInit()?;
        match icon {
            None => list.SetOverlayIcon(hwnd, HICON::default(), PCWSTR::null()),
            Some((rgba, description)) => {
                let hicon = create_icon(rgba)?;
                let result = list.SetOverlayIcon(hwnd, hicon, &HSTRING::from(description));
                let _ = DestroyIcon(hicon);
                result
            }
        }
    }
}

fn create_icon(rgba: &[u8]) -> windows::core::Result<HICON> {
    let bgra: Vec<u8> = rgba.as_chunks::<4>().0.iter().flat_map(|&[r, g, b, a]| [b, g, r, a]).collect();
    // 1 bpp AND mask, rows padded to 16 bits; all zero – the colour bitmap's alpha decides.
    let mask = vec![0u8; (SIZE as usize).div_ceil(16) * 2 * SIZE as usize];
    // SAFETY: both buffers are alive for the call and sized for a SIZE×SIZE icon (32 bpp
    // colour, 1 bpp mask).
    unsafe { CreateIcon(None, SIZE as i32, SIZE as i32, 1, 32, mask.as_ptr(), bgra.as_ptr()) }
}
