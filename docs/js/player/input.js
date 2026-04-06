/**
 * Pointer / touch input for scrubbing and video surface (compact vs standard).
 * Desktop: unchanged — click video toggles play; mouse scrubs.
 * Compact / coarse: touch scrub; tap-to-show-UI then tap-to-play on video.
 */

export function bindProgressInteractions({
  ctx,
  getProfile,
  video,
  fmt,
  getProgressFrac,
  applyProgress,
  setDragging,
  isDragging,
  onScrubTo,
  showUI,
}) {
  const { progWrap, timeTip, curTime } = ctx;

  progWrap.addEventListener("mousemove", (e) => {
    timeTip.textContent = fmt(getProgressFrac(e) * (video.duration || 0));
    timeTip.style.left = e.clientX - progWrap.getBoundingClientRect().left + "px";
  });

  progWrap.addEventListener("mousedown", (e) => {
    setDragging(true);
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

export function bindVideoSurfaceInteractions({
  ctx,
  getProfile,
  togglePlay,
  showUI,
  closeAllMenus,
  isAnyMenuOpen,
  video,
  flashSeek,
  showToast,
}) {
  const { wrap } = ctx;

  video.addEventListener("click", (e) => {
    const p = getProfile();
    if (p.layout === "compact" || p.coarsePointer) return;
    togglePlay();
  });

  const SWIPE_THRESHOLD = 10;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchMoved = false;
  let swipeActive = false;
  let swipeStartVol = 0;
  let swipeStartTime = 0;

  wrap.addEventListener(
    "touchstart",
    (e) => {
      const p = getProfile();
      if (p.layout !== "compact" && !p.coarsePointer) return;
      if (e.target.closest("#controls, .menu-popup, #menu-backdrop")) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchMoved = false;
      swipeActive = false;
      swipeStartVol = video.volume;
      swipeStartTime = video.currentTime;
    },
    { passive: true },
  );

  wrap.addEventListener(
    "touchmove",
    (e) => {
      const p = getProfile();
      if (p.layout !== "compact" && !p.coarsePointer) return;
      if (e.target.closest("#controls, .menu-popup, #progress-wrap, .cc-slider, #menu-backdrop"))
        return;
      const dx = e.touches[0].clientX - touchStartX;
      const dy = e.touches[0].clientY - touchStartY;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);

      if (adx > SWIPE_THRESHOLD || ady > SWIPE_THRESHOLD) touchMoved = true;

      if (ady > SWIPE_THRESHOLD && ady > adx * 1.5) {
        e.preventDefault();
        swipeActive = true;
        const rect = wrap.getBoundingClientRect();
        const rightHalf = touchStartX > rect.left + rect.width / 2;

        if (rightHalf) {
          const newVol = Math.max(0, Math.min(1, swipeStartVol + -dy / 200));
          video.volume = newVol;
          showToast(`Volume ${Math.round(newVol * 100)}%`);
        } else {
          const delta = (-dy / 150) * 30;
          const newTime = Math.max(0, Math.min(video.duration, swipeStartTime + delta));
          video.currentTime = newTime;
          const secs = Math.round(Math.abs(delta));
          flashSeek(delta >= 0 ? `+${secs}s` : `−${secs}s`);
        }
        showUI();
      }
    },
    { passive: false },
  );

  wrap.addEventListener(
    "touchend",
    (e) => {
      const p = getProfile();
      if (p.layout !== "compact" && !p.coarsePointer) return;
      if (e.target.closest("#controls, .menu-popup, #progress-wrap, .cc-slider, #menu-backdrop"))
        return;
      if (swipeActive) {
        swipeActive = false;
        showUI();
        return;
      }
      if (touchMoved) {
        showUI();
        return;
      }

      const uiVisible = wrap.classList.contains("ui-visible");
      if (!uiVisible) {
        showUI();
      } else if (isAnyMenuOpen()) {
        closeAllMenus();
        showUI();
      } else {
        togglePlay();
        showUI();
      }
    },
    { passive: true },
  );

  wrap.addEventListener(
    "touchend",
    (e) => {
      const p = getProfile();
      if (p.layout !== "compact" && !p.coarsePointer) return;
      if (e.target.closest(".ctrl-btn, .menu-toggle, .menu-item, .cc-slider")) showUI();
    },
    { passive: true },
  );
}
