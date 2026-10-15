//! M3: agent adapter definitions (`adapter.json`, schema `schema/adapter.v1.json`) — the
//! one source of truth for detection, graceful close, permission keys and screen rules.
//!
//! Built-in definitions ship as Tauri resources (`<resources>/adapters/<id>/adapter.json`;
//! debug builds fall back to the repo's `adapters/`), user definitions live in
//! `%APPDATA%\kotilo\adapters\<id>\adapter.json`. A built-in id wins over a user file
//! with the same id; an invalid file is reported in `errors`, never fatal. Unknown fields
//! are ignored so newer files still load.

pub mod keys;
pub mod screen;
pub mod user;

use std::path::{Path, PathBuf};
use std::time::Duration;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::agents::AgentKind;
use screen::{CompiledRule, ScreenRule};

pub const DEFINITION_FILE_NAME: &str = "adapter.json";
/// The id whose graceful close falls back to the Faz 8 Claude sequence when its
/// definition has none.
pub const CLAUDE_CODE_ID: &str = "claude-code";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Avatar {
    pub letter: String,
    pub bg: String,
    pub ink: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detect {
    #[serde(default)]
    pub executables: Vec<String>,
    #[serde(default)]
    pub node_scripts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Launch {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseStepDef {
    pub keys: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionKeys {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_once: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub always_allow: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deny: Option<String>,
}

/// One `adapter.json`. Every field defaults so a partial file reaches [`validate`] (which
/// reports what is missing) instead of failing as opaque JSON.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterDefinition {
    #[serde(default)]
    pub v: u32,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub avatar: Option<Avatar>,
    #[serde(default)]
    pub detect: Detect,
    #[serde(default)]
    pub launch: Option<Launch>,
    #[serde(default)]
    pub graceful_close: Vec<CloseStepDef>,
    #[serde(default)]
    pub permission_keys: Option<PermissionKeys>,
    /// `{shell, events[]}` — informational for the desktop (the hub installs hooks).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hooks: Option<serde_json::Value>,
    /// `"none" | "builtIn" | "protocol"` — read by the hub.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<serde_json::Value>,
    #[serde(default)]
    pub screen_rules: Vec<ScreenRule>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DefinitionSource {
    BuiltIn,
    User,
}

/// A parsed graceful-close step: write `bytes` `repeat` times `gap` apart, then wait up to
/// `wait` for the agent to exit before the next step (or the hard kill).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseStep {
    pub bytes: Vec<u8>,
    pub repeat: u32,
    pub gap: Duration,
    pub wait: Duration,
}

const DEFAULT_CLOSE_GAP_MS: u64 = 400;
const DEFAULT_CLOSE_WAIT_MS: u64 = 1000;

/// Faz 8: Ctrl+C three times 400 ms apart, then up to 3 s for Claude Code to exit — used
/// for `claude-code` when its definition has no `gracefulClose`.
pub fn claude_default_close() -> Vec<CloseStep> {
    vec![CloseStep {
        bytes: vec![0x03],
        repeat: 3,
        gap: Duration::from_millis(400),
        wait: Duration::from_millis(3000),
    }]
}

/// A valid definition with its parsed close sequence and compiled screen rules.
#[derive(Debug, Clone)]
pub struct LoadedDefinition {
    pub def: AdapterDefinition,
    pub source: DefinitionSource,
    pub rules: Vec<CompiledRule>,
    pub close: Vec<CloseStep>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionError {
    /// The id from the file (or its folder name when the file has none).
    pub id: String,
    pub path: String,
    pub source: DefinitionSource,
    pub message: String,
}

/// Every loaded definition (built-in first, then user, each sorted by folder name).
#[derive(Debug, Clone, Default)]
pub struct Definitions {
    pub items: Vec<LoadedDefinition>,
    pub errors: Vec<DefinitionError>,
}

/// `agents_definitions` wire shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionView {
    #[serde(flatten)]
    pub def: AdapterDefinition,
    pub source: DefinitionSource,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionsView {
    pub definitions: Vec<DefinitionView>,
    pub errors: Vec<DefinitionError>,
}

fn id_regex() -> Regex {
    // Same pattern as schema/adapter.v1.json.
    Regex::new("^[a-z0-9][a-z0-9-]*$").expect("static regex")
}

/// Checks one definition against the v1 contract and parses what the desktop executes.
pub fn validate(def: AdapterDefinition, source: DefinitionSource) -> Result<LoadedDefinition, String> {
    if def.v != 1 {
        return Err(format!("unsupported version v={} (expected 1)", def.v));
    }
    if !id_regex().is_match(&def.id) {
        return Err(format!("invalid id '{}' (lowercase letters, digits and '-')", def.id));
    }
    if def.display_name.trim().is_empty() {
        return Err("displayName is missing".to_string());
    }
    if def.avatar.is_none() {
        return Err("avatar is missing".to_string());
    }
    match &def.launch {
        Some(l) if !l.command.trim().is_empty() => {}
        _ => return Err("launch.command is missing".to_string()),
    }
    let mut close = Vec::with_capacity(def.graceful_close.len());
    for (i, step) in def.graceful_close.iter().enumerate() {
        let bytes = keys::parse_keys(&step.keys).map_err(|e| format!("gracefulClose[{i}].keys: {e}"))?;
        let repeat = step.repeat.unwrap_or(1);
        if repeat == 0 {
            return Err(format!("gracefulClose[{i}].repeat must be at least 1"));
        }
        close.push(CloseStep {
            bytes,
            repeat,
            gap: Duration::from_millis(step.gap_ms.unwrap_or(DEFAULT_CLOSE_GAP_MS)),
            wait: Duration::from_millis(step.wait_ms.unwrap_or(DEFAULT_CLOSE_WAIT_MS)),
        });
    }
    if let Some(pk) = &def.permission_keys {
        for (name, value) in [("allowOnce", &pk.allow_once), ("alwaysAllow", &pk.always_allow), ("deny", &pk.deny)] {
            if let Some(v) = value {
                keys::parse_keys(v).map_err(|e| format!("permissionKeys.{name}: {e}"))?;
            }
        }
    }
    let rules = screen::compile_rules(&def.screen_rules)?;
    Ok(LoadedDefinition { def, source, rules, close })
}

/// Parses `adapter.json` text (a UTF-8 BOM is tolerated).
pub fn parse(text: &str) -> Result<AdapterDefinition, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    serde_json::from_str(text).map_err(|e| format!("invalid JSON: {e}"))
}

/// `<dir>/<folder>/adapter.json` for every sub-folder that has one, sorted by folder name.
fn definition_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(String, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let file = e.path().join(DEFINITION_FILE_NAME);
            file.is_file()
                .then(|| (e.file_name().to_string_lossy().into_owned(), file))
        })
        .collect();
    files.sort();
    files
}

impl Definitions {
    /// Loads built-in then user definitions. Either directory may be missing.
    pub fn load(builtin_dir: Option<&Path>, user_dir: Option<&Path>) -> Self {
        let mut out = Definitions::default();
        for (dir, source) in [(builtin_dir, DefinitionSource::BuiltIn), (user_dir, DefinitionSource::User)] {
            let Some(dir) = dir else { continue };
            for (folder, file) in definition_files(dir) {
                let result = std::fs::read_to_string(&file)
                    .map_err(|e| format!("cannot read: {e}"))
                    .and_then(|text| parse(&text));
                let id = result
                    .as_ref()
                    .ok()
                    .map(|d| d.id.clone())
                    .filter(|id| !id.is_empty())
                    .unwrap_or_else(|| folder.clone());
                let checked = result.and_then(|def| {
                    if def.id != folder {
                        return Err(format!("id '{}' does not match its folder name '{folder}'", def.id));
                    }
                    if out.get(&def.id).is_some() {
                        return Err(format!("id '{}' is already used by a built-in adapter", def.id));
                    }
                    validate(def, source)
                });
                match checked {
                    Ok(loaded) => out.items.push(loaded),
                    Err(message) => {
                        log::warn!("adapters: {:?} definition '{id}' rejected: {message}", source);
                        out.errors.push(DefinitionError {
                            id,
                            path: file.to_string_lossy().into_owned(),
                            source,
                            message,
                        });
                    }
                }
            }
        }
        out
    }

    /// In-memory built-in definitions (tests). Panics on an invalid one.
    pub fn from_builtin(defs: Vec<AdapterDefinition>) -> Self {
        Self {
            items: defs
                .into_iter()
                .map(|d| validate(d, DefinitionSource::BuiltIn).expect("valid test definition"))
                .collect(),
            errors: Vec::new(),
        }
    }

    pub fn get(&self, id: &str) -> Option<&LoadedDefinition> {
        self.items.iter().find(|d| d.def.id == id)
    }

    pub fn view(&self) -> DefinitionsView {
        DefinitionsView {
            definitions: self
                .items
                .iter()
                .map(|d| DefinitionView {
                    def: d.def.clone(),
                    source: d.source,
                })
                .collect(),
            errors: self.errors.clone(),
        }
    }

    /// The graceful-close sequence for a pane's agent: its definition's `gracefulClose`,
    /// else the Faz 8 sequence for Claude Code, else `None` (killed at once).
    pub fn close_plan(&self, adapter_id: Option<&str>, kind: AgentKind) -> Option<Vec<CloseStep>> {
        if let Some(def) = adapter_id.and_then(|id| self.get(id)) {
            if !def.close.is_empty() {
                return Some(def.close.clone());
            }
        }
        (adapter_id == Some(CLAUDE_CODE_ID) || kind == AgentKind::Claude).then(claude_default_close)
    }
}

/// Where the built-in definitions are: `<resources>/adapters`, else (debug builds) the
/// repo's `adapters/`.
pub fn builtin_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_dir {
        candidates.push(dir.join("adapters"));
    }
    if cfg!(debug_assertions) {
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..").join("adapters"));
    }
    candidates
        .into_iter()
        .find(|p| !definition_files(p).is_empty())
        .map(|p| dunce::canonicalize(&p).unwrap_or(p))
}

/// `%APPDATA%\kotilo\adapters`.
pub fn user_dir() -> PathBuf {
    crate::persistence::state_dir().join("adapters")
}

/// Tauri-managed: where definitions come from. The loaded set itself lives in the
/// [`crate::agents::AgentTracker`], which every consumer already reaches.
#[derive(Debug, Clone, Default)]
pub struct AdapterDirs {
    pub builtin: Option<PathBuf>,
    pub user: Option<PathBuf>,
}

impl AdapterDirs {
    pub fn load(&self) -> Definitions {
        Definitions::load(self.builtin.as_deref(), self.user.as_deref())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A minimal valid definition for tests.
    pub(crate) fn def(id: &str) -> AdapterDefinition {
        AdapterDefinition {
            v: 1,
            id: id.to_string(),
            display_name: id.to_string(),
            avatar: Some(Avatar {
                letter: "A".into(),
                bg: "#000000".into(),
                ink: "#ffffff".into(),
            }),
            launch: Some(Launch {
                command: id.to_string(),
                args: vec![],
            }),
            ..Default::default()
        }
    }

    fn write(dir: &Path, folder: &str, text: &str) {
        std::fs::create_dir_all(dir.join(folder)).unwrap();
        std::fs::write(dir.join(folder).join(DEFINITION_FILE_NAME), text).unwrap();
    }

    #[test]
    fn repo_builtin_definitions_load_without_errors() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../adapters");
        let defs = Definitions::load(Some(&dir), None);
        assert!(defs.errors.is_empty(), "{:?}", defs.errors);
        let claude = defs.get("claude-code").expect("claude-code");
        assert_eq!(claude.close, claude_default_close());
        assert!(defs.get("codex").is_some());
    }

    /// 0.3.2: Claude's permission dialog on screen (safety net when no PermissionRequest
    /// hook arrives) — both dialog layouts match, ordinary output does not.
    #[test]
    fn repo_builtin_claude_permission_screen_rule_matches_the_dialogs_only() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../adapters");
        let defs = Definitions::load(Some(&dir), None);
        let claude = defs.get("claude-code").expect("claude-code");
        let fixture = |name: &str| -> Vec<String> {
            let text = std::fs::read_to_string(dir.join("claude-code/fixtures").join(name)).unwrap();
            // A 40-row screen: the fixture at the bottom, blank rows above.
            let mut rows = vec![String::new(); 40usize.saturating_sub(text.lines().count())];
            rows.extend(text.lines().map(str::to_string));
            rows
        };
        for name in ["screen-permission-three-options.txt", "screen-permission-yes-no.txt"] {
            let hit = screen::first_match(&claude.rules, &fixture(name), |_| true).unwrap_or_else(|| panic!("{name}"));
            assert_eq!(claude.rules[hit.index].state, screen::ScreenState::WaitingPermission, "{name}");
        }
        assert!(screen::first_match(&claude.rules, &fixture("screen-normal-output.txt"), |_| true).is_none());
        // Only the bottom of the screen counts: the dialog scrolled up under later output.
        let mut scrolled = fixture("screen-permission-yes-no.txt");
        scrolled.extend((0..20).map(|i| format!("line {i}")));
        assert!(screen::first_match(&claude.rules, &scrolled, |_| true).is_none());
    }

    /// The permission card sends `allowOnce` / `deny` through `pane_send_keys`: a built-in
    /// adapter with keys must have both, and each must be one key, not literal text.
    #[test]
    fn repo_builtin_permission_keys_are_complete_and_parse() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../adapters");
        let defs = Definitions::load(Some(&dir), None);
        let mut with_keys = 0;
        for d in &defs.items {
            let Some(pk) = &d.def.permission_keys else { continue };
            with_keys += 1;
            for (name, value) in [("allowOnce", &pk.allow_once), ("alwaysAllow", &pk.always_allow), ("deny", &pk.deny)] {
                let Some(v) = value.as_deref() else {
                    assert_eq!(name, "alwaysAllow", "{}: permissionKeys.{name} missing", d.def.id);
                    continue;
                };
                let bytes = keys::parse_keys(v).unwrap();
                assert!(!bytes.is_empty() && bytes.len() <= 4, "{}: {name} = {v:?} is not a key", d.def.id);
            }
        }
        assert!(with_keys >= 7, "only {with_keys} built-in adapters have permission keys");
        // Droid's prompt keys are not verified yet (D-030): the card offers only the terminal.
        assert!(defs.get("droid").is_some_and(|d| d.def.permission_keys.is_none()));
    }

    #[test]
    fn user_definitions_load_and_errors_are_collected() {
        let tmp = tempfile::tempdir().unwrap();
        let builtin = tmp.path().join("builtin");
        let user = tmp.path().join("user");
        write(&builtin, "codex", &serde_json::to_string(&def("codex")).unwrap());
        // BOM + unknown field: fine.
        let mut mine = serde_json::to_value(def("my-agent")).unwrap();
        mine["futureField"] = serde_json::json!(true);
        write(&user, "my-agent", &format!("\u{feff}{mine}"));
        write(&user, "codex", &serde_json::to_string(&def("codex")).unwrap());
        write(&user, "broken", "{ not json");
        write(&user, "wrong-folder", &serde_json::to_string(&def("other")).unwrap());
        let mut bad_rule = def("bad-rule");
        bad_rule.screen_rules = vec![ScreenRule {
            id: "x".into(),
            state: screen::ScreenState::Working,
            pattern: "(".into(),
            lines: None,
            clear_on: None,
        }];
        write(&user, "bad-rule", &serde_json::to_string(&bad_rule).unwrap());
        std::fs::create_dir_all(user.join("empty-folder")).unwrap();

        let defs = Definitions::load(Some(&builtin), Some(&user));
        let ids: Vec<_> = defs.items.iter().map(|d| (d.def.id.as_str(), d.source)).collect();
        assert_eq!(ids, vec![("codex", DefinitionSource::BuiltIn), ("my-agent", DefinitionSource::User)]);
        let errs: Vec<_> = defs.errors.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(errs, vec!["bad-rule", "broken", "codex", "other"]);
        assert!(defs.errors.iter().all(|e| e.source == DefinitionSource::User));
        assert!(defs.errors[0].message.contains("invalid pattern"));
    }

    #[test]
    fn missing_dirs_load_nothing() {
        let defs = Definitions::load(Some(Path::new("Z:/no/such/dir")), None);
        assert!(defs.items.is_empty() && defs.errors.is_empty());
    }

    #[test]
    fn validate_reports_missing_required_fields_and_bad_keys() {
        let mut d = def("x");
        d.v = 2;
        assert!(validate(d, DefinitionSource::User).is_err());
        let mut d = def("X Y");
        d.id = "X Y".into();
        assert!(validate(d, DefinitionSource::User).is_err());
        let mut d = def("x");
        d.launch = None;
        assert!(validate(d, DefinitionSource::User).unwrap_err().contains("launch"));
        let mut d = def("x");
        d.graceful_close = vec![CloseStepDef {
            keys: String::new(),
            repeat: None,
            gap_ms: None,
            wait_ms: None,
        }];
        assert!(validate(d, DefinitionSource::User).is_err());
    }

    #[test]
    fn close_plan_uses_the_definition_then_the_claude_fallback() {
        let mut gemini = def("gemini");
        gemini.graceful_close = vec![
            CloseStepDef {
                keys: "Ctrl+C".into(),
                repeat: Some(2),
                gap_ms: Some(300),
                wait_ms: None,
            },
            CloseStepDef {
                keys: "/quit\r".into(),
                repeat: None,
                gap_ms: None,
                wait_ms: Some(2000),
            },
        ];
        let defs = Definitions::from_builtin(vec![gemini, def("codex")]);
        let plan = defs.close_plan(Some("gemini"), AgentKind::Gemini).unwrap();
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].bytes, vec![0x03]);
        assert_eq!(plan[0].repeat, 2);
        assert_eq!(plan[0].gap, Duration::from_millis(300));
        assert_eq!(plan[0].wait, Duration::from_millis(DEFAULT_CLOSE_WAIT_MS));
        assert_eq!(plan[1].bytes, b"/quit\r".to_vec());
        assert_eq!(plan[1].wait, Duration::from_millis(2000));

        assert!(defs.close_plan(Some("codex"), AgentKind::Codex).is_none());
        assert!(defs.close_plan(None, AgentKind::Other).is_none());
        // No definition loaded at all: Claude keeps its Faz 8 sequence.
        let empty = Definitions::default();
        assert_eq!(empty.close_plan(Some("claude-code"), AgentKind::Claude), Some(claude_default_close()));
        assert_eq!(empty.close_plan(None, AgentKind::Claude), Some(claude_default_close()));
    }

    #[test]
    fn view_flattens_the_definition_with_its_source() {
        let defs = Definitions::from_builtin(vec![def("codex")]);
        let v = serde_json::to_value(defs.view()).unwrap();
        assert_eq!(v["definitions"][0]["id"], "codex");
        assert_eq!(v["definitions"][0]["displayName"], "codex");
        assert_eq!(v["definitions"][0]["source"], "builtIn");
        assert_eq!(v["definitions"][0]["screenRules"], serde_json::json!([]));
        assert!(v["errors"].as_array().unwrap().is_empty());
    }
}
