/** Pointer events choose the input behavior; viewport size only chooses composition. */
export function bindProgressInput({ ctx, video, fmt, applyProgress, setDragging, onScrubTo, showUI }) {
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
    activePointer = event.pointerId;
    progWrap.setPointerCapture(activePointer);
    resume = !video.paused;
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
  let press = null, tap = null, singleClick;
  ctx.wrap.addEventListener("pointerdown", event => {
    press = null;
    if (event.pointerType === "mouse" || event.target.closest(ignore) || isMenuOpen()) return;
    press = { x: event.clientX, y: event.clientY, id: event.pointerId };
  });
  ctx.wrap.addEventListener("pointercancel", () => { press = null; tap = null; });
  ctx.wrap.addEventListener("pointerup", event => {
    if (!press || event.pointerId !== press.id) return;
    const start = press;
    press = null;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) return;
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
    if (event.pointerType === "touch" || event.pointerType === "pen" || event.sourceCapabilities?.firesTouchEvents) return;
    if (event.defaultPrevented || event.target.closest(ignore) || isMenuOpen()) return;
    clearTimeout(singleClick);
    if (event.detail === 2) toggleFS();
    else if (event.detail < 2) singleClick = setTimeout(togglePlay, 200);
  });
}
