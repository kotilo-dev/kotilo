import { describe, expect, it } from "vitest";
import type { SavedPrompt } from "../../lib/ipc";
import { MAX_SAVED_PROMPTS } from "../composer/composerLogic";
import { appliesTo, commandLine, kindOf, quickCommandsFor, samePath, upsertQuickCommand } from "./quickCommandLogic";

const entry = (id: string, extra: Partial<SavedPrompt> = {}): SavedPrompt => ({ id, title: id, text: `${id} text`, ...extra });

describe("quick command logic", () => {
  it("treats entries without a kind as prompts (saved before D-069)", () => {
    expect(kindOf(entry("a"))).toBe("prompt");
    expect(kindOf(entry("b", { kind: "command" }))).toBe("command");
  });

  it("compares folders ignoring separators, case and a trailing slash", () => {
    expect(samePath("C:\\src\\App\\", "c:/src/app")).toBe(true);
    expect(samePath("C:\\src\\app", "C:\\src\\apps")).toBe(false);
  });

  it("offers global entries everywhere and project entries only in their folder", () => {
    expect(appliesTo(entry("g"), null)).toBe(true);
    expect(appliesTo(entry("g", { project: "  " }), "C:\\x")).toBe(true);
    expect(appliesTo(entry("p", { project: "C:\\src\\app" }), "C:\\src\\app")).toBe(true);
    expect(appliesTo(entry("p", { project: "C:\\src\\app" }), "C:\\src\\other")).toBe(false);
    expect(appliesTo(entry("p", { project: "C:\\src\\app" }), null)).toBe(false);
  });

  it("filters by workspace and kind, keeping list order", () => {
    const list = [
      entry("c1", { kind: "command" }),
      entry("p1"),
      entry("c2", { kind: "command", project: "C:\\other" }),
      entry("c3", { kind: "command", project: "C:\\app" }),
    ];
    expect(quickCommandsFor(list, "C:\\app", "command").map((e) => e.id)).toEqual(["c1", "c3"]);
    expect(quickCommandsFor(list, "C:\\app", "prompt").map((e) => e.id)).toEqual(["p1"]);
    expect(quickCommandsFor(list, "C:\\app").map((e) => e.id)).toEqual(["c1", "p1", "c3"]);
  });

  it("keeps a shell command on one line", () => {
    expect(commandLine("  npm test\r\n  -- --watch \n")).toBe("npm test -- --watch");
  });

  it("adds new entries to the front and edits existing ones in place", () => {
    const list = [entry("a"), entry("b")];
    const added = upsertQuickCommand(list, { id: "n", title: " ", text: "npm run\nlint", kind: "command", project: " C:\\app " });
    expect(added[0]).toEqual({ id: "n", title: "npm run lint", text: "npm run lint", kind: "command", project: "C:\\app" });
    const edited = upsertQuickCommand(added, { ...entry("b"), title: "Renamed", text: "  new text  " });
    expect(edited.map((e) => e.id)).toEqual(["n", "a", "b"]);
    expect(edited[2]).toMatchObject({ title: "Renamed", text: "new text", project: "" });
  });

  it("stays within the saved prompt limit", () => {
    const full = Array.from({ length: MAX_SAVED_PROMPTS }, (_, i) => entry(`e${i}`));
    const next = upsertQuickCommand(full, entry("new"));
    expect(next).toHaveLength(MAX_SAVED_PROMPTS);
    expect(next[0]!.id).toBe("new");
  });
});
