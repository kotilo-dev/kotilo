import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MascotView } from "./MascotView";

const ipc = vi.hoisted(() => ({
  onMascotState: vi.fn(),
  mascotReady: vi.fn(),
  mascotClicked: vi.fn(),
  mascotContextMenu: vi.fn(),
  mascotDrag: vi.fn(),
  mascotDragEnd: vi.fn(),
}));
vi.mock("./mascotIpc", () => ipc);

let emit: (payload: unknown) => void = () => {};

describe("MascotView", () => {
  beforeEach(() => {
    for (const fn of Object.values(ipc)) fn.mockReset().mockResolvedValue(undefined);
    ipc.onMascotState.mockImplementation((h: (p: unknown) => void) => {
      emit = (p) => act(() => h(p));
      return Promise.resolve(() => {});
    });
  });

  it("sleeps until the first event, then sends ready and follows mascot:state", async () => {
    const { container } = render(<MascotView />);
    const root = container.querySelector(".mascot")!;
    expect(root).toHaveAttribute("data-state", "sleep");
    expect(root).toHaveAttribute("data-direction", "left");
    expect(root).toHaveStyle({ "--mh": "48px" });
    await act(async () => {});
    expect(ipc.mascotReady).toHaveBeenCalledTimes(1);

    emit({ state: "perm", direction: "right", walking: true, scale: 2, celebrate: false, label: "An agent needs permission" });
    expect(root).toHaveAttribute("data-state", "perm");
    expect(root).toHaveAttribute("data-direction", "right");
    expect(root).toHaveAttribute("data-walking", "false"); // perm never walks
    expect(root).toHaveStyle({ "--mh": "32px" });
    expect(screen.getByRole("img", { name: "An agent needs permission" })).toBeInTheDocument();
    expect(screen.getByTestId("mascot-bubble")).toHaveTextContent("!");

    emit({ state: "work", walking: true });
    expect(root).toHaveAttribute("data-walking", "true");
    expect(screen.queryByTestId("mascot-bubble")).toBeNull();
  });

  it("click, context menu and drag go to Rust", () => {
    render(<MascotView />);
    const snail = screen.getByTestId("mascot-snail");
    fireEvent.pointerDown(snail, { button: 0, pointerId: 1, screenX: 10, screenY: 10 });
    fireEvent.pointerUp(snail, { button: 0, pointerId: 1, screenX: 11, screenY: 10 });
    expect(ipc.mascotClicked).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(snail);
    expect(ipc.mascotContextMenu).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(snail, { button: 0, pointerId: 2, screenX: 10, screenY: 10 });
    fireEvent.pointerMove(snail, { pointerId: 2, screenX: 30, screenY: 10 });
    fireEvent.pointerUp(snail, { button: 0, pointerId: 2, screenX: 35, screenY: 10 });
    expect(ipc.mascotDrag.mock.calls.reduce((sum, [dx]) => sum + (dx as number), 0)).toBe(25);
    expect(ipc.mascotDragEnd).toHaveBeenCalledTimes(1);
    expect(ipc.mascotClicked).toHaveBeenCalledTimes(1);
  });
});
