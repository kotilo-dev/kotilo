//! Workspace-root-relative path resolution and name validation (Faz 2 spec §2, §5, §8.7).
//!
//! IPC addresses files as `(workspaceId, rel)`, `rel` being `/`-separated and relative to
//! the workspace root (`""` = the root itself). [`resolve`] turns such a `rel` into an
//! absolute path that is guaranteed to exist and to sit under the workspace root — even
//! once symlinks/junctions are followed, which is why the escape check re-canonicalizes
//! both sides with `std::fs::canonicalize` (not `dunce`, which only cosmetically strips
//! the `\\?\` prefix and would not catch a junction pointing outside the root).

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Windows reserved device names (checked against the name's stem, i.e. the part before
/// the first `.` — `NUL.txt` is just as reserved as `NUL`).
const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
    "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

const FORBIDDEN_CHARS: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

/// Validates a single path *segment* (a file or directory name, never a `rel` path).
pub fn validate_name(name: &str) -> AppResult<()> {
    if name.is_empty() {
        return Err(AppError::invalid_name("name must not be empty"));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(AppError::invalid_name(
            "name must not end with a dot or space",
        ));
    }
    if name
        .chars()
        .any(|c| FORBIDDEN_CHARS.contains(&c) || c.is_control())
    {
        return Err(AppError::invalid_name("name contains an invalid character"));
    }
    let stem = name.split('.').next().unwrap_or(name);
    if RESERVED_NAMES.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return Err(AppError::invalid_name(
            "name is a reserved Windows device name",
        ));
    }
    Ok(())
}

/// Builds the lexical (not yet existence/escape-checked) path for `rel` under `root`.
///
/// Rejects an absolute-looking `rel`, `..` components, and segments that still carry a
/// Windows drive letter or backslash (defense in depth against a caller that built `rel`
/// from a raw Windows path instead of following the `/`-separated contract).
///
/// Only the whole-`rel`-is-empty case (`""`, meaning "the workspace root itself") is
/// allowed to resolve to `root`. A `.` component, or an empty component from a doubled
/// separator (e.g. `a//b`), is otherwise rejected rather than silently skipped — silently
/// skipping them let `rel` values like `"."`, `"./"`, or `"./."` also resolve to `root`,
/// which bypassed the `rel.is_empty()` root guard in `fs_delete`/`fs_rename`.
pub(crate) fn join_rel(root: &Path, rel: &str) -> AppResult<PathBuf> {
    if rel.is_empty() {
        return Ok(root.to_path_buf());
    }
    if rel.starts_with('/') || rel.starts_with('\\') {
        return Err(AppError::outside_workspace("rel must not be an absolute path"));
    }
    let mut candidate = root.to_path_buf();
    for component in rel.split('/') {
        if component.is_empty() {
            return Err(AppError::outside_workspace(
                "rel must not contain an empty component",
            ));
        }
        if component == "." {
            return Err(AppError::outside_workspace("rel must not contain a '.' component"));
        }
        if component == ".." {
            return Err(AppError::outside_workspace("rel must not contain a '..' component"));
        }
        if component.contains('\\') || component.contains(':') {
            return Err(AppError::outside_workspace("rel must use '/' as a separator"));
        }
        candidate.push(component);
    }
    Ok(candidate)
}

/// `path`'s `/`-separated path relative to `root` (`""` for the root itself), or `None`
/// if it isn't under `root`. Windows paths are case-insensitive, so the comparison is
/// done **component by component**: slicing the original string by the length of a
/// lowercased prefix would misalign on characters whose lowercase form has a different
/// length (Turkish `İ` → `i̇`).
pub fn rel_under_ci(root: &Path, path: &Path) -> Option<String> {
    let mut path_parts = path.components();
    for root_part in root.components() {
        let path_part = path_parts.next()?;
        if root_part.as_os_str().to_string_lossy().to_lowercase()
            != path_part.as_os_str().to_string_lossy().to_lowercase()
        {
            return None;
        }
    }
    let rest: Vec<String> = path_parts
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(rest.join("/"))
}

/// Case-insensitive "is `candidate` at or under `root`" check on two already-canonical
/// paths (both produced by `std::fs::canonicalize`, so both carry the same `\\?\` style
/// prefix).
fn is_under_root_ci(candidate: &Path, root: &Path) -> bool {
    rel_under_ci(root, candidate).is_some()
}

/// Resolves `rel` under `root` to an absolute path. The target **must already exist**
/// (`not_found` otherwise) and must resolve, after canonicalization, under the
/// canonicalized `root` (`outside_workspace` otherwise — this is what catches a
/// symlink/junction planted inside the workspace that points outside it).
///
/// Callers that need to create a *new* entry resolve the parent directory with this
/// function (which must already exist) and then `.join()` the validated new name onto
/// the result — the parent's canonicalization is what the spec calls out explicitly.
pub fn resolve(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let candidate = join_rel(root, rel)?;
    if !candidate.exists() {
        return Err(AppError::not_found(format!("not found: {rel}")));
    }
    let canon_root = std::fs::canonicalize(root)?;
    let canon_candidate = std::fs::canonicalize(&candidate)?;
    if !is_under_root_ci(&canon_candidate, &canon_root) {
        return Err(AppError::outside_workspace(
            "resolved path escapes the workspace root",
        ));
    }
    Ok(candidate)
}

/// `true` if `a` and `b` refer to the same file-system entry: both are canonicalized
/// with `std::fs::canonicalize` (which requires both to exist) and compared
/// case-insensitively. Used for workspace duplicate detection.
pub fn same_existing_path(a: &Path, b: &Path) -> std::io::Result<bool> {
    let ca = std::fs::canonicalize(a)?;
    let cb = std::fs::canonicalize(b)?;
    Ok(ca.to_string_lossy().to_lowercase() == cb.to_string_lossy().to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_dotdot() {
        let dir = tempfile::tempdir().unwrap();
        let err = resolve(dir.path(), "../escape").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::OutsideWorkspace);
    }

    #[test]
    fn rejects_absolute_rel() {
        let dir = tempfile::tempdir().unwrap();
        let err = resolve(dir.path(), "/etc/passwd").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::OutsideWorkspace);
    }

    #[test]
    fn rejects_backslash_or_drive_segment() {
        let dir = tempfile::tempdir().unwrap();
        let err = resolve(dir.path(), "C:/nope").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::OutsideWorkspace);
    }

    #[test]
    fn missing_target_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let err = resolve(dir.path(), "nope.txt").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::NotFound);
    }

    #[test]
    fn resolves_deep_valid_path() {
        let dir = tempfile::tempdir().unwrap();
        let deep = dir.path().join("a").join("b").join("c");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("f.txt"), b"hi").unwrap();

        let resolved = resolve(dir.path(), "a/b/c/f.txt").unwrap();
        assert!(resolved.ends_with("a/b/c/f.txt") || resolved.ends_with("a\\b\\c\\f.txt"));
    }

    /// Finding #1 regression: `rel="."` (or `"./"`, `"./."`) must NOT silently resolve to
    /// the workspace root the way `rel=""` legitimately does — that would let it sneak
    /// past `fs_delete`/`fs_rename`'s `rel.is_empty()` root guard.
    #[test]
    fn dot_component_is_rejected_not_treated_as_root() {
        let dir = tempfile::tempdir().unwrap();
        for rel in [".", "./", "./.", "a/./b", "a/."] {
            let err = resolve(dir.path(), rel).unwrap_err();
            assert_eq!(
                err.code,
                crate::error::ErrorCode::OutsideWorkspace,
                "rel={rel:?} should be rejected"
            );
        }
    }

    /// Finding #1 regression: an empty component from a doubled separator (`a//b`) is
    /// also rejected rather than silently skipped.
    #[test]
    fn empty_component_from_doubled_separator_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let err = resolve(dir.path(), "a//b").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::OutsideWorkspace);
    }

    #[test]
    fn empty_rel_resolves_to_root() {
        let dir = tempfile::tempdir().unwrap();
        let resolved = resolve(dir.path(), "").unwrap();
        assert_eq!(
            std::fs::canonicalize(resolved).unwrap(),
            std::fs::canonicalize(dir.path()).unwrap()
        );
    }

    /// Used by `fs_delete`/`fs_rename`'s defense-in-depth root guard (finding #1): the
    /// workspace root compares equal to itself...
    #[test]
    fn same_existing_path_true_for_root_against_itself() {
        let dir = tempfile::tempdir().unwrap();
        assert!(same_existing_path(dir.path(), dir.path()).unwrap());
    }

    /// ...but a real child entry must not.
    #[test]
    fn same_existing_path_false_for_child_against_root() {
        let dir = tempfile::tempdir().unwrap();
        let child = dir.path().join("child");
        fs::create_dir(&child).unwrap();
        assert!(!same_existing_path(&child, dir.path()).unwrap());
    }

    #[test]
    fn validate_name_accepts_normal_names() {
        assert!(validate_name("readme.md").is_ok());
        assert!(validate_name("a folder name").is_ok());
        assert!(validate_name("dotfile.").is_err());
    }

    #[test]
    fn validate_name_rejects_forbidden_chars() {
        for bad in ["a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b"] {
            assert!(validate_name(bad).is_err(), "{bad} should be invalid");
        }
    }

    #[test]
    fn validate_name_rejects_trailing_dot_or_space() {
        assert!(validate_name("name.").is_err());
        assert!(validate_name("name ").is_err());
    }

    #[test]
    fn validate_name_rejects_empty() {
        assert!(validate_name("").is_err());
    }

    #[test]
    fn validate_name_rejects_windows_reserved_names() {
        for bad in ["CON", "con", "NUL", "nul.txt", "COM1", "lpt9", "Aux"] {
            assert!(validate_name(bad).is_err(), "{bad} should be reserved");
        }
    }

    #[test]
    fn validate_name_allows_names_that_merely_contain_reserved_words() {
        // Only the stem itself is reserved, not names containing it as a substring.
        assert!(validate_name("CONFIG.txt").is_ok());
        assert!(validate_name("nullable.rs").is_ok());
    }

    /// Windows-only: a junction planted *inside* the workspace root that points outside
    /// it must not let `resolve` escape the root (D-spec §5, §8.7 — this is the whole
    /// point of re-canonicalizing the resolved candidate rather than trusting the
    /// lexical join).
    #[cfg(windows)]
    #[test]
    fn resolve_rejects_junction_escape() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), b"nope").unwrap();

        let link_path = workspace.path().join("escape_link");
        let status = std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &link_path.to_string_lossy(),
                &outside.path().to_string_lossy(),
            ])
            .status()
            .expect("mklink should run");
        assert!(status.success(), "mklink /J failed");

        let err = resolve(workspace.path(), "escape_link/secret.txt").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::OutsideWorkspace);
    }
}
