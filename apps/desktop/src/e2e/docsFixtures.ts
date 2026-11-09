/**
 * 0.7 docs check for the browser e2e mode (`docs=demo`): an in-memory stand-in for the Rust
 * `docs_check` / `docs_mark_reviewed` commands with invented demo data, plus a small file tree
 * (AGENTS.md, README.md, docs/…) so the tree badges show. `docs=empty` reports no doc with links.
 * Without the param `docs_check` reports nothing to show. `window.__e2eDocs` records the calls.
 */
import type { DocDoc, DocsReport, GitHeadContent } from "../lib/ipc";

declare global {
  interface Window {
    __e2eDocs: { checks: number; reviewed: string[]; showHead: { path: string; rev: string | null }[] };
  }
}
window.__e2eDocs = { checks: 0, reviewed: [], showHead: [] };

const params = new URLSearchParams(window.location.search);
const scenario = params.get("docs");
export const docsDemo = scenario === "demo";

const HEAD = "b41e9c07d2a35f6812c4e9a07b3d5f1e2a6c8d90";
const REVIEWED = "3f2c1ab9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3";
const LAST_TOUCH = "7d0e4b2a91c35f8e6d1b0a2c4e6f8a1b3c5d7e9f";

let docs: DocDoc[] = [
  {
    path: "AGENTS.md",
    agentFile: true,
    links: [
      { target: "src/orders/service.ts", source: "inline", line: 9, exists: true },
      { target: "src/legacy/queue.ts", source: "inline", line: 14, exists: false },
      { target: "scripts/old-build.ps1", source: "link", line: 22, exists: false },
    ],
    missing: [
      { target: "src/legacy/queue.ts", source: "inline", line: 14, exists: false },
      { target: "scripts/old-build.ps1", source: "link", line: 22, exists: false },
    ],
    stale: null,
  },
  {
    path: "docs/api.md",
    agentFile: false,
    links: [
      { target: "src/api/**", source: "config", line: 0, exists: true },
      { target: "schema/orders.json", source: "config", line: 0, exists: false },
    ],
    missing: [{ target: "schema/orders.json", source: "config", line: 0, exists: false }],
    stale: {
      baseline: REVIEWED,
      baselineKind: "reviewed",
      reviewedMissing: false,
      commits: [
        { id: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b", subject: "Add order cancel route", date: "2026-11-06T14:12:00+01:00" },
        { id: "1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c", subject: "Rename OrderStatus.Pending to Open", date: "2026-11-04T09:40:00+01:00" },
        { id: "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f", subject: "Paginate the order list", date: "2026-11-02T17:05:00+01:00" },
      ],
      commitCount: 3,
      files: [
        { path: "src/api/orders.ts", commits: 2 },
        { path: "src/api/routes.ts", commits: 1 },
      ],
    },
  },
  {
    path: "docs/setup.md",
    agentFile: false,
    links: [{ target: "scripts/dev.ps1", source: "link", line: 5, exists: true }],
    missing: [],
    stale: {
      baseline: LAST_TOUCH,
      baselineKind: "lastTouch",
      reviewedMissing: true,
      commits: [{ id: "c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9", subject: "Switch dev script to pnpm", date: "2026-11-05T11:20:00+01:00" }],
      commitCount: 1,
      files: [{ path: "scripts/dev.ps1", commits: 1 }],
    },
  },
  {
    path: "README.md",
    agentFile: false,
    links: [{ target: "docs/setup.md", source: "link", line: 7, exists: true }],
    missing: [],
    stale: null,
  },
];

export function check(): DocsReport {
  window.__e2eDocs.checks += 1;
  const list = scenario === "demo" ? docs : [];
  return {
    root: "C:\\src\\orders-service",
    gitAvailable: true,
    head: HEAD,
    configPath: scenario === "demo" ? ".kotilo/docs.toml" : null,
    configError: null,
    docs: list,
    truncated: false,
    summary: {
      docs: scenario === "demo" ? 6 : 2,
      stale: list.filter((d) => d.stale).length,
      missing: list.reduce((n, d) => n + d.missing.length, 0),
    },
  };
}

export function markReviewed(path: string): { commit: string } {
  window.__e2eDocs.reviewed.push(path);
  docs = docs.map((d) => (d.path === path ? { ...d, stale: null } : d));
  return { commit: HEAD };
}

/** Root and `docs/` of the demo tree; `undefined` for other folders (the caller's default applies). */
export function readDir(rel: string): unknown {
  if (!docsDemo) return undefined;
  if (rel === "") {
    return [
      { name: "docs", rel: "docs", isDir: true },
      { name: "src", rel: "src", isDir: true },
      { name: "AGENTS.md", rel: "AGENTS.md", isDir: false },
      { name: "README.md", rel: "README.md", isDir: false },
    ];
  }
  if (rel === "docs") {
    return [
      { name: "api.md", rel: "docs/api.md", isDir: false },
      { name: "setup.md", rel: "docs/setup.md", isDir: false },
    ];
  }
  return undefined;
}

const ORDERS_BASE = ["export const orderRoutes = [", '  { method: "GET", path: "/orders" },', '  { method: "POST", path: "/orders" },', "];", ""].join("\n");
const ORDERS_NOW = [
  "export const orderRoutes = [",
  '  { method: "GET", path: "/orders", paginated: true },',
  '  { method: "POST", path: "/orders" },',
  '  { method: "POST", path: "/orders/:id/cancel" },',
  "];",
  "",
].join("\n");

/** `git_show_head` for the demo's changed source file; `null` for other paths. */
export function showHead(path: string, rev: string | null): GitHeadContent | null {
  if (!docsDemo || path !== "src/api/orders.ts") return null;
  window.__e2eDocs.showHead.push({ path, rev });
  return { content: ORDERS_BASE, binary: false, tooLarge: false };
}

const TEXT: Record<string, string> = {
  "src/api/orders.ts": ORDERS_NOW,
  "AGENTS.md": [
    "# Agent notes",
    "",
    "Work in small steps and run the tests before you finish.",
    "",
    "## Layout",
    "",
    "- Order rules live in one service.",
    "",
    "The service is `src/orders/service.ts`.",
    "",
    "## Queue",
    "",
    "Background jobs go through the queue in",
    "`src/legacy/queue.ts`.",
    "",
    "## Build",
    "",
    "Build with the script below.",
    "",
    "",
    "",
    "Run [the build](scripts/old-build.ps1) before a release.",
    "",
  ].join("\n"),
};

/** `fs_read_text` for the demo docs; `undefined` for other paths. */
export function readText(rel: string): unknown {
  if (!docsDemo) return undefined;
  const text = TEXT[rel] ?? (rel.endsWith(".md") || rel.endsWith(".toml") ? `# ${rel}\n` : undefined);
  if (text === undefined) return undefined;
  return { text, encoding: "utf8", eol: "lf", mixedEol: false, hash: "e2e", mtimeMs: 0, size: text.length, readOnly: false, readOnlyReason: null };
}
