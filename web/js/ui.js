/* Shared disclosure motion and chrome for real native scroll containers. */
(() => {
  "use strict";
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  function createDisclosure({ trigger, panel, flowRoot = panel.parentElement, bind = true, onSettled = () => {} }) {
    let open = !panel.hidden, generation = 0, motions = [], held = new Set();
    const peers = [];
    for (let node = panel; node && node !== flowRoot; node = node.parentElement) {
      for (let next = node.nextElementSibling; next; next = next.nextElementSibling) peers.push(next);
    }
    const stop = () => { for (const motion of motions) motion.cancel(); motions = []; };
    const phase = value => { panel.dataset.phase = value; };
    trigger.setAttribute("aria-expanded", String(open));
    panel.inert = !open;
    phase(open ? "open" : "closed");

    function set(next, immediate = false) {
      if (!immediate && next === open) return;
      const token = ++generation, wasHidden = panel.hidden;
      const style = wasHidden ? null : getComputedStyle(panel);
      const from = style && { opacity: style.opacity, transform: style.transform, clipPath: style.clipPath };
      const painted = peers.map(peer => peer.getBoundingClientRect().top);
      stop();
      open = next;
      trigger.setAttribute("aria-expanded", String(open));
      if (!open && panel.contains(document.activeElement)) trigger.focus({ preventScroll: true });
      panel.inert = !open;
      const finish = () => {
        if (token !== generation) return;
        panel.hidden = !open;
        phase(open ? "open" : "closed");
        stop();
        onSettled(open);
      };
      if (immediate || !open && wasHidden) { finish(); return; }

      // Measure the two flow endpoints once. Only transforms/opacity/clip paint
      // between them; text and controls keep their real, unscaled geometry.
      panel.hidden = true;
      const collapsed = peers.map(peer => peer.getBoundingClientRect().top);
      panel.hidden = false;
      const expanded = peers.map(peer => peer.getBoundingClientRect().top);
      const reduced = reducedMotion.matches;
      const visible = { opacity: 1, transform: "none", clipPath: reduced ? "none" : "inset(0 0 0 0)" };
      const closed = { opacity: 0, transform: reduced ? "none" : "translateY(-6px)", clipPath: reduced ? "none" : "inset(0 0 100% 0)" };
      const start = from || closed;
      if (reduced) { start.transform = "none"; start.clipPath = "none"; }
      const options = { duration: reduced ? 90 : open ? 260 : 200, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" };
      phase(open ? "opening" : "closing");
      motions.push(panel.animate([start, open ? visible : closed], options));
      if (!reduced) peers.forEach((peer, index) => {
        const fromY = painted[index] - expanded[index], toY = open ? 0 : collapsed[index] - expanded[index];
        if (Math.abs(fromY) > .01 || Math.abs(toY) > .01) motions.push(peer.animate([
          { transform: `translateY(${fromY}px)` }, { transform: `translateY(${toY}px)` },
        ], options));
      });
      if (held.size) motions.forEach(motion => motion.pause());
      Promise.all(motions.map(motion => motion.finished)).then(finish, () => {});
    }

    // A newly pressed control must stay under its pointer until release.
    flowRoot.addEventListener("pointerdown", event => {
      held.add(event.pointerId);
      motions.forEach(motion => motion.pause());
    }, true);
    const release = event => {
      held.delete(event.pointerId);
      if (!held.size) motions.forEach(motion => motion.play());
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", () => { held.clear(); motions.forEach(motion => motion.play()); });
    reducedMotion.addEventListener("change", () => { if (motions.length) set(open, true); });
    document.addEventListener("visibilitychange", () => { if (document.hidden && motions.length) set(open, true); });
    window.addEventListener("resize", () => { if (motions.length) set(open, true); });
    if (bind) trigger.addEventListener("click", () => set(!open));
    return { set, get open() { return open; }, settle() { set(open, true); } };
  }

  function createDialog(dialog) {
    let motions = [], generation = 0;
    function transition(open, value = "") {
      const token = ++generation, wasOpen = dialog.open;
      const style = wasOpen ? getComputedStyle(dialog) : null;
      const from = style ? { opacity: style.opacity, transform: style.transform } : { opacity: 0, transform: reducedMotion.matches ? "none" : "translateY(8px)" };
      const backdropFrom = wasOpen ? getComputedStyle(dialog, "::backdrop").opacity : 0;
      motions.forEach(motion => motion.cancel());
      if (open && !wasOpen) dialog.showModal();
      if (!dialog.open) return;
      dialog.dataset.phase = open ? "opening" : "closing";
      dialog.inert = !open;
      if (reducedMotion.matches) from.transform = "none";
      const options = { duration: reducedMotion.matches ? 90 : open ? 200 : 160, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" };
      motions = [dialog.animate([from, { opacity: open ? 1 : 0, transform: reducedMotion.matches || open ? "none" : "translateY(8px)" }], options),
        dialog.animate([{ opacity: backdropFrom }, { opacity: open ? 1 : 0 }], { ...options, pseudoElement: "::backdrop" })];
      Promise.all(motions.map(motion => motion.finished)).then(() => {
        if (token !== generation) return;
        if (!open) dialog.close(value);
        dialog.dataset.phase = open ? "open" : "closed";
        motions.forEach(motion => motion.cancel()); motions = [];
      }, () => {});
    }
    dialog.addEventListener("cancel", event => { event.preventDefault(); transition(false); });
    dialog.querySelector('form[method="dialog"]').addEventListener("submit", event => {
      event.preventDefault(); transition(false, event.submitter?.value || "");
    });
    dialog.addEventListener("pointerdown", () => motions.forEach(motion => motion.pause()), true);
    for (const type of ["pointerup", "pointercancel"]) window.addEventListener(type, () => motions.forEach(motion => motion.play()));
    reducedMotion.addEventListener("change", () => motions.forEach(motion => motion.finish()));
    return { open: () => transition(true) };
  }

  function installScrollbar(port, page = false) {
    const thumb = document.createElement("div");
    thumb.className = `site-scroll-thumb${page ? " site-page-thumb" : ""}`;
    thumb.tabIndex = 0;
    thumb.hidden = true;
    thumb.setAttribute("role", "scrollbar");
    thumb.setAttribute("aria-label", page ? "Page scroll" : "Scroll video message");
    thumb.setAttribute("aria-orientation", "vertical");
    if (!port.id) port.id = "site-page";
    thumb.setAttribute("aria-controls", port.id);
    thumb.setAttribute("aria-valuemin", "0");
    (page ? document.body : port.parentElement).append(thumb);
    let metrics = { range: 0, travel: 0, height: 0, start: 0 }, drag = null, frame = 0, dirty = true;
    const top = () => page ? scrollY : port.scrollTop;
    const write = value => page ? scrollTo(scrollX, value) : (port.scrollTop = value);
    const cancel = () => {
      if (!drag) return;
      const pointer = drag.pointer; drag = null;
      thumb.classList.remove("is-dragging");
      if (thumb.hasPointerCapture(pointer)) thumb.releasePointerCapture(pointer);
    };
    function paint() {
      frame = 0;
      if (dirty) {
        dirty = false;
        const height = page ? innerHeight : port.clientHeight, range = Math.max(0, port.scrollHeight - height);
        const size = Math.min(height, Math.max(44, height * height / Math.max(1, port.scrollHeight)));
        const hidden = port.hidden || !port.getClientRects().length || ["hidden", "clip"].includes(getComputedStyle(port).overflowY);
        const start = page ? 0 : port.offsetTop;
        const next = { range, travel: Math.max(0, height - size), height, start };
        if (Object.keys(next).some(key => next[key] !== metrics[key])) cancel();
        metrics = next;
        const focused = document.activeElement === thumb;
        thumb.hidden = hidden || range < 1 || !metrics.travel;
        if (thumb.hidden && focused) (page ? document.querySelector("main") : port.querySelector("button:not([hidden]), a:not([hidden])"))?.focus({ preventScroll: true });
        thumb.style.height = `${size}px`;
        thumb.setAttribute("aria-valuemax", String(Math.round(range)));
      }
      if (thumb.hidden) return;
      const value = Math.max(0, Math.min(metrics.range, top()));
      thumb.style.transform = `translateY(${metrics.start + metrics.travel * value / metrics.range}px)`;
      thumb.setAttribute("aria-valuenow", String(Math.round(value)));
      thumb.setAttribute("aria-valuetext", `${Math.round(value / metrics.range * 100)}%`);
    }
    const schedule = (measure = false) => { dirty ||= measure; if (!frame) frame = requestAnimationFrame(paint); };
    (page ? window : port).addEventListener("scroll", () => schedule(), { passive: true });
    window.addEventListener("resize", () => schedule(true));
    document.addEventListener("fullscreenchange", () => schedule(true));
    const resize = new ResizeObserver(() => schedule(true));
    resize.observe(port);
    if (page) resize.observe(document.body);
    const mutations = new MutationObserver(() => schedule(true));
    mutations.observe(page ? document.querySelector("main") : port, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "inert"] });
    if (page) mutations.observe(port, { attributes: true, attributeFilter: ["style", "class"] });
    thumb.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !metrics.travel) return;
      event.preventDefault(); event.stopPropagation();
      drag = { pointer: event.pointerId, y: event.clientY, top: top(), ...metrics };
      thumb.focus({ preventScroll: true }); thumb.setPointerCapture(event.pointerId); thumb.classList.add("is-dragging");
    });
    thumb.addEventListener("pointermove", event => {
      if (event.pointerId !== drag?.pointer) return;
      event.preventDefault(); event.stopPropagation();
      write(drag.top + (event.clientY - drag.y) * drag.range / drag.travel);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) thumb.addEventListener(type, event => { if (event.pointerId === drag?.pointer) { event.stopPropagation(); cancel(); } });
    thumb.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); });
    thumb.addEventListener("wheel", event => {
      if (!event.deltaY || event.ctrlKey) return;
      event.preventDefault(); event.stopPropagation();
      write(top() + event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? metrics.height : 1));
    }, { passive: false });
    thumb.addEventListener("keydown", event => {
      const values = { ArrowDown: top() + 40, ArrowUp: top() - 40, PageDown: top() + metrics.height * .8, PageUp: top() - metrics.height * .8, Home: 0, End: metrics.range, " ": top() + metrics.height * .8 * (event.shiftKey ? -1 : 1) };
      if (Object.hasOwn(values, event.key)) { event.preventDefault(); event.stopPropagation(); write(values[event.key]); }
    });
    schedule(true);
  }

  window.AidaUI = { createDisclosure, createDialog };
  function init() {
    document.querySelectorAll("[data-disclosure]").forEach(trigger => createDisclosure({
      trigger, panel: document.getElementById(trigger.getAttribute("aria-controls")), flowRoot: trigger.closest(".videos-section"),
    }));
    if (document.querySelector(".site-main")) {
      installScrollbar(document.documentElement, true);
      document.querySelectorAll(".watch-status").forEach(port => installScrollbar(port));
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
