import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinDefinitions } from "../../test/builtinDefinitions";
import { resetDefinitionsStoreForTests, useDefinitionsStore } from "../../stores/definitionsStore";
import { hasScreenPermissionRule, permissionKeysFor, permissionKeysOf } from "./permissionKeys";

describe("permissionKeys (from adapter definitions)", () => {
  beforeEach(() => useDefinitionsStore.setState({ loaded: true, definitions: builtinDefinitions() }));
  afterEach(() => resetDefinitionsStoreForTests());

  it("reads every built-in adapter's keys from its adapter.json", () => {
    expect(permissionKeysFor("claude-code")).toEqual({ allowOnce: "1", alwaysAllow: "2", deny: "Esc" });
    expect(permissionKeysFor("codex")).toEqual({ allowOnce: "y", alwaysAllow: "p", deny: "Esc" });
    expect(permissionKeysFor("cursor")).toEqual({ allowOnce: "y", deny: "n" });
    expect(permissionKeysFor("opencode")).toEqual({ allowOnce: "Enter", deny: "Esc" });
    for (const id of ["copilot", "gemini", "qwen"]) expect(permissionKeysFor(id)?.allowOnce).toBe("1");
  });

  it("returns null without a complete allow/deny pair (Droid, unknown ids)", () => {
    expect(permissionKeysFor("droid")).toBeNull();
    expect(permissionKeysFor("nope")).toBeNull();
    const base = builtinDefinitions()[0]!;
    expect(permissionKeysOf({ ...base, permissionKeys: { allowOnce: "y" } })).toBeNull();
    expect(permissionKeysOf(undefined)).toBeNull();
  });

  it("follows a reload (no mirrored table)", () => {
    const defs = builtinDefinitions().map((d) => (d.id === "droid" ? { ...d, permissionKeys: { allowOnce: "Enter", deny: "Esc" } } : d));
    useDefinitionsStore.setState({ definitions: defs });
    expect(permissionKeysFor("droid")).toEqual({ allowOnce: "Enter", deny: "Esc" });
  });

  it("knows which agents detect permission prompts on screen", () => {
    const defs = builtinDefinitions();
    expect(defs.filter(hasScreenPermissionRule).map((d) => d.id)).toEqual(["cursor"]);
  });
});
