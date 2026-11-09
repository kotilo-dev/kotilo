import { describe, expect, it } from "vitest";
import { en } from "../../app/i18n/en";
import type { WorktreeInfo, WorktreeMergeResult } from "../../lib/ipc";
import type { TerminalTab } from "../../stores/terminalStore";
import {
  badgeLabel,
  deleteBranchDefault,
  mergeMessage,
  offersCleanup,
  removeFollowUp,
  slugify,
  tabsInWorktree,
  unsupportedHint,
  worktreeForCwd,
  worktreeFromSession,
} from "./worktreeLogic";

function wt(over: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    name: "fix-login",
    rel: ".kotilo/worktrees/fix-login",
    branch: "kotilo/fix-login",
    head: "a".repeat(40),
    base: "main",
    managed: true,
    locked: false,
    prunable: false,
    dirty: 0,
    ahead: 2,
    behind: 0,
    added: 10,
    removed: 3,
    ...over,
  };
}

function tab(id: string, cwdRel: string): TerminalTab {
  return { id, title: id, profileId: null, cwdRel, agentCommand: null, status: "idle", titleEdited: false };
}

describe("slugify", () => {
  it("lowercases and turns other runs into one dash", () => {
    expect(slugify("Fix Login!")).toBe("fix-login");
    expect(slugify("  --API v2 / auth__flow-- ")).toBe("api-v2-auth-flow");
    expect(slugify("Çalışma alanı")).toBe("al-ma-alan");
  });

  it("is empty when nothing usable is left", () => {
    expect(slugify("")).toBe("");
    expect(slugify("!!!")).toBe("");
  });

  it("cuts at 40 characters without a trailing dash", () => {
    const slug = slugify(`${"a".repeat(39)} bcd`);
    expect(slug).toBe("a".repeat(39));
    expect(slugify("x".repeat(60))).toHaveLength(40);
  });
});

describe("worktreeForCwd", () => {
  const list = [wt({}), wt({ name: "spike", rel: ".claude/worktrees/spike", branch: null, managed: false })];

  it("matches the worktree folder and folders inside it", () => {
    expect(worktreeForCwd(".kotilo/worktrees/fix-login", list)).toMatchObject({ name: "fix-login", branch: "kotilo/fix-login", managed: true });
    expect(worktreeForCwd(".kotilo\\worktrees\\fix-login\\src", list)).toMatchObject({ name: "fix-login" });
    expect(worktreeForCwd(".claude/worktrees/spike/", list)).toMatchObject({ name: "spike", managed: false, branch: null });
  });

  it("is null at the root, in other folders and for name prefixes", () => {
    expect(worktreeForCwd("", list)).toBeNull();
    expect(worktreeForCwd("src", list)).toBeNull();
    expect(worktreeForCwd(".kotilo/worktrees/fix-login-2", list)).toMatchObject({ name: "fix-login-2", branch: null });
    expect(worktreeForCwd(".claude/worktrees/spiked", list)).toBeNull();
  });

  it("falls back to the folder name under .kotilo/worktrees before the list loads", () => {
    expect(worktreeForCwd(".kotilo/worktrees/new-one/src", null)).toEqual({ name: "new-one", rel: ".kotilo/worktrees/new-one", branch: null, managed: true });
    expect(worktreeForCwd(".kotilo/worktrees", null)).toBeNull();
  });

  it("labels with the branch, else the name", () => {
    expect(badgeLabel(worktreeForCwd(".kotilo/worktrees/fix-login", list)!)).toBe("kotilo/fix-login");
    expect(badgeLabel(worktreeForCwd(".claude/worktrees/spike", list)!)).toBe("spike");
  });
});

describe("worktreeFromSession", () => {
  const list = [wt({})];

  it("matches a listed worktree case-insensitively under the workspace root", () => {
    const session = { worktree: "c:\\SRC\\orders-service\\.kotilo\\worktrees\\FIX-LOGIN", worktreeBranch: "kotilo/fix-login" };
    expect(worktreeFromSession(session, "C:\\src\\orders-service\\", list)).toMatchObject({ name: "fix-login", rel: ".kotilo/worktrees/fix-login", managed: true });
  });

  it("labels an unlisted worktree with its branch or last segment", () => {
    expect(badgeLabel(worktreeFromSession({ worktree: "D:\\wt\\spike", worktreeBranch: "spike-branch" }, null, null)!)).toBe("spike-branch");
    expect(badgeLabel(worktreeFromSession({ worktree: "/home/me/wt/spike/", worktreeBranch: null }, "/home/me/app", list)!)).toBe("spike");
  });

  it("is null without a worktree (older hubs)", () => {
    expect(worktreeFromSession({}, "C:\\src", list)).toBeNull();
    expect(worktreeFromSession({ worktree: null }, "C:\\src", list)).toBeNull();
    expect(worktreeFromSession(null, "C:\\src", list)).toBeNull();
  });
});

describe("tabsInWorktree", () => {
  it("keeps the tabs whose cwd is inside the worktree", () => {
    const tabs = [tab("a", ".kotilo/worktrees/fix-login"), tab("b", ".kotilo/worktrees/fix-login/src"), tab("c", ""), tab("d", ".kotilo/worktrees/fix-login-2")];
    expect(tabsInWorktree(tabs, ".kotilo/worktrees/fix-login").map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("messages", () => {
  const result = (status: WorktreeMergeResult["status"]): WorktreeMergeResult => ({ status, conflicts: [], detail: null });

  it("maps every merge status to a message and tone", () => {
    expect(mergeMessage(en, result("merged"), "kotilo/x", "main")).toEqual({ tone: "success", text: "Merged kotilo/x into main." });
    expect(mergeMessage(en, result("upToDate"), "kotilo/x", "main").tone).toBe("info");
    expect(mergeMessage(en, result("conflict"), "kotilo/x", "main").text).toMatch(/conflicts and was undone/);
    expect(mergeMessage(en, result("mainDirty"), "kotilo/x", "main").text).toMatch(/main checkout has uncommitted/);
    expect(mergeMessage(en, result("worktreeDirty"), "kotilo/x", "main").text).toBe("The worktree has uncommitted changes. Commit in the worktree first.");
    expect(mergeMessage(en, result("notOnBase"), "kotilo/x", "main").text).toMatch(/not on main/);
    expect(mergeMessage(en, result("failed"), "kotilo/x", "main").tone).toBe("error");
  });

  it("offers cleanup only when the base has every change", () => {
    expect(offersCleanup(result("merged"))).toBe(true);
    expect(offersCleanup(result("upToDate"))).toBe(true);
    expect(offersCleanup(result("conflict"))).toBe(false);
    expect(offersCleanup(result("worktreeDirty"))).toBe(false);
  });

  it("maps remove results to the next step", () => {
    expect(removeFollowUp({ status: "removed", branchDeleted: true, detail: null })).toBe("done");
    expect(removeFollowUp({ status: "dirty", branchDeleted: false, detail: null })).toBe("confirmForce");
    expect(removeFollowUp({ status: "unmerged", branchDeleted: false, detail: null })).toBe("confirmForceBranch");
    expect(removeFollowUp({ status: "failed", branchDeleted: false, detail: "locked" })).toBe("failed");
  });

  it("deletes the branch by default only when it is merged", () => {
    expect(deleteBranchDefault(wt({ ahead: 0 }))).toBe(true);
    expect(deleteBranchDefault(wt({ ahead: 3 }))).toBe(false);
    expect(deleteBranchDefault(wt({ ahead: 0, branch: null }))).toBe(false);
  });

  it("explains why worktrees are unavailable", () => {
    expect(unsupportedHint(en, "notRepoRoot")).toMatch(/top folder/);
    expect(unsupportedHint(en, "noCommit")).toMatch(/no commit/);
    expect(unsupportedHint(en, null)).toBe(en.worktrees.create.unsupported);
  });
});
