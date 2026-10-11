/**
 * Single-series vertical bar chart (dataviz skill: one accent series, thin bars with 4px
 * rounded tops anchored to the baseline, a 2px surface gap, recessive grid, mono axis labels,
 * a hover tooltip per bar with a hit target wider than the bar, and a visually hidden table
 * for screen readers). Hand-written SVG; no chart dependency.
 */
import { useEffect, useId, useRef, useState, type RefObject } from "react";

export interface BarDatum {
  key: string;
  /** Axis label (shown for every `labelEvery`-th bar). */
  label: string;
  value: number;
  /** Tooltip text for the value (already formatted; "—" allowed). */
  display: string;
}

const HEIGHT = 180;
const PAD_LEFT = 52;
const PAD_BOTTOM = 22;
const PAD_TOP = 8;

/** A "nice" axis maximum (1, 2, 2.5, 5 × 10^n) at or above `max`. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * exp >= max) return m * exp;
  }
  return 10 * exp;
}

export function BarChart({
  data,
  ariaLabel,
  formatAxis,
  labelEvery = 5,
  width: initialWidth = 720,
}: {
  data: BarDatum[];
  ariaLabel: string;
  formatAxis: (v: number) => string;
  labelEvery?: number;
  width?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box, initialWidth);
  const titleId = useId();
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const plotW = width - PAD_LEFT;
  const plotH = HEIGHT - PAD_BOTTOM - PAD_TOP;
  const slot = data.length > 0 ? plotW / data.length : plotW;
  const barW = Math.max(2, Math.min(18, slot - 2));
  const ticks = [0, max / 2, max];
  const hovered = hover !== null ? data[hover] : undefined;

  return (
    <div ref={box} className="relative w-full">
      <svg
        role="img"
        aria-labelledby={titleId}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        className="block h-[180px] w-full"
        onMouseLeave={() => setHover(null)}
      >
        <title id={titleId}>{ariaLabel}</title>
        {ticks.map((t) => {
          const y = PAD_TOP + plotH - (t / max) * plotH;
          return (
            <g key={t}>
              <line x1={PAD_LEFT} x2={width} y1={y} y2={y} stroke="var(--border)" strokeWidth={1} />
              <text x={PAD_LEFT - 8} y={y + 3} textAnchor="end" className="fill-[var(--text-faint)] font-mono text-label">
                {formatAxis(t)}
              </text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const h = (d.value / max) * plotH;
          const x = PAD_LEFT + i * slot + (slot - barW) / 2;
          const y = PAD_TOP + plotH - h;
          const r = Math.min(4, barW / 2, h);
          return (
            <g key={d.key} onMouseEnter={() => setHover(i)}>
              <rect x={PAD_LEFT + i * slot} y={PAD_TOP} width={slot} height={plotH} fill="transparent" />
              {h > 0 && (
                <path
                  d={`M${x},${y + plotH - (plotH - h)} v${-(h - r)} q0,${-r} ${r},${-r} h${barW - 2 * r} q${r},0 ${r},${r} v${h - r} z`}
                  className={hover === i ? "fill-[var(--accent)]" : "fill-[color-mix(in_srgb,var(--accent)_75%,transparent)]"}
                />
              )}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={HEIGHT - 6} textAnchor="middle" className="fill-[var(--text-faint)] font-mono text-label">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hovered && hover !== null && (
        <div
          role="tooltip"
          className="pointer-events-none absolute top-0 z-10 rounded-control border border-border bg-surface-4 px-2.5 py-1.5 text-small shadow-float"
          style={{ left: `${((PAD_LEFT + (hover + 0.5) * slot) / width) * 100}%`, transform: "translateX(-50%)" }}
        >
          <div className="text-muted">{hovered.label}</div>
          <div className="font-mono text-text">{hovered.display}</div>
        </div>
      )}
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.key}>
              <th scope="row">{d.label}</th>
              <td>{d.display}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The element's pixel width (so SVG text isn't stretched); `fallback` where ResizeObserver is missing. */
function useWidth(ref: RefObject<HTMLDivElement | null>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
