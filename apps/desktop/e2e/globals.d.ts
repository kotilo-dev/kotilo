// Test hooks the mocked IPC (src/e2e/setup.ts) puts on `window`; shared by every spec.
export {};

declare global {
  interface Window {
    __e2e: { pushHubSnapshot: () => Promise<void>; emit: (type: string, data: unknown) => Promise<void> };
    __e2ePtyWrites: string[];
  }
}
