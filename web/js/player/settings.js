/** One mounted settings surface. Motion never owns values, focus, or page state. */
export function createSettings({ wrap, onActivity }) {
  const panel = document.getElementById("settings-panel");
  const body = document.getElementById("settings-body");
  const opener = document.getElementById("settings-btn");
  const back = document.getElementById("settings-back");
  const heading = document.getElementById("settings-heading");
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
  const isolation = new Map();

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
    body.style.height = "";
    for (const [name, element] of pages) {
      element.hidden = name !== page;
      element.inert = name !== page;
      element.style.cssText = "";
    }
  }
  function bounds() {
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const player = wrap.getBoundingClientRect();
    const mobile = wrap.classList.contains("is-mobile");
    const visibleHeight = Math.min(player.bottom, viewportHeight) - Math.max(player.top, 0);
    panel.style.maxHeight = `${Math.max(120, mobile ? Math.min(520, viewportHeight - 24) : Math.min(520, visibleHeight - 64))}px`;
    panel.setAttribute("aria-modal", String(mobile));
  }
  function settled() {
    panel.dispatchEvent(new CustomEvent("aida:settings-settled", { bubbles: true }));
  }
  function navigate(next, { animate = true, focus = true } = {}) {
    if (!pages.has(next)) return;
    const outgoing = pages.get(page);
    const incoming = pages.get(next);
    const oldHeight = body.getBoundingClientRect().height;
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
    incoming.scrollTop = 0;
    const newHeight = incoming.getBoundingClientRect().height;
    if (animate && outgoing !== incoming && !reduced.matches) {
      // Both pages keep their live nodes; the outgoing page stops accepting input now.
      outgoing.hidden = false;
      outgoing.inert = true;
      Object.assign(outgoing.style, { position: "absolute", inset: "0", width: "100%" });
      const direction = backwards ? -1 : 1;
      const options = { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" };
      pageMotions = [
        outgoing.animate([outgoingStart, { opacity: 0, transform: `translateX(${-12 * direction}px)` }], options),
        incoming.animate([incomingStart ?? { opacity: 0, transform: `translateX(${12 * direction}px)` }, { opacity: 1, transform: "translateX(0)" }], options),
        body.animate([{ height: `${oldHeight}px` }, { height: `${newHeight}px` }], options),
      ];
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
  function show() {
    const token = ++generation;
    const wasHidden = panel.hidden;
    const from = wasHidden ? { opacity: 0, transform: reduced.matches ? "none" : "translateY(16px)" }
      : { opacity: getComputedStyle(panel).opacity, transform: getComputedStyle(panel).transform };
    panelMotion?.cancel();
    open = true;
    panel.hidden = false;
    panel.inert = false;
    panel.dataset.phase = "opening";
    wrap.classList.add("menu-open", "ui-visible", "cursor-visible");
    opener.setAttribute("aria-expanded", "true");
    backdrop.classList.add("open");
    backdrop.hidden = false;
    bounds();
    if (wasHidden) navigate("home", { animate: false, focus: false });
    else {
      // Reversing an exit preserves the page and its painted height.
      const fromHeight = body.getBoundingClientRect().height;
      const toHeight = pages.get(page).getBoundingClientRect().height;
      body.style.height = "";
      const motion = body.animate([{ height: `${fromHeight}px` }, { height: `${toHeight}px` }], {
        duration: reduced.matches ? 100 : 220, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both",
      });
      pageMotions = [motion];
      motion.finished.catch(() => {}).then(() => {
        if (generation === token && pageMotions[0] === motion) cancelPages();
      });
    }
    heading.focus({ preventScroll: true });
    isolate();
    const duration = reduced.matches ? 100 : 280;
    panelMotion = panel.animate([from, { opacity: 1, transform: "translateY(0)" }], { duration, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both" });
    for (const animation of backdrop.getAnimations()) animation.cancel();
    backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduced.matches ? 100 : 180 });
    panelMotion.finished.catch(() => {}).then(() => {
      if (generation !== token || !open) return;
      panelMotion.cancel();
      panelMotion = null;
      panel.dataset.phase = "open";
      settled();
    });
    onActivity();
  }
  function close(restoreFocus = true) {
    if (panel.hidden || (!open && panel.dataset.phase === "closing")) return;
    const token = ++generation;
    const from = { opacity: getComputedStyle(panel).opacity, transform: getComputedStyle(panel).transform };
    panelMotion?.cancel();
    const paintedHeight = body.getBoundingClientRect().height;
    cancelPages();
    body.style.height = `${paintedHeight}px`;
    open = false;
    panel.inert = true;
    panel.dataset.phase = "closing";
    opener.setAttribute("aria-expanded", "false");
    for (const trigger of Object.values(triggers)) trigger.setAttribute("aria-expanded", "false");
    onActivity();
    const duration = reduced.matches ? 100 : 180;
    panelMotion = panel.animate([from, { opacity: 0, transform: reduced.matches ? "none" : "translateY(12px)" }], { duration, easing: "cubic-bezier(.4,0,1,1)", fill: "both" });
    backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration, fill: "forwards" });
    panelMotion.finished.catch(() => {}).then(() => {
      if (token !== generation || open) return;
      panel.hidden = true;
      body.style.height = "";
      panel.dataset.phase = "closed";
      restoreBackground();
      wrap.classList.remove("menu-open");
      onActivity();
      if (restoreFocus) opener.focus({ preventScroll: true });
      panelMotion.cancel();
      panelMotion = null;
      backdrop.classList.remove("open");
      backdrop.hidden = true;
      for (const animation of backdrop.getAnimations()) animation.cancel();
      settled();
    });
  }
  opener.addEventListener("click", event => { event.stopPropagation(); open ? close() : show(); });
  document.getElementById("settings-close").addEventListener("click", () => close());
  back.addEventListener("click", () => {
    const previous = page;
    navigate("home");
    triggers[previous]?.focus({ preventScroll: true });
  });
  for (const [name, trigger] of Object.entries(triggers)) trigger.addEventListener("click", () => navigate(name));
  backdrop.addEventListener("click", () => close());
  panel.addEventListener("click", event => event.stopPropagation());
  panel.addEventListener("aida:setting-change", () => {
    document.getElementById("cc-label").textContent = triggers.cc.classList.contains("active") ? "On" : "Off";
  });
  document.addEventListener("pointerdown", event => {
    suppressClick = false;
    if (open && !panel.contains(event.target) && !opener.contains(event.target)) {
      // Capture dismissal so the same press cannot also play or seek the picture.
      close();
      suppressClick = true;
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
  document.addEventListener("click", event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  panel.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    const items = visibleItems();
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
  for (const element of pages.values()) { element.hidden = true; element.inert = true; }
  return { get isOpen() { return open || panel.dataset.phase === "closing"; }, open: show, close, resize: bounds };
}
