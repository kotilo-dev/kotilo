import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentHeaderStrip, type AgentHeaderStripProps } from "./AgentHeaderStrip";
import type { PaneVisualState } from "./paneSession";

function props(partial: Partial<AgentHeaderStripProps>): AgentHeaderStripProps {
  return {
    agent: "codex",
    agentName: "Codex CLI",
    projectName: "payments-gateway",
    branch: "main",
    model: "gpt-5-codex",
    state: "working",
    elapsed: "2m",
    contextPercent: 41,
    tokens: 88_000,
    costUsd: null,
    limit: { window: "weekly", usedPercent: 31 },
    ...partial,
  };
}

const LABELS: Record<PaneVisualState, string> = {
  working: "Working",
  permission: "Needs permission",
  input: "Waiting for input",
  done: "Done",
  idle: "Idle",
  error: "Error",
};

describe("AgentHeaderStrip", () => {
  it.each(Object.entries(LABELS))("shows the %s state with its §10 label", (state, label) => {
    const { container } = render(<AgentHeaderStrip {...props({ state: state as PaneVisualState })} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelector(`[data-state="${state}"]`)).not.toBeNull();
  });

  it("spins only while working and pulses while blocked", () => {
    const { container, rerender } = render(<AgentHeaderStrip {...props({ state: "working" })} />);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(container.querySelector(".pulse-halo")).toBeNull();
    rerender(<AgentHeaderStrip {...props({ state: "permission" })} />);
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(container.querySelector(".pulse-halo")).not.toBeNull();
  });

  it("keeps the ring still while only background work runs", () => {
    const { container } = render(<AgentHeaderStrip {...props({ state: "working", background: "Background: bash" })} />);
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByText("Background: bash")).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("shows project, agent · branch · model, context, tokens and the limit", () => {
    render(<AgentHeaderStrip {...props({})} />);
    expect(screen.getByText("payments-gateway")).toBeInTheDocument();
    expect(screen.getByText("Codex CLI · main · gpt-5-codex")).toBeInTheDocument();
    expect(screen.getByText("41%")).toBeInTheDocument();
    expect(screen.getByText("88k tokens")).toBeInTheDocument();
    expect(screen.getByText("Weekly limit")).toBeInTheDocument();
    expect(screen.getByText("31%")).toBeInTheDocument();
  });

  it("shows a dash instead of inventing missing numbers", () => {
    render(<AgentHeaderStrip {...props({ contextPercent: null, tokens: null, costUsd: null, limit: null })} />);
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText("Weekly limit")).toBeNull();
  });

  it("prefers cost over tokens when the hub has a price", () => {
    render(<AgentHeaderStrip {...props({ costUsd: 1.24 })} />);
    expect(screen.getByText("$1.24")).toBeInTheDocument();
  });

  it("uses no emoji", () => {
    const { container } = render(<AgentHeaderStrip {...props({ state: "permission" })} />);
    expect(container.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
