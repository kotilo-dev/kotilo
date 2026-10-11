//! D-056 on Windows: time since the last input via `GetLastInputInfo` (session-wide).

use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

pub fn idle_ms() -> Option<u64> {
    let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    // SAFETY: `info` is a local with `cbSize` set; both calls only read/write it.
    unsafe {
        if !GetLastInputInfo(&mut info).as_bool() {
            return None;
        }
        Some(super::idle_from_ticks(GetTickCount(), info.dwTime))
    }
}
