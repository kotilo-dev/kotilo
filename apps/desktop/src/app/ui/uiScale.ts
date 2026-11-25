/**
 * D-081: interface scale. Rust zooms the whole webview (`window.set_zoom`), which multiplies
 * every CSS pixel. Terminal and editor sizes are the user's own, so they are divided by the
 * zoom to land on the size the user asked for.
 */
export const UI_SCALES = [90, 100, 110, 125, 150, 175, 200] as const;
export const DEFAULT_UI_SCALE = 100;

/** Snaps any number to the nearest allowed step (mirrors the Rust side). */
export function snapUiScale(percent: number | undefined): number {
  if (percent === undefined || !Number.isFinite(percent)) return DEFAULT_UI_SCALE;
  return UI_SCALES.reduce((best, s) => (Math.abs(s - percent) < Math.abs(best - percent) ? s : best), UI_SCALES[0] as number);
}

/** The CSS font size that renders as `px` on screen under the given zoom (rounded to 0.5px). */
export function unscaledFontSize(px: number, uiScalePercent: number | undefined): number {
  const scale = (uiScalePercent && uiScalePercent > 0 ? uiScalePercent : DEFAULT_UI_SCALE) / 100;
  return Math.round((px / scale) * 2) / 2;
}

export function nextUiScale(current: number | undefined): number {
  const cur = snapUiScale(current);
  return UI_SCALES.find((s) => s > cur) ?? cur;
}

export function previousUiScale(current: number | undefined): number {
  const cur = snapUiScale(current);
  return [...UI_SCALES].reverse().find((s) => s < cur) ?? cur;
}
