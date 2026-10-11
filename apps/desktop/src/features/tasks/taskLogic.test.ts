import { describe, expect, it } from "vitest";
import { groupTasks, isoDatePlusDays, splitNote } from "./taskLogic";
import type { PersonalTask } from "../../lib/hubTypes";

function task(id: number, projectRoot: string | null, projectName: string | null = projectRoot): PersonalTask {
  return {
    id,
    text: `t${id}`,
    title: `t${id}`,
    details: null,
    projectRoot,
    projectName,
    dueDate: null,
    dueTime: null,
    priority: "normal",
    dueState: "none",
    createdAt: "2026-10-01T10:00:00+03:00",
    updatedAt: "2026-10-01T10:00:00+03:00",
    completedAt: null,
  };
}

describe("taskLogic", () => {
  it("puts general notes first, then projects in order, keeping the hub's order inside groups", () => {
    const groups = groupTasks([task(1, "C:/b", "b"), task(2, null), task(3, "C:/a", "a"), task(4, "C:/b", "b"), task(5, null)]);
    expect(groups.map((g) => g.projectName)).toEqual([null, "b", "a"]);
    expect(groups[0]!.tasks.map((t) => t.id)).toEqual([2, 5]);
    expect(groups[1]!.tasks.map((t) => t.id)).toEqual([1, 4]);
  });

  it("has no general group when every task belongs to a project", () => {
    expect(groupTasks([task(1, "C:/a")]).map((g) => g.projectRoot)).toEqual(["C:/a"]);
  });

  it("splits the first line as the title", () => {
    expect(splitNote("  Buy milk \n  2 liters\nsemi-skimmed ")).toEqual({ title: "Buy milk", details: "2 liters\nsemi-skimmed" });
    expect(splitNote("only title")).toEqual({ title: "only title", details: "" });
    expect(splitNote("   ").title).toBe("");
  });

  it("computes local due dates", () => {
    const now = new Date(2026, 9, 31, 23, 30);
    expect(isoDatePlusDays(0, now)).toBe("2026-10-31");
    expect(isoDatePlusDays(1, now)).toBe("2026-11-01");
    expect(isoDatePlusDays(7, now)).toBe("2026-11-07");
  });
});
