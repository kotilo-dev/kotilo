//! The `agenthub-docs` CLI (shipped as `<exePrefix>-docs`). Hand-written argument parsing keeps
//! the binary small. Exit codes: 0 = no findings, 1 = findings, 2 = error.
//!
//! ```text
//! kotilo-docs check [--root <dir>] [--json] [--missing-only | --stale-only] [--no-git]
//! kotilo-docs reviewed <doc> [--root <dir>]
//! kotilo-docs --version | --help
//! ```

use std::io::Write;
use std::path::{Path, PathBuf};

use agenthub_proto::brand;

use crate::{check, git, mark_reviewed, BaselineKind, CheckOptions, DocsReport, CONFIG_REL};

pub const EXIT_OK: i32 = 0;
pub const EXIT_FINDINGS: i32 = 1;
pub const EXIT_ERROR: i32 = 2;

pub const VERSION: &str = env!("AGENTHUB_DOCS_VERSION");
/// Changed files listed per stale line before "+N more".
const TEXT_MAX_FILES: usize = 5;

fn exe() -> String {
    format!("{}-docs", brand::EXE_PREFIX)
}

fn help() -> String {
    let exe = exe();
    format!(
        "{exe} {VERSION} – find docs that no longer match the code ({name})\n\
         \n\
         Usage:\n  \
           {exe} check [--root <dir>] [--json] [--missing-only | --stale-only] [--no-git]\n  \
           {exe} reviewed <doc> [--root <dir>]\n  \
           {exe} --version | --help\n\
         \n\
         check     list docs naming paths that do not exist (missing) and docs whose covered\n          \
                   files changed in commits after the doc's baseline (stale)\n\
         reviewed  store the current HEAD commit as the doc's baseline in {CONFIG_REL}\n\
         \n\
         The root defaults to the git top level of the current folder. Configure covered files in\n\
         {CONFIG_REL}:\n  \
           [[doc]]\n  \
           path = \"docs/api.md\"\n  \
           covers = [\"src/api/**\"]\n\
         \n\
         Exit codes: 0 no findings, 1 findings, 2 error.\n",
        name = brand::NAME
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Filter {
    All,
    MissingOnly,
    StaleOnly,
}

struct Paint(bool);

impl Paint {
    fn red(&self, s: &str) -> String {
        self.wrap("31", s)
    }
    fn yellow(&self, s: &str) -> String {
        self.wrap("33", s)
    }
    fn wrap(&self, code: &str, s: &str) -> String {
        if self.0 {
            format!("\x1b[{code}m{s}\x1b[0m")
        } else {
            s.to_string()
        }
    }
}

/// Whether to colour stdout: a TTY, `NO_COLOR` unset and a terminal that renders ANSI.
pub fn want_color() -> bool {
    use std::io::IsTerminal;
    std::io::stdout().is_terminal()
        && std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty())
        && crate::platform::terminal_supports_ansi()
}

/// Runs the CLI with `args` (without the program name). Never panics on bad input.
pub fn run(args: &[String], cwd: &Path, out: &mut dyn Write, err: &mut dyn Write, color: bool) -> i32 {
    match run_inner(args, cwd, out, color) {
        Ok(code) => code,
        Err(message) => {
            let _ = writeln!(err, "{}: error: {message}", exe());
            EXIT_ERROR
        }
    }
}

fn run_inner(args: &[String], cwd: &Path, out: &mut dyn Write, color: bool) -> Result<i32, String> {
    let io = |e: std::io::Error| e.to_string();
    let Some(command) = args.first() else {
        return Err(format!("missing command; see `{} --help`", exe()));
    };
    match command.as_str() {
        "--version" | "-V" => {
            writeln!(out, "{} {VERSION}", exe()).map_err(io)?;
            Ok(EXIT_OK)
        }
        "--help" | "-h" | "help" => {
            write!(out, "{}", help()).map_err(io)?;
            Ok(EXIT_OK)
        }
        "check" => cmd_check(&args[1..], cwd, out, color),
        "reviewed" => cmd_reviewed(&args[1..], cwd, out),
        other => Err(format!("unknown command `{other}`; see `{} --help`", exe())),
    }
}

/// Splits `--root <dir>` / `--root=<dir>` off; returns the remaining args.
fn take_root(args: &[String]) -> Result<(Option<String>, Vec<String>), String> {
    let mut root = None;
    let mut rest = Vec::new();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--root" {
            root = Some(iter.next().cloned().ok_or("--root needs a folder")?);
        } else if let Some(value) = arg.strip_prefix("--root=") {
            root = Some(value.to_string());
        } else {
            rest.push(arg.clone());
        }
    }
    Ok((root, rest))
}

/// An explicit `--root` is used as given (a subfolder workspace stays a subfolder); else the
/// git top level of the current folder, or the current folder without git.
fn resolve_root(cwd: &Path, root: Option<String>, use_git: bool) -> Result<PathBuf, String> {
    let explicit = root.is_some();
    let base = match root {
        Some(r) => cwd.join(r),
        None => cwd.to_path_buf(),
    };
    if !base.is_dir() {
        return Err(format!("{} is not a folder", base.display()));
    }
    if use_git && !explicit {
        if let Ok(Some(top)) = git::line(&base, &["rev-parse", "--show-toplevel"]) {
            return Ok(PathBuf::from(top));
        }
    }
    Ok(base)
}

fn cmd_check(args: &[String], cwd: &Path, out: &mut dyn Write, color: bool) -> Result<i32, String> {
    let (root, rest) = take_root(args)?;
    let (mut json, mut no_git, mut filter) = (false, false, Filter::All);
    for arg in &rest {
        match arg.as_str() {
            "--json" => json = true,
            "--no-git" => no_git = true,
            "--missing-only" | "--stale-only" => {
                let wanted = if arg == "--missing-only" { Filter::MissingOnly } else { Filter::StaleOnly };
                if filter != Filter::All && filter != wanted {
                    return Err("--missing-only and --stale-only exclude each other".into());
                }
                filter = wanted;
            }
            other => return Err(format!("unknown option `{other}` for check")),
        }
    }
    let root = resolve_root(cwd, root, !no_git)?;
    let mut report = check(&root, &CheckOptions { git: !no_git, ..CheckOptions::default() }).map_err(|e| e.to_string())?;
    apply_filter(&mut report, filter);
    let io = |e: std::io::Error| e.to_string();
    if json {
        let text = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
        writeln!(out, "{text}").map_err(io)?;
    } else {
        write_text(&report, &Paint(color), out).map_err(io)?;
    }
    Ok(if report.config_error.is_some() {
        EXIT_ERROR
    } else if report.summary.missing + report.summary.stale > 0 {
        EXIT_FINDINGS
    } else {
        EXIT_OK
    })
}

fn apply_filter(report: &mut DocsReport, filter: Filter) {
    for doc in &mut report.docs {
        match filter {
            Filter::All => {}
            Filter::MissingOnly => doc.stale = None,
            Filter::StaleOnly => doc.missing.clear(),
        }
    }
    report.summary.stale = report.docs.iter().filter(|d| d.stale.is_some()).count();
    report.summary.missing = report.docs.iter().map(|d| d.missing.len()).sum();
}

fn short(id: &str) -> &str {
    id.get(..7).unwrap_or(id)
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn write_text(report: &DocsReport, paint: &Paint, out: &mut dyn Write) -> std::io::Result<()> {
    if let Some(problem) = &report.config_error {
        writeln!(out, "{CONFIG_REL}:{}: invalid config: {}", problem.line, problem.message)?;
    }
    for doc in &report.docs {
        for link in &doc.missing {
            let at = if link.line > 0 { format!("{}:{}", doc.path, link.line) } else { doc.path.clone() };
            writeln!(out, "{at}: {} {} ({})", paint.red("missing"), link.target, link.source.as_str())?;
        }
        if let Some(stale) = &doc.stale {
            let kind = match (stale.baseline_kind, stale.reviewed_missing) {
                (BaselineKind::Reviewed, _) => "reviewed",
                (BaselineKind::LastTouch, false) => "last touch",
                (BaselineKind::LastTouch, true) => "last touch; reviewed commit not found",
            };
            let mut files: Vec<&str> = stale.files.iter().take(TEXT_MAX_FILES).map(|f| f.path.as_str()).collect();
            let more = stale.files.len().saturating_sub(TEXT_MAX_FILES);
            let more = if more > 0 { format!(", +{more} more") } else { String::new() };
            if files.is_empty() {
                files.push("(no file names)");
            }
            writeln!(
                out,
                "{}: {} since {} ({kind}), {}: {}{more}",
                doc.path,
                paint.yellow("stale"),
                short(&stale.baseline),
                plural(stale.commit_count, "commit", "commits"),
                files.join(", ")
            )?;
        }
    }
    let mut summary = format!(
        "{} checked: {} stale, {} missing {}",
        plural(report.summary.docs, "doc", "docs"),
        report.summary.stale,
        report.summary.missing,
        if report.summary.missing == 1 { "path" } else { "paths" }
    );
    if !report.git_available {
        summary.push_str(" (no git: staleness not checked)");
    }
    if report.truncated {
        summary.push_str(" (truncated: too many or too large docs)");
    }
    writeln!(out, "{summary}")
}

fn cmd_reviewed(args: &[String], cwd: &Path, out: &mut dyn Write) -> Result<i32, String> {
    let (root, rest) = take_root(args)?;
    let doc = match rest.as_slice() {
        [doc] if !doc.starts_with("--") => doc.clone(),
        [] => return Err("reviewed needs a doc path".into()),
        _ => return Err(format!("unexpected arguments for reviewed: {}", rest.join(" "))),
    };
    let root = resolve_root(cwd, root, true)?;
    // A path that exists from the current folder is made root-relative; else it is taken as
    // root-relative already.
    let from_cwd = cwd.join(&doc);
    let rel = match (from_cwd.is_file(), from_cwd.canonicalize(), root.canonicalize()) {
        (true, Ok(full), Ok(root_full)) => match full.strip_prefix(&root_full) {
            Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
            Err(_) => doc.clone(),
        },
        _ => doc.clone(),
    };
    let commit = mark_reviewed(&root, &rel).map_err(|e| format!("{rel}: {e}"))?;
    writeln!(out, "{rel}: marked reviewed at {} in {CONFIG_REL}", short(&commit)).map_err(|e| e.to_string())?;
    Ok(EXIT_OK)
}
