/** Styled native select: same height and surface as the text inputs, theme chevron instead of the OS arrow. */
import { ChevronDownIcon } from "./pageIcons";

export function Select<T extends string>({
  value,
  onChange,
  options,
  id,
  describedBy,
  ariaLabel,
  className = "w-full",
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
  id?: string;
  describedBy?: string;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <span className={`relative inline-flex ${className}`}>
      <select
        id={id}
        value={value}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-9 w-full cursor-pointer appearance-none rounded-control border border-border bg-surface-3 py-0 pl-3 pr-9 text-ui text-text outline-none hover:bg-surface-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-3" />
    </span>
  );
}
