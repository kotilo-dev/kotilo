//! Repo-relative path handling: everything is `/`-separated; `\` from Windows-style text is
//! accepted on input.

/// Joins `target` onto the repo-relative folder `base_dir` and normalizes `.`/`..`. A target
/// starting with `/` is repo-root relative. `None` when it leaves the repo, names the root
/// itself or looks like an absolute OS path (`C:`).
pub fn resolve(base_dir: &str, target: &str) -> Option<String> {
    let target = target.replace('\\', "/");
    let (base, rest) = match target.strip_prefix('/') {
        Some(rest) => ("", rest.to_string()),
        None => (base_dir, target),
    };
    if rest.split('/').next().is_some_and(|first| first.contains(':')) {
        return None;
    }
    let mut out: Vec<&str> = Vec::new();
    for seg in base.split('/').chain(rest.split('/')) {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            s => out.push(s),
        }
    }
    (!out.is_empty()).then(|| out.join("/"))
}

/// A repo-relative path from config / front matter / CLI input (`./a`, `/a`, `a\b` accepted).
pub fn normalize_rel(path: &str) -> Option<String> {
    resolve("", path.trim())
}

/// The folder part of a repo-relative path (`""` for a root file).
pub fn parent(rel: &str) -> &str {
    rel.rfind('/').map(|i| &rel[..i]).unwrap_or("")
}

/// `path` equals `cover` or lies under the folder `cover`.
pub fn is_under(path: &str, cover: &str) -> bool {
    path == cover || (path.len() > cover.len() && path.starts_with(cover) && path.as_bytes()[cover.len()] == b'/')
}

/// Whether a covers pattern needs glob matching.
pub fn is_glob(pattern: &str) -> bool {
    pattern.contains(['*', '?', '[', '{'])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_rooted_and_windows_paths() {
        assert_eq!(resolve("docs", "../src/a.rs").as_deref(), Some("src/a.rs"));
        assert_eq!(resolve("docs/sub", "./x/../y.md").as_deref(), Some("docs/sub/y.md"));
        assert_eq!(resolve("docs", "/hub/x.cs").as_deref(), Some("hub/x.cs"));
        assert_eq!(resolve("docs", "..\\src\\win.rs").as_deref(), Some("src/win.rs"));
        assert_eq!(resolve("", "a//b/").as_deref(), Some("a/b"));
        assert_eq!(resolve("docs", "../../outside.md"), None);
        assert_eq!(resolve("docs", ".."), None);
        assert_eq!(resolve("", "C:/Users/x"), None);
        assert_eq!(normalize_rel(" ./docs\\a.md ").as_deref(), Some("docs/a.md"));
        assert_eq!(parent("docs/a.md"), "docs");
        assert_eq!(parent("a.md"), "");
    }

    #[test]
    fn under_and_glob() {
        assert!(is_under("src/a.rs", "src"));
        assert!(is_under("src", "src"));
        assert!(!is_under("srcx/a.rs", "src"));
        assert!(is_glob("hub/**") && is_glob("a?.rs") && !is_glob("plain/path.rs"));
    }
}
