import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { DebouncedNumber, DebouncedText, parseIntegerInRange } from "./controls";

describe("parseIntegerInRange (review #8)", () => {
  it("accepts integers within [min, max]", () => {
    expect(parseIntegerInRange("8", 8, 32)).toBe(8);
    expect(parseIntegerInRange("32", 8, 32)).toBe(32);
    expect(parseIntegerInRange("15", 8, 32)).toBe(15);
  });

  it("rejects an empty string (previously coerced to 0, then clamped to 8 server-side)", () => {
    expect(parseIntegerInRange("", 8, 32)).toBeNull();
    expect(parseIntegerInRange("   ", 8, 32)).toBeNull();
  });

  it("rejects non-integers", () => {
    expect(parseIntegerInRange("13.5", 8, 32)).toBeNull();
    expect(parseIntegerInRange("abc", 8, 32)).toBeNull();
  });

  it("rejects values outside the range", () => {
    expect(parseIntegerInRange("7", 8, 32)).toBeNull();
    expect(parseIntegerInRange("33", 8, 32)).toBeNull();
  });
});

describe("DebouncedNumber (review #8)", () => {
  it("does not commit while the field is cleared, and marks it invalid", () => {
    const onCommit = vi.fn();
    render(<DebouncedNumber value={13} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("commits a valid integer on blur", () => {
    const onCommit = vi.fn();
    render(<DebouncedNumber value={13} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(20);
  });

  it("commits a valid integer on Enter (without needing blur)", () => {
    const onCommit = vi.fn();
    render(<DebouncedNumber value={13} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "24" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(24);
  });

  it("rejects an out-of-range or non-integer value and does not commit it", () => {
    const onCommit = vi.fn();
    render(<DebouncedNumber value={13} onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.blur(input);

    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("does not overwrite the field with a server-echoed `value` while the user is still typing", () => {
    // Mirrors the real bug: `settingsStore` optimistically updates, then the server response
    // (a slightly different/normalized value) flows back into `value` while the user is mid-edit.
    function Harness() {
      const [value, setValue] = useState(13);
      return (
        <div>
          <DebouncedNumber value={value} onCommit={() => {}} />
          <button onClick={() => setValue(99)}>simulate-server-echo</button>
        </div>
      );
    }
    render(<Harness />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "21" } });
    // A server echo (or any parent-driven `value` change) arrives while the field is focused.
    fireEvent.click(screen.getByText("simulate-server-echo"));

    expect(input.value).toBe("21");
  });

  it("syncs from `value` once the field loses focus (no stale local echo afterwards)", () => {
    function Harness() {
      const [value, setValue] = useState(13);
      return (
        <div>
          <DebouncedNumber value={value} onCommit={() => {}} />
          <button onClick={() => setValue(99)}>simulate-server-echo</button>
        </div>
      );
    }
    render(<Harness />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "21" } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByText("simulate-server-echo"));

    expect(input.value).toBe("99");
  });
});

describe("DebouncedText (review #8: same focus rule for text inputs)", () => {
  it("does not overwrite local text with a `value` prop change while focused", () => {
    function Harness() {
      const [value, setValue] = useState("Consolas");
      return (
        <div>
          <DebouncedText value={value} onCommit={() => {}} />
          <button onClick={() => setValue("server-echoed-value")}>simulate-server-echo</button>
        </div>
      );
    }
    render(<Harness />);
    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Cascadia" } });
    fireEvent.click(screen.getByText("simulate-server-echo"));

    expect(input.value).toBe("Cascadia");
  });

  it("commits the local value on blur", () => {
    const onCommit = vi.fn();
    render(<DebouncedText value="Consolas" onCommit={onCommit} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Cascadia" } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith("Cascadia");
  });
});
