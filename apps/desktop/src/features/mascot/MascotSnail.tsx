/**
 * The robot snail (M6, concept B from D-049) as one vector drawing. The art faces right; the
 * state lives on the parent's `data-state` (colours and animations in `mascot.css`), so this
 * component only draws shapes and mirrors them for `direction="left"`.
 */
import type { MascotDirection } from "./mascotState";

/** Cropped around concept B's 200 × 160 box: width = 1.25 × height, foot on the bottom edge. */
export const SNAIL_VIEWBOX = "22 4 172 137.6";
/** Mirror axis for facing left (centre of the view box). */
const FLIP = "translate(216 0) scale(-1 1)";

export function MascotSnail({ direction }: { direction: MascotDirection }) {
  return (
    <svg className="ms-snail" viewBox={SNAIL_VIEWBOX} aria-hidden="true" focusable="false">
      <g transform={direction === "left" ? FLIP : undefined}>
        <g className="ms-hop">
          <circle className="ms-halo" cx="88" cy="80" r="54" />
          <g className="ms-antennas">
            <path className="ln ms-antenna" d="M158 70 L150 42 M170 70 L182 44" />
            <circle className="ms-glow" cx="150" cy="39" r="9" />
            <circle className="ms-glow" cx="182" cy="41" r="9" />
            <circle className="led" cx="150" cy="39" r="5" />
            <circle className="led" cx="182" cy="41" r="5" />
          </g>
          <path className="m2" d="M40 140 a12 12 0 0 1 0 -24 H150 V80 a14 14 0 0 1 28 0 V126 a14 14 0 0 1 -14 14 Z" />
          <g className="ms-ridges" clipPath="url(#ms-foot-clip)">
            <g className="ms-ridges-move">
              {[22, 40, 58, 76, 94, 112, 130, 148].map((x) => (
                <path key={x} className="ms-ridge" d={`M${x} 126 l-6 10`} />
              ))}
            </g>
          </g>
          <rect className="visor" x="156" y="84" width="16" height="6" rx="3" />
          <g className="ms-shell">
            <circle className="m1" cx="88" cy="80" r="48" />
            <path className="sp" d="M88 74 a8 8 0 0 1 8 8 a16 16 0 0 1 -16 16 a24 24 0 0 1 -24 -24 a32 32 0 0 1 32 -32 a40 40 0 0 1 40 40" />
            <circle className="dot" cx="88" cy="36" r="2" />
            <circle className="dot" cx="46" cy="96" r="2" />
            <circle className="dot" cx="122" cy="110" r="2" />
            <circle className="ms-glow ms-core-glow" cx="88" cy="82" r="10" />
            <circle className="led ms-core" cx="88" cy="82" r="5" />
          </g>
        </g>
        <g className="ms-drops">
          <path className="ms-drop ms-drop-1" d="M188 58 c3 5 5 8 5 10.5 a5 5 0 0 1 -10 0 c0 -2.5 2 -5.5 5 -10.5 Z" />
          <path className="ms-drop ms-drop-2" d="M196 78 c2.2 3.6 3.6 5.8 3.6 7.6 a3.6 3.6 0 0 1 -7.2 0 c0 -1.8 1.4 -4 3.6 -7.6 Z" />
        </g>
        <g className="ms-sparkles">
          <path className="ms-sparkle" d="M196 18 l3 8 l8 3 l-8 3 l-3 8 l-3 -8 l-8 -3 l8 -3 Z" />
          <path className="ms-sparkle ms-sparkle-2" d="M130 8 l2 5.5 l5.5 2 l-5.5 2 l-2 5.5 l-2 -5.5 l-5.5 -2 l5.5 -2 Z" />
          <path className="ms-sparkle ms-sparkle-3" d="M30 30 l2 5.5 l5.5 2 l-5.5 2 l-2 5.5 l-2 -5.5 l-5.5 -2 l5.5 -2 Z" />
        </g>
      </g>
      <defs>
        <clipPath id="ms-foot-clip">
          <path d="M40 140 a12 12 0 0 1 0 -24 H150 V140 Z" />
        </clipPath>
      </defs>
    </svg>
  );
}
