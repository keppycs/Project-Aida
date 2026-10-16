/** Pointer events choose the input behavior; viewport size only chooses composition. */
export function bindProgressInput({ ctx, video, fmt, applyProgress, setDragging, onScrubTo, showUI, beforeScrub }) {
  const { progWrap, timeTip, curTime } = ctx;
  let activePointer = null, resume = false;
  const fraction = event => {
    const bounds = progWrap.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  };
  function preview(event) {
    const bounds = progWrap.getBoundingClientRect();
    const value = fraction(event);
    timeTip.textContent = fmt(value * video.duration);
    timeTip.style.left = `${Math.max(24, Math.min(bounds.width - 24, event.clientX - bounds.left))}px`;
    if (activePointer !== null) { applyProgress(value); curTime.textContent = fmt(value * video.duration); }
  }
  progWrap.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0 || !(video.duration > 0)) return;
    event.preventDefault();
    progWrap.focus({ preventScroll: true });
    activePointer = event.pointerId;
    progWrap.setPointerCapture(activePointer);
    resume = beforeScrub ? beforeScrub() : !video.paused;
    setDragging(true);
    video.pause();
    progWrap.classList.add("scrubbing");
    preview(event);
    showUI();
  });
  progWrap.addEventListener("pointermove", event => {
    if (activePointer !== null && activePointer !== event.pointerId) return;
    if (event.pointerType === "mouse" || activePointer !== null) preview(event);
  });
  function finish(event, cancel) {
    if (event.pointerId !== activePointer) return;
    const pointer = activePointer;
    activePointer = null;
    setDragging(false);
    progWrap.classList.remove("scrubbing");
    if (!cancel) onScrubTo(fraction(event));
    else applyProgress(video.currentTime / video.duration);
    if (progWrap.hasPointerCapture(pointer)) progWrap.releasePointerCapture(pointer);
    if (resume) void video.play().catch(showUI);
    showUI();
  }
  progWrap.addEventListener("pointerup", event => finish(event, false));
  progWrap.addEventListener("pointercancel", event => finish(event, true));
  progWrap.addEventListener("lostpointercapture", event => finish(event, true));
}

export function bindSurfaceInput({ ctx, showUI, hideUI, togglePlay, toggleFS, skip, isMenuOpen }) {
  const ignore = "button, input, a, summary, #controls, #settings-panel, #menu-backdrop, .player-notice";
  let press = null, tap = null, surfaceClickToggled = false, consumedPointerClick = null;
  ctx.wrap.addEventListener("pointerdown", event => {
    const previousPress = press;
    consumedPointerClick = null;
    press = null;
    if (!event.isPrimary) {
      tap = null;
      if (previousPress?.control) consumedPointerClick = previousPress.id;
      return;
    }
    if (event.pointerType === "mouse" || event.button !== 0 || isMenuOpen()) return;
    const control = event.target.closest("#big-play, #fs-btn");
    if (event.target.closest(ignore) && !control) return;
    const fullscreen = document.fullscreenElement === ctx.wrap;
    press = { x: event.clientX, y: event.clientY, id: event.pointerId, fullscreen, control };
  }, true);
  ctx.wrap.addEventListener("pointermove", event => {
    if (event.pointerId === press?.id && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) press.moved = true;
  });
  ctx.wrap.addEventListener("pointercancel", () => { press = null; tap = null; consumedPointerClick = null; });
  ctx.wrap.addEventListener("pointerup", event => {
    if (!press || event.pointerId !== press.id) return;
    const start = press;
    press = null;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (start.moved || Math.hypot(dx, dy) > 12) {
      tap = null;
      if (start.fullscreen || start.control) {
        // Native touch can synthesize a click even after a drag on the center
        // button. Consume it before the button's own playback handler runs.
        consumedPointerClick = event.pointerId;
        event.preventDefault();
        if (start.control !== ctx.fsBtn && start.fullscreen && !isMenuOpen() && document.fullscreenElement === ctx.wrap && dy >= 72 && dy >= Math.abs(dx) * 1.35) {
          // Exit only: a fullscreen change during the gesture must never enter
          // fullscreen again through a toggle or leak into playback/double-tap.
          try { void Promise.resolve(document.exitFullscreen()).catch(() => {}); } catch {}
        }
      }
      return;
    }
    if (isMenuOpen()) return;
    if (start.control) {
      // Chromium can omit the compatibility click on the first fresh tap after
      // exiting fullscreen. The delivered pointer sequence owns this action.
      consumedPointerClick = event.pointerId;
      event.preventDefault();
      const bounds = start.control.getBoundingClientRect();
      if (event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
        start.control === ctx.fsBtn ? toggleFS() : togglePlay();
      }
      return;
    }
    const bounds = ctx.wrap.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const side = x < .35 ? -1 : x > .65 ? 1 : 0;
    if (side && tap?.side === side && performance.now() - tap.time < 300) {
      tap = null;
      skip(side * 10);
      showUI();
    } else {
      tap = { side, time: performance.now() };
      ctx.wrap.classList.contains("ui-visible") ? hideUI() : showUI();
    }
  });
  ctx.wrap.addEventListener("click", event => {
    // Older WebKit compatibility clicks lack a pointer ID. A fresh pointerdown
    // clears the pending sequence; keyboard clicks (detail 0) remain immediate.
    const ownedClick = consumedPointerClick !== null && (event.pointerId === consumedPointerClick
      || (!("pointerId" in event) && event.isTrusted && event.detail > 0));
    if (!ownedClick) return;
    consumedPointerClick = null;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  ctx.wrap.addEventListener("click", event => {
    if (event.pointerType === "touch" || event.pointerType === "pen" || event.sourceCapabilities?.firesTouchEvents) return;
    // Transport feedback can replace the clicked SVG before this event bubbles.
    // The original route still contains its button, even if event.target is detached.
    if (event.defaultPrevented || event.composedPath().some(node => node instanceof Element && node.matches(ignore)) || isMenuOpen()) {
      surfaceClickToggled = false;
      return;
    }
    // First-click transport feedback is immediate; a double-click reverses
    // only this surface's first toggle before entering fullscreen.
    if (event.detail === 2) {
      if (surfaceClickToggled) togglePlay();
      surfaceClickToggled = false;
      toggleFS();
    } else if (event.detail < 2) {
      surfaceClickToggled = event.detail === 1;
      togglePlay();
    }
  });
}
