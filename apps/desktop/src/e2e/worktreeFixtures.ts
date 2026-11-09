/**
 * 0.6 worktrees for the browser e2e mode (`worktrees=demo`): an in-memory stand-in for the Rust
 * `worktree_*` commands with invented demo data. Without the param the list is supported and
 * empty; `worktrees=unsupported` reports a workspace below the repository root.
 * `window.__e2eWorktree` records the calls specs assert on.
 */
import type {
  GitChangedFile,
  GitHeadContent,
  WorktreeChanges,
  WorktreeInfo,
  WorktreeList,
  WorktreeMergeResult,
  WorktreeRemoveResult,
} from "../lib/ipc";

declare global {
  interface Window {
    __e2eWorktree: {
      created: string[];
      merges: { name: string; squash: boolean; message: string | null }[];
      removes: { name: string; force: boolean; deleteBranch: boolean; forceBranch: boolean }[];
      showHead: { path: string; rev: string | null }[];
      spawns: { cwdRel: string; agentCommand: string | null }[];
    };
  }
}
window.__e2eWorktree = { created: [], merges: [], removes: [], showHead: [], spawns: [] };

const params = new URLSearchParams(window.location.search);
const scenario = params.get("worktrees");
const BASE = "4f7d2a91c3e85b06d1a9f2c47e3b8d5a6c0f1e29";

function info(name: string, over: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    name,
    rel: `.kotilo/worktrees/${name}`,
    branch: `kotilo/${name}`,
    head: "9c1e5b7a2d4f6038e1b2c3d4e5f60718293a4b5c",
    base: "main",
    managed: true,
    locked: false,
    prunable: false,
    dirty: 0,
    ahead: 0,
    behind: 0,
    added: 0,
    removed: 0,
    ...over,
  };
}

let worktrees: WorktreeInfo[] =
  scenario === "demo"
    ? [
        info("api-docs", { ahead: 1, added: 18, removed: 2 }),
        info("fix-login", { dirty: 2, ahead: 3, behind: 1, added: 42, removed: 7 }),
        info("spike", { rel: ".claude/worktrees/spike", branch: "claude/spike", managed: false, ahead: 2, added: 9, removed: 0 }),
      ]
    : [];

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function list(): WorktreeList {
  if (scenario === "unsupported") return { supported: false, reason: "notRepoRoot", currentBranch: "main", mainDirty: false, worktrees: [] };
  return { supported: true, reason: null, currentBranch: "main", mainDirty: false, worktrees: [...worktrees].sort((a, b) => a.name.localeCompare(b.name)) };
}

export function create(name: string): WorktreeInfo {
  const slug = slugify(name);
  if (!slug) throw { code: "invalid_name", message: "invalid worktree name" };
  if (worktrees.some((w) => w.name === slug)) throw { code: "already_exists", message: `worktree '${slug}' already exists` };
  const created = info(slug, {});
  worktrees = [...worktrees, created];
  window.__e2eWorktree.created.push(slug);
  return created;
}

const CHANGED: Record<string, GitChangedFile[]> = {
  "fix-login": [
    { path: "src/auth/login.ts", status: "M", added: 30, removed: 7 },
    { path: "src/auth/session.ts", status: "M", added: 4, removed: 0 },
    { path: "src/auth/login.test.ts", status: "A", added: 8, removed: 0 },
  ],
  "api-docs": [{ path: "docs/api.md", status: "M", added: 18, removed: 2 }],
  spike: [{ path: "notes.md", status: "?", added: 9, removed: 0 }],
};

export function changes(name: string): WorktreeChanges {
  const wt = worktrees.find((w) => w.name === name);
  if (!wt) throw { code: "not_found", message: "no such worktree" };
  const files = (CHANGED[name] ?? []).map((f) => ({ ...f, path: `${wt.rel}/${f.path}` }));
  return { base: BASE, files, truncated: false };
}

export function merge(name: string, squash: boolean, message: string | null): WorktreeMergeResult {
  window.__e2eWorktree.merges.push({ name, squash, message });
  if (name === "fix-login") {
    return {
      status: "conflict",
      conflicts: ["src/auth/login.ts", "src/auth/session.ts"],
      detail: "CONFLICT (content): Merge conflict in src/auth/login.ts\nCONFLICT (content): Merge conflict in src/auth/session.ts\nAutomatic merge failed; fix conflicts and then commit the result.",
    };
  }
  worktrees = worktrees.map((w) => (w.name === name ? { ...w, ahead: 0, behind: 0 } : w));
  return { status: "merged", conflicts: [], detail: null };
}

export function remove(name: string, force: boolean, deleteBranch: boolean, forceBranch: boolean): WorktreeRemoveResult {
  window.__e2eWorktree.removes.push({ name, force, deleteBranch, forceBranch });
  const wt = worktrees.find((w) => w.name === name);
  if (!wt) return { status: "failed", branchDeleted: false, detail: "fatal: not a working tree" };
  if (wt.dirty > 0 && !force) return { status: "dirty", branchDeleted: false, detail: null };
  if (deleteBranch && wt.ahead > 0 && !forceBranch) return { status: "unmerged", branchDeleted: false, detail: null };
  worktrees = worktrees.filter((w) => w.name !== name);
  return { status: "removed", branchDeleted: deleteBranch, detail: null };
}

const BASE_TEXT: Record<string, string> = {
  "src/auth/login.ts": [
    "export async function login(user: string, password: string) {",
    "  const session = await createSession(user, password);",
    "  return session;",
    "}",
    "",
  ].join("\n"),
};
const WORK_TEXT: Record<string, string> = {
  "src/auth/login.ts": [
    "export async function login(user: string, password: string) {",
    "  if (!user.trim()) throw new LoginError(\"empty-user\");",
    "  const session = await createSession(user.trim(), password);",
    "  await session.refreshIfExpired();",
    "  return session;",
    "}",
    "",
  ].join("\n"),
};

function inWorktree(path: string): string | null {
  const m = path.match(/^\.kotilo\/worktrees\/[^/]+\/(.*)$/);
  return m ? m[1]! : null;
}

/** `git_show_head` for paths inside a worktree; `null` for any other path (the caller's default applies). */
export function showHead(path: string, rev: string | null): GitHeadContent | null {
  const inner = inWorktree(path);
  if (inner === null) return null;
  window.__e2eWorktree.showHead.push({ path, rev });
  return { content: BASE_TEXT[inner] ?? null, binary: false, tooLarge: false };
}

/** `fs_read_text` for worktree files; `undefined` for other paths. */
export function readText(rel: string): unknown {
  const inner = inWorktree(rel);
  if (inner === null) return undefined;
  const text = WORK_TEXT[inner] ?? `// ${inner}\n`;
  return { text, encoding: "utf8", eol: "lf", mixedEol: false, hash: "e2e", mtimeMs: 0, size: text.length, readOnly: false, readOnlyReason: null };
}
