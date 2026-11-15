//! File discovery for instruction and rule sources: names in walked directories, nested
//! on-demand matches, globs, `@path` imports and rule front matter.

use std::path::{Path, PathBuf};

use crate::adapters::{ContextLoaded, ContextPick};

use super::skills::front_matter;
use super::Env;

/// Nested matches and glob matches stop at this many files.
pub const MAX_MATCHES: usize = 200;
/// A walk visits at most this many entries.
const MAX_VISITED: usize = 50_000;
const MAX_DEPTH: usize = 24;
/// Never descended into.
const SKIP_DIRS: [&str; 3] = [".git", "node_modules", "target"];

/// `names` looked up in each of `dirs` (outermost first).
pub fn names_in_dirs(dirs: &[PathBuf], names: &[String], pick: ContextPick) -> Vec<PathBuf> {
    let existing = |dir: &Path| -> Vec<PathBuf> {
        names.iter().map(|n| super::join_native(dir, n)).filter(|p| p.is_file()).collect()
    };
    match pick {
        ContextPick::All => dirs.iter().flat_map(|d| existing(d)).collect(),
        ContextPick::First => dirs.iter().filter_map(|d| existing(d).into_iter().next()).collect(),
        ContextPick::Nearest => dirs.iter().rev().find_map(|d| existing(d).into_iter().next()).into_iter().collect(),
    }
}

fn walker(dir: &Path, gitignore: bool) -> ignore::Walk {
    ignore::WalkBuilder::new(dir)
        .standard_filters(gitignore)
        .hidden(false)
        .require_git(false)
        .follow_links(false)
        .max_depth(Some(MAX_DEPTH))
        .sort_by_file_name(|a, b| a.cmp(b))
        .filter_entry(|e| !e.file_type().is_some_and(|t| t.is_dir()) || !SKIP_DIRS.iter().any(|s| e.file_name() == *s))
        .build()
}

/// Files below `dir` (relative path with `/`) for which `keep` holds, capped.
fn walk_files(dir: &Path, gitignore: bool, keep: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in walker(dir, gitignore).take(MAX_VISITED).filter_map(Result::ok) {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(dir) else { continue };
        if keep(&rel.to_string_lossy().replace('\\', "/")) {
            out.push(entry.into_path());
            if out.len() >= MAX_MATCHES {
                break;
            }
        }
    }
    out
}

/// Files named like one of `names` in subdirectories of the workspace (`.gitignore`
/// respected, `.git`/`node_modules`/`target` skipped, capped). The root's own files are
/// left out: the walk already covers them.
pub fn nested_matches(env: &Env, names: &[String]) -> Vec<PathBuf> {
    walk_files(&env.root, true, |rel| {
        names.iter().any(|n| {
            let n = n.replace('\\', "/");
            rel.len() > n.len() + 1 && rel.ends_with(&n) && rel.as_bytes()[rel.len() - n.len() - 1] == b'/'
        })
    })
}

/// Files matching `glob` (relative to the root, or `~/…`), sorted, capped.
pub fn glob_matches(env: &Env, glob: &str) -> Vec<PathBuf> {
    let (prefix, rest) = match glob.strip_prefix("~/") {
        Some(r) => ("~/", r),
        None => ("", glob),
    };
    let segments: Vec<&str> = rest.split('/').collect();
    let literal = segments.iter().take_while(|s| !s.contains(['*', '?', '[', '{'])).count();
    let base = format!("{prefix}{}", segments[..literal].join("/"));
    let pattern = segments[literal..].join("/");
    let Some(base) = env.resolve(if base.is_empty() { "." } else { &base }) else { return Vec::new() };
    if pattern.is_empty() {
        return Some(base).filter(|p| p.is_file()).into_iter().collect();
    }
    if !base.is_dir() {
        return Vec::new();
    }
    let Ok(matcher) = globset::GlobBuilder::new(&pattern).literal_separator(true).build().map(|g| g.compile_matcher())
    else {
        return Vec::new();
    };
    walk_files(&base, false, |rel| matcher.is_match(rel))
}

/// `@path` imports of a Markdown file: tokens that start with `@` after whitespace or at
/// the start of a line, outside code fences and inline code. E-mail addresses never
/// match (their `@` follows a letter).
pub fn import_refs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut fence: Option<&str> = None;
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(f) = fence {
            if t.starts_with(f) {
                fence = None;
            }
            continue;
        }
        if let Some(f) = ["```", "~~~"].into_iter().find(|f| t.starts_with(f)) {
            fence = Some(f);
            continue;
        }
        let mut in_code = false;
        let plain: String = line
            .chars()
            .map(|ch| {
                if ch == '`' {
                    in_code = !in_code;
                    ' '
                } else if in_code {
                    ' '
                } else {
                    ch
                }
            })
            .collect();
        for token in plain.split_whitespace() {
            let Some(path) = token.strip_prefix('@') else { continue };
            let path = path.trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']', '"', '\'']);
            if !path.is_empty() && !path.contains('@') {
                out.push(path.to_string());
            }
        }
    }
    out
}

/// How a rule file is loaded according to its front matter: Cursor `alwaysApply`,
/// Claude `paths`, Copilot `applyTo` (anything but `**` is conditional). `None` = the
/// source's default.
pub fn rule_loaded(text: &str) -> Option<ContextLoaded> {
    let fm = front_matter(text)?;
    let get = |k: &str| fm.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
    match get("alwaysApply") {
        Some("true") => return Some(ContextLoaded::Always),
        Some("false") => return Some(ContextLoaded::OnDemand),
        _ => {}
    }
    if get("paths").is_some() {
        return Some(ContextLoaded::OnDemand);
    }
    get("applyTo").map(|v| {
        if matches!(v, "**" | "**/*") {
            ContextLoaded::Always
        } else {
            ContextLoaded::OnDemand
        }
    })
}
