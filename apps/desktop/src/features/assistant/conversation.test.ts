import { describe, expect, it } from "vitest";
import type { AssistantEvent } from "./assistantIpc";
import { conversationReducer, INITIAL_CONVERSATION, IPC_ERROR_KIND, isRunning, lastUserText, messagesFor, type ConversationAction, type ConversationState } from "./conversation";

const run = (actions: ConversationAction[], start: ConversationState = INITIAL_CONVERSATION) => actions.reduce(conversationReducer, start);
const ev = (turnId: number, event: AssistantEvent): ConversationAction => ({ type: "event", turnId, event });

describe("conversationReducer", () => {
  it("sends, streams the full text so far and finishes", () => {
    let s = run([{ type: "send", text: "  Hello?  " }]);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]).toMatchObject({ id: 1, user: "Hello?", answer: "", status: "streaming" });
    expect(isRunning(s)).toBe(true);

    s = run([ev(1, { type: "meta", provider: "cli:codex", providerLabel: "Codex", model: "gpt-5", ephemeral: true }), ev(1, { type: "text", text: "Hi" }), ev(1, { type: "text", text: "Hi there" })], s);
    expect(s.meta).toEqual({ providerLabel: "Codex", model: "gpt-5", ephemeral: true });
    expect(s.turns[0]!.answer).toBe("Hi there");

    s = conversationReducer(s, ev(1, { type: "done", errorKind: "none" }));
    expect(s.turns[0]!.status).toBe("done");
    expect(isRunning(s)).toBe(false);
  });

  it("ignores empty messages and a second send while an answer runs", () => {
    expect(run([{ type: "send", text: "   " }]).turns).toHaveLength(0);
    const s = run([{ type: "send", text: "a" }, { type: "send", text: "b" }]);
    expect(s.turns.map((t) => t.user)).toEqual(["a"]);
  });

  it("marks errors with their kind and detail", () => {
    const s = run([{ type: "send", text: "a" }, ev(1, { type: "done", errorKind: "notLoggedIn", error: "exit 1" })]);
    expect(s.turns[0]).toMatchObject({ status: "error", errorKind: "notLoggedIn", error: "exit 1" });
  });

  it("keeps partial text when an error follows it", () => {
    const s = run([{ type: "send", text: "a" }, ev(1, { type: "text", text: "half an" }), ev(1, { type: "done", errorKind: "timeout" })]);
    expect(s.turns[0]).toMatchObject({ status: "error", errorKind: "timeout", answer: "half an" });
  });

  it("treats an empty successful answer as failed", () => {
    const s = run([{ type: "send", text: "a" }, ev(1, { type: "done", errorKind: "none" })]);
    expect(s.turns[0]).toMatchObject({ status: "error", errorKind: "failed" });
  });

  it("records a failed invoke and ignores events after the turn ended", () => {
    let s = run([{ type: "send", text: "a" }, { type: "failed", turnId: 1, error: "hub down" }]);
    expect(s.turns[0]).toMatchObject({ status: "error", errorKind: IPC_ERROR_KIND, error: "hub down" });
    s = conversationReducer(s, ev(1, { type: "text", text: "late" }));
    expect(s.turns[0]!.answer).toBe("");
  });

  it("stop keeps the partial answer and ends as stopped on cancelled", () => {
    let s = run([{ type: "send", text: "a" }, ev(1, { type: "text", text: "partial" }), { type: "stop" }]);
    expect(s.turns[0]).toMatchObject({ status: "streaming", stopping: true });
    s = conversationReducer(s, ev(1, { type: "done", errorKind: "cancelled" }));
    expect(s.turns[0]).toMatchObject({ status: "stopped", stopping: false, answer: "partial" });
    // A cancel nobody asked for is an error.
    const other = run([{ type: "send", text: "b" }, ev(1, { type: "done", errorKind: "cancelled" })]);
    expect(other.turns[0]).toMatchObject({ status: "error", errorKind: "cancelled" });
  });

  it("a stopped turn ends when the stop or the chat call resolves (Rust sends no done)", () => {
    let s = run([{ type: "send", text: "a" }, ev(1, { type: "text", text: "partial" })]);
    // Not stopping: resolving alone waits for late frames; `lost` ends it.
    expect(conversationReducer(s, { type: "ended", turnId: 1, lost: false }).turns[0]!.status).toBe("streaming");
    expect(conversationReducer(s, { type: "ended", turnId: 1, lost: true }).turns[0]).toMatchObject({ status: "error", errorKind: "hubUnavailable", answer: "partial" });
    s = run([{ type: "stop" }, { type: "ended", turnId: 1, lost: false }], s);
    expect(s.turns[0]).toMatchObject({ status: "stopped", answer: "partial" });
    // A finished turn isn't touched.
    const done = run([{ type: "send", text: "b" }, ev(1, { type: "text", text: "x" }), ev(1, { type: "done", errorKind: "none" }), { type: "ended", turnId: 1, lost: true }]);
    expect(done.turns[0]!.status).toBe("done");
  });

  it("posts completed turns plus the new message", () => {
    const s = run([
      { type: "send", text: "q1" },
      ev(1, { type: "text", text: "a1" }),
      ev(1, { type: "done", errorKind: "none" }),
      { type: "send", text: "q2" },
      ev(2, { type: "done", errorKind: "timeout" }),
      { type: "send", text: "q3" },
      ev(3, { type: "text", text: "a3" }),
      { type: "stop" },
      ev(3, { type: "done", errorKind: "cancelled" }),
    ]);
    expect(messagesFor(s, "q4")).toEqual([
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "q4" },
    ]);
  });

  it("edit-last removes the last turn and its answer, not while running", () => {
    let s = run([{ type: "send", text: "q1" }, ev(1, { type: "text", text: "a1" }), ev(1, { type: "done", errorKind: "none" }), { type: "send", text: "q2" }]);
    expect(lastUserText(s)).toBeNull();
    expect(conversationReducer(s, { type: "editLast" })).toBe(s);
    s = conversationReducer(s, ev(2, { type: "done", errorKind: "failed" }));
    expect(lastUserText(s)).toBe("q2");
    s = conversationReducer(s, { type: "editLast" });
    expect(s.turns.map((t) => t.user)).toEqual(["q1"]);
    expect(lastUserText(INITIAL_CONVERSATION)).toBeNull();
  });

  it("reset clears everything and ignores the old stream", () => {
    let s = run([{ type: "send", text: "q1" }, ev(1, { type: "meta", provider: "p", providerLabel: "P", model: null, ephemeral: false })]);
    s = conversationReducer(s, { type: "reset" });
    expect(s.turns).toEqual([]);
    expect(s.meta).toBeNull();
    s = conversationReducer(s, ev(1, { type: "text", text: "late" }));
    expect(s.turns).toEqual([]);
    s = conversationReducer(s, { type: "send", text: "new" });
    expect(s.turns[0]!.id).toBe(2);
  });
});
