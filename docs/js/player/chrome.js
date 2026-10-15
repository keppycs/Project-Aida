/**
 * Player chrome (overlay UI) decisions that differ between desktop and mobile.
 * Kept as small pure functions so shell.js stays a plain orchestrator instead of
 * branching on profile.layout inline throughout its event handlers.
 */
import { isMobileLayout } from "./capabilities.js";

const DESKTOP_AUTO_HIDE_MS = 3000;
const MOBILE_AUTO_HIDE_MS = 3000;

/** Keep controls visible for a full inactivity window after interaction. */
export function getAutoHideDelayMs(profile) {
  return isMobileLayout(profile) ? MOBILE_AUTO_HIDE_MS : DESKTOP_AUTO_HIDE_MS;
}

/**
 * Desktop: big-play is a brief play/pause flash on state change (see shell.js).
 * Mobile: paused/ended video always exposes Play; playing video exposes Pause
 * with the chrome overlay (the bar's duplicate button is hidden).
 */
export function getBigPlayState(profile, video, uiVisible) {
  if (isMobileLayout(profile)) {
    return { show: uiVisible || video.paused || video.ended, showPause: !video.paused && !video.ended };
  }
  return { show: false, showPause: false };
}

/** Mobile menus render as a bottom sheet, dimmed by a full-screen backdrop. */
export function shouldShowMenuBackdrop(profile) {
  return isMobileLayout(profile);
}
