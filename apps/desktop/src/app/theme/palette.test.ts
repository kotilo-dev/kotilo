/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ansiVar, PALETTES, type ThemePalette } from "./palette";

// Vitest runs from apps/desktop.
const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

/** Custom properties declared in the first block that starts with `selector`. */
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("\n}", start));
  const vars = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars.set(match[1]!, match[2]!.trim());
  return vars;
}

function expectMirrors(vars: Map<string, string>, palette: ThemePalette) {
  expect(vars.get("--bg")).toBe(palette.bg);
  expect(vars.get("--surface-2")).toBe(palette.surface2);
  expect(vars.get("--terminal-bg")).toBe(palette.terminalBg);
  expect(vars.get("--text")).toBe(palette.text);
  expect(vars.get("--accent")).toBe(palette.accent);
  expect(vars.get("--terminal-selection")).toBe(palette.terminalSelection);
  expect(vars.get("--terminal-selection-inactive")).toBe(palette.terminalSelectionInactive);
  for (const key of Object.keys(palette.ansi) as Array<keyof ThemePalette["ansi"]>) {
    expect(vars.get(ansiVar(key)), ansiVar(key)).toBe(palette.ansi[key]);
  }
}

describe("palette.ts mirrors index.css", () => {
  it("dark (:root)", () => expectMirrors(block(":root"), PALETTES.dark));
  it("light ([data-theme=light])", () => expectMirrors(block(':root[data-theme="light"]'), PALETTES.light));

  it("DESIGN_SYSTEM §8 dark ANSI palette", () => {
    expect(PALETTES.dark.ansi).toMatchObject({ red: "#ff6b5a", green: "#46c58a", blue: "#7c9cff", brightWhite: "#e7e9ee" });
  });
});
