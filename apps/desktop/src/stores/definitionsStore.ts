/**
 * M3 wave 3: the adapter definitions (`adapter.json`, built-in + user) as the desktop loaded
 * them — the UI's one source for agent names, avatars, permission keys and launch commands.
 * Loaded once at startup (`agents_definitions`) and replaced on reload or after the wizard
 * saves/deletes a user adapter. `installed` (ids whose executable is on PATH) feeds the
 * launch menu; `null` until the first check answered.
 */
import { create } from "zustand";
import {
  agentsDefinitions,
  agentsDefinitionsReload,
  agentsInstalled,
  type AdapterDefinition,
  type AdapterDefinitionError,
  type AdapterDefinitions,
} from "../lib/ipc";

interface DefinitionsStore {
  loaded: boolean;
  definitions: AdapterDefinition[];
  errors: AdapterDefinitionError[];
  installed: string[] | null;

  init: () => Promise<void>;
  /** Re-reads every adapter.json in the desktop app (the hub reloads separately). */
  reload: () => Promise<void>;
  /** Applies a view returned by a save/delete/reload command and refreshes `installed`. */
  apply: (view: AdapterDefinitions) => void;
}

let initStarted = false;

async function refreshInstalled(set: (p: Partial<DefinitionsStore>) => void): Promise<void> {
  try {
    set({ installed: await agentsInstalled() });
  } catch {
    // Without the check the launch menu falls back to the user's own commands.
    set({ installed: [] });
  }
}

export const useDefinitionsStore = create<DefinitionsStore>((set, get) => ({
  loaded: false,
  definitions: [],
  errors: [],
  installed: null,

  init: async () => {
    if (initStarted) return;
    initStarted = true;
    try {
      get().apply(await agentsDefinitions());
    } catch {
      set({ loaded: true });
    }
  },

  reload: async () => {
    get().apply(await agentsDefinitionsReload());
  },

  apply: (view) => {
    set({ loaded: true, definitions: view?.definitions ?? [], errors: view?.errors ?? [] });
    void refreshInstalled(set);
  },
}));

/** The loaded definition for an adapter id (also outside React). */
export function definitionFor(adapterId: string | null | undefined): AdapterDefinition | undefined {
  if (!adapterId) return undefined;
  return useDefinitionsStore.getState().definitions.find((d) => d.id === adapterId);
}

/** Test hook: forget that `init` ran. */
export function resetDefinitionsStoreForTests(): void {
  initStarted = false;
  useDefinitionsStore.setState({ loaded: false, definitions: [], errors: [], installed: null });
}
