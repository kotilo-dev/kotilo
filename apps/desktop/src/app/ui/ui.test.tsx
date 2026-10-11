import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { useI18nStore } from "../i18n";
import { formatCost, formatDuration, formatPercent100, secondsSince, toIsoDate } from "./format";
import { LimitMeter, meterColorClass } from "./LimitMeter";
import { StatusPill, toneForState } from "./StatusPill";
import { AgentAvatar } from "./AgentAvatar";

beforeEach(() => useI18nStore.setState({ preference: "en", language: "en" }));

describe("format", () => {
  it("formats durations per DESIGN_SYSTEM §10", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(134)).toBe("2m 14s");
    expect(formatDuration(3900)).toBe("1h 05m");
    expect(formatDuration(null)).toBe("—");
  });

  it("never shows $0 for unpriced usage", () => {
    expect(formatCost(null)).toBe("—");
    expect(formatCost(0, true)).toBe("—");
    expect(formatCost(4.82)).toBe("$4.82");
  });

  it("percent, seconds since, local iso date", () => {
    expect(formatPercent100(41.4)).toBe("41%");
    expect(formatPercent100(null)).toBe("—");
    expect(secondsSince("2026-10-04T10:00:00Z", Date.parse("2026-10-04T10:01:12Z"))).toBe(72);
    expect(toIsoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("primitives", () => {
  it("limit meter colors by threshold (§7.9)", () => {
    expect(meterColorClass(50)).toBe("bg-accent");
    expect(meterColorClass(75)).toBe("bg-working");
    expect(meterColorClass(95)).toBe("bg-blocked");
    render(<LimitMeter label="Codex · Weekly" percent={31} note="resets 11:20" />);
    expect(screen.getByRole("meter", { name: "Codex · Weekly" })).toHaveAttribute("aria-valuenow", "31");
  });

  it("status pill labels and tones", () => {
    expect(toneForState("WaitingPermission")).toBe("blocked");
    expect(toneForState("Ended")).toBe("neutral");
    render(<StatusPill state="WaitingPermission" suffix="1m 12s" />);
    expect(screen.getByText("Needs permission")).toBeInTheDocument();
    expect(screen.getByText("· 1m 12s")).toBeInTheDocument();
  });

  it("agent avatar names the agent", () => {
    render(<AgentAvatar agent="codex" />);
    expect(screen.getByRole("img", { name: "Codex CLI" })).toHaveTextContent("X");
  });
});
