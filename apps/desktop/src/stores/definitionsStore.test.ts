import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  agentsDefinitions: vi.fn(),
  agentsDefinitionsReload: vi.fn(),
  agentsInstalled: vi.fn(),
}));
vi.mock("../lib/ipc", () => ipc);

import { definitionFor, resetDefinitionsStoreForTests, useDefinitionsStore } from "./definitionsStore";
import { builtinDefinitions } from "../test/builtinDefinitions";

const view = { definitions: builtinDefinitions(), errors: [{ id: "bad", path: "C:/x/bad/adapter.json", source: "user" as const, message: "invalid JSON" }] };

describe("definitionsStore", () => {
  beforeEach(() => {
    resetDefinitionsStoreForTests();
    ipc.agentsDefinitions.mockReset().mockResolvedValue(view);
    ipc.agentsDefinitionsReload.mockReset().mockResolvedValue({ definitions: view.definitions.slice(0, 1), errors: [] });
    ipc.agentsInstalled.mockReset().mockResolvedValue(["claude-code"]);
  });
  afterEach(() => resetDefinitionsStoreForTests());

  it("loads once, then checks which agents are installed", async () => {
    await useDefinitionsStore.getState().init();
    await useDefinitionsStore.getState().init();
    expect(ipc.agentsDefinitions).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(useDefinitionsStore.getState().installed).toEqual(["claude-code"]));
    const st = useDefinitionsStore.getState();
    expect(st.loaded).toBe(true);
    expect(st.definitions.map((d) => d.id)).toContain("cursor");
    expect(st.errors[0]?.id).toBe("bad");
    expect(definitionFor("codex")?.displayName).toBe("Codex CLI");
    expect(definitionFor(null)).toBeUndefined();
  });

  it("reload replaces the definitions and rechecks PATH", async () => {
    await useDefinitionsStore.getState().init();
    await useDefinitionsStore.getState().reload();
    expect(useDefinitionsStore.getState().definitions).toHaveLength(1);
    expect(useDefinitionsStore.getState().errors).toEqual([]);
    await vi.waitFor(() => expect(ipc.agentsInstalled).toHaveBeenCalledTimes(2));
  });

  it("stays usable when the desktop commands fail", async () => {
    ipc.agentsDefinitions.mockRejectedValue(new Error("no"));
    await useDefinitionsStore.getState().init();
    expect(useDefinitionsStore.getState()).toMatchObject({ loaded: true, definitions: [] });
    ipc.agentsInstalled.mockRejectedValue(new Error("no"));
    useDefinitionsStore.getState().apply(view);
    await vi.waitFor(() => expect(useDefinitionsStore.getState().installed).toEqual([]));
  });
});
