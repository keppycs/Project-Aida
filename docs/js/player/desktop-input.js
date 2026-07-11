/**
 * Desktop-only player input: mouse hover/drag on the seek bar, and click-to-toggle
 * playback on the video surface. See mobile-input.js for the touch equivalents —
 * both files are bound unconditionally and each guards itself via isTouchInput/
 * isMobileLayout, since the profile (and therefore the active platform) can change
 * live on window resize.
 */
import { isTouchInput } from "./capabilities.js";

export function bindDesktopProgressInput({
  ctx,
  video,
  fmt,
  getProgressFrac,
  applyProgress,
  setHoverPreview,
  clearHoverPreview,
  setDragging,
  isDragging,
  setHovering,
  onScrubTo,
}) {
  const { progWrap, timeTip, curTime } = ctx;

  progWrap.addEventListener("mouseenter", () => setHovering(true));

  progWrap.addEventListener("mouseleave", () => {
    setHovering(false);
    clearHoverPreview();
    if (!isDragging() && video.duration) {
      applyProgress(video.currentTime / video.duration);
    }
  });

  progWrap.addEventListener("mousemove", (e) => {
    const frac = getProgressFrac(e);
    const x = e.clientX - progWrap.getBoundingClientRect().left;
    timeTip.textContent = fmt(frac * (video.duration || 0));
    timeTip.style.left = x + "px";
    if (!isDragging()) setHoverPreview(frac);
  });

  progWrap.addEventListener("mousedown", (e) => {
    setDragging(true);
    clearHoverPreview();
    applyProgress(getProgressFrac(e));
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging()) return;
    applyProgress(getProgressFrac(e));
    curTime.textContent = fmt(getProgressFrac(e) * (video.duration || 0));
  });

  document.addEventListener("mouseup", (e) => {
    if (!isDragging()) return;
    setDragging(false);
    onScrubTo(getProgressFrac(e));
  });
}

export function bindDesktopVideoInput({ ctx, getProfile, togglePlay }) {
  const { video } = ctx;

  video.addEventListener("click", () => {
    if (isTouchInput(getProfile())) return;
    togglePlay();
  });
}
