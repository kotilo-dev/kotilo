//! M6 mascot: pure placement and walking maths (no OS types, tested on every OS).
//!
//! All rectangles are physical pixels in virtual-screen coordinates. Sizes and speeds
//! are given in logical pixels and converted with the monitor's DPI scale.
//!
//! Placement choice (D-052): in `taskbar` mode the snail always walks horizontally. With a
//! visible taskbar at the bottom it stands on the taskbar's top edge; with the taskbar at
//! the top/left/right, or auto-hidden, it walks along the bottom of the work area (the
//! screen's bottom edge in those cases). It never climbs a vertical taskbar.

use serde::{Deserialize, Serialize};

/// Base walking speed in logical px/s at speed factor 1.
pub const BASE_SPEED: f64 = 18.0;
/// `sweat` walks slower than `work`.
pub const SWEAT_FACTOR: f64 = 0.6;
/// Distance from the work area's edges in `corner` placement, in logical px.
pub const CORNER_MARGIN: f64 = 12.0;
pub const MIN_SCALE: u8 = 2;
pub const MAX_SCALE: u8 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WalkArea {
    Taskbar,
    Corner,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Left,
    Right,
}

/// The aggregate agent state the main window sends (`mascot_update`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MascotState {
    Sleep,
    Done,
    Work,
    Sweat,
    Input,
    Perm,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskbarEdge {
    Bottom,
    Top,
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Taskbar {
    pub edge: TaskbarEdge,
    pub rect: Rect,
    pub auto_hide: bool,
}

/// The monitor the mascot lives on (the primary one).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Display {
    pub work: Rect,
    /// DPI scale (1.0 = 96 DPI).
    pub scale: f64,
    pub taskbar: Option<Taskbar>,
}

/// The horizontal line the window travels on: `left` is the window's x at position 0,
/// `len` the travel distance to position 1 (never negative), `bottom` the window's bottom.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Track {
    pub left: i32,
    pub len: i32,
    pub bottom: i32,
}

pub fn clamp_scale(scale: u8) -> u8 {
    scale.clamp(MIN_SCALE, MAX_SCALE)
}

/// The window is 2H × 2H logical px with H = 16 × scale (the snail is H tall).
pub fn window_size_logical(scale: u8) -> f64 {
    32.0 * f64::from(clamp_scale(scale))
}

/// Window edge length in physical px for a mascot scale and a DPI scale.
pub fn window_size_px(scale: u8, dpi_scale: f64) -> i32 {
    (window_size_logical(scale) * sanitize_dpi(dpi_scale)).round() as i32
}

fn sanitize_dpi(dpi_scale: f64) -> f64 {
    if dpi_scale.is_finite() && dpi_scale > 0.0 {
        dpi_scale
    } else {
        1.0
    }
}

fn clamp01(v: f64) -> f64 {
    if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// Bottom edge the snail stands on in `taskbar` placement (see the module doc).
fn baseline(display: &Display) -> i32 {
    let work = display.work;
    match display.taskbar {
        Some(Taskbar { edge: TaskbarEdge::Bottom, rect, auto_hide: false })
            if rect.top > work.top && rect.left < work.right && rect.right > work.left =>
        {
            rect.top
        }
        _ => work.bottom,
    }
}

/// The walking track for a square window of `size` physical px.
pub fn track(display: &Display, size: i32) -> Track {
    let work = display.work;
    Track { left: work.left, len: (work.width() - size).max(0), bottom: baseline(display) }
}

/// The window's rectangle for `position` (0..1 along the track) and the placement.
pub fn window_rect(display: &Display, size: i32, position: f64, area: WalkArea) -> Rect {
    let (left, bottom) = match area {
        WalkArea::Taskbar => {
            let t = track(display, size);
            (t.left + (clamp01(position) * f64::from(t.len)).round() as i32, t.bottom)
        }
        WalkArea::Corner => {
            let margin = (CORNER_MARGIN * sanitize_dpi(display.scale)).round() as i32;
            let work = display.work;
            ((work.right - size - margin).max(work.left), work.bottom - margin)
        }
    };
    Rect { left, top: bottom - size, right: left + size, bottom }
}

/// Whether the snail walks: only when working (or sweating), in `taskbar` placement, with
/// animations on and not while the user drags it.
pub fn should_walk(state: MascotState, area: WalkArea, animations: bool, dragging: bool) -> bool {
    matches!(state, MascotState::Work | MascotState::Sweat) && area == WalkArea::Taskbar && animations && !dragging
}

/// Walking speed in physical px/s.
pub fn walk_speed_px(state: MascotState, speed_factor: f64, dpi_scale: f64) -> f64 {
    let factor = if speed_factor.is_finite() { speed_factor.clamp(0.0, 3.0) } else { 1.0 };
    let state_factor = if state == MascotState::Sweat { SWEAT_FACTOR } else { 1.0 };
    BASE_SPEED * factor * state_factor * sanitize_dpi(dpi_scale)
}

/// One walking step: moves `px_per_s × dt` px along a track of `track_len` px and turns
/// around at either end (the overshoot is reflected back).
pub fn walk_step(position: f64, direction: Direction, px_per_s: f64, dt: f64, track_len: i32) -> (f64, Direction) {
    let position = clamp01(position);
    if track_len <= 0 || !(px_per_s * dt).is_finite() || px_per_s * dt <= 0.0 {
        return (position, direction);
    }
    let delta = (px_per_s * dt / f64::from(track_len)).min(1.0);
    match direction {
        Direction::Right => {
            let p = position + delta;
            if p >= 1.0 {
                (2.0 - p, Direction::Left)
            } else {
                (p, Direction::Right)
            }
        }
        Direction::Left => {
            let p = position - delta;
            if p <= 0.0 {
                (-p, Direction::Right)
            } else {
                (p, Direction::Left)
            }
        }
    }
}

/// New position after a drag of `dx_css` CSS px of the mascot page (clamped to 0..1).
pub fn drag_position(position: f64, dx_css: f64, dpi_scale: f64, track_len: i32) -> f64 {
    if track_len <= 0 || !dx_css.is_finite() {
        return clamp01(position);
    }
    clamp01(position + dx_css * sanitize_dpi(dpi_scale) / f64::from(track_len))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
        Rect { left, top, right, bottom }
    }

    /// 1920×1080 at 100 %, taskbar 48 px at the bottom.
    fn bottom_taskbar() -> Display {
        Display {
            work: rect(0, 0, 1920, 1032),
            scale: 1.0,
            taskbar: Some(Taskbar { edge: TaskbarEdge::Bottom, rect: rect(0, 1032, 1920, 1080), auto_hide: false }),
        }
    }

    #[test]
    fn window_size_follows_scale_and_dpi() {
        assert_eq!(window_size_px(2, 1.0), 64);
        assert_eq!(window_size_px(3, 1.0), 96);
        assert_eq!(window_size_px(4, 1.5), 192);
        assert_eq!(window_size_px(3, 1.25), 120);
        // Out-of-range scale is clamped; a bad DPI scale falls back to 1.
        assert_eq!(window_size_px(1, 1.0), 64);
        assert_eq!(window_size_px(9, 1.0), 128);
        assert_eq!(window_size_px(2, 0.0), 64);
        assert_eq!(window_size_px(2, f64::NAN), 64);
    }

    #[test]
    fn taskbar_bottom_stands_on_the_taskbar() {
        let d = bottom_taskbar();
        assert_eq!(window_rect(&d, 64, 0.0, WalkArea::Taskbar), rect(0, 968, 64, 1032));
        assert_eq!(window_rect(&d, 64, 1.0, WalkArea::Taskbar), rect(1856, 968, 1920, 1032));
        assert_eq!(window_rect(&d, 64, 0.5, WalkArea::Taskbar), rect(928, 968, 992, 1032));
    }

    #[test]
    fn taskbar_bottom_below_another_appbar_still_uses_the_taskbar_top() {
        let mut d = bottom_taskbar();
        d.work.bottom = 1000; // another appbar docked above the taskbar
        assert_eq!(window_rect(&d, 64, 0.0, WalkArea::Taskbar).bottom, 1032);
    }

    #[test]
    fn position_is_clamped() {
        let d = bottom_taskbar();
        assert_eq!(window_rect(&d, 64, -3.0, WalkArea::Taskbar).left, 0);
        assert_eq!(window_rect(&d, 64, 7.0, WalkArea::Taskbar).left, 1856);
        assert_eq!(window_rect(&d, 64, f64::NAN, WalkArea::Taskbar).left, 0);
    }

    #[test]
    fn other_taskbar_edges_and_auto_hide_walk_along_the_work_area_bottom() {
        let left = Display {
            work: rect(48, 0, 1920, 1080),
            scale: 1.0,
            taskbar: Some(Taskbar { edge: TaskbarEdge::Left, rect: rect(0, 0, 48, 1080), auto_hide: false }),
        };
        assert_eq!(window_rect(&left, 64, 0.0, WalkArea::Taskbar), rect(48, 1016, 112, 1080));
        assert_eq!(track(&left, 64), Track { left: 48, len: 1808, bottom: 1080 });

        let top = Display {
            work: rect(0, 48, 1920, 1080),
            scale: 1.0,
            taskbar: Some(Taskbar { edge: TaskbarEdge::Top, rect: rect(0, 0, 1920, 48), auto_hide: false }),
        };
        assert_eq!(window_rect(&top, 64, 1.0, WalkArea::Taskbar), rect(1856, 1016, 1920, 1080));

        let hidden = Display {
            work: rect(0, 0, 1920, 1080),
            scale: 1.0,
            taskbar: Some(Taskbar { edge: TaskbarEdge::Bottom, rect: rect(0, 1032, 1920, 1080), auto_hide: true }),
        };
        assert_eq!(window_rect(&hidden, 64, 0.0, WalkArea::Taskbar).bottom, 1080);

        let none = Display { work: rect(0, 0, 1920, 1080), scale: 1.0, taskbar: None };
        assert_eq!(window_rect(&none, 64, 0.0, WalkArea::Taskbar).bottom, 1080);
    }

    #[test]
    fn taskbar_on_another_monitor_is_ignored() {
        let d = Display {
            work: rect(0, 0, 1920, 1032),
            scale: 1.0,
            taskbar: Some(Taskbar { edge: TaskbarEdge::Bottom, rect: rect(1920, 1032, 3840, 1080), auto_hide: false }),
        };
        assert_eq!(window_rect(&d, 64, 0.0, WalkArea::Taskbar).bottom, 1032);
    }

    #[test]
    fn negative_coordinates_work() {
        let d = Display { work: rect(-1920, -200, 0, 880), scale: 1.0, taskbar: None };
        assert_eq!(window_rect(&d, 64, 0.0, WalkArea::Taskbar), rect(-1920, 816, -1856, 880));
        assert_eq!(window_rect(&d, 64, 1.0, WalkArea::Taskbar).right, 0);
    }

    #[test]
    fn corner_is_bottom_right_with_a_margin() {
        let d = bottom_taskbar();
        assert_eq!(window_rect(&d, 64, 0.3, WalkArea::Corner), rect(1844, 956, 1908, 1020));
        let hi = Display { scale: 1.5, ..d };
        assert_eq!(window_rect(&hi, 96, 0.0, WalkArea::Corner), rect(1806, 918, 1902, 1014));
    }

    #[test]
    fn work_area_narrower_than_the_window_does_not_move() {
        let d = Display { work: rect(0, 0, 50, 100), scale: 1.0, taskbar: None };
        assert_eq!(track(&d, 64).len, 0);
        assert_eq!(window_rect(&d, 64, 1.0, WalkArea::Taskbar).left, 0);
        assert_eq!(walk_step(0.5, Direction::Right, 18.0, 1.0, 0), (0.5, Direction::Right));
        assert_eq!(drag_position(0.5, 30.0, 1.0, 0), 0.5);
    }

    #[test]
    fn walking_happens_only_when_working_on_the_taskbar_with_animations() {
        assert!(should_walk(MascotState::Work, WalkArea::Taskbar, true, false));
        assert!(should_walk(MascotState::Sweat, WalkArea::Taskbar, true, false));
        for s in [MascotState::Sleep, MascotState::Done, MascotState::Input, MascotState::Perm, MascotState::Error] {
            assert!(!should_walk(s, WalkArea::Taskbar, true, false), "{s:?}");
        }
        assert!(!should_walk(MascotState::Work, WalkArea::Corner, true, false));
        assert!(!should_walk(MascotState::Work, WalkArea::Taskbar, false, false));
        assert!(!should_walk(MascotState::Work, WalkArea::Taskbar, true, true));
    }

    #[test]
    fn walk_speed_scales_with_factor_state_and_dpi() {
        assert_eq!(walk_speed_px(MascotState::Work, 1.0, 1.0), 18.0);
        assert!((walk_speed_px(MascotState::Sweat, 1.0, 1.0) - 10.8).abs() < 1e-9);
        assert!((walk_speed_px(MascotState::Work, 1.3, 1.5) - 35.1).abs() < 1e-9);
        assert_eq!(walk_speed_px(MascotState::Work, f64::NAN, 1.0), 18.0);
        assert_eq!(walk_speed_px(MascotState::Work, -1.0, 1.0), 0.0);
        assert_eq!(walk_speed_px(MascotState::Work, 10.0, 1.0), 54.0);
    }

    #[test]
    fn walk_step_moves_along_the_track() {
        // 18 px/s for 1 s on a 180 px track = 0.1.
        let (p, d) = walk_step(0.5, Direction::Right, 18.0, 1.0, 180);
        assert!((p - 0.6).abs() < 1e-9);
        assert_eq!(d, Direction::Right);
        let (p, d) = walk_step(0.5, Direction::Left, 18.0, 1.0, 180);
        assert!((p - 0.4).abs() < 1e-9);
        assert_eq!(d, Direction::Left);
    }

    #[test]
    fn walk_step_turns_at_the_ends() {
        let (p, d) = walk_step(0.95, Direction::Right, 18.0, 1.0, 180);
        assert!((p - 0.95).abs() < 1e-9, "{p}");
        assert_eq!(d, Direction::Left);
        let (p, d) = walk_step(0.05, Direction::Left, 18.0, 1.0, 180);
        assert!((p - 0.05).abs() < 1e-9, "{p}");
        assert_eq!(d, Direction::Right);
        // A huge step stays in range.
        let (p, _) = walk_step(0.2, Direction::Right, 1e9, 1.0, 180);
        assert!((0.0..=1.0).contains(&p));
    }

    #[test]
    fn walk_step_without_movement_keeps_the_state() {
        assert_eq!(walk_step(0.3, Direction::Left, 0.0, 1.0, 180), (0.3, Direction::Left));
        assert_eq!(walk_step(0.3, Direction::Left, 18.0, 0.0, 180), (0.3, Direction::Left));
        assert_eq!(walk_step(2.0, Direction::Left, 0.0, 1.0, 180), (1.0, Direction::Left));
    }

    #[test]
    fn drag_converts_css_px_with_the_dpi_scale() {
        // 100 CSS px at 150 % = 150 physical px on a 1500 px track = 0.1.
        assert!((drag_position(0.5, 100.0, 1.5, 1500) - 0.6).abs() < 1e-9);
        assert!((drag_position(0.5, -100.0, 1.0, 1000) - 0.4).abs() < 1e-9);
        assert_eq!(drag_position(0.95, 500.0, 1.0, 1000), 1.0);
        assert_eq!(drag_position(0.05, -500.0, 1.0, 1000), 0.0);
        assert_eq!(drag_position(0.5, f64::INFINITY, 1.0, 1000), 0.5);
    }

    #[test]
    fn wire_names_are_lowercase() {
        assert_eq!(serde_json::to_string(&Direction::Left).unwrap(), "\"left\"");
        assert_eq!(serde_json::to_string(&MascotState::Sweat).unwrap(), "\"sweat\"");
        assert_eq!(serde_json::from_str::<WalkArea>("\"corner\"").unwrap(), WalkArea::Corner);
    }
}
