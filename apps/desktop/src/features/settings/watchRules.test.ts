import { describe, expect, it } from "vitest";
import { dictionary } from "../../app/i18n";
import { checkRule, cleanRule, formatList, newRuleId, parseList, validateWatchRules, watchHitName, watchOf } from "./watchRules";

const w = dictionary("en").watch;

describe("watch rule helpers", () => {
  it("requires a name and at least one match field", () => {
    expect(checkRule({ name: " ", command: "x" }, w.settings).name).toBe(w.settings.nameRequired);
    expect(checkRule({ name: "a", tools: [], command: "  ", paths: [] }, w.settings).match).toBe(w.settings.needsMatch);
    expect(checkRule({ name: "a", paths: ["**/.env"] }, w.settings)).toEqual({});
    expect(checkRule({ name: "x".repeat(61), tools: ["Read"] }, w.settings).name).toBe(w.settings.nameTooLong);
  });

  it("hints (does not block) when the regex does not compile in JavaScript", () => {
    const issues = checkRule({ name: "a", command: "(unclosed" }, w.settings);
    expect(issues.regex).toBe(w.settings.regexSuspect);
    expect(validateWatchRules([{ id: "user.a", name: "a", enabled: true, notify: true, command: "(unclosed" }], w.settings)).toEqual({});
  });

  it("reports blocking problems per rule index", () => {
    const errors = validateWatchRules(
      [
        { id: "user.a", name: "", enabled: true, notify: true, command: "x" },
        { id: "user.b", name: "b", enabled: true, notify: true },
      ],
      w.settings,
    );
    expect(Object.keys(errors)).toEqual(["watch.rules.0", "watch.rules.1"]);
  });

  it("parses lists, builds unique ids and drops empty fields", () => {
    expect(parseList(" Read, Bash,,\n Write ")).toEqual(["Read", "Bash", "Write"]);
    expect(formatList(["a", "b"])).toBe("a, b");
    expect(newRuleId("Prod Host!", [])).toBe("user.prod-host");
    expect(newRuleId("Prod Host!", ["user.prod-host"])).toBe("user.prod-host-2");
    expect(newRuleId("???", [])).toBe("user.rule");
    expect(cleanRule({ id: "user.a", name: " A ", enabled: true, notify: true, tools: [], command: " ", paths: ["x"] })).toEqual({
      id: "user.a",
      name: "A",
      enabled: true,
      notify: true,
      paths: ["x"],
    });
  });

  it("uses defaults for a hub without watch settings", () => {
    expect(watchOf({})).toEqual({ enabled: true, disabledBuiltins: [], notifyOffBuiltins: [], rules: [], trustedProjects: [] });
  });

  it("translates built-in names in both languages and falls back to the hub name", () => {
    expect(watchHitName({ id: "builtin.db-drop", name: "x" }, w)).toBe("Database drop");
    expect(watchHitName({ id: "builtin.db-drop", name: "x" }, dictionary("tr").watch)).toBe("Veritabanı silme");
    expect(watchHitName({ id: "builtin.other", name: "Other" }, w)).toBe("Other");
    expect(watchHitName({ id: "user.db-drop", name: "Mine" }, w)).toBe("Mine");
  });
});
