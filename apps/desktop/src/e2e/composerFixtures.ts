/**
 * M4 composer e2e data: `@` file suggestions and a record of what was written to the PTYs
 * (`window.__e2ePtyWrites`, read by `e2e/composer.spec.ts`). Only invented demo data.
 */
import type { QuickOpenResult } from "../lib/ipc";

const FILES = [
  "src/approval/approval.ts",
  "src/approval/approval.test.ts",
  "src/approval/statusMapping.ts",
  "src/orders/orderService.ts",
  "docs/approval-flow.md",
];

export function quickOpen(query: string): QuickOpenResult {
  const q = query.toLowerCase();
  const items = FILES.filter((rel) => rel.toLowerCase().includes(q)).map((rel, i) => ({ rel, score: 100 - i, indices: [] }));
  return { items, truncated: false };
}

declare global {
  interface Window {
    __e2ePtyWrites: string[];
  }
}

export const ptyWrites: string[] = [];
window.__e2ePtyWrites = ptyWrites;
