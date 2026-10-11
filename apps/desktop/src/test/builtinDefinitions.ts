/**
 * Tests only: the repo's built-in `adapters/<id>/adapter.json` files in the shape
 * `agents_definitions` returns (Rust fills the defaults), so UI tests run on the real data.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterDefinition } from "../lib/ipc";

// apps/desktop/src/test → repo root
export const ADAPTERS_DIR = join(__dirname, "..", "..", "..", "..", "adapters");

export function builtinDefinitions(): AdapterDefinition[] {
  const out: AdapterDefinition[] = [];
  for (const folder of readdirSync(ADAPTERS_DIR).sort()) {
    const file = join(ADAPTERS_DIR, folder, "adapter.json");
    if (!existsSync(file)) continue;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<AdapterDefinition> & { $schema?: string };
    delete raw.$schema;
    out.push({
      ...raw,
      v: 1,
      id: raw.id ?? folder,
      displayName: raw.displayName ?? folder,
      avatar: raw.avatar ?? null,
      detect: { executables: raw.detect?.executables ?? [], nodeScripts: raw.detect?.nodeScripts ?? [] },
      launch: raw.launch ? { command: raw.launch.command, args: raw.launch.args ?? [] } : null,
      gracefulClose: raw.gracefulClose ?? [],
      permissionKeys: raw.permissionKeys ?? null,
      screenRules: raw.screenRules ?? [],
      source: "builtIn",
    });
  }
  return out;
}
