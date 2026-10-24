import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaneStatusDot } from "./PaneStatus";

const EMOJI = /\p{Extended_Pictographic}/u;

describe("PaneStatusDot", () => {
  it("is a labelled shape, never an emoji", () => {
    const { container } = render(
      <>
        <PaneStatusDot state="permission" />
        <PaneStatusDot state="working" />
        <PaneStatusDot state="error" />
      </>,
    );
    expect(screen.getByRole("img", { name: "Needs permission" })).toHaveClass("pulse-halo");
    expect(screen.getByRole("img", { name: "Working" }).querySelector("svg")).toHaveClass("motion-safe:animate-spin");
    expect(screen.getByRole("img", { name: "Error" }).querySelector("svg")).not.toBeNull();
    expect(container.textContent ?? "").not.toMatch(EMOJI);
  });
});

describe("PaneStatusDot shapes", () => {
  it("draws a different icon per state", () => {
    const states = ["working", "permission", "input", "done", "idle", "error"] as const;
    const { container } = render(
      <>
        {states.map((st) => (
          <PaneStatusDot key={st} state={st} />
        ))}
      </>,
    );
    const shapes = [...container.querySelectorAll("[data-state] svg")].map((svg) => svg.innerHTML);
    expect(shapes).toHaveLength(states.length);
    expect(new Set(shapes).size).toBe(states.length);
    expect(screen.getByRole("img", { name: "Waiting for input" })).toHaveAttribute("data-state", "input");
  });
});

describe("no emoji status icons (DESIGN_SYSTEM §5)", () => {
  it.each(["features/agents/AgentsPanel.tsx", "app/StatusBar.tsx", "features/workspace/AgentHeaderStrip.tsx"])(
    "%s",
    (file) => {
      const source = readFileSync(join(__dirname, "..", "..", file), "utf8");
      expect(source).not.toMatch(EMOJI);
    },
  );
});
