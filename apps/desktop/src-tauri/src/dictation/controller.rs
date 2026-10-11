//! The dictation state machine (CCC `DictationController`, spec §22). Single-threaded: the
//! service loop feeds it [`Event`]s with the current time; blocking work (transcription,
//! AI cleanup, delivery) is handed out as [`Job`]s, run elsewhere by [`run_job`], and comes
//! back as events. A session id tags every job so a late result of a cancelled session is
//! ignored.

use crate::dictation::audio::Recording;
use crate::dictation::gesture::{Gesture, VK_ESCAPE};
use crate::dictation::hold::{HoldToTalk, TalkMode};
use crate::dictation::{
    ComposerResult, Delivery, DictationHub, DictationMessage, DictationSettings, DictationStatus, HotkeyId, HotkeyStatus,
    HubCallError, InsertMethod, InsertResult, OverlayResult, OverlayState, Phase, Platform, SaveRequest, Sound,
    TranscriptStatus, WindowId,
};

/// Polling interval for hold-to-talk, the timer and the level meter.
pub const TICK_MS: u64 = 40;
const RESULT_OK_MS: u64 = 1_600;
const RESULT_ERROR_MS: u64 = 4_500;

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Hotkey(HotkeyId),
    /// The overlay's ✕.
    Cancel,
    Tick,
    /// Settings changed (or the hub came back): re-read them and re-register the hotkeys.
    Reload,
    Done(u64, JobResult),
    /// M4 composer mic button: record (tap-to-toggle) and hand the text back to the pane's
    /// composer as a `dictation:composer` event instead of inserting it through the OS.
    StartComposer(String),
    /// Second click on the composer mic: stop recording and transcribe.
    StopComposer,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Job {
    Transcribe { samples: Vec<f32> },
    Cleanup { text: String },
    Deliver(Box<DeliverJob>),
    PasteLast { target: Option<WindowId>, method: InsertMethod },
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeliverJob {
    pub target: Option<WindowId>,
    pub raw_text: String,
    pub final_text: String,
    pub cleaned: bool,
    pub cleanup_failed: bool,
    pub duration_seconds: f64,
    pub settings: DictationSettings,
    /// Composer mode: the text already went to the composer; only file + history remain.
    pub composer: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum JobResult {
    Transcribed(Result<crate::dictation::Transcript, HubCallError>),
    Cleaned(Result<crate::dictation::Cleanup, HubCallError>),
    Delivered { message: DictationMessage, id: Option<i64> },
    PastedLast(Option<DictationMessage>),
}

/// Runs one job against the hub and the OS. Blocking; called off the controller thread.
pub fn run_job(job: Job, hub: &dyn DictationHub, delivery: &dyn Delivery) -> JobResult {
    match job {
        Job::Transcribe { samples } => JobResult::Transcribed(hub.transcribe(&samples)),
        Job::Cleanup { text } => JobResult::Cleaned(hub.cleanup(&text)),
        Job::Deliver(job) => {
            let (message, id) = deliver(&job, hub, delivery);
            JobResult::Delivered { message, id }
        }
        Job::PasteLast { target, method } => JobResult::PastedLast(paste_last(target, method, hub, delivery)),
    }
}

/// Outputs in CCC order: focused field, clipboard, then the hub's file + history. A
/// composer dictation skips the OS outputs (`outputs: []`).
fn deliver(job: &DeliverJob, hub: &dyn DictationHub, delivery: &dyn Delivery) -> (DictationMessage, Option<i64>) {
    let s = &job.settings;
    let text = job.final_text.as_str();
    let mut outputs: Vec<String> = Vec::new();
    let mut message = None;
    let mut on_clipboard = false;
    let os_outputs = !job.composer;
    if os_outputs && s.output_focused {
        let result = match job.target {
            Some(target) => delivery.insert(target, text, s.insert_method, s.output_clipboard),
            None => InsertResult::NoTarget,
        };
        match result {
            InsertResult::Pasted | InsertResult::Typed => {
                outputs.push("type".into());
                on_clipboard = s.output_clipboard && result == InsertResult::Pasted;
            }
            InsertResult::Elevated | InsertResult::NoTarget => {
                // The text is never lost: it waits on the clipboard.
                on_clipboard = delivery.copy(text);
                message = Some(if result == InsertResult::Elevated {
                    DictationMessage::ElevatedTarget
                } else {
                    DictationMessage::NoTarget
                });
            }
        }
    }
    if os_outputs && s.output_clipboard && !on_clipboard {
        on_clipboard = delivery.copy(text);
    }
    if on_clipboard {
        outputs.push("clipboard".into());
    }
    let saved = hub.save(&SaveRequest {
        duration_seconds: job.duration_seconds,
        raw_text: job.raw_text.clone(),
        final_text: job.final_text.clone(),
        cleaned: job.cleaned,
        outputs: outputs.clone(),
    });
    let id = match saved {
        Ok(r) => {
            if r.file_error.is_some() {
                message = message.or(Some(DictationMessage::FileFailed));
            }
            r.id
        }
        Err(e) => {
            log::warn!("dictation: history/file save failed: {e:?}");
            None
        }
    };
    let message = message
        .or(job.cleanup_failed.then_some(DictationMessage::CleanupFailed))
        .unwrap_or(if outputs.iter().any(|o| o == "type") {
            DictationMessage::Inserted
        } else {
            DictationMessage::Done
        });
    (message, id)
}

/// Re-inserts the newest dictation; `Some(message)` only when something went wrong.
fn paste_last(
    target: Option<WindowId>,
    method: InsertMethod,
    hub: &dyn DictationHub,
    delivery: &dyn Delivery,
) -> Option<DictationMessage> {
    let text = match hub.latest_text() {
        Ok(Some(t)) if !t.is_empty() => t,
        Ok(_) => return Some(DictationMessage::NoSpeech),
        Err(HubCallError::Unavailable) => return Some(DictationMessage::HubUnavailable),
        Err(_) => return Some(DictationMessage::Failed),
    };
    let Some(target) = target else {
        delivery.copy(&text);
        return Some(DictationMessage::NoTarget);
    };
    match delivery.insert(target, &text, method, false) {
        InsertResult::Pasted | InsertResult::Typed => None,
        InsertResult::Elevated => {
            delivery.copy(&text);
            Some(DictationMessage::ElevatedTarget)
        }
        InsertResult::NoTarget => {
            delivery.copy(&text);
            Some(DictationMessage::NoTarget)
        }
    }
}

#[derive(Debug)]
enum State {
    Idle,
    /// `vk` is the hotkey polled for hold-to-talk; `None` for a composer recording (toggle only).
    Recording { started: u64, hold: HoldToTalk, vk: Option<u32> },
    /// Waiting for a job; `delivering` once the text is on its way (no cancel any more).
    Processing { phase: Phase, delivering: bool },
    Result { until: u64 },
}

/// One dictation session's context.
#[derive(Debug, Clone)]
struct Session {
    id: u64,
    target: Option<WindowId>,
    settings: DictationSettings,
    duration_seconds: f64,
    raw_text: String,
    /// Composer mode: the pane that gets the text. Taken once its `dictation:composer`
    /// event (text or error) has gone out.
    composer: Option<String>,
    is_composer: bool,
}

pub struct Controller<P: Platform> {
    platform: P,
    hub: std::sync::Arc<dyn DictationHub>,
    spawn: Box<dyn FnMut(u64, Job) + Send>,
    settings: DictationSettings,
    dictation_gesture: Option<Gesture>,
    status: DictationStatus,
    state: State,
    session: Option<Session>,
    next_session: u64,
}

impl<P: Platform> Controller<P> {
    /// `spawn(session, job)` must run the job and send back `Event::Done(session, result)`.
    pub fn new(platform: P, hub: std::sync::Arc<dyn DictationHub>, spawn: Box<dyn FnMut(u64, Job) + Send>) -> Self {
        Self {
            platform,
            hub,
            spawn,
            settings: DictationSettings::default(),
            dictation_gesture: None,
            status: DictationStatus::default(),
            state: State::Idle,
            session: None,
            next_session: 1,
        }
    }

    pub fn status(&self) -> DictationStatus {
        let mut status = self.status.clone();
        status.phase = self.phase();
        status
    }

    pub fn platform(&self) -> &P {
        &self.platform
    }

    fn phase(&self) -> Phase {
        match &self.state {
            State::Idle => Phase::Hidden,
            State::Recording { .. } => Phase::Recording,
            State::Processing { phase, .. } => *phase,
            State::Result { .. } => Phase::Result,
        }
    }

    /// True while the loop should send [`Event::Tick`]s.
    pub fn needs_ticks(&self) -> bool {
        matches!(self.state, State::Recording { .. } | State::Result { .. })
    }

    pub fn handle(&mut self, event: Event, now: u64) {
        match event {
            Event::Reload => self.reload(),
            Event::StartComposer(pane_id) => match &self.state {
                State::Idle | State::Result { .. } => self.start(now, Some(pane_id)),
                // Another dictation is running: tell this composer right away.
                _ => self.platform.composer_result(&ComposerResult::error(
                    pane_id,
                    DictationMessage::Failed,
                    Some("busy".into()),
                )),
            },
            Event::StopComposer => {
                if self.session.as_ref().is_some_and(|s| s.is_composer) {
                    self.stop(now);
                }
            }
            Event::Hotkey(HotkeyId::Dictation) => match &self.state {
                State::Idle | State::Result { .. } => self.start(now, None),
                State::Recording { hold, .. } if hold.mode == TalkMode::Toggle => self.stop(now),
                _ => {}
            },
            Event::Hotkey(HotkeyId::PasteLast) => {
                if matches!(self.state, State::Idle | State::Result { .. }) {
                    let target = self.platform.foreground_window();
                    let job = Job::PasteLast { target, method: self.settings.insert_method };
                    (self.spawn)(0, job);
                }
            }
            Event::Hotkey(HotkeyId::Escape) | Event::Cancel => self.cancel(now),
            Event::Tick => self.tick(now),
            Event::Done(id, result) => self.done(id, result, now),
        }
    }

    fn reload(&mut self) {
        match self.hub.settings() {
            Ok(settings) => self.settings = settings,
            Err(e) => {
                log::info!("dictation: hub settings unavailable ({e:?}); keeping the last ones");
            }
        }
        let s = self.settings.clone();
        self.status.enabled = s.enabled;
        self.dictation_gesture = Gesture::parse(&s.hotkey);
        let dictation = self.dictation_gesture.clone();
        self.status.hotkey = self.register(HotkeyId::Dictation, &s.hotkey, s.enabled, dictation.as_ref());
        let paste = Gesture::parse(&s.paste_last_hotkey);
        self.status.paste_last_hotkey = self.register(HotkeyId::PasteLast, &s.paste_last_hotkey, s.enabled, paste.as_ref());
    }

    fn register(&mut self, id: HotkeyId, text: &str, enabled: bool, gesture: Option<&Gesture>) -> HotkeyStatus {
        let _ = self.platform.register_hotkey(id, None);
        if !enabled || text.trim().is_empty() {
            return HotkeyStatus { gesture: text.to_string(), error: None };
        }
        let Some(gesture) = gesture else {
            return HotkeyStatus { gesture: text.to_string(), error: Some(crate::dictation::HotkeyError::Invalid) };
        };
        let error = self.platform.register_hotkey(id, Some(gesture)).err();
        if let Some(e) = error {
            log::warn!("dictation: hotkey {} not registered: {e:?}", gesture.text);
        }
        HotkeyStatus { gesture: gesture.text.clone(), error }
    }

    fn overlay(&self, state: OverlayState) {
        let target = self.session.as_ref().and_then(|s| s.target);
        self.platform.show_overlay(&state, target);
    }

    fn sound(&self, sound: Sound) {
        if self.settings.sound_cues {
            self.platform.play(sound);
        }
    }

    /// Starts a recording: from the hotkey (`composer: None`, needs a valid gesture) or from
    /// a composer mic button (always tap-to-toggle; the hotkey settings don't matter).
    fn start(&mut self, now: u64, composer: Option<String>) {
        let vk = match &composer {
            Some(_) => None,
            None => match &self.dictation_gesture {
                Some(gesture) => Some(gesture.vk),
                None => return,
            },
        };
        // Composer: the foreground window is our own; it only places the overlay.
        let target = self.platform.foreground_window();
        let id = self.next_session;
        self.next_session += 1;
        self.session = Some(Session {
            id,
            target,
            settings: self.settings.clone(),
            duration_seconds: 0.0,
            raw_text: String::new(),
            is_composer: composer.is_some(),
            composer,
        });
        // Loads the model while the user speaks; also tells us early that it is missing.
        match self.hub.preload() {
            Ok(()) => {}
            Err(HubCallError::ModelMissing) => return self.finish(DictationMessage::ModelMissing, now),
            Err(HubCallError::Unavailable) => return self.finish(DictationMessage::HubUnavailable, now),
            Err(e) => log::warn!("dictation: preload failed: {e:?}"),
        }
        if let Err(e) = self.platform.start_recording() {
            log::warn!("dictation: microphone: {e}");
            return self.finish(DictationMessage::NoMicrophone, now);
        }
        let _ = self.platform.register_hotkey(HotkeyId::Escape, Some(&escape()));
        let mut hold = HoldToTalk::begin(now);
        if vk.is_none() {
            hold.mode = TalkMode::Toggle;
        }
        let mode = hold.mode;
        self.state = State::Recording { started: now, hold, vk };
        self.sound(Sound::Start);
        self.overlay(OverlayState {
            phase: Phase::Recording,
            mode,
            elapsed_ms: 0,
            level: 0.0,
            result: None,
            sound: Some(Sound::Start),
        });
    }

    fn tick(&mut self, now: u64) {
        match &mut self.state {
            State::Recording { started, hold, vk } => {
                let released = match vk {
                    Some(vk) => {
                        let down = self.platform.key_down(*vk);
                        hold.observe(down, now)
                    }
                    None => false,
                };
                let elapsed = now.saturating_sub(*started);
                let max_ms = u64::from(self.settings.max_minutes.max(1)) * 60_000;
                let mode = hold.mode;
                if released || elapsed >= max_ms {
                    return self.stop(now);
                }
                let level = self.platform.level();
                self.overlay(OverlayState { phase: Phase::Recording, mode, elapsed_ms: elapsed, level, result: None, sound: None });
            }
            State::Result { until } if now >= *until => {
                self.state = State::Idle;
                self.session = None;
                self.platform.show_overlay(&OverlayState::hidden(), None);
            }
            _ => {}
        }
    }

    fn stop(&mut self, now: u64) {
        let State::Recording { started, hold, .. } = &self.state else { return };
        let (elapsed, mode) = (now.saturating_sub(*started), hold.mode);
        let recording: Recording = self.platform.stop_recording();
        self.sound(Sound::Stop);
        if !recording.heard_anything() {
            return self.finish(DictationMessage::Silent, now);
        }
        let Some(session) = self.session.as_mut() else { return };
        session.duration_seconds = recording.seconds();
        let id = session.id;
        self.state = State::Processing { phase: Phase::Transcribing, delivering: false };
        self.overlay(OverlayState { phase: Phase::Transcribing, mode, elapsed_ms: elapsed, level: 0.0, result: None, sound: Some(Sound::Stop) });
        (self.spawn)(id, Job::Transcribe { samples: recording.to_whisper() });
    }

    fn cancel(&mut self, now: u64) {
        match &self.state {
            State::Recording { .. } => {
                let _ = self.platform.stop_recording();
                self.finish(DictationMessage::Cancelled, now);
            }
            State::Processing { delivering: false, .. } => {
                self.hub.cancel();
                self.finish(DictationMessage::Cancelled, now);
            }
            _ => {}
        }
    }

    fn done(&mut self, id: u64, result: JobResult, now: u64) {
        if let JobResult::PastedLast(message) = result {
            if let Some(message) = message {
                if matches!(self.state, State::Idle | State::Result { .. }) {
                    self.finish(message, now);
                }
            }
            return;
        }
        let current = matches!(self.state, State::Processing { .. }) && self.session.as_ref().is_some_and(|s| s.id == id);
        if !current {
            return;
        }
        match result {
            JobResult::Transcribed(Ok(t)) => match t.status {
                TranscriptStatus::Cancelled => self.finish(DictationMessage::Cancelled, now),
                TranscriptStatus::NoSpeech => self.finish(DictationMessage::NoSpeech, now),
                TranscriptStatus::Ok if t.raw_text.trim().is_empty() => self.finish(DictationMessage::NoSpeech, now),
                TranscriptStatus::Ok => {
                    let Some(session) = self.session.as_mut() else { return };
                    session.raw_text = t.raw_text.clone();
                    if session.settings.ai_cleanup {
                        self.state = State::Processing { phase: Phase::Cleaning, delivering: false };
                        self.overlay(processing(Phase::Cleaning));
                        (self.spawn)(id, Job::Cleanup { text: t.raw_text });
                    } else {
                        self.deliver(t.raw_text, false, false);
                    }
                }
            },
            JobResult::Transcribed(Err(e)) => {
                let detail = match &e {
                    HubCallError::Other(text) => Some(text.clone()),
                    _ => None,
                };
                self.finish_with(error_message(&e), detail, now);
            }
            JobResult::Cleaned(result) => {
                let raw = self.session.as_ref().map(|s| s.raw_text.clone()).unwrap_or_default();
                match result {
                    Ok(c) if !c.final_text.trim().is_empty() => {
                        let failed = c.note.as_deref() == Some("cleanupFailed");
                        self.deliver(c.final_text, c.cleaned, failed);
                    }
                    Ok(_) | Err(_) => self.deliver(raw, false, true),
                }
            }
            JobResult::Delivered { message, id: saved } => {
                self.platform.dictation_done(saved);
                self.finish(message, now);
            }
            JobResult::PastedLast(_) => {}
        }
    }

    fn deliver(&mut self, final_text: String, cleaned: bool, cleanup_failed: bool) {
        // Composer: the text goes to the pane now; the job below only saves file + history.
        if let Some(pane_id) = self.session.as_mut().and_then(|s| s.composer.take()) {
            self.platform.composer_result(&ComposerResult {
                pane_id,
                text: Some(final_text.clone()),
                cleaned: Some(cleaned),
                error: None,
                detail: None,
            });
        }
        let Some(session) = self.session.clone() else { return };
        let phase = self.phase();
        self.state = State::Processing { phase, delivering: true };
        let job = DeliverJob {
            target: session.target,
            raw_text: session.raw_text,
            final_text,
            cleaned,
            cleanup_failed,
            duration_seconds: session.duration_seconds,
            settings: session.settings,
            composer: session.is_composer,
        };
        (self.spawn)(session.id, Job::Deliver(Box::new(job)));
    }

    /// Ends the session with a result line; the overlay hides itself after a moment.
    fn finish(&mut self, message: DictationMessage, now: u64) {
        self.finish_with(message, None, now);
    }

    fn finish_with(&mut self, message: DictationMessage, detail: Option<String>, now: u64) {
        let _ = self.platform.register_hotkey(HotkeyId::Escape, None);
        // A composer session that ends without text (cancel, silence, error) still answers.
        if let Some(pane_id) = self.session.as_mut().and_then(|s| s.composer.take()) {
            self.platform.composer_result(&ComposerResult::error(pane_id, message, detail.clone()));
        }
        let ok = message.is_ok() || message == DictationMessage::Cancelled;
        let sound = (!ok).then_some(Sound::Error);
        if let Some(s) = sound {
            self.sound(s);
        }
        self.state = State::Result { until: now + if ok { RESULT_OK_MS } else { RESULT_ERROR_MS } };
        self.overlay(OverlayState {
            phase: Phase::Result,
            mode: TalkMode::Undecided,
            elapsed_ms: 0,
            level: 0.0,
            result: Some(OverlayResult { ok: message.is_ok(), message, detail }),
            sound,
        });
    }
}

fn processing(phase: Phase) -> OverlayState {
    OverlayState { phase, mode: TalkMode::Undecided, elapsed_ms: 0, level: 0.0, result: None, sound: None }
}

fn escape() -> Gesture {
    Gesture { modifiers: 0, vk: VK_ESCAPE, text: "Esc".into() }
}

fn error_message(e: &HubCallError) -> DictationMessage {
    match e {
        HubCallError::Unavailable => DictationMessage::HubUnavailable,
        HubCallError::ModelMissing => DictationMessage::ModelMissing,
        HubCallError::Busy | HubCallError::Other(_) => DictationMessage::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictation::{Cleanup, HotkeyError, SaveResult, Transcript};
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct World {
        key_down: bool,
        foreground: Option<WindowId>,
        mic_error: bool,
        recording: Recording,
        registered: Vec<(HotkeyId, Option<String>)>,
        taken: Vec<String>,
        overlays: Vec<OverlayState>,
        sounds: Vec<Sound>,
        done: Vec<Option<i64>>,
        composer: Vec<ComposerResult>,
    }

    struct FakePlatform(Arc<Mutex<World>>);

    impl Platform for FakePlatform {
        fn foreground_window(&self) -> Option<WindowId> {
            self.0.lock().unwrap().foreground
        }
        fn key_down(&self, _vk: u32) -> bool {
            self.0.lock().unwrap().key_down
        }
        fn register_hotkey(&mut self, id: HotkeyId, gesture: Option<&Gesture>) -> Result<(), HotkeyError> {
            let mut w = self.0.lock().unwrap();
            if gesture.is_some_and(|g| w.taken.contains(&g.text)) {
                return Err(HotkeyError::Taken);
            }
            w.registered.push((id, gesture.map(|g| g.text.clone())));
            Ok(())
        }
        fn start_recording(&mut self) -> Result<(), String> {
            if self.0.lock().unwrap().mic_error {
                Err("no device".into())
            } else {
                Ok(())
            }
        }
        fn level(&self) -> f32 {
            0.25
        }
        fn stop_recording(&mut self) -> Recording {
            self.0.lock().unwrap().recording.clone()
        }
        fn play(&self, sound: Sound) {
            self.0.lock().unwrap().sounds.push(sound);
        }
        fn show_overlay(&self, state: &OverlayState, _target: Option<WindowId>) {
            self.0.lock().unwrap().overlays.push(state.clone());
        }
        fn dictation_done(&self, id: Option<i64>) {
            self.0.lock().unwrap().done.push(id);
        }
        fn composer_result(&self, result: &ComposerResult) {
            self.0.lock().unwrap().composer.push(result.clone());
        }
    }

    #[derive(Default)]
    struct FakeHub {
        settings: Mutex<DictationSettings>,
        preload: Mutex<Option<HubCallError>>,
        cancels: Mutex<u32>,
        saved: Mutex<Vec<SaveRequest>>,
        file_error: bool,
        latest: Option<String>,
    }

    impl DictationHub for FakeHub {
        fn settings(&self) -> Result<DictationSettings, HubCallError> {
            Ok(self.settings.lock().unwrap().clone())
        }
        fn preload(&self) -> Result<(), HubCallError> {
            self.preload.lock().unwrap().clone().map_or(Ok(()), Err)
        }
        fn transcribe(&self, _samples: &[f32]) -> Result<Transcript, HubCallError> {
            unreachable!("jobs are run by the tests")
        }
        fn cleanup(&self, _text: &str) -> Result<Cleanup, HubCallError> {
            unreachable!("jobs are run by the tests")
        }
        fn cancel(&self) {
            *self.cancels.lock().unwrap() += 1;
        }
        fn save(&self, request: &SaveRequest) -> Result<SaveResult, HubCallError> {
            self.saved.lock().unwrap().push(request.clone());
            Ok(SaveResult { id: Some(7), file_error: self.file_error.then(|| "denied".into()) })
        }
        fn latest_text(&self) -> Result<Option<String>, HubCallError> {
            Ok(self.latest.clone())
        }
    }

    #[derive(Default)]
    struct FakeDelivery {
        result: Option<InsertResult>,
        inserted: Mutex<Vec<(WindowId, String, InsertMethod, bool)>>,
        copied: Mutex<Vec<String>>,
    }

    impl Delivery for FakeDelivery {
        fn insert(&self, target: WindowId, text: &str, method: InsertMethod, keep: bool) -> InsertResult {
            self.inserted.lock().unwrap().push((target, text.into(), method, keep));
            self.result.unwrap_or(if method == InsertMethod::Type { InsertResult::Typed } else { InsertResult::Pasted })
        }
        fn copy(&self, text: &str) -> bool {
            self.copied.lock().unwrap().push(text.into());
            true
        }
    }

    struct Rig {
        world: Arc<Mutex<World>>,
        hub: Arc<FakeHub>,
        jobs: Arc<Mutex<Vec<(u64, Job)>>>,
        c: Controller<FakePlatform>,
    }

    fn rig_with(hub: FakeHub) -> Rig {
        let world = Arc::new(Mutex::new(World {
            foreground: Some(42),
            recording: Recording { samples: vec![0.1; 48_000], rate: 48_000, peak_rms: 0.2 },
            ..World::default()
        }));
        let hub = Arc::new(hub);
        let jobs: Arc<Mutex<Vec<(u64, Job)>>> = Arc::default();
        let sink = jobs.clone();
        let mut c = Controller::new(FakePlatform(world.clone()), hub.clone(), Box::new(move |id, job| sink.lock().unwrap().push((id, job))));
        c.handle(Event::Reload, 0);
        Rig { world, hub, jobs, c }
    }

    fn rig() -> Rig {
        rig_with(FakeHub::default())
    }

    impl Rig {
        fn take_job(&self) -> (u64, Job) {
            self.jobs.lock().unwrap().remove(0)
        }
        fn last_overlay(&self) -> OverlayState {
            self.world.lock().unwrap().overlays.last().cloned().unwrap()
        }
        fn result(&self) -> Option<DictationMessage> {
            self.last_overlay().result.map(|r| r.message)
        }
        fn set_key(&self, down: bool) {
            self.world.lock().unwrap().key_down = down;
        }
    }

    #[test]
    fn reload_registers_both_hotkeys_and_reports_problems() {
        let r = rig();
        let w = r.world.lock().unwrap();
        assert!(w.registered.contains(&(HotkeyId::Dictation, Some("Ctrl+Alt+D".into()))));
        assert!(w.registered.contains(&(HotkeyId::PasteLast, Some("Ctrl+Alt+Shift+D".into()))));
        drop(w);

        let hub = FakeHub::default();
        *hub.settings.lock().unwrap() = DictationSettings { hotkey: "D".into(), ..DictationSettings::default() };
        let mut r = rig_with(hub);
        r.world.lock().unwrap().taken.push("Ctrl+Alt+Shift+D".into());
        r.c.handle(Event::Reload, 0);
        let status = r.c.status();
        assert_eq!(status.hotkey.error, Some(HotkeyError::Invalid));
        assert_eq!(status.paste_last_hotkey.error, Some(HotkeyError::Taken));
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 0);
        assert_eq!(r.c.status().phase, Phase::Hidden, "no valid gesture, no dictation");
    }

    #[test]
    fn disabled_dictation_unregisters_the_hotkeys() {
        let hub = FakeHub::default();
        *hub.settings.lock().unwrap() = DictationSettings { enabled: false, ..DictationSettings::default() };
        let r = rig_with(hub);
        let w = r.world.lock().unwrap();
        assert!(w.registered.iter().all(|(_, g)| g.is_none()));
    }

    #[test]
    fn hold_to_talk_records_until_release_then_transcribes_and_inserts() {
        let mut r = rig();
        r.set_key(true);
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 1_000);
        assert_eq!(r.last_overlay().phase, Phase::Recording);
        assert!(r.world.lock().unwrap().registered.contains(&(HotkeyId::Escape, Some("Esc".into()))));
        r.c.handle(Event::Tick, 1_400);
        assert_eq!(r.last_overlay().mode, TalkMode::Hold);
        assert_eq!(r.last_overlay().elapsed_ms, 400);
        r.set_key(false);
        r.c.handle(Event::Tick, 2_000);
        assert_eq!(r.last_overlay().phase, Phase::Transcribing);
        assert_eq!(r.world.lock().unwrap().sounds, vec![Sound::Start, Sound::Stop]);

        let (id, job) = r.take_job();
        let Job::Transcribe { samples } = job else { panic!("expected transcribe") };
        assert_eq!(samples.len(), 16_000, "48 kHz second resampled to 16 kHz");
        r.c.handle(Event::Done(id, JobResult::Transcribed(Ok(Transcript { status: TranscriptStatus::Ok, raw_text: "Merhaba".into() }))), 3_000);

        let (id, job) = r.take_job();
        let delivery = FakeDelivery::default();
        let result = run_job(job, r.hub.as_ref(), &delivery);
        assert_eq!(delivery.inserted.lock().unwrap()[0], (42, "Merhaba".into(), InsertMethod::Paste, false));
        assert_eq!(r.hub.saved.lock().unwrap()[0].outputs, vec!["type".to_string()]);
        assert_eq!(r.hub.saved.lock().unwrap()[0].duration_seconds, 1.0);
        r.c.handle(Event::Done(id, result), 3_100);
        assert_eq!(r.result(), Some(DictationMessage::Inserted));
        assert_eq!(r.world.lock().unwrap().done, vec![Some(7)]);
        assert_eq!(r.world.lock().unwrap().registered.last(), Some(&(HotkeyId::Escape, None)));

        r.c.handle(Event::Tick, 3_100 + RESULT_OK_MS);
        assert_eq!(r.last_overlay().phase, Phase::Hidden);
        assert!(!r.c.needs_ticks());
    }

    #[test]
    fn a_quick_tap_toggles_and_the_next_press_stops() {
        let mut r = rig();
        r.set_key(true);
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 0);
        r.set_key(false);
        r.c.handle(Event::Tick, 120);
        r.c.handle(Event::Tick, 10_000);
        assert_eq!(r.last_overlay().mode, TalkMode::Toggle);
        assert_eq!(r.last_overlay().phase, Phase::Recording);
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 12_000);
        assert_eq!(r.last_overlay().phase, Phase::Transcribing);
    }

    #[test]
    fn recording_stops_by_itself_at_max_minutes() {
        let mut r = rig();
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 0);
        r.c.handle(Event::Tick, 100);
        r.c.handle(Event::Tick, 5 * 60_000);
        assert_eq!(r.last_overlay().phase, Phase::Transcribing);
    }

    #[test]
    fn escape_cancels_recording_and_processing() {
        let mut r = rig();
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 0);
        r.c.handle(Event::Hotkey(HotkeyId::Escape), 500);
        assert_eq!(r.result(), Some(DictationMessage::Cancelled));
        assert!(r.jobs.lock().unwrap().is_empty());

        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 1_000);
        r.c.handle(Event::Tick, 1_100);
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 2_000);
        let (id, _) = r.take_job();
        r.c.handle(Event::Cancel, 2_100);
        assert_eq!(*r.hub.cancels.lock().unwrap(), 1);
        assert_eq!(r.result(), Some(DictationMessage::Cancelled));
        // The late answer of the cancelled session changes nothing.
        let overlays = r.world.lock().unwrap().overlays.len();
        r.c.handle(Event::Done(id, JobResult::Transcribed(Ok(Transcript { status: TranscriptStatus::Ok, raw_text: "x".into() }))), 2_200);
        assert_eq!(r.world.lock().unwrap().overlays.len(), overlays);
        assert!(r.jobs.lock().unwrap().is_empty());
    }

    #[test]
    fn silence_missing_model_and_microphone_errors_end_with_a_message() {
        let mut r = rig();
        r.world.lock().unwrap().recording.peak_rms = 0.0;
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 0);
        r.c.handle(Event::Tick, 100);
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 1_000);
        assert_eq!(r.result(), Some(DictationMessage::Silent));
        assert_eq!(r.world.lock().unwrap().sounds.last(), Some(&Sound::Error));

        r.world.lock().unwrap().mic_error = true;
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 10_000);
        assert_eq!(r.result(), Some(DictationMessage::NoMicrophone));

        let hub = FakeHub::default();
        *hub.preload.lock().unwrap() = Some(HubCallError::ModelMissing);
        let mut r = rig_with(hub);
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 0);
        assert_eq!(r.result(), Some(DictationMessage::ModelMissing));
        assert_eq!(r.c.status().phase, Phase::Result);
    }

    #[test]
    fn no_speech_and_hub_errors_from_transcription() {
        let mut r = rig();
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 0);
        r.c.handle(Event::Tick, 100);
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 1_000);
        let (id, _) = r.take_job();
        r.c.handle(Event::Done(id, JobResult::Transcribed(Ok(Transcript { status: TranscriptStatus::NoSpeech, raw_text: String::new() }))), 2_000);
        assert_eq!(r.result(), Some(DictationMessage::NoSpeech));

        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 3_000);
        r.c.handle(Event::Tick, 3_100);
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 4_000);
        let (id, _) = r.take_job();
        r.c.handle(Event::Done(id, JobResult::Transcribed(Err(HubCallError::Unavailable))), 5_000);
        assert_eq!(r.result(), Some(DictationMessage::HubUnavailable));
    }

    #[test]
    fn ai_cleanup_runs_between_transcription_and_delivery_and_falls_back_to_raw() {
        let hub = FakeHub::default();
        *hub.settings.lock().unwrap() = DictationSettings { ai_cleanup: true, ..DictationSettings::default() };
        let mut r = rig_with(hub);
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 0);
        r.c.handle(Event::Tick, 100);
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 1_000);
        let (id, _) = r.take_job();
        r.c.handle(Event::Done(id, JobResult::Transcribed(Ok(Transcript { status: TranscriptStatus::Ok, raw_text: "ham metin".into() }))), 2_000);
        assert_eq!(r.last_overlay().phase, Phase::Cleaning);
        let (id, job) = r.take_job();
        assert_eq!(job, Job::Cleanup { text: "ham metin".into() });
        r.c.handle(Event::Done(id, JobResult::Cleaned(Err(HubCallError::Other("timeout".into())))), 3_000);
        let (id, job) = r.take_job();
        let Job::Deliver(d) = &job else { panic!("expected deliver") };
        assert_eq!((d.final_text.as_str(), d.cleaned, d.cleanup_failed), ("ham metin", false, true));
        let result = run_job(job, r.hub.as_ref(), &FakeDelivery::default());
        assert_eq!(result, JobResult::Delivered { message: DictationMessage::CleanupFailed, id: Some(7) });
        r.c.handle(Event::Done(id, result), 3_500);
        assert_eq!(r.result(), Some(DictationMessage::CleanupFailed));
    }

    fn deliver_job(settings: DictationSettings, target: Option<WindowId>) -> DeliverJob {
        DeliverJob {
            target,
            raw_text: "raw".into(),
            final_text: "final".into(),
            cleaned: true,
            cleanup_failed: false,
            duration_seconds: 2.0,
            settings,
            composer: false,
        }
    }

    #[test]
    fn delivery_falls_back_to_the_clipboard_and_reports_why() {
        let hub = FakeHub::default();
        let elevated = FakeDelivery { result: Some(InsertResult::Elevated), ..FakeDelivery::default() };
        let job = deliver_job(DictationSettings::default(), Some(1));
        assert_eq!(deliver(&job, &hub, &elevated), (DictationMessage::ElevatedTarget, Some(7)));
        assert_eq!(elevated.copied.lock().unwrap().as_slice(), ["final".to_string()]);
        assert_eq!(hub.saved.lock().unwrap()[0].outputs, vec!["clipboard".to_string()]);

        let none = FakeDelivery::default();
        assert_eq!(deliver(&deliver_job(DictationSettings::default(), None), &hub, &none).0, DictationMessage::NoTarget);
        assert!(none.inserted.lock().unwrap().is_empty());
    }

    #[test]
    fn delivery_outputs_clipboard_only_and_file_errors() {
        let hub = FakeHub { file_error: true, ..FakeHub::default() };
        let d = FakeDelivery::default();
        let settings = DictationSettings { output_focused: false, output_clipboard: true, ..DictationSettings::default() };
        assert_eq!(deliver(&deliver_job(settings, Some(1)), &hub, &d).0, DictationMessage::FileFailed);
        assert!(d.inserted.lock().unwrap().is_empty());
        assert_eq!(hub.saved.lock().unwrap()[0].outputs, vec!["clipboard".to_string()]);

        let hub = FakeHub::default();
        let d = FakeDelivery::default();
        let settings = DictationSettings { output_clipboard: true, insert_method: InsertMethod::Type, ..DictationSettings::default() };
        assert_eq!(deliver(&deliver_job(settings, Some(1)), &hub, &d).0, DictationMessage::Inserted);
        assert_eq!(d.inserted.lock().unwrap()[0].2, InsertMethod::Type);
        assert_eq!(d.copied.lock().unwrap().len(), 1, "typed text still goes to the clipboard when asked");
        assert_eq!(hub.saved.lock().unwrap()[0].outputs, vec!["type".to_string(), "clipboard".to_string()]);
    }

    #[test]
    fn paste_last_inserts_the_newest_text_and_reports_failures() {
        let mut r = rig_with(FakeHub { latest: Some("son dikte".into()), ..FakeHub::default() });
        r.c.handle(Event::Hotkey(HotkeyId::PasteLast), 0);
        let (id, job) = r.take_job();
        assert_eq!(job, Job::PasteLast { target: Some(42), method: InsertMethod::Paste });
        let d = FakeDelivery::default();
        let result = run_job(job, r.hub.as_ref(), &d);
        assert_eq!(result, JobResult::PastedLast(None));
        assert_eq!(d.inserted.lock().unwrap()[0], (42, "son dikte".into(), InsertMethod::Paste, false));
        let overlays = r.world.lock().unwrap().overlays.len();
        r.c.handle(Event::Done(id, result), 100);
        assert_eq!(r.world.lock().unwrap().overlays.len(), overlays, "success shows nothing");

        let empty = FakeHub::default();
        assert_eq!(paste_last(Some(1), InsertMethod::Paste, &empty, &d), Some(DictationMessage::NoSpeech));
        r.c.handle(Event::Done(0, JobResult::PastedLast(Some(DictationMessage::ElevatedTarget))), 200);
        assert_eq!(r.result(), Some(DictationMessage::ElevatedTarget));
    }

    fn composer(r: &Rig) -> Vec<ComposerResult> {
        r.world.lock().unwrap().composer.clone()
    }

    #[test]
    fn composer_dictation_hands_the_text_to_the_pane_without_os_insertion() {
        let hub = FakeHub::default();
        // Hotkey settings don't matter for the composer mic, and OS outputs are skipped.
        *hub.settings.lock().unwrap() =
            DictationSettings { hotkey: String::new(), output_clipboard: true, ..DictationSettings::default() };
        let mut r = rig_with(hub);
        r.set_key(true); // a held key must not stop a composer recording
        r.c.handle(Event::StartComposer("pane-1".into()), 0);
        assert_eq!(r.last_overlay().phase, Phase::Recording);
        assert_eq!(r.last_overlay().mode, TalkMode::Toggle);
        r.set_key(false);
        r.c.handle(Event::Tick, 1_000);
        r.c.handle(Event::Tick, 60_000);
        assert_eq!(r.last_overlay().phase, Phase::Recording, "toggle: only the stop command ends it");

        r.c.handle(Event::StopComposer, 61_000);
        assert_eq!(r.last_overlay().phase, Phase::Transcribing);
        let (id, _) = r.take_job();
        r.c.handle(Event::Done(id, JobResult::Transcribed(Ok(Transcript { status: TranscriptStatus::Ok, raw_text: "merhaba".into() }))), 62_000);
        assert_eq!(
            composer(&r),
            vec![ComposerResult { pane_id: "pane-1".into(), text: Some("merhaba".into()), cleaned: Some(false), error: None, detail: None }]
        );

        let (id, job) = r.take_job();
        let delivery = FakeDelivery::default();
        let result = run_job(job, r.hub.as_ref(), &delivery);
        assert!(delivery.inserted.lock().unwrap().is_empty());
        assert!(delivery.copied.lock().unwrap().is_empty());
        assert_eq!(r.hub.saved.lock().unwrap()[0].outputs, Vec::<String>::new());
        assert_eq!(r.hub.saved.lock().unwrap()[0].final_text, "merhaba");
        r.c.handle(Event::Done(id, result), 62_100);
        assert_eq!(r.result(), Some(DictationMessage::Done));
        assert_eq!(r.world.lock().unwrap().done, vec![Some(7)]);
        assert_eq!(composer(&r).len(), 1, "exactly one composer event per dictation");
        r.c.handle(Event::Tick, 62_100 + RESULT_OK_MS);
        assert_eq!(r.last_overlay().phase, Phase::Hidden);
    }

    #[test]
    fn composer_dictation_reports_cancel_silence_cleanup_and_busy() {
        // Esc / ✕ while recording.
        let mut r = rig();
        r.c.handle(Event::StartComposer("p".into()), 0);
        r.c.handle(Event::Cancel, 500);
        assert_eq!(composer(&r), vec![ComposerResult::error("p".into(), DictationMessage::Cancelled, None)]);

        // Silence.
        r.world.lock().unwrap().recording.peak_rms = 0.0;
        r.c.handle(Event::StartComposer("p".into()), 1_000);
        r.c.handle(Event::StopComposer, 2_000);
        assert_eq!(composer(&r)[1].error, Some(DictationMessage::Silent));

        // Busy: a hotkey dictation is running; it keeps running.
        let mut r = rig();
        r.c.handle(Event::Hotkey(HotkeyId::Dictation), 0);
        r.c.handle(Event::StartComposer("p".into()), 100);
        assert_eq!(composer(&r), vec![ComposerResult::error("p".into(), DictationMessage::Failed, Some("busy".into()))]);
        r.c.handle(Event::StopComposer, 200);
        assert_eq!(r.c.status().phase, Phase::Recording, "stop_composer leaves a hotkey dictation alone");

        // AI cleanup: the cleaned text goes to the composer.
        let hub = FakeHub::default();
        *hub.settings.lock().unwrap() = DictationSettings { ai_cleanup: true, ..DictationSettings::default() };
        let mut r = rig_with(hub);
        r.c.handle(Event::StartComposer("p2".into()), 0);
        r.c.handle(Event::StopComposer, 1_000);
        let (id, _) = r.take_job();
        r.c.handle(Event::Done(id, JobResult::Transcribed(Ok(Transcript { status: TranscriptStatus::Ok, raw_text: "ham".into() }))), 2_000);
        let (id, _) = r.take_job();
        r.c.handle(Event::Done(id, JobResult::Cleaned(Ok(Cleanup { final_text: "Ham.".into(), cleaned: true, note: None }))), 3_000);
        assert_eq!(composer(&r)[0].text.as_deref(), Some("Ham."));
        assert_eq!(composer(&r)[0].cleaned, Some(true));

        // Hub down during transcription.
        let mut r = rig();
        r.c.handle(Event::StartComposer("p3".into()), 0);
        r.c.handle(Event::StopComposer, 1_000);
        let (id, _) = r.take_job();
        r.c.handle(Event::Done(id, JobResult::Transcribed(Err(HubCallError::Unavailable))), 2_000);
        assert_eq!(composer(&r), vec![ComposerResult::error("p3".into(), DictationMessage::HubUnavailable, None)]);
    }

    #[test]
    fn composer_payload_serializes_to_the_contract() {
        let ok = ComposerResult { pane_id: "p".into(), text: Some("hi".into()), cleaned: Some(true), error: None, detail: None };
        assert_eq!(serde_json::to_value(ok).unwrap(), serde_json::json!({"paneId":"p","text":"hi","cleaned":true}));
        let err = ComposerResult::error("p".into(), DictationMessage::NoSpeech, None);
        assert_eq!(serde_json::to_value(err).unwrap(), serde_json::json!({"paneId":"p","error":"noSpeech"}));
    }

    #[test]
    fn overlay_payload_serializes_to_the_contract() {
        let json = serde_json::to_value(OverlayState {
            phase: Phase::Result,
            mode: TalkMode::Hold,
            elapsed_ms: 7_000,
            level: 0.5,
            result: Some(OverlayResult { ok: false, message: DictationMessage::NoSpeech, detail: None }),
            sound: Some(Sound::Error),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"phase":"result","mode":"hold","elapsedMs":7000,"level":0.5,"result":{"ok":false,"message":"noSpeech","detail":null},"sound":"error"})
        );
    }
}
