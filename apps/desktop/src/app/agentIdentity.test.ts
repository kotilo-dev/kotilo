import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtinDefinitions } from "../test/builtinDefinitions";
import { resetDefinitionsStoreForTests, useDefinitionsStore } from "../stores/definitionsStore";
import { agentIdentity } from "./agentIdentity";
import { agentDisplayName, agentLabel } from "./ui/agents";

const css = readFileSync(join(__dirname, "..", "index.css"), "utf8");
const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf(":root[data-theme"));

function token(name: string): string | undefined {
  return new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`).exec(rootBlock)?.[1]?.toLowerCase();
}

describe("agent identity from adapter definitions", () => {
  afterEach(() => resetDefinitionsStoreForTests());

  it("keeps every built-in avatar token equal to its adapter.json (DESIGN_SYSTEM §2.4)", () => {
    const defs = builtinDefinitions();
    expect(defs).toHaveLength(8);
    for (const def of defs) {
      const id = agentIdentity(def.id, defs);
      expect(id.key, def.id).not.toBe("other");
      expect(id.letter).toBe(def.avatar!.letter);
      expect(token(`agent-${id.key}-bg`), def.id).toBe(def.avatar!.bg.toLowerCase());
      expect(token(`agent-${id.key}-ink`), def.id).toBe(def.avatar!.ink.toLowerCase());
      // Built-ins render through tokens, never raw hex.
      expect(id.bg).toBe(`var(--agent-${id.key}-bg)`);
    }
  });

  it("uses a user adapter's own colours and letter", () => {
    const user = { ...builtinDefinitions()[0]!, id: "my-agent", displayName: "My Agent", avatar: { letter: "M", bg: "#1c262e", ink: "#86c8f0" }, source: "user" as const };
    expect(agentIdentity("my-agent", [user])).toEqual({ key: "other", letter: "M", bg: "#1c262e", ink: "#86c8f0" });
    expect(agentIdentity("unknown", [user])).toMatchObject({ key: "other", letter: "?", bg: "var(--agent-other-bg)" });
  });

  it("names agents from their definitions, with built-in fallbacks", () => {
    expect(agentDisplayName("copilot", [])).toBe("GitHub Copilot CLI");
    expect(agentDisplayName("my-agent", [])).toBe("my-agent");
    useDefinitionsStore.setState({ definitions: [{ ...builtinDefinitions()[0]!, id: "my-agent", displayName: "My Agent", source: "user" }] });
    expect(agentDisplayName("my-agent")).toBe("My Agent");
    expect(agentLabel({ kind: "custom", adapterId: "my-agent" })).toBe("My Agent");
    expect(agentLabel({ kind: "codex", adapterId: null })).toBe("Codex");
  });

  it("maps pane kinds to the adapter's identity", () => {
    const defs = builtinDefinitions();
    expect(agentIdentity("claude", defs)).toMatchObject({ key: "claude", letter: "C" });
    expect(agentIdentity("copilot", defs).letter).toBe("P");
  });
});
