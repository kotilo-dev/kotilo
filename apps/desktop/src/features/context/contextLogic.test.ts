import { describe, expect, it } from "vitest";
import type { ContextAgent, ContextFile, ContextReport } from "../../lib/ipc";
import { adapterForKind, contextSections, defaultContextAgent, formatBytes, formatTokenEstimate, isEmptyReport, pickerAgents } from "./contextLogic";

const agents: ContextAgent[] = [
  { id: "claude-code", displayName: "Claude Code", supported: true },
  { id: "codex", displayName: "Codex CLI", supported: true },
  { id: "acme", displayName: "Acme", supported: false },
];

function file(display: string, partial: Partial<ContextFile> = {}): ContextFile {
  return {
    kind: "instruction",
    scope: "project",
    path: `C:\\src\\app\\${display}`,
    display,
    rel: display,
    bytes: 400,
    tokens: 100,
    loaded: "always",
    importedBy: null,
    overLimit: false,
    error: null,
    ...partial,
  };
}

describe("adapterForKind", () => {
  it("maps pane kinds to adapter ids", () => {
    expect(adapterForKind("claude")).toBe("claude-code");
    expect(adapterForKind("codex")).toBe("codex");
    expect(adapterForKind("custom")).toBeNull();
    expect(adapterForKind("other")).toBeNull();
  });
});

describe("defaultContextAgent", () => {
  it("prefers a running agent with context data", () => {
    expect(defaultContextAgent(["acme", "codex"], agents)).toBe("codex");
  });
  it("falls back to Claude Code, then the first supported agent", () => {
    expect(defaultContextAgent([], agents)).toBe("claude-code");
    expect(defaultContextAgent(["acme"], agents)).toBe("claude-code");
    expect(defaultContextAgent([], [{ id: "gemini", displayName: "Gemini CLI", supported: true }])).toBe("gemini");
    expect(defaultContextAgent([], [])).toBe("claude-code");
  });
  it("takes the running agent as is before the list is loaded", () => {
    expect(defaultContextAgent(["codex"], null)).toBe("codex");
    expect(defaultContextAgent([], null)).toBe("claude-code");
  });
});

describe("pickerAgents", () => {
  it("lists supported agents and keeps an unsupported current one selectable", () => {
    expect(pickerAgents(agents, "codex").map((a) => a.id)).toEqual(["claude-code", "codex"]);
    expect(pickerAgents(agents, "acme").map((a) => a.id)).toEqual(["claude-code", "codex", "acme"]);
    expect(pickerAgents(agents, "ghost")[2]).toEqual({ id: "ghost", displayName: "ghost", supported: false });
  });
});

describe("contextSections", () => {
  it("splits files into always / on demand / rules and indents imports by depth", () => {
    const files = [
      file("~/.claude/CLAUDE.md", { scope: "user", rel: null }),
      file("CLAUDE.md"),
      file("docs/a.md", { importedBy: "CLAUDE.md" }),
      file("docs/b.md", { importedBy: "docs/a.md" }),
      file("src/x/CLAUDE.md", { loaded: "onDemand" }),
      file(".claude/rules/t.md", { kind: "rule" }),
      file("~/.claude/rules/g.md", { kind: "rule", loaded: "onDemand" }),
    ];
    const s = contextSections(files);
    expect(s.always.map((r) => [r.file.display, r.depth])).toEqual([
      ["~/.claude/CLAUDE.md", 0],
      ["CLAUDE.md", 0],
      ["docs/a.md", 1],
      ["docs/b.md", 2],
    ]);
    expect(s.onDemand.map((r) => r.file.display)).toEqual(["src/x/CLAUDE.md"]);
    expect(s.rules.map((r) => r.file.display)).toEqual([".claude/rules/t.md", "~/.claude/rules/g.md"]);
  });

  it("caps the depth and treats an unknown importer as depth 0", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const chain = names.map((n, i) => file(`${n}.md`, { importedBy: i === 0 ? "missing.md" : `${names[i - 1]}.md` }));
    expect(contextSections(chain).always.map((r) => r.depth)).toEqual([1, 2, 3, 4, 4, 4]);
  });
});

describe("isEmptyReport", () => {
  it("is true only without files, skills and MCP servers", () => {
    const base: ContextReport = {
      agent: "gemini",
      supported: true,
      root: "C:\\src\\app",
      files: [],
      skills: [],
      mcp: [],
      sources: [{ scope: "user", path: "x", display: "x", exists: false, error: null, serverCount: 0 }],
      maxBytes: null,
      totals: { alwaysTokens: 0, onDemandTokens: 0, skillTokens: 0, alwaysBytes: 0 },
    };
    expect(isEmptyReport(base)).toBe(true);
    expect(isEmptyReport({ ...base, files: [file("GEMINI.md")] })).toBe(false);
  });
});

describe("formats", () => {
  it("formats token estimates", () => {
    expect(formatTokenEstimate(0)).toBe("0");
    expect(formatTokenEstimate(830)).toBe("830");
    expect(formatTokenEstimate(4_210)).toBe("4.2k");
    expect(formatTokenEstimate(9_960)).toBe("10k");
    expect(formatTokenEstimate(12_400)).toBe("12k");
    expect(formatTokenEstimate(1_260_000)).toBe("1.3M");
  });
  it("formats byte sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(32_768)).toBe("32 KB");
    expect(formatBytes(38_912)).toBe("38 KB");
    expect(formatBytes(3_480)).toBe("3.4 KB");
    expect(formatBytes(1_258_291)).toBe("1.2 MB");
  });
});
