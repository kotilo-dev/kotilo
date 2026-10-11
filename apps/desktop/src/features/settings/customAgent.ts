/**
 * "Add custom agent" wizard logic (M3 wave 3): the form ↔ `adapter.json` v1 mapping, the
 * checks the desktop loader and the hub run (so the user sees them before saving) and the
 * Agent Integration Protocol snippets. Pure.
 */
import { HOOK_COMMAND } from "../../app/constants";
import type { ScreenRuleState, UserAdapterDefinition } from "../../lib/ipc";

/** Same pattern as `schema/adapter.v1.json` (`id`, screen rule ids). */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Avatar colours for custom agents. The schema stores hex, so these are the token values:
 * inks from the status / ANSI tokens (`--status-*-ink`, `--ansi-bright-*`, `--text-2`), tiles
 * = the ink at 14 % over `--bg`, the recipe of the `--status-*-bg` tokens.
 */
export const AVATAR_PALETTE = [
  { key: "blue", bg: "#1b2031", ink: "#7c9cff" },
  { key: "sky", bg: "#1f2631", ink: "#9cc8ff" },
  { key: "cyan", bg: "#1c262e", ink: "#86c8f0" },
  { key: "green", bg: "#1d2a26", ink: "#8fe0b6" },
  { key: "amber", bg: "#2c261c", ink: "#f6c86b" },
  { key: "red", bg: "#2d2021", ink: "#ff9d90" },
  { key: "violet", bg: "#27202e", ink: "#d29bf0" },
  { key: "grey", bg: "#26272b", ink: "#c9ccd4" },
] as const;

export type PaletteKey = (typeof AVATAR_PALETTE)[number]["key"];

export const SCREEN_STATES: readonly ScreenRuleState[] = ["waitingPermission", "waitingInput", "working", "done"];

export interface RuleForm {
  id: string;
  state: ScreenRuleState;
  pattern: string;
  /** Text field; empty = default (6). */
  lines: string;
  clearOn: "" | "output" | "input";
}

export interface CustomAgentForm {
  id: string;
  displayName: string;
  letter: string;
  bg: string;
  ink: string;
  command: string;
  /** Space separated, double quotes keep spaces. */
  args: string;
  /** Comma or space separated. */
  executables: string;
  allowOnce: string;
  alwaysAllow: string;
  deny: string;
  usage: "protocol" | "none";
  rules: RuleForm[];
}

export function emptyForm(): CustomAgentForm {
  const first = AVATAR_PALETTE[0];
  return {
    id: "",
    displayName: "",
    letter: "",
    bg: first.bg,
    ink: first.ink,
    command: "",
    args: "",
    executables: "",
    allowOnce: "",
    alwaysAllow: "",
    deny: "",
    usage: "protocol",
    rules: [],
  };
}

export function newRule(existing: readonly RuleForm[]): RuleForm {
  let n = existing.length + 1;
  const ids = new Set(existing.map((r) => r.id));
  while (ids.has(`rule-${n}`)) n++;
  return { id: `rule-${n}`, state: "waitingPermission", pattern: "", lines: "", clearOn: "" };
}

/** Splits an argument line on spaces; double quotes group, `\"` is a literal quote. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\" && line[i + 1] === '"') {
      current += '"';
      started = true;
      i++;
    } else if (c === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(c) && !quoted) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

export function joinArgs(args: readonly string[]): string {
  return args.map((a) => (a !== "" && !/[\s"]/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)).join(" ");
}

export function splitList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Suggested executable names for a launch command (`my-agent` → `my-agent.exe, my-agent.cmd, my-agent`). */
export function suggestExecutables(command: string): string {
  const name = command.trim().split(/[\\/]/).pop() ?? "";
  if (!name) return "";
  if (/\.(exe|cmd|bat)$/i.test(name)) return name;
  return `${name}.exe, ${name}.cmd, ${name}`;
}

export type PatternError = { kind: "unsupported" } | { kind: "invalid"; message: string };

/**
 * The hub's check (`AdapterDefinition.PatternError`): no lookaround or backreferences (the
 * desktop runs Rust's `regex`), and it must compile. Inline flag groups (`(?i)`), which Rust
 * has and JS does not, are removed before JS compiles it.
 */
export function patternError(pattern: string): PatternError | null {
  if (/\(\?<?[=!]|\\[1-9]|\\k</.test(pattern)) return { kind: "unsupported" };
  const forJs = pattern.replace(/\(\?[imsxU-]+\)/g, "").replace(/\(\?[imsxU-]+:/g, "(?:");
  try {
    new RegExp(forJs);
    return null;
  } catch (e) {
    return { kind: "invalid", message: e instanceof Error ? e.message : String(e) };
  }
}

export type FieldError =
  | { kind: "required" }
  | { kind: "idPattern" }
  | { kind: "idBuiltIn" }
  | { kind: "idTaken" }
  | { kind: "letter" }
  | { kind: "keyPair" }
  | { kind: "ruleIdDuplicate" }
  | { kind: "lines" }
  | PatternError;

/** Field paths: `id`, `displayName`, `letter`, `command`, `executables`, `keys`, `rules.<i>.id|pattern|lines`. */
export type FormErrors = Record<string, FieldError>;

export interface ValidationContext {
  builtinIds: readonly string[];
  /** Ids of existing user adapters (also invalid files). */
  userIds: readonly string[];
  /** The id being edited (may keep its own id). */
  editingId: string | null;
}

export function validateForm(form: CustomAgentForm, ctx: ValidationContext): FormErrors {
  const errors: FormErrors = {};
  const id = form.id.trim();
  if (!id) errors.id = { kind: "required" };
  else if (!ID_PATTERN.test(id)) errors.id = { kind: "idPattern" };
  else if (ctx.builtinIds.includes(id)) errors.id = { kind: "idBuiltIn" };
  else if (id !== ctx.editingId && ctx.userIds.includes(id)) errors.id = { kind: "idTaken" };

  if (!form.displayName.trim()) errors.displayName = { kind: "required" };
  if ([...form.letter.trim()].length !== 1) errors.letter = { kind: "letter" };
  if (!form.command.trim()) errors.command = { kind: "required" };
  if (splitList(form.executables).length === 0) errors.executables = { kind: "required" };

  const allow = form.allowOnce.trim();
  const deny = form.deny.trim();
  if ((allow === "") !== (deny === "") || (form.alwaysAllow.trim() && (!allow || !deny))) errors.keys = { kind: "keyPair" };

  const seen = new Set<string>();
  form.rules.forEach((rule, i) => {
    const rid = rule.id.trim();
    if (!rid) errors[`rules.${i}.id`] = { kind: "required" };
    else if (!ID_PATTERN.test(rid)) errors[`rules.${i}.id`] = { kind: "idPattern" };
    else if (seen.has(rid)) errors[`rules.${i}.id`] = { kind: "ruleIdDuplicate" };
    seen.add(rid);
    if (!rule.pattern) errors[`rules.${i}.pattern`] = { kind: "required" };
    else {
      const err = patternError(rule.pattern);
      if (err) errors[`rules.${i}.pattern`] = err;
    }
    if (rule.lines.trim()) {
      const n = Number(rule.lines.trim());
      if (!Number.isInteger(n) || n < 1 || n > 50) errors[`rules.${i}.lines`] = { kind: "lines" };
    }
  });
  return errors;
}

export const WIZARD_STEPS = ["basics", "launch", "keys", "rules", "finish"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** Which error fields block leaving a step. */
export function errorsForStep(errors: FormErrors, step: WizardStep): string[] {
  const fields = Object.keys(errors);
  switch (step) {
    case "basics":
      return fields.filter((f) => f === "id" || f === "displayName" || f === "letter");
    case "launch":
      return fields.filter((f) => f === "command" || f === "executables");
    case "keys":
      return fields.filter((f) => f === "keys");
    case "rules":
      return fields.filter((f) => f.startsWith("rules."));
    case "finish":
      return fields;
  }
}

/**
 * The file content. Fields the wizard does not edit (`gracefulClose`, `detect.nodeScripts`,
 * `hooks`) are kept from `base` when editing.
 */
export function toDefinition(form: CustomAgentForm, base?: UserAdapterDefinition | null): UserAdapterDefinition {
  const allow = form.allowOnce.trim();
  const deny = form.deny.trim();
  const always = form.alwaysAllow.trim();
  const def: UserAdapterDefinition = {
    v: 1,
    id: form.id.trim(),
    displayName: form.displayName.trim(),
    avatar: { letter: form.letter.trim(), bg: form.bg, ink: form.ink },
    detect: { executables: splitList(form.executables), nodeScripts: base?.detect.nodeScripts ?? [] },
    launch: { command: form.command.trim(), args: splitArgs(form.args) },
    gracefulClose: base?.gracefulClose ?? [],
    permissionKeys: allow && deny ? { allowOnce: allow, ...(always ? { alwaysAllow: always } : {}), deny } : null,
    usage: form.usage,
    screenRules: form.rules.map((r) => ({
      id: r.id.trim(),
      state: r.state,
      pattern: r.pattern,
      ...(r.lines.trim() ? { lines: Number(r.lines.trim()) } : {}),
      ...(r.clearOn ? { clearOn: r.clearOn } : {}),
    })),
  };
  if (base?.hooks) def.hooks = base.hooks;
  return def;
}

export function fromDefinition(def: UserAdapterDefinition): CustomAgentForm {
  const first = AVATAR_PALETTE[0];
  return {
    id: def.id,
    displayName: def.displayName,
    letter: def.avatar?.letter ?? "",
    bg: def.avatar?.bg ?? first.bg,
    ink: def.avatar?.ink ?? first.ink,
    command: def.launch?.command ?? "",
    args: joinArgs(def.launch?.args ?? []),
    executables: def.detect.executables.join(", "),
    allowOnce: def.permissionKeys?.allowOnce ?? "",
    alwaysAllow: def.permissionKeys?.alwaysAllow ?? "",
    deny: def.permissionKeys?.deny ?? "",
    usage: def.usage === "none" ? "none" : "protocol",
    rules: def.screenRules.map((r) => ({
      id: r.id,
      state: r.state,
      pattern: r.pattern,
      lines: r.lines !== undefined ? String(r.lines) : "",
      clearOn: r.clearOn ?? "",
    })),
  };
}

/** Sidecar calls the agent (or its wrapper) makes; `docs/agent-protocol.md` §2. */
export function sidecarSnippet(id: string): string {
  const agent = id || "<id>";
  return [
    `${HOOK_COMMAND} --agent ${agent} --event session-start --session s-1 --json "{\\"cwd\\":\\"C:\\\\src\\\\demo\\"}"`,
    `${HOOK_COMMAND} --agent ${agent} --event working --session s-1`,
    `${HOOK_COMMAND} --agent ${agent} --event waiting-permission --session s-1 --json "{\\"tool\\":\\"shell\\",\\"command\\":\\"git push\\"}"`,
    `${HOOK_COMMAND} --agent ${agent} --event done --session s-1`,
  ].join("\n");
}

/** The same `working` event posted to the hub directly. */
export function httpSnippet(id: string): string {
  const agent = id || "<id>";
  return [
    "POST http://127.0.0.1:<port>/v1/events",
    "X-AgentHub-Token: <token>",
    "Content-Type: application/json",
    "",
    JSON.stringify({ v: 1, agent, event: "working", payload: { sessionId: "s-1" } }),
  ].join("\n");
}

/** One-line example for a protocol adapter's settings card. */
export function protocolExample(id: string): string {
  return `${HOOK_COMMAND} --agent ${id} --event working`;
}
