/** Visible scroll chrome for an existing native scroll container. */
export function createOverlayScrollbar({ body, thumb, onActivity = () => {}, onHiddenFocus = () => {} }) {
  let enabled = false;
  let destroyed = false;
  let frame = 0;
  let needsMeasure = false;
  let drag = null;
  let metrics = { max: 0, start: 0, travel: 0, height: 0, viewport: 0, line: 16 };
  const observedPages = new Set();
  const document = body.ownerDocument;
  const view = document.defaultView;
  const clamp = (value, max) => Math.max(0, Math.min(max, value));

  // Native scrolling stays mounted. If this module does not initialize, its
  // unmodified native scrollbar remains the fallback.
  body.classList.add("overlay-scrollbar");
  thumb.hidden = true;
  thumb.setAttribute("role", "scrollbar");
  thumb.setAttribute("aria-orientation", "vertical");
  thumb.setAttribute("aria-valuemin", "0");
  thumb.setAttribute("aria-controls", body.id);

  function cancelDrag() {
    if (!drag) return;
    const pointer = drag.pointer;
    drag = null;
    thumb.classList.remove("is-dragging");
    if (thumb.hasPointerCapture(pointer)) thumb.releasePointerCapture(pointer);
  }

  function hide() {
    cancelDrag();
    const focused = document.activeElement === thumb;
    thumb.hidden = true;
    if (focused) onHiddenFocus();
  }

  function paint() {
    if (!enabled || destroyed || metrics.max <= 1 || metrics.travel <= 0) return;
    const scroll = clamp(body.scrollTop, metrics.max);
    const fraction = scroll / metrics.max;
    thumb.style.transform = `translateY(${metrics.start + fraction * metrics.travel}px)`;
    thumb.setAttribute("aria-valuenow", String(Math.round(scroll)));
    thumb.setAttribute("aria-valuetext", `${Math.round(fraction * 100)}%`);
  }

  function measure() {
    if (destroyed || !enabled) return;
    needsMeasure = false;
    // Read endpoints together. Scrolling and dragging only reuse these cached
    // values; transformed menu motion never becomes a per-frame layout read.
    const viewport = body.clientHeight;
    const content = body.scrollHeight;
    const top = body.offsetTop;
    const style = view.getComputedStyle(body);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16;
    const max = Math.max(0, content - viewport);
    const track = Math.max(0, viewport - 8);
    const height = Math.min(track, Math.max(28, track * viewport / Math.max(1, content)));
    const next = { max, start: top + 4, travel: Math.max(0, track - height), height, viewport, line };
    const changed = ["max", "start", "travel", "height"].some(key => Math.abs(next[key] - metrics[key]) > .01);
    metrics = next;
    if (max <= 1 || metrics.travel <= 0) {
      hide();
      return;
    }
    // A viewport/content change invalidates an in-progress drag's mapping.
    if (changed) cancelDrag();
    thumb.style.height = `${height}px`;
    thumb.setAttribute("aria-valuemax", String(Math.round(max)));
    thumb.hidden = false;
    paint();
  }

  function schedule(measureEndpoints = false) {
    if (destroyed || !enabled) return;
    needsMeasure ||= measureEndpoints;
    if (frame) return;
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      if (!enabled || destroyed) return;
      if (needsMeasure) measure();
      else paint();
    });
  }

  function refresh() { schedule(); }

  function setEnabled(value) {
    if (destroyed) return;
    enabled = Boolean(value);
    if (frame) view.cancelAnimationFrame(frame);
    frame = 0;
    needsMeasure = false;
    if (enabled) measure();
    else hide();
  }

  function scrolled() {
    refresh();
    if (enabled) onActivity();
  }

  function pointerDown(event) {
    if (!enabled || thumb.hidden || !event.isPrimary || event.button !== 0 || drag) return;
    measure();
    if (thumb.hidden) return;
    event.preventDefault();
    drag = { pointer: event.pointerId, y: event.clientY, scroll: clamp(body.scrollTop, metrics.max) };
    thumb.classList.add("is-dragging");
    thumb.focus({ preventScroll: true });
    thumb.setPointerCapture(event.pointerId);
    onActivity();
  }

  function pointerMove(event) {
    if (!drag || event.pointerId !== drag.pointer) return;
    event.preventDefault();
    body.scrollTop = clamp(drag.scroll + (event.clientY - drag.y) * metrics.max / metrics.travel, metrics.max);
    refresh();
    onActivity();
  }

  function pointerEnd(event) {
    if (event.pointerId !== drag?.pointer) return;
    cancelDrag();
    onActivity();
  }

  function keyDown(event) {
    if (!enabled || thumb.hidden) return;
    const page = Math.max(40, metrics.viewport - 40);
    const targets = {
      ArrowUp: body.scrollTop - 40,
      ArrowDown: body.scrollTop + 40,
      PageUp: body.scrollTop - page,
      PageDown: body.scrollTop + page,
      Home: 0,
      End: metrics.max,
      " ": body.scrollTop + (event.shiftKey ? -page : page),
    };
    if (!Object.hasOwn(targets, event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    body.scrollTop = clamp(targets[event.key], metrics.max);
    refresh();
    onActivity();
  }

  function clicked(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function wheel(event) {
    if (!enabled || thumb.hidden || !event.deltaY || event.ctrlKey) return;
    // The overlaid sibling cannot naturally send a wheel gesture to the
    // underlying scroller. Redirect only that narrow hit target to the same
    // native scroll position; wheel events over the content are untouched.
    const unit = event.deltaMode === 1 ? metrics.line : event.deltaMode === 2 ? metrics.viewport : 1;
    event.preventDefault();
    event.stopPropagation();
    body.scrollTop += event.deltaY * unit;
    refresh();
    onActivity();
  }

  const resize = new view.ResizeObserver(() => schedule(true));
  function observePages() {
    for (const page of observedPages) {
      if (page.parentElement === body) continue;
      resize.unobserve(page);
      observedPages.delete(page);
    }
    for (const page of body.children) {
      if (observedPages.has(page)) continue;
      observedPages.add(page);
      resize.observe(page);
    }
  }
  resize.observe(body);
  observePages();
  const mutation = new view.MutationObserver(() => {
    observePages();
    schedule(true);
  });
  mutation.observe(body, { childList: true, subtree: true, characterData: true });
  body.addEventListener("scroll", scrolled, { passive: true });
  thumb.addEventListener("pointerdown", pointerDown);
  document.addEventListener("pointermove", pointerMove, { passive: false });
  document.addEventListener("pointerup", pointerEnd);
  document.addEventListener("pointercancel", pointerEnd);
  thumb.addEventListener("lostpointercapture", pointerEnd);
  thumb.addEventListener("keydown", keyDown);
  thumb.addEventListener("click", clicked);
  thumb.addEventListener("wheel", wheel, { passive: false });

  function destroy() {
    if (destroyed) return;
    setEnabled(false);
    destroyed = true;
    resize.disconnect();
    mutation.disconnect();
    body.removeEventListener("scroll", scrolled);
    thumb.removeEventListener("pointerdown", pointerDown);
    document.removeEventListener("pointermove", pointerMove);
    document.removeEventListener("pointerup", pointerEnd);
    document.removeEventListener("pointercancel", pointerEnd);
    thumb.removeEventListener("lostpointercapture", pointerEnd);
    thumb.removeEventListener("keydown", keyDown);
    thumb.removeEventListener("click", clicked);
    thumb.removeEventListener("wheel", wheel);
    body.classList.remove("overlay-scrollbar");
  }

  return { measure, refresh, cancelDrag, setEnabled, destroy };
}
