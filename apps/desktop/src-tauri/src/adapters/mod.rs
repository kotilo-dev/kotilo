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

/// D-067: the placeholder in `launch.resumeArgs`.
pub const SESSION_ID_PLACEHOLDER: &str = "{sessionId}";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Launch {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// D-067: arguments that resume a session (`{sessionId}` is replaced); empty = no resume.
    #[serde(default, rename = "resumeArgs", skip_serializing_if = "Vec::is_empty")]
    pub resume_args: Vec<String>,
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
    /// 0.9 (D-076): where the agent's instruction files, rules, skills and MCP servers live.
    /// Read by `crate::context`; the hub ignores it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<ContextDef>,
}

/// 0.9 `context`: instruction files, rules, skills and MCP configs of one agent.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextDef {
    #[serde(default)]
    pub instructions: Vec<ContextSourceDef>,
    #[serde(default)]
    pub rules: Vec<ContextSourceDef>,
    #[serde(default)]
    pub skills: Vec<SkillDirDef>,
    #[serde(default)]
    pub mcp: Vec<McpSourceDef>,
    /// The agent stops reading project instructions past this many bytes (Codex).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextScope {
    Managed,
    User,
    Project,
    Local,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextWalk {
    /// The workspace root only.
    Root,
    /// The root and every parent up to the filesystem root.
    Ancestors,
    /// The git toplevel down to the root (the root only without git).
    Repo,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextPick {
    /// Every name that exists in every directory.
    #[default]
    All,
    /// Per directory only the first name that exists.
    First,
    /// Only the single match closest to the workspace root.
    Nearest,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextLoaded {
    #[default]
    Always,
    OnDemand,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextOs {
    Windows,
    Macos,
    Linux,
}

impl ContextOs {
    /// Same values as [`crate::platform::os_id`].
    pub fn id(self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::Macos => "macos",
            Self::Linux => "linux",
        }
    }
}

/// One instruction or rule source: exactly one of `path`, `names`, `glob`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSourceDef {
    pub scope: ContextScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub names: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glob: Option<String>,
    /// With `names`: look only in this directory (`~/…`, relative to the root, or absolute)
    /// instead of walking from the workspace root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub walk: Option<ContextWalk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pick: Option<ContextPick>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub nested: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<ContextOs>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fallback: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loaded: Option<ContextLoaded>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub imports: bool,
}

/// `<dir>/<name>/SKILL.md` folders.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDirDef {
    pub scope: ContextScope,
    pub dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub walk: Option<ContextWalk>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpFormat {
    Json,
    Jsonc,
    Toml,
}

/// A JSON pointer, or several tried in order (the first that resolves wins).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum McpPointer {
    One(String),
    Many(Vec<String>),
}

impl McpPointer {
    pub fn list(&self) -> Vec<&str> {
        match self {
            Self::One(p) => vec![p.as_str()],
            Self::Many(ps) => ps.iter().map(String::as_str).collect(),
        }
    }
}

/// An MCP config file and where its server map is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSourceDef {
    pub scope: ContextScope,
    pub path: String,
    pub format: McpFormat,
    pub pointer: McpPointer,
    /// `~/.claude.json`: also `/projects/<workspace root>/mcpServers` (scope local).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub project_pointer: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub walk: Option<ContextWalk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<ContextOs>,
}

/// True for a path that looks like a credential or key file (`.credentials.json`,
/// `auth.json`, any segment containing `token`, `*.key`, `*.pem`). Context sources never
/// point at these, and the walker never lists one.
pub fn is_credential_path(path: &str) -> bool {
    path.split(['/', '\\']).any(|segment| {
        let s = segment.to_ascii_lowercase();
        s == ".credentials.json"
            || s == "credentials.json"
            || s == "auth.json"
            || s.contains("token")
            || s.ends_with(".key")
            || s.ends_with(".pem")
    })
}

fn check_context_path(field: &str, path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err(format!("{field} is empty"));
    }
    if is_credential_path(path) {
        return Err(format!("{field} '{path}' looks like a credential file"));
    }
    Ok(())
}

fn validate_context_source(field: &str, s: &ContextSourceDef) -> Result<(), String> {
    if s.scope == ContextScope::Local {
        return Err(format!("{field}.scope must be managed, user or project"));
    }
    let given = [s.path.is_some(), s.names.is_some(), s.glob.is_some()].iter().filter(|b| **b).count();
    if given != 1 {
        return Err(format!("{field} needs exactly one of path, names, glob"));
    }
    if let Some(path) = &s.path {
        check_context_path(&format!("{field}.path"), path)?;
    }
    if let Some(glob) = &s.glob {
        check_context_path(&format!("{field}.glob"), glob)?;
        globset::Glob::new(glob).map_err(|e| format!("{field}.glob: {e}"))?;
    }
    match &s.names {
        Some(names) => {
            if names.is_empty() {
                return Err(format!("{field}.names is empty"));
            }
            for name in names {
                check_context_path(&format!("{field}.names"), name)?;
            }
            if let Some(dir) = &s.dir {
                check_context_path(&format!("{field}.dir"), dir)?;
                if s.walk.is_some() || s.nested {
                    return Err(format!("{field}: dir cannot be combined with walk or nested"));
                }
            }
        }
        None => {
            if s.dir.is_some() || s.walk.is_some() || s.pick.is_some() || s.nested {
                return Err(format!("{field}: dir, walk, pick and nested need names"));
            }
        }
    }
    Ok(())
}

/// Checks the 0.9 `context` section (D-076).
pub fn validate_context(ctx: &ContextDef) -> Result<(), String> {
    for (kind, sources) in [("instructions", &ctx.instructions), ("rules", &ctx.rules)] {
        for (i, s) in sources.iter().enumerate() {
            validate_context_source(&format!("context.{kind}[{i}]"), s)?;
        }
    }
    for (i, s) in ctx.skills.iter().enumerate() {
        let field = format!("context.skills[{i}]");
        if !matches!(s.scope, ContextScope::User | ContextScope::Project) {
            return Err(format!("{field}.scope must be user or project"));
        }
        if s.walk == Some(ContextWalk::Ancestors) {
            return Err(format!("{field}.walk must be root or repo"));
        }
        check_context_path(&format!("{field}.dir"), &s.dir)?;
    }
    for (i, s) in ctx.mcp.iter().enumerate() {
        let field = format!("context.mcp[{i}]");
        if s.scope == ContextScope::Managed {
            return Err(format!("{field}.scope must be user, project or local"));
        }
        if s.walk == Some(ContextWalk::Ancestors) {
            return Err(format!("{field}.walk must be root or repo"));
        }
        check_context_path(&format!("{field}.path"), &s.path)?;
        let pointers = s.pointer.list();
        if pointers.is_empty() || pointers.iter().any(|p| !p.is_empty() && !p.starts_with('/')) {
            return Err(format!("{field}.pointer must be a JSON pointer (\"\" or starting with /)"));
        }
        if s.project_pointer && s.format == McpFormat::Toml {
            return Err(format!("{field}.projectPointer needs a JSON file"));
        }
    }
    if ctx.max_bytes == Some(0) {
        return Err("context.maxBytes must be at least 1".to_string());
    }
    Ok(())
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
        Some(l) if !l.command.trim().is_empty() => {
            if !l.resume_args.is_empty() && !l.resume_args.iter().any(|a| a.contains(SESSION_ID_PLACEHOLDER)) {
                return Err(format!("launch.resumeArgs must contain {SESSION_ID_PLACEHOLDER}"));
            }
        }
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
    if let Some(ctx) = &def.context {
        validate_context(ctx)?;
    }
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
                resume_args: vec![],
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
    fn resume_args_need_the_session_id_placeholder() {
        let mut d = def("x");
        d.launch.as_mut().unwrap().resume_args = vec!["--resume".into()];
        assert!(validate(d, DefinitionSource::User).unwrap_err().contains("resumeArgs"));
        let mut d = def("x");
        d.launch.as_mut().unwrap().resume_args = vec!["--resume".into(), "{sessionId}".into()];
        assert!(validate(d, DefinitionSource::User).is_ok());
    }

    #[test]
    fn built_in_adapters_resume_with_the_session_id() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../adapters");
        let defs = Definitions::load(Some(&dir), None);
        assert!(defs.errors.is_empty(), "{:?}", defs.errors);
        assert!(defs.items.len() >= 8);
        for d in &defs.items {
            let launch = d.def.launch.as_ref().unwrap();
            assert!(launch.resume_args.iter().any(|a| a == SESSION_ID_PLACEHOLDER), "{}", d.def.id);
        }
        let json = serde_json::to_value(defs.items.iter().find(|d| d.def.id == "codex").unwrap().def.launch.as_ref()).unwrap();
        assert_eq!(json["resumeArgs"], serde_json::json!(["resume", "{sessionId}"]));
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

    fn with_context(ctx: serde_json::Value) -> Result<LoadedDefinition, String> {
        let mut d = def("x");
        d.context = Some(serde_json::from_value(ctx).map_err(|e| e.to_string())?);
        validate(d, DefinitionSource::User)
    }

    #[test]
    fn context_rejects_credential_paths() {
        use serde_json::json;
        for bad in [
            json!({ "instructions": [{ "scope": "user", "path": "~/.claude/.credentials.json" }] }),
            json!({ "instructions": [{ "scope": "user", "path": "~/.codex/auth.json" }] }),
            json!({ "instructions": [{ "scope": "project", "names": ["AGENTS.md", "github_token.txt"] }] }),
            json!({ "rules": [{ "scope": "user", "glob": "~/.ssh/**/*.pem" }] }),
            json!({ "rules": [{ "scope": "user", "glob": "~/keys/*.key" }] }),
            json!({ "instructions": [{ "scope": "user", "names": ["A.md"], "dir": "~/.tokens" }] }),
            json!({ "skills": [{ "scope": "user", "dir": "~/.Token-store" }] }),
            json!({ "mcp": [{ "scope": "user", "path": "~/.codex/auth.json", "format": "json", "pointer": "/x" }] }),
        ] {
            let err = with_context(bad.clone()).unwrap_err();
            assert!(err.contains("credential"), "{bad}: {err}");
        }
        assert!(is_credential_path(r"C:\Users\x\.claude\.credentials.json"));
        assert!(!is_credential_path("~/.claude.json"));
        assert!(!is_credential_path("~/.claude/CLAUDE.md"));
    }

    #[test]
    fn context_rejects_bad_combinations() {
        use serde_json::json;
        for bad in [
            json!({ "instructions": [{ "scope": "project" }] }),
            json!({ "instructions": [{ "scope": "project", "path": "A.md", "names": ["A.md"] }] }),
            json!({ "instructions": [{ "scope": "project", "path": "A.md", "glob": "*.md" }] }),
            json!({ "instructions": [{ "scope": "project", "names": [] }] }),
            json!({ "instructions": [{ "scope": "project", "path": "A.md", "walk": "repo" }] }),
            json!({ "instructions": [{ "scope": "project", "glob": "*.md", "pick": "first" }] }),
            json!({ "instructions": [{ "scope": "project", "path": "A.md", "nested": true }] }),
            json!({ "instructions": [{ "scope": "project", "names": ["A.md"], "dir": "~/.a", "walk": "repo" }] }),
            json!({ "instructions": [{ "scope": "local", "path": "A.md" }] }),
            json!({ "rules": [{ "scope": "project", "glob": "[" }] }),
            json!({ "skills": [{ "scope": "managed", "dir": ".s" }] }),
            json!({ "skills": [{ "scope": "project", "dir": ".s", "walk": "ancestors" }] }),
            json!({ "mcp": [{ "scope": "managed", "path": ".mcp.json", "format": "json", "pointer": "/m" }] }),
            json!({ "mcp": [{ "scope": "user", "path": ".mcp.json", "format": "json", "pointer": "mcpServers" }] }),
            json!({ "mcp": [{ "scope": "user", "path": ".mcp.json", "format": "json", "pointer": [] }] }),
            json!({ "mcp": [{ "scope": "user", "path": "c.toml", "format": "toml", "pointer": "/m", "projectPointer": true }] }),
            json!({ "maxBytes": 0 }),
        ] {
            assert!(with_context(bad.clone()).is_err(), "{bad} was accepted");
        }
        // Unknown enum values fail to parse (reported like any invalid file).
        assert!(with_context(json!({ "instructions": [{ "scope": "project", "path": "A.md", "walk": "sideways" }] })).is_err());
        assert!(with_context(json!({
            "instructions": [{ "scope": "project", "names": ["A.md"], "walk": "repo", "pick": "first", "nested": true, "imports": true }],
            "mcp": [{ "scope": "user", "path": "~/.x.json", "format": "jsonc", "pointer": ["/a/b", "/a"], "walk": "root" }],
            "maxBytes": 10
        }))
        .is_ok());
    }

    #[test]
    fn every_builtin_adapter_has_a_valid_context() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../adapters");
        let defs = Definitions::load(Some(&dir), None);
        assert!(defs.errors.is_empty(), "{:?}", defs.errors);
        for id in ["claude-code", "codex", "copilot", "cursor", "droid", "gemini", "opencode", "qwen"] {
            let ctx = defs.get(id).and_then(|d| d.def.context.as_ref()).unwrap_or_else(|| panic!("{id}: no context"));
            assert!(!ctx.instructions.is_empty() && !ctx.skills.is_empty() && !ctx.mcp.is_empty(), "{id}");
            // Round trip: the serialized context parses back to the same value.
            let back: ContextDef = serde_json::from_value(serde_json::to_value(ctx).unwrap()).unwrap();
            assert_eq!(&back, ctx, "{id}");
        }
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
