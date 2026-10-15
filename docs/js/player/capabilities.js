/** Layout and chrome hints: one source of truth for responsive player behavior. */
export function getPlayerProfile() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const minDim = Math.min(w, h);
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  /* Compact controls must fit narrow desktop windows as well as phones in landscape. */
  const isMobile = w <= 760 || (coarse && minDim <= 720);
  const hideVolumeChrome = coarse || w < 640;
  return {
    layout: isMobile ? "mobile" : "desktop",
    hideVolumeChrome,
    coarsePointer: coarse,
  };
}

/**
 * Structural check: does the small-screen layout apply (hidden bar buttons, bottom-sheet
 * menus, etc.)? Drives the `is-mobile` class and player-mobile.css.
 */
export function isMobileLayout(profile) {
  return profile.layout === "mobile";
}

/**
 * Input-behavior check: should touch-style interaction win over mouse-style (double-tap
 * seek, touch scrubbing)? Broader than isMobileLayout — also true for a touch-capable
 * desktop/tablet that hasn't dropped into the mobile layout yet.
 */
export function isTouchInput(profile) {
  return profile.layout === "mobile" || profile.coarsePointer;
}

/** Recompute profile on resize / breakpoint changes (classList + volume chrome). */
export function watchProfile(onChange) {
  const handler = () => onChange(getPlayerProfile());
  const compact = window.matchMedia("(max-width: 760px)");
  const pointer = window.matchMedia("(pointer: coarse)");
  compact.addEventListener("change", handler);
  pointer.addEventListener("change", handler);
  window.addEventListener("resize", handler);
  return () => {
    compact.removeEventListener("change", handler);
    pointer.removeEventListener("change", handler);
    window.removeEventListener("resize", handler);
  };
}
