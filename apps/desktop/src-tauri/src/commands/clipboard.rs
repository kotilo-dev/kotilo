//! `clipboard_*` commands (Faz 2 spec §3, §5, §8.12 / D22).
//!
//! `arboard::Clipboard` is `!Send` on Windows (it wraps a raw HWND / OLE clipboard
//! handle), so it is never put into managed state — a fresh instance is opened inside
//! each command invocation, per spec §8.12.

use std::io::BufWriter;
use std::path::Path;
use std::time::Duration;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::fsguard;
use crate::workspace::WorkspaceStore;

/// Builds `screenshot-YYYYMMDD-HHMMSS.png`, or `...-2.png`, `...-3.png`, ... on
/// collision. Pure function (no I/O) so it's independently unit-testable; `exists`
/// abstracts over the real filesystem check.
pub fn unique_screenshot_name(base_timestamp: &str, exists: impl Fn(&str) -> bool) -> String {
    let first = format!("{base_timestamp}.png");
    if !exists(&first) {
        return first;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base_timestamp}-{n}.png");
        if !exists(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Maps a `Clipboard::get_image()` failure to an [`AppError`] (finding #10). Only "there
/// was nothing image-shaped on the clipboard" is `no_image`; every other `arboard::Error`
/// variant (clipboard held by another process, conversion failure, ...) is a real `io`
/// error and should say so rather than being lumped in with "no image".
fn map_get_image_error(e: arboard::Error) -> AppError {
    match e {
        arboard::Error::ContentNotAvailable => {
            AppError::no_image("there is no image on the clipboard")
        }
        other => AppError::io(other.to_string()),
    }
}

fn write_png(path: &Path, width: u32, height: u32, rgba: &[u8]) -> std::io::Result<()> {
    let file = std::fs::File::create(path)?;
    let writer = BufWriter::new(file);
    let mut encoder = png::Encoder::new(writer, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    writer
        .write_image_data(rgba)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(())
}

#[tauri::command(async)]
pub fn clipboard_save_image(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    dir_rel: String,
) -> AppResult<String> {
    let root = std::path::PathBuf::from(store.find_path(&workspace_id)?);
    let dir = fsguard::resolve(&root, &dir_rel)?;
    if !dir.is_dir() {
        return Err(AppError::not_a_directory(format!(
            "'{dir_rel}' is not a folder"
        )));
    }

    let mut clipboard = arboard::Clipboard::new().map_err(|e| AppError::io(e.to_string()))?;
    let image = clipboard.get_image().map_err(map_get_image_error)?;

    let base = chrono::Local::now()
        .format("screenshot-%Y%m%d-%H%M%S")
        .to_string();
    let filename = unique_screenshot_name(&base, |candidate| dir.join(candidate).exists());
    let target = dir.join(&filename);
    write_png(&target, image.width as u32, image.height as u32, &image.bytes)
        .map_err(|e| AppError::io(e.to_string()))?;

    Ok(if dir_rel.is_empty() {
        filename
    } else {
        format!("{dir_rel}/{filename}")
    })
}

/// Live-test finding: `clipboard_read_text`/`clipboard_write_text` returned
/// `ClipboardOccupied` ("held by another party") for minutes during a run. Investigated
/// whether *our* code could be the culprit: every clipboard command here opens a fresh
/// `arboard::Clipboard::new()` as a plain local variable and lets it drop (closing the
/// OLE clipboard handle) at the end of that same function — there is no retained
/// `Clipboard`, no background thread, and nothing else in this crate touches the
/// clipboard at all. That rules out a leak on our side; a hold lasting *minutes* is far
/// longer than any real cross-process clipboard contention (Explorer, clipboard
/// history, a sync/cloud-clipboard service, or another app momentarily opening it), so
/// this looks environmental rather than a defect here — but `ClipboardOccupied` in
/// general is a well-known transient condition on Windows, so both commands retry a
/// handful of times before giving up rather than surfacing a spurious failure for a
/// contention window that would have cleared a few hundred ms later.
const CLIPBOARD_OCCUPIED_RETRY_ATTEMPTS: u32 = 5;
const CLIPBOARD_OCCUPIED_RETRY_DELAY: Duration = Duration::from_millis(50);

fn retry_on_clipboard_occupied<T>(
    mut op: impl FnMut() -> Result<T, arboard::Error>,
) -> Result<T, arboard::Error> {
    let mut attempt = 0;
    loop {
        match op() {
            Err(arboard::Error::ClipboardOccupied) if attempt + 1 < CLIPBOARD_OCCUPIED_RETRY_ATTEMPTS => {
                attempt += 1;
                std::thread::sleep(CLIPBOARD_OCCUPIED_RETRY_DELAY);
            }
            result => return result,
        }
    }
}

#[tauri::command(async)]
pub fn clipboard_write_text(text: String) -> AppResult<()> {
    retry_on_clipboard_occupied(|| {
        let mut clipboard = arboard::Clipboard::new()?;
        clipboard.set_text(text.clone())
    })
    .map_err(|e| AppError::io(e.to_string()))
}

/// Faz 4 spec §1.4: reads plain text off the clipboard for the terminal's
/// `Ctrl+Shift+V` / right-click paste (bypassing `navigator.clipboard`'s WebView2
/// permission prompt / focus quirks). `None` — not an error — when the clipboard holds
/// no text at all.
#[tauri::command(async)]
pub fn clipboard_read_text() -> AppResult<Option<String>> {
    let result = retry_on_clipboard_occupied(|| {
        let mut clipboard = arboard::Clipboard::new()?;
        clipboard.get_text()
    });
    match result {
        Ok(text) => Ok(Some(text)),
        Err(arboard::Error::ContentNotAvailable) => Ok(None),
        Err(e) => Err(AppError::io(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn first_save_uses_plain_timestamp_name() {
        let existing: HashSet<&str> = HashSet::new();
        let name = unique_screenshot_name("screenshot-20260101-120000", |c| existing.contains(c));
        assert_eq!(name, "screenshot-20260101-120000.png");
    }

    #[test]
    fn collision_chain_increments_suffix() {
        let existing: HashSet<&str> = [
            "screenshot-20260101-120000.png",
            "screenshot-20260101-120000-2.png",
            "screenshot-20260101-120000-3.png",
        ]
        .into_iter()
        .collect();
        let name =
            unique_screenshot_name("screenshot-20260101-120000", |c| existing.contains(c));
        assert_eq!(name, "screenshot-20260101-120000-4.png");
    }

    #[test]
    fn single_collision_yields_dash_two() {
        let existing: HashSet<&str> = ["screenshot-20260101-120000.png"].into_iter().collect();
        let name =
            unique_screenshot_name("screenshot-20260101-120000", |c| existing.contains(c));
        assert_eq!(name, "screenshot-20260101-120000-2.png");
    }

    #[test]
    fn content_not_available_maps_to_no_image() {
        let err = map_get_image_error(arboard::Error::ContentNotAvailable);
        assert_eq!(err.code, crate::error::ErrorCode::NoImage);
    }

    #[test]
    fn other_clipboard_errors_map_to_io_not_no_image() {
        for e in [
            arboard::Error::ClipboardNotSupported,
            arboard::Error::ClipboardOccupied,
            arboard::Error::ConversionFailure,
        ] {
            let err = map_get_image_error(e);
            assert_eq!(err.code, crate::error::ErrorCode::Io);
        }
    }

    // ---- retry_on_clipboard_occupied ---------------------------------------------

    #[test]
    fn retry_succeeds_after_a_couple_of_transient_occupied_errors() {
        let calls = std::cell::Cell::new(0);
        let result = retry_on_clipboard_occupied(|| {
            calls.set(calls.get() + 1);
            if calls.get() < 3 {
                Err(arboard::Error::ClipboardOccupied)
            } else {
                Ok(42)
            }
        });
        assert_eq!(result.unwrap(), 42);
        assert_eq!(calls.get(), 3);
    }

    #[test]
    fn retry_gives_up_after_max_attempts() {
        let calls = std::cell::Cell::new(0);
        let result = retry_on_clipboard_occupied(|| {
            calls.set(calls.get() + 1);
            Err::<(), _>(arboard::Error::ClipboardOccupied)
        });
        assert!(matches!(result, Err(arboard::Error::ClipboardOccupied)));
        assert_eq!(calls.get(), CLIPBOARD_OCCUPIED_RETRY_ATTEMPTS);
    }

    #[test]
    fn retry_does_not_retry_non_occupied_errors() {
        let calls = std::cell::Cell::new(0);
        let result = retry_on_clipboard_occupied(|| {
            calls.set(calls.get() + 1);
            Err::<(), _>(arboard::Error::ContentNotAvailable)
        });
        assert!(matches!(result, Err(arboard::Error::ContentNotAvailable)));
        assert_eq!(calls.get(), 1, "a non-occupied error must not be retried");
    }
}
