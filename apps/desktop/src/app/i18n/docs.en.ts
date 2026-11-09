/**
 * 0.7 docs check (D-074): the Docs tab, tree badges, entry points and the setting. Part of `en`
 * as `docs`; `docs.tr.ts` has the same shape.
 */
import type { DocLinkSource } from "../../lib/ipc";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const docsEn = {
  tabTitle: "Docs",
  title: "Docs check",
  /** Palette: "Docs: Check". */
  commandCategory: "Docs",
  commandTitle: "Check",
  contextMenu: "Check docs",
  summary: (scanned: number, missing: number, stale: number) =>
    `${plural(scanned, "doc", "docs")} scanned · ${missing} with missing paths · ${stale} stale`,
  checking: "Checking…",
  checkAgain: "Check again",
  loadFailed: "The docs check failed.",
  filter: {
    label: "Show",
    all: (n: number) => `All ${n}`,
    missing: (n: number) => `Missing ${n}`,
    stale: (n: number) => `Stale ${n}`,
  },
  noGit: "Git is not available here, so only missing paths are checked.",
  truncated: "Only the first 2000 docs were checked.",
  configError: (line: number, message: string) => `.kotilo/docs.toml line ${line}: ${message}. The check used the Markdown links only.`,
  allGood: (n: number) => `All ${plural(n, "doc", "docs")} with links match the code.`,
  noneMissing: "No doc names a missing path.",
  noneStale: "No doc is stale.",
  agentFile: "Agent file",
  missingCount: (n: number) => plural(n, "missing path", "missing paths"),
  staleSince: (id: string) => `stale since ${id}`,
  staleCommits: (n: number) => `stale · ${plural(n, "commit", "commits")}`,
  expand: (path: string) => `Details for ${path}`,
  missingTitle: "Missing paths",
  whyStale: "Why stale",
  staleReason: (count: number, id: string, reviewed: boolean) =>
    `${plural(count, "commit", "commits")} changed covered code since ${id} (${reviewed ? "last review" : "last change of the doc"}).`,
  reviewedMissing: "The reviewed commit no longer exists (rebased away?), so the doc's last change is used.",
  moreCommits: (n: number) => `… and ${plural(n, "more commit", "more commits")}`,
  changedFiles: "Changed files",
  fileCommits: (n: number) => plural(n, "commit", "commits"),
  openAt: (path: string, line: number) => `Open ${path} at line ${line}`,
  openConfig: "Open .kotilo/docs.toml",
  inConfig: "docs.toml, matches nothing",
  showDiff: (path: string, id: string) => `Show changes in ${path} since ${id}`,
  source: {
    link: "link",
    codeBlock: "code block",
    inline: "inline code",
    config: "docs.toml",
    frontMatter: "front matter",
  } satisfies Record<DocLinkSource, string>,
  actions: {
    openDoc: "Open doc",
    markReviewed: "Mark reviewed",
    updateWithAgent: "Update with agent…",
    noAgent: "Start an agent in this workspace first.",
    noCommit: "Needs a git repository with a commit.",
  },
  confirm: {
    title: (path: string) => `Mark ${path} as reviewed?`,
    body: (id: string) =>
      `This writes the current commit ${id} for this doc into .kotilo/docs.toml (created if missing). Commit the file to share the review with your team and CI.`,
    confirm: "Mark reviewed",
  },
  markedToast: (path: string) => `Marked ${path} as reviewed`,
  sentTo: (label: string) => `Prompt is in ${label}'s composer – check it and send.`,
  empty: {
    title: "No doc links to code yet",
    body: "Docs are checked for paths they name: Markdown links, file= code blocks and paths in inline code. To say which code a doc covers, add .kotilo/docs.toml to the repository:",
    copy: "Copy example",
    copied: "Example copied",
  },
  badge: {
    missing: "Doc names missing paths",
    stale: "Doc is stale",
  },
  settings: {
    treeBadges: "Show docs check badges in the file tree",
    treeBadgesHint: "Red: the doc names paths that no longer exist. Amber: code the doc covers changed since its last review.",
  },
};
