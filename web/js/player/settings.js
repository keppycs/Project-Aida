import { createOverlayScrollbar } from "./scrollbar.js?v=overlay-scrollbar-v36";

/** One mounted settings surface. Motion never owns values, focus, or page state. */
export function createSettings({ wrap, onActivity }) {
  const panel = document.getElementById("settings-panel");
  const surface = document.getElementById("settings-surface");
  const body = document.getElementById("settings-body");
  const opener = document.getElementById("settings-btn");
  const back = document.getElementById("settings-back");
  const heading = document.getElementById("settings-heading");
  const header = panel.querySelector(".settings-header");
  const backdrop = document.getElementById("menu-backdrop");
  const pages = new Map([
    ["home", document.getElementById("settings-home")],
    ["speed", document.getElementById("speed-menu")],
    ["quality", document.getElementById("quality-menu")],
    ["cc", document.getElementById("cc-menu")],
  ]);
  const titles = { home: "Settings", speed: "Playback speed", quality: "Quality", cc: "Color correction" };
  const triggers = { speed: document.getElementById("speed-btn"), quality: document.getElementById("quality-btn"), cc: document.getElementById("cc-btn") };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let open = false, page = "home", generation = 0, panelMotion, suppressClick = false;
  let pageMotions = [];
  let heldPointer = null;
  let heldMotions = null;
  let heldStart = null;
  let heldMoved = false;
  let heldControl = null;
  let heldPanelMotion = false;
  let heldGeneration = 0;
  let drag = null;
  let lastViewport = null;
  let closeRestoreFocus = true;
  let reopenPointer = null;
  let openerPress = null;
  const isolation = new Map();
  const scrollbar = createOverlayScrollbar({
    body, thumb: document.getElementById("settings-scroll-thumb"), onActivity,
    onHiddenFocus: () => { if (open) heading.focus({ preventScroll: true }); },
  });
  const mobile = () => wrap.classList.contains("is-mobile");
  const pose = element => {
    const style = getComputedStyle(element);
    return { opacity: Number(style.opacity), transform: style.transform };
  };
  const translateY = () => {
    const transform = getComputedStyle(panel).transform;
    return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
  };
  const travel = () => panel.getBoundingClientRect().height;

  function freezePanel() {
    const from = pose(panel);
    panelMotion?.cancel();
    panelMotion = null;
    Object.assign(panel.style, from);
    return from;
  }
  function stopBackdrop() {
    const style = getComputedStyle(backdrop);
    const opacity = backdrop.hidden || style.display === "none" ? 0 : Number(style.opacity);
    for (const animation of backdrop.getAnimations()) animation.cancel();
    backdrop.style.opacity = String(opacity);
    return opacity;
  }
  function fadeBackdrop(target, duration) {
    const from = stopBackdrop();
    if (!mobile()) {
      backdrop.hidden = true;
      backdrop.classList.remove("open");
      return;
    }
    backdrop.hidden = false;
    backdrop.classList.add("open");
    backdrop.animate([{ opacity: from }, { opacity: target }], { duration, fill: "both" });
  }
  function releaseCapture(control, pointer) {
    if (control?.hasPointerCapture(pointer)) control.releasePointerCapture(pointer);
  }
  function clearHeld() {
    const control = heldControl, pointer = heldPointer;
    heldPointer = heldMotions = heldStart = heldControl = null;
    heldPanelMotion = false;
    releaseCapture(control, pointer);
  }
  function clearDrag() {
    if (!drag) return;
    const pointer = drag.pointer;
    drag = null;
    releaseCapture(header, pointer);
  }

  function visibleItems() {
    return [...panel.querySelectorAll("button:not(:disabled), input:not(:disabled), summary, [tabindex='0']")]
      .filter(element => element.getClientRects().length && !element.closest("[inert]"));
  }
  function restoreBackground() {
    for (const [element, value] of isolation) element.inert = value;
    isolation.clear();
  }
  function isolate() {
    restoreBackground();
    if (!wrap.classList.contains("is-mobile")) return;
    let branch = panel;
    while (branch.parentElement && branch !== document.body) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || sibling === backdrop || sibling.matches("script, style, link")) continue;
        isolation.set(sibling, sibling.inert);
        sibling.inert = true;
      }
      branch = branch.parentElement;
    }
  }
  function cancelPages() {
    for (const animation of pageMotions) animation.cancel();
    pageMotions = [];
    panel.style.height = "";
    panel.classList.remove("page-transitioning");
    surface.style.height = "";
    surface.style.transform = "";
    for (const [name, element] of pages) {
      element.hidden = name !== page;
      element.inert = name !== page;
      element.style.cssText = "";
    }
  }
  function visibleHeight() {
    const stage = panel.getBoundingClientRect();
    const painted = surface.getBoundingClientRect();
    return Math.max(0, Math.min(stage.bottom, painted.bottom) - Math.max(stage.top, painted.top));
  }
  function freezePages() {
    // Retain the painted pose while an interrupted page change exits or reverses.
    const poses = [...new Set(pageMotions.map(animation => animation.effect.target))]
      .map(element => {
        const style = getComputedStyle(element);
        return { element, opacity: style.opacity, transform: style.transform };
      });
    for (const animation of pageMotions) animation.cancel();
    pageMotions = [];
    for (const { element, opacity, transform } of poses) {
      element.style.opacity = opacity;
      element.style.transform = transform;
    }
  }
  function bounds() {
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const player = wrap.getBoundingClientRect();
    const isMobile = mobile();
    const viewport = { width: window.innerWidth, height: viewportHeight, mobile: isMobile };
    const resized = lastViewport && (Math.abs(viewport.width - lastViewport.width) > .5
      || Math.abs(viewport.height - lastViewport.height) > .5 || viewport.mobile !== lastViewport.mobile);
    lastViewport = viewport;
    const visibleHeight = Math.min(player.bottom, viewportHeight) - Math.max(player.top, 0);
    // CSS resolves the real safe-area inset against the visual viewport cap.
    const maxHeight = isMobile
      ? `calc(${viewportHeight}px - max(12px, env(safe-area-inset-top)))`
      : `${Math.max(96, Math.min(520, visibleHeight - 64))}px`;
    panel.style.maxHeight = maxHeight;
    panel.style.setProperty("--settings-max-height", maxHeight);
    panel.setAttribute("aria-modal", String(isMobile));
    if (resized && !panel.hidden) {
      scrollbar.setEnabled(false);
      // A resize changes the coordinate space. Settle once into its new bounds,
      // rather than continuing a gesture or keyframe with obsolete endpoints.
      generation += 1;
      clearHeld();
      clearDrag();
      freezePanel();
      cancelPages();
      panel.style.opacity = panel.style.transform = "";
      if (!open) finishClose(closeRestoreFocus);
      else {
        panel.dataset.phase = "open";
        isolate();
        fadeBackdrop(1, 0);
        settled();
      }
    }
  }
  function settled() {
    scrollbar.setEnabled(open && !panel.hidden);
    panel.dispatchEvent(new CustomEvent("aida:settings-settled", { bubbles: true }));
  }
  function navigate(next, { animate = true, focus = true } = {}) {
    if (!pages.has(next)) return;
    scrollbar.setEnabled(false);
    const outgoing = pages.get(page);
    const incoming = pages.get(next);
    const oldHeight = visibleHeight();
    const oldScroll = body.scrollTop;
    const outgoingStyle = getComputedStyle(outgoing);
    const outgoingStart = { opacity: outgoingStyle.opacity, transform: outgoingStyle.transform };
    const incomingStyle = getComputedStyle(incoming);
    const incomingStart = incoming.hidden ? null : { opacity: incomingStyle.opacity, transform: incomingStyle.transform };
    cancelPages();
    const backwards = next === "home";
    page = next;
    for (const [name, trigger] of Object.entries(triggers)) trigger.setAttribute("aria-expanded", String(name === page));
    panel.dataset.page = page;
    heading.textContent = titles[page];
    back.hidden = page === "home";
    for (const [name, element] of pages) {
      element.hidden = name !== page;
      element.inert = name !== page;
    }
    body.scrollTop = outgoing === incoming ? oldScroll : 0;
    const newHeight = surface.getBoundingClientRect().height;
    if (animate && !reduced.matches) {
      // Measure once. A translated, clipped surface morphs the visible height;
      // live text and touch targets are never scaled or laid out on every frame.
      const stageHeight = Math.max(oldHeight, newHeight);
      panel.style.height = `${stageHeight}px`;
      surface.style.height = `${stageHeight}px`;
      panel.classList.add("page-transitioning");
      const direction = backwards ? -1 : 1;
      const options = { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" };
      pageMotions = [
        surface.animate([
          { transform: `translateY(${stageHeight - oldHeight}px)` },
          { transform: `translateY(${stageHeight - newHeight}px)` },
        ], options),
        incoming.animate([incomingStart ?? { opacity: 0, transform: `translateX(${12 * direction}px)` }, { opacity: 1, transform: "translateX(0)" }], options),
      ];
      if (outgoing !== incoming) {
        outgoing.hidden = false;
        outgoing.inert = true;
        Object.assign(outgoing.style, { position: "absolute", top: `${-oldScroll}px`, left: "0", width: "100%" });
        pageMotions.push(outgoing.animate([outgoingStart, { opacity: 0, transform: `translateX(${-12 * direction}px)` }], options));
      }
      const token = generation;
      const motion = pageMotions;
      Promise.allSettled(motion.map(animation => animation.finished)).then(() => {
        if (generation !== token || pageMotions !== motion) return;
        cancelPages();
        settled();
      });
    } else if (animate && outgoing !== incoming) {
      const motion = incoming.animate([{ opacity: .3 }, { opacity: 1 }], { duration: 100 });
      pageMotions = [motion];
      motion.finished.catch(() => {}).then(settled);
    }
    if (focus && open) {
      const preferred = backwards ? triggers[incoming.dataset.returnPage] : incoming.querySelector(".active:not(:disabled)");
      (preferred ?? (backwards ? visibleItems()[0] : back))?.focus({ preventScroll: true });
    }
  }
  function animateOpen(from, duration) {
    const token = generation;
    panel.dataset.phase = "opening";
    Object.assign(panel.style, from);
    const motion = panel.animate([from, { opacity: 1, transform: "translateY(0)" }], {
      duration, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both",
    });
    panelMotion = motion;
    motion.finished.then(() => {
      if (generation !== token || !open || panelMotion !== motion) return;
      panel.style.opacity = panel.style.transform = "";
      motion.cancel();
      panelMotion = null;
      panel.dataset.phase = "open";
      settled();
    }, () => {});
  }
  function resumeOpen() {
    const from = pose(panel);
    const distance = mobile() ? Math.max(1, travel()) : 16;
    const remaining = Math.max(Math.abs(translateY()) / distance, 1 - from.opacity);
    animateOpen(from, reduced.matches ? 100 : Math.max(100, Math.min(280, 280 * remaining)));
  }
  function show() {
    generation += 1;
    const wasHidden = panel.hidden;
    const from = wasHidden ? null : pose(panel);
    clearHeld();
    clearDrag();
    panelMotion?.cancel();
    panelMotion = null;
    open = true;
    panel.hidden = false;
    panel.inert = false;
    panel.dataset.phase = "opening";
    wrap.classList.add("menu-open", "ui-visible", "cursor-visible");
    opener.setAttribute("aria-expanded", "true");
    bounds();
    if (wasHidden) navigate("home", { animate: false, focus: false });
    else navigate(page, { focus: false });
    heading.focus({ preventScroll: true });
    isolate();
    const duration = reduced.matches ? 100 : 280;
    const initial = from ?? { opacity: mobile() && !reduced.matches ? 1 : 0,
      transform: reduced.matches ? "none" : `translateY(${mobile() ? travel() : 16}px)` };
    animateOpen(initial, duration);
    fadeBackdrop(1, reduced.matches ? 100 : 180);
    onActivity();
  }
  function finishClose(restoreFocus) {
    panel.hidden = true;
    cancelPages();
    panel.dataset.phase = "closed";
    restoreBackground();
    wrap.classList.remove("menu-open");
    panel.style.opacity = panel.style.transform = "";
    panelMotion?.cancel();
    panelMotion = null;
    onActivity();
    if (restoreFocus) opener.focus({ preventScroll: true });
    backdrop.classList.remove("open");
    backdrop.hidden = true;
    for (const animation of backdrop.getAnimations()) animation.cancel();
    backdrop.style.opacity = "";
    settled();
  }
  function close(restoreFocus = true) {
    if (panel.hidden || (!open && panel.dataset.phase === "closing")) return;
    scrollbar.setEnabled(false);
    const token = ++generation;
    const from = pose(panel);
    closeRestoreFocus = restoreFocus;
    clearHeld();
    clearDrag();
    panelMotion?.cancel();
    freezePages();
    open = false;
    panel.inert = true;
    panel.dataset.phase = "closing";
    opener.setAttribute("aria-expanded", "false");
    for (const trigger of Object.values(triggers)) trigger.setAttribute("aria-expanded", "false");
    onActivity();
    const duration = reduced.matches ? 100 : 180;
    const to = { opacity: mobile() && !reduced.matches ? 1 : 0,
      transform: reduced.matches ? from.transform : `translateY(${mobile() ? travel() : 12}px)` };
    const motion = panel.animate([from, to], { duration, easing: "cubic-bezier(.4,0,1,1)", fill: "both" });
    panelMotion = motion;
    fadeBackdrop(0, duration);
    motion.finished.then(() => {
      if (token !== generation || open || panelMotion !== motion) return;
      finishClose(restoreFocus);
    }, () => {});
  }
  const toggle = () => open ? close() : show();
  opener.addEventListener("click", event => {
    event.stopPropagation();
    // Touch/pen taps use their delivered pointer sequence. Browsers can omit
    // the compatibility click after a swipe, and keyboard/mouse still use it.
    if (event.pointerType === "touch" || event.pointerType === "pen") return;
    toggle();
  });
  opener.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0
      || (event.pointerType !== "touch" && event.pointerType !== "pen")) return;
    openerPress = { pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  });
  document.addEventListener("pointermove", event => {
    if (event.pointerId !== openerPress?.pointer) return;
    if (Math.hypot(event.clientX - openerPress.x, event.clientY - openerPress.y) > 12) openerPress.moved = true;
  });
  document.addEventListener("pointerup", event => {
    if (event.pointerId !== openerPress?.pointer) return;
    const press = openerPress;
    openerPress = null;
    reopenPointer = event.pointerId;
    const target = opener.getBoundingClientRect();
    if (press.moved || !opener.contains(event.target)
      || event.clientX < target.left || event.clientX > target.right
      || event.clientY < target.top || event.clientY > target.bottom) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggle();
  });
  document.getElementById("settings-close").addEventListener("click", () => close());
  back.addEventListener("click", () => {
    const previous = page;
    navigate("home");
    triggers[previous]?.focus({ preventScroll: true });
  });
  for (const [name, trigger] of Object.entries(triggers)) trigger.addEventListener("click", () => navigate(name));
  backdrop.addEventListener("click", () => close());
  panel.addEventListener("click", event => event.stopPropagation());
  panel.addEventListener("pointerdown", event => {
    const control = event.target.closest("button, input, summary, [role='scrollbar']");
    if (!event.isPrimary || event.button !== 0 || !control) return;
    const movingPanel = panelMotion?.playState === "running";
    const movingPages = panel.classList.contains("page-transitioning")
      || pageMotions.some(animation => animation.playState === "running");
    if (!movingPanel && !movingPages) return;
    generation += 1;
    heldPointer = event.pointerId;
    heldStart = { x: event.clientX, y: event.clientY };
    heldMoved = false;
    heldControl = control;
    heldPanelMotion = movingPanel;
    heldGeneration = generation;
    // Cancelling to the computed pose is synchronous; WAAPI pause() can remain
    // pending on the compositor for another frame and move a pressed target.
    if (movingPanel) freezePanel();
    freezePages();
    heldMotions = movingPages ? pageMotions : null;
    control.setPointerCapture(event.pointerId);
  });
  panel.addEventListener("pointermove", event => {
    if (event.pointerId === heldPointer && Math.hypot(event.clientX - heldStart.x, event.clientY - heldStart.y) > 12) heldMoved = true;
  });
  function releaseMotion(event) {
    if (event.pointerId !== heldPointer) return;
    const motion = heldMotions;
    const resumePanel = heldPanelMotion;
    const token = heldGeneration;
    if (heldMoved) suppressClick = true;
    clearHeld();
    // Native click dispatch completes before motion resumes. If that click
    // navigates or dismisses, it replaces/cancels this exact animation group.
    requestAnimationFrame(() => {
      if (generation !== token || !open) return;
      if (resumePanel) resumeOpen();
      if (motion && pageMotions === motion) navigate(page, { focus: false });
    });
  }
  document.addEventListener("pointerup", releaseMotion);
  document.addEventListener("pointercancel", releaseMotion);
  document.addEventListener("pointercancel", event => {
    if (event.pointerId === openerPress?.pointer) openerPress = null;
    if (event.pointerId !== reopenPointer) return;
    reopenPointer = null;
  });
  document.addEventListener("lostpointercapture", releaseMotion);

  header.addEventListener("pointerdown", event => {
    if (!mobile() || !open || !event.isPrimary || event.button !== 0
      || event.target.closest("button, input, a, summary")) return;
    event.preventDefault();
    event.stopPropagation();
    generation += 1;
    clearHeld();
    const movingPages = panel.classList.contains("page-transitioning")
      || pageMotions.some(animation => animation.playState === "running");
    const from = freezePanel();
    freezePages();
    const offset = Math.max(0, translateY());
    drag = { pointer: event.pointerId, startY: event.clientY, offset, y: offset,
      height: Math.max(1, travel()), backdrop: stopBackdrop(),
      samples: [{ y: event.clientY, time: event.timeStamp }], motions: movingPages ? pageMotions : null, token: generation };
    // A direct manipulation remains fully opaque; only the independent scrim
    // changes strength as the sheet follows the finger.
    panel.style.opacity = "1";
    panel.style.transform = from.transform;
    header.setPointerCapture(event.pointerId);
  });
  header.addEventListener("pointermove", event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    drag.y = Math.max(0, drag.offset + event.clientY - drag.startY);
    panel.style.transform = `translateY(${drag.y}px)`;
    backdrop.style.opacity = String(drag.backdrop * Math.max(0, 1 - (drag.y - drag.offset) / drag.height));
    drag.samples.push({ y: event.clientY, time: event.timeStamp });
    while (drag.samples.length > 2 && drag.samples[1].time < event.timeStamp - 80) drag.samples.shift();
  });
  function finishDrag(event) {
    if (!drag || drag.pointer !== event.pointerId) return;
    const gesture = drag;
    const first = gesture.samples[0], last = gesture.samples.at(-1);
    const elapsed = Math.max(1, event.timeStamp - first.time);
    const velocity = (last.y - first.y) / elapsed;
    const distance = Math.max(0, gesture.y - gesture.offset);
    const dismissed = event.type === "pointerup" && (distance >= Math.min(96, gesture.height * .25)
      || (distance >= 24 && velocity > .6));
    clearDrag();
    if (dismissed) { close(); return; }
    if (!open || generation !== gesture.token) return;
    resumeOpen();
    if (gesture.motions && pageMotions === gesture.motions) navigate(page, { focus: false });
    fadeBackdrop(1, reduced.matches ? 100 : 180);
    onActivity();
  }
  header.addEventListener("pointerup", finishDrag);
  header.addEventListener("pointercancel", finishDrag);
  header.addEventListener("lostpointercapture", finishDrag);
  panel.addEventListener("aida:setting-change", () => {
    document.getElementById("cc-label").textContent = triggers.cc.classList.contains("active") ? "On" : "Off";
  });
  document.addEventListener("pointerdown", event => {
    suppressClick = false;
    reopenPointer = null;
    openerPress = null;
    if (mobile() && !open && panel.dataset.phase === "closing"
      && event.isPrimary && event.button === 0) {
      const target = opener.getBoundingClientRect();
      const stage = panel.getBoundingClientRect(), painted = surface.getBoundingClientRect();
      const sheetCoversPress = event.clientX >= Math.max(stage.left, painted.left)
        && event.clientX <= Math.min(stage.right, painted.right)
        && event.clientY >= Math.max(stage.top, painted.top)
        && event.clientY <= Math.min(stage.bottom, painted.bottom);
      if (event.clientX >= target.left && event.clientX <= target.right
        && event.clientY >= target.top && event.clientY <= target.bottom && !sheetCoversPress) {
        // The fading scrim and inert background still own hit testing until
        // exit completes. Route only a fresh press on the visible opener back
        // into the reversible motion; never release the rest of the page.
        event.preventDefault();
        event.stopImmediatePropagation();
        reopenPointer = event.pointerId;
        show();
        return;
      }
    }
    if (open && !panel.contains(event.target) && !opener.contains(event.target)) {
      // Capture dismissal so the same press cannot also play or seek the picture.
      close();
      suppressClick = true;
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
  document.addEventListener("click", event => {
    // Older WebKit emits a MouseEvent compatibility click without pointer ID.
    // Only a trusted pointer-style click can complete this pending sequence;
    // keyboard clicks have detail 0 and a new pointerdown clears the pending ID.
    const openerClick = reopenPointer !== null && (event.pointerId === reopenPointer
      || (!("pointerId" in event) && event.isTrusted && event.detail > 0));
    if (!suppressClick && !openerClick) return;
    suppressClick = false;
    reopenPointer = null;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  panel.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    // The scrollbar has its own arrow keys; menu arrows still visit options.
    // It remains in the mobile Tab cycle when there is scroll travel.
    const items = visibleItems().filter(element => event.key === "Tab" || element.getAttribute("role") !== "scrollbar");
    const index = items.indexOf(document.activeElement);
    if (event.key === "Tab" && wrap.classList.contains("is-mobile")) {
      if (index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? items.at(-1) : items[0])?.focus({ preventScroll: true });
      }
    } else if (!event.target.matches("input") && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus({ preventScroll: true });
      items[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  });
  panel.hidden = true;
  panel.inert = true;
  panel.dataset.phase = "closed";
  backdrop.hidden = true;
  backdrop.classList.remove("open");
  for (const element of pages.values()) { element.hidden = true; element.inert = true; }
  return { get isOpen() { return open || panel.dataset.phase === "closing"; }, open: show, close, resize: bounds };
}
