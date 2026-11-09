//! 0.7 Docs: finds docs that no longer match the code (D-074).
//!
//! Two findings per doc: **missing** (the doc names a repo path that does not exist) and
//! **stale** (a file the doc covers changed in commits after the doc's baseline – the commit
//! stored by "Mark reviewed" in `.kotilo/docs.toml`, else the last commit that touched the doc).
//! What a doc covers comes from Markdown links, `file=` code blocks, path-like inline code
//! (missing only), `.kotilo/docs.toml` globs and an optional front matter `covers:` list.
//!
//! Pure library shared by the desktop app and the `agenthub-docs` CLI. Git runs read-only
//! through the CLI; without git (or outside a repo) only missing paths are reported. Doc
//! content is never logged or stored.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use globset::GlobBuilder;
use serde::{Deserialize, Serialize};

pub mod cli;
pub mod config;
mod git;
mod parse;
pub mod paths;
mod platform;

pub use config::CONFIG_REL;

/// At most this many docs are scanned by default (`truncated` when more exist).
pub const DEFAULT_MAX_DOCS: usize = 2000;
/// Docs larger than this are skipped (`truncated`).
pub const MAX_DOC_BYTES: u64 = 1024 * 1024;
/// Without git the folder walk stops after this many files (`truncated`).
const MAX_WALK_FILES: usize = 200_000;
const MAX_STALE_COMMITS: usize = 20;
const MAX_STALE_FILES: usize = 50;

#[derive(Debug, thiserror::Error)]
pub enum DocsError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{CONFIG_REL}:{line}: {message}")]
    InvalidConfig { line: u32, message: String },
    #[error("not a git repository")]
    NotARepo,
    #[error("the repository has no commit yet")]
    NoCommit,
    #[error("{0}")]
    Git(String),
    #[error("not a file in this repository")]
    UnknownDoc,
}

impl From<git::GitError> for DocsError {
    fn from(e: git::GitError) -> Self {
        DocsError::Git(e.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckOptions {
    pub max_docs: usize,
    /// `false`: behave as if git were missing (missing paths only).
    pub git: bool,
}

impl Default for CheckOptions {
    fn default() -> Self {
        CheckOptions { max_docs: DEFAULT_MAX_DOCS, git: true }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsReport {
    pub root: String,
    pub git_available: bool,
    pub head: Option<String>,
    /// `".kotilo/docs.toml"` when the file exists.
    pub config_path: Option<String>,
    /// Invalid docs.toml: the report is still built from the Markdown sources.
    pub config_error: Option<ConfigProblem>,
    /// Docs with at least one link; agent instruction files first, then by path.
    pub docs: Vec<DocDoc>,
    pub truncated: bool,
    pub summary: Summary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigProblem {
    /// 1-based; 0 when unknown.
    pub line: u32,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// All scanned docs (also those without links).
    pub docs: usize,
    /// Docs with a stale finding.
    pub stale: usize,
    /// Missing paths over all docs.
    pub missing: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkSource {
    Link,
    CodeBlock,
    Inline,
    Config,
    FrontMatter,
}

impl LinkSource {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkSource::Link => "link",
            LinkSource::CodeBlock => "codeBlock",
            LinkSource::Inline => "inline",
            LinkSource::Config => "config",
            LinkSource::FrontMatter => "frontMatter",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocLink {
    /// Repo-relative path or (config / front matter) glob.
    pub target: String,
    pub source: LinkSource,
    /// 1-based line in the doc; 0 for config entries.
    pub line: u32,
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocDoc {
    pub path: String,
    pub agent_file: bool,
    /// De-duplicated by (target, source); the first line is kept.
    pub links: Vec<DocLink>,
    pub missing: Vec<DocLink>,
    pub stale: Option<DocStale>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BaselineKind {
    Reviewed,
    LastTouch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocStale {
    pub baseline: String,
    pub baseline_kind: BaselineKind,
    /// The reviewed commit no longer exists (rebased away); the last touch was used instead.
    pub reviewed_missing: bool,
    /// Newest first, at most 20.
    pub commits: Vec<StaleCommit>,
    pub commit_count: usize,
    /// Changed covered files, most commits first, at most 50.
    pub files: Vec<StaleFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleCommit {
    pub id: String,
    pub subject: String,
    /// Committer date, ISO 8601.
    pub date: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleFile {
    pub path: String,
    pub commits: usize,
}

/// Agent instruction files: flagged and listed first.
pub fn is_agent_file(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    matches!(name, "CLAUDE.md" | "AGENTS.md")
        || matches!(rel, "GEMINI.md" | "QWEN.md" | "CLAUDE.local.md" | ".github/copilot-instructions.md")
}

fn is_markdown(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".mdx")
}

fn skipped_dir(rel: &str) -> bool {
    rel.starts_with(".kotilo/") || rel.split('/').any(|seg| seg == "node_modules")
}

/// What git can tell about `root`: `None` when git is missing or `root` is not in a work tree.
struct GitInfo {
    head: Option<String>,
}

fn git_info(root: &Path) -> Option<GitInfo> {
    match git::line(root, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(Some(t)) if t == "true" => {}
        _ => return None,
    }
    let head = git::line(root, &["rev-parse", "--verify", "-q", "HEAD^{commit}"]).ok().flatten();
    Some(GitInfo { head })
}

/// Repo files relative to `root`: tracked plus untracked-not-ignored (git), or a walk that
/// honours `.gitignore` (no git). `.kotilo/` and `.git/` are left out. Bool: walk cap hit.
fn list_files(root: &Path, with_git: bool) -> Result<(Vec<String>, bool), DocsError> {
    if with_git {
        let out = git::run(root, &["ls-files", "-co", "--exclude-standard", "-z"], None)?
            .ok_or_else(|| DocsError::Git("git ls-files failed".into()))?;
        let mut seen = HashSet::new();
        let mut files: Vec<String> = out
            .split(|b| *b == 0)
            .filter(|f| !f.is_empty())
            .map(|f| String::from_utf8_lossy(f).into_owned())
            .filter(|f| !f.starts_with(".kotilo/") && seen.insert(f.clone()))
            .collect();
        // Sorted: `Ctx::in_repo` binary-searches it (tracked and untracked come in two runs).
        files.sort();
        return Ok((files, false));
    }
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .parents(false)
        .require_git(false)
        .git_global(false)
        .filter_entry(|e| !matches!(e.file_name().to_str(), Some(".git" | ".kotilo" | "node_modules")))
        .build();
    let mut files = Vec::new();
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if files.len() >= MAX_WALK_FILES {
            return Ok((files, true));
        }
        if let Ok(rel) = entry.path().strip_prefix(root) {
            files.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    files.sort();
    Ok((files, false))
}

/// The folders containing `rel` (`a/b/c.md` → `a/b`, `a`).
fn ancestors(rel: &str) -> impl Iterator<Item = &str> {
    rel.match_indices('/').map(move |(i, _)| &rel[..i])
}

/// How a link is checked for staleness.
enum Spec {
    /// A file or folder.
    Path(String),
    /// A glob and the files it matches now.
    Glob(String, Vec<String>),
}

struct Resolved {
    link: DocLink,
    spec: Option<Spec>,
}

struct Ctx<'a> {
    root: &'a Path,
    files: &'a [String],
    /// Folders of `files`: a glob naming folders (`adapters/*`) exists too.
    dirs: Vec<String>,
}

impl Ctx<'_> {
    fn exists(&self, rel: &str) -> bool {
        self.root.join(rel).exists()
    }

    /// A file or folder git lists (tracked or untracked-not-ignored), so a local-only folder
    /// such as an ignored `.claude/` does not make prose mentions of other tools' paths count.
    fn in_repo(&self, rel: &str) -> bool {
        self.files.binary_search_by(|f| f.as_str().cmp(rel)).is_ok() || self.dirs.binary_search_by(|d| d.as_str().cmp(rel)).is_ok()
    }

    fn glob_matches(&self, matcher: &globset::GlobMatcher) -> Vec<String> {
        self.files.iter().filter(|f| matcher.is_match(f.as_str())).cloned().collect()
    }

    fn glob_exists(&self, matcher: &globset::GlobMatcher) -> bool {
        self.files.iter().chain(&self.dirs).any(|f| matcher.is_match(f.as_str()))
    }

    /// A covers entry from docs.toml or front matter: literal path or glob, repo-relative.
    fn cover(&self, pattern: &str, source: LinkSource, line: u32) -> Option<Resolved> {
        let normalized = pattern.trim().replace('\\', "/");
        let normalized = normalized.trim_start_matches("./").trim_start_matches('/').trim_end_matches('/');
        if normalized.is_empty() {
            return None;
        }
        if !paths::is_glob(normalized) {
            let rel = paths::normalize_rel(normalized)?;
            let exists = self.exists(&rel);
            return Some(Resolved { link: DocLink { target: rel.clone(), source, line, exists }, spec: Some(Spec::Path(rel)) });
        }
        let glob = GlobBuilder::new(normalized).literal_separator(true).build().ok().map(|g| g.compile_matcher());
        let (matches, exists) = match &glob {
            Some(m) => (self.glob_matches(m), self.glob_exists(m)),
            None => (Vec::new(), false),
        };
        let link = DocLink { target: normalized.to_string(), source, line, exists };
        Some(Resolved { link, spec: glob.map(|_| Spec::Glob(normalized.to_string(), matches)) })
    }

    fn resolve(&self, doc: &str, raw: parse::RawLink) -> Option<Resolved> {
        let dir = paths::parent(doc);
        match raw.source {
            LinkSource::Link => {
                let target = clean_link_target(&raw.target)?;
                let rel = paths::resolve(dir, &target)?;
                (rel != doc).then(|| self.path_link(rel, raw.source, raw.line))
            }
            LinkSource::CodeBlock => {
                let rel = paths::normalize_rel(&raw.target)?;
                (rel != doc).then(|| self.path_link(rel, raw.source, raw.line))
            }
            LinkSource::Inline => {
                // A wildcard in prose is a pattern, not a reference to a file.
                if raw.target.contains('*') {
                    return None;
                }
                let first = raw.target.split('/').next().unwrap_or("");
                let rel = if !matches!(first, "." | "..") && self.in_repo(first) {
                    paths::normalize_rel(&raw.target)?
                } else if !dir.is_empty() && (matches!(first, "." | "..") || self.in_repo(&format!("{dir}/{first}"))) {
                    paths::resolve(dir, &raw.target)?
                } else {
                    return None;
                };
                // The config file is optional: docs that explain it are not wrong without one.
                if rel == CONFIG_REL {
                    return None;
                }
                let exists = self.exists(&rel);
                Some(Resolved { link: DocLink { target: rel, source: raw.source, line: raw.line, exists }, spec: None })
            }
            LinkSource::FrontMatter | LinkSource::Config => self.cover(&raw.target, raw.source, raw.line),
        }
    }

    fn path_link(&self, rel: String, source: LinkSource, line: u32) -> Resolved {
        let exists = self.exists(&rel);
        Resolved { link: DocLink { target: rel.clone(), source, line, exists }, spec: Some(Spec::Path(rel)) }
    }
}

/// A Markdown link target as a path: `None` for schemes (`http:`, `mailto:`), protocol-relative
/// URLs and pure anchors; `#…` / `?…` stripped, percent-decoded.
fn clean_link_target(target: &str) -> Option<String> {
    let target = target.trim();
    if target.is_empty() || target.starts_with('#') || target.starts_with("//") {
        return None;
    }
    let before_slash = target.split('/').next().unwrap_or("");
    if before_slash.contains(':') {
        return None;
    }
    let end = target.find(['#', '?']).unwrap_or(target.len());
    let path = &target[..end];
    if path.is_empty() {
        return None;
    }
    Some(percent_encoding::percent_decode_str(path).decode_utf8_lossy().into_owned())
}

/// Drops missing inline-code paths that git ignores (`target/…`, `.kotilo/…`, local settings):
/// they name local files that are not meant to be in the repo, so they are not doc errors.
fn drop_ignored_inline(root: &Path, docs: &mut Vec<DocDoc>) {
    let mut candidates: Vec<&str> = docs
        .iter()
        .flat_map(|d| d.missing.iter())
        .filter(|l| l.source == LinkSource::Inline)
        .map(|l| l.target.as_str())
        .collect();
    candidates.sort_unstable();
    candidates.dedup();
    if candidates.is_empty() {
        return;
    }
    let input: Vec<u8> = candidates.iter().flat_map(|c| c.bytes().chain([0])).collect();
    // Exit 1 (nothing ignored) comes back as `None`, like any failure: then nothing is dropped.
    let Ok(Some(out)) = git::run(root, &["check-ignore", "--stdin", "-z"], Some(&input)) else {
        return;
    };
    let ignored: HashSet<String> =
        out.split(|b| *b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect();
    let keep = |l: &DocLink| !(l.source == LinkSource::Inline && !l.exists && ignored.contains(&l.target));
    for doc in docs.iter_mut() {
        doc.links.retain(keep);
        doc.missing.retain(keep);
    }
    docs.retain(|d| !d.links.is_empty());
}

/// Git pathspecs for the doc's stale-relevant links (all sources except inline code).
fn stale_pathspecs(doc: &str, links: &[Resolved]) -> Vec<String> {
    let mut specs: Vec<String> = Vec::new();
    let mut push = |s: String| {
        if !specs.contains(&s) {
            specs.push(s);
        }
    };
    for resolved in links {
        match &resolved.spec {
            // A Markdown link to another doc is navigation, not code the doc describes.
            Some(Spec::Path(p)) if resolved.link.source == LinkSource::Link && is_markdown(p) => {}
            Some(Spec::Path(p)) if p != doc => push(format!(":(literal){p}")),
            Some(Spec::Glob(pattern, matches)) => {
                if pattern.contains('{') {
                    // Git's glob magic has no braces: use today's matches.
                    for m in matches {
                        push(format!(":(literal){m}"));
                    }
                } else {
                    push(format!(":(glob){pattern}"));
                }
            }
            _ => {}
        }
    }
    specs
}

fn is_commit_id(s: &str) -> bool {
    (4..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn staleness(root: &Path, head: &str, doc: &str, reviewed: Option<&str>, specs: &[String]) -> Result<Option<DocStale>, DocsError> {
    if specs.is_empty() {
        return Ok(None);
    }
    let mut reviewed_missing = false;
    let mut baseline = None;
    if let Some(r) = reviewed {
        let found = if is_commit_id(r) {
            git::line(root, &["rev-parse", "--verify", "-q", "--end-of-options", &format!("{r}^{{commit}}")])?
        } else {
            None
        };
        match found {
            Some(full) => baseline = Some((full, BaselineKind::Reviewed)),
            None => reviewed_missing = true,
        }
    }
    let (baseline, baseline_kind) = match baseline {
        Some(b) => b,
        None => match git::line(root, &["log", "-1", "--format=%H", "--", &format!(":(literal){doc}")])? {
            Some(commit) => (commit, BaselineKind::LastTouch),
            // Never committed: baseline HEAD, so not stale.
            None => return Ok(None),
        },
    };
    if baseline == head {
        return Ok(None);
    }
    // Pathspecs go through stdin (`--stdin` after `--`): no command-line length limit.
    let mut input = String::from("--\n");
    for spec in specs {
        input.push_str(spec);
        input.push('\n');
    }
    // The doc itself and the config never make a doc stale (a glob may cover them).
    input.push_str(&format!(":(exclude,literal){doc}\n:(exclude,literal){CONFIG_REL}\n"));
    let range = format!("{baseline}..{head}");
    let out = git::run(
        root,
        &["log", "--no-merges", "--relative", "--name-only", "--format=%x1e%H%x1f%s%x1f%cI", "--stdin", &range],
        Some(input.as_bytes()),
    )?
    .ok_or_else(|| DocsError::Git(format!("git log failed for {doc}")))?;
    let text = String::from_utf8_lossy(&out);
    let mut commits = Vec::new();
    let mut commit_count = 0;
    let mut file_counts: BTreeMap<String, usize> = BTreeMap::new();
    for record in text.split('\u{1e}') {
        let mut lines = record.lines();
        let Some(header) = lines.next().filter(|h| !h.trim().is_empty()) else { continue };
        let mut fields = header.split('\u{1f}');
        let (Some(id), Some(subject), Some(date)) = (fields.next(), fields.next(), fields.next()) else { continue };
        commit_count += 1;
        if commits.len() < MAX_STALE_COMMITS {
            commits.push(StaleCommit { id: id.to_string(), subject: subject.to_string(), date: date.trim().to_string() });
        }
        for name in lines.map(str::trim).filter(|l| !l.is_empty()) {
            *file_counts.entry(git::unquote(name)).or_default() += 1;
        }
    }
    if commit_count == 0 {
        return Ok(None);
    }
    let mut files: Vec<StaleFile> = file_counts.into_iter().map(|(path, commits)| StaleFile { path, commits }).collect();
    files.sort_by(|a, b| b.commits.cmp(&a.commits).then_with(|| a.path.cmp(&b.path)));
    files.truncate(MAX_STALE_FILES);
    Ok(Some(DocStale { baseline, baseline_kind, reviewed_missing, commits, commit_count, files }))
}

/// Scans the docs under `root` (the repo's top level or a folder without git).
pub fn check(root: &Path, opts: &CheckOptions) -> Result<DocsReport, DocsError> {
    if !root.is_dir() {
        return Err(DocsError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, "root is not a folder")));
    }
    let git = if opts.git { git_info(root) } else { None };
    let config_text = config::read_text(root)?;
    let (config_docs, config_error) = match config_text.as_deref().map(config::parse) {
        None => (Vec::new(), None),
        Some(Ok(docs)) => (docs, None),
        Some(Err(problem)) => (Vec::new(), Some(problem)),
    };

    let (files, mut truncated) = list_files(root, git.is_some())?;
    let mut doc_paths: Vec<String> = files.iter().filter(|f| is_markdown(f) && !skipped_dir(f)).cloned().collect();
    for entry in &config_docs {
        if !doc_paths.contains(&entry.path) && root.join(&entry.path).is_file() {
            doc_paths.push(entry.path.clone());
        }
    }
    doc_paths.sort_by(|a, b| is_agent_file(b).cmp(&is_agent_file(a)).then_with(|| a.cmp(b)));
    if doc_paths.len() > opts.max_docs {
        doc_paths.truncate(opts.max_docs);
        truncated = true;
    }

    let mut dirs: Vec<String> = files.iter().flat_map(|f| ancestors(f)).map(str::to_string).collect();
    dirs.sort_unstable();
    dirs.dedup();
    let ctx = Ctx { root, files: &files, dirs };
    let mut docs = Vec::new();
    let mut scanned = 0;
    for rel in &doc_paths {
        let path = root.join(rel);
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if !meta.is_file() {
            continue;
        }
        if meta.len() > MAX_DOC_BYTES {
            truncated = true;
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        scanned += 1;
        let text = String::from_utf8_lossy(&bytes);
        let entry = config_docs.iter().find(|d| &d.path == rel);
        let mut raws = parse::extract(&text);
        if let Some(entry) = entry {
            raws.extend(entry.covers.iter().map(|c| parse::RawLink { target: c.clone(), source: LinkSource::Config, line: 0 }));
        }
        let mut seen = HashSet::new();
        let resolved: Vec<Resolved> = raws
            .into_iter()
            .filter_map(|raw| ctx.resolve(rel, raw))
            .filter(|r| seen.insert((r.link.target.clone(), r.link.source)))
            .collect();
        if resolved.is_empty() {
            continue;
        }
        let stale = match git.as_ref().and_then(|g| g.head.as_deref()) {
            Some(head) => {
                let specs = stale_pathspecs(rel, &resolved);
                staleness(root, head, rel, entry.and_then(|e| e.reviewed.as_deref()), &specs)?
            }
            None => None,
        };
        let links: Vec<DocLink> = resolved.into_iter().map(|r| r.link).collect();
        let missing = links.iter().filter(|l| !l.exists).cloned().collect();
        docs.push(DocDoc { path: rel.clone(), agent_file: is_agent_file(rel), links, missing, stale });
    }

    if git.is_some() {
        drop_ignored_inline(root, &mut docs);
    }

    let summary = Summary {
        docs: scanned,
        stale: docs.iter().filter(|d| d.stale.is_some()).count(),
        missing: docs.iter().map(|d| d.missing.len()).sum(),
    };
    Ok(DocsReport {
        root: root.to_string_lossy().into_owned(),
        git_available: git.is_some(),
        head: git.and_then(|g| g.head),
        config_path: config_text.is_some().then(|| CONFIG_REL.to_string()),
        config_error,
        docs,
        truncated,
        summary,
    })
}

/// "Mark reviewed": stores the full `HEAD` commit as the doc's `reviewed` in
/// `.kotilo/docs.toml` (creating the file / entry) and returns it.
pub fn mark_reviewed(root: &Path, doc_rel: &str) -> Result<String, DocsError> {
    let rel = paths::normalize_rel(doc_rel).ok_or(DocsError::UnknownDoc)?;
    if !root.join(&rel).is_file() {
        return Err(DocsError::UnknownDoc);
    }
    match git::line(root, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(Some(t)) if t == "true" => {}
        Ok(_) | Err(git::GitError::NotInstalled) => return Err(DocsError::NotARepo),
        Err(e) => return Err(e.into()),
    }
    let head = git::line(root, &["rev-parse", "--verify", "-q", "HEAD^{commit}"])?.ok_or(DocsError::NoCommit)?;
    config::set_reviewed(root, &rel, &head)?;
    Ok(head)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_files_and_markdown() {
        for f in ["CLAUDE.md", "AGENTS.md", "GEMINI.md", "QWEN.md", "CLAUDE.local.md", ".github/copilot-instructions.md", "apps/x/CLAUDE.md", "a/AGENTS.md"] {
            assert!(is_agent_file(f), "{f}");
        }
        for f in ["README.md", "docs/GEMINI.md", "claude.md"] {
            assert!(!is_agent_file(f), "{f}");
        }
        assert!(is_markdown("a/B.MD") && is_markdown("x.mdx") && !is_markdown("x.txt"));
        assert!(skipped_dir(".kotilo/worktrees/a/README.md") && skipped_dir("web/node_modules/p/README.md"));
        assert!(!skipped_dir("docs/a.md"));
    }

    #[test]
    fn link_targets_are_cleaned() {
        assert_eq!(clean_link_target("src/a.rs#L10").as_deref(), Some("src/a.rs"));
        assert_eq!(clean_link_target("a%20b.md?x=1").as_deref(), Some("a b.md"));
        for skip in ["https://x.dev/a", "mailto:a@b", "#anchor", "//cdn/x", "C:/abs", ""] {
            assert_eq!(clean_link_target(skip), None, "{skip}");
        }
    }

    #[test]
    fn serializes_to_the_contract() {
        let report = DocsReport {
            root: "r".into(),
            git_available: true,
            head: None,
            config_path: None,
            config_error: Some(ConfigProblem { line: 2, message: "m".into() }),
            docs: vec![DocDoc {
                path: "a.md".into(),
                agent_file: false,
                links: vec![DocLink { target: "x".into(), source: LinkSource::CodeBlock, line: 1, exists: false }],
                missing: vec![],
                stale: Some(DocStale {
                    baseline: "b".into(),
                    baseline_kind: BaselineKind::LastTouch,
                    reviewed_missing: false,
                    commits: vec![StaleCommit { id: "i".into(), subject: "s".into(), date: "d".into() }],
                    commit_count: 1,
                    files: vec![StaleFile { path: "p".into(), commits: 1 }],
                }),
            }],
            truncated: false,
            summary: Summary { docs: 1, stale: 1, missing: 0 },
        };
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            serde_json::json!({
                "root": "r", "gitAvailable": true, "head": null, "configPath": null,
                "configError": {"line": 2, "message": "m"},
                "docs": [{
                    "path": "a.md", "agentFile": false,
                    "links": [{"target": "x", "source": "codeBlock", "line": 1, "exists": false}],
                    "missing": [],
                    "stale": {
                        "baseline": "b", "baselineKind": "lastTouch", "reviewedMissing": false,
                        "commits": [{"id": "i", "subject": "s", "date": "d"}], "commitCount": 1,
                        "files": [{"path": "p", "commits": 1}]
                    }
                }],
                "truncated": false,
                "summary": {"docs": 1, "stale": 1, "missing": 0}
            })
        );
        for s in [LinkSource::Link, LinkSource::CodeBlock, LinkSource::Inline, LinkSource::Config, LinkSource::FrontMatter] {
            assert_eq!(serde_json::to_value(s).unwrap(), serde_json::json!(s.as_str()));
        }
    }
}
