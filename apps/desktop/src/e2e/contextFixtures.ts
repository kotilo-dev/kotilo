/**
 * 0.9 agent context for the browser e2e mode: an in-memory stand-in for the Rust
 * `context_agents` / `context_report` / `context_read` commands with invented demo data –
 * Claude Code (project CLAUDE.md with imports, a user file, a nested on-demand file, rules, an
 * unreadable managed file, two skills, MCP servers with secret key names, one disabled, one
 * shadowed), Codex (an AGENTS.md past the 32 KiB limit), Gemini with nothing found and a user
 * adapter without context data. `window.__e2eContext` records the calls.
 */
import type { ContextAgent, ContextFile, ContextReadResult, ContextReport } from "../lib/ipc";

declare global {
  interface Window {
    __e2eContext: { reports: { workspaceId: string; agent: string }[]; reads: string[] };
  }
}
window.__e2eContext = { reports: [], reads: [] };

const HOME = "C:\\Users\\demo";
const ROOT = "C:\\src\\orders-service";

export const agents: ContextAgent[] = [
  { id: "claude-code", displayName: "Claude Code", supported: true },
  { id: "codex", displayName: "Codex CLI", supported: true },
  { id: "gemini", displayName: "Gemini CLI", supported: true },
  { id: "opencode", displayName: "OpenCode", supported: true },
  { id: "acme-agent", displayName: "Acme Agent", supported: false },
];

function file(partial: Partial<ContextFile> & Pick<ContextFile, "scope" | "path" | "display" | "bytes">): ContextFile {
  return {
    kind: "instruction",
    rel: null,
    tokens: Math.ceil(partial.bytes / 4),
    loaded: "always",
    importedBy: null,
    overLimit: false,
    error: null,
    ...partial,
  };
}

function totals(files: ContextFile[], skillTokens: number): ContextReport["totals"] {
  const always = files.filter((f) => f.loaded === "always" && !f.error);
  return {
    alwaysTokens: always.reduce((n, f) => n + f.tokens, 0),
    onDemandTokens: files.filter((f) => f.loaded === "onDemand").reduce((n, f) => n + f.tokens, 0),
    skillTokens,
    alwaysBytes: always.reduce((n, f) => n + f.bytes, 0),
  };
}

const claudeFiles: ContextFile[] = [
  file({ scope: "managed", path: "C:\\ProgramData\\ClaudeCode\\CLAUDE.md", display: "C:\\ProgramData\\ClaudeCode\\CLAUDE.md", bytes: 0, tokens: 0, error: "Access is denied. (os error 5)" }),
  file({ scope: "user", path: `${HOME}\\.claude\\CLAUDE.md`, display: "~/.claude/CLAUDE.md", bytes: 1_840 }),
  file({ scope: "project", path: `${ROOT}\\CLAUDE.md`, display: "CLAUDE.md", rel: "CLAUDE.md", bytes: 6_320 }),
  file({ scope: "project", path: `${ROOT}\\docs\\conventions.md`, display: "docs/conventions.md", rel: "docs/conventions.md", bytes: 3_960, importedBy: "CLAUDE.md" }),
  file({ scope: "user", path: `${HOME}\\.claude\\shared\\review.md`, display: "~/.claude/shared/review.md", bytes: 1_120, importedBy: "docs/conventions.md" }),
  file({ scope: "project", path: `${ROOT}\\CLAUDE.local.md`, display: "CLAUDE.local.md", rel: "CLAUDE.local.md", bytes: 410 }),
  file({ scope: "project", path: `${ROOT}\\src\\billing\\CLAUDE.md`, display: "src/billing/CLAUDE.md", rel: "src/billing/CLAUDE.md", bytes: 2_480, loaded: "onDemand" }),
  file({ kind: "rule", scope: "project", path: `${ROOT}\\.claude\\rules\\testing.md`, display: ".claude/rules/testing.md", rel: ".claude/rules/testing.md", bytes: 920 }),
  file({ kind: "rule", scope: "user", path: `${HOME}\\.claude\\rules\\git.md`, display: "~/.claude/rules/git.md", bytes: 540 }),
];

const claude: ContextReport = {
  agent: "claude-code",
  supported: true,
  root: ROOT,
  files: claudeFiles,
  skills: [
    {
      scope: "project",
      name: "release-notes",
      description: "Drafts release notes from the merged pull requests since the last tag.",
      path: `${ROOT}\\.claude\\skills\\release-notes\\SKILL.md`,
      display: ".claude/skills/release-notes/SKILL.md",
      rel: ".claude/skills/release-notes/SKILL.md",
      tokens: 24,
    },
    {
      scope: "user",
      name: "pdf-tools",
      description: "Fill, merge and split PDF files with the local toolchain.",
      path: `${HOME}\\.claude\\skills\\pdf-tools\\SKILL.md`,
      display: "~/.claude/skills/pdf-tools/SKILL.md",
      rel: null,
      tokens: 19,
    },
  ],
  mcp: [
    { name: "postgres", scope: "local", source: "~/.claude.json", transport: "stdio", command: "uvx", argCount: 3, url: null, secretKeys: ["env.DATABASE_URL"], disabled: true, shadowedBy: null },
    {
      name: "github",
      scope: "project",
      source: ".mcp.json",
      transport: "stdio",
      command: "docker",
      argCount: 6,
      url: null,
      secretKeys: ["env.GITHUB_PERSONAL_ACCESS_TOKEN"],
      disabled: false,
      shadowedBy: null,
    },
    { name: "sentry", scope: "project", source: ".mcp.json", transport: "http", command: null, argCount: 0, url: "https://mcp.sentry.dev", secretKeys: ["headers.Authorization"], disabled: false, shadowedBy: null },
    { name: "github", scope: "user", source: "~/.claude.json", transport: "stdio", command: "npx", argCount: 2, url: null, secretKeys: ["env.GITHUB_TOKEN", "env.GITHUB_HOST"], disabled: false, shadowedBy: ".mcp.json" },
    { name: "docs-search", scope: "user", source: "~/.claude.json", transport: "sse", command: null, argCount: 0, url: "http://localhost:7300", secretKeys: [], disabled: false, shadowedBy: null },
  ],
  sources: [
    { scope: "local", path: `${HOME}\\.claude.json`, display: "~/.claude.json", exists: true, error: null, serverCount: 1 },
    { scope: "project", path: `${ROOT}\\.mcp.json`, display: ".mcp.json", exists: true, error: null, serverCount: 2 },
    { scope: "user", path: `${HOME}\\.claude.json`, display: "~/.claude.json", exists: true, error: null, serverCount: 2 },
  ],
  maxBytes: null,
  totals: totals(claudeFiles, 43),
};

const codexFiles: ContextFile[] = [
  file({ scope: "user", path: `${HOME}\\.codex\\AGENTS.md`, display: "~/.codex/AGENTS.md", bytes: 2_150 }),
  file({ scope: "project", path: `${ROOT}\\AGENTS.md`, display: "AGENTS.md", rel: "AGENTS.md", bytes: 38_912, overLimit: true }),
];

const codex: ContextReport = {
  agent: "codex",
  supported: true,
  root: ROOT,
  files: codexFiles,
  skills: [
    {
      scope: "project",
      name: "db-migrate",
      description: "Writes and checks a database migration for the orders schema.",
      path: `${ROOT}\\.agents\\skills\\db-migrate\\SKILL.md`,
      display: ".agents/skills/db-migrate/SKILL.md",
      rel: ".agents/skills/db-migrate/SKILL.md",
      tokens: 18,
    },
  ],
  mcp: [
    { name: "context7", scope: "user", source: "~/.codex/config.toml", transport: "http", command: null, argCount: 0, url: "https://mcp.context7.com", secretKeys: ["http_headers.CONTEXT7_API_KEY"], disabled: false, shadowedBy: null },
  ],
  sources: [
    { scope: "user", path: `${HOME}\\.codex\\config.toml`, display: "~/.codex/config.toml", exists: true, error: null, serverCount: 1 },
    { scope: "project", path: `${ROOT}\\.codex\\config.toml`, display: ".codex/config.toml", exists: false, error: null, serverCount: 0 },
  ],
  maxBytes: 32_768,
  totals: totals(codexFiles, 18),
};

function emptyReport(agent: string, supported: boolean): ContextReport {
  return {
    agent,
    supported,
    root: ROOT,
    files: [],
    skills: [],
    mcp: [],
    sources: [],
    maxBytes: null,
    totals: { alwaysTokens: 0, onDemandTokens: 0, skillTokens: 0, alwaysBytes: 0 },
  };
}

export function report(workspaceId: string, agent: string): ContextReport {
  window.__e2eContext.reports.push({ workspaceId, agent });
  if (agent === "claude-code") return claude;
  if (agent === "codex") return codex;
  const known = agents.find((a) => a.id === agent);
  if (!known) throw { code: "invalid_argument", message: `unknown agent ${agent}` };
  return emptyReport(agent, known.supported);
}

const TEXT: Record<string, string> = {
  [`${HOME}\\.claude\\CLAUDE.md`]: [
    "# My defaults",
    "",
    "- Answer in short sentences; explain the *why* of a change.",
    "- Prefer small commits with an imperative summary line.",
    "- Never run `git push --force` without asking.",
    "",
    "## Tools",
    "",
    "```sh",
    "pnpm test --filter changed",
    "```",
    "",
  ].join("\n"),
  [`${HOME}\\.claude\\shared\\review.md`]: ["# Review checklist", "", "1. Tests cover the change.", "2. No secrets in the diff.", "3. Docs updated.", ""].join("\n"),
  [`${HOME}\\.claude\\skills\\pdf-tools\\SKILL.md`]: ["---", "name: pdf-tools", "description: Fill, merge and split PDF files with the local toolchain.", "---", "", "# PDF tools", ""].join("\n"),
};

export function read(path: string): ContextReadResult {
  window.__e2eContext.reads.push(path);
  const text = TEXT[path];
  if (text === undefined) throw { code: "invalid_argument", message: "path is not in the report" };
  return { text, truncated: path.endsWith("review.md") };
}

const contextDemo = new URLSearchParams(window.location.search).get("context") === "demo";

const WORKSPACE_TEXT: Record<string, string> = {
  "CLAUDE.md": ["# orders-service", "", "Order API and background jobs.", "", "@docs/conventions.md", "", "Run `pnpm test` before you finish.", ""].join("\n"),
};

/** `fs_read_text` for the demo's workspace files (`context=demo`); `undefined` for other paths. */
export function readText(rel: string): unknown {
  if (!contextDemo) return undefined;
  const text = WORKSPACE_TEXT[rel];
  if (text === undefined) return undefined;
  return { text, encoding: "utf8", eol: "lf", mixedEol: false, hash: "e2e", mtimeMs: 0, size: text.length, readOnly: false, readOnlyReason: null };
}
