//! Product identity (`brand.json` at the repo root, generated into `agenthub_proto::brand`)
//! and the one-time move of a legacy-named data folder after a rename.
//!
//! Ownership: the desktop app moves its roaming folder (`%APPDATA%\<slug>`: state,
//! settings, user adapters) and its `logs`/`diagnostics` under `%LOCALAPPDATA%\<slug>`,
//! before the logger attaches and before the hub is started. The hub moves its own
//! `%LOCALAPPDATA%\<slug>\hub` (`Hub.Infrastructure.LegacyData`), so neither process
//! touches a folder the other one may hold open.

use std::path::{Path, PathBuf};

pub use agenthub_proto::brand::*;

/// Result of [`migrate_dir`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Migration {
    /// The brand's folder exists already, or there is no legacy folder.
    NotNeeded,
    Moved { from: PathBuf, to: PathBuf },
    Failed { from: PathBuf, to: PathBuf, error: String },
}

/// Moves `<root>/<legacy slug>/<rel>` to `<root>/<slug>/<rel>` when the brand's folder is
/// missing and a legacy one exists (the first in `legacy_slugs` order wins). An empty
/// `rel` moves the whole folder. Never merges and never overwrites: an existing target
/// means the migration already happened (or the user started fresh).
pub fn migrate_dir(root: &Path, slug: &str, legacy_slugs: &[&str], rel: &[&str]) -> Migration {
    let under = |name: &str| rel.iter().fold(root.join(name), |p, part| p.join(part));
    let to = under(slug);
    if to.exists() {
        return Migration::NotNeeded;
    }
    let Some(from) = legacy_slugs.iter().filter(|l| **l != slug).map(|l| under(l)).find(|p| p.is_dir()) else {
        return Migration::NotNeeded;
    };
    let result = to
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|_| std::fs::rename(&from, &to));
    match result {
        Ok(()) => Migration::Moved { from, to },
        Err(e) => Migration::Failed { from, to, error: e.to_string() },
    }
}

/// Moves the desktop app's legacy folders (see the module doc). A no-op while
/// `brand.json` lists no legacy slugs. Returns only the migrations that did something, for
/// logging once the logger is attached.
pub fn migrate_legacy_data() -> Vec<Migration> {
    if LEGACY_SLUGS.is_empty() {
        return Vec::new();
    }
    let mut done = Vec::new();
    if let Some(roaming) = std::env::var_os("APPDATA").map(PathBuf::from) {
        done.push(migrate_dir(&roaming, SLUG, LEGACY_SLUGS, &[]));
    }
    let local = crate::logging::local_app_data_dir();
    for rel in ["logs", "diagnostics"] {
        done.push(migrate_dir(&local, SLUG, LEGACY_SLUGS, &[rel]));
    }
    done.retain(|m| *m != Migration::NotNeeded);
    done
}

/// Logs what [`migrate_legacy_data`] did.
pub fn log_migrations(migrations: &[Migration]) {
    for m in migrations {
        match m {
            Migration::Moved { from, to } => log::info!("brand: moved {} -> {}", from.display(), to.display()),
            Migration::Failed { from, to, error } => {
                log::warn!("brand: could not move {} -> {}: {error}", from.display(), to.display())
            }
            Migration::NotNeeded => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn moves_the_whole_legacy_folder_when_the_new_one_is_missing() {
        let root = tempfile::tempdir().unwrap();
        write(&root.path().join("old-name").join("state.json"), "{}");

        let m = migrate_dir(root.path(), "new-name", &["old-name"], &[]);

        assert!(matches!(m, Migration::Moved { .. }));
        assert_eq!(std::fs::read_to_string(root.path().join("new-name").join("state.json")).unwrap(), "{}");
        assert!(!root.path().join("old-name").exists());
    }

    #[test]
    fn moves_a_subfolder_and_leaves_the_rest_of_the_legacy_folder() {
        let root = tempfile::tempdir().unwrap();
        write(&root.path().join("old-name").join("logs").join("a.log"), "x");
        write(&root.path().join("old-name").join("hub").join("hub.db"), "db");

        let m = migrate_dir(root.path(), "new-name", &["old-name"], &["logs"]);

        assert!(matches!(m, Migration::Moved { .. }));
        assert!(root.path().join("new-name").join("logs").join("a.log").is_file());
        // The hub's folder is the hub's to move.
        assert!(root.path().join("old-name").join("hub").join("hub.db").is_file());
    }

    #[test]
    fn never_overwrites_an_existing_brand_folder() {
        let root = tempfile::tempdir().unwrap();
        write(&root.path().join("old-name").join("state.json"), "old");
        write(&root.path().join("new-name").join("state.json"), "new");

        assert_eq!(migrate_dir(root.path(), "new-name", &["old-name"], &[]), Migration::NotNeeded);
        assert_eq!(std::fs::read_to_string(root.path().join("new-name").join("state.json")).unwrap(), "new");
        assert!(root.path().join("old-name").join("state.json").is_file());
    }

    #[test]
    fn first_existing_legacy_slug_wins_and_no_legacy_is_a_no_op() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(migrate_dir(root.path(), "new-name", &[], &[]), Migration::NotNeeded);
        assert_eq!(migrate_dir(root.path(), "new-name", &["missing"], &[]), Migration::NotNeeded);

        write(&root.path().join("older").join("f"), "older");
        write(&root.path().join("old").join("f"), "old");
        migrate_dir(root.path(), "new-name", &["missing", "old", "older"], &[]);
        assert_eq!(std::fs::read_to_string(root.path().join("new-name").join("f")).unwrap(), "old");
    }

    #[test]
    fn generated_brand_values_are_consistent() {
        assert_eq!(HOOK_MARKER, format!("{EXE_PREFIX}-hook"));
        assert_eq!(HUB_EXE_STEM, format!("{EXE_PREFIX}-hub"));
        assert!(!NAME.is_empty() && !SLUG.is_empty() && !IDENTIFIER.is_empty());
        assert!(!LEGACY_SLUGS.contains(&SLUG), "a legacy slug must differ from the current one");
    }
}
