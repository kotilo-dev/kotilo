/**
 * 0.3.5: pauses CSS animations (spinners, halos) while the window is unfocused or hidden, the
 * same rule as `useAppActive`. A running animation repaints every frame even when nobody is
 * looking; the state stays readable from icon shape and colour. Returns the uninstaller.
 */
export function installMotionPause(root: HTMLElement = document.documentElement): () => void {
  const update = () => {
    const active = document.hasFocus() && document.visibilityState !== "hidden";
    root.toggleAttribute("data-motion-paused", !active);
  };
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  document.addEventListener("visibilitychange", update);
  update();
  return () => {
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", update);
    document.removeEventListener("visibilitychange", update);
    root.removeAttribute("data-motion-paused");
  };
}
