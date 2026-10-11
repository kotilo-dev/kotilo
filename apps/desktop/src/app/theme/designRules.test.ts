/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Vitest runs from apps/desktop. Guards for DESIGN_SYSTEM §2–§3 in component sources.
const SRC = resolve(process.cwd(), "src");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "index.css") out.push(path);
  }
  return out;
}

function offenders(pattern: RegExp): string[] {
  return sources(SRC)
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(SRC, path));
}

describe("design rules", () => {
  it("no arbitrary font size below 11px", () => {
    expect(offenders(/text-\[(?:[0-9]|10)(?:\.\d+)?px\]/)).toEqual([]);
  });

  it("no legacy AgentDeck --color-* variables outside index.css", () => {
    expect(offenders(/var\(--color-/)).toEqual([]);
  });

  it("modal backdrops use the --scrim token", () => {
    expect(offenders(/rgba\(0,\s*0,\s*0,\s*0\.(?:35|5)\)/)).toEqual([]);
  });
});
