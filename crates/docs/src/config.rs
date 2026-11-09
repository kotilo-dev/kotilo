//! `.kotilo/docs.toml`: reading (`[[doc]]` with `path`, `covers`, `reviewed`) and the
//! "Mark reviewed" edit, which keeps comments and formatting (`toml_edit`) and never rewrites an
//! invalid file.

use std::path::{Path, PathBuf};

use toml_edit::{ArrayOfTables, DocumentMut, Item, Table, Value};

use crate::{paths, ConfigProblem, DocsError};

/// Repo-relative location of the config.
pub const CONFIG_REL: &str = ".kotilo/docs.toml";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConfigDoc {
    /// Repo-relative, `/`-separated.
    pub path: String,
    pub covers: Vec<String>,
    pub reviewed: Option<String>,
}

pub fn config_path(root: &Path) -> PathBuf {
    root.join(".kotilo").join("docs.toml")
}

/// Reads the config: `Ok(None)` when the file does not exist.
pub fn read_text(root: &Path) -> Result<Option<String>, DocsError> {
    match std::fs::read(config_path(root)) {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            Ok(Some(text.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(text)))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(DocsError::Io(e)),
    }
}

fn line_of(text: &str, offset: Option<std::ops::Range<usize>>) -> u32 {
    offset
        .map(|r| text.as_bytes()[..r.start.min(text.len())].iter().filter(|b| **b == b'\n').count() + 1)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0)
}

fn problem(text: &str, span: Option<std::ops::Range<usize>>, message: impl Into<String>) -> ConfigProblem {
    ConfigProblem { line: line_of(text, span), message: message.into() }
}

/// Parses and validates the config. Unknown keys are ignored.
pub fn parse(text: &str) -> Result<Vec<ConfigDoc>, ConfigProblem> {
    let doc = toml_edit::Document::parse(text)
        .map_err(|e| problem(text, e.span(), e.message().trim().to_string()))?;
    let Some(root) = doc.as_item().as_table() else { return Ok(Vec::new()) };
    let Some(item) = root.get("doc") else { return Ok(Vec::new()) };
    let Some(entries) = item.as_array_of_tables() else {
        return Err(problem(text, item.span(), "`doc` must be an array of tables ([[doc]])"));
    };
    let mut docs: Vec<ConfigDoc> = Vec::new();
    for table in entries.iter() {
        let Some(path_item) = table.get("path") else {
            return Err(problem(text, table.span(), "[[doc]] needs a `path`"));
        };
        let path = path_item
            .as_str()
            .and_then(paths::normalize_rel)
            .ok_or_else(|| problem(text, path_item.span(), "`path` must be a repo-relative path"))?;
        let mut covers = Vec::new();
        if let Some(item) = table.get("covers") {
            let invalid = || problem(text, item.span(), "`covers` must be a list of strings");
            match item.as_value() {
                Some(Value::String(s)) => covers.push(s.value().clone()),
                Some(Value::Array(array)) => {
                    for value in array.iter() {
                        covers.push(value.as_str().ok_or_else(invalid)?.to_string());
                    }
                }
                _ => return Err(invalid()),
            }
        }
        let reviewed = match table.get("reviewed") {
            None => None,
            Some(item) => Some(
                item.as_str()
                    .map(|s| s.trim().to_string())
                    .ok_or_else(|| problem(text, item.span(), "`reviewed` must be a commit id string"))?,
            )
            .filter(|s| !s.is_empty()),
        };
        // A doc listed twice: covers are merged, the first `reviewed` wins.
        if let Some(existing) = docs.iter_mut().find(|d| d.path == path) {
            existing.covers.extend(covers);
            if existing.reviewed.is_none() {
                existing.reviewed = reviewed;
            }
        } else {
            docs.push(ConfigDoc { path, covers, reviewed });
        }
    }
    Ok(docs)
}

/// Sets `reviewed = "<commit>"` on the doc's `[[doc]]` entry (adds the entry, creates the file
/// and `.kotilo/` when missing). Other content keeps its comments and formatting.
pub fn set_reviewed(root: &Path, doc_rel: &str, commit: &str) -> Result<(), DocsError> {
    let existing = read_text(root)?.unwrap_or_default();
    // Validate first: an invalid file is never rewritten.
    parse(&existing).map_err(|p| DocsError::InvalidConfig { line: p.line, message: p.message })?;
    let mut doc: DocumentMut = existing
        .parse()
        .map_err(|e: toml_edit::TomlError| DocsError::InvalidConfig { line: 0, message: e.message().to_string() })?;
    if doc.get("doc").is_none() {
        doc.insert("doc", Item::ArrayOfTables(ArrayOfTables::new()));
    }
    let entries = doc
        .get_mut("doc")
        .and_then(Item::as_array_of_tables_mut)
        .ok_or_else(|| DocsError::InvalidConfig { line: 0, message: "`doc` must be an array of tables ([[doc]])".into() })?;
    let found = entries
        .iter_mut()
        .find(|t| t.get("path").and_then(Item::as_str).and_then(paths::normalize_rel).as_deref() == Some(doc_rel));
    match found {
        Some(table) => {
            table["reviewed"] = toml_edit::value(commit);
        }
        None => {
            let mut table = Table::new();
            table["path"] = toml_edit::value(doc_rel);
            table["reviewed"] = toml_edit::value(commit);
            entries.push(table);
        }
    }
    let path = config_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut text = doc.to_string();
    if !text.ends_with('\n') {
        text.push('\n');
    }
    // Temp file + rename: a crash never leaves a half-written config.
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, text)?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(DocsError::Io(e));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_entries_and_merges_duplicates() {
        let text = "# docs\n[[doc]]\npath = \"./docs/a.md\"\ncovers = [\"src/**\", \"b.rs\"]\nreviewed = \"abc\"\n\n\
                    [[doc]]\npath = 'docs\\b.md'\ncovers = \"one/*\"\nextra = 1\n\n[[doc]]\npath = \"docs/a.md\"\ncovers = [\"c.rs\"]\nreviewed = \"zzz\"\n";
        let docs = parse(text).unwrap();
        assert_eq!(
            docs,
            vec![
                ConfigDoc {
                    path: "docs/a.md".into(),
                    covers: vec!["src/**".into(), "b.rs".into(), "c.rs".into()],
                    reviewed: Some("abc".into())
                },
                ConfigDoc { path: "docs/b.md".into(), covers: vec!["one/*".into()], reviewed: None },
            ]
        );
        assert_eq!(parse("").unwrap(), vec![]);
        assert_eq!(parse("other = 1\n").unwrap(), vec![]);
    }

    #[test]
    fn invalid_config_reports_a_line() {
        let syntax = parse("[[doc]]\npath = \"a.md\"\ncovers = [\"x\"\n").unwrap_err();
        assert_eq!(syntax.line, 3, "{syntax:?}");
        assert!(!syntax.message.is_empty());
        let table = parse("x = 1\n[doc]\npath = \"a.md\"\n").unwrap_err();
        assert_eq!(table.line, 2, "{table:?}");
        let no_path = parse("[[doc]]\ncovers = []\n").unwrap_err();
        assert!(no_path.message.contains("path"), "{no_path:?}");
        let covers = parse("[[doc]]\npath = \"a.md\"\ncovers = [1]\n").unwrap_err();
        assert_eq!(covers.line, 3, "{covers:?}");
        let outside = parse("[[doc]]\npath = \"../a.md\"\n").unwrap_err();
        assert_eq!(outside.line, 2, "{outside:?}");
    }
}
