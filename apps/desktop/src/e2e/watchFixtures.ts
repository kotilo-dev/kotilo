/**
 * e2e fake data for watch rules (`?watch=1` adds the hits): `GET /v1/watch`, `POST /v1/watch/test`,
 * and `watch` on the waiting Codex permission and on one Claude activity entry.
 */
import type { ActivityDto, SessionDto, WatchHit, WatchOverview, WatchSettings, WatchTestRequest, WatchTestResult } from "../lib/hubTypes";

export const forcePush: WatchHit = { id: "builtin.force-push", name: "Force push" };
export const secretFile: WatchHit = { id: "builtin.secret-file", name: "Secret file" };

export const watchSettings: WatchSettings = {
  enabled: true,
  disabledBuiltins: ["builtin.wide-delete"],
  notifyOffBuiltins: ["builtin.git-discard"],
  rules: [
    { id: "user.prod-host", name: "Production host", enabled: true, notify: true, tools: ["Bash", "WebFetch"], command: "https?://[a-z.]*prod\\.example\\.com" },
    { id: "user.terraform-state", name: "Terraform state", enabled: true, notify: false, paths: ["**/*.tfstate", "**/*.tfstate.backup"] },
  ],
  trustedProjects: ["C:\\src\\orders-service"],
};

export const overview: WatchOverview = {
  builtins: [
    { id: "builtin.secret-file", name: "Secret file", enabled: true, notify: true },
    { id: "builtin.force-push", name: "Force push", enabled: true, notify: true },
    { id: "builtin.git-discard", name: "Irreversible git command", enabled: true, notify: false },
    { id: "builtin.wide-delete", name: "Wide delete", enabled: false, notify: true },
    { id: "builtin.db-drop", name: "Database drop", enabled: true, notify: true },
    { id: "builtin.pipe-to-shell", name: "Download and run", enabled: true, notify: true },
  ],
  user: watchSettings.rules,
  projects: [
    { root: "C:\\src\\orders-service", trusted: true, ruleCount: 3, problems: [] },
    { root: "C:\\src\\gateway", trusted: false, ruleCount: 1, problems: [{ line: 7, message: "Invalid regular expression in rule \"deploy\"." }] },
  ],
  problems: [],
};

export function testResult(body: WatchTestRequest | undefined): WatchTestResult {
  const command = body?.command ?? "";
  const matches: WatchHit[] = [];
  if (/push.*(--force\b|-f\b)/.test(command)) matches.push(forcePush);
  if (/\.env\b/.test(body?.path ?? command)) matches.push(secretFile);
  return { matches };
}

export function withWatchSessions(sessions: SessionDto[], on: boolean): SessionDto[] {
  if (!on) return sessions;
  return sessions.map((s) =>
    s.pendingPermission && s.agent === "codex"
      ? { ...s, pendingPermission: { ...s.pendingPermission, command: "git push --force origin main", risk: "gitPush" as const, watch: forcePush } }
      : s,
  );
}

export function withWatchActivity(dto: ActivityDto | null, on: boolean): ActivityDto | null {
  if (!on || !dto) return dto;
  return {
    ...dto,
    entries: dto.entries.map((e) => (e.id === 105 ? { ...e, target: "git push --force origin main", watch: forcePush } : e.id === 103 ? { ...e, watch: secretFile, target: ".env" } : e)),
  };
}
