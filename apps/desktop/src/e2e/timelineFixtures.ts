/**
 * e2e fake data for the M4 timeline rail: the activity of the working Claude session
 * (`demo-claude-1`, pane `pane-claude`), `git_changes`, and HEAD / working copies for the diff tab.
 */
import type { ActivityDto } from "../lib/hubTypes";
import type { GitChanges, GitHeadContent } from "../lib/ipc";

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

export function activityFor(path: string): ActivityDto | null {
  if (!path.endsWith("/activity")) return null;
  if (!path.includes("/demo-claude-1/")) return { entries: [], plan: null };
  return {
    entries: [
      { id: 101, kind: "turn", at: iso(4) },
      { id: 102, kind: "read", tool: "Read", target: "src/approval/approval.ts", startedAt: iso(3.9), durationMs: 38, status: "ok" },
      { id: 103, kind: "read", tool: "Read", target: "src/approval/approval.test.ts", startedAt: iso(3.8), durationMs: 21, status: "ok" },
      { id: 104, kind: "search", tool: "Grep", target: "ProviderStatus.Cancelled", startedAt: iso(3.6), durationMs: 140, status: "ok" },
      { id: 105, kind: "bash", tool: "Bash", target: "npm test -- approval", startedAt: iso(3.2), durationMs: 9_400, status: "failed" },
      { id: 106, kind: "edit", tool: "Edit", target: "src/approval/approval.ts", startedAt: iso(1.5), durationMs: 64, status: "ok" },
      { id: 107, kind: "write", tool: "Write", target: "src/approval/cancelled.test.ts", startedAt: iso(1.1), durationMs: 51, status: "ok" },
      { id: 108, kind: "bash", tool: "Bash", target: "npm test -- approval", startedAt: iso(0.4), status: "running" },
    ],
    plan: {
      items: [
        { text: "Reproduce the failing approval test", status: "completed" },
        { text: "Map provider CANCELLED to Rejected", status: "completed" },
        { text: "Add regression test for cancelled orders", status: "completed" },
        { text: "Run the full approval suite", status: "in_progress" },
        { text: "Update CHANGELOG", status: "pending" },
      ],
    },
  };
}

export const gitChanges: GitChanges = {
  repo: true,
  head: "3f9c2d1e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d",
  truncated: false,
  files: [
    { path: "README.md", status: "M", added: 3, removed: 1 },
    { path: "package-lock.json", status: "M", added: 41, removed: 38 },
    { path: "src/approval/approval.ts", status: "M", added: 12, removed: 3 },
    { path: "src/approval/cancelled.test.ts", status: "?", added: 28, removed: 0 },
    { path: "src/legacy/provider.ts", status: "D", added: 0, removed: 54 },
  ],
};

const HEAD: Record<string, string> = {
  "src/approval/approval.ts": [
    "import { ApprovalState, GibStatus } from './types';",
    "",
    "export function mapGibStatus(status: GibStatus): ApprovalState {",
    "  switch (status) {",
    "    case GibStatus.Onay:",
    "      return ApprovalState.Approved;",
    "    case GibStatus.Red:",
    "      return ApprovalState.Rejected;",
    "    default:",
    "      return ApprovalState.Pending;",
    "  }",
    "}",
    "",
  ].join("\n"),
};

const WORKING: Record<string, string> = {
  "src/approval/approval.ts": [
    "import { ApprovalState, GibStatus } from './types';",
    "",
    "/** Maps the provider answer to our approval state; CANCELLED counts as rejected. */",
    "export function mapGibStatus(status: GibStatus): ApprovalState {",
    "  switch (status) {",
    "    case GibStatus.Onay:",
    "      return ApprovalState.Approved;",
    "    case GibStatus.Red:",
    "    case ProviderStatus.Cancelled:",
    "      return ApprovalState.Rejected;",
    "    case GibStatus.Beklemede:",
    "      return ApprovalState.Pending;",
    "    default:",
    "      throw new Error(`Unknown provider status: ${status}`);",
    "  }",
    "}",
    "",
  ].join("\n"),
};

export function showHead(path: string): GitHeadContent {
  return { content: HEAD[path] ?? null, binary: false, tooLarge: false };
}

/** `fs_read_text` for the diff's working copy; `null` (the old default answer) for anything else. */
export function readText(rel: string): unknown {
  const text = WORKING[rel];
  if (text === undefined) return null;
  return { text, encoding: "utf8", eol: "lf", mixedEol: false, hash: "e2e", mtimeMs: 0, size: text.length, readOnly: false, readOnlyReason: null };
}
