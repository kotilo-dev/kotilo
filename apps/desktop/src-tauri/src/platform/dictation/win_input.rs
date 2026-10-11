//! Text into another program (CCC `TextInjector`): wait for the hotkey's modifiers to be
//! released, bring the target back to the front, then either paste (clipboard + Ctrl+V,
//! Shift+Insert in terminals; the previous clipboard is restored unless something else
//! changed it) or type Unicode key events. Elevated targets are refused (UIPI would drop
//! the input silently); the controller puts the text on the clipboard instead.

use std::thread::sleep;
use std::time::Duration;

use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HGLOBAL, HWND};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_CONTROL, VK_INSERT, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU,
    VK_RCONTROL, VK_RETURN, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SHIFT, VK_TAB, VK_V,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, IsWindow, SetForegroundWindow, ShowWindow,
    SW_RESTORE,
};

use crate::dictation::{Delivery, InsertMethod, InsertResult, WindowId};

const CF_UNICODETEXT: u32 = 13;
/// Window classes that paste with Shift+Insert (Ctrl+V is a key of its own there).
const TERMINAL_CLASSES: [&str; 4] = ["CASCADIA_HOSTING_WINDOW_CLASS", "ConsoleWindowClass", "mintty", "VirtualConsoleClass"];
const MAX_SAVED_CLIPBOARD: usize = 64 * 1024 * 1024;
const RESTORE_AFTER: Duration = Duration::from_millis(450);
const TYPE_CHUNK: usize = 200;

pub struct WinDelivery;

impl Delivery for WinDelivery {
    fn insert(&self, target: WindowId, text: &str, method: InsertMethod, keep_on_clipboard: bool) -> InsertResult {
        let hwnd = HWND(target as *mut core::ffi::c_void);
        // SAFETY: IsWindow accepts any handle value.
        if target == 0 || !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            return InsertResult::NoTarget;
        }
        if is_elevated(Some(hwnd)) && !is_elevated(None) {
            return InsertResult::Elevated;
        }
        release_modifiers();
        if !focus(hwnd) {
            return InsertResult::NoTarget;
        }
        match method {
            InsertMethod::Type => {
                type_text(text);
                InsertResult::Typed
            }
            InsertMethod::Paste => {
                let saved = if keep_on_clipboard { None } else { Clipboard::save() };
                if !set_clipboard_text(text, !keep_on_clipboard) {
                    return InsertResult::NoTarget;
                }
                // SAFETY: no arguments.
                let sequence = unsafe { GetClipboardSequenceNumber() };
                if is_terminal(hwnd) {
                    chord(VK_SHIFT, VK_INSERT);
                } else {
                    chord(VK_CONTROL, VK_V);
                }
                if let Some(saved) = saved {
                    sleep(RESTORE_AFTER);
                    // Only when nobody copied something else in the meantime.
                    // SAFETY: no arguments.
                    if unsafe { GetClipboardSequenceNumber() } == sequence {
                        saved.restore();
                    }
                }
                InsertResult::Pasted
            }
        }
    }

    fn copy(&self, text: &str) -> bool {
        set_clipboard_text(text, false)
    }
}

/// Elevation of the process owning `hwnd`, or of this process for `None`. A process we may
/// not even query counts as elevated.
fn is_elevated(hwnd: Option<HWND>) -> bool {
    // SAFETY: handles are checked and closed; buffers are sized for TOKEN_ELEVATION.
    unsafe {
        let process = match hwnd {
            None => GetCurrentProcess(),
            Some(h) => {
                let mut pid = 0u32;
                GetWindowThreadProcessId(h, Some(&mut pid));
                match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                    Ok(p) => p,
                    Err(_) => return true,
                }
            }
        };
        let mut token = HANDLE::default();
        let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token).is_ok();
        if hwnd.is_some() {
            let _ = CloseHandle(process);
        }
        if !opened {
            return hwnd.is_some();
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut core::ffi::c_void),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

fn is_terminal(hwnd: HWND) -> bool {
    let mut buf = [0u16; 256];
    // SAFETY: the buffer outlives the call.
    let n = unsafe { GetClassNameW(hwnd, &mut buf) } as usize;
    let class = String::from_utf16_lossy(&buf[..n.min(buf.len())]);
    TERMINAL_CLASSES.contains(&class.as_str())
}

/// The hotkey's Ctrl/Alt/Shift/Win would turn the pasted text into shortcuts: wait up to
/// two seconds for the user to let go, then release whatever is still down.
fn release_modifiers() {
    const MODIFIERS: [VIRTUAL_KEY; 8] = [VK_LSHIFT, VK_RSHIFT, VK_LCONTROL, VK_RCONTROL, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN];
    // SAFETY: reads key state only.
    let down = || MODIFIERS.into_iter().filter(|k| unsafe { GetAsyncKeyState(i32::from(k.0)) } as u16 & 0x8000 != 0).collect::<Vec<_>>();
    for _ in 0..40 {
        if down().is_empty() {
            return;
        }
        sleep(Duration::from_millis(50));
    }
    let ups: Vec<INPUT> = down().into_iter().map(|k| key(k, KEYEVENTF_KEYUP)).collect();
    send(&ups);
}

fn focus(hwnd: HWND) -> bool {
    // SAFETY: plain window calls on a handle IsWindow accepted.
    unsafe {
        if GetForegroundWindow() == hwnd {
            return true;
        }
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if !SetForegroundWindow(hwnd).as_bool() {
            // Windows lets a process take the foreground right after a key event of its own.
            send(&[key(VK_MENU, KEYBD_EVENT_FLAGS(0)), key(VK_MENU, KEYEVENTF_KEYUP)]);
            let _ = SetForegroundWindow(hwnd);
        }
        sleep(Duration::from_millis(120));
        GetForegroundWindow() == hwnd
    }
}

fn key(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn unicode(unit: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: unit, dwFlags: KEYEVENTF_UNICODE | flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

fn send(inputs: &[INPUT]) {
    if inputs.is_empty() {
        return;
    }
    // SAFETY: the slice is valid for the call; the size is the INPUT struct size.
    unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
}

fn chord(modifier: VIRTUAL_KEY, k: VIRTUAL_KEY) {
    let none = KEYBD_EVENT_FLAGS(0);
    send(&[key(modifier, none), key(k, none), key(k, KEYEVENTF_KEYUP), key(modifier, KEYEVENTF_KEYUP)]);
}

/// Key events for `text`: Unicode units, a new line as Shift+Enter (a plain Enter would
/// send a chat message), Tab as Tab.
pub fn typing_inputs(text: &str) -> Vec<INPUT> {
    let none = KEYBD_EVENT_FLAGS(0);
    let mut inputs = Vec::new();
    for ch in text.chars() {
        match ch {
            '\r' => {}
            '\n' => inputs.extend([
                key(VK_SHIFT, none),
                key(VK_RETURN, none),
                key(VK_RETURN, KEYEVENTF_KEYUP),
                key(VK_SHIFT, KEYEVENTF_KEYUP),
            ]),
            '\t' => inputs.extend([key(VK_TAB, none), key(VK_TAB, KEYEVENTF_KEYUP)]),
            _ => {
                let mut units = [0u16; 2];
                for unit in ch.encode_utf16(&mut units).iter() {
                    inputs.extend([unicode(*unit, none), unicode(*unit, KEYEVENTF_KEYUP)]);
                }
            }
        }
    }
    inputs
}

fn type_text(text: &str) {
    for chunk in typing_inputs(text).chunks(TYPE_CHUNK) {
        send(chunk);
        sleep(Duration::from_millis(5));
    }
}

fn open_clipboard() -> bool {
    for _ in 0..10 {
        // SAFETY: no owner window; closed by the caller.
        if unsafe { OpenClipboard(None) }.is_ok() {
            return true;
        }
        sleep(Duration::from_millis(20));
    }
    false
}

/// HGLOBAL with a copy of `bytes`; ownership passes to the clipboard on SetClipboardData.
fn global_copy(bytes: &[u8]) -> Option<HGLOBAL> {
    // SAFETY: the allocation is at least `bytes.len()` long and locked while written.
    unsafe {
        let global = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)).ok()?;
        let ptr = GlobalLock(global) as *mut u8;
        if ptr.is_null() {
            return None;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
        let _ = GlobalUnlock(global);
        Some(global)
    }
}

fn put(format: u32, bytes: &[u8]) {
    if let Some(global) = global_copy(bytes) {
        // SAFETY: the clipboard is open; on success it owns the memory.
        let _ = unsafe { SetClipboardData(format, Some(HANDLE(global.0))) };
    }
}

/// `text` as CF_UNICODETEXT (CRLF line ends). `private` keeps it out of Win+V history and
/// cloud clipboard – used for the short-lived paste copy.
fn set_clipboard_text(text: &str, private: bool) -> bool {
    if !open_clipboard() {
        return false;
    }
    let crlf = text.replace("\r\n", "\n").replace('\n', "\r\n");
    let bytes: Vec<u8> = crlf.encode_utf16().chain(std::iter::once(0)).flat_map(u16::to_le_bytes).collect();
    // SAFETY: the clipboard is open until CloseClipboard below.
    unsafe {
        let _ = EmptyClipboard();
        put(CF_UNICODETEXT, &bytes);
        if private {
            for name in [w!("ExcludeClipboardContentFromMonitorProcessing"), w!("CanIncludeInClipboardHistory"), w!("CanUploadToCloudClipboard")] {
                let format = RegisterClipboardFormatW(name);
                if format != 0 {
                    put(format, &0u32.to_le_bytes());
                }
            }
        }
        let _ = CloseClipboard();
    }
    true
}

/// Everything on the clipboard that lives in plain global memory (GDI handles and private
/// formats can't be copied and are skipped), up to 64 MB.
struct Clipboard(Vec<(u32, Vec<u8>)>);

impl Clipboard {
    fn save() -> Option<Self> {
        if !open_clipboard() {
            return None;
        }
        let mut formats = Vec::new();
        let mut total = 0usize;
        // SAFETY: the clipboard is open; data handles are only read while locked.
        unsafe {
            let mut format = EnumClipboardFormats(0);
            while format != 0 {
                let skip = matches!(format, 2 | 3 | 9 | 14 | 0x80..=0x8F | 0x200..=0x3FF);
                if !skip {
                    if let Ok(handle) = GetClipboardData(format) {
                        let global = HGLOBAL(handle.0);
                        let size = GlobalSize(global);
                        let ptr = GlobalLock(global) as *const u8;
                        if !ptr.is_null() {
                            if total + size <= MAX_SAVED_CLIPBOARD {
                                formats.push((format, std::slice::from_raw_parts(ptr, size).to_vec()));
                                total += size;
                            }
                            let _ = GlobalUnlock(global);
                        }
                    }
                }
                format = EnumClipboardFormats(format);
            }
            let _ = CloseClipboard();
        }
        Some(Self(formats))
    }

    fn restore(self) {
        if !open_clipboard() {
            return;
        }
        // SAFETY: the clipboard is open until CloseClipboard.
        unsafe {
            let _ = EmptyClipboard();
            for (format, bytes) in &self.0 {
                put(*format, bytes);
            }
            let _ = CloseClipboard();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Builds the events only; nothing is sent (AGENTS.md rule 6).
    #[test]
    fn typing_maps_new_lines_tabs_and_surrogate_pairs() {
        let inputs = typing_inputs("a\r\nb\t😀");
        // a down/up, Shift+Enter (4), b down/up, Tab down/up, 😀 = 2 units × down/up.
        assert_eq!(inputs.len(), 2 + 4 + 2 + 2 + 4);
        // SAFETY: reading the keyboard member of inputs built above.
        let ki = |i: usize| unsafe { inputs[i].Anonymous.ki };
        assert_eq!(ki(0).wScan, 'a' as u16);
        assert_eq!(ki(2).wVk, VK_SHIFT);
        assert_eq!(ki(3).wVk, VK_RETURN);
        assert_eq!(ki(8).wVk, VK_TAB);
        assert_eq!(ki(10).wScan, 0xD83D);
        assert_eq!(ki(12).wScan, 0xDE00);
    }
}
