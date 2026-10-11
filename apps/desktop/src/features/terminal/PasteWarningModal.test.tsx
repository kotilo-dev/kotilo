import { describe, expect, it } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { PasteWarningModal } from "./PasteWarningModal";

/**
 * Review #16: `TerminalView` renders `<PasteWarningModal onCancel={() => ...} onConfirm={(v) =>
 * ...} />` with INLINE lambdas — brand-new function references on every `TerminalView` render.
 * This wrapper mirrors that real-world shape (a parent that re-renders for unrelated reasons,
 * passing new handler references each time) so the test actually exercises the bug's trigger,
 * not just the component in isolation with stable props.
 */
function Wrapper() {
  const [, setTick] = useState(0);
  return (
    <div>
      <button onClick={() => setTick((t) => t + 1)}>force-rerender</button>
      <PasteWarningModal
        lines={3}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    </div>
  );
}

describe("PasteWarningModal (review #16: focus-stealing effect deps)", () => {
  it("focuses the Paste button once on mount, not on every unrelated parent re-render", () => {
    render(<Wrapper />);
    const checkbox = screen.getByRole("checkbox");
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);

    // Simulates the parent (TerminalView) re-rendering while the modal is open (new
    // onConfirm/onCancel references each time) — must NOT steal focus back to the Paste button.
    fireEvent.click(screen.getByText("force-rerender"));
    fireEvent.click(screen.getByText("force-rerender"));

    expect(document.activeElement).toBe(checkbox);
  });

  it("toggling the checkbox by clicking it keeps focus on the checkbox (keyboard-toggleable)", () => {
    render(<Wrapper />);
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    checkbox.focus();

    fireEvent.click(checkbox);

    expect(checkbox.checked).toBe(true);
    expect(document.activeElement).toBe(checkbox);
  });

  it("still focuses the Paste (confirm) button on initial mount", () => {
    render(<Wrapper />);
    const confirmButton = screen.getByText("Paste");
    expect(document.activeElement).toBe(confirmButton);
  });
});
