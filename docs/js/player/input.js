/**
 * Desktop: click video toggles play; mouse drags scrub the seek bar.
 * Mobile (compact layout or coarse pointer): tap the video surface toggles chrome
 * (show/hide controls); only the center #big-play control toggles playback. Drag on the
 * seek bar scrubs. Touch `click` on the video is ignored so we do not double-fire after
 * touchend.
 */

export function bindProgressInteractions({
  ctx,
  getProfile,
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
  showUI,
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

  const useTouchScrub = () => {
    const p = getProfile();
    return p.layout === "compact" || p.coarsePointer;
  };

  progWrap.addEventListener(
    "touchstart",
    (e) => {
      if (!useTouchScrub()) return;
      e.preventDefault();
      setDragging(true);
      const rect = progWrap.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width));
      applyProgress(frac);
      showUI();
    },
    { passive: false },
  );

  progWrap.addEventListener(
    "touchmove",
    (e) => {
      if (!useTouchScrub()) return;
      e.preventDefault();
      if (!isDragging()) return;
      const rect = progWrap.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width));
      applyProgress(frac);
      curTime.textContent = fmt(frac * (video.duration || 0));
      timeTip.textContent = fmt(frac * (video.duration || 0));
      timeTip.style.left = e.touches[0].clientX - rect.left + "px";
    },
    { passive: false },
  );

  progWrap.addEventListener("touchend", (e) => {
    if (!useTouchScrub()) return;
    if (!isDragging()) return;
    setDragging(false);
    const rect = progWrap.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.changedTouches[0].clientX - rect.left) / rect.width));
    onScrubTo(frac);
    showUI();
  });

  progWrap.addEventListener("touchcancel", () => {
    if (!useTouchScrub()) return;
    setDragging(false);
  });
}

function isMobileProfile(p) {
  return p.layout === "compact" || p.coarsePointer;
}

/** Keep in sync with `shouldIgnoreMenuDismissClick` in shell.js */
function shouldIgnoreMenuDismissTouch(e) {
  return e.target.closest(
    ".menu-item, .menu-toggle, .cc-slider, .menu-popup input, .menu-popup label, .menu-wrap",
  );
}

export function bindVideoSurfaceInteractions({
  ctx,
  getProfile,
  togglePlay,
  showUI,
  hideUI,
  closeAllMenus,
  isAnyMenuOpen,
}) {
  const { wrap, video } = ctx;

  video.addEventListener("click", () => {
    if (isMobileProfile(getProfile())) return;
    togglePlay();
  });

  const MOVE_PX = 14;
  let sx = 0;
  let sy = 0;
  let moved = false;

  wrap.addEventListener(
    "touchstart",
    (e) => {
      if (!isMobileProfile(getProfile())) return;
      if (e.target.closest("#controls, #autoplay-gate")) return;
      if (e.target.closest(".menu-popup") && shouldIgnoreMenuDismissTouch(e)) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      moved = false;
    },
    { passive: true },
  );

  wrap.addEventListener(
    "touchmove",
    (e) => {
      if (!isMobileProfile(getProfile())) return;
      if (e.target.closest("#controls, .menu-popup, #progress-wrap, .cc-slider, #menu-backdrop")) {
        return;
      }
      const dx = e.touches[0].clientX - sx;
      const dy = e.touches[0].clientY - sy;
      if (Math.abs(dx) > MOVE_PX || Math.abs(dy) > MOVE_PX) moved = true;
    },
    { passive: true },
  );

  wrap.addEventListener(
    "touchend",
    (e) => {
      if (!isMobileProfile(getProfile())) return;
      if (e.target.closest("#autoplay-gate")) return;

      if (isAnyMenuOpen()) {
        if (shouldIgnoreMenuDismissTouch(e)) return;
        closeAllMenus();
        showUI();
        return;
      }

      if (e.target.closest("#controls, .menu-popup, #progress-wrap, .cc-slider, #autoplay-gate")) {
        return;
      }
      if (e.target.closest("#big-play")) return;

      if (moved) {
        showUI();
        return;
      }

      if (wrap.classList.contains("ui-visible")) hideUI();
      else showUI();
    },
    { passive: true },
  );

  wrap.addEventListener(
    "touchend",
    (e) => {
      if (!isMobileProfile(getProfile())) return;
      if (e.target.closest(".ctrl-btn, .menu-toggle, .menu-item, .cc-slider")) showUI();
    },
    { passive: true },
  );
}
