/**
 * Mascot window state (M6, D-052): the `mascot:state` payload Rust forwards from the main
 * window, its validation, and the static demo state e2e reads from the URL
 * (`?view=mascot&demo=perm&scale=3&direction=left&walking=1&celebrate=1&label=…`).
 */

export const MASCOT_STATES = ["sleep", "done", "work", "sweat", "input", "perm", "error"] as const;
export type MascotStateName = (typeof MASCOT_STATES)[number];
export type MascotDirection = "left" | "right";
export type MascotScale = 2 | 3 | 4;

export interface MascotStatePayload {
  state: MascotStateName;
  direction: MascotDirection;
  walking: boolean;
  scale: MascotScale;
  celebrate: boolean;
  /** Localized accessible name (aria-label). */
  label: string;
}

/** Shown until the first `mascot:state` event arrives. */
export const INITIAL_MASCOT_STATE: MascotStatePayload = {
  state: "sleep",
  direction: "left",
  walking: false,
  scale: 3,
  celebrate: false,
  label: "",
};

/** Snail height in CSS px for a scale (16 × scale); the window is 2H × 2H. */
export function snailHeight(scale: MascotScale): number {
  return 16 * scale;
}

function isState(v: unknown): v is MascotStateName {
  return typeof v === "string" && (MASCOT_STATES as readonly string[]).includes(v);
}

function toScale(v: unknown): MascotScale | null {
  const n = typeof v === "string" ? Number(v) : v;
  return n === 2 || n === 3 || n === 4 ? n : null;
}

function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return null;
}

/**
 * Merges an incoming payload over the previous state field by field: a missing or invalid
 * field keeps the previous value, so a malformed event never blanks the mascot.
 */
export function mergeMascotState(previous: MascotStatePayload, raw: unknown): MascotStatePayload {
  if (typeof raw !== "object" || raw === null) return previous;
  const p = raw as Record<string, unknown>;
  return {
    state: isState(p.state) ? p.state : previous.state,
    direction: p.direction === "left" || p.direction === "right" ? p.direction : previous.direction,
    walking: toBool(p.walking) ?? previous.walking,
    scale: toScale(p.scale) ?? previous.scale,
    celebrate: toBool(p.celebrate) ?? previous.celebrate,
    label: typeof p.label === "string" ? p.label : previous.label,
  };
}

/**
 * Static demo state from the URL, or null without a valid `demo=<state>`. Other params are
 * optional; walking defaults to on for the walking states so a demo shows the walk cycle.
 */
export function parseDemoParams(search: string): MascotStatePayload | null {
  const q = new URLSearchParams(search);
  const state = q.get("demo");
  if (!isState(state)) return null;
  return mergeMascotState(
    { ...INITIAL_MASCOT_STATE, state, walking: state === "work" || state === "sweat", celebrate: true },
    {
      direction: q.get("direction") ?? undefined,
      scale: q.get("scale") ?? undefined,
      walking: q.get("walking") ?? undefined,
      celebrate: q.get("celebrate") ?? undefined,
      label: q.get("label") ?? undefined,
    },
  );
}

/** Which speech bubble a state shows, if any. */
export function bubbleFor(state: MascotStateName): "!" | "?" | null {
  if (state === "perm" || state === "error") return "!";
  if (state === "input") return "?";
  return null;
}
