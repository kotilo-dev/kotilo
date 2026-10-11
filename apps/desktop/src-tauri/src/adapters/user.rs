//! M3 wave 3: writing user adapter definitions (`%APPDATA%\kotilo\adapters\<id>\adapter.json`)
//! from the "Add custom agent" wizard, and the cheap "is this agent installed?" check behind
//! the launch menu. Pure apart from the file system; every function takes its directories.

use std::fmt;
use std::path::{Path, PathBuf};

use regex::Regex;

use super::{validate, AdapterDefinition, DefinitionSource, Definitions, DEFINITION_FILE_NAME};

const TMP_FILE_NAME: &str = "adapter.json.tmp";
const USAGE_VALUES: [&str; 3] = ["none", "builtIn", "protocol"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserDefinitionError {
    /// The definition breaks the v1 contract (message says where).
    Invalid(String),
    /// The id belongs to a built-in adapter.
    BuiltInId(String),
    /// A user file with this id exists and `overwrite` was not set.
    Exists(String),
    /// No user file with this id.
    NotFound(String),
    Io(String),
}

impl fmt::Display for UserDefinitionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(m) => write!(f, "{m}"),
            Self::BuiltInId(id) => write!(f, "'{id}' is a built-in adapter id"),
            Self::Exists(id) => write!(f, "a custom agent with the id '{id}' already exists"),
            Self::NotFound(id) => write!(f, "no custom agent with the id '{id}'"),
            Self::Io(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for UserDefinitionError {}

fn hex_color() -> Regex {
    Regex::new("^#[0-9a-fA-F]{6}$").expect("static regex")
}

/// Schema rules the loader's [`validate`] leaves to the hub (avatar format, rule ids,
/// duplicate rules, `usage` values). A file the wizard writes must pass the hub too.
pub fn check_schema_extras(def: &AdapterDefinition) -> Result<(), String> {
    if let Some(avatar) = &def.avatar {
        if avatar.letter.chars().count() != 1 {
            return Err("avatar.letter must be exactly one character".to_string());
        }
        for (name, value) in [("bg", &avatar.bg), ("ink", &avatar.ink)] {
            if !hex_color().is_match(value) {
                return Err(format!("avatar.{name} must be a #rrggbb color"));
            }
        }
    }
    let id_pattern = super::id_regex();
    let mut seen = std::collections::HashSet::new();
    for (i, rule) in def.screen_rules.iter().enumerate() {
        if !id_pattern.is_match(&rule.id) {
            return Err(format!("screenRules[{i}]: invalid id '{}'", rule.id));
        }
        if !seen.insert(rule.id.as_str()) {
            return Err(format!("screenRules: duplicate id '{}'", rule.id));
        }
    }
    if let Some(usage) = &def.usage {
        if !usage.as_str().is_some_and(|u| USAGE_VALUES.contains(&u)) {
            return Err(format!("usage must be one of {}", USAGE_VALUES.join(", ")));
        }
    }
    if def.detect.executables.iter().any(|e| e.trim().is_empty()) {
        return Err("detect.executables must not contain empty names".to_string());
    }
    Ok(())
}

/// Ids a user file may not take: every built-in definition (also a broken one) and every
/// folder in the built-in directory.
pub fn builtin_ids(defs: &Definitions, builtin_dir: Option<&Path>) -> Vec<String> {
    let mut ids: Vec<String> = defs
        .items
        .iter()
        .filter(|d| d.source == DefinitionSource::BuiltIn)
        .map(|d| d.def.id.clone())
        .chain(
            defs.errors
                .iter()
                .filter(|e| e.source == DefinitionSource::BuiltIn)
                .map(|e| e.id.clone()),
        )
        .chain(
            builtin_dir
                .map(super::definition_files)
                .unwrap_or_default()
                .into_iter()
                .map(|(folder, _)| folder),
        )
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// The JSON written to disk: the typed definition with `null` fields dropped (the schema
/// has no nullable fields).
fn to_file_json(def: &AdapterDefinition) -> Result<serde_json::Value, UserDefinitionError> {
    let mut value = serde_json::to_value(def).map_err(|e| UserDefinitionError::Io(e.to_string()))?;
    if let Some(map) = value.as_object_mut() {
        map.retain(|_, v| !v.is_null());
    }
    Ok(value)
}

/// Validates `def` like the loader (plus [`check_schema_extras`]) and writes it atomically to
/// `<user_dir>/<id>/adapter.json`. Refuses built-in ids, and an existing file unless
/// `overwrite`. Returns the written path.
pub fn save_user_definition(
    user_dir: &Path,
    builtin_ids: &[String],
    def: AdapterDefinition,
    overwrite: bool,
) -> Result<PathBuf, UserDefinitionError> {
    if builtin_ids.contains(&def.id) {
        return Err(UserDefinitionError::BuiltInId(def.id));
    }
    check_schema_extras(&def).map_err(UserDefinitionError::Invalid)?;
    let loaded = validate(def, DefinitionSource::User).map_err(UserDefinitionError::Invalid)?;
    let dir = user_dir.join(&loaded.def.id);
    let path = dir.join(DEFINITION_FILE_NAME);
    if path.exists() && !overwrite {
        return Err(UserDefinitionError::Exists(loaded.def.id));
    }
    let value = to_file_json(&loaded.def)?;
    crate::persistence::save_json_to(&dir, DEFINITION_FILE_NAME, TMP_FILE_NAME, &value)
        .map_err(|e| UserDefinitionError::Io(format!("cannot write {}: {e}", path.display())))?;
    Ok(path)
}

/// Deletes `<user_dir>/<id>/adapter.json` (and the folder when it is then empty).
pub fn delete_user_definition(user_dir: &Path, builtin_ids: &[String], id: &str) -> Result<(), UserDefinitionError> {
    if !super::id_regex().is_match(id) {
        return Err(UserDefinitionError::Invalid(format!("invalid id '{id}'")));
    }
    if builtin_ids.iter().any(|b| b == id) {
        return Err(UserDefinitionError::BuiltInId(id.to_string()));
    }
    let dir = user_dir.join(id);
    let path = dir.join(DEFINITION_FILE_NAME);
    if !path.is_file() {
        return Err(UserDefinitionError::NotFound(id.to_string()));
    }
    std::fs::remove_file(&path).map_err(|e| UserDefinitionError::Io(format!("cannot delete {}: {e}", path.display())))?;
    // Only an empty folder goes; anything the user put next to the file stays.
    let _ = std::fs::remove_dir(&dir);
    Ok(())
}

/// Ids of the loaded definitions with at least one `detect.executables` name as a file in
/// one of `path_dirs` (the `PATH` entries). Names are matched exactly (`claude.exe`,
/// `gemini.cmd`, `claude`), so no platform rules are needed; names with a path are skipped.
pub fn installed_ids(defs: &Definitions, path_dirs: &[PathBuf]) -> Vec<String> {
    defs.items
        .iter()
        .filter(|d| {
            d.def.detect.executables.iter().any(|exe| {
                !exe.is_empty()
                    && !exe.contains(['/', '\\'])
                    && path_dirs.iter().any(|dir| dir.join(exe).is_file())
            })
        })
        .map(|d| d.def.id.clone())
        .collect()
}

/// The `PATH` entries of this process.
pub fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::super::screen::{ScreenRule, ScreenState};
    use super::super::tests::def;
    use super::super::Detect;
    use super::*;

    fn rule(id: &str, pattern: &str) -> ScreenRule {
        ScreenRule {
            id: id.into(),
            state: ScreenState::WaitingPermission,
            pattern: pattern.into(),
            lines: Some(3),
            clear_on: None,
        }
    }

    #[test]
    fn saves_a_valid_definition_that_the_loader_reads_back() {
        let tmp = tempfile::tempdir().unwrap();
        let mut d = def("my-agent");
        d.screen_rules = vec![rule("approve", r"Allow\? \(y/n\)")];
        d.usage = Some(serde_json::json!("protocol"));
        let path = save_user_definition(tmp.path(), &[], d.clone(), false).unwrap();
        assert_eq!(path, tmp.path().join("my-agent").join("adapter.json"));
        assert!(!tmp.path().join("my-agent").join(TMP_FILE_NAME).exists());

        let text = std::fs::read_to_string(&path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        // No nulls on disk (the schema has no nullable fields).
        assert!(json.get("permissionKeys").is_none());
        assert_eq!(json["usage"], "protocol");

        let defs = Definitions::load(None, Some(tmp.path()));
        assert!(defs.errors.is_empty(), "{:?}", defs.errors);
        assert_eq!(defs.get("my-agent").unwrap().def, d);
    }

    #[test]
    fn refuses_builtin_ids_and_existing_files_unless_overwrite() {
        let tmp = tempfile::tempdir().unwrap();
        let builtin = vec!["codex".to_string()];
        assert_eq!(
            save_user_definition(tmp.path(), &builtin, def("codex"), true),
            Err(UserDefinitionError::BuiltInId("codex".into()))
        );
        save_user_definition(tmp.path(), &builtin, def("mine"), false).unwrap();
        assert_eq!(
            save_user_definition(tmp.path(), &builtin, def("mine"), false),
            Err(UserDefinitionError::Exists("mine".into()))
        );
        let mut changed = def("mine");
        changed.display_name = "Mine 2".into();
        save_user_definition(tmp.path(), &builtin, changed, true).unwrap();
        let defs = Definitions::load(None, Some(tmp.path()));
        assert_eq!(defs.get("mine").unwrap().def.display_name, "Mine 2");
    }

    #[test]
    fn rejects_what_the_hub_schema_would_reject() {
        let tmp = tempfile::tempdir().unwrap();
        let invalid = |d: AdapterDefinition| matches!(save_user_definition(tmp.path(), &[], d, false), Err(UserDefinitionError::Invalid(_)));

        let mut d = def("a");
        d.avatar.as_mut().unwrap().letter = "AB".into();
        assert!(invalid(d));
        let mut d = def("a");
        d.avatar.as_mut().unwrap().bg = "red".into();
        assert!(invalid(d));
        let mut d = def("a");
        d.screen_rules = vec![rule("x", "a"), rule("x", "b")];
        assert!(invalid(d));
        let mut d = def("a");
        d.screen_rules = vec![rule("Bad Id", "a")];
        assert!(invalid(d));
        // Lookaround / backreferences don't compile in Rust's regex.
        let mut d = def("a");
        d.screen_rules = vec![rule("x", "(?=y)")];
        assert!(invalid(d));
        let mut d = def("a");
        d.screen_rules = vec![rule("x", r"(a)\1")];
        assert!(invalid(d));
        let mut d = def("a");
        d.usage = Some(serde_json::json!("sometimes"));
        assert!(invalid(d));
        let mut d = def("a");
        d.launch = None;
        assert!(invalid(d));
        let mut d = def("Not-Valid");
        d.id = "Not-Valid".into();
        assert!(invalid(d));
        assert!(!tmp.path().join("a").exists());
    }

    #[test]
    fn deletes_only_user_files() {
        let tmp = tempfile::tempdir().unwrap();
        let builtin = vec!["codex".to_string()];
        save_user_definition(tmp.path(), &builtin, def("mine"), false).unwrap();
        assert_eq!(
            delete_user_definition(tmp.path(), &builtin, "codex"),
            Err(UserDefinitionError::BuiltInId("codex".into()))
        );
        assert_eq!(
            delete_user_definition(tmp.path(), &builtin, "../x"),
            Err(UserDefinitionError::Invalid("invalid id '../x'".into()))
        );
        delete_user_definition(tmp.path(), &builtin, "mine").unwrap();
        assert!(!tmp.path().join("mine").exists());
        assert_eq!(
            delete_user_definition(tmp.path(), &builtin, "mine"),
            Err(UserDefinitionError::NotFound("mine".into()))
        );
    }

    #[test]
    fn delete_keeps_other_files_in_the_folder() {
        let tmp = tempfile::tempdir().unwrap();
        save_user_definition(tmp.path(), &[], def("mine"), false).unwrap();
        std::fs::write(tmp.path().join("mine").join("notes.txt"), "x").unwrap();
        delete_user_definition(tmp.path(), &[], "mine").unwrap();
        assert!(tmp.path().join("mine").join("notes.txt").exists());
    }

    #[test]
    fn builtin_ids_include_broken_files_and_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::create_dir_all(dir.join("codex")).unwrap();
        std::fs::write(dir.join("codex").join(DEFINITION_FILE_NAME), serde_json::to_string(&def("codex")).unwrap()).unwrap();
        std::fs::create_dir_all(dir.join("broken")).unwrap();
        std::fs::write(dir.join("broken").join(DEFINITION_FILE_NAME), "{").unwrap();
        let defs = Definitions::load(Some(dir), None);
        assert_eq!(builtin_ids(&defs, Some(dir)), vec!["broken", "codex"]);
        assert_eq!(builtin_ids(&defs, None), vec!["broken", "codex"]);
    }

    #[test]
    fn installed_ids_match_executables_on_path() {
        let tmp = tempfile::tempdir().unwrap();
        let bin_a = tmp.path().join("a");
        let bin_b = tmp.path().join("b");
        std::fs::create_dir_all(&bin_a).unwrap();
        std::fs::create_dir_all(&bin_b).unwrap();
        std::fs::write(bin_b.join("gemini.cmd"), "").unwrap();
        std::fs::write(bin_a.join("claude"), "").unwrap();
        // A folder with an agent's name is not an executable.
        std::fs::create_dir_all(bin_a.join("codex.exe")).unwrap();

        let with_exes = |id: &str, exes: &[&str]| {
            let mut d = def(id);
            d.detect = Detect {
                executables: exes.iter().map(|s| s.to_string()).collect(),
                node_scripts: vec![],
            };
            d
        };
        let defs = Definitions::from_builtin(vec![
            with_exes("claude-code", &["claude.exe", "claude"]),
            with_exes("codex", &["codex.exe"]),
            with_exes("gemini", &["gemini.cmd", "gemini"]),
            with_exes("sneaky", &["../a/claude"]),
            with_exes("none", &[]),
        ]);
        assert_eq!(installed_ids(&defs, &[bin_a, bin_b]), vec!["claude-code", "gemini"]);
        assert!(installed_ids(&defs, &[]).is_empty());
    }
}
