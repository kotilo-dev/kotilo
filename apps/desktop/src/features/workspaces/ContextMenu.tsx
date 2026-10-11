import { useEffect, useRef, type CSSProperties } from "react";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Draws a separator line before this item. */
  separatorBefore?: boolean;
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

  // Roughly keep the menu on screen.
  const style: CSSProperties = {
    position: "fixed",
    left: Math.min(state.x, window.innerWidth - 220),
    top: Math.min(state.y, window.innerHeight - state.items.length * 26 - 16),
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
              onClose();
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
