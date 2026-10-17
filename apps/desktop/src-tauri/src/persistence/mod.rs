//! Single source of truth for app persistence: `%APPDATA%\kotilo\state.json`.
//!
//! The directory is injectable (see [`state_dir`] / the `*_from` functions) so unit
//! tests can point at a temp dir instead of the real `%APPDATA%`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const STATE_FILE_NAME: &str = "state.json";
const TMP_FILE_NAME: &str = "state.json.tmp";
const CORRUPT_FILE_NAME: &str = "state.json.corrupt";

/// Faz 6 §1.1: `settings.json` lives in the same directory as `state.json` but is a
/// separate file (and separate corrupt/tmp names) — user preferences must never be able
/// to corrupt, or be corrupted by, layout/workspace data.
const SETTINGS_FILE_NAME: &str = "settings.json";
const SETTINGS_TMP_FILE_NAME: &str = "settings.json.tmp";
const SETTINGS_CORRUPT_FILE_NAME: &str = "settings.json.corrupt";

/// Resolves `%APPDATA%\kotilo` (`~/.config/kotilo` on Linux, see
/// `platform::roaming_data_root`). Falls back to the current directory if the variable is
/// not set (should not happen, but keeps the function total).
pub fn state_dir() -> PathBuf {
    crate::platform::roaming_data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(crate::brand::SLUG)
}

/// Loads `dir/file_name`.
///
/// - Missing file → `{}`.
/// - Corrupt (unparsable) file → a `corrupt_name` copy of the original bytes is kept
///   next to it and `{}` is returned, so the app can still start.
///
/// Generic core shared by [`load_state_from`] and `settings::SettingsStore` (Faz 6 §1.1:
/// "mevcut load_*_from/save_*_to yardımcıları genelleştirilip yeniden kullanılır") — the
/// two callers only differ in which file names they pass.
fn load_json_from(dir: &Path, file_name: &str, corrupt_name: &str) -> serde_json::Value {
    let path = dir.join(file_name);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return serde_json::json!({}),
    };

    match serde_json::from_slice::<serde_json::Value>(&bytes) {
        Ok(value) => value,
        Err(_) => {
            let corrupt_path = dir.join(corrupt_name);
            // Best-effort: preserve the corrupt file for later inspection. If we can't
            // even write the copy, we still must not fail startup.
            let _ = fs::write(&corrupt_path, &bytes);
            // Faz 7 §9.1 acceptance: a corrupt state/settings file must leave a trace in
            // the log — path only, never the file's (possibly garbled, possibly
            // sensitive) content.
            log::warn!("{} did not parse as JSON; kept as {}", path.display(), corrupt_path.display());
            serde_json::json!({})
        }
    }
}

/// Atomically writes `value` to `dir/file_name`: write to `dir/tmp_name`, then rename
/// over the final path (`fs::rename` on Windows uses `MoveFileExW` with
/// `MOVEFILE_REPLACE_EXISTING`, so this is an atomic replace, not a two-step
/// delete+create that could race or crash mid-write). Generic core — see
/// [`load_json_from`].
pub(crate) fn save_json_to(dir: &Path, file_name: &str, tmp_name: &str, value: &serde_json::Value) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let tmp_path = dir.join(tmp_name);
    let final_path = dir.join(file_name);

    let data = serde_json::to_vec_pretty(value)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(&tmp_path, data)?;
    fs::rename(&tmp_path, &final_path)?;
    Ok(())
}

/// Loads `state.json` from `dir` (see [`load_json_from`]).
pub fn load_state_from(dir: &Path) -> serde_json::Value {
    load_json_from(dir, STATE_FILE_NAME, CORRUPT_FILE_NAME)
}

/// Atomically writes `state` to `dir/state.json` (see [`save_json_to`]).
pub fn save_state_to(dir: &Path, state: &serde_json::Value) -> io::Result<()> {
    save_json_to(dir, STATE_FILE_NAME, TMP_FILE_NAME, state)
}

/// Loads state from the real `%APPDATA%\kotilo\state.json`.
pub fn load_state() -> serde_json::Value {
    load_state_from(&state_dir())
}

/// Saves state to the real `%APPDATA%\kotilo\state.json`.
pub fn save_state(state: &serde_json::Value) -> io::Result<()> {
    save_state_to(&state_dir(), state)
}

/// Faz 6 §1.1: loads `settings.json` from `dir` — same missing/corrupt handling as
/// [`load_state_from`], its own file/corrupt names.
pub fn load_settings_json_from(dir: &Path) -> serde_json::Value {
    load_json_from(dir, SETTINGS_FILE_NAME, SETTINGS_CORRUPT_FILE_NAME)
}

/// Faz 6 §1.1: atomically writes `value` to `dir/settings.json`.
pub fn save_settings_json_to(dir: &Path, value: &serde_json::Value) -> io::Result<()> {
    save_json_to(dir, SETTINGS_FILE_NAME, SETTINGS_TMP_FILE_NAME, value)
}

/// Process-lifetime, single-writer view of `state.json` (Tauri managed state).
///
/// Faz 1 had a single writer (`layoutStore`) round-tripping the whole file, which is
/// why it could write its own stale copy over another writer's slice. Faz 2 adds a
/// second writer (the Rust workspace store), so the file's in-memory shape is now a
/// top-level JSON object of independently-owned "slices" (`"layout"`, `"workspaces"`,
/// ...): [`StateStore::set_slice`] only ever replaces `obj[key]` — no deep merge — so a
/// writer that owns one slice can never clobber another's.
pub struct StateStore {
    value: Mutex<serde_json::Value>,
    dir: PathBuf,
}

impl StateStore {
    /// Loads `dir/state.json` once (see [`load_state_from`]) and holds it in memory for
    /// the rest of the process's life.
    pub fn load_from(dir: PathBuf) -> Self {
        let value = load_state_from(&dir);
        Self {
            value: Mutex::new(value),
            dir,
        }
    }

    /// Loads from the real `%APPDATA%\kotilo\state.json`.
    pub fn load() -> Self {
        Self::load_from(state_dir())
    }

    /// Returns a clone of the whole in-memory state (used by the `load_state` command).
    pub fn snapshot(&self) -> serde_json::Value {
        self.lock().clone()
    }

    /// Returns a clone of one top-level slice, if present.
    pub fn get_slice(&self, key: &str) -> Option<serde_json::Value> {
        self.lock().get(key).cloned()
    }

    /// Replaces `obj[key]` with `value` (no deep merge — the caller always sends the
    /// slice's full contents) and persists the whole object atomically to disk.
    ///
    /// The lock is held across the disk write itself (finding #7): releasing it right
    /// after updating the in-memory value let two concurrent writers interleave their
    /// `save_state_to` calls in either order, so whichever one's write actually landed
    /// last on disk could be the *older* in-memory snapshot — and both were writing to
    /// the same `state.json.tmp`. Holding the guard serializes writers so lock order and
    /// on-disk write order always match.
    pub fn set_slice(&self, key: &str, value: serde_json::Value) -> io::Result<()> {
        let mut guard = self.lock();
        if !guard.is_object() {
            *guard = serde_json::json!({});
        }
        guard
            .as_object_mut()
            .expect("just ensured this is an object")
            .insert(key.to_string(), value);
        save_state_to(&self.dir, &guard)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, serde_json::Value> {
        self.value.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_state() {
        let dir = tempfile::tempdir().unwrap();
        let state = json!({ "hello": "world", "n": 42 });

        save_state_to(dir.path(), &state).unwrap();
        let loaded = load_state_from(dir.path());

        assert_eq!(loaded, state);
    }

    #[test]
    fn missing_file_returns_empty_object() {
        let dir = tempfile::tempdir().unwrap();
        // No state.json written.
        let loaded = load_state_from(dir.path());
        assert_eq!(loaded, json!({}));
    }

    #[test]
    fn corrupt_file_returns_empty_object_and_keeps_corrupt_copy() {
        let dir = tempfile::tempdir().unwrap();
        let state_path = dir.path().join(STATE_FILE_NAME);
        fs::write(&state_path, b"{ this is not valid json ").unwrap();

        let loaded = load_state_from(dir.path());
        assert_eq!(loaded, json!({}));

        let corrupt_path = dir.path().join(CORRUPT_FILE_NAME);
        assert!(corrupt_path.exists(), ".corrupt copy should be kept");
        let corrupt_contents = fs::read(&corrupt_path).unwrap();
        assert_eq!(corrupt_contents, b"{ this is not valid json ");
    }

    #[test]
    fn save_creates_directory_if_missing() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested").join("agent-hub");
        assert!(!nested.exists());

        save_state_to(&nested, &json!({ "a": 1 })).unwrap();
        assert!(nested.join(STATE_FILE_NAME).exists());
    }

    #[test]
    fn state_store_two_slices_both_persist_independently() {
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::load_from(dir.path().to_path_buf());

        store
            .set_slice("layout", json!({ "columns": [1, 2, 3] }))
            .unwrap();
        store
            .set_slice("workspaces", json!({ "workspaces": [], "activeId": null }))
            .unwrap();

        // In-memory view has both slices...
        let snapshot = store.snapshot();
        assert_eq!(snapshot["layout"], json!({ "columns": [1, 2, 3] }));
        assert_eq!(
            snapshot["workspaces"],
            json!({ "workspaces": [], "activeId": null })
        );

        // ...and so does what actually landed on disk.
        let on_disk = load_state_from(dir.path());
        assert_eq!(on_disk["layout"], json!({ "columns": [1, 2, 3] }));
        assert_eq!(
            on_disk["workspaces"],
            json!({ "workspaces": [], "activeId": null })
        );
    }

    #[test]
    fn state_store_set_slice_replaces_without_deep_merge() {
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::load_from(dir.path().to_path_buf());

        store.set_slice("layout", json!({ "a": 1, "b": 2 })).unwrap();
        store.set_slice("layout", json!({ "a": 99 })).unwrap();

        assert_eq!(store.get_slice("layout"), Some(json!({ "a": 99 })));
    }

    #[test]
    fn concurrent_set_slice_calls_leave_disk_matching_memory() {
        // Finding #7 regression: before the fix, the mutex was released before the disk
        // write, so two threads' `save_state_to` calls could land in either order —
        // whichever write actually finished last on disk could belong to the *earlier*
        // in-memory update. With the lock held across the write, lock-acquisition order
        // and on-disk write order are the same, so after every thread has finished,
        // whatever is in memory must be what's on disk.
        use std::sync::Arc;
        use std::thread;

        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(StateStore::load_from(dir.path().to_path_buf()));

        let handles: Vec<_> = (0..8)
            .map(|i| {
                let store = Arc::clone(&store);
                thread::spawn(move || {
                    for n in 0..25 {
                        store
                            .set_slice("counter", json!({ "thread": i, "n": n }))
                            .unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let in_memory = store.snapshot();
        let on_disk = load_state_from(dir.path());
        assert_eq!(on_disk, in_memory);
    }

    #[test]
    fn save_overwrites_existing_state_atomically() {
        let dir = tempfile::tempdir().unwrap();
        save_state_to(dir.path(), &json!({ "v": 1 })).unwrap();
        save_state_to(dir.path(), &json!({ "v": 2 })).unwrap();

        let loaded = load_state_from(dir.path());
        assert_eq!(loaded, json!({ "v": 2 }));
        // The tmp file must not linger after a successful save.
        assert!(!dir.path().join(TMP_FILE_NAME).exists());
    }
}
