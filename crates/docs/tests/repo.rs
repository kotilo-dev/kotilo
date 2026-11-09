//! Fixture tests on temporary git repositories (never the real home folders). Skipped when git
//! is not on PATH.

use std::path::{Path, PathBuf};
use std::process::Command;

use agenthub_docs::cli::{self, EXIT_ERROR, EXIT_FINDINGS, EXIT_OK};
use agenthub_docs::{check, mark_reviewed, BaselineKind, CheckOptions, DocDoc, DocsError, DocsReport, LinkSource};

fn git_installed() -> bool {
    let ok = Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success());
    if !ok {
        eprintln!("git not on PATH; skipping");
    }
    ok
}

struct Repo {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Repo {
    /// An empty repo on `main` (no commit yet).
    fn empty() -> Option<Repo> {
        if !git_installed() {
            return None;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let repo = Repo { _dir: dir, root };
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "test@example.invalid"]);
        repo.git(&["config", "user.name", "Test"]);
        repo.git(&["config", "core.autocrlf", "false"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        Some(repo)
    }

    /// A repo with `src/a.rs`, `src/b.rs`, `hub/x.cs` committed.
    fn new() -> Option<Repo> {
        let repo = Repo::empty()?;
        repo.write("src/a.rs", "a\n");
        repo.write("src/b.rs", "b\n");
        repo.write("hub/x.cs", "x\n");
        repo.commit("init");
        Some(repo)
    }

    fn git(&self, args: &[&str]) -> String {
        let out = Command::new("git").args(args).current_dir(&self.root).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn write(&self, rel: &str, text: &str) {
        let path = self.root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.root.join(rel)).unwrap()
    }

    fn commit(&self, msg: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
        self.git(&["rev-parse", "HEAD"])
    }

    fn change(&self, rel: &str, msg: &str) -> String {
        let old = std::fs::read_to_string(self.root.join(rel)).unwrap_or_default();
        self.write(rel, &format!("{old}{msg}\n"));
        self.commit(msg)
    }

    fn check(&self) -> DocsReport {
        check(&self.root, &CheckOptions::default()).unwrap()
    }
}

fn doc<'a>(report: &'a DocsReport, path: &str) -> &'a DocDoc {
    report.docs.iter().find(|d| d.path == path).unwrap_or_else(|| panic!("{path} not in {:?}", report.docs))
}

fn targets(links: &[agenthub_docs::DocLink]) -> Vec<(String, LinkSource, u32, bool)> {
    links.iter().map(|l| (l.target.clone(), l.source, l.line, l.exists)).collect()
}

fn l(target: &str, source: LinkSource, line: u32, exists: bool) -> (String, LinkSource, u32, bool) {
    (target.to_string(), source, line, exists)
}

#[test]
fn link_sources_dedup_folders_and_missing() {
    let Some(repo) = Repo::new() else { return };
    repo.write(
        "docs/a.md",
        "# A\n\
         See [a](../src/a.rs#L3) and [again](../src/a.rs).\n\
         Folder: [src](../src/), rooted [x](/hub/x.cs), [web](https://example.com/x), [self](a.md), [top](#top)\n\
         Gone: [old](../src/old.rs) and `src/b.rs`, `src/nope.rs`, `notadir/x.rs`, `../src/a.rs`\n\
         ```rust file=src/gone.rs\n[inside](../src/inside.rs)\n```\n\
         [ref]: ../src/b.rs\n",
    );
    let report = repo.check();
    let a = doc(&report, "docs/a.md");
    assert_eq!(
        targets(&a.links),
        vec![
            l("src/a.rs", LinkSource::Link, 2, true),
            l("src", LinkSource::Link, 3, true),
            l("hub/x.cs", LinkSource::Link, 3, true),
            // Inline code is collected before the links of the same line; `../` resolves
            // against the doc's folder.
            l("src/b.rs", LinkSource::Inline, 4, true),
            l("src/nope.rs", LinkSource::Inline, 4, false),
            l("src/a.rs", LinkSource::Inline, 4, true),
            l("src/old.rs", LinkSource::Link, 4, false),
            l("src/gone.rs", LinkSource::CodeBlock, 5, false),
            l("src/b.rs", LinkSource::Link, 8, true),
        ]
    );
    assert_eq!(targets(&a.missing), vec![
        l("src/nope.rs", LinkSource::Inline, 4, false),
        l("src/old.rs", LinkSource::Link, 4, false),
        l("src/gone.rs", LinkSource::CodeBlock, 5, false),
    ]);
    assert!(a.stale.is_none(), "uncommitted doc is never stale");
    assert_eq!(report.summary.missing, 3);
    assert!(report.git_available);
    assert_eq!(report.head.as_deref().map(str::len), Some(40));
}

#[test]
fn inline_paths_resolve_against_the_doc_folder_too() {
    let Some(repo) = Repo::new() else { return };
    repo.write("apps/web/src/main.ts", "m\n");
    repo.write("apps/web/README.md", "Entry `src/main.ts`, gone `src/old.ts`, root `hub/x.cs`.\n");
    let report = repo.check();
    // `src` exists at the root, so `src/main.ts` resolves there (and is missing).
    assert_eq!(
        targets(&doc(&report, "apps/web/README.md").links),
        vec![
            l("src/main.ts", LinkSource::Inline, 1, false),
            l("src/old.ts", LinkSource::Inline, 1, false),
            l("hub/x.cs", LinkSource::Inline, 1, true),
        ]
    );
    repo.write("apps/web/README.md", "Entry `lib/util.ts`.\n");
    repo.write("apps/web/lib/util.ts", "u\n");
    let report = repo.check();
    assert_eq!(targets(&doc(&report, "apps/web/README.md").links), vec![l("apps/web/lib/util.ts", LinkSource::Inline, 1, true)]);
}

#[test]
fn staleness_from_last_touch_with_folder_links_and_uncommitted_changes() {
    let Some(repo) = Repo::new() else { return };
    repo.write("docs/a.md", "[a](../src/a.rs) [hub](../hub/) `src/b.rs`\n");
    let baseline = repo.commit("doc");
    assert!(doc(&repo.check(), "docs/a.md").stale.is_none(), "nothing changed after the doc");

    repo.change("src/a.rs", "change a");
    repo.write("hub/new/y.cs", "y\n");
    repo.commit("add y under the hub folder");
    repo.change("src/a.rs", "change a again");
    repo.change("src/b.rs", "inline only, does not count");
    repo.write("src/a.rs", "uncommitted\n");

    let report = repo.check();
    let stale = doc(&report, "docs/a.md").stale.clone().expect("stale");
    assert_eq!(stale.baseline, baseline);
    assert_eq!(stale.baseline_kind, BaselineKind::LastTouch);
    assert!(!stale.reviewed_missing);
    assert_eq!(stale.commit_count, 3);
    let subjects: Vec<&str> = stale.commits.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(subjects, vec!["change a again", "add y under the hub folder", "change a"], "newest first");
    assert!(stale.commits.iter().all(|c| c.id.len() == 40 && c.date.contains('T')));
    let files: Vec<(&str, usize)> = stale.files.iter().map(|f| (f.path.as_str(), f.commits)).collect();
    assert_eq!(files, vec![("src/a.rs", 2), ("hub/new/y.cs", 1)]);
    assert_eq!(report.summary.stale, 1);

    // Editing the doc moves the baseline.
    repo.change("docs/a.md", "doc updated");
    assert!(doc(&repo.check(), "docs/a.md").stale.is_none());
}

#[test]
fn ignored_and_wildcard_inline_paths_and_doc_links_are_not_findings() {
    let Some(repo) = Repo::new() else { return };
    repo.write(".gitignore", "target/
");
    repo.write("target/.keep", "");
    repo.write("docs/other.md", "# other
");
    repo.write(
        "docs/guide.md",
        "See [other](other.md) and [code](../src/a.rs).

`target/release/app.exe` `src/*.rs` `src/gone.rs`
",
    );
    repo.commit("docs");
    repo.change("docs/other.md", "other changed");
    let report = repo.check();
    let guide = doc(&report, "docs/guide.md");
    assert_eq!(targets(&guide.missing), vec![l("src/gone.rs", LinkSource::Inline, 3, false)]);
    assert!(guide.stale.is_none(), "a link to another doc does not make it stale");
    repo.change("src/a.rs", "code changed");
    assert!(doc(&repo.check(), "docs/guide.md").stale.is_some(), "a link to code still does");
}

#[test]
fn local_only_folders_and_the_config_path_are_not_missing() {
    let Some(repo) = Repo::new() else { return };
    repo.write(".gitignore", ".local/
");
    repo.write(".local/settings.json", "{}
");
    repo.write("docs/guide.md", "Other tools use `.local/worktrees`; configure in `.kotilo/docs.toml`; gone `src/gone.rs`.
");
    let report = repo.check();
    assert_eq!(targets(&doc(&report, "docs/guide.md").links), vec![l("src/gone.rs", LinkSource::Inline, 1, false)]);
}

#[test]
fn merge_commits_are_ignored() {
    let Some(repo) = Repo::new() else { return };
    repo.write("docs/a.md", "[a](../src/a.rs)\n");
    repo.commit("doc");
    repo.git(&["checkout", "-q", "-b", "feature"]);
    repo.change("src/a.rs", "on feature");
    repo.git(&["checkout", "-q", "main"]);
    repo.change("hub/x.cs", "unrelated on main");
    repo.git(&["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);
    let stale = doc(&repo.check(), "docs/a.md").stale.clone().expect("stale");
    assert_eq!(stale.commit_count, 1);
    assert_eq!(stale.commits[0].subject, "on feature");
}

#[test]
fn reviewed_baseline_and_reviewed_missing() {
    let Some(repo) = Repo::new() else { return };
    repo.write("docs/a.md", "[a](../src/a.rs)\n");
    let doc_commit = repo.commit("doc");
    repo.change("src/a.rs", "before review");
    assert!(doc(&repo.check(), "docs/a.md").stale.is_some());

    let reviewed = mark_reviewed(&repo.root, "docs/a.md").unwrap();
    assert_eq!(reviewed, repo.git(&["rev-parse", "HEAD"]));
    assert!(doc(&repo.check(), "docs/a.md").stale.is_none(), "reviewed at HEAD");
    // Committing the config (as a team would) does not make the doc stale.
    repo.commit("mark reviewed");
    assert!(doc(&repo.check(), "docs/a.md").stale.is_none());

    repo.change("src/a.rs", "after review");
    let stale = doc(&repo.check(), "docs/a.md").stale.clone().expect("stale");
    assert_eq!((stale.baseline.as_str(), stale.baseline_kind, stale.commit_count), (reviewed.as_str(), BaselineKind::Reviewed, 1));

    // A reviewed commit that no longer exists → last touch, reviewedMissing.
    repo.write(".kotilo/docs.toml", "[[doc]]\npath = \"docs/a.md\"\nreviewed = \"0123456789abcdef0123456789abcdef01234567\"\n");
    let stale = doc(&repo.check(), "docs/a.md").stale.clone().expect("stale");
    assert_eq!(stale.baseline, doc_commit);
    assert_eq!(stale.baseline_kind, BaselineKind::LastTouch);
    assert!(stale.reviewed_missing);
    assert_eq!(stale.commit_count, 2);
    // Not a commit id at all: same fallback, never passed to git as an option.
    repo.write(".kotilo/docs.toml", "[[doc]]\npath = \"docs/a.md\"\nreviewed = \"--all\"\n");
    assert!(doc(&repo.check(), "docs/a.md").stale.as_ref().is_some_and(|s| s.reviewed_missing));
}

#[test]
fn config_globs_brace_globs_and_front_matter() {
    let Some(repo) = Repo::new() else { return };
    repo.write("hub/Api/v1/c.cs", "c\n");
    repo.write("docs/api.md", "# API\n");
    repo.write("docs/fm.md", "---\ntitle: FM\ncovers:\n  - src/*.rs\n  - missing/**\n---\nBody\n");
    repo.write(
        ".kotilo/docs.toml",
        "# team config\n[[doc]]\npath = \"docs/api.md\"\ncovers = [\"hub/Api/**\", \"nomatch/**\", \"{hub,src}/*.cs\", \"src/b.rs\", \"*.cs\"]\n",
    );
    repo.commit("docs");
    let report = repo.check();
    assert_eq!(report.config_path.as_deref(), Some(".kotilo/docs.toml"));
    assert!(report.config_error.is_none());
    let api = doc(&report, "docs/api.md");
    assert_eq!(
        targets(&api.links),
        vec![
            l("hub/Api/**", LinkSource::Config, 0, true),
            l("nomatch/**", LinkSource::Config, 0, false),
            l("{hub,src}/*.cs", LinkSource::Config, 0, true),
            l("src/b.rs", LinkSource::Config, 0, true),
            // literal_separator: `*` does not cross `/`, and there is no root .cs file.
            l("*.cs", LinkSource::Config, 0, false),
        ]
    );

    let fm = doc(&report, "docs/fm.md");
    assert_eq!(targets(&fm.links), vec![l("src/*.rs", LinkSource::FrontMatter, 4, true), l("missing/**", LinkSource::FrontMatter, 5, false)]);

    repo.change("hub/Api/v1/c.cs", "api change");
    repo.change("hub/x.cs", "brace match");
    repo.change("src/a.rs", "front matter match");
    let report = repo.check();
    let files: Vec<String> = doc(&report, "docs/api.md").stale.as_ref().unwrap().files.iter().map(|f| f.path.clone()).collect();
    assert_eq!(files, vec!["hub/Api/v1/c.cs", "hub/x.cs"]);
    let fm_stale = doc(&report, "docs/fm.md").stale.as_ref().unwrap();
    assert_eq!(fm_stale.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), vec!["front matter match"]);
}

#[test]
fn globs_naming_folders_exist() {
    let Some(repo) = Repo::new() else { return };
    repo.write("hub/Api/c.cs", "c\n");
    repo.write("docs/dirs.md", "Folders `hub/*/` and `src/*`.\n");
    repo.write(".kotilo/docs.toml", "[[doc]]\npath = \"docs/dirs.md\"\ncovers = [\"hub/*\", \"src/*/\"]\n");
    assert_eq!(
        targets(&doc(&repo.check(), "docs/dirs.md").links),
        vec![
            // Inline wildcards (`hub/*/`) are prose patterns and never become links.
            l("hub/*", LinkSource::Config, 0, true),
            l("src/*", LinkSource::Config, 0, true),
        ]
    );
}

#[test]
fn a_glob_covering_the_doc_itself_does_not_make_it_stale() {
    let Some(repo) = Repo::new() else { return };
    repo.write("docs/a.md", "# A\n");
    repo.write(".kotilo/docs.toml", "[[doc]]\npath = \"docs/a.md\"\ncovers = [\"**\"]\n");
    repo.commit("doc");
    mark_reviewed(&repo.root, "docs/a.md").unwrap();
    repo.commit("reviewed");
    repo.change("docs/a.md", "doc edit");
    assert!(doc(&repo.check(), "docs/a.md").stale.is_none());
    repo.change("src/a.rs", "code edit");
    let stale = doc(&repo.check(), "docs/a.md").stale.clone().unwrap();
    assert_eq!(stale.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["src/a.rs"]);
}

#[test]
fn config_lists_non_markdown_docs() {
    let Some(repo) = Repo::new() else { return };
    repo.write("docs/notes.txt", "plain\n");
    repo.write(".kotilo/docs.toml", "[[doc]]\npath = \"docs/notes.txt\"\ncovers = [\"src/a.rs\"]\n[[doc]]\npath = \"docs/absent.txt\"\ncovers = [\"src\"]\n");
    let report = repo.check();
    assert_eq!(targets(&doc(&report, "docs/notes.txt").links), vec![l("src/a.rs", LinkSource::Config, 0, true)]);
    assert!(report.docs.iter().all(|d| d.path != "docs/absent.txt"));
}

#[test]
fn discovery_order_skips_and_ignores() {
    let Some(repo) = Repo::new() else { return };
    let body = "[a](/src/a.rs)\n";
    for rel in ["README.md", "docs/z.MDX", "AGENTS.md", "pkg/CLAUDE.md", ".github/copilot-instructions.md", "node_modules/p/README.md", ".kotilo/worktrees/w/README.md", "build/out.md", "nolinks.md"] {
        repo.write(rel, body);
    }
    repo.write("nolinks.md", "no links here\n");
    repo.write(".gitignore", "build/\n");
    let report = repo.check();
    let paths: Vec<&str> = report.docs.iter().map(|d| d.path.as_str()).collect();
    assert_eq!(paths, vec![".github/copilot-instructions.md", "AGENTS.md", "pkg/CLAUDE.md", "README.md", "docs/z.MDX"]);
    assert!(report.docs[0].agent_file && !report.docs[3].agent_file);
    // Only docs with links are listed; all scanned docs are counted.
    assert_eq!(report.summary.docs, 6);
    assert!(!report.truncated);
}

#[test]
fn caps_truncate_but_keep_agent_files() {
    let Some(repo) = Repo::new() else { return };
    for rel in ["a.md", "b.md", "AGENTS.md"] {
        repo.write(rel, "[x](src/gone.rs)\n");
    }
    let report = check(&repo.root, &CheckOptions { max_docs: 2, git: true }).unwrap();
    assert!(report.truncated);
    assert_eq!(report.docs.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), vec!["AGENTS.md", "a.md"]);

    repo.write("big.md", &format!("[x](src/gone.rs)\n{}", "x".repeat(1024 * 1024 + 1)));
    let report = repo.check();
    assert!(report.truncated);
    assert!(report.docs.iter().all(|d| d.path != "big.md"));
}

#[test]
fn no_git_mode_reports_missing_only() {
    let Some(repo) = Repo::new() else { return };
    repo.write("docs/a.md", "[a](../src/a.rs) [gone](../src/gone.rs)\n");
    repo.commit("doc");
    repo.change("src/a.rs", "change");
    let report = check(&repo.root, &CheckOptions { git: false, ..CheckOptions::default() }).unwrap();
    assert!(!report.git_available && report.head.is_none());
    let a = doc(&report, "docs/a.md");
    assert!(a.stale.is_none());
    assert_eq!(targets(&a.missing), vec![l("src/gone.rs", LinkSource::Link, 1, false)]);

    // A plain folder (no repo at all): the walk honours .gitignore and skips node_modules.
    let plain = tempfile::tempdir().unwrap();
    let root = plain.path();
    std::fs::create_dir_all(root.join("ignored")).unwrap();
    std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
    std::fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
    std::fs::write(root.join("README.md"), "[g](gone.txt) [i](ignored/x.md)\n").unwrap();
    std::fs::write(root.join("ignored/x.md"), "[g](gone.txt)\n").unwrap();
    std::fs::write(root.join("node_modules/x/README.md"), "[g](gone.txt)\n").unwrap();
    let report = check(root, &CheckOptions::default()).unwrap();
    assert!(!report.git_available);
    assert_eq!(report.docs.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), vec!["README.md"]);
    assert_eq!(report.summary.docs, 1);
    assert_eq!(targets(&report.docs[0].missing), vec![l("gone.txt", LinkSource::Link, 1, false)]);
}

#[test]
fn invalid_config_is_reported_and_never_rewritten() {
    let Some(repo) = Repo::new() else { return };
    repo.write("docs/a.md", "[gone](../src/gone.rs)\n");
    let bad = "# keep me\n[[doc]]\npath = \"docs/a.md\"\ncovers = [\"src/**\"\n";
    repo.write(".kotilo/docs.toml", bad);
    repo.commit("bad config");
    let report = repo.check();
    let problem = report.config_error.clone().expect("config error");
    assert_eq!(problem.line, 4, "{problem:?}");
    assert_eq!(report.config_path.as_deref(), Some(".kotilo/docs.toml"));
    // Still built from Markdown.
    assert_eq!(targets(&doc(&report, "docs/a.md").missing), vec![l("src/gone.rs", LinkSource::Link, 1, false)]);

    let err = mark_reviewed(&repo.root, "docs/a.md").unwrap_err();
    assert!(matches!(err, DocsError::InvalidConfig { line: 4, .. }), "{err:?}");
    assert_eq!(repo.read(".kotilo/docs.toml"), bad);
}

#[test]
fn mark_reviewed_creates_updates_and_keeps_comments() {
    let Some(repo) = Repo::new() else { return };
    repo.write("docs/a.md", "# A\n");
    repo.write("docs/b.md", "# B\n");
    let head = repo.commit("docs");

    // Creates `.kotilo/docs.toml` with a new entry; Windows separators are accepted.
    assert_eq!(mark_reviewed(&repo.root, "docs\\a.md").unwrap(), head);
    assert_eq!(repo.read(".kotilo/docs.toml"), format!("[[doc]]\npath = \"docs/a.md\"\nreviewed = \"{head}\"\n"));

    let text = "# Docs map for the team\n\n[[doc]]\npath = \"./docs/b.md\" # the API doc\ncovers = [\n  \"src/**\", # code\n]\nreviewed = \"old\"\n\n# trailing comment\n";
    repo.write(".kotilo/docs.toml", text);
    repo.change("src/a.rs", "next");
    let head2 = mark_reviewed(&repo.root, "docs/b.md").unwrap();
    assert_ne!(head, head2);
    assert_eq!(repo.read(".kotilo/docs.toml"), text.replace("reviewed = \"old\"", &format!("reviewed = \"{head2}\"")));

    // A new entry is appended; existing content stays as it was.
    mark_reviewed(&repo.root, "./docs/a.md").unwrap();
    let after = repo.read(".kotilo/docs.toml");
    assert!(after.starts_with(&text.replace("reviewed = \"old\"", &format!("reviewed = \"{head2}\"")).replace("\n# trailing comment\n", "")), "{after}");
    assert!(after.contains(&format!("[[doc]]\npath = \"docs/a.md\"\nreviewed = \"{head2}\"\n")), "{after}");
    assert!(after.contains("# trailing comment"), "{after}");
    assert!(agenthub_docs::config::parse(&after).is_ok());
}

#[test]
fn mark_reviewed_errors() {
    let Some(repo) = Repo::empty() else { return };
    repo.write("a.md", "# A\n");
    assert!(matches!(mark_reviewed(&repo.root, "a.md"), Err(DocsError::NoCommit)));
    assert!(matches!(mark_reviewed(&repo.root, "missing.md"), Err(DocsError::UnknownDoc)));
    assert!(matches!(mark_reviewed(&repo.root, "../outside.md"), Err(DocsError::UnknownDoc)));
    let plain = tempfile::tempdir().unwrap();
    std::fs::write(plain.path().join("a.md"), "# A\n").unwrap();
    // Inside the system temp folder there is normally no repo; skip if there is one.
    if !Command::new("git").args(["rev-parse", "--git-dir"]).current_dir(plain.path()).output().unwrap().status.success() {
        assert!(matches!(mark_reviewed(plain.path(), "a.md"), Err(DocsError::NotARepo)));
    }
    assert!(!plain.path().join(".kotilo").exists());
}

// --- CLI -------------------------------------------------------------------------------------

fn run_cli(cwd: &Path, args: &[&str]) -> (i32, String, String) {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = cli::run(&args, cwd, &mut out, &mut err, false);
    (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
}

#[test]
fn cli_check_text_json_filters_and_exit_codes() {
    let Some(repo) = Repo::new() else { return };
    repo.write("docs/a.md", "# A\n[a](../src/a.rs)\n");
    repo.commit("doc");
    let (code, out, err) = run_cli(&repo.root, &["check"]);
    assert_eq!((code, out.as_str(), err.as_str()), (EXIT_OK, "1 doc checked: 0 stale, 0 missing paths\n", ""));

    repo.write("docs/a.md", "# A\n[a](../src/a.rs)\n[old](../src/old.rs)\n");
    let baseline = repo.commit("doc 2");
    repo.change("src/a.rs", "change");
    // From a subfolder: the root is the git top level.
    let (code, out, _) = run_cli(&repo.root.join("src"), &["check"]);
    assert_eq!(code, EXIT_FINDINGS);
    assert_eq!(
        out,
        format!(
            "docs/a.md:3: missing src/old.rs (link)\n\
             docs/a.md: stale since {} (last touch), 1 commit: src/a.rs\n\
             1 doc checked: 1 stale, 1 missing path\n",
            &baseline[..7]
        )
    );

    let (code, out, _) = run_cli(&repo.root, &["check", "--missing-only"]);
    assert_eq!(code, EXIT_FINDINGS);
    assert!(!out.contains("stale since") && out.contains("missing src/old.rs"));
    let (code, out, _) = run_cli(&repo.root, &["check", "--stale-only", "--json"]);
    assert_eq!(code, EXIT_FINDINGS);
    let report: DocsReport = serde_json::from_str(&out).unwrap();
    assert_eq!((report.summary.stale, report.summary.missing), (1, 0));
    assert!(report.docs[0].missing.is_empty());
    let json: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(json["docs"][0]["stale"]["baselineKind"], "lastTouch");

    let (code, out, _) = run_cli(Path::new("."), &["check", "--no-git", "--root", repo.root.to_str().unwrap()]);
    assert_eq!(code, EXIT_FINDINGS);
    assert!(out.ends_with("1 doc checked: 0 stale, 1 missing path (no git: staleness not checked)\n"), "{out}");

    repo.write(".kotilo/docs.toml", "[[doc]\n");
    let (code, out, _) = run_cli(&repo.root, &["check"]);
    assert_eq!(code, EXIT_ERROR);
    assert!(out.starts_with(".kotilo/docs.toml:1: invalid config: "), "{out}");
}

#[test]
fn cli_reviewed_version_help_and_usage_errors() {
    let Some(repo) = Repo::new() else { return };
    repo.write("docs/a.md", "[a](../src/a.rs)\n");
    repo.commit("doc");
    repo.change("src/a.rs", "change");
    assert_eq!(run_cli(&repo.root, &["check", "--stale-only"]).0, EXIT_FINDINGS);
    // Relative to the current folder.
    let (code, out, err) = run_cli(&repo.root.join("docs"), &["reviewed", "a.md"]);
    assert_eq!(code, EXIT_OK, "{err}");
    let head = repo.git(&["rev-parse", "HEAD"]);
    assert_eq!(out, format!("docs/a.md: marked reviewed at {} in .kotilo/docs.toml\n", &head[..7]));
    assert_eq!(run_cli(&repo.root, &["check", "--stale-only"]).0, EXIT_OK);
    // Root-relative with --root and a Windows separator.
    let (code, _, err) = run_cli(Path::new("."), &["reviewed", "docs\\a.md", "--root", repo.root.to_str().unwrap()]);
    assert_eq!(code, EXIT_OK, "{err}");

    let (code, _, err) = run_cli(&repo.root, &["reviewed", "nope.md"]);
    assert_eq!(code, EXIT_ERROR);
    assert!(err.contains("nope.md: not a file in this repository"), "{err}");

    let (code, out, _) = run_cli(&repo.root, &["--version"]);
    assert_eq!(code, EXIT_OK);
    assert_eq!(out, format!("{}-docs {}\n", brand_exe_prefix(), cli::VERSION));
    let (code, out, _) = run_cli(&repo.root, &["--help"]);
    assert_eq!(code, EXIT_OK);
    assert!(out.contains("check [--root <dir>]") && out.contains("Exit codes"));

    for bad in [&[][..], &["frobnicate"], &["check", "--bogus"], &["check", "--missing-only", "--stale-only"], &["check", "--root"], &["reviewed"], &["reviewed", "a", "b"]] {
        let (code, out, err) = run_cli(&repo.root, bad);
        assert_eq!(code, EXIT_ERROR, "{bad:?}");
        assert!(out.is_empty() && err.contains("error:"), "{bad:?}: {err}");
    }
}

fn brand_exe_prefix() -> String {
    let brand = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../brand.json")).unwrap();
    let brand: serde_json::Value = serde_json::from_str(&brand).unwrap();
    brand["exePrefix"].as_str().unwrap().to_string()
}
