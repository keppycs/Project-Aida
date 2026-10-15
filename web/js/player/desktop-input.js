/**
 * Desktop-only player input: mouse hover/drag on the seek bar, and click-count-based
 * play/pause + fullscreen on #player-wrap. See mobile-input.js for touch equivalents.
 *
 * Every click within CLICK_WINDOW_MS of the previous one increments a counter instead
 * of relying on the browser's native `dblclick` (which races awkwardly against a
 * delayed single-click handler). Once clicks stop arriving, we act once on the final
 * count:
 *   1 click  -> play/pause
 *   2 clicks -> fullscreen only
 *   3 clicks -> fullscreen + play/pause
 * From the 4th click onward (still spamming within the window), fullscreen is done —
 * every extra click just toggles play/pause immediately, no debounce. This lets rapid
 * mashing feel responsive instead of silently eating clicks past the 3rd.
 */
import { isTouchInput } from "./capabilities.js?v=prechat-20261016-dd37ee5";

const CLICK_WINDOW_MS = 200;

function shouldIgnoreSurfaceClick(e) {
  return e.target.closest(
    "#controls, .menu-popup, #progress-wrap, .ctrl-btn, .menu-toggle, .menu-item, .menu-wrap, #big-play, .cc-slider, #menu-backdrop",
  );
}

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

export function bindDesktopVideoInput({ ctx, getProfile, togglePlay, toggleFS }) {
  const { wrap } = ctx;

  let clickCount = 0;
  let resolveTimer = null;

  function resetBurst() {
    clickCount = 0;
    resolveTimer = null;
  }

  function resolveClicks() {
    const count = clickCount;
    resetBurst();
    if (count === 2) {
      toggleFS();
    } else if (count === 3) {
      toggleFS();
      togglePlay();
    } else {
      togglePlay();
    }
  }

  wrap.addEventListener("click", (e) => {
    if (isTouchInput(getProfile())) return;
    if (shouldIgnoreSurfaceClick(e)) return;
    clickCount++;
    clearTimeout(resolveTimer);

    if (clickCount >= 4) {
      togglePlay();
      resolveTimer = setTimeout(resetBurst, CLICK_WINDOW_MS);
      return;
    }

    resolveTimer = setTimeout(resolveClicks, CLICK_WINDOW_MS);
  });
}
