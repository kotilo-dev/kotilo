//! Skills: `<dir>/<name>/SKILL.md` with YAML-ish front matter (`name`, `description`).

use std::collections::HashSet;
use std::path::PathBuf;

use crate::adapters::{ContextWalk, SkillDirDef};

use super::{estimate_tokens, read_capped, ContextSkill, Env};

/// Skill folders read per directory.
const MAX_SKILLS_PER_DIR: usize = 500;
/// Only the start of `SKILL.md` is read for the front matter.
const FRONT_MATTER_BYTES: usize = 16 * 1024;

/// Top-level `key: value` pairs between a leading `---` line and the next `---`. Quotes
/// are stripped; a block scalar (`>`/`|`) or indented continuation lines are joined with
/// spaces; list items under a key (`- x`) are joined with `, `. Not a YAML parser.
pub fn front_matter(text: &str) -> Option<Vec<(String, String)>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let mut out: Vec<(String, String)> = Vec::new();
    for line in lines {
        if line.trim_end() == "---" {
            return Some(out);
        }
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indented = line.starts_with([' ', '\t']);
        if indented || line.starts_with("- ") {
            if let Some((_, value)) = out.last_mut() {
                let part = line.trim();
                let (part, sep) = match part.strip_prefix("- ") {
                    Some(item) => (unquote(item), ", "),
                    None => (part.to_string(), " "),
                };
                if !value.is_empty() {
                    value.push_str(sep);
                }
                value.push_str(&part);
            }
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let value = value.trim();
            let value = if matches!(value, ">" | "|" | ">-" | "|-" | ">+" | "|+") { String::new() } else { unquote(value) };
            out.push((key.trim().to_string(), value));
        }
    }
    None
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    for q in ['"', '\''] {
        if v.len() >= 2 && v.starts_with(q) && v.ends_with(q) {
            return v[1..v.len() - 1].to_string();
        }
    }
    v.to_string()
}

fn skill_dirs(env: &Env, def: &SkillDirDef) -> Vec<PathBuf> {
    let home_or_abs = def.dir.starts_with('~') || std::path::Path::new(&def.dir).is_absolute();
    match def.walk {
        Some(ContextWalk::Repo) if !home_or_abs => {
            env.walk_dirs(ContextWalk::Repo).iter().filter_map(|d| env.resolve_from(&def.dir, d)).collect()
        }
        _ => env.resolve(&def.dir).into_iter().collect(),
    }
}

pub fn collect(env: &Env, defs: &[SkillDirDef]) -> Vec<ContextSkill> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for def in defs {
        for dir in skill_dirs(env, def) {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            let mut folders: Vec<(String, PathBuf)> = entries
                .filter_map(Result::ok)
                .filter(|e| e.path().is_dir())
                .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path().join("SKILL.md")))
                .filter(|(_, p)| p.is_file())
                .collect();
            folders.sort();
            for (folder, path) in folders.into_iter().take(MAX_SKILLS_PER_DIR) {
                if !seen.insert(env.key(&path)) {
                    continue;
                }
                let fm = read_capped(&path, FRONT_MATTER_BYTES).ok().and_then(|t| front_matter(&t.text)).unwrap_or_default();
                let get = |k: &str| fm.iter().find(|(key, v)| key == k && !v.is_empty()).map(|(_, v)| v.clone());
                let name = get("name").unwrap_or(folder);
                let description = get("description");
                let tokens = estimate_tokens(&format!("{name}{}", description.as_deref().unwrap_or_default()));
                out.push(ContextSkill {
                    scope: def.scope,
                    name,
                    description,
                    path: path.to_string_lossy().into_owned(),
                    display: env.display(&path),
                    rel: env.rel(&path),
                    tokens,
                });
            }
        }
    }
    out
}
