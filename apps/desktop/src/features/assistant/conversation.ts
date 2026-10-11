/**
 * The assistant chat as a pure reducer (M7, D-053). The conversation lives only in the popup's
 * memory: nothing here is persisted, and `reset` drops it on every open / close. Turn ids keep
 * growing across resets, so stream events of a chat that was cleared are ignored.
 */
import type { AssistantEvent, AssistantMessage } from "./assistantIpc";

export type TurnStatus = "streaming" | "done" | "error" | "stopped";

export interface Turn {
  id: number;
  user: string;
  answer: string;
  status: TurnStatus;
  /** Stop was asked for; the turn ends when Rust sends `done`. */
  stopping: boolean;
  errorKind: string | null;
  error: string | null;
}

export interface ChatMeta {
  providerLabel: string;
  model: string | null;
  ephemeral: boolean | null;
}

export interface ConversationState {
  turns: Turn[];
  nextId: number;
  /** From the latest stream's `meta` event (may differ from `assistant_info` after a switch). */
  meta: ChatMeta | null;
}

export type ConversationAction =
  | { type: "send"; text: string }
  | { type: "event"; turnId: number; event: AssistantEvent }
  /** `assistant_chat` itself failed (no `done` will come). */
  | { type: "failed"; turnId: number; error: string }
  /**
   * `assistant_stop` or `assistant_chat` resolved. After a stop Rust sends no `done`, so a
   * stopped turn ends here (partial text kept). `lost` (sent a while after `assistant_chat`
   * resolved, so late Channel frames land first) also ends a turn that never got `done`.
   */
  | { type: "ended"; turnId: number; lost: boolean }
  | { type: "stop" }
  | { type: "editLast" }
  | { type: "reset" };

export const INITIAL_CONVERSATION: ConversationState = { turns: [], nextId: 1, meta: null };

/** Error kind for a failed `assistant_chat` call (shown with the generic message). */
export const IPC_ERROR_KIND = "ipc";

export function runningTurn(state: ConversationState): Turn | null {
  const last = state.turns[state.turns.length - 1];
  return last?.status === "streaming" ? last : null;
}

export function isRunning(state: ConversationState): boolean {
  return runningTurn(state) !== null;
}

/** The conversation sent with a new message: every completed turn, then the new user message. */
export function messagesFor(state: ConversationState, text: string): AssistantMessage[] {
  const out: AssistantMessage[] = [];
  for (const t of state.turns) {
    if (t.status !== "done") continue;
    out.push({ role: "user", text: t.user }, { role: "assistant", text: t.answer });
  }
  out.push({ role: "user", text });
  return out;
}

/** Text `editLast` puts back into the composer (null = nothing to edit). */
export function lastUserText(state: ConversationState): string | null {
  if (isRunning(state)) return null;
  return state.turns[state.turns.length - 1]?.user ?? null;
}

function updateTurn(state: ConversationState, id: number, change: (t: Turn) => Turn): ConversationState {
  const index = state.turns.findIndex((t) => t.id === id);
  const turn = state.turns[index];
  if (!turn || turn.status !== "streaming") return state;
  const turns = state.turns.slice();
  turns[index] = change(turn);
  return { ...state, turns };
}

function finish(turn: Turn, errorKind: string, error: string | null): Turn {
  if (errorKind === "none") {
    return turn.answer.trim() === "" ? { ...turn, status: "error", stopping: false, errorKind: "failed", error: null } : { ...turn, status: "done", stopping: false, errorKind: null, error: null };
  }
  if (errorKind === "cancelled" && turn.stopping) return { ...turn, status: "stopped", stopping: false, errorKind: null, error: null };
  return { ...turn, status: "error", stopping: false, errorKind, error };
}

export function conversationReducer(state: ConversationState, action: ConversationAction): ConversationState {
  switch (action.type) {
    case "send": {
      const text = action.text.trim();
      if (text === "" || isRunning(state)) return state;
      const turn: Turn = { id: state.nextId, user: text, answer: "", status: "streaming", stopping: false, errorKind: null, error: null };
      return { ...state, turns: [...state.turns, turn], nextId: state.nextId + 1 };
    }
    case "event": {
      const e = action.event;
      if (!state.turns.some((t) => t.id === action.turnId)) return state;
      switch (e.type) {
        case "meta":
          return { ...state, meta: { providerLabel: e.providerLabel, model: e.model ?? null, ephemeral: e.ephemeral ?? null } };
        case "text":
          return updateTurn(state, action.turnId, (t) => ({ ...t, answer: e.text }));
        case "done":
          return updateTurn(state, action.turnId, (t) => finish(t, e.errorKind || "failed", e.error ?? null));
        default:
          return state;
      }
    }
    case "failed":
      return updateTurn(state, action.turnId, (t) => ({ ...t, status: "error", stopping: false, errorKind: IPC_ERROR_KIND, error: action.error }));
    case "ended":
      return updateTurn(state, action.turnId, (t) =>
        t.stopping ? { ...t, status: "stopped", stopping: false } : action.lost ? { ...t, status: "error", errorKind: "hubUnavailable", error: null } : t,
      );
    case "stop": {
      const running = runningTurn(state);
      return running ? updateTurn(state, running.id, (t) => ({ ...t, stopping: true })) : state;
    }
    case "editLast":
      return lastUserText(state) === null ? state : { ...state, turns: state.turns.slice(0, -1) };
    case "reset":
      return { ...INITIAL_CONVERSATION, nextId: state.nextId };
  }
}
