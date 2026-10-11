//! Faz 5 §1.4 / §4 items 4, 11: heuristic agent detection — classifying a pane's
//! subprocess tree into an [`AgentKind`] (or not), and the "is this record still
//! justified" presence check that decides whether a record should be removed.
//!
//! Pure and unit-tested against synthetic process lists; the real Windows-side queries
//! (`pty::system_process_snapshot`, `pty::process_command_line`) are injected by the
//! caller (`agents::AgentTracker::tick`) so none of this needs a real process tree.

use std::collections::HashMap;

use crate::adapters::Definitions;
use crate::pty::ProcSnapshotEntry;

use super::Source;

/// Lowercase file stem without a trailing `.exe`.
fn exe_stem(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_string()
}

/// M3: exact image-filename match (spec §1.4) against every definition's
/// `detect.executables`, case-insensitively and with or without `.exe` on either side.
/// Returns the adapter id.
pub fn classify_image_name<'a>(name: &str, defs: &'a Definitions) -> Option<&'a str> {
    let stem = exe_stem(name);
    defs.items
        .iter()
        .find(|d| d.def.detect.executables.iter().any(|e| exe_stem(e) == stem))
        .map(|d| d.def.id.as_str())
}

/// M3: `node.exe`'s command line (spec §1.4: npm-installed agents) against every
/// definition's `detect.nodeScripts` — a case-insensitive substring match with `\`
/// treated as `/`, so `@openai/codex` matches `...\node_modules\@openai\codex\bin\codex.js`.
pub fn classify_node_cmdline<'a>(cmdline: &str, defs: &'a Definitions) -> Option<&'a str> {
    let normalized = cmdline.to_ascii_lowercase().replace('\\', "/");
    defs.items
        .iter()
        .find(|d| {
            d.def.detect.node_scripts.iter().any(|s| {
                let script = s.to_ascii_lowercase().replace('\\', "/");
                !script.is_empty() && normalized.contains(&script)
            })
        })
        .map(|d| d.def.id.as_str())
}

/// Classifies a pane's already-walked descendant list (spec §1.4): an exact image-name
/// match wins outright; otherwise every `node.exe` descendant's command line is
/// consulted (via `query_cmdline`, cached by `(pid, creation_time)` in `cmdline_cache`
/// — spec §4 item 11 — so a repeat tick never re-queries the same still-alive process).
/// Returns the matching definition's adapter id.
pub fn classify_descendants(
    descendants: &[ProcSnapshotEntry],
    cmdline_cache: &mut HashMap<(u32, u64), Option<String>>,
    query_cmdline: &dyn Fn(u32) -> Option<String>,
    defs: &Definitions,
) -> Option<String> {
    for entry in descendants {
        if let Some(id) = classify_image_name(&entry.name, defs) {
            return Some(id.to_string());
        }
    }
    if !defs.items.iter().any(|d| !d.def.detect.node_scripts.is_empty()) {
        return None;
    }
    for entry in descendants {
        if !entry.name.eq_ignore_ascii_case("node.exe") {
            continue;
        }
        let key = (entry.pid, entry.creation_time);
        let cmdline = cmdline_cache
            .entry(key)
            .or_insert_with(|| query_cmdline(entry.pid))
            .clone();
        if let Some(cmdline) = cmdline {
            if let Some(id) = classify_node_cmdline(&cmdline, defs) {
                return Some(id.to_string());
            }
        }
    }
    None
}

/// Spec §4 item 4: whether an existing record is still "present" this tick, and the
/// updated miss-streak counter. A `Heuristic`-sourced record's presence is the specific
/// image/cmdline classifier match; a `Hook`-sourced record's presence is the broader
/// "is anything other than the shell running under this pane" signal (`pty::decide_busy`
/// — deliberately *not* the specific classifier, since a hook-confirmed Claude session
/// might be between tool calls with nothing but the shell running and no hook due for a
/// while). Two consecutive misses (`>= 2`) recommend removal; any miss resets on a hit.
pub fn presence_tick(
    source: Source,
    classifier_matched: bool,
    busy: bool,
    miss_count: u32,
) -> (bool /* should_remove */, u32 /* new_miss_count */) {
    let present = match source {
        Source::Heuristic => classifier_matched,
        Source::Hook => busy,
    };
    if present {
        (false, 0)
    } else {
        let new_miss = miss_count + 1;
        (new_miss >= 2, new_miss)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pid: u32, ppid: u32, name: &str, creation_time: u64) -> ProcSnapshotEntry {
        ProcSnapshotEntry {
            pid,
            ppid,
            name: name.to_string(),
            creation_time,
        }
    }

    /// The repo's built-in definitions (claude-code, codex) plus in-memory ones for agents
    /// whose built-in files arrive later (M3 wave 2).
    fn defs() -> Definitions {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../adapters");
        let mut defs = Definitions::load(Some(&dir), None);
        let mut gemini = crate::adapters::tests::def("gemini");
        gemini.detect.executables = vec!["gemini".into()];
        gemini.detect.node_scripts = vec!["@google/gemini-cli".into()];
        let mut cursor = crate::adapters::tests::def("cursor");
        cursor.detect.executables = vec!["cursor-agent.exe".into()];
        defs.items.extend(Definitions::from_builtin(vec![gemini, cursor]).items);
        defs
    }

    #[test]
    fn classify_image_name_matches_definitions_case_insensitively() {
        let defs = defs();
        assert_eq!(classify_image_name("claude.exe", &defs), Some("claude-code"));
        assert_eq!(classify_image_name("CLAUDE.EXE", &defs), Some("claude-code"));
        assert_eq!(classify_image_name("claude", &defs), Some("claude-code"));
        assert_eq!(classify_image_name("codex.exe", &defs), Some("codex"));
        assert_eq!(classify_image_name("gemini.exe", &defs), Some("gemini"));
        assert_eq!(classify_image_name("cursor-agent.exe", &defs), Some("cursor"));
        assert_eq!(classify_image_name("pwsh.exe", &defs), None);
        assert_eq!(classify_image_name("node.exe", &defs), None);
        assert_eq!(classify_image_name("claude.exe", &Definitions::default()), None);
    }

    #[test]
    fn classify_node_cmdline_matches_each_npm_agent() {
        let defs = defs();
        assert_eq!(
            classify_node_cmdline(
                r#""C:\Program Files\nodejs\node.exe" C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js"#,
                &defs
            ),
            Some("claude-code")
        );
        assert_eq!(
            classify_node_cmdline("node /usr/lib/node_modules/@openai/codex/bin/codex.js", &defs),
            Some("codex")
        );
        assert_eq!(
            classify_node_cmdline("node @google/gemini-cli/dist/index.js", &defs),
            Some("gemini")
        );
        assert_eq!(classify_node_cmdline("node some-other-tool.js", &defs), None);
    }

    #[test]
    fn classify_descendants_prefers_exact_image_match_over_node_cmdline() {
        let descendants = vec![
            entry(10, 1, "node.exe", 5),
            entry(11, 1, "claude.exe", 6),
        ];
        let mut cache = HashMap::new();
        let matched = classify_descendants(&descendants, &mut cache, &|_| None, &defs());
        assert_eq!(matched.as_deref(), Some("claude-code"));
        // The node.exe pid was never consulted since the image match already won.
        assert!(cache.is_empty());
    }

    #[test]
    fn classify_descendants_falls_back_to_node_cmdline() {
        let descendants = vec![entry(10, 1, "node.exe", 5)];
        let mut cache = HashMap::new();
        let matched = classify_descendants(
            &descendants,
            &mut cache,
            &|pid| {
                assert_eq!(pid, 10);
                Some(r"node C:\npm\node_modules\@anthropic-ai\claude-code\cli.js".to_string())
            },
            &defs(),
        );
        assert_eq!(matched.as_deref(), Some("claude-code"));
    }

    #[test]
    fn classify_descendants_caches_cmdline_query_by_pid_and_creation_time() {
        let defs = defs();
        let descendants = vec![entry(10, 1, "node.exe", 5)];
        let mut cache = HashMap::new();
        let calls = std::cell::Cell::new(0);
        {
            let query = |_pid: u32| {
                calls.set(calls.get() + 1);
                None
            };
            let _ = classify_descendants(&descendants, &mut cache, &query, &defs);
        }
        assert_eq!(calls.get(), 1);
        // Second tick, same (pid, creation_time): served from cache, no re-query.
        let calls2 = std::cell::Cell::new(0);
        let query2 = |_pid: u32| {
            calls2.set(calls2.get() + 1);
            None
        };
        let _ = classify_descendants(&descendants, &mut cache, &query2, &defs);
        assert_eq!(calls2.get(), 0);
    }

    #[test]
    fn classify_descendants_none_when_nothing_matches() {
        let descendants = vec![entry(10, 1, "explorer.exe", 5)];
        let mut cache = HashMap::new();
        assert_eq!(classify_descendants(&descendants, &mut cache, &|_| None, &defs()), None);
    }

    #[test]
    fn classify_descendants_skips_cmdline_queries_without_node_scripts() {
        let mut cursor = crate::adapters::tests::def("cursor");
        cursor.detect.executables = vec!["cursor-agent.exe".into()];
        let defs = Definitions::from_builtin(vec![cursor]);
        let mut cache = HashMap::new();
        let matched = classify_descendants(&[entry(10, 1, "node.exe", 5)], &mut cache, &|_| panic!("queried"), &defs);
        assert_eq!(matched, None);
    }

    #[test]
    fn presence_tick_heuristic_record_present_resets_miss_count() {
        assert_eq!(presence_tick(Source::Heuristic, true, true, 1), (false, 0));
    }

    #[test]
    fn presence_tick_heuristic_record_absent_once_is_not_yet_removed() {
        assert_eq!(presence_tick(Source::Heuristic, false, true, 0), (false, 1));
    }

    #[test]
    fn presence_tick_heuristic_record_absent_twice_is_removed() {
        assert_eq!(presence_tick(Source::Heuristic, false, true, 1), (true, 2));
    }

    #[test]
    fn presence_tick_hook_record_uses_busy_not_classifier() {
        // classifier says no match, but something non-shell is still running: present.
        assert_eq!(presence_tick(Source::Hook, false, true, 1), (false, 0));
    }

    #[test]
    fn presence_tick_hook_record_removed_after_two_idle_ticks() {
        assert_eq!(presence_tick(Source::Hook, true, false, 0), (false, 1));
        assert_eq!(presence_tick(Source::Hook, true, false, 1), (true, 2));
    }
}
