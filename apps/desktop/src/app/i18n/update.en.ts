/**
 * M5: About additions (license, links, licenses viewer) and app updates (check, prompt,
 * install). Part of `en` as `update`; `update.tr.ts` has the same shape.
 */
import { APP_NAME } from "../constants";

export const updateEn = {
  // About
  license: "Free and open source under the Apache License 2.0.",
  linksLabel: "Project links",
  repository: "Source code",
  issues: "Report an issue",
  discussions: "Discussions",
  notAffiliated: `${APP_NAME} is an independent open-source project. It works with Claude Code, Codex, GitHub Copilot CLI, Gemini CLI and other coding agents, and is not affiliated with or endorsed by their makers. Product names belong to their owners.`,
  licensesTitle: "Open-source licenses",
  licensesShow: "Show open-source licenses",
  licensesHide: "Hide open-source licenses",
  licensesSearch: "Search licenses",
  licensesSearchPlaceholder: "Filter by package or license…",
  licensesMatches: (n: number) => `${n} matching ${n === 1 ? "line" : "lines"}`,
  licensesLoading: "Loading licenses…",
  licensesError: "The license list could not be loaded.",

  // Check
  checkOnStart: "Check for updates on start",
  checkNow: "Check for updates",
  checking: "Checking for updates…",
  upToDate: (version: string) => `You're up to date (version ${version}).`,
  available: (version: string) => `Version ${version} is available.`,
  notConfigured: "Updates are not configured in this build.",
  checkFailed: (message: string) => `Couldn't check for updates: ${message}`,

  // Prompt
  promptLabel: "Update available",
  promptTitle: (version: string) => `${APP_NAME} ${version} is available`,
  promptCurrent: (current: string, date: string | null) => `You have ${current}${date ? ` · released ${date}` : ""}`,
  notesLabel: "What's new",
  install: "Install and restart",
  later: "Later",
  downloading: (percent: number | null) => (percent === null ? "Downloading…" : `Downloading… ${percent}%`),
  downloadedSize: (downloaded: string, total: string | null) => (total ? `${downloaded} of ${total}` : downloaded),
  progressLabel: "Download progress",
  ready: "Installing – the app restarts in a moment.",
  installFailed: (message: string) => `The update could not be installed: ${message}`,
  retry: "Try again",
  close: "Close",
};
