import { describe, expect, it } from "vitest";
import {
  AVATAR_PALETTE,
  emptyForm,
  errorsForStep,
  fromDefinition,
  httpSnippet,
  joinArgs,
  newRule,
  patternError,
  sidecarSnippet,
  splitArgs,
  splitList,
  suggestExecutables,
  toDefinition,
  validateForm,
  type CustomAgentForm,
} from "./customAgent";

const ctx = { builtinIds: ["claude-code", "codex"], userIds: ["mine"], editingId: null };

function valid(patch: Partial<CustomAgentForm> = {}): CustomAgentForm {
  return {
    ...emptyForm(),
    id: "my-agent",
    displayName: "My Agent",
    letter: "M",
    command: "my-agent",
    executables: "my-agent.exe, my-agent",
    ...patch,
  };
}

describe("customAgent form", () => {
  it("accepts a complete form and maps it to adapter.json v1", () => {
    const form = valid({
      args: '--mode tui "--title=My Agent"',
      allowOnce: "y",
      deny: "Esc",
      rules: [{ id: "approve", state: "waitingPermission", pattern: "Allow\\? \\(y/n\\)", lines: "3", clearOn: "input" }],
    });
    expect(validateForm(form, ctx)).toEqual({});
    const def = toDefinition(form);
    expect(def).toEqual({
      v: 1,
      id: "my-agent",
      displayName: "My Agent",
      avatar: { letter: "M", bg: AVATAR_PALETTE[0].bg, ink: AVATAR_PALETTE[0].ink },
      detect: { executables: ["my-agent.exe", "my-agent"], nodeScripts: [] },
      launch: { command: "my-agent", args: ["--mode", "tui", "--title=My Agent"] },
      gracefulClose: [],
      permissionKeys: { allowOnce: "y", deny: "Esc" },
      usage: "protocol",
      screenRules: [{ id: "approve", state: "waitingPermission", pattern: "Allow\\? \\(y/n\\)", lines: 3, clearOn: "input" }],
    });
    // Round trip for editing.
    expect(toDefinition(fromDefinition(def), def)).toEqual(def);
  });

  it("keeps fields the wizard does not edit when editing", () => {
    const base = { ...toDefinition(valid()), gracefulClose: [{ keys: "Ctrl+C", repeat: 2 }], detect: { executables: ["x"], nodeScripts: ["pkg/x"] } };
    const def = toDefinition(fromDefinition(base), base);
    expect(def.gracefulClose).toEqual([{ keys: "Ctrl+C", repeat: 2 }]);
    expect(def.detect.nodeScripts).toEqual(["pkg/x"]);
  });

  it("validates the id like the schema and refuses built-in or taken ids", () => {
    expect(validateForm(valid({ id: "" }), ctx).id).toEqual({ kind: "required" });
    expect(validateForm(valid({ id: "My Agent" }), ctx).id).toEqual({ kind: "idPattern" });
    expect(validateForm(valid({ id: "-x" }), ctx).id).toEqual({ kind: "idPattern" });
    expect(validateForm(valid({ id: "codex" }), ctx).id).toEqual({ kind: "idBuiltIn" });
    expect(validateForm(valid({ id: "mine" }), ctx).id).toEqual({ kind: "idTaken" });
    expect(validateForm(valid({ id: "mine" }), { ...ctx, editingId: "mine" }).id).toBeUndefined();
  });

  it("requires a name, one letter, a command and an executable", () => {
    const errors = validateForm(valid({ displayName: " ", letter: "AB", command: "", executables: " , " }), ctx);
    expect(Object.keys(errors).sort()).toEqual(["command", "displayName", "executables", "letter"]);
    expect(errorsForStep(errors, "basics").sort()).toEqual(["displayName", "letter"]);
    expect(errorsForStep(errors, "launch").sort()).toEqual(["command", "executables"]);
    expect(errorsForStep(errors, "keys")).toEqual([]);
  });

  it("needs both allow and deny keys, or neither", () => {
    expect(validateForm(valid({ allowOnce: "y" }), ctx).keys).toEqual({ kind: "keyPair" });
    expect(validateForm(valid({ deny: "n" }), ctx).keys).toEqual({ kind: "keyPair" });
    expect(validateForm(valid({ alwaysAllow: "a" }), ctx).keys).toEqual({ kind: "keyPair" });
    expect(validateForm(valid({ allowOnce: "y", deny: "n" }), ctx).keys).toBeUndefined();
    expect(toDefinition(valid()).permissionKeys).toBeNull();
    expect(toDefinition(valid({ allowOnce: "1", alwaysAllow: "2", deny: "Esc" })).permissionKeys).toEqual({ allowOnce: "1", alwaysAllow: "2", deny: "Esc" });
  });

  it("checks screen rules: ids, regex, lines", () => {
    const rules = [
      { ...newRule([]), pattern: "(?=x)" },
      { ...newRule([]), pattern: "(" },
      { id: "Bad", state: "working" as const, pattern: "ok", lines: "60", clearOn: "" as const },
      { id: "rule-1", state: "done" as const, pattern: "", lines: "", clearOn: "" as const },
    ];
    const errors = validateForm(valid({ rules }), ctx);
    expect(errors["rules.0.pattern"]).toEqual({ kind: "unsupported" });
    expect(errors["rules.1.pattern"]?.kind).toBe("invalid");
    expect(errors["rules.1.id"]).toEqual({ kind: "ruleIdDuplicate" });
    expect(errors["rules.2.id"]).toEqual({ kind: "idPattern" });
    expect(errors["rules.2.lines"]).toEqual({ kind: "lines" });
    expect(errors["rules.3.pattern"]).toEqual({ kind: "required" });
    expect(errors["rules.3.id"]).toEqual({ kind: "ruleIdDuplicate" });
    expect(errorsForStep(errors, "rules").length).toBe(Object.keys(errors).length);
  });

  it("rejects lookaround and backreferences like the hub, allows Rust inline flags", () => {
    for (const p of ["(?=a)", "(?!a)", "(?<=a)", "(?<!a)", "(a)\\1", "(?<n>a)\\k<n>"]) expect(patternError(p)).toEqual({ kind: "unsupported" });
    expect(patternError("(?i)allow\\?")).toBeNull();
    expect(patternError("(?i:yes|no)")).toBeNull();
    expect(patternError("\\(y\\)[\\s\\S]*\\((?:esc or )?n\\)|\\(y/n\\)")).toBeNull();
    expect(patternError("[")).toMatchObject({ kind: "invalid" });
  });

  it("numbers new rules without clashing", () => {
    expect(newRule([]).id).toBe("rule-1");
    expect(newRule([{ ...newRule([]), id: "rule-2" }]).id).toBe("rule-3");
  });
});

describe("customAgent helpers", () => {
  it("splits and joins argument lines", () => {
    expect(splitArgs('a  "b c" d\\"e ""')).toEqual(["a", "b c", 'd"e', ""]);
    expect(splitArgs("")).toEqual([]);
    expect(joinArgs(["a", "b c", ""])).toBe('a "b c" ""');
    expect(splitArgs(joinArgs(["x", 'say "hi"']))).toEqual(["x", 'say "hi"']);
  });

  it("splits executable lists on commas and spaces", () => {
    expect(splitList(" a.exe, b ,c d ")).toEqual(["a.exe", "b", "c", "d"]);
  });

  it("suggests executable names from the command", () => {
    expect(suggestExecutables("my-agent")).toBe("my-agent.exe, my-agent.cmd, my-agent");
    expect(suggestExecutables("C:\\tools\\agent.exe")).toBe("agent.exe");
    expect(suggestExecutables("")).toBe("");
  });

  it("builds protocol snippets for the id", () => {
    expect(sidecarSnippet("my-agent")).toContain("kotilo-hook --agent my-agent --event working --session s-1");
    expect(sidecarSnippet("")).toContain("--agent <id>");
    const http = httpSnippet("my-agent");
    expect(http.split("\n")[0]).toBe("POST http://127.0.0.1:<port>/v1/events");
    expect(JSON.parse(http.split("\n").pop()!)).toEqual({ v: 1, agent: "my-agent", event: "working", payload: { sessionId: "s-1" } });
  });

  it("palette colours are #rrggbb (the schema's format)", () => {
    for (const p of AVATAR_PALETTE) {
      expect(p.bg).toMatch(/^#[0-9a-f]{6}$/);
      expect(p.ink).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("help link from Settings → Agents", () => {
  it("points at an existing heading in the English and Turkish user guide", async () => {
    const { tocFor } = await import("../help/helpIndex");
    const { en } = await import("../../app/i18n/en");
    const { tr } = await import("../../app/i18n/tr");
    expect(tocFor("user-guide.md", "en").map((h) => h.id)).toContain(en.agentSetup.protocolHelpAnchor);
    expect(tocFor("user-guide.md", "tr").map((h) => h.id)).toContain(tr.agentSetup.protocolHelpAnchor);
    expect(tocFor("user-guide.md", "en").map((h) => h.id)).toContain("supported-agents");
  });
});
