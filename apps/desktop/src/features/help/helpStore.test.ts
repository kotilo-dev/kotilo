import { beforeEach, describe, expect, it } from "vitest";
import { openHelpFromF1, resetHelpMemoryForTest, useHelpStore } from "./helpStore";
import { pushModalOpen, resetModalStackForTest } from "../../app/modalStack";

function closeHelp() {
  useHelpStore.setState({ open: false, item: "user-guide.md", pendingAnchor: null, previouslyFocused: null });
}

describe("helpStore (faz7-spec §10.3)", () => {
  beforeEach(() => {
    closeHelp();
    resetHelpMemoryForTest();
    resetModalStackForTest();
  });

  it("openHelp() with no argument opens the last viewed doc, defaulting to the user guide", () => {
    useHelpStore.getState().openHelp();
    expect(useHelpStore.getState().item).toBe("user-guide.md");
  });

  it("openHelp() is idempotent while already open", () => {
    useHelpStore.getState().openHelp("keybindings.md");
    useHelpStore.getState().openHelp("troubleshooting.md");
    expect(useHelpStore.getState().item).toBe("keybindings.md"); // no-op, second call ignored
  });

  it("remembers the last viewed doc across a close/reopen (but not 'about')", () => {
    useHelpStore.getState().setItem("troubleshooting.md");
    closeHelp();
    useHelpStore.getState().openHelp();
    expect(useHelpStore.getState().item).toBe("troubleshooting.md");

    useHelpStore.getState().setItem("about");
    closeHelp();
    useHelpStore.getState().openHelp();
    expect(useHelpStore.getState().item).toBe("troubleshooting.md"); // "about" isn't remembered as a doc
  });

  it("openItemWithAnchor sets a pending anchor to scroll to", () => {
    useHelpStore.getState().openItemWithAnchor("user-guide.md", "workspaces");
    expect(useHelpStore.getState()).toMatchObject({ open: true, item: "user-guide.md", pendingAnchor: "workspaces" });
  });
});

describe("openHelpFromF1 (faz7-spec §12.4)", () => {
  beforeEach(() => {
    closeHelp();
    resetHelpMemoryForTest();
    resetModalStackForTest();
  });

  it("opens Help when nothing else is open", () => {
    openHelpFromF1();
    expect(useHelpStore.getState().open).toBe(true);
  });

  it("is a no-op while another modal is open", () => {
    const pop = pushModalOpen(); // simulates Settings/QuickPick/PasteWarning/etc. open
    openHelpFromF1();
    expect(useHelpStore.getState().open).toBe(false);
    pop();
    openHelpFromF1();
    expect(useHelpStore.getState().open).toBe(true);
  });

  it("is a no-op while Help itself is already open", () => {
    useHelpStore.getState().openHelp("keybindings.md");
    openHelpFromF1(); // would otherwise reset to the last-viewed doc — must stay a no-op
    expect(useHelpStore.getState().item).toBe("keybindings.md");
  });
});
