/**
 * Answers sent to agent permission prompts (D-016 keys), by the permission card or by Kotilo
 * Deck (D-072). Both go through `answerPermission`, so a deck decision uses exactly the card's
 * path and the card shows its result. In memory only; old entries are pruned.
 */
import { create } from "zustand";
import { paneSendKeys } from "../lib/ipc";

export type AnswerDecision = "allow" | "always" | "deny";
export type AnswerSource = "desktop" | "deck";

export interface PermissionAnswer {
  requestKey: string;
  paneId: string;
  decision: AnswerDecision;
  keyName: string;
  by: AnswerSource;
  at: number;
}

const KEEP_MS = 10 * 60_000;

interface AnswerState {
  /** By request key. */
  answers: Record<string, PermissionAnswer>;
  record: (answer: PermissionAnswer) => void;
}

export const usePermissionAnswerStore = create<AnswerState>((set) => ({
  answers: {},
  record: (answer) =>
    set((st) => {
      const next: Record<string, PermissionAnswer> = {};
      for (const [key, a] of Object.entries(st.answers)) if (answer.at - a.at < KEEP_MS) next[key] = a;
      next[answer.requestKey] = answer;
      return { answers: next };
    }),
}));

/** Sends the prompt's key to the pane and records who answered. */
export function answerPermission(paneId: string, requestKey: string, decision: AnswerDecision, keyName: string, by: AnswerSource): void {
  void paneSendKeys(paneId, keyName).catch(() => {});
  usePermissionAnswerStore.getState().record({ requestKey, paneId, decision, keyName, by, at: Date.now() });
}
