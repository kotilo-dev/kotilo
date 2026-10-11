//! M3: data-driven screen rules (`adapter.json` → `screenRules`, D-002 follow-up). A rule
//! is a regex over the last `lines` non-blank visible lines of an agent pane's terminal
//! screen; a match reports a state the agent's own hooks cannot (e.g. Cursor's permission
//! prompt). Everything here is pure: the per-pane `vt100` screen lives in `pty`, the
//! state mapping in `agents`.

use regex::Regex;
use serde::{Deserialize, Serialize};

/// Default number of screen lines a rule looks at.
pub const DEFAULT_RULE_LINES: usize = 6;
/// Upper bound for `lines` (schema: 1..50).
pub const MAX_RULE_LINES: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenState {
    WaitingPermission,
    WaitingInput,
    Working,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClearOn {
    Output,
    Input,
}

/// One `screenRules[]` entry as written in `adapter.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenRule {
    pub id: String,
    pub state: ScreenState,
    pub pattern: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_on: Option<ClearOn>,
}

/// A rule with its regex compiled once per definition load.
#[derive(Debug, Clone)]
pub struct CompiledRule {
    pub id: String,
    pub state: ScreenState,
    pub regex: Regex,
    pub lines: usize,
    pub clear_on: Option<ClearOn>,
}

/// Compiles every rule; the first invalid one (empty id, `lines` out of range, bad
/// regex) makes the whole definition invalid.
pub fn compile_rules(rules: &[ScreenRule]) -> Result<Vec<CompiledRule>, String> {
    let mut out = Vec::with_capacity(rules.len());
    for (i, rule) in rules.iter().enumerate() {
        if rule.id.trim().is_empty() {
            return Err(format!("screenRules[{i}]: id is empty"));
        }
        if rule.pattern.is_empty() {
            return Err(format!("screenRules[{i}] ({}): pattern is empty", rule.id));
        }
        let lines = match rule.lines {
            None => DEFAULT_RULE_LINES,
            Some(n) if (1..=MAX_RULE_LINES as u32).contains(&n) => n as usize,
            Some(n) => {
                return Err(format!(
                    "screenRules[{i}] ({}): lines must be 1..{MAX_RULE_LINES}, got {n}",
                    rule.id
                ))
            }
        };
        let regex = Regex::new(&rule.pattern)
            .map_err(|e| format!("screenRules[{i}] ({}): invalid pattern: {e}", rule.id))?;
        out.push(CompiledRule {
            id: rule.id.clone(),
            state: rule.state,
            regex,
            lines,
            clear_on: rule.clear_on,
        });
    }
    Ok(out)
}

/// How many screen lines the rules need at most.
pub fn max_lines(rules: &[CompiledRule]) -> usize {
    rules.iter().map(|r| r.lines).max().unwrap_or(0)
}

/// The last `n` lines of `rows` (the visible screen, top to bottom), with each row's
/// trailing spaces and the blank rows below the last text dropped first — a TUI often
/// leaves the bottom of the screen empty — joined by `\n`.
pub fn tail_text(rows: &[String], n: usize) -> String {
    let end = rows
        .iter()
        .rposition(|r| !r.trim().is_empty())
        .map(|i| i + 1)
        .unwrap_or(0);
    let start = end.saturating_sub(n);
    rows[start..end]
        .iter()
        .map(|r| r.trim_end())
        .collect::<Vec<_>>()
        .join("\n")
}

/// A rule that matched this tick: its index in the rule list and the matched text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleMatch {
    pub index: usize,
    pub text: String,
}

/// The first rule (in file order) accepted by `allow` whose pattern matches its tail of
/// `rows`.
pub fn first_match(
    rules: &[CompiledRule],
    rows: &[String],
    allow: impl Fn(&CompiledRule) -> bool,
) -> Option<RuleMatch> {
    rules.iter().enumerate().find_map(|(index, rule)| {
        if !allow(rule) {
            return None;
        }
        let text = tail_text(rows, rule.lines);
        rule.regex.find(&text).map(|m| RuleMatch {
            index,
            text: m.as_str().to_string(),
        })
    })
}

/// The rule currently in force for a pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenHit {
    pub rule_id: String,
    pub state: ScreenState,
    pub clear_on: Option<ClearOn>,
    pub text: String,
    /// When the hit was raised (input/output after this clears a `clearOn` rule).
    pub at_ms: u64,
}

/// Per-pane screen-rule bookkeeping.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScreenTrack {
    pub hit: Option<ScreenHit>,
    /// `(rule id, matched text)` of a hit cleared by `clearOn` while its text was still on
    /// screen: not raised again until that match goes away or changes.
    suppressed: Option<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenEvent {
    None,
    /// A new hit (possibly replacing another one).
    Raised(ScreenState),
    /// The hit in force was dropped and nothing replaced it.
    Cleared(ScreenState),
}

/// Advances `track` by one tick. `current` is this tick's [`first_match`] result.
///
/// - Without `clearOn` a hit lasts exactly as long as its rule keeps matching.
/// - `clearOn: "input"` / `"output"`: the hit sticks (even if the text scrolls away) until
///   the user types into the pane / the pane prints new output after the hit was raised;
///   then it is dropped and the same matched text is not raised again.
/// - A different rule matching replaces the hit.
pub fn step(
    track: &mut ScreenTrack,
    rules: &[CompiledRule],
    current: Option<RuleMatch>,
    last_input_ms: u64,
    last_output_ms: u64,
    now_ms: u64,
) -> ScreenEvent {
    let current = current.and_then(|m| rules.get(m.index).map(|r| (r, m.text)));
    match &current {
        None => track.suppressed = None,
        Some((rule, text)) => {
            if track
                .suppressed
                .as_ref()
                .is_some_and(|(id, t)| (id != &rule.id) || (t != text))
            {
                track.suppressed = None;
            }
        }
    }
    let raisable = current.filter(|(rule, text)| {
        track.suppressed.as_ref() != Some(&(rule.id.clone(), text.clone()))
    });

    let mut cleared = None;
    if let Some(hit) = track.hit.take() {
        let same_rule = raisable.as_ref().is_some_and(|(r, _)| r.id == hit.rule_id);
        let other_rule = raisable.is_some() && !same_rule;
        let drop = match hit.clear_on {
            None => !same_rule,
            Some(ClearOn::Input) => other_rule || last_input_ms > hit.at_ms,
            Some(ClearOn::Output) => other_rule || last_output_ms > hit.at_ms,
        };
        if !drop {
            let text = raisable.map_or(hit.text.clone(), |(_, t)| t);
            track.hit = Some(ScreenHit { text, ..hit });
            return ScreenEvent::None;
        }
        if hit.clear_on.is_some() && same_rule {
            // Cleared by input/output while still on screen: don't raise it right back.
            if let Some((rule, text)) = &raisable {
                track.suppressed = Some((rule.id.clone(), text.clone()));
            }
            return ScreenEvent::Cleared(hit.state);
        }
        cleared = Some(hit.state);
    }

    if let Some((rule, text)) = raisable {
        track.hit = Some(ScreenHit {
            rule_id: rule.id.clone(),
            state: rule.state,
            clear_on: rule.clear_on,
            text,
            at_ms: now_ms,
        });
        return ScreenEvent::Raised(rule.state);
    }
    cleared.map_or(ScreenEvent::None, ScreenEvent::Cleared)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: &str, state: ScreenState, pattern: &str, clear_on: Option<ClearOn>) -> ScreenRule {
        ScreenRule {
            id: id.to_string(),
            state,
            pattern: pattern.to_string(),
            lines: None,
            clear_on,
        }
    }

    fn rows(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn compile_rejects_bad_regex_and_line_counts() {
        let bad = rule("p", ScreenState::Working, "(unclosed", None);
        assert!(compile_rules(&[bad]).unwrap_err().contains("invalid pattern"));
        let mut lines = rule("p", ScreenState::Working, "x", None);
        lines.lines = Some(0);
        assert!(compile_rules(&[lines.clone()]).is_err());
        lines.lines = Some(51);
        assert!(compile_rules(&[lines.clone()]).is_err());
        lines.lines = Some(50);
        assert_eq!(compile_rules(&[lines]).unwrap()[0].lines, 50);
        assert!(compile_rules(&[rule(" ", ScreenState::Working, "x", None)]).is_err());
        assert!(compile_rules(&[rule("p", ScreenState::Working, "", None)]).is_err());
    }

    #[test]
    fn rule_json_uses_camel_case_and_ignores_unknown_fields() {
        let r: ScreenRule = serde_json::from_str(
            r#"{"id":"perm","state":"waitingPermission","pattern":"Allow\\?","lines":3,"clearOn":"input","future":1}"#,
        )
        .unwrap();
        assert_eq!(r.state, ScreenState::WaitingPermission);
        assert_eq!(r.clear_on, Some(ClearOn::Input));
        assert_eq!(r.lines, Some(3));
    }

    #[test]
    fn tail_text_skips_blank_bottom_rows_and_trailing_spaces() {
        let screen = rows(&["one", "two   ", "three", "", "   ", ""]);
        assert_eq!(tail_text(&screen, 2), "two\nthree");
        assert_eq!(tail_text(&screen, 10), "one\ntwo\nthree");
        assert_eq!(tail_text(&rows(&["", ""]), 3), "");
    }

    #[test]
    fn first_match_respects_lines_order_and_filter() {
        let mut r1 = rule("old", ScreenState::Working, "top line", None);
        r1.lines = Some(1);
        let r2 = rule("perm", ScreenState::WaitingPermission, r"Run this command\?", None);
        let rules = compile_rules(&[r1, r2]).unwrap();
        let screen = rows(&["top line", "Run this command?", "> yes"]);
        // "top line" is outside r1's single line; r2 sees the last 6.
        assert_eq!(first_match(&rules, &screen, |_| true).unwrap().index, 1);
        assert!(first_match(&rules, &screen, |r| r.state != ScreenState::WaitingPermission).is_none());
    }

    #[test]
    fn hit_without_clear_on_lasts_while_the_rule_matches() {
        let rules = compile_rules(&[rule("perm", ScreenState::WaitingPermission, "Allow", None)]).unwrap();
        let mut t = ScreenTrack::default();
        let m = Some(RuleMatch { index: 0, text: "Allow".into() });
        assert_eq!(step(&mut t, &rules, m.clone(), 0, 0, 10), ScreenEvent::Raised(ScreenState::WaitingPermission));
        assert_eq!(step(&mut t, &rules, m, 50, 50, 20), ScreenEvent::None);
        assert_eq!(step(&mut t, &rules, None, 50, 50, 30), ScreenEvent::Cleared(ScreenState::WaitingPermission));
        assert!(t.hit.is_none());
    }

    #[test]
    fn clear_on_input_sticks_until_input_and_is_not_re_raised_for_the_same_text() {
        let rules = compile_rules(&[rule("q", ScreenState::WaitingInput, "Continue\\?", Some(ClearOn::Input))]).unwrap();
        let mut t = ScreenTrack::default();
        let m = Some(RuleMatch { index: 0, text: "Continue?".into() });
        assert_eq!(step(&mut t, &rules, m.clone(), 0, 0, 100), ScreenEvent::Raised(ScreenState::WaitingInput));
        // Text scrolled away, no input yet: still in force.
        assert_eq!(step(&mut t, &rules, None, 0, 150, 200), ScreenEvent::None);
        // Visible again, then the user types.
        assert_eq!(step(&mut t, &rules, m.clone(), 0, 150, 250), ScreenEvent::None);
        assert_eq!(step(&mut t, &rules, m.clone(), 300, 150, 350), ScreenEvent::Cleared(ScreenState::WaitingInput));
        // Same prompt text still on screen: suppressed.
        assert_eq!(step(&mut t, &rules, m.clone(), 300, 150, 400), ScreenEvent::None);
        // It goes away and comes back: raised again.
        assert_eq!(step(&mut t, &rules, None, 300, 150, 450), ScreenEvent::None);
        assert_eq!(step(&mut t, &rules, m, 300, 150, 500), ScreenEvent::Raised(ScreenState::WaitingInput));
    }

    #[test]
    fn clear_on_output_drops_on_new_output() {
        let rules = compile_rules(&[rule("d", ScreenState::Done, "Task complete", Some(ClearOn::Output))]).unwrap();
        let mut t = ScreenTrack::default();
        let m = Some(RuleMatch { index: 0, text: "Task complete".into() });
        assert_eq!(step(&mut t, &rules, m.clone(), 0, 90, 100), ScreenEvent::Raised(ScreenState::Done));
        assert_eq!(step(&mut t, &rules, None, 0, 100, 200), ScreenEvent::None);
        assert_eq!(step(&mut t, &rules, None, 0, 201, 300), ScreenEvent::Cleared(ScreenState::Done));
    }

    #[test]
    fn another_rule_replaces_the_hit() {
        let rules = compile_rules(&[
            rule("perm", ScreenState::WaitingPermission, "Allow", None),
            rule("work", ScreenState::Working, "esc to interrupt", Some(ClearOn::Input)),
        ])
        .unwrap();
        let mut t = ScreenTrack::default();
        step(&mut t, &rules, Some(RuleMatch { index: 1, text: "esc to interrupt".into() }), 0, 0, 10);
        assert_eq!(
            step(&mut t, &rules, Some(RuleMatch { index: 0, text: "Allow".into() }), 0, 0, 20),
            ScreenEvent::Raised(ScreenState::WaitingPermission)
        );
        assert_eq!(t.hit.as_ref().unwrap().rule_id, "perm");
    }

    /// M3 wave 2: the shipped `adapters/cursor/adapter.json` rule against synthetic Cursor CLI
    /// screens fed through a `vt100` pane. The prompt layout is UNVERIFIED (docs only say
    /// "approve (y) or reject (n)"); re-check against a live capture.
    #[test]
    fn cursor_definition_detects_its_approval_prompt() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../adapters");
        let defs = crate::adapters::Definitions::load(Some(&dir), None);
        let rules = &defs.get("cursor").expect("cursor definition").rules;
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].state, ScreenState::WaitingPermission);

        let screen_of = |bytes: &[u8]| {
            let mut screen = crate::pty::PaneScreen::new(24, 80);
            screen.set_enabled(true);
            screen.process(bytes);
            screen.rows().unwrap()
        };
        let matched = |bytes: &[u8]| first_match(rules, &screen_of(bytes), |_| true).is_some();

        // Menu-style approval box at the bottom of the TUI, with colours and cursor moves.
        assert!(matched(
            b"\x1b[2J\x1b[H  Running tests...\x1b[15;1H\x1b[1m  Run this command?\x1b[0m\r\n  Not in allowlist: npm test\r\n \
              \x1b[36m\xe2\x86\x92 Run (once) (y)\x1b[0m\r\n    Skip (esc or n)\r\n    Add Shell(npm) to allowlist? (tab)\r\n    \
              Auto-run everything (shift+tab)\r\n"
        ));
        // The documented wording on one line, and a classic (y/n) prompt.
        assert!(matched(b"Approve (y) or reject (n) execution of: npm test\r\n"));
        assert!(matched(b"Run this command? (y/n)\r\n"));

        // Ordinary output, a lone "(y)" and a prompt that scrolled out of the last 10 lines don't count.
        assert!(!matched(b"\x1b[2J\x1b[H> fix the failing test\r\n  Generating...\r\n"));
        assert!(!matched(b"Option (y) was chosen\r\n"));
        let mut scrolled = b"Run (once) (y)\r\nSkip (esc or n)\r\n".to_vec();
        for i in 0..12 {
            scrolled.extend_from_slice(format!("line {i}\r\n").as_bytes());
        }
        assert!(!matched(&scrolled));
    }
}
