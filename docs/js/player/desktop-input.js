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
const CLICK_WINDOW_MS = 200;

function shouldIgnoreSurfaceClick(e) {
  return e.target.closest(
    "#controls, .menu-popup, #progress-wrap, .ctrl-btn, .menu-toggle, .menu-item, .menu-wrap, #big-play, .cc-slider, #menu-backdrop, #autoplay-gate, button, input, a",
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
  showUI = () => {},
}) {
  const { progWrap, timeTip, curTime } = ctx;
  let activePointer = null;

  function restoreProgress() {
    const duration = video.duration;
    applyProgress(Number.isFinite(duration) && duration > 0 ? video.currentTime / duration : 0);
    curTime.textContent = fmt(video.currentTime);
    timeTip.textContent = fmt(video.currentTime);
  }

  function preview(e) {
    const frac = getProgressFrac(e);
    const rect = progWrap.getBoundingClientRect();
    timeTip.textContent = fmt(frac * (video.duration || 0));
    timeTip.style.left = `clamp(32px, ${Math.max(0, Math.min(rect.width, e.clientX - rect.left))}px, calc(100% - 32px))`;
    if (activePointer !== null) {
      applyProgress(frac);
      curTime.textContent = timeTip.textContent;
      showUI();
    } else {
      setHoverPreview(frac);
    }
  }

  function finishDrag(e, commit = false) {
    if (activePointer === null || (e && e.pointerId !== activePointer)) return;
    const pointerId = activePointer;
    activePointer = null;
    setDragging(false);
    setHovering(false);
    progWrap.classList.remove("scrubbing");
    clearHoverPreview();
    if (progWrap.hasPointerCapture(pointerId)) progWrap.releasePointerCapture(pointerId);
    if (commit) onScrubTo(getProgressFrac(e));
    else restoreProgress();
    showUI();
  }

  progWrap.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "touch") return;
    setHovering(true);
  });

  progWrap.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "touch") return;
    setHovering(false);
    clearHoverPreview();
    if (!isDragging()) restoreProgress();
  });

  progWrap.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    if (activePointer !== null && e.pointerId !== activePointer) return;
    if (activePointer === null && isDragging()) return;
    preview(e);
  });

  progWrap.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || !e.isPrimary || e.button !== 0 || isDragging()) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    e.preventDefault();
    activePointer = e.pointerId;
    setDragging(true);
    progWrap.classList.add("scrubbing");
    clearHoverPreview();
    progWrap.focus({ preventScroll: true });
    progWrap.setPointerCapture(e.pointerId);
    preview(e);
  });

  progWrap.addEventListener("pointerup", (e) => finishDrag(e, true));
  progWrap.addEventListener("pointercancel", (e) => finishDrag(e));
  progWrap.addEventListener("lostpointercapture", (e) => finishDrag(e));
  window.addEventListener("blur", () => finishDrag());
}

export function bindDesktopVideoInput({ ctx, togglePlay, toggleFS }) {
  const { wrap } = ctx;

  let clickCount = 0;
  let resolveTimer = null;
  let lastPointerType = null;
  let lastTouchTime = 0;

  function resetBurst() {
    clearTimeout(resolveTimer);
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

  wrap.addEventListener("pointerdown", (e) => {
    lastPointerType = e.pointerType;
    if (e.pointerType === "touch") lastTouchTime = Date.now();
    if (e.pointerType === "touch" || shouldIgnoreSurfaceClick(e)) resetBurst();
  });

  wrap.addEventListener("click", (e) => {
    if (e.button !== 0 || e.pointerType === "touch" || e.sourceCapabilities?.firesTouchEvents) return;
    if (!e.pointerType && lastPointerType === "touch" && Date.now() - lastTouchTime < 1000) return;
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
