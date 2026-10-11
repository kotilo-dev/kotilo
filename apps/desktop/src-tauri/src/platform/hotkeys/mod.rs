//! App-wide global hotkeys (M7, D-053): one `RegisterHotKey` thread shared by every consumer.
//! Dictation keeps its three ids and behaviour from M2b; the assistant popup adds its own.
//! Each consumer installs one callback; a press is routed to the callback of the consumer
//! that owns the id. Callbacks run on the hotkey thread and must return quickly.

#[cfg(windows)]
mod win;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::dictation::gesture::Gesture;
use crate::dictation::{HotkeyError, HotkeyId};

#[cfg(windows)]
mod os {
    pub use super::win::{key_down, HotkeyThread};
}

#[cfg(not(windows))]
mod os {
    use crate::dictation::HotkeyError;

    pub struct HotkeyThread;
    impl HotkeyThread {
        pub fn start(_on_press: impl Fn(i32) + Send + 'static) -> Option<Self> {
            None
        }
        pub fn register(&self, _n: i32, _key: Option<(u32, u32)>) -> Result<(), HotkeyError> {
            Err(HotkeyError::Taken)
        }
    }
    pub fn key_down(_vk: u32) -> bool {
        false
    }
}

/// True while the key with virtual-key code `vk` is held down.
pub fn key_down(vk: u32) -> bool {
    os::key_down(vk)
}

/// Every global hotkey the app registers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HotkeySlot {
    Dictation(HotkeyId),
    Assistant,
}

/// Who receives a slot's presses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Consumer {
    Dictation,
    Assistant,
}

const SLOTS: [HotkeySlot; 4] = [
    HotkeySlot::Dictation(HotkeyId::Dictation),
    HotkeySlot::Dictation(HotkeyId::PasteLast),
    HotkeySlot::Dictation(HotkeyId::Escape),
    HotkeySlot::Assistant,
];

impl HotkeySlot {
    /// The `RegisterHotKey` id (dictation keeps its M2b numbers).
    pub fn numeric(self) -> i32 {
        match self {
            HotkeySlot::Dictation(HotkeyId::Dictation) => 0xD1,
            HotkeySlot::Dictation(HotkeyId::PasteLast) => 0xD2,
            HotkeySlot::Dictation(HotkeyId::Escape) => 0xD3,
            HotkeySlot::Assistant => 0xA1,
        }
    }

    pub fn from_numeric(n: i32) -> Option<Self> {
        SLOTS.into_iter().find(|s| s.numeric() == n)
    }

    pub fn consumer(self) -> Consumer {
        match self {
            HotkeySlot::Dictation(_) => Consumer::Dictation,
            HotkeySlot::Assistant => Consumer::Assistant,
        }
    }
}

type Handler = Arc<dyn Fn(HotkeySlot) + Send + Sync>;

/// Id → consumer callback.
#[derive(Default)]
struct Routes {
    handlers: HashMap<Consumer, Handler>,
}

impl Routes {
    fn route(&self, n: i32) -> Option<(HotkeySlot, Handler)> {
        let slot = HotkeySlot::from_numeric(n)?;
        self.handlers.get(&slot.consumer()).map(|h| (slot, Arc::clone(h)))
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Managed state: the hotkey thread and its routing table. Cheap to clone.
#[derive(Clone)]
pub struct Hotkeys {
    thread: Option<Arc<os::HotkeyThread>>,
    routes: Arc<Mutex<Routes>>,
}

impl Hotkeys {
    pub fn start() -> Self {
        let routes = Arc::new(Mutex::new(Routes::default()));
        let table = Arc::clone(&routes);
        let thread = os::HotkeyThread::start(move |n| {
            // The lock is released before the callback runs.
            let found = lock(&table).route(n);
            if let Some((slot, handler)) = found {
                handler(slot);
            }
        });
        Self { thread: thread.map(Arc::new), routes }
    }

    /// Installs (or replaces) the callback for `consumer`'s slots.
    pub fn set_handler(&self, consumer: Consumer, handler: impl Fn(HotkeySlot) + Send + Sync + 'static) {
        lock(&self.routes).handlers.insert(consumer, Arc::new(handler));
    }

    /// Registers (`Some`) or unregisters (`None`) the gesture for `slot`; registering
    /// replaces whatever the slot had. `Taken` when the OS refuses (another program has it).
    pub fn register(&self, slot: HotkeySlot, gesture: Option<&Gesture>) -> Result<(), HotkeyError> {
        let key = gesture.map(|g| (g.modifiers, g.vk));
        match &self.thread {
            Some(thread) => thread.register(slot.numeric(), key),
            None if key.is_none() => Ok(()),
            None => Err(HotkeyError::Taken),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn numeric_ids_are_unique_and_round_trip() {
        for slot in SLOTS {
            assert_eq!(HotkeySlot::from_numeric(slot.numeric()), Some(slot));
        }
        let mut ids: Vec<i32> = SLOTS.iter().map(|s| s.numeric()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), SLOTS.len());
        // Dictation keeps its M2b ids.
        assert_eq!(HotkeySlot::Dictation(HotkeyId::Dictation).numeric(), 0xD1);
        assert_eq!(HotkeySlot::from_numeric(0x1234), None);
    }

    #[test]
    fn presses_go_to_the_owning_consumer_only() {
        let dictation = Arc::new(Mutex::new(Vec::new()));
        let assistant = Arc::new(AtomicUsize::new(0));
        let mut routes = Routes::default();
        let seen = Arc::clone(&dictation);
        routes.handlers.insert(Consumer::Dictation, Arc::new(move |slot| seen.lock().unwrap().push(slot)));
        let count = Arc::clone(&assistant);
        routes.handlers.insert(
            Consumer::Assistant,
            Arc::new(move |slot| {
                assert_eq!(slot, HotkeySlot::Assistant);
                count.fetch_add(1, Ordering::SeqCst);
            }),
        );
        for n in [0xD1, 0xA1, 0xD3, 0x77] {
            if let Some((slot, handler)) = routes.route(n) {
                handler(slot);
            }
        }
        assert_eq!(
            *dictation.lock().unwrap(),
            vec![HotkeySlot::Dictation(HotkeyId::Dictation), HotkeySlot::Dictation(HotkeyId::Escape)]
        );
        assert_eq!(assistant.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_consumer_without_a_handler_gets_nothing() {
        let routes = Routes::default();
        assert!(routes.route(HotkeySlot::Assistant.numeric()).is_none());
    }
}
