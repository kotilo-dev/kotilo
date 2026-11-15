//! Fixture tests: a fake home and workspace in a temp dir (never the real `~/.claude`,
//! `~/.codex`, …). The OS id is a made-up value unless a test is about OS filtering, so
//! built-in managed paths are never looked up on the real machine.

use std::path::{Path, PathBuf};

use serde_json::json;

use super::*;
use crate::adapters::{ContextDef, Definitions};

const OS: &str = "test-os";

struct Fx {
    _tmp: tempfile::TempDir,
    base: PathBuf,
    home: PathBuf,
    root: PathBuf,
}

/// `<tmp>/home` and `<tmp>/top/mid/root` (no `.git` unless a test adds one).
fn fx() -> Fx {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let home = base.join("home");
    let root = base.join("top").join("mid").join("root");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    // `ancestors` walks stop at the temp dir instead of reading the real machine's folders.
    TEST_CEILING.with(|c| *c.borrow_mut() = Some(base.clone()));
    Fx {
        _tmp: tmp,
        base,
        home,
        root,
    }
}

fn write(p: &Path, text: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

fn agent(ctx: serde_json::Value) -> AdapterDefinition {
    let ctx: ContextDef = serde_json::from_value(ctx).unwrap();
    let mut d = crate::adapters::tests::def("test-agent");
    d.context = Some(ctx);
    d
}

impl Fx {
    fn report(&self, ctx: serde_json::Value) -> ContextReport {
        report(&agent(ctx), &self.root, Some(&self.home), OS)
    }
}

fn paths(r: &ContextReport) -> Vec<PathBuf> {
    r.files.iter().map(|f| PathBuf::from(&f.path)).collect()
}

fn displays(r: &ContextReport) -> Vec<&str> {
    r.files.iter().map(|f| f.display.as_str()).collect()
}

fn names_ctx(names: &[&str], walk: &str, pick: &str) -> serde_json::Value {
    json!({ "instructions": [{ "scope": "project", "names": names, "walk": walk, "pick": pick }] })
}

#[test]
fn walks_root_repo_and_ancestors_with_each_pick_mode() {
    let f = fx();
    let top = f.base.join("top");
    let mid = top.join("mid");
    std::fs::create_dir_all(top.join(".git")).unwrap();
    for d in [&f.base, &top, &mid, &f.root] {
        write(&d.join("KTEST.md"), "x");
    }
    write(&f.root.join("KALT.md"), "y");
    write(&mid.join("KMID.md"), "m");
    write(&f.base.join("KMID.md"), "m");

    let r = f.report(names_ctx(&["KTEST.md", "KALT.md"], "root", "all"));
    assert_eq!(displays(&r), vec!["KTEST.md", "KALT.md"]);
    assert!(r.files.iter().all(|x| x.rel.is_some() && x.loaded == ContextLoaded::Always));

    let r = f.report(names_ctx(&["KTEST.md", "KALT.md"], "repo", "all"));
    assert_eq!(
        paths(&r),
        vec![top.join("KTEST.md"), mid.join("KTEST.md"), f.root.join("KTEST.md"), f.root.join("KALT.md")]
    );
    // Outside the root: absolute display, no rel.
    assert_eq!(r.files[0].display, top.join("KTEST.md").to_string_lossy());
    assert_eq!(r.files[0].rel, None);

    let r = f.report(names_ctx(&["KTEST.md"], "ancestors", "all"));
    assert_eq!(&paths(&r)[..4], &[f.base.join("KTEST.md"), top.join("KTEST.md"), mid.join("KTEST.md"), f.root.join("KTEST.md")]);

    let r = f.report(names_ctx(&["KTEST.md", "KALT.md"], "repo", "first"));
    assert_eq!(paths(&r), vec![top.join("KTEST.md"), mid.join("KTEST.md"), f.root.join("KTEST.md")]);

    let r = f.report(names_ctx(&["KALT.md", "KTEST.md"], "ancestors", "nearest"));
    assert_eq!(paths(&r), vec![f.root.join("KALT.md")]);
    let r = f.report(names_ctx(&["KMID.md"], "ancestors", "nearest"));
    assert_eq!(paths(&r), vec![mid.join("KMID.md")]);

    // No git: `repo` is the root only.
    std::fs::remove_dir(top.join(".git")).unwrap();
    let r = f.report(names_ctx(&["KTEST.md"], "repo", "all"));
    assert_eq!(paths(&r), vec![f.root.join("KTEST.md")]);
}

#[test]
fn path_dir_and_home_sources_resolve_and_display() {
    let f = fx();
    write(&f.home.join(".agent/MAIN.md"), "home");
    write(&f.home.join(".agent/OVERRIDE.md"), "override");
    let r = f.report(json!({ "instructions": [
        { "scope": "user", "path": "~/.agent/MAIN.md" },
        { "scope": "user", "names": ["OVERRIDE.md", "MAIN.md"], "dir": "~/.agent", "pick": "first" },
        { "scope": "user", "path": "~/.agent/MISSING.md" }
    ]}));
    // MAIN.md is listed once (dedupe), the `dir` source picks OVERRIDE.md first.
    assert_eq!(displays(&r), vec!["~/.agent/MAIN.md", "~/.agent/OVERRIDE.md"]);
    assert_eq!(r.files[0].scope, ContextScope::User);
    assert_eq!(r.files[0].rel, None);
    // No home: `~` sources are skipped.
    let r = report(&agent(json!({ "instructions": [{ "scope": "user", "path": "~/.agent/MAIN.md" }] })), &f.root, None, OS);
    assert!(r.files.is_empty());
}

#[test]
fn os_filter_skips_sources_for_other_systems() {
    let f = fx();
    write(&f.root.join("WIN.md"), "w");
    write(&f.root.join("MAC.md"), "m");
    let def = agent(json!({ "instructions": [
        { "scope": "managed", "path": "WIN.md", "os": "windows" },
        { "scope": "managed", "path": "MAC.md", "os": "macos" }
    ]}));
    let r = report(&def, &f.root, Some(&f.home), "windows");
    assert_eq!(displays(&r), vec!["WIN.md"]);
    assert_eq!(r.files[0].scope, ContextScope::Managed);
    let r = report(&def, &f.root, Some(&f.home), "linux");
    assert!(r.files.is_empty());
}

#[test]
fn fallback_counts_only_when_its_scope_found_nothing() {
    let f = fx();
    let ctx = json!({ "instructions": [
        { "scope": "user", "path": "~/USER.md" },
        { "scope": "project", "names": ["KPRIMARY.md"], "walk": "root" },
        { "scope": "project", "names": ["KFALLBACK.md"], "walk": "root", "fallback": true }
    ]});
    write(&f.home.join("USER.md"), "u");
    write(&f.root.join("KFALLBACK.md"), "f");
    // A user file does not suppress the project fallback.
    assert_eq!(displays(&f.report(ctx.clone())), vec!["~/USER.md", "KFALLBACK.md"]);
    write(&f.root.join("KPRIMARY.md"), "p");
    assert_eq!(displays(&f.report(ctx)), vec!["~/USER.md", "KPRIMARY.md"]);
}

#[test]
fn nested_matches_are_on_demand_skip_ignored_dirs_and_are_capped() {
    let f = fx();
    let ctx = json!({ "instructions": [{ "scope": "project", "names": ["KNEST.md", ".k/KNEST.md"], "walk": "root", "nested": true }] });
    write(&f.root.join("KNEST.md"), "root");
    write(&f.root.join("sub/a/KNEST.md"), "a");
    write(&f.root.join("sub/b/.k/KNEST.md"), "b");
    write(&f.root.join("node_modules/x/KNEST.md"), "nm");
    write(&f.root.join("target/KNEST.md"), "t");
    write(&f.root.join("ignored/KNEST.md"), "i");
    write(&f.root.join(".gitignore"), "ignored/\n");
    let r = f.report(ctx.clone());
    assert_eq!(displays(&r), vec!["KNEST.md", "sub/a/KNEST.md", "sub/b/.k/KNEST.md"]);
    assert_eq!(r.files[0].loaded, ContextLoaded::Always);
    assert!(r.files[1..].iter().all(|x| x.loaded == ContextLoaded::OnDemand));
    assert_eq!(r.totals.always_tokens, 1);
    assert_eq!(r.totals.on_demand_tokens, 2);

    for i in 0..(walk::MAX_MATCHES + 30) {
        write(&f.root.join(format!("gen/d{i:03}/KNEST.md")), "g");
    }
    let r = f.report(ctx);
    let nested = r.files.iter().filter(|x| x.loaded == ContextLoaded::OnDemand).count();
    assert_eq!(nested, walk::MAX_MATCHES);
}

#[test]
fn import_refs_skip_code_and_email() {
    let text = "Read @docs/a.md, then @~/notes.md.\nMail me@example.com or `@code.md`\n```\n@fenced.md\n```\n  @indented.md\n(@paren.md)";
    assert_eq!(import_refs_for_test(text), vec!["docs/a.md", "~/notes.md", "indented.md"]);
}

fn import_refs_for_test(text: &str) -> Vec<String> {
    walk::import_refs(text)
}

#[test]
fn imports_follow_four_hops_and_stop_cycles() {
    let f = fx();
    write(&f.root.join("KMAIN.md"), "See @docs/a.md and @~/home-note.md and @missing.md");
    write(&f.root.join("docs/a.md"), "@b.md");
    write(&f.root.join("docs/b.md"), "@c.md");
    write(&f.root.join("docs/c.md"), "@d.md");
    write(&f.root.join("docs/d.md"), "@e.md");
    write(&f.root.join("docs/e.md"), "too deep");
    write(&f.home.join("home-note.md"), "home");
    let ctx = json!({ "instructions": [{ "scope": "project", "names": ["KMAIN.md"], "walk": "root", "imports": true }] });
    let r = f.report(ctx);
    assert_eq!(
        displays(&r),
        vec!["KMAIN.md", "docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md", "~/home-note.md"]
    );
    assert_eq!(r.files[1].imported_by.as_deref(), Some("KMAIN.md"));
    assert_eq!(r.files[2].imported_by.as_deref(), Some("docs/a.md"));
    assert_eq!(r.files[5].imported_by.as_deref(), Some("KMAIN.md"));

    // A cycle ends; every file appears once.
    write(&f.root.join("KCYC.md"), "@x.md");
    write(&f.root.join("x.md"), "@y.md");
    write(&f.root.join("y.md"), "@x.md @KCYC.md");
    let r = f.report(json!({ "instructions": [{ "scope": "project", "path": "KCYC.md", "imports": true }] }));
    assert_eq!(displays(&r), vec!["KCYC.md", "x.md", "y.md"]);

    // Without `imports` nothing is followed.
    let r = f.report(json!({ "instructions": [{ "scope": "project", "path": "KCYC.md" }] }));
    assert_eq!(displays(&r), vec!["KCYC.md"]);
}

#[test]
fn max_bytes_flags_project_instructions_past_the_limit() {
    let f = fx();
    let top = f.base.join("top");
    std::fs::create_dir_all(top.join(".git")).unwrap();
    write(&f.home.join("G.md"), "123456789012");
    for d in [top.clone(), top.join("mid"), f.root.clone()] {
        write(&d.join("KAG.md"), "123456");
    }
    let r = f.report(json!({
        "instructions": [
            { "scope": "user", "path": "~/G.md" },
            { "scope": "project", "names": ["KAG.md"], "walk": "repo" }
        ],
        "maxBytes": 10
    }));
    assert_eq!(r.max_bytes, Some(10));
    let flags: Vec<bool> = r.files.iter().map(|x| x.over_limit).collect();
    assert_eq!(flags, vec![false, false, true, true]);
    assert_eq!(r.totals.always_bytes, 12 + 18);
    assert_eq!(r.files[0].tokens, 3);
}

#[test]
fn rule_globs_and_front_matter() {
    let f = fx();
    write(&f.root.join(".claude/rules/a.md"), "plain rule");
    write(&f.root.join(".claude/rules/sub/b.md"), "---\npaths:\n  - \"src/**\"\n---\nconditional");
    write(&f.root.join(".claude/rules/c.txt"), "not md");
    write(&f.root.join(".cursor/rules/on.mdc"), "---\nalwaysApply: true\n---\n");
    write(&f.root.join(".cursor/rules/off.mdc"), "---\ndescription: x\nalwaysApply: false\n---\n");
    write(&f.root.join(".github/instructions/all.instructions.md"), "---\napplyTo: \"**\"\n---\n");
    write(&f.root.join(".github/instructions/ts.instructions.md"), "---\napplyTo: \"**/*.ts\"\n---\n");
    write(&f.home.join(".claude/rules/u.md"), "user rule");
    let r = f.report(json!({ "rules": [
        { "scope": "user", "glob": "~/.claude/rules/**/*.md" },
        { "scope": "project", "glob": ".claude/rules/**/*.md" },
        { "scope": "project", "glob": ".cursor/rules/**/*.mdc" },
        { "scope": "project", "glob": ".github/instructions/**/*.instructions.md" }
    ]}));
    let got: Vec<(&str, ContextLoaded)> = r.files.iter().map(|x| (x.display.as_str(), x.loaded)).collect();
    assert_eq!(
        got,
        vec![
            ("~/.claude/rules/u.md", ContextLoaded::Always),
            (".claude/rules/a.md", ContextLoaded::Always),
            (".claude/rules/sub/b.md", ContextLoaded::OnDemand),
            (".cursor/rules/off.mdc", ContextLoaded::OnDemand),
            (".cursor/rules/on.mdc", ContextLoaded::Always),
            (".github/instructions/all.instructions.md", ContextLoaded::Always),
            (".github/instructions/ts.instructions.md", ContextLoaded::OnDemand),
        ]
    );
    assert!(r.files.iter().all(|x| x.kind == FileKind::Rule));
}

#[test]
fn credential_files_are_never_listed_even_if_a_glob_matches() {
    let f = fx();
    write(&f.home.join(".claude/.credentials.json"), "{\"secret\":\"SECRET_CRED\"}");
    write(&f.home.join(".claude/settings.json"), "{}");
    // Bypasses validation on purpose: the walker filters credential names as well.
    let r = f.report(json!({ "instructions": [{ "scope": "user", "glob": "~/.claude/*.json" }] }));
    assert_eq!(displays(&r), vec!["~/.claude/settings.json"]);
    let cred = f.home.join(".claude/.credentials.json");
    let err = read(&agent(json!({ "instructions": [{ "scope": "user", "glob": "~/.claude/*.json" }] })), &f.root, Some(&f.home), OS, &cred.to_string_lossy());
    assert!(matches!(err, Err(ContextError::NotListed)));
}

#[test]
fn skills_read_front_matter_and_walk_the_repo() {
    let f = fx();
    let top = f.base.join("top");
    std::fs::create_dir_all(top.join(".git")).unwrap();
    write(&f.root.join(".claude/skills/one/SKILL.md"), "---\nname: \"pdf-tools\"\ndescription: 'Fill PDF forms'\n---\nbody");
    write(&f.root.join(".claude/skills/two/SKILL.md"), "no front matter");
    write(&f.root.join(".claude/skills/three/SKILL.md"), "---\nname: three\ndescription: >\n  Long text\n  over lines\n---\n");
    std::fs::create_dir_all(f.root.join(".claude/skills/empty")).unwrap();
    write(&f.home.join(".claude/skills/mine/SKILL.md"), "---\ndescription: user skill\n---\n");
    write(&top.join(".agents/skills/repo-skill/SKILL.md"), "---\nname: repo-skill\n---\n");
    let r = f.report(json!({ "skills": [
        { "scope": "project", "dir": ".claude/skills" },
        { "scope": "user", "dir": "~/.claude/skills" },
        { "scope": "project", "dir": ".agents/skills", "walk": "repo" }
    ]}));
    let got: Vec<(&str, Option<&str>, &str)> =
        r.skills.iter().map(|s| (s.name.as_str(), s.description.as_deref(), s.display.as_str())).collect();
    assert_eq!(
        got,
        vec![
            ("pdf-tools", Some("Fill PDF forms"), ".claude/skills/one/SKILL.md"),
            ("three", Some("Long text over lines"), ".claude/skills/three/SKILL.md"),
            ("two", None, ".claude/skills/two/SKILL.md"),
            ("mine", Some("user skill"), "~/.claude/skills/mine/SKILL.md"),
            ("repo-skill", None, &*top.join(".agents").join("skills").join("repo-skill").join("SKILL.md").to_string_lossy()),
        ]
    );
    assert_eq!(r.skills[0].tokens, ("pdf-tools".len() as u64 + "Fill PDF forms".len() as u64).div_ceil(4));
    assert_eq!(r.skills[1].scope, ContextScope::Project);
    assert_eq!(r.skills[3].scope, ContextScope::User);
    assert_eq!(r.totals.skill_tokens, r.skills.iter().map(|s| s.tokens).sum::<u64>());
}

fn server<'a>(r: &'a ContextReport, name: &str) -> &'a McpServer {
    r.mcp.iter().find(|s| s.name == name).unwrap_or_else(|| panic!("server {name}"))
}

#[test]
fn mcp_json_jsonc_and_toml_show_only_safe_fields() {
    let f = fx();
    write(
        &f.root.join(".mcp.json"),
        &json!({ "mcpServers": {
            "gh": { "command": "C:\\tools\\npx.cmd", "args": ["-y", "pkg", "--token", "SECRET_ARG"], "env": { "GITHUB_TOKEN": "SECRET_ENV" } },
            "web": { "type": "sse", "url": "https://user:SECRET_PW@example.com:8443/p?key=SECRET_QUERY", "headers": { "Authorization": "Bearer SECRET_HEADER" } },
            "plain": { "url": "http://localhost:3000/mcp" },
            "off": { "command": "/usr/bin/off", "disabled": true },
            "odd": {},
            "notAServer": "SECRET_STRING"
        }})
        .to_string(),
    );
    write(
        &f.home.join(".gemini/settings.json"),
        "{\n  // comment with SECRET_COMMENT\n  \"mcpServers\": {\n    \"g\": { \"httpUrl\": \"https://g.example/mcp\", \"enabled\": false, \"oauth\": { \"clientSecret\": \"SECRET_OAUTH\" }, },\n    /* block */\n    \"url\": \"not // a comment\",\n  },\n}\n",
    );
    write(
        &f.home.join(".codex/config.toml"),
        "model = \"x\"\n[mcp_servers.docs]\ncommand = \"uvx\"\nargs = [\"docs-server\"]\nenv = { API_KEY = \"SECRET_TOML\" }\n\n[mcp_servers.remote]\nurl = \"https://api.example.com/mcp?token=SECRET_URL\"\nbearer_token_env_var = \"MY_VAR\"\nhttp_headers = { X-Key = \"SECRET_HH\" }\nenv_http_headers = { X-Env = \"ENV_NAME\" }\nenabled = false\n",
    );
    write(
        &f.root.join("opencode.json"),
        &json!({ "mcp": { "oc": { "type": "local", "command": ["npx", "-y", "oc-server"], "environment": { "K": "SECRET_OC" } },
                          "ocr": { "type": "remote", "url": "https://oc.example/x" } } })
        .to_string(),
    );
    write(
        &f.root.join("opencode.jsonc"),
        &json!({ "mcp": { "servers": { "v2": { "command": "node", "envFile": "/secret/SECRET_ENVFILE.env" } } } }).to_string(),
    );
    let r = f.report(json!({ "mcp": [
        { "scope": "project", "path": ".mcp.json", "format": "json", "pointer": "/mcpServers" },
        { "scope": "user", "path": "~/.gemini/settings.json", "format": "jsonc", "pointer": "/mcpServers" },
        { "scope": "user", "path": "~/.codex/config.toml", "format": "toml", "pointer": "/mcp_servers" },
        { "scope": "project", "path": "opencode.json", "format": "jsonc", "pointer": ["/mcp/servers", "/mcp"] },
        { "scope": "project", "path": "opencode.jsonc", "format": "jsonc", "pointer": ["/mcp/servers", "/mcp"] },
        { "scope": "project", "path": "missing.json", "format": "json", "pointer": "/mcpServers" }
    ]}));

    let gh = server(&r, "gh");
    assert_eq!((gh.transport, gh.command.as_deref(), gh.arg_count), (McpTransport::Stdio, Some("npx.cmd"), 4));
    assert_eq!(gh.secret_keys, vec!["env.GITHUB_TOKEN"]);
    assert_eq!(gh.source, ".mcp.json");
    let web = server(&r, "web");
    assert_eq!((web.transport, web.url.as_deref()), (McpTransport::Sse, Some("https://example.com:8443")));
    assert_eq!(web.secret_keys, vec!["headers.Authorization"]);
    assert_eq!(server(&r, "plain").transport, McpTransport::Http);
    assert_eq!(server(&r, "plain").url.as_deref(), Some("http://localhost:3000"));
    let off = server(&r, "off");
    assert!(off.disabled);
    assert_eq!(off.command.as_deref(), Some("off"));
    assert_eq!(server(&r, "odd").transport, McpTransport::Unknown);
    assert!(r.mcp.iter().all(|s| s.name != "notAServer"));

    let g = server(&r, "g");
    assert_eq!((g.transport, g.disabled, g.url.as_deref()), (McpTransport::Http, true, Some("https://g.example")));
    assert_eq!(g.secret_keys, vec!["oauth.clientSecret"]);
    assert_eq!(g.source, "~/.gemini/settings.json");

    let docs = server(&r, "docs");
    assert_eq!((docs.command.as_deref(), docs.arg_count, docs.scope), (Some("uvx"), 1, ContextScope::User));
    assert_eq!(docs.secret_keys, vec!["env.API_KEY"]);
    let remote = server(&r, "remote");
    assert_eq!((remote.transport, remote.disabled, remote.url.as_deref()), (McpTransport::Http, true, Some("https://api.example.com")));
    assert_eq!(remote.secret_keys, vec!["http_headers.X-Key", "env_http_headers.X-Env"]);

    let oc = server(&r, "oc");
    assert_eq!((oc.transport, oc.command.as_deref(), oc.arg_count), (McpTransport::Stdio, Some("npx"), 2));
    assert_eq!(oc.secret_keys, vec!["environment.K"]);
    assert_eq!(server(&r, "ocr").transport, McpTransport::Http);
    assert_eq!(server(&r, "v2").secret_keys, vec!["envFile"]);
    assert!(r.mcp.iter().all(|s| s.name != "servers"));

    let src: Vec<(&str, bool, u32)> = r.sources.iter().map(|s| (s.display.as_str(), s.exists, s.server_count)).collect();
    assert_eq!(
        src,
        vec![
            (".mcp.json", true, 5),
            ("~/.gemini/settings.json", true, 1),
            ("~/.codex/config.toml", true, 2),
            ("opencode.json", true, 2),
            ("opencode.jsonc", true, 1),
            ("missing.json", false, 0),
        ]
    );
    let text = serde_json::to_string(&r).unwrap();
    assert!(!text.contains("SECRET"), "{text}");
    assert!(!text.contains("docs-server") && !text.contains("MY_VAR") && !text.contains("ENV_NAME"));
}

#[test]
fn mcp_parse_errors_carry_only_a_line_number() {
    let f = fx();
    write(&f.root.join("bad.json"), "{\n \"mcpServers\": { \"a\": SECRET_BAD }\n}");
    write(&f.root.join("bad.toml"), "[mcp_servers.a]\ncommand = SECRET_TOML_BAD\n");
    write(&f.root.join("list.json"), "{ \"mcpServers\": [\"SECRET_LIST\"] }");
    let r = f.report(json!({ "mcp": [
        { "scope": "project", "path": "bad.json", "format": "json", "pointer": "/mcpServers" },
        { "scope": "project", "path": "bad.toml", "format": "toml", "pointer": "/mcp_servers" },
        { "scope": "project", "path": "list.json", "format": "json", "pointer": "/mcpServers" }
    ]}));
    let errors: Vec<Option<&str>> = r.sources.iter().map(|s| s.error.as_deref()).collect();
    assert_eq!(
        errors,
        vec![Some("invalid JSON (line 2)"), Some("invalid TOML (line 2)"), Some("server list is not an object")]
    );
    assert!(r.mcp.is_empty());
    assert!(!serde_json::to_string(&r).unwrap().contains("SECRET"));
}

#[test]
fn claude_json_yields_only_servers_with_local_shadowing() {
    let f = fx();
    let root = f.root.to_string_lossy().into_owned();
    // `~/.claude.json` keys use the OS's own spelling; match it with the other slash
    // style and (Windows) another case.
    let key = if cfg!(windows) { root.replace('\\', "/").to_uppercase() } else { format!("{root}/") };
    let claude_json = json!({
        "numStartups": 12,
        "userID": "SECRET_UID",
        "oauthAccount": { "emailAddress": "person@example.org", "accountUuid": "SECRET_ACCOUNT" },
        "mcpServers": {
            "u1": { "command": "u1", "env": { "U_TOKEN": "SECRET_U" } },
            "shared": { "command": "user-version" }
        },
        "projects": {
            key: {
                "allowedTools": [],
                "history": [{ "display": "SECRET_PROMPT", "pastedContents": {} }],
                "mcpServers": {
                    "loc": { "type": "http", "url": "https://loc.example/mcp", "headers": { "Authorization": "SECRET_LOC" } },
                    "shared": { "command": "local-version" }
                }
            },
            "/some/other/project": { "mcpServers": { "nope": { "command": "nope" } } }
        }
    });
    write(&f.home.join(".claude.json"), &serde_json::to_string_pretty(&claude_json).unwrap());
    write(&f.root.join(".mcp.json"), &json!({ "mcpServers": { "shared": { "command": "project-version" } } }).to_string());
    write(&f.root.join("CLAUDE.md"), "hello");
    let def = agent(json!({
        "instructions": [{ "scope": "project", "path": "CLAUDE.md" }],
        "mcp": [
            { "scope": "project", "path": ".mcp.json", "format": "json", "pointer": "/mcpServers" },
            { "scope": "user", "path": "~/.claude.json", "format": "json", "pointer": "/mcpServers", "projectPointer": true }
        ]
    }));
    let os = if cfg!(windows) { "windows" } else { OS };
    let r = report(&def, &f.root, Some(&f.home), os);
    let got: Vec<(&str, ContextScope, Option<&str>)> =
        r.mcp.iter().map(|s| (s.name.as_str(), s.scope, s.shadowed_by.as_deref())).collect();
    assert_eq!(
        got,
        vec![
            ("shared", ContextScope::Project, Some("~/.claude.json")),
            ("u1", ContextScope::User, None),
            ("shared", ContextScope::User, Some("~/.claude.json")),
            ("loc", ContextScope::Local, None),
            ("shared", ContextScope::Local, None),
        ]
    );
    let src: Vec<(ContextScope, &str, u32)> = r.sources.iter().map(|s| (s.scope, s.display.as_str(), s.server_count)).collect();
    assert_eq!(
        src,
        vec![
            (ContextScope::Project, ".mcp.json", 1),
            (ContextScope::User, "~/.claude.json", 2),
            (ContextScope::Local, "~/.claude.json", 2),
        ]
    );
    let text = serde_json::to_string(&r).unwrap();
    for leaked in ["person@example.org", "SECRET", "numStartups", "nope", "allowedTools", "history"] {
        assert!(!text.contains(leaked), "{leaked} in {text}");
    }

    // `context_read` never returns `~/.claude.json` or `.mcp.json`, nor an unlisted file.
    let claude_json_path = f.home.join(".claude.json");
    for p in [claude_json_path, f.root.join(".mcp.json"), f.root.join("other.md")] {
        write(&f.root.join("other.md"), "x");
        assert!(matches!(read(&def, &f.root, Some(&f.home), os, &p.to_string_lossy()), Err(ContextError::NotListed)), "{p:?}");
    }
    let ok = read(&def, &f.root, Some(&f.home), os, &f.root.join("CLAUDE.md").to_string_lossy()).unwrap();
    assert_eq!(ok, ContextText { text: "hello".into(), truncated: false });
}

#[test]
fn context_read_returns_listed_files_and_skills_capped() {
    let f = fx();
    let big = "é".repeat(MAX_READ_BYTES); // 2 bytes each: the cut falls inside a char
    write(&f.root.join("BIG.md"), &format!("\u{feff}a{big}"));
    write(&f.root.join(".s/one/SKILL.md"), "---\nname: one\n---\nskill body");
    let def = agent(json!({
        "instructions": [{ "scope": "project", "path": "BIG.md" }],
        "skills": [{ "scope": "project", "dir": ".s" }]
    }));
    let t = read(&def, &f.root, Some(&f.home), OS, &f.root.join("BIG.md").to_string_lossy()).unwrap();
    assert!(t.truncated);
    assert!(t.text.starts_with("aé") && !t.text.contains('\u{fffd}') && !t.text.starts_with('\u{feff}'));
    assert!(t.text.len() <= MAX_READ_BYTES);
    let s = read(&def, &f.root, Some(&f.home), OS, &f.root.join(".s/one/SKILL.md").to_string_lossy()).unwrap();
    assert!(s.text.ends_with("skill body") && !s.truncated);
}

#[test]
fn unsupported_agent_reports_nothing() {
    let f = fx();
    let d = crate::adapters::tests::def("plain");
    let r = report(&d, &f.root, Some(&f.home), OS);
    assert!(!r.supported);
    assert!(r.files.is_empty() && r.mcp.is_empty() && r.sources.is_empty() && r.max_bytes.is_none());
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["maxBytes"], serde_json::Value::Null);
    assert_eq!(v["totals"], json!({ "alwaysTokens": 0, "onDemandTokens": 0, "skillTokens": 0, "alwaysBytes": 0 }));
}

#[test]
fn report_serializes_in_the_contract_shape() {
    let f = fx();
    write(&f.root.join("KX.md"), "abcde");
    let r = f.report(json!({ "instructions": [{ "scope": "project", "path": "KX.md" }] }));
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["agent"], "test-agent");
    assert_eq!(v["supported"], true);
    let file = &v["files"][0];
    assert_eq!(file["kind"], "instruction");
    assert_eq!(file["scope"], "project");
    assert_eq!(file["display"], "KX.md");
    assert_eq!(file["rel"], "KX.md");
    assert_eq!(file["bytes"], 5);
    assert_eq!(file["tokens"], 2);
    assert_eq!(file["loaded"], "always");
    assert_eq!(file["importedBy"], serde_json::Value::Null);
    assert_eq!(file["overLimit"], false);
    assert_eq!(file["error"], serde_json::Value::Null);
    for k in ["root", "skills", "mcp", "sources", "maxBytes", "totals"] {
        assert!(v.get(k).is_some(), "{k}");
    }
}

fn builtin(id: &str) -> AdapterDefinition {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../adapters");
    let defs = Definitions::load(Some(&dir), None);
    assert!(defs.errors.is_empty(), "{:?}", defs.errors);
    defs.get(id).unwrap_or_else(|| panic!("{id}")).def.clone()
}

#[test]
fn builtin_claude_code_context() {
    let f = fx();
    write(&f.home.join(".claude/CLAUDE.md"), "user @~/.claude/extra.md");
    write(&f.home.join(".claude/extra.md"), "extra");
    write(&f.home.join(".claude/skills/s/SKILL.md"), "---\nname: s\ndescription: d\n---\n");
    write(&f.root.join("CLAUDE.md"), "project");
    write(&f.root.join("AGENTS.md"), "not used: CLAUDE.md exists");
    write(&f.root.join("pkg/CLAUDE.md"), "nested");
    write(&f.root.join(".claude/rules/r.md"), "rule");
    write(&f.root.join(".mcp.json"), &json!({ "mcpServers": { "p": { "command": "p" } } }).to_string());
    write(&f.home.join(".claude.json"), &json!({ "mcpServers": { "u": { "command": "u" } } }).to_string());
    let r = report(&builtin("claude-code"), &f.root, Some(&f.home), OS);
    let d = displays(&r);
    for want in ["~/.claude/CLAUDE.md", "~/.claude/extra.md", "CLAUDE.md", "pkg/CLAUDE.md", ".claude/rules/r.md"] {
        assert!(d.contains(&want), "{want} missing in {d:?}");
    }
    assert!(!d.contains(&"AGENTS.md"));
    assert_eq!(r.files.iter().find(|x| x.display == "pkg/CLAUDE.md").unwrap().loaded, ContextLoaded::OnDemand);
    assert_eq!(r.skills.len(), 1);
    assert_eq!(r.mcp.len(), 2);
    assert_eq!(r.sources.len(), 3);

    std::fs::remove_file(f.root.join("CLAUDE.md")).unwrap();
    let r = report(&builtin("claude-code"), &f.root, Some(&f.home), OS);
    assert!(displays(&r).contains(&"AGENTS.md"));
}

#[test]
fn builtin_codex_context() {
    let f = fx();
    std::fs::create_dir_all(f.base.join("top/.git")).unwrap();
    write(&f.home.join(".codex/AGENTS.override.md"), "override");
    write(&f.home.join(".codex/AGENTS.md"), "ignored");
    write(&f.base.join("top/AGENTS.md"), "repo");
    write(&f.root.join("AGENTS.md"), "root");
    write(&f.home.join(".codex/config.toml"), "[mcp_servers.x]\ncommand = \"x\"\n");
    write(&f.base.join("top/.agents/skills/k/SKILL.md"), "---\nname: k\n---\n");
    let r = report(&builtin("codex"), &f.root, Some(&f.home), OS);
    let top_agents = f.base.join("top").join("AGENTS.md").to_string_lossy().into_owned();
    assert_eq!(displays(&r), vec!["~/.codex/AGENTS.override.md", top_agents.as_str(), "AGENTS.md"]);
    assert_eq!(r.max_bytes, Some(32768));
    assert_eq!(r.mcp.len(), 1);
    assert_eq!(r.skills.len(), 1);
}

#[test]
fn builtin_opencode_context_falls_back_to_claude_files() {
    let f = fx();
    write(&f.home.join(".claude/CLAUDE.md"), "claude user");
    write(&f.root.join("CLAUDE.md"), "claude project");
    write(&f.root.join("opencode.jsonc"), "{ \"mcp\": { \"a\": { \"type\": \"local\", \"command\": [\"a\"] }, }, }");
    let r = report(&builtin("opencode"), &f.root, Some(&f.home), OS);
    let d = displays(&r);
    assert!(d.contains(&"~/.claude/CLAUDE.md") && d.contains(&"CLAUDE.md"), "{d:?}");
    assert_eq!(r.mcp.len(), 1);

    write(&f.home.join(".config/opencode/AGENTS.md"), "oc user");
    write(&f.root.join("AGENTS.md"), "oc project");
    let r = report(&builtin("opencode"), &f.root, Some(&f.home), OS);
    let d = displays(&r);
    assert!(d.contains(&"~/.config/opencode/AGENTS.md") && d.contains(&"AGENTS.md"), "{d:?}");
    assert!(!d.contains(&"~/.claude/CLAUDE.md") && !d.contains(&"CLAUDE.md"), "{d:?}");
}

#[test]
fn every_builtin_reports_without_errors_on_an_empty_home() {
    let f = fx();
    for id in ["claude-code", "codex", "copilot", "cursor", "droid", "gemini", "opencode", "qwen"] {
        let def = builtin(id);
        assert!(def.context.is_some(), "{id} has no context");
        let r = report(&def, &f.root, Some(&f.home), OS);
        assert!(r.supported, "{id}");
        assert!(r.mcp.is_empty(), "{id}");
        assert!(r.sources.iter().all(|s| !s.exists && s.error.is_none()), "{id}");
    }
}

/// Manual integration check (0.9 C): this repo + the real home, read-only.
/// Prints only metadata (names, sizes, counts). Run with
/// `cargo test -p agenthub --lib context::tests::real_home_smoke -- --ignored --nocapture`.
#[test]
#[ignore]
fn real_home_smoke() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap();
    let home = crate::platform::home_dir(&|k| std::env::var(k).ok()).map(PathBuf::from);
    for id in ["claude-code", "codex", "copilot", "cursor", "droid", "gemini", "opencode", "qwen"] {
        let start = std::time::Instant::now();
        let r = report(&builtin(id), &root, home.as_deref(), crate::platform::os_id());
        println!("== {id} ({} ms) totals {:?}", start.elapsed().as_millis(), r.totals);
        for f in &r.files {
            println!("  file {:?} {:?} {} {}B {}t over={} err={:?}", f.kind, f.loaded, f.display, f.bytes, f.tokens, f.over_limit, f.error);
        }
        for s in &r.skills {
            println!("  skill {} {}t {}", s.name, s.tokens, s.display);
        }
        for m in &r.mcp {
            println!("  mcp {} {:?} cmd={:?} url={:?} keys={} disabled={} shadow={:?} src={}", m.name, m.transport, m.command, m.url, m.secret_keys.len(), m.disabled, m.shadowed_by, m.source);
        }
        for s in &r.sources {
            println!("  source {} exists={} servers={} err={:?}", s.display, s.exists, s.server_count, s.error);
        }
    }
}
