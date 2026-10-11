//! Runs the [`Controller`] on its own thread: events come from the hotkey thread, the
//! overlay's ✕, Tauri commands and finished jobs; ticks every [`TICK_MS`] while recording
//! or showing a result. Jobs run on short-lived worker threads.

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::dictation::controller::{run_job, Controller, Event, TICK_MS};
use crate::dictation::{Delivery, DictationHub, DictationStatus, Platform};

/// How long the loop sleeps when nothing needs ticks (events still wake it at once).
const IDLE_WAIT: Duration = Duration::from_secs(3600);

pub struct DictationService {
    tx: Sender<Event>,
    status: Arc<Mutex<DictationStatus>>,
}

impl DictationService {
    /// `make_platform` runs on the controller thread and gets the event sender for hotkey presses.
    pub fn start<P, F>(make_platform: F, hub: Arc<dyn DictationHub>, delivery: Arc<dyn Delivery>) -> Self
    where
        P: Platform + 'static,
        F: FnOnce(Sender<Event>) -> P + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<Event>();
        let status = Arc::new(Mutex::new(DictationStatus::default()));
        let (loop_tx, shared) = (tx.clone(), status.clone());
        let spawned = std::thread::Builder::new().name("dictation".into()).spawn(move || {
            let platform = make_platform(loop_tx.clone());
            let jobs_tx = loop_tx.clone();
            let (job_hub, job_delivery) = (hub.clone(), delivery.clone());
            let spawn = Box::new(move |id, job| {
                let (tx, hub, delivery) = (jobs_tx.clone(), job_hub.clone(), job_delivery.clone());
                let worker = std::thread::Builder::new().name("dictation-job".into()).spawn(move || {
                    let result = run_job(job, hub.as_ref(), delivery.as_ref());
                    let _ = tx.send(Event::Done(id, result));
                });
                if let Err(e) = worker {
                    log::error!("dictation: job thread failed to start: {e}");
                }
            });
            let mut controller = Controller::new(platform, hub, spawn);
            let started = Instant::now();
            let now = || started.elapsed().as_millis() as u64;
            let mut last_tick = 0;
            loop {
                let wait = if controller.needs_ticks() {
                    Duration::from_millis(TICK_MS.saturating_sub(now().saturating_sub(last_tick)))
                } else {
                    IDLE_WAIT
                };
                match rx.recv_timeout(wait) {
                    Ok(event) => controller.handle(event, now()),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                if controller.needs_ticks() && now().saturating_sub(last_tick) >= TICK_MS {
                    last_tick = now();
                    controller.handle(Event::Tick, last_tick);
                }
                if let Ok(mut s) = shared.lock() {
                    *s = controller.status();
                }
            }
        });
        if let Err(e) = spawned {
            log::error!("dictation: thread failed to start: {e}");
        }
        Self { tx, status }
    }

    pub fn send(&self, event: Event) {
        let _ = self.tx.send(event);
    }

    pub fn status(&self) -> DictationStatus {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }
}
