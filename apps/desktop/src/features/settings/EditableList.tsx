/** Add / remove (and optionally reorder) list; used for agent commands and hidden patterns. */
import { useState } from "react";
import { useStrings } from "../../app/i18n";
import { Button, TextInput } from "./controls";

export function EditableList({
  items,
  onChange,
  reorder,
  addPlaceholder,
  addLabel,
  removeLabel,
  emptyLabel,
  listLabel,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  reorder?: boolean;
  addPlaceholder: string;
  addLabel: string;
  removeLabel: string;
  emptyLabel: string;
  listLabel: string;
}) {
  const s = useStrings();
  const [draft, setDraft] = useState("");

  function submit() {
    const v = draft.trim();
    if (!v) return;
    onChange([...items, v]);
    setDraft("");
  }
  function move(i: number, by: -1 | 1) {
    const j = i + by;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-1.5">
      {items.length === 0 && emptyLabel && <span className="text-small italic text-muted">{emptyLabel}</span>}
      <ul aria-label={listLabel} className="m-0 flex list-none flex-col gap-1.5 p-0">
        {items.map((item, i) => (
          <li key={`${item}-${i}`} className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate rounded-control border border-border-subtle bg-surface-3 px-2 py-1.5 font-mono text-body text-text">{item}</span>
            {reorder && (
              <>
                <Button small variant="ghost" ariaLabel={`${s.settings.agents.moveUp}: ${item}`} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </Button>
                <Button small variant="ghost" ariaLabel={`${s.settings.agents.moveDown}: ${item}`} disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </Button>
              </>
            )}
            <Button small variant="danger" ariaLabel={`${removeLabel}: ${item}`} onClick={() => onChange(items.filter((_, idx) => idx !== i))}>
              {removeLabel}
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <TextInput
            value={draft}
            onChange={setDraft}
            placeholder={addPlaceholder}
            ariaLabel={addPlaceholder}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <Button small variant="primary" onClick={submit}>
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

