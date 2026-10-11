import { describe, expect, it } from "vitest";
import { bubbleFor, INITIAL_MASCOT_STATE, mergeMascotState, parseDemoParams, snailHeight } from "./mascotState";

describe("mascot state", () => {
  it("starts asleep at scale 3 facing left", () => {
    expect(INITIAL_MASCOT_STATE).toMatchObject({ state: "sleep", scale: 3, direction: "left", walking: false });
    expect(snailHeight(2)).toBe(32);
    expect(snailHeight(4)).toBe(64);
  });

  it("takes a full valid payload", () => {
    const next = { state: "perm", direction: "right", walking: true, scale: 4, celebrate: true, label: "Needs you" } as const;
    expect(mergeMascotState(INITIAL_MASCOT_STATE, next)).toEqual(next);
  });

  it("keeps the previous value for missing or invalid fields", () => {
    const prev = { ...INITIAL_MASCOT_STATE, state: "work" as const, label: "Working" };
    expect(mergeMascotState(prev, { state: "dance", scale: 5, direction: "up", walking: "yes", label: 3 })).toEqual(prev);
    expect(mergeMascotState(prev, null)).toBe(prev);
    expect(mergeMascotState(prev, "perm")).toBe(prev);
    expect(mergeMascotState(prev, { scale: 2 })).toEqual({ ...prev, scale: 2 });
  });

  it("parses the e2e demo params", () => {
    expect(parseDemoParams("?view=mascot")).toBeNull();
    expect(parseDemoParams("?view=mascot&demo=nope")).toBeNull();
    expect(parseDemoParams("?view=mascot&demo=work&scale=2&direction=right")).toEqual({
      state: "work",
      direction: "right",
      walking: true,
      scale: 2,
      celebrate: true,
      label: "",
    });
    expect(parseDemoParams("?demo=perm&walking=1&celebrate=0&scale=9&label=Hi")).toMatchObject({
      state: "perm",
      direction: "left",
      walking: true,
      scale: 3,
      celebrate: false,
      label: "Hi",
    });
  });

  it("maps states to speech bubbles", () => {
    expect(bubbleFor("perm")).toBe("!");
    expect(bubbleFor("error")).toBe("!");
    expect(bubbleFor("input")).toBe("?");
    for (const s of ["sleep", "done", "work", "sweat"] as const) expect(bubbleFor(s)).toBeNull();
  });
});
