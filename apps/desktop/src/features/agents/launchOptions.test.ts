import { describe, expect, it } from "vitest";
import { builtinDefinitions } from "../../test/builtinDefinitions";
import { commandLine, launchOptions } from "./launchOptions";

describe("launchOptions", () => {
  const defs = builtinDefinitions();

  it("offers installed definitions first, then custom commands no definition covers", () => {
    const options = launchOptions(defs, ["codex", "claude-code"], ["claude", "aider --model x", "  ", "aider --model x"]);
    expect(options).toEqual([
      { command: "claude", label: "Claude Code", adapterId: "claude-code" },
      { command: "codex", label: "Codex CLI", adapterId: "codex" },
      { command: "aider --model x", label: "aider --model x", adapterId: null },
    ]);
  });

  it("names a custom command after its agent even when the agent is not on PATH", () => {
    expect(launchOptions(defs, [], ["gemini"])).toEqual([{ command: "gemini", label: "Gemini CLI", adapterId: "gemini" }]);
  });

  it("falls back to the custom commands while the installed check has not answered", () => {
    expect(launchOptions(defs, null, ["claude", "codex"]).map((o) => o.label)).toEqual(["Claude Code", "Codex CLI"]);
    expect(launchOptions(defs, null, [])).toEqual([]);
  });

  it("joins launch args into one shell line, quoting where needed", () => {
    expect(commandLine({ command: "my-agent", args: ["--tui", "two words", 'q"x'] })).toBe('my-agent --tui "two words" "q\\"x"');
    expect(commandLine({ command: "x" })).toBe("x");
  });
});
