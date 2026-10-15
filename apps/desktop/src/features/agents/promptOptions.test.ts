import { describe, expect, it } from "vitest";
import { parsePromptOptions, screenPermissionKeys, shortAlwaysLabel } from "./promptOptions";

// Invented screens in the shape Claude Code draws its permission dialog.
const THREE_OPTIONS = [
  "● I'll run the tests.",
  "",
  "╭──────────────────────────────────────────────────────────────╮",
  "│ Bash command                                                 │",
  "│                                                              │",
  "│   npm test -- approval                                       │",
  "│   Run the approval tests                                     │",
  "│                                                              │",
  "│ Do you want to proceed?                                      │",
  "│ ❯ 1. Yes                                                     │",
  "│   2. Yes, and don't ask again for npm test commands in       │",
  "│      C:\\src\\orders-service                                   │",
  "│   3. No, and tell Claude what to do differently (esc)        │",
  "╰──────────────────────────────────────────────────────────────╯",
  "",
];

const YES_NO = [
  "────────────────────────────────────────────────",
  " Bash command",
  "",
  "   Remove-Item -Recurse dist",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes   ",
  "   2. No",
  "",
  " Esc to cancel",
];

describe("parsePromptOptions", () => {
  it("reads a three-option dialog with a wrapped label", () => {
    expect(parsePromptOptions(THREE_OPTIONS)).toEqual([
      { number: "1", label: "Yes" },
      { number: "2", label: "Yes, and don't ask again for npm test commands in C:\\src\\orders-service" },
      { number: "3", label: "No, and tell Claude what to do differently (esc)" },
    ]);
  });

  it("reads a Yes/No dialog without a box (footer is not part of a label)", () => {
    expect(parsePromptOptions(YES_NO)).toEqual([
      { number: "1", label: "Yes" },
      { number: "2", label: "No" },
    ]);
  });

  it("accepts > as the cursor", () => {
    expect(parsePromptOptions(["> 1. Yes", "  2. No"])).toHaveLength(2);
  });

  it("finds no dialog in plain output or a numbered list without a cursor", () => {
    expect(parsePromptOptions([])).toEqual([]);
    expect(parsePromptOptions(["● Done.", "", "1. Added the migration", "2. Updated the tests", "> "])).toEqual([]);
  });

  it("takes the last dialog on the screen", () => {
    const rows = [...THREE_OPTIONS, "● Ran tests", ...YES_NO];
    expect(parsePromptOptions(rows).map((o) => o.label)).toEqual(["Yes", "No"]);
  });
});

describe("screenPermissionKeys", () => {
  const claude = { allowOnce: "1", alwaysAllow: "2", deny: "Esc" };
  const codex = { allowOnce: "y", alwaysAllow: "p", deny: "Esc" };

  it("offers always with the screen's option and text", () => {
    const keys = screenPermissionKeys(claude, parsePromptOptions(THREE_OPTIONS), true);
    expect(keys).toEqual({
      allowOnce: "1",
      alwaysAllow: "2",
      alwaysLabel: "Yes, and don't ask again for npm test commands in C:\\src\\orders-service",
      deny: "Esc",
    });
  });

  it("drops always on a Yes/No dialog (2 = No)", () => {
    expect(screenPermissionKeys(claude, parsePromptOptions(YES_NO), true)).toEqual({ allowOnce: "1", deny: "Esc" });
  });

  it("strict agents drop always without a dialog; others keep their keys", () => {
    expect(screenPermissionKeys(claude, [], true)).toEqual({ allowOnce: "1", deny: "Esc" });
    expect(screenPermissionKeys(codex, [], false)).toEqual(codex);
  });

  it("keeps a letter key but takes the label when the dialog has a second yes", () => {
    const options = [
      { number: "1", label: "Yes, proceed (y)" },
      { number: "2", label: "Yes, and don't ask again for this command (p)" },
      { number: "3", label: "No (esc)" },
    ];
    expect(screenPermissionKeys(codex, options, false)?.alwaysAllow).toBe("p");
    expect(screenPermissionKeys(codex, options.filter((o) => o.number !== "2"), false)?.alwaysAllow).toBeUndefined();
  });

  it("uses the option's own number when it is not 2", () => {
    const options = [
      { number: "1", label: "Yes" },
      { number: "2", label: "No" },
      { number: "3", label: "Yes, allow all edits during this session (shift+tab)" },
    ];
    expect(screenPermissionKeys(claude, options, true)?.alwaysAllow).toBe("3");
  });

  it("passes null through", () => {
    expect(screenPermissionKeys(null, [], true)).toBeNull();
  });
});

describe("shortAlwaysLabel", () => {
  it("drops the yes prefix and key hints and shortens", () => {
    expect(shortAlwaysLabel("Yes, allow all edits during this session (shift+tab)")).toBe("Allow all edits during this session");
    const long = shortAlwaysLabel("Yes, and don't ask again for npm test commands in C:\\src\\orders-service");
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(44);
    expect(long.startsWith("Don't ask again")).toBe(true);
  });
});
