//! M5 brand switch guard: identity values live in `brand.json` only. Fails when product
//! source code (Rust, C#, TypeScript, JavaScript, HTML, JSON) spells one of today's identity
//! literals outside comments, tests and the small allowlist below. Renaming the product is
//! then an edit of `brand.json` (plus the checked `tauri.conf.json`), not a hunt.

use std::fs;
use std::path::{Path, PathBuf};

/// Today's identity values and the working-name ones (`legacy`) that must come from `brand.json`.
const IDENTITY_LITERALS: [&str; 6] = [
    "kotilo-hook",
    "dev.kotilo.app",
    "kotilo-dev/kotilo",
    "agent-hub",
    "agenthub-hook",
    "dev.agenthub.app",
];

/// Files that may spell them, each for a stated reason (paths relative to the repo root).
const ALLOWED_FILES: [(&str, &str); 3] = [
    ("brand.json", "the single source"),
    (
        "apps/desktop/src-tauri/tauri.conf.json",
        "read by Tauri itself; build.rs fails the build when it differs from brand.json",
    ),
    (
        "apps/desktop/src-tauri/build.rs",
        "the cargo package/binary name `agenthub-hook` is an internal crate name",
    ),
];

/// Folders that are not product source: docs, tests, fixtures, published schema ids, build output.
const SKIPPED_DIRS: [&str; 17] = [
    ".git",
    ".claude",
    "target",
    "node_modules",
    "bin",
    "obj",
    "dist",
    "docs",
    "tasks",
    "tests",
    "e2e",
    "fixtures",
    "schema",
    "binaries",
    "gen",
    "test-results",
    "playwright-report",
];

const SCANNED_EXTENSIONS: [&str; 9] = ["rs", "cs", "ts", "tsx", "js", "mjs", "html", "json", "csproj"];

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn is_test_file(name: &str) -> bool {
    name.contains(".test.") || name.contains(".spec.") || name.ends_with("Tests.cs") || name.ends_with("-lock.json")
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if !SKIPPED_DIRS.contains(&name.as_str()) {
                collect(&path, out);
            }
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| SCANNED_EXTENSIONS.contains(&e))
            && !is_test_file(&name)
        {
            out.push(path);
        }
    }
}

fn is_comment(line: &str) -> bool {
    let t = line.trim_start();
    ["//", "/*", "*", "#", "<!--"].iter().any(|p| t.starts_with(p))
}

/// `file:line: text` for every identity literal in code lines of `text`. Rust files stop at
/// their `#[cfg(test)]` module (tests sit at the bottom of the file by convention).
fn offending_lines(rel: &str, text: &str) -> Vec<String> {
    let mut hits = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if rel.ends_with(".rs") && line.trim_start().starts_with("#[cfg(test)]") {
            break;
        }
        if is_comment(line) {
            continue;
        }
        if IDENTITY_LITERALS.iter().any(|lit| line.contains(lit)) {
            hits.push(format!("{rel}:{}: {}", i + 1, line.trim()));
        }
    }
    hits
}

#[test]
fn identity_literals_come_from_brand_json_only() {
    let root = repo_root();
    let mut files = Vec::new();
    collect(&root, &mut files);
    assert!(files.len() > 100, "the scan found only {} files; is the repo root right?", files.len());

    let mut hits = Vec::new();
    for path in files {
        let rel = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if ALLOWED_FILES.iter().any(|(allowed, _)| *allowed == rel) {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&path) {
            hits.extend(offending_lines(&rel, &text));
        }
    }
    assert!(
        hits.is_empty(),
        "identity literals outside brand.json (use the brand consts, or add an allowlist entry with a reason):\n{}",
        hits.join("\n")
    );
}

#[test]
fn the_guard_sees_code_and_ignores_comments_and_rust_tests() {
    let text = "// agent-hub in a comment\nlet x = \"agent-hub\";\n#[cfg(test)]\nlet y = \"agenthub-hook\";\n";
    assert_eq!(offending_lines("a.rs", text), vec!["a.rs:2: let x = \"agent-hub\";".to_string()]);
    assert_eq!(offending_lines("a.ts", text).len(), 2, "only Rust files stop at #[cfg(test)]");
}

#[test]
fn allowlist_entries_exist() {
    for (path, _) in ALLOWED_FILES {
        assert!(repo_root().join(path).is_file(), "allowlisted {path} does not exist");
    }
}
