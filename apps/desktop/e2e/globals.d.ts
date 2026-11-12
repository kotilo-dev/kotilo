// Test hooks the mocked IPC (src/e2e/setup.ts) puts on `window`; shared by every spec.
export {};

declare global {
  interface Window {
    __e2e: {
      pushHubSnapshot: () => Promise<void>;
      emit: (type: string, data: unknown) => Promise<void>;
      /** D-072: a Kotilo Deck message (`approval.respond`, `pomodoro.state`). */
      deck: (type: string, payload: unknown) => Promise<void>;
    };
    __e2ePtyWrites: string[];
    __e2eLeftoverStops: string[];
    __e2eClipboard: string[];
    __e2eOpenedUrls: string[];
    __e2eCompanion: { agents: unknown[]; usage: unknown[]; sent: unknown[]; keys: { paneId: string; keys: string }[] };
    /** 0.6: worktree commands the mocked IPC saw (src/e2e/worktreeFixtures.ts). */
    __e2eWorktree: {
      created: string[];
      merges: { name: string; squash: boolean; message: string | null }[];
      removes: { name: string; force: boolean; deleteBranch: boolean; forceBranch: boolean }[];
      showHead: { path: string; rev: string | null }[];
      spawns: { cwdRel: string; agentCommand: string | null }[];
    };
    /** 0.7: docs commands the mocked IPC saw (src/e2e/docsFixtures.ts). */
    /** D-075: tray menus (item texts, "---" = separator) and tooltips in order. */
    __e2eTray: { menus: string[][]; tooltips: string[] };
    __e2eDocs: { checks: number; reviewed: string[]; showHead: { path: string; rev: string | null }[] };
  }
}
