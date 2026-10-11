//! M7 assistant popup: where it opens (pure, tested on every OS). Physical pixels in
//! virtual-screen coordinates, like the mascot geometry whose [`Rect`] it reuses.

pub use crate::platform::mascot::geometry::Rect;

/// Bottom-right of `work` (the work area of the monitor under the cursor), `margin` logical
/// px from its edges, `size` logical px scaled by the monitor's DPI. A popup larger than the
/// work area shrinks to fit; it never leaves the work area.
pub fn popup_rect(work: Rect, dpi_scale: f64, size: (f64, f64), margin: f64) -> Rect {
    let scale = if dpi_scale.is_finite() && dpi_scale > 0.0 { dpi_scale } else { 1.0 };
    let px = |v: f64| (v * scale).round() as i32;
    let width = px(size.0).clamp(0, work.width().max(0));
    let height = px(size.1).clamp(0, work.height().max(0));
    let m = px(margin);
    let left = (work.right - width - m).max(work.left);
    let top = (work.bottom - height - m).max(work.top);
    Rect { left, top, right: left + width, bottom: top + height }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZE: (f64, f64) = (400.0, 580.0);

    #[test]
    fn bottom_right_with_margin_at_100_percent() {
        let work = Rect { left: 0, top: 0, right: 1920, bottom: 1032 };
        assert_eq!(popup_rect(work, 1.0, SIZE, 12.0), Rect { left: 1508, top: 440, right: 1908, bottom: 1020 });
    }

    #[test]
    fn scales_with_dpi_on_a_secondary_monitor() {
        // A 150 % monitor left of the primary one (negative coordinates).
        let work = Rect { left: -2560, top: 0, right: 0, bottom: 1380 };
        let r = popup_rect(work, 1.5, SIZE, 12.0);
        assert_eq!((r.width(), r.height()), (600, 870));
        assert_eq!((r.right, r.bottom), (-18, 1362));
    }

    #[test]
    fn a_small_work_area_clamps_on_screen() {
        let work = Rect { left: 100, top: 50, right: 500, bottom: 550 };
        let r = popup_rect(work, 1.0, SIZE, 12.0);
        assert_eq!(r, Rect { left: 100, top: 50, right: 500, bottom: 550 });
        let r = popup_rect(work, f64::NAN, (100.0, 100.0), 12.0);
        assert_eq!(r, Rect { left: 388, top: 438, right: 488, bottom: 538 });
    }
}
