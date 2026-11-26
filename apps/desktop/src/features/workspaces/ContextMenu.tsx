import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Draws a separator line before this item. */
  separatorBefore?: boolean;
  /** Runs onClick but leaves the menu open (the caller swaps the items in place). */
  keepOpen?: boolean;
  /** Destructive action: drawn in the danger ink. */
  danger?: boolean;
  /** Muted second line, meant for disabled items ("why is this off"). */
  hint?: string;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
  /** Open upwards: `y` is the menu's bottom edge (e.g. the top of the button that opened it). */
  above?: boolean;
}

interface ContextMenuProps {
  state: ContextMenuState;
  onClose: () => void;
}

/**
 * Our own right-click menu: the browser's default context menu is already disabled in
 * `App.tsx` (D18); used for file/folder/workspace actions (faz2-spec §6).
 */
export function ContextMenu({ state, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointer = (e: MouseEvent) => {
      const target = e.target as Element | null;
      // The button that toggles this menu closes it with its own click; closing here too would reopen it.
      if (target?.closest?.("[data-menu-toggle]")) return;
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // capture: true on mousedown, so closing does not get ahead of the row's own click handler.
    window.addEventListener("mousedown", handlePointer, true);
    window.addEventListener("keydown", handleKey, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", handlePointer, true);
      window.removeEventListener("keydown", handleKey, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // Keyboard: focus the first enabled item on open (and after a swap), give focus back on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);
  // Callers build items inline and re-render often, so only pull focus back when it is not already in the menu
  // (first open, or after an in-place swap remounted the focused item).
  useEffect(() => {
    if (ref.current?.contains(document.activeElement)) return;
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [state.items]);
  function handleMenuKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Tab") {
      // No focus escape with an open menu: Tab dismisses it (focus returns to where it was).
      e.preventDefault();
      onClose();
      return;
    }
    const enabled = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    if (enabled.length === 0) return;
    const idx = enabled.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (idx + 1) % enabled.length;
    else if (e.key === "ArrowUp") next = (idx <= 0 ? enabled.length : idx) - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = enabled.length - 1;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    enabled[next]?.focus();
  }

  // Keep the menu on screen; re-measure whenever the items change (a swapped submenu has another height).
  const [size, setSize] = useState({ w: 220, h: state.items.length * 26 + 16 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  }, [state.items]);
  const style: CSSProperties = {
    position: "fixed",
    left: Math.max(0, Math.min(state.x, window.innerWidth - size.w - 8)),
    top: Math.max(0, Math.min(state.above ? state.y - size.h : state.y, window.innerHeight - size.h - 8)),
  };

  return (
    <div ref={ref} role="menu" onKeyDown={handleMenuKey} className="z-50 min-w-[200px] rounded border border-border bg-surface-1 py-1 text-xs text-text shadow-lg" style={style}>
      {state.items.map((item, i) => (
        <div key={`${i}:${item.label}`}>
          {item.separatorBefore && <div className="my-1 border-t border-border" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onClick();
              if (!item.keepOpen) onClose();
            }}
            className={`block w-full bg-transparent px-3 py-1 text-left enabled:hover:bg-surface-4 focus-visible:outline-none enabled:focus-visible:bg-surface-4 disabled:opacity-40 ${
              item.danger ? "text-blocked-ink" : ""
            }`}
          >
            {item.label}
            {item.hint && <span className="block text-label text-muted">{item.hint}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}
