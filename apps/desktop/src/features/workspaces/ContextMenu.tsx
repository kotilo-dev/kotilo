import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Draws a separator line before this item. */
  separatorBefore?: boolean;
  /** Runs onClick but leaves the menu open (the caller swaps the items in place). */
  keepOpen?: boolean;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
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

  // Keep the menu on screen; re-measure whenever the items change (a swapped submenu has another height).
  const [size, setSize] = useState({ w: 220, h: state.items.length * 26 + 16 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  }, [state.items]);
  const style: CSSProperties = {
    position: "fixed",
    left: Math.max(0, Math.min(state.x, window.innerWidth - size.w - 8)),
    top: Math.max(0, Math.min(state.y, window.innerHeight - size.h - 8)),
  };

  return (
    <div ref={ref} className="z-50 min-w-[200px] rounded border border-border bg-surface-1 py-1 text-xs text-text shadow-lg" style={style}>
      {state.items.map((item, i) => (
        <div key={i}>
          {item.separatorBefore && <div className="my-1 border-t border-border" />}
          <button
            type="button"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onClick();
              if (!item.keepOpen) onClose();
            }}
            className="block w-full bg-transparent px-3 py-1 text-left enabled:hover:bg-surface-4 disabled:opacity-40"
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
