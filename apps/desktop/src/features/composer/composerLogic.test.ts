import { describe, expect, it } from "vitest";
import {
  addSavedPrompt,
  applyMention,
  composeMessage,
  composerKeyAction,
  filterSavedPrompts,
  findMentionQuery,
  hasImage,
  insertText,
  MAX_PROMPT_TITLE_CHARS,
  MAX_SAVED_PROMPTS,
  mentionToken,
  moveIndex,
  PASTE_END,
  PASTE_START,
  pastePayload,
  removeSavedPrompt,
  titleFromText,
} from "./composerLogic";

const key = (key: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing: boolean }> = {}) => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("findMentionQuery", () => {
  it("finds an @ at the start or after whitespace", () => {
    expect(findMentionQuery("@src/a", 6)).toEqual({ start: 0, query: "src/a" });
    expect(findMentionQuery("fix @app", 8)).toEqual({ start: 4, query: "app" });
    expect(findMentionQuery("fix @", 5)).toEqual({ start: 4, query: "" });
  });

  it("ignores e-mail-like @ and a caret outside the mention", () => {
    expect(findMentionQuery("mail me@host", 12)).toBeNull();
    expect(findMentionQuery("@app done", 9)).toBeNull();
    expect(findMentionQuery("no mention", 10)).toBeNull();
  });
});

describe("applyMention", () => {
  it("replaces the query with the file and puts the caret after it", () => {
    const text = "look at @app please";
    const mention = findMentionQuery(text, 12)!;
    expect(applyMention(text, mention, "src/approval.ts")).toEqual({ text: "look at @src/approval.ts please", caret: 25 });
  });

  it("quotes paths with spaces", () => {
    expect(mentionToken("docs/my file.md")).toBe('@"docs/my file.md"');
    expect(applyMention("@my", { start: 0, query: "my" }, "my file.md").text).toBe('@"my file.md" ');
  });
});

describe("insertText", () => {
  it("adds spaces only where words would touch", () => {
    expect(insertText("fix the", 7, 7, "tests")).toEqual({ text: "fix the tests", caret: 13 });
    expect(insertText("fix ", 4, 4, "tests")).toEqual({ text: "fix tests", caret: 9 });
    expect(insertText("", 0, 0, " hello ")).toEqual({ text: "hello", caret: 5 });
    expect(insertText("ab", 1, 1, "X")).toEqual({ text: "a X b", caret: 4 });
  });

  it("replaces the selection and ignores empty text", () => {
    expect(insertText("fix old here", 4, 7, "new")).toEqual({ text: "fix new here", caret: 7 });
    expect(insertText("same", 2, 2, "  ")).toEqual({ text: "same", caret: 2 });
  });
});

describe("composeMessage", () => {
  it("appends attachment chips as @paths", () => {
    expect(composeMessage("  what is this? ", [".kotilo/attachments/a.png"])).toBe("what is this? @.kotilo/attachments/a.png");
    expect(composeMessage("", ["a.png", "b c.png"])).toBe('@a.png @"b c.png"');
    expect(composeMessage("line 1\nline 2", ["a.png"])).toBe("line 1\nline 2\n@a.png");
    expect(composeMessage("  ", [])).toBe("");
  });
});

describe("pastePayload", () => {
  it("wraps in bracketed paste markers and turns newlines into CR", () => {
    expect(pastePayload("a\nb\r\nc", true)).toBe(`${PASTE_START}a\rb\rc${PASTE_END}`);
    expect(pastePayload("a\nb", false)).toBe("a\rb");
  });

  it("strips escape and control characters so the paste cannot be ended early", () => {
    expect(pastePayload(`x${PASTE_END}rm -rf\x07\x00\ty`, true)).toBe(`${PASTE_START}x[201~rm -rf\ty${PASTE_END}`);
  });
});

describe("composerKeyAction", () => {
  it("Enter sends, Shift+Enter is a newline, other keys stay with the textarea", () => {
    expect(composerKeyAction(key("Enter"), false)).toBe("send");
    expect(composerKeyAction(key("Enter", { shiftKey: true }), false)).toBe("newline");
    expect(composerKeyAction(key("Enter", { ctrlKey: true }), false)).toBeNull();
    expect(composerKeyAction(key("a"), false)).toBeNull();
    expect(composerKeyAction(key("Escape"), false)).toBe("leave");
    expect(composerKeyAction(key("Escape", { shiftKey: true }), false)).toBeNull();
    expect(composerKeyAction(key("Enter", { isComposing: true }), false)).toBeNull();
  });

  it("drives the suggestion list while it is open", () => {
    expect(composerKeyAction(key("ArrowDown"), true)).toBe("next");
    expect(composerKeyAction(key("ArrowUp"), true)).toBe("previous");
    expect(composerKeyAction(key("Enter"), true)).toBe("accept");
    expect(composerKeyAction(key("Tab"), true)).toBe("accept");
    expect(composerKeyAction(key("Escape"), true)).toBe("close");
    expect(composerKeyAction(key("Enter", { shiftKey: true }), true)).toBe("newline");
  });
});

describe("saved prompts", () => {
  it("derives a title from the first line", () => {
    expect(titleFromText("  Review the diff\nand more")).toBe("Review the diff");
    expect(titleFromText("x".repeat(60))).toHaveLength(40);
  });

  it("adds newest first, replaces the same id and respects the limits", () => {
    const one = addSavedPrompt([], " Run the tests ", "p1");
    expect(one).toEqual([{ id: "p1", title: "Run the tests", text: "Run the tests" }]);
    const two = addSavedPrompt(one, "Review", "p2", "  Review title ");
    expect(two.map((p) => p.id)).toEqual(["p2", "p1"]);
    expect(two[0]!.title).toBe("Review title");
    expect(addSavedPrompt(two, "   ", "p3")).toEqual(two);
    expect(addSavedPrompt([], "t", "p", "y".repeat(200))[0]!.title).toHaveLength(MAX_PROMPT_TITLE_CHARS);
    const many = Array.from({ length: MAX_SAVED_PROMPTS }, (_, i) => ({ id: `p${i}`, title: "", text: "t" }));
    expect(addSavedPrompt(many, "new", "n")).toHaveLength(MAX_SAVED_PROMPTS);
  });

  it("removes and filters", () => {
    const list = [
      { id: "a", title: "Review", text: "Review the diff" },
      { id: "b", title: "Tests", text: "Run the failing tests" },
    ];
    expect(removeSavedPrompt(list, "a").map((p) => p.id)).toEqual(["b"]);
    expect(filterSavedPrompts(list, "FAIL").map((p) => p.id)).toEqual(["b"]);
    expect(filterSavedPrompts(list, " ")).toHaveLength(2);
  });
});

describe("helpers", () => {
  it("moveIndex wraps", () => {
    expect(moveIndex(0, 3, -1)).toBe(2);
    expect(moveIndex(2, 3, 1)).toBe(0);
    expect(moveIndex(0, 0, 1)).toBe(0);
  });

  it("hasImage looks for image files only", () => {
    expect(hasImage([{ kind: "string", type: "text/plain" }])).toBe(false);
    expect(hasImage([{ kind: "file", type: "image/png" }])).toBe(true);
  });
});
