//! 0.9 Context (D-076): a read-only view of what an agent picks up in a workspace –
//! instruction files, rules, skills and MCP servers – from the adapter's data-only
//! `context` section, with a rough token estimate.
//!
//! Everything takes the workspace root, the home folder and the OS id as parameters
//! (tests use a fake home in a temp dir). Nothing is written, and no file content or
//! secret value is logged or returned in a report: MCP configs yield only server names,
//! executable basenames, argument counts, URL origins and the NAMES of secret keys
//! (`mcp.rs`). File contents leave only through [`read`], and only for a file the
//! recomputed report lists under `files` or `skills`.

mod mcp;
mod skills;
mod walk;

use std::collections::HashSet;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::adapters::{
    is_credential_path, AdapterDefinition, ContextDef, ContextLoaded, ContextOs, ContextScope, ContextSourceDef,
    ContextWalk,
};

/// Imports are followed at most this many hops from the file that is loaded.
const MAX_IMPORT_DEPTH: usize = 4;
/// Instruction files above this size are not read; their tokens are estimated from bytes.
const MAX_ESTIMATE_BYTES: u64 = 4 * 1024 * 1024;
/// [`read`] returns at most this much text.
pub const MAX_READ_BYTES: usize = 256 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ContextError {
    #[error("unknown agent '{0}'")]
    UnknownAgent(String),
    #[error("this path is not part of the agent's context")]
    NotListed,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    Instruction,
    Rule,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextFile {
    pub kind: FileKind,
    pub scope: ContextScope,
    /// Absolute, as found.
    pub path: String,
    /// `~/…` under home, workspace-relative (forward slashes) inside the root, else absolute.
    pub display: String,
    pub rel: Option<String>,
    pub bytes: u64,
    pub tokens: u64,
    pub loaded: ContextLoaded,
    pub imported_by: Option<String>,
    pub over_limit: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSkill {
    pub scope: ContextScope,
    pub name: String,
    pub description: Option<String>,
    /// The skill's `SKILL.md`.
    pub path: String,
    pub display: String,
    pub rel: Option<String>,
    /// Name + description (what the agent always sees).
    pub tokens: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub scope: ContextScope,
    /// Display of the config file.
    pub source: String,
    pub transport: McpTransport,
    /// Executable basename only.
    pub command: Option<String>,
    pub arg_count: u32,
    /// `scheme://host[:port]` only.
    pub url: Option<String>,
    /// `env.GITHUB_TOKEN`, `headers.Authorization`, … – names only.
    pub secret_keys: Vec<String>,
    pub disabled: bool,
    /// Display of the higher-precedence source that defines the same name.
    pub shadowed_by: Option<String>,
}

/// One MCP config file that was looked at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSource {
    pub scope: ContextScope,
    pub path: String,
    pub display: String,
    pub exists: bool,
    pub error: Option<String>,
    pub server_count: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextTotals {
    pub always_tokens: u64,
    pub on_demand_tokens: u64,
    pub skill_tokens: u64,
    pub always_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextReport {
    pub agent: String,
    pub supported: bool,
    pub root: String,
    /// Instructions + rules, in load order.
    pub files: Vec<ContextFile>,
    pub skills: Vec<ContextSkill>,
    pub mcp: Vec<McpServer>,
    pub sources: Vec<ContextSource>,
    pub max_bytes: Option<u64>,
    pub totals: ContextTotals,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextText {
    pub text: String,
    pub truncated: bool,
}

/// Where a report is computed: the workspace root, the home folder and the OS id.
pub(crate) struct Env {
    pub root: PathBuf,
    pub home: Option<PathBuf>,
    pub os: String,
    /// Highest directory an `ancestors` walk may reach (tests: the fixture's temp dir, so a
    /// walk never reads the real machine's folders).
    ceiling: Option<PathBuf>,
}

#[cfg(test)]
thread_local! {
    /// Set by the fixture tests; each test runs on its own thread.
    pub(crate) static TEST_CEILING: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

impl Env {
    pub fn new(root: &Path, home: Option<&Path>, os: &str) -> Self {
        Self {
            root: root.to_path_buf(),
            home: home.map(Path::to_path_buf),
            os: os.to_string(),
            #[cfg(test)]
            ceiling: TEST_CEILING.with(|c| c.borrow().clone()),
            #[cfg(not(test))]
            ceiling: None,
        }
    }

    fn windows(&self) -> bool {
        self.os == "windows"
    }

    fn os_matches(&self, os: Option<ContextOs>) -> bool {
        os.is_none_or(|o| o.id() == self.os)
    }

    /// `~/x` → home, absolute → as is, relative → `base` (the workspace root by default).
    pub fn resolve_from(&self, p: &str, base: &Path) -> Option<PathBuf> {
        if p == "~" {
            return self.home.clone();
        }
        if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
            return self.home.as_ref().map(|h| join_native(h, rest));
        }
        let path = Path::new(p);
        Some(if path.is_absolute() { path.to_path_buf() } else { join_native(base, p) })
    }

    pub fn resolve(&self, p: &str) -> Option<PathBuf> {
        self.resolve_from(p, &self.root)
    }

    /// Workspace-relative path (forward slashes) when `p` is inside the root.
    pub fn rel(&self, p: &Path) -> Option<String> {
        let rest = p.strip_prefix(&self.root).ok()?;
        let s = slashes(rest);
        (!s.is_empty()).then_some(s)
    }

    pub fn display(&self, p: &Path) -> String {
        if let Some(rel) = self.rel(p) {
            return rel;
        }
        if let Some(rest) = self.home.as_ref().and_then(|h| p.strip_prefix(h).ok()) {
            return format!("~/{}", slashes(rest));
        }
        p.to_string_lossy().into_owned()
    }

    /// Identity of a path for de-duplication (case-insensitive on Windows).
    pub fn key(&self, p: &Path) -> String {
        let s = p.to_string_lossy().replace('\\', "/");
        if self.windows() {
            s.to_lowercase()
        } else {
            s
        }
    }

    /// The git toplevel: the nearest directory at or above the root with a `.git`.
    pub fn repo_top(&self) -> Option<PathBuf> {
        self.root
            .ancestors()
            .take_while(|d| self.ceiling.as_ref().is_none_or(|c| d.starts_with(c)))
            .find(|d| d.join(".git").exists())
            .map(Path::to_path_buf)
    }

    /// Walked directories, outermost first (load order: general before specific).
    pub fn walk_dirs(&self, walk: ContextWalk) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = match walk {
            ContextWalk::Root => return vec![self.root.clone()],
            ContextWalk::Ancestors => self
                .root
                .ancestors()
                .take_while(|d| self.ceiling.as_ref().is_none_or(|c| d.starts_with(c)))
                .map(Path::to_path_buf)
                .collect(),
            ContextWalk::Repo => match self.repo_top() {
                Some(top) => self
                    .root
                    .ancestors()
                    .take_while(|d| d.starts_with(&top))
                    .map(Path::to_path_buf)
                    .collect(),
                None => vec![self.root.clone()],
            },
        };
        dirs.reverse();
        dirs
    }
}

/// `base` + a `/`- or `\`-separated relative path, with native separators.
pub(crate) fn join_native(base: &Path, rel: &str) -> PathBuf {
    rel.split(['/', '\\']).filter(|s| !s.is_empty() && *s != ".").fold(base.to_path_buf(), |acc, s| acc.join(s))
}

fn slashes(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// ceil(chars / 4).
pub fn estimate_tokens(text: &str) -> u64 {
    (text.chars().count() as u64).div_ceil(4)
}

/// Reads at most `cap` bytes of a text file (BOM stripped, cut at a char boundary).
fn read_capped(path: &Path, cap: usize) -> std::io::Result<ContextText> {
    let file = std::fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(cap as u64 + 1).read_to_end(&mut bytes)?;
    let truncated = bytes.len() > cap;
    bytes.truncate(cap);
    let text = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => {
            let mut bytes = e.into_bytes();
            // Only an incomplete sequence at the cut is dropped; other bad bytes become U+FFFD.
            if truncated {
                if let Err(u) = std::str::from_utf8(&bytes) {
                    if u.error_len().is_none() {
                        bytes.truncate(u.valid_up_to());
                    }
                }
            }
            String::from_utf8_lossy(&bytes).into_owned()
        }
    };
    let text = text.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(text);
    Ok(ContextText { text, truncated })
}

/// Collects instruction and rule files in load order.
struct FileCollector<'a> {
    env: &'a Env,
    seen: HashSet<String>,
    files: Vec<ContextFile>,
}

impl FileCollector<'_> {
    fn push(
        &mut self,
        kind: FileKind,
        src: &ContextSourceDef,
        path: &Path,
        loaded: ContextLoaded,
        imported_by: Option<String>,
        depth: usize,
    ) {
        if !self.seen.insert(self.env.key(path)) || is_credential_path(&path.to_string_lossy()) {
            return;
        }
        let display = self.env.display(path);
        let mut file = ContextFile {
            kind,
            scope: src.scope,
            path: path.to_string_lossy().into_owned(),
            display: display.clone(),
            rel: self.env.rel(path),
            bytes: 0,
            tokens: 0,
            loaded,
            imported_by,
            over_limit: false,
            error: None,
        };
        let size = std::fs::metadata(path).map(|m| m.len());
        let text = match size {
            Ok(n) if n > MAX_ESTIMATE_BYTES => {
                file.bytes = n;
                file.tokens = n.div_ceil(4);
                None
            }
            Ok(_) => match read_capped(path, MAX_ESTIMATE_BYTES as usize) {
                Ok(t) => {
                    file.bytes = size.unwrap_or_default();
                    file.tokens = estimate_tokens(&t.text);
                    Some(t.text)
                }
                Err(e) => {
                    file.error = Some(e.kind().to_string());
                    None
                }
            },
            Err(e) => {
                file.error = Some(e.kind().to_string());
                None
            }
        };
        if kind == FileKind::Rule && src.loaded.is_none() {
            if let Some(l) = text.as_deref().and_then(walk::rule_loaded) {
                file.loaded = l;
            }
        }
        let loaded = file.loaded;
        self.files.push(file);
        if !src.imports || depth >= MAX_IMPORT_DEPTH {
            return;
        }
        let Some(text) = text else { return };
        let base = path.parent().unwrap_or(path);
        for r in walk::import_refs(&text) {
            let Some(target) = self.env.resolve_from(&r, base) else { continue };
            if target.is_file() {
                self.push(kind, src, &target, loaded, Some(display.clone()), depth + 1);
            }
        }
    }
}

fn source_matches(env: &Env, src: &ContextSourceDef) -> (Vec<PathBuf>, Vec<PathBuf>) {
    if let Some(path) = &src.path {
        let found = env.resolve(path).filter(|p| p.is_file());
        return (found.into_iter().collect(), Vec::new());
    }
    if let Some(glob) = &src.glob {
        return (walk::glob_matches(env, glob), Vec::new());
    }
    let Some(names) = &src.names else { return (Vec::new(), Vec::new()) };
    let dirs = match &src.dir {
        Some(dir) => env.resolve(dir).into_iter().collect(),
        None => env.walk_dirs(src.walk.unwrap_or(ContextWalk::Root)),
    };
    let primary = walk::names_in_dirs(&dirs, names, src.pick.unwrap_or_default());
    let nested = if src.nested { walk::nested_matches(env, names) } else { Vec::new() };
    (primary, nested)
}

fn collect_files(env: &Env, ctx: &ContextDef) -> Vec<ContextFile> {
    let mut c = FileCollector {
        env,
        seen: HashSet::new(),
        files: Vec::new(),
    };
    for (kind, sources) in [(FileKind::Instruction, &ctx.instructions), (FileKind::Rule, &ctx.rules)] {
        let matched: Vec<Option<(Vec<PathBuf>, Vec<PathBuf>)>> = sources
            .iter()
            .map(|s| env.os_matches(s.os).then(|| source_matches(env, s)))
            .collect();
        // A fallback source counts only when no regular source of the same kind and scope
        // found a file (Claude's AGENTS.md, OpenCode's CLAUDE.md).
        let found_scopes: HashSet<ContextScope> = sources
            .iter()
            .zip(&matched)
            .filter(|(s, m)| !s.fallback && m.as_ref().is_some_and(|(p, _)| !p.is_empty()))
            .map(|(s, _)| s.scope)
            .collect();
        for (src, m) in sources.iter().zip(matched) {
            let Some((primary, nested)) = m else { continue };
            if src.fallback && found_scopes.contains(&src.scope) {
                continue;
            }
            let loaded = src.loaded.unwrap_or_default();
            for p in primary {
                c.push(kind, src, &p, loaded, None, 0);
            }
            for p in nested {
                c.push(kind, src, &p, ContextLoaded::OnDemand, None, 0);
            }
        }
    }
    let mut files = c.files;
    if let Some(max) = ctx.max_bytes {
        // The agent stops reading project instructions past `maxBytes` (Codex's
        // `project_doc_max_bytes`); user/managed files are not part of that budget.
        let mut total = 0u64;
        for f in files.iter_mut().filter(|f| {
            f.kind == FileKind::Instruction && f.scope == ContextScope::Project && f.loaded == ContextLoaded::Always
        }) {
            total += f.bytes;
            f.over_limit = total > max;
        }
    }
    files
}

/// The context report of `def` for the workspace at `root`.
pub fn report(def: &AdapterDefinition, root: &Path, home: Option<&Path>, os: &str) -> ContextReport {
    let env = Env::new(root, home, os);
    let mut out = ContextReport {
        agent: def.id.clone(),
        supported: def.context.is_some(),
        root: root.to_string_lossy().into_owned(),
        files: Vec::new(),
        skills: Vec::new(),
        mcp: Vec::new(),
        sources: Vec::new(),
        max_bytes: None,
        totals: ContextTotals::default(),
    };
    let Some(ctx) = &def.context else { return out };
    out.max_bytes = ctx.max_bytes;
    out.files = collect_files(&env, ctx);
    out.skills = skills::collect(&env, &ctx.skills);
    let (servers, sources) = mcp::collect(&env, &ctx.mcp);
    out.mcp = servers;
    out.sources = sources;
    for f in &out.files {
        match f.loaded {
            ContextLoaded::Always => {
                out.totals.always_tokens += f.tokens;
                out.totals.always_bytes += f.bytes;
            }
            ContextLoaded::OnDemand => out.totals.on_demand_tokens += f.tokens,
        }
    }
    out.totals.skill_tokens = out.skills.iter().map(|s| s.tokens).sum();
    out
}

/// Text of a file the report lists under `files` or `skills` (recomputed), at most
/// [`MAX_READ_BYTES`]. MCP config files (`~/.claude.json`, …) are never readable here.
pub fn read(def: &AdapterDefinition, root: &Path, home: Option<&Path>, os: &str, path: &str) -> Result<ContextText, ContextError> {
    let r = report(def, root, home, os);
    let env = Env::new(root, home, os);
    let key = env.key(Path::new(path));
    let listed = r.files.iter().any(|f| env.key(Path::new(&f.path)) == key)
        || r.skills.iter().any(|s| env.key(Path::new(&s.path)) == key);
    let is_mcp_source = r.sources.iter().any(|s| env.key(Path::new(&s.path)) == key)
        || def
            .context
            .iter()
            .flat_map(|c| &c.mcp)
            .filter_map(|m| env.resolve(&m.path))
            .any(|p| env.key(&p) == key);
    if !listed || is_mcp_source || is_credential_path(path) {
        return Err(ContextError::NotListed);
    }
    Ok(read_capped(Path::new(path), MAX_READ_BYTES)?)
}

#[cfg(test)]
mod tests;
