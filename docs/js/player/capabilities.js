/** Layout and chrome hints: one source of truth for responsive player behavior. */
export function getPlayerProfile() {
  const w = window.innerWidth;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const compact = w <= 560 || (coarse && w <= 720);
  const hideVolumeChrome = coarse || w < 640;
  return {
    layout: compact ? "compact" : "standard",
    hideVolumeChrome,
    coarsePointer: coarse,
  };
}

/** Recompute profile on resize / breakpoint changes (classList + volume chrome). */
export function watchProfile(onChange) {
  const handler = () => onChange(getPlayerProfile());
  const mq560 = window.matchMedia("(max-width: 560px)");
  const mq720 = window.matchMedia("(max-width: 720px)");
  mq560.addEventListener("change", handler);
  mq720.addEventListener("change", handler);
  window.addEventListener("resize", handler);
  return () => {
    mq560.removeEventListener("change", handler);
    mq720.removeEventListener("change", handler);
    window.removeEventListener("resize", handler);
  };
}
