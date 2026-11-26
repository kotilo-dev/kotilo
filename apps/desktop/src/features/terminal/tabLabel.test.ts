import { describe, expect, it } from "vitest";
import { dedupeTabLabels, tabLabelFor } from "./tabLabel";

const shells = ["PowerShell", "Command Prompt"];
const tab = (title: string, titleEdited = false, agentCommand: string | null = null) => ({ title, titleEdited, agentCommand });

describe("tabLabelFor", () => {
  it("shows the agent name while the title is still the shell default", () => {
    expect(tabLabelFor(tab("PowerShell"), "claude-code", "Claude Code", shells)).toEqual({
      text: "C Claude Code",
      name: "Claude Code",
      agent: "claude-code",
    });
  });
  it("treats the launch command as a default title too", () => {
    expect(tabLabelFor(tab("claude", false, "claude"), "claude-code", "Claude Code", shells).name).toBe("Claude Code");
  });
  it("shows the live OSC title of an agent tab", () => {
    const l = tabLabelFor(tab("fix login bug"), "claude-code", "Claude Code", shells);
    expect(l.text).toBe("C fix login bug");
    expect(l.agent).toBe("claude-code");
  });
  it("keeps the shell name for plain terminals", () => {
    expect(tabLabelFor(tab("PowerShell"), null, "", shells).text).toBe("PowerShell");
  });
  it("lets a user-edited title win", () => {
    const l = tabLabelFor(tab("build", true), "codex", "Codex CLI", shells);
    expect(l.text).toBe("build");
    expect(l.agent).toBeNull();
  });
});

describe("dedupeTabLabels", () => {
  it("numbers identical agent labels in tab order and leaves shells alone", () => {
    const a = tabLabelFor(tab("PowerShell"), "claude-code", "Claude Code", shells);
    const sh = tabLabelFor(tab("PowerShell"), null, "", shells);
    const out = dedupeTabLabels([a, sh, a, sh, a]);
    expect(out.map((l) => l.text)).toEqual(["C Claude Code", "PowerShell", "C Claude Code 2", "PowerShell", "C Claude Code 3"]);
    expect(out[2]!.name).toBe("Claude Code 2");
  });
});
