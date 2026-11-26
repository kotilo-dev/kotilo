import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PendingPermission } from "../../lib/hubTypes";
import { PermissionCard } from "./PermissionCard";

const base: PendingPermission = { tool: "Bash", command: "git push --force", path: null, risk: "gitPush", since: "2026-10-04T10:00:00Z" };

function renderCard(permission: PendingPermission) {
  render(
    <PermissionCard agentName="Claude" projectName="app" waiting="5s" permission={permission} keys={null} autoFocus={false} onDecide={vi.fn()} onAnswerInTerminal={vi.fn()} />,
  );
}

describe("PermissionCard watch rule badge", () => {
  it("shows no rule badge without a watch hit", () => {
    renderCard(base);
    expect(screen.queryByTestId("permission-watch-rule")).toBeNull();
    expect(screen.getByText("Pushes to a remote")).toBeInTheDocument();
  });

  it("shows the translated built-in rule name next to the risk badge", () => {
    renderCard({ ...base, watch: { id: "builtin.force-push", name: "Force push (hub)" } });
    expect(screen.getByTestId("permission-watch-rule")).toHaveTextContent("Rule: Force push");
    expect(screen.getByText("Pushes to a remote")).toBeInTheDocument();
  });

  it("falls back to the name the hub sends for a user rule", () => {
    renderCard({ ...base, watch: { id: "user.prod-host", name: "Prod host" } });
    expect(screen.getByTestId("permission-watch-rule")).toHaveTextContent("Rule: Prod host");
  });

  it("falls back to the hub name for a built-in without a translation", () => {
    renderCard({ ...base, watch: { id: "builtin.brand-new", name: "Brand new" } });
    expect(screen.getByTestId("permission-watch-rule")).toHaveTextContent("Rule: Brand new");
  });
});
