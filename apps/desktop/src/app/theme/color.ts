/**
 * Small colour helpers for the theme derivation (D-057): `#rrggbb` parsing, sRGB mixing,
 * WCAG 2.x relative luminance / contrast ratio and a contrast "nudge". No dependencies.
 */

export type Rgb = [number, number, number];

const HEX = /^#?([0-9a-f]{6})$/i;

export function isHex(value: string): boolean {
  return HEX.test(value.trim());
}

export function parseHex(hex: string): Rgb {
  const match = HEX.exec(hex.trim());
  if (!match) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(match[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: Rgb): string {
  const part = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** `amount` 0 = `a`, 1 = `b` (linear in sRGB, like `color-mix(in srgb, …)`). */
export function mix(a: string, b: string, amount: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex([x[0] + (y[0] - x[0]) * amount, x[1] + (y[1] - x[1]) * amount, x[2] + (y[2] - x[2]) * amount]);
}

/** `rgba(r, g, b, alpha)` in the same notation as index.css. */
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function luminance(hex: string): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * `color` itself when it already reaches `min` against `against`; otherwise mixed step by step
 * toward `toward` (white on dark themes, black on light ones) until it does. Hue is kept as far
 * as possible – only lightness moves.
 */
export function ensureContrast(color: string, against: string, min: number, toward: string): string {
  if (contrast(color, against) >= min) return color;
  for (let step = 1; step <= 25; step++) {
    const candidate = mix(color, toward, step * 0.04);
    if (contrast(candidate, against) >= min) return candidate;
  }
  return toward;
}
