/**
 * Player chrome (overlay UI) decisions that differ between desktop and mobile.
 * Kept as small pure functions so shell.js stays a plain orchestrator instead of
 * branching on profile.layout inline throughout its event handlers.
 */
import { isMobileLayout } from "./capabilities.js?v=progress-hover-removed-v4";

const DESKTOP_AUTO_HIDE_MS = 3000;
const MOBILE_AUTO_HIDE_MS = 2000;

/** Desktop keeps chrome up longer since mouse movement re-triggers it constantly. */
export function getAutoHideDelayMs(profile) {
  return isMobileLayout(profile) ? MOBILE_AUTO_HIDE_MS : DESKTOP_AUTO_HIDE_MS;
}

/**
 * Desktop: big-play is a brief play/pause flash on state change (see shell.js).
 * Mobile: big-play only appears with the chrome overlay; it doubles as the pause
 * button since the bar's own play/pause button is hidden (see player-mobile.css).
 */
export function getBigPlayState(profile, video, uiVisible) {
  if (isMobileLayout(profile)) {
    return { show: uiVisible, showPause: uiVisible && !video.paused };
  }
  return { show: false, showPause: false };
}

/** Mobile menus render as a bottom sheet, dimmed by a full-screen backdrop. */
export function shouldShowMenuBackdrop(profile) {
  return isMobileLayout(profile);
}
