//! Global hotkeys via `RegisterHotKey` with a NULL window: WM_HOTKEY is posted to the
//! queue of the registering thread, so one dedicated thread registers, unregisters and
//! receives them (CCC used a message-only window per hotkey; same effect). Other threads
//! talk to it through a channel plus a WM_APP wake-up message. Ids are plain numbers here;
//! `super` maps them to their consumers.

use std::sync::mpsc;

use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_NOREPEAT,
};
use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, PeekMessageW, PostThreadMessageW, MSG, PM_NOREMOVE, WM_APP, WM_HOTKEY};

use crate::dictation::HotkeyError;

enum Command {
    Register(i32, Option<(u32, u32)>, mpsc::Sender<Result<(), HotkeyError>>),
}

pub struct HotkeyThread {
    thread_id: u32,
    commands: mpsc::Sender<Command>,
}

impl HotkeyThread {
    pub fn start(on_press: impl Fn(i32) + Send + 'static) -> Option<Self> {
        let (ready_tx, ready_rx) = mpsc::channel::<u32>();
        let (commands, rx) = mpsc::channel::<Command>();
        let spawned = std::thread::Builder::new().name("hotkeys".into()).spawn(move || {
            let mut msg = MSG::default();
            // SAFETY: plain Win32 calls on this thread's own message queue.
            unsafe {
                // Creates the thread's message queue before anyone posts to it.
                let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
                let _ = ready_tx.send(GetCurrentThreadId());
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    if msg.message == WM_HOTKEY {
                        on_press(msg.wParam.0 as i32);
                    } else if msg.message == WM_APP {
                        while let Ok(Command::Register(n, key, reply)) = rx.try_recv() {
                            let _ = UnregisterHotKey(None, n);
                            let result = match key {
                                None => Ok(()),
                                Some((modifiers, vk)) => {
                                    RegisterHotKey(None, n, HOT_KEY_MODIFIERS(modifiers) | MOD_NOREPEAT, vk)
                                        .map_err(|_| HotkeyError::Taken)
                                }
                            };
                            let _ = reply.send(result);
                        }
                    }
                }
            }
        });
        if let Err(e) = spawned {
            log::error!("hotkeys: thread failed to start: {e}");
            return None;
        }
        let thread_id = ready_rx.recv().ok()?;
        Some(Self { thread_id, commands })
    }

    /// Registers `(modifiers, vk)` under id `n`, or only unregisters `n` with `None`.
    pub fn register(&self, n: i32, key: Option<(u32, u32)>) -> Result<(), HotkeyError> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.commands.send(Command::Register(n, key, reply_tx)).map_err(|_| HotkeyError::Taken)?;
        // SAFETY: posting a message to a thread id we own.
        unsafe { PostThreadMessageW(self.thread_id, WM_APP, WPARAM(0), LPARAM(0)) }.map_err(|_| HotkeyError::Taken)?;
        reply_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap_or(Err(HotkeyError::Taken))
    }
}

pub fn key_down(vk: u32) -> bool {
    // SAFETY: reads the async key state; no pointers involved.
    (unsafe { GetAsyncKeyState(vk as i32) } as u16) & 0x8000 != 0
}
