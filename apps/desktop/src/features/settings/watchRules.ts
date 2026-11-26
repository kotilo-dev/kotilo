/**
 * Pure helpers for the watch-rule editor (Settings → Notifications): defaults for a hub that
 * has no `watch` settings yet, list parsing, ids and the UI-side checks. The hub validates
 * again and stays authoritative (its regex engine differs from JavaScript's).
 */
import type { Strings } from "../../app/i18n";
import type { WatchHit, WatchRule, WatchSettings } from "../../lib/hubTypes";

export const DEFAULT_WATCH: WatchSettings = {
  enabled: true,
  disabledBuiltins: [],
  notifyOffBuiltins: [],
  rules: [],
  trustedProjects: [],
};

export const MAX_RULE_NAME = 60;

export function watchOf(settings: { watch?: WatchSettings }): WatchSettings {
  return { ...DEFAULT_WATCH, ...settings.watch };
}

/** Comma / newline separated list → trimmed non-empty items. */
export function parseList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

export function formatList(items: readonly string[] | undefined): string {
  return (items ?? []).join(", ");
}

/** `user.<slug>` not yet used by `taken`. */
export function newRuleId(name: string, taken: readonly string[]): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "rule";
  let id = `user.${slug}`;
  for (let n = 2; taken.includes(id); n++) id = `user.${slug}-${n}`;
  return id;
}

export function regexCompiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export interface RuleIssues {
  name?: string;
  match?: string;
  /** A hint only: JavaScript could not compile the pattern (the hub decides). */
  regex?: string;
}

export function checkRule(rule: Pick<WatchRule, "name" | "tools" | "command" | "paths">, w: Strings["watch"]["settings"]): RuleIssues {
  const issues: RuleIssues = {};
  const name = rule.name.trim();
  if (name === "") issues.name = w.nameRequired;
  else if (name.length > MAX_RULE_NAME) issues.name = w.nameTooLong;
  const command = rule.command?.trim() ?? "";
  if ((rule.tools?.length ?? 0) === 0 && command === "" && (rule.paths?.length ?? 0) === 0) issues.match = w.needsMatch;
  if (command !== "" && !regexCompiles(command)) issues.regex = w.regexSuspect;
  return issues;
}

/** Drops empty match fields so the hub sees only what the user filled in. */
export function cleanRule(rule: WatchRule): WatchRule {
  const { tools, command, paths, ...rest } = rule;
  const out: WatchRule = { ...rest, name: rule.name.trim() };
  if (tools && tools.length > 0) out.tools = tools;
  if (command && command.trim() !== "") out.command = command.trim();
  if (paths && paths.length > 0) out.paths = paths;
  return out;
}

/** Blocking errors (name, match fields) per user rule, keyed `watch.rules.<index>`; regex hints don't block. */
export function validateWatchRules(rules: readonly WatchRule[], w: Strings["watch"]["settings"]): Record<string, string> {
  const errors: Record<string, string> = {};
  rules.forEach((r, i) => {
    const issues = checkRule(r, w);
    const why = issues.name ?? issues.match;
    if (why) errors[`watch.rules.${i}`] = w.ruleInvalid(r.name.trim() || String(i + 1), why);
  });
  return errors;
}

/** Display name of a hit: the translated built-in name when we have one, else what the hub sent. */
export function watchHitName(hit: WatchHit, w: Strings["watch"]): string {
  if (hit.id.startsWith("builtin.")) {
    const suffix = hit.id.slice("builtin.".length);
    const known = (w.builtin as Record<string, string | undefined>)[suffix];
    if (known) return known;
  }
  return hit.name;
}
