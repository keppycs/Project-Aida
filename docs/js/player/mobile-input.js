/**
 * Touch player input: drag scrubbing on the seek bar, tap-to-toggle chrome
 * on the video surface, and double-tap left/right to seek ±5s with a ripple overlay.
 * Only the center #big-play control toggles playback on mobile — see desktop-input.js
 * for the click-to-play equivalent. Touch `click` on the video is ignored so we do not
 * double-fire after touchend.
 */
export function bindMobileProgressInput({
  ctx,
  video,
  fmt,
  applyProgress,
  setDragging,
  isDragging,
  onScrubTo,
  showUI,
}) {
  const { progWrap, timeTip, curTime } = ctx;
  let activePointer = null;

  function getFraction(e) {
    const rect = progWrap.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function preview(e) {
    const frac = getFraction(e);
    const rect = progWrap.getBoundingClientRect();
    applyProgress(frac);
    curTime.textContent = fmt(frac * video.duration);
    timeTip.textContent = curTime.textContent;
    timeTip.style.left = `clamp(32px, ${Math.max(0, Math.min(rect.width, e.clientX - rect.left))}px, calc(100% - 32px))`;
    showUI();
  }

  function finishDrag(e, commit = false) {
    if (activePointer === null || (e && e.pointerId !== activePointer)) return;
    const pointerId = activePointer;
    activePointer = null;
    setDragging(false);
    progWrap.classList.remove("scrubbing");
    if (progWrap.hasPointerCapture(pointerId)) progWrap.releasePointerCapture(pointerId);
    if (commit) onScrubTo(getFraction(e));
    else {
      const duration = video.duration;
      applyProgress(Number.isFinite(duration) && duration > 0 ? video.currentTime / duration : 0);
      curTime.textContent = fmt(video.currentTime);
      timeTip.textContent = curTime.textContent;
    }
    showUI();
  }

  progWrap.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || !e.isPrimary || e.button !== 0 || isDragging()) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    e.preventDefault();
    activePointer = e.pointerId;
    setDragging(true);
    progWrap.classList.add("scrubbing");
    progWrap.setPointerCapture(e.pointerId);
    preview(e);
  });

  progWrap.addEventListener("pointermove", (e) => {
    if (e.pointerId !== activePointer) return;
    e.preventDefault();
    preview(e);
  });

  progWrap.addEventListener("pointerup", (e) => finishDrag(e, true));
  progWrap.addEventListener("pointercancel", (e) => finishDrag(e));
  progWrap.addEventListener("lostpointercapture", (e) => finishDrag(e));
  window.addEventListener("blur", () => finishDrag());
}

function isInteractiveTarget(e) {
  return e.target.closest(
    "#controls, .menu-popup, #progress-wrap, #big-play, #autoplay-gate, #menu-backdrop, button, input, a, [role='slider']",
  );
}

export function bindMobileVideoInput({
  ctx,
  skip,
  showUI,
  hideUI,
  closeAllMenus,
  isAnyMenuOpen,
}) {
  const { wrap, seekRippleLeft, seekRippleRight } = ctx;

  const MOVE_PX = 14;
  const DOUBLE_TAP_MS = 300;
  const MAX_TAP_MS = 600;
  const touchPointers = new Set();
  let gesture = null;
  let pendingTap = null;
  let singleTapTimer = null;

  function getTapSide(clientX) {
    const rect = wrap.getBoundingClientRect();
    const x = clientX - rect.left;
    return x < rect.width / 2 ? "left" : "right";
  }

  function flashRipple(side) {
    const el = side === "left" ? seekRippleLeft : seekRippleRight;
    if (!el) return;
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }

  function clearSingleTapTimer() {
    clearTimeout(singleTapTimer);
    singleTapTimer = null;
    pendingTap = null;
  }

  function cancelGesture() {
    gesture = null;
    clearSingleTapTimer();
  }

  function scheduleChromeToggle(tap) {
    clearSingleTapTimer();
    pendingTap = tap;
    singleTapTimer = setTimeout(() => {
      singleTapTimer = null;
      pendingTap = null;
      if (isAnyMenuOpen()) return;
      if (tap.uiWasVisible) hideUI();
      else showUI();
    }, DOUBLE_TAP_MS);
  }

  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") touchPointers.add(e.pointerId);
    if (!wrap.contains(e.target) || isInteractiveTarget(e) || isAnyMenuOpen() || touchPointers.size > 1) {
      cancelGesture();
    }
  }, true);

  wrap.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || !e.isPrimary || touchPointers.size !== 1 || isInteractiveTarget(e)) return;
    gesture = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      startedAt: Date.now(),
      uiWasVisible: wrap.classList.contains("ui-visible"),
      menuWasOpen: isAnyMenuOpen(),
    };
  });

  document.addEventListener("pointermove", (e) => {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    if (Math.abs(e.clientX - gesture.x) > MOVE_PX || Math.abs(e.clientY - gesture.y) > MOVE_PX) {
      cancelGesture();
    }
  }, { passive: true });

  document.addEventListener("pointerup", (e) => {
    touchPointers.delete(e.pointerId);
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const tap = gesture;
    gesture = null;
    if (Date.now() - tap.startedAt > MAX_TAP_MS) {
      clearSingleTapTimer();
      return;
    }
    if (tap.menuWasOpen || isAnyMenuOpen()) {
      clearSingleTapTimer();
      closeAllMenus();
      showUI();
      return;
    }
    const side = getTapSide(e.clientX);
    const now = Date.now();
    if (pendingTap && now - pendingTap.time < DOUBLE_TAP_MS && side === pendingTap.side) {
      clearSingleTapTimer();
      skip(side === "left" ? -5 : 5);
      flashRipple(side);
      return;
    }
    scheduleChromeToggle({ time: now, side, uiWasVisible: tap.uiWasVisible });
  });

  document.addEventListener("pointercancel", (e) => {
    touchPointers.delete(e.pointerId);
    if (!gesture || e.pointerId === gesture.pointerId) cancelGesture();
  });
  window.addEventListener("scroll", cancelGesture, { passive: true, capture: true });
  window.addEventListener("blur", () => {
    touchPointers.clear();
    cancelGesture();
  });
}
