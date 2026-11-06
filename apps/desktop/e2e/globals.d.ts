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
  }
}
