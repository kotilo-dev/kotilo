import { beforeEach, describe, expect, it } from "vitest";
import type { Command } from "../../app/commands";
import {
  baseNameMatchIndices,
  filterCommands,
  modeForInput,
  queryForInput,
  recordCommandUsed,
  resetMruForTest,
} from "./quickPickLogic";

function cmd(partial: Partial<Command> & Pick<Command, "id" | "title">): Command {
  return { run: () => {}, ...partial };
}

describe("modeForInput / queryForInput", () => {
  it("is 'file' mode for plain text", () => {
    expect(modeForInput("readme")).toBe("file");
    expect(queryForInput("readme")).toBe("readme");
  });

  it("switches to 'command' mode when the input starts with '>'", () => {
    expect(modeForInput(">tog")).toBe("command");
    expect(queryForInput(">tog")).toBe("tog");
  });

  it("switches back to 'file' mode once the leading '>' is removed", () => {
    expect(modeForInput("")).toBe("file");
    expect(modeForInput(">")).toBe("command");
    expect(queryForInput(">")).toBe("");
  });
});

describe("filterCommands", () => {
  beforeEach(() => resetMruForTest());

  const commands: Command[] = [
    cmd({ id: "view.toggleTheme", title: "Toggle theme", category: "View" }),
    cmd({ id: "settings.open", title: "Open settings" }),
    cmd({ id: "terminal.new", title: "New terminal" }),
    cmd({ id: "agents.installHooks", title: "Install Claude Code integration", category: "Agents", enabled: () => false }),
  ];

  it("hides commands whose enabled() returns false", () => {
    const result = filterCommands(commands, "");
    expect(result.some((r) => r.command.id === "agents.installHooks")).toBe(false);
  });

  it("empty query: sorts alphabetically by 'Category: Title' when there's no MRU", () => {
    const result = filterCommands(commands, "");
    // Labels: "New terminal", "Open settings", "View: Toggle theme" -> N < O < V.
    expect(result.map((r) => r.command.id)).toEqual(["terminal.new", "settings.open", "view.toggleTheme"]);
    expect(result.every((r) => r.indices === null)).toBe(true);
  });

  it("empty query: puts recently used commands first, in MRU order", () => {
    recordCommandUsed("terminal.new");
    recordCommandUsed("view.toggleTheme");
    const result = filterCommands(commands, "");
    // En son kullanılan başta: view.toggleTheme, sonra terminal.new, sonra kalanlar alfabetik.
    expect(result.map((r) => r.command.id)).toEqual(["view.toggleTheme", "terminal.new", "settings.open"]);
  });

  it("non-empty query: only matching commands, scored/sorted, with highlight indices", () => {
    const result = filterCommands(commands, "vtog");
    expect(result.map((r) => r.command.id)).toEqual(["view.toggleTheme"]);
    expect(result[0]!.indices).not.toBeNull();
  });

  it("non-empty query: no matches -> empty list", () => {
    expect(filterCommands(commands, "zzzzz")).toEqual([]);
  });
});

describe("baseNameMatchIndices (review #7)", () => {
  it("offsets indices that fall within the basename to be relative to the basename", () => {
    const rel = "src/foo/bar.ts";
    const base = "bar.ts";
    // "bar.ts" starts at rel-index 8 ("src/foo/" is 8 chars).
    expect(baseNameMatchIndices(rel, base, [8, 9, 10])).toEqual([0, 1, 2]);
  });

  it("drops indices that fall in the directory part, keeping only basename-relative ones", () => {
    const rel = "src/foo/bar.ts";
    const base = "bar.ts";
    expect(baseNameMatchIndices(rel, base, [0, 1, 8])).toEqual([0]);
  });

  it("returns null when every index falls in the directory part", () => {
    const rel = "src/foo/bar.ts";
    const base = "bar.ts";
    expect(baseNameMatchIndices(rel, base, [0, 1, 2])).toBeNull();
  });

  it("returns null for null or empty indices", () => {
    expect(baseNameMatchIndices("a/b.ts", "b.ts", null)).toBeNull();
    expect(baseNameMatchIndices("a/b.ts", "b.ts", [])).toBeNull();
  });

  it("returns unchanged indices when rel has no directory (base === rel)", () => {
    expect(baseNameMatchIndices("readme.md", "readme.md", [0, 3])).toEqual([0, 3]);
  });

  it("is Unicode-codepoint aware, not UTF-16-length aware (astral characters like emoji)", () => {
    // "😀" is one code point but two UTF-16 code units — a `.length`-based offset would be
    // off by one and misalign every highlight after it.
    const rel = "😀dir/file.ts";
    const base = "file.ts";
    expect(Array.from(rel).length).toBe(12); // 😀,d,i,r,/,f,i,l,e,.,t,s
    // index 5 (code points) is "f", the first char of the basename.
    expect(baseNameMatchIndices(rel, base, [5, 6])).toEqual([0, 1]);
  });
});
