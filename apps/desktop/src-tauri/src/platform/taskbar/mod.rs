//! D-056: a count on the main window's taskbar button (unseen finished work + agents that
//! wait). The badge is drawn here as a small RGBA image – a round disc in the tone's colour
//! with white digits from a built-in 3×5 bitmap font (no font files) – and handed to the
//! taskbar as an overlay icon with an accessible description. Windows only (`win.rs`);
//! elsewhere it is a no-op.

#[cfg(windows)]
mod win;

use serde::Deserialize;

pub const SIZE: u32 = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    /// Something waits for the user (permission, input, error).
    Attention,
    /// Only finished work nobody has looked at yet.
    Done,
}

impl Tone {
    fn rgb(self) -> [u8; 3] {
        match self {
            // Darker than the `--status-blocked` / `--status-done` tokens so white digits
            // stay readable at 16 px.
            Tone::Attention => [0xd9, 0x48, 0x2b],
            Tone::Done => [0x25, 0x6f, 0xd6],
        }
    }
}

#[cfg(windows)]
mod os {
    pub use super::win::set_overlay;
}

#[cfg(not(windows))]
mod os {
    pub fn set_overlay(_hwnd: isize, _icon: Option<(&[u8], &str)>) -> Result<(), String> {
        Ok(())
    }
}

/// The text drawn on the badge: `1`…`9`, `9+`; `None` for 0 (no badge).
pub fn label(count: u32) -> Option<&'static str> {
    const DIGITS: [&str; 9] = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
    match count {
        0 => None,
        1..=9 => Some(DIGITS[count as usize - 1]),
        _ => Some("9+"),
    }
}

/// Default (English) screen-reader text, used when the UI sends none.
pub fn default_description(count: u32, tone: Tone) -> String {
    match tone {
        Tone::Attention => format!("{count} need attention"),
        Tone::Done => format!("{count} finished"),
    }
}

/// 3×5 glyphs, one row per byte, bit 2 = left column.
fn glyph(c: char) -> [u8; 5] {
    match c {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b011, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b010, 0b010, 0b010],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '+' => [0b000, 0b010, 0b111, 0b010, 0b000],
        _ => [0; 5],
    }
}

/// The badge as `SIZE`×`SIZE` straight-alpha RGBA: an anti-aliased disc with a thin dark
/// rim (visible on light and dark taskbars) and the label in white, centred.
pub fn draw(text: &str, tone: Tone) -> Vec<u8> {
    let size = SIZE as usize;
    let mut rgba = vec![0u8; size * size * 4];
    let center = SIZE as f32 / 2.0;
    let radius = center - 0.5;
    let [r, g, b] = tone.rgb();
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 + 0.5 - center;
            let dy = y as f32 + 0.5 - center;
            let dist = (dx * dx + dy * dy).sqrt();
            let coverage = (radius - dist + 0.5).clamp(0.0, 1.0);
            if coverage <= 0.0 {
                continue;
            }
            // Outer 1.5 px: a darker rim of the same hue.
            let rim = (dist - (radius - 1.5)).clamp(0.0, 1.0);
            let shade = |c: u8| (f32::from(c) * (1.0 - 0.45 * rim)) as u8;
            let i = (y * size + x) * 4;
            rgba[i..i + 4].copy_from_slice(&[shade(r), shade(g), shade(b), (coverage * 255.0) as u8]);
        }
    }

    // One glyph: scale 4 (12×20 px); two glyphs ("9+"): scale 3 with a 1-cell gap (21×15 px).
    let glyphs: Vec<[u8; 5]> = text.chars().map(glyph).collect();
    let n = glyphs.len();
    if n == 0 {
        return rgba;
    }
    let scale = if n == 1 { 4 } else { 3 };
    let cells_w = n * 3 + (n - 1);
    let left = (size - cells_w * scale) / 2;
    let top = (size - 5 * scale) / 2;
    for (gi, rows) in glyphs.iter().enumerate() {
        for (row, bits) in rows.iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) == 0 {
                    continue;
                }
                let x0 = left + (gi * 4 + col) * scale;
                let y0 = top + row * scale;
                for y in y0..y0 + scale {
                    for x in x0..x0 + scale {
                        let i = (y * size + x) * 4;
                        rgba[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
                    }
                }
            }
        }
    }
    rgba
}

/// Shows `count` on the window's taskbar button (0 clears it). Runs on the UI thread, where
/// the window's COM apartment lives.
pub fn set_badge(window: &tauri::WebviewWindow, count: u32, tone: Tone, description: Option<String>) -> tauri::Result<()> {
    let Some(hwnd) = handle(window) else { return Ok(()) };
    let badge = label(count).map(|text| {
        let description = description.filter(|d| !d.trim().is_empty()).unwrap_or_else(|| default_description(count, tone));
        (draw(text, tone), description)
    });
    window.run_on_main_thread(move || {
        let icon = badge.as_ref().map(|(rgba, description)| (rgba.as_slice(), description.as_str()));
        if let Err(err) = os::set_overlay(hwnd, icon) {
            log::warn!("taskbar: overlay icon not set: {err}");
        }
    })
}

#[cfg(windows)]
fn handle(window: &tauri::WebviewWindow) -> Option<isize> {
    window.hwnd().ok().map(|h| h.0 as isize)
}

#[cfg(not(windows))]
fn handle(_window: &tauri::WebviewWindow) -> Option<isize> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(rgba: &[u8], x: usize, y: usize) -> [u8; 4] {
        let i = (y * SIZE as usize + x) * 4;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    }

    fn white_pixels(rgba: &[u8]) -> usize {
        rgba.chunks(4).filter(|p| p == &[255, 255, 255, 255]).count()
    }

    #[test]
    fn labels() {
        assert_eq!(label(0), None);
        assert_eq!(label(1), Some("1"));
        assert_eq!(label(9), Some("9"));
        assert_eq!(label(10), Some("9+"));
        assert_eq!(label(u32::MAX), Some("9+"));
    }

    #[test]
    fn descriptions() {
        assert_eq!(default_description(3, Tone::Attention), "3 need attention");
        assert_eq!(default_description(12, Tone::Done), "12 finished");
    }

    #[test]
    fn tone_deserializes_lowercase() {
        assert_eq!(serde_json::from_str::<Tone>("\"attention\"").unwrap(), Tone::Attention);
        assert_eq!(serde_json::from_str::<Tone>("\"done\"").unwrap(), Tone::Done);
        assert!(serde_json::from_str::<Tone>("\"other\"").is_err());
    }

    #[test]
    fn disc_is_round_and_tinted_by_tone() {
        let rgba = draw("", Tone::Done);
        assert_eq!(rgba.len(), (SIZE * SIZE * 4) as usize);
        assert_eq!(pixel(&rgba, 0, 0)[3], 0, "corners are transparent");
        assert_eq!(pixel(&rgba, 31, 31)[3], 0);
        assert_eq!(pixel(&rgba, 16, 4), [0x25, 0x6f, 0xd6, 255]);
        let attention = draw("", Tone::Attention);
        assert_eq!(pixel(&attention, 16, 4), [0xd9, 0x48, 0x2b, 255]);
        let edge = pixel(&rgba, 16, 0)[3];
        assert!(edge > 0 && edge < 255, "the edge is anti-aliased: {edge}");
    }

    #[test]
    fn digits_are_drawn_in_white_and_centred() {
        // "1": 1+2+1+1+3 = 8 cells of 4×4 px.
        let one = draw("1", Tone::Attention);
        assert_eq!(white_pixels(&one), 8 * 16);
        // "8": 3+2+3+2+3 = 13 cells.
        assert_eq!(white_pixels(&draw("8", Tone::Done)), 13 * 16);
        // Centre cell of "8"'s top row is white, its middle hole is not.
        assert_eq!(pixel(&draw("8", Tone::Done), 16, 7), [255, 255, 255, 255]);
        assert_ne!(pixel(&draw("8", Tone::Done), 16, 11), [255, 255, 255, 255]);
    }

    #[test]
    fn nine_plus_fits_inside_the_disc() {
        let rgba = draw("9+", Tone::Attention);
        // "9" has 12 cells, "+" 5, at 3×3 px.
        assert_eq!(white_pixels(&rgba), 17 * 9);
        for y in 0..SIZE as usize {
            for x in 0..SIZE as usize {
                let p = pixel(&rgba, x, y);
                if p == [255, 255, 255, 255] {
                    let (dx, dy) = (x as f32 + 0.5 - 16.0, y as f32 + 0.5 - 16.0);
                    assert!((dx * dx + dy * dy).sqrt() < 14.0, "white pixel outside the disc at {x},{y}");
                }
            }
        }
    }

    #[test]
    fn every_label_draws() {
        for count in 1..=12 {
            let text = label(count).unwrap();
            assert!(white_pixels(&draw(text, Tone::Done)) > 0, "{text}");
        }
    }
}
