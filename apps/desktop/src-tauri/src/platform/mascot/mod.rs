//! M6 robot snail mascot (D-052): the small always-on-top `mascot` window, where it stands,
//! and its walk along the taskbar. The main window decides the state (`mascot_update`) and
//! the settings (`mascot_set_config`); this module owns the window, its placement and
//! movement, and forwards the page's clicks, drags and context menu back to the main window.
//!
//! Threads: a walker (~30 fps) that only runs while the snail walks, and a 2 s check that
//! only runs while the mascot is on (full screen, work area/DPI and animation-setting
//! changes). The OS side lives in `win.rs`; other systems get a stub that never shows the
//! window. The state lock is never held while calling into the window system.

pub mod geometry;
#[cfg(windows)]
mod win;

use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use geometry::{Direction, Display, MascotState, Rect, WalkArea};

pub const MASCOT_LABEL: &str = "mascot";
const MAIN_LABEL: &str = "main";
const WALK_FRAME: Duration = Duration::from_millis(33);
const CHECK_EVERY: Duration = Duration::from_secs(2);
/// Longest step the walker takes after a stall (sleep, debugger), in seconds.
const MAX_STEP: f64 = 0.1;

const MENU_HIDE_HOUR: &str = "mascot:hideHour";
const MENU_TURN_OFF: &str = "mascot:turnOff";
const MENU_SETTINGS: &str = "mascot:settings";
const MENU_OPEN_ASSISTANT: &str = "mascot:openAssistant";

#[cfg(windows)]
mod os {
    pub use super::win::{move_window, query_env, show_without_activation, window_rect};

    pub fn handle(window: &tauri::WebviewWindow) -> Option<isize> {
        window.hwnd().ok().map(|h| h.0 as isize)
    }
}

#[cfg(not(windows))]
mod os {
    use super::Env;

    pub fn query_env() -> Env {
        Env::default()
    }
    pub fn handle(_window: &tauri::WebviewWindow) -> Option<isize> {
        None
    }
    pub fn move_window(_handle: isize, _x: i32, _y: i32, _size: Option<(i32, i32)>, _wait: bool) {}
    pub fn show_without_activation(_handle: isize) {}
    pub fn window_rect(_handle: isize) -> Option<(i32, i32, i32, i32)> {
        None
    }
}

/// Context-menu labels, already translated by the main window.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MascotLabels {
    pub aria: String,
    pub hide_hour: String,
    pub turn_off: String,
    pub settings: String,
    /// M7: "Open assistant"; empty = no menu item.
    pub open_assistant: String,
}

/// M7: a click on a calm snail opens the assistant (the old prototype's "Bip"); a snail
/// that needs attention keeps bringing the main window up.
fn click_opens_assistant(state: MascotState, assistant_enabled: bool) -> bool {
    assistant_enabled && matches!(state, MascotState::Sleep | MascotState::Done | MascotState::Work)
}

fn assistant_enabled(app: &AppHandle) -> bool {
    app.try_state::<crate::platform::assistant::Assistant>().is_some_and(|a| a.enabled())
}

/// Opens the assistant off the calling thread (menu events run on the UI thread).
fn open_assistant(app: &AppHandle) {
    let app = app.clone();
    let spawned = thread::Builder::new().name("assistant-open".into()).spawn(move || {
        if let Some(assistant) = app.try_state::<crate::platform::assistant::Assistant>() {
            assistant.open(&app);
        }
    });
    if let Err(e) = spawned {
        log::error!("mascot: assistant could not be opened: {e}");
    }
}

/// `mascot_set_config` argument. `enabled` already folds in "hidden until".
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MascotConfig {
    pub enabled: bool,
    /// 2..=4 (clamped).
    pub scale: u8,
    pub walk_area: WalkArea,
    pub celebrate: bool,
    /// 0..1 along the walking track (clamped).
    pub position: f64,
    #[serde(default)]
    pub labels: MascotLabels,
}

/// `mascot_update` argument: the aggregate state and the walking speed factor.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct MascotUpdate {
    pub state: MascotState,
    pub speed: f64,
}

/// `mascot:state` payload for the mascot page.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePayload {
    pub state: MascotState,
    pub direction: Direction,
    pub walking: bool,
    pub scale: u8,
    pub celebrate: bool,
    pub label: String,
    /// Windows "Animation effects" is off: no walk, no bob, state only.
    pub reduced_motion: bool,
}

/// What the OS says about the screen.
#[derive(Clone, Debug, PartialEq)]
pub struct Env {
    pub display: Option<Display>,
    /// Full screen, D3D full screen or presentation mode: hide.
    pub busy: bool,
    /// Animation effects on (off = reduced motion).
    pub animations: bool,
}

impl Default for Env {
    fn default() -> Self {
        Self { display: None, busy: false, animations: true }
    }
}

/// Window work that follows a state change, done after the lock is released.
#[derive(Debug, Default, PartialEq)]
struct Plan {
    hwnd: Option<isize>,
    place: Option<Rect>,
    show: Option<bool>,
    emit: Option<StatePayload>,
    start_walker: Option<u64>,
}

/// One walker frame.
#[derive(Debug, PartialEq)]
struct Tick {
    hwnd: isize,
    moved: Option<Rect>,
    emit: Option<StatePayload>,
}

struct Inner {
    config: Option<MascotConfig>,
    state: MascotState,
    speed: f64,
    direction: Direction,
    position: f64,
    dragging: bool,
    env: Env,
    /// Bumped whenever the mascot turns on or off; threads of an older generation exit.
    generation: u64,
    walker: bool,
    hwnd: Option<isize>,
    placed: Option<Rect>,
    shown: bool,
    sent: Option<StatePayload>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            config: None,
            state: MascotState::Sleep,
            speed: 1.0,
            direction: Direction::Right,
            position: 1.0,
            dragging: false,
            env: Env::default(),
            generation: 0,
            walker: false,
            hwnd: None,
            placed: None,
            shown: false,
            sent: None,
        }
    }
}

impl Inner {
    fn enabled(&self) -> bool {
        self.config.as_ref().is_some_and(|c| c.enabled)
    }

    fn area(&self) -> WalkArea {
        self.config.as_ref().map_or(WalkArea::Taskbar, |c| c.walk_area)
    }

    fn scale(&self) -> u8 {
        geometry::clamp_scale(self.config.as_ref().map_or(geometry::MIN_SCALE, |c| c.scale))
    }

    fn visible(&self) -> bool {
        self.enabled() && !self.env.busy && self.env.display.is_some() && self.hwnd.is_some()
    }

    fn walking(&self) -> bool {
        self.visible() && geometry::should_walk(self.state, self.area(), self.env.animations, self.dragging)
    }

    fn size(&self, display: &Display) -> i32 {
        geometry::window_size_px(self.scale(), display.scale)
    }

    fn target_rect(&self) -> Option<Rect> {
        let display = self.env.display?;
        Some(geometry::window_rect(&display, self.size(&display), self.position, self.area()))
    }

    fn track_len(&self) -> i32 {
        self.env.display.map_or(0, |d| geometry::track(&d, self.size(&d)).len)
    }

    fn payload(&self) -> Option<StatePayload> {
        let config = self.config.as_ref().filter(|c| c.enabled)?;
        Some(StatePayload {
            state: self.state,
            direction: self.direction,
            walking: self.walking(),
            scale: self.scale(),
            celebrate: config.celebrate,
            label: config.labels.aria.clone(),
            reduced_motion: !self.env.animations,
        })
    }

    /// Turns the mascot on (`config.enabled`) or off; returns the new generation when it
    /// just turned on (the caller starts the check thread for it).
    fn set_config(&mut self, mut config: MascotConfig) -> Option<u64> {
        config.scale = geometry::clamp_scale(config.scale);
        config.position = if config.position.is_finite() { config.position.clamp(0.0, 1.0) } else { 1.0 };
        let was = self.enabled();
        let now = config.enabled;
        if !was && now {
            // The saved position counts when the mascot (re)appears; afterwards it is ours.
            self.position = config.position;
        }
        self.config = Some(config);
        if was == now {
            return None;
        }
        self.generation += 1;
        self.walker = false;
        self.dragging = false;
        if !now {
            self.hwnd = None;
            self.placed = None;
            self.shown = false;
            self.sent = None;
            return None;
        }
        Some(self.generation)
    }

    fn plan(&mut self, force_emit: bool) -> Plan {
        let mut plan = Plan { hwnd: self.hwnd, ..Plan::default() };
        if self.hwnd.is_none() {
            return plan;
        }
        let visible = self.visible();
        if visible {
            if let Some(rect) = self.target_rect() {
                if self.placed != Some(rect) {
                    self.placed = Some(rect);
                    plan.place = Some(rect);
                }
            }
        }
        if visible != self.shown {
            self.shown = visible;
            plan.show = Some(visible);
        }
        let payload = self.payload();
        if force_emit || payload != self.sent {
            self.sent.clone_from(&payload);
            plan.emit = payload;
        }
        if self.walking() && !self.walker {
            self.walker = true;
            plan.start_walker = Some(self.generation);
        }
        plan
    }

    /// One walker frame of `dt` seconds; `None` = the walker stops.
    fn walk_tick(&mut self, generation: u64, dt: f64) -> Option<Tick> {
        if generation != self.generation {
            // A newer generation owns the `walker` flag.
            return None;
        }
        let (Some(hwnd), Some(display), true) = (self.hwnd, self.env.display, self.walking()) else {
            self.walker = false;
            return None;
        };
        let speed = geometry::walk_speed_px(self.state, self.speed, display.scale);
        let (position, direction) =
            geometry::walk_step(self.position, self.direction, speed, dt.clamp(0.0, MAX_STEP), self.track_len());
        self.position = position;
        self.direction = direction;
        let rect = self.target_rect();
        let moved = rect.filter(|r| self.placed != Some(*r));
        if moved.is_some() {
            self.placed = rect;
        }
        let payload = self.payload();
        let emit = (payload != self.sent).then(|| payload.clone()).flatten();
        if emit.is_some() {
            self.sent = payload;
        }
        Some(Tick { hwnd, moved, emit })
    }

    fn drag(&mut self, dx: f64) -> Plan {
        if !self.visible() || self.area() != WalkArea::Taskbar || !dx.is_finite() {
            return Plan::default();
        }
        self.dragging = true;
        if dx > 0.0 {
            self.direction = Direction::Right;
        } else if dx < 0.0 {
            self.direction = Direction::Left;
        }
        let scale = self.env.display.map_or(1.0, |d| d.scale);
        self.position = geometry::drag_position(self.position, dx, scale, self.track_len());
        self.plan(false)
    }

    /// Ends a drag; returns the position to save, if a drag was going on.
    fn drag_end(&mut self) -> (Option<f64>, Plan) {
        if !self.dragging {
            return (None, Plan::default());
        }
        self.dragging = false;
        (Some(self.position), self.plan(false))
    }

    /// The 2 s check: new OS facts, and a re-place if the window drifted (DPI change).
    fn check(&mut self, generation: u64, env: Env, actual: Option<(i32, i32, i32, i32)>) -> Option<Plan> {
        if generation != self.generation || !self.enabled() {
            return None;
        }
        self.env = env;
        if let (Some(placed), Some(actual), false) = (self.placed, actual, self.walking() || self.dragging) {
            if (placed.left, placed.top, placed.right, placed.bottom) != actual {
                self.placed = None;
            }
        }
        Some(self.plan(false))
    }
}

/// Managed state behind the `mascot_*` commands.
#[derive(Default)]
pub struct Mascot {
    inner: Arc<Mutex<Inner>>,
    /// Serialises `set_config` (window create/destroy).
    config_lock: Mutex<()>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Mascot {
    pub fn set_config(&self, app: &AppHandle, config: MascotConfig) {
        let _serial = lock(&self.config_lock);
        if !config.enabled {
            lock(&self.inner).set_config(config);
            if let Some(window) = app.get_webview_window(MASCOT_LABEL) {
                let _ = window.destroy();
            }
            return;
        }
        let env = os::query_env();
        let (started, initial) = {
            let mut inner = lock(&self.inner);
            inner.env = env;
            let started = inner.set_config(config);
            (started, inner.target_rect().zip(inner.env.display.map(|d| d.scale)))
        };
        let window = match app.get_webview_window(MASCOT_LABEL) {
            Some(window) => Some(window),
            None => match create_window(app, initial) {
                Ok(window) => Some(window),
                Err(e) => {
                    log::error!("mascot: window could not be created: {e}");
                    None
                }
            },
        };
        let plan = {
            let mut inner = lock(&self.inner);
            inner.hwnd = window.as_ref().and_then(os::handle);
            inner.plan(false)
        };
        self.execute(app, plan);
        if let Some(generation) = started {
            self.spawn_check(app, generation);
        }
    }

    pub fn update(&self, app: &AppHandle, update: MascotUpdate) {
        let plan = {
            let mut inner = lock(&self.inner);
            inner.state = update.state;
            inner.speed = update.speed;
            inner.plan(false)
        };
        self.execute(app, plan);
    }

    pub fn ready(&self, app: &AppHandle) {
        let plan = lock(&self.inner).plan(true);
        self.execute(app, plan);
    }

    pub fn clicked(&self, app: &AppHandle) {
        let state = lock(&self.inner).state;
        if click_opens_assistant(state, assistant_enabled(app)) {
            open_assistant(app);
        } else {
            bring_main_up(app);
        }
        // Sent in every case so the main window's handling stays the same.
        let _ = app.emit_to(MAIN_LABEL, "mascot:clicked", serde_json::json!({ "state": state }));
    }

    pub fn context_menu(&self, app: &AppHandle) -> tauri::Result<()> {
        let labels = lock(&self.inner).config.as_ref().map(|c| c.labels.clone()).unwrap_or_default();
        let Some(window) = app.get_webview_window(MASCOT_LABEL) else { return Ok(()) };
        let hide = MenuItem::with_id(app, MENU_HIDE_HOUR, &labels.hide_hour, true, None::<&str>)?;
        let off = MenuItem::with_id(app, MENU_TURN_OFF, &labels.turn_off, true, None::<&str>)?;
        let settings = MenuItem::with_id(app, MENU_SETTINGS, &labels.settings, true, None::<&str>)?;
        let menu = if !labels.open_assistant.is_empty() && assistant_enabled(app) {
            let assistant = MenuItem::with_id(app, MENU_OPEN_ASSISTANT, &labels.open_assistant, true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            Menu::with_items(app, &[&assistant, &separator, &hide, &off, &settings])?
        } else {
            Menu::with_items(app, &[&hide, &off, &settings])?
        };
        window.popup_menu(&menu)
    }

    pub fn drag(&self, app: &AppHandle, dx: f64) {
        let plan = lock(&self.inner).drag(dx);
        self.execute(app, plan);
    }

    pub fn drag_end(&self, app: &AppHandle) {
        let (position, plan) = lock(&self.inner).drag_end();
        self.execute(app, plan);
        if let Some(position) = position {
            let _ = app.emit_to(MAIN_LABEL, "mascot:position", serde_json::json!({ "position": position }));
        }
    }

    /// The main window is gone: stop the threads and close the mascot.
    pub fn shutdown(&self, app: &AppHandle) {
        let mut inner = lock(&self.inner);
        if let Some(config) = inner.config.clone() {
            inner.set_config(MascotConfig { enabled: false, ..config });
        }
        drop(inner);
        if let Some(window) = app.get_webview_window(MASCOT_LABEL) {
            let _ = window.destroy();
        }
    }

    fn execute(&self, app: &AppHandle, plan: Plan) {
        if let Some(hwnd) = plan.hwnd {
            if let Some(r) = plan.place {
                os::move_window(hwnd, r.left, r.top, Some((r.width(), r.height())), true);
            }
            match plan.show {
                Some(true) => os::show_without_activation(hwnd),
                Some(false) => {
                    if let Some(window) = app.get_webview_window(MASCOT_LABEL) {
                        let _ = window.hide();
                    }
                }
                None => {}
            }
        }
        if let Some(payload) = plan.emit {
            let _ = app.emit_to(MASCOT_LABEL, "mascot:state", payload);
        }
        if let Some(generation) = plan.start_walker {
            self.spawn_walker(app, generation);
        }
    }

    fn spawn_walker(&self, app: &AppHandle, generation: u64) {
        let inner = Arc::clone(&self.inner);
        let app = app.clone();
        let spawned = thread::Builder::new().name("mascot-walk".into()).spawn(move || {
            let mut last = Instant::now();
            loop {
                thread::sleep(WALK_FRAME);
                let now = Instant::now();
                let dt = now.duration_since(last).as_secs_f64();
                last = now;
                let Some(tick) = lock(&inner).walk_tick(generation, dt) else { return };
                if let Some(r) = tick.moved {
                    os::move_window(tick.hwnd, r.left, r.top, None, false);
                }
                if let Some(payload) = tick.emit {
                    let _ = app.emit_to(MASCOT_LABEL, "mascot:state", payload);
                }
            }
        });
        if let Err(e) = spawned {
            log::error!("mascot: walker thread could not start: {e}");
            lock(&self.inner).walker = false;
        }
    }

    fn spawn_check(&self, app: &AppHandle, generation: u64) {
        let inner = Arc::clone(&self.inner);
        let app = app.clone();
        let spawned = thread::Builder::new().name("mascot-check".into()).spawn(move || loop {
            thread::sleep(CHECK_EVERY);
            let env = os::query_env();
            let plan = {
                let mut guard = lock(&inner);
                let actual = guard.hwnd.and_then(os::window_rect);
                guard.check(generation, env, actual)
            };
            let Some(plan) = plan else { return };
            if let Some(mascot) = app.try_state::<Mascot>() {
                mascot.execute(&app, plan);
            }
        });
        if let Err(e) = spawned {
            log::error!("mascot: check thread could not start: {e}");
        }
    }
}

fn create_window(app: &AppHandle, initial: Option<(Rect, f64)>) -> tauri::Result<WebviewWindow> {
    let mut builder = WebviewWindowBuilder::new(app, MASCOT_LABEL, WebviewUrl::App("index.html?view=mascot".into()))
        .title("Mascot")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .on_menu_event(|window, event| on_menu(window.app_handle(), event.id().as_ref()));
    if let Some((rect, scale)) = initial {
        // Created on the primary monitor at its place, so no DPI change follows the first move.
        builder = builder
            .inner_size(f64::from(rect.width()) / scale, f64::from(rect.height()) / scale)
            .position(f64::from(rect.left) / scale, f64::from(rect.top) / scale);
    }
    builder.build()
}

/// Every window's menu listener sees every menu event; only ours are handled.
fn on_menu(app: &AppHandle, id: &str) {
    let action = match id {
        MENU_HIDE_HOUR => "hideHour",
        MENU_TURN_OFF => "turnOff",
        MENU_SETTINGS => {
            bring_main_up(app);
            "settings"
        }
        // M7: handled here; the main window has nothing to do for it.
        MENU_OPEN_ASSISTANT => return open_assistant(app),
        _ => return,
    };
    let _ = app.emit_to(MAIN_LABEL, "mascot:menu", serde_json::json!({ "action": action }));
}

fn bring_main_up(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::geometry::{Taskbar, TaskbarEdge};
    use super::*;

    fn display() -> Display {
        Display {
            work: Rect { left: 0, top: 0, right: 1920, bottom: 1032 },
            scale: 1.0,
            taskbar: Some(Taskbar {
                edge: TaskbarEdge::Bottom,
                rect: Rect { left: 0, top: 1032, right: 1920, bottom: 1080 },
                auto_hide: false,
            }),
        }
    }

    fn config(enabled: bool) -> MascotConfig {
        MascotConfig {
            enabled,
            scale: 2,
            walk_area: WalkArea::Taskbar,
            celebrate: true,
            position: 0.5,
            labels: MascotLabels { aria: "Mascot".into(), ..MascotLabels::default() },
        }
    }

    /// An enabled mascot with a window.
    fn on() -> Inner {
        let mut inner = Inner { env: Env { display: Some(display()), busy: false, animations: true }, ..Inner::default() };
        assert_eq!(inner.set_config(config(true)), Some(1));
        inner.hwnd = Some(42);
        inner
    }

    #[test]
    fn config_wire_format_is_camel_case() {
        let json = r#"{"enabled":true,"scale":3,"walkArea":"corner","celebrate":false,"position":0.25,
            "labels":{"aria":"A","hideHour":"H","turnOff":"T","settings":"S"}}"#;
        let c: MascotConfig = serde_json::from_str(json).unwrap();
        assert_eq!(c.walk_area, WalkArea::Corner);
        assert_eq!(c.labels.hide_hour, "H");
        assert_eq!(c.labels.turn_off, "T");
        assert_eq!(c.labels.open_assistant, "", "optional");
        let labels: MascotLabels = serde_json::from_str(r#"{"openAssistant":"Open assistant"}"#).unwrap();
        assert_eq!(labels.open_assistant, "Open assistant");
        let u: MascotUpdate = serde_json::from_str(r#"{"state":"perm","speed":1.15}"#).unwrap();
        assert_eq!(u.state, MascotState::Perm);
    }

    #[test]
    fn calm_states_open_the_assistant_when_it_is_on() {
        use MascotState::*;
        for state in [Sleep, Done, Work] {
            assert!(click_opens_assistant(state, true), "{state:?}");
            assert!(!click_opens_assistant(state, false), "{state:?}");
        }
        for state in [Perm, Input, Error, Sweat] {
            assert!(!click_opens_assistant(state, true), "{state:?}");
        }
    }

    #[test]
    fn payload_wire_format() {
        let p = on().payload().unwrap();
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"state":"sleep","direction":"right","walking":false,"scale":2,
                "celebrate":true,"label":"Mascot","reducedMotion":false})
        );
    }

    #[test]
    fn first_plan_places_shows_and_emits() {
        let mut inner = on();
        let plan = inner.plan(false);
        assert_eq!(plan.place, Some(Rect { left: 928, top: 968, right: 992, bottom: 1032 }));
        assert_eq!(plan.show, Some(true));
        assert!(plan.emit.is_some());
        assert_eq!(plan.start_walker, None);
        // Nothing changed: nothing to do, unless the page asks again.
        assert_eq!(inner.plan(false), Plan { hwnd: Some(42), ..Plan::default() });
        assert!(inner.plan(true).emit.is_some());
    }

    #[test]
    fn work_starts_one_walker_and_sleep_stops_it() {
        let mut inner = on();
        inner.plan(false);
        inner.state = MascotState::Work;
        let plan = inner.plan(false);
        assert_eq!(plan.start_walker, Some(1));
        assert!(plan.emit.unwrap().walking);
        assert_eq!(inner.plan(false).start_walker, None);

        let tick = inner.walk_tick(1, 1.0 / 30.0).unwrap();
        assert!(inner.position > 0.5);
        assert_eq!(tick.hwnd, 42);

        inner.state = MascotState::Sleep;
        let plan = inner.plan(false);
        assert!(!plan.emit.unwrap().walking);
        assert_eq!(inner.walk_tick(1, 1.0 / 30.0), None);
        assert!(!inner.walker);
    }

    #[test]
    fn walker_turning_emits_the_new_direction_once() {
        let mut inner = on();
        inner.plan(false);
        inner.state = MascotState::Work;
        inner.position = 1.0;
        inner.plan(false);
        let tick = inner.walk_tick(1, 0.05).unwrap();
        assert_eq!(tick.emit.unwrap().direction, Direction::Left);
        assert_eq!(inner.walk_tick(1, 0.05).unwrap().emit, None);
    }

    #[test]
    fn old_generation_walker_exits_without_touching_the_flag() {
        let mut inner = on();
        inner.state = MascotState::Work;
        inner.plan(false);
        inner.set_config(config(false));
        inner.set_config(config(true));
        inner.hwnd = Some(42);
        assert_eq!(inner.plan(false).start_walker, Some(3));
        assert_eq!(inner.walk_tick(1, 0.03), None);
        assert!(inner.walker);
    }

    #[test]
    fn no_walking_in_corner_or_with_reduced_motion() {
        let mut inner = on();
        inner.state = MascotState::Work;
        inner.env.animations = false;
        let plan = inner.plan(false);
        assert_eq!(plan.start_walker, None);
        let p = plan.emit.unwrap();
        assert!(!p.walking && p.reduced_motion);

        let mut inner = on();
        inner.state = MascotState::Sweat;
        inner.set_config(MascotConfig { walk_area: WalkArea::Corner, ..config(true) });
        assert_eq!(inner.plan(false).start_walker, None);
    }

    #[test]
    fn full_screen_hides_and_shows_again() {
        let mut inner = on();
        inner.plan(false);
        let busy = Env { busy: true, ..inner.env.clone() };
        assert_eq!(inner.check(1, busy, None).unwrap().show, Some(false));
        let free = Env { busy: false, ..inner.env.clone() };
        assert_eq!(inner.check(1, free, None).unwrap().show, Some(true));
        // A check of an older generation does nothing.
        assert_eq!(inner.check(0, inner.env.clone(), None), None);
    }

    #[test]
    fn work_area_change_and_drift_re_place() {
        let mut inner = on();
        inner.plan(false);
        let mut moved = inner.env.clone();
        if let Some(d) = moved.display.as_mut() {
            d.work.right = 2560;
        }
        assert!(inner.check(1, moved.clone(), None).unwrap().place.is_some());
        let placed = inner.placed.unwrap();
        let same = Some((placed.left, placed.top, placed.right, placed.bottom));
        assert_eq!(inner.check(1, moved.clone(), same).unwrap().place, None);
        let drifted = Some((placed.left, placed.top, placed.right + 30, placed.bottom + 30));
        assert_eq!(inner.check(1, moved, drifted).unwrap().place, Some(placed));
    }

    #[test]
    fn drag_moves_pauses_walking_and_reports_the_position() {
        let mut inner = on();
        inner.state = MascotState::Work;
        inner.plan(false);
        let plan = inner.drag(-185.6); // track 1856 px at 100 %: -0.1
        assert!((inner.position - 0.4).abs() < 1e-9);
        assert!(!plan.emit.unwrap().walking);
        assert_eq!(inner.direction, Direction::Left);
        assert_eq!(inner.walk_tick(1, 0.03), None);
        let (position, plan) = inner.drag_end();
        assert!((position.unwrap() - 0.4).abs() < 1e-9);
        assert_eq!(plan.start_walker, Some(1));
        assert_eq!(inner.drag_end().0, None);
    }

    #[test]
    fn drag_does_nothing_in_corner() {
        let mut inner = on();
        inner.set_config(MascotConfig { walk_area: WalkArea::Corner, ..config(true) });
        assert_eq!(inner.drag(50.0), Plan::default());
        assert_eq!(inner.drag_end().0, None);
    }

    #[test]
    fn saved_position_only_counts_when_turning_on() {
        let mut inner = on();
        inner.position = 0.9;
        inner.set_config(MascotConfig { position: 0.1, ..config(true) });
        assert!((inner.position - 0.9).abs() < 1e-9);
        inner.set_config(config(false));
        inner.set_config(MascotConfig { position: 0.1, ..config(true) });
        assert!((inner.position - 0.1).abs() < 1e-9);
    }

    #[test]
    fn config_is_sanitised() {
        let mut inner = on();
        inner.set_config(MascotConfig { scale: 9, position: f64::NAN, ..config(true) });
        assert_eq!(inner.scale(), 4);
        assert_eq!(inner.config.as_ref().unwrap().position, 1.0);
    }

    #[test]
    fn turning_off_forgets_the_window() {
        let mut inner = on();
        inner.plan(false);
        assert_eq!(inner.set_config(config(false)), None);
        assert_eq!(inner.hwnd, None);
        assert_eq!(inner.payload(), None);
        assert_eq!(inner.plan(false), Plan::default());
    }
}
