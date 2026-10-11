/** §7.10 filter / segment control: options in a `--surface-3` track, the selected one raised. */
export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex gap-1 rounded-card border border-border-subtle bg-surface-3 p-1">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`h-[30px] rounded-control px-3 text-body font-medium transition-colors duration-150 ${
              on ? "bg-surface-selected text-text" : "bg-transparent text-muted hover:text-text-2"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
