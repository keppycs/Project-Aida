import { getPlayerProfile, watchProfile, isMobileLayout } from "./capabilities.js";
import {
  initPlayback, applyCcSliderChange, setCcEnabled, markCcBannerMenuUsed,
  loadPlayerPrefs, persistPlaybackPrefs,
} from "./engine.js";
import { getAutoHideDelayMs, getBigPlayState, shouldShowMenuBackdrop } from "./chrome.js";
import { bindDesktopProgressInput, bindDesktopVideoInput } from "./desktop-input.js";
import { bindMobileProgressInput, bindMobileVideoInput } from "./mobile-input.js";

function collectContext() {
  const wrap = document.getElementById("player-wrap");
  return {
    wrap,
    video: document.getElementById("video"),
    bigPlay: document.getElementById("big-play"),
    spinner: document.getElementById("spinner"),
    seekFlash: document.getElementById("seek-flash"),
    seekRippleLeft: document.getElementById("seek-ripple-left"),
    seekRippleRight: document.getElementById("seek-ripple-right"),
    kbToast: document.getElementById("kb-toast"),
    playBtn: document.getElementById("play-btn"),
    playIcon: document.getElementById("play-icon"),
    muteBtn: document.getElementById("mute-btn"),
    volSlider: document.getElementById("vol-slider"),
    volCluster: document.getElementById("vol-cluster"),
    backBtn: document.getElementById("back-btn"),
    fwdBtn: document.getElementById("fwd-btn"),
    curTime: document.getElementById("cur-time"),
    durTime: document.getElementById("dur-time"),
    fsBtn: document.getElementById("fs-btn"),
    fsIcon: document.getElementById("fs-icon"),
    progWrap: document.getElementById("progress-wrap"),
    progFill: document.getElementById("progress-fill"),
    progHover: document.getElementById("progress-hover"),
    progBuf: document.getElementById("progress-buffer"),
    progThumb: document.getElementById("progress-thumb"),
    timeTip: document.getElementById("time-tooltip"),
    qualBtn: document.getElementById("quality-btn"),
    qualMenu: document.getElementById("quality-menu"),
    qualLabel: document.getElementById("quality-label"),
    speedBtn: document.getElementById("speed-btn"),
    speedMenu: document.getElementById("speed-menu"),
    hdrBadge: document.getElementById("hdr-badge"),
    codecBadge: document.getElementById("codec-badge"),
    protocolBadge: document.getElementById("protocol-badge"),
    titleText: document.getElementById("title-text"),
    ccWrap: document.getElementById("cc-wrap"),
    ccBtn: document.getElementById("cc-btn"),
    ccMenu: document.getElementById("cc-menu"),
    ccOff: document.getElementById("cc-off"),
    ccOn: document.getElementById("cc-on"),
    ccBrightness: document.getElementById("cc-brightness"),
    ccContrast: document.getElementById("cc-contrast"),
    ccSaturation: document.getElementById("cc-saturation"),
    ccBrightnessVal: document.getElementById("cc-brightness-val"),
    ccContrastVal: document.getElementById("cc-contrast-val"),
    ccSaturationVal: document.getElementById("cc-saturation-val"),
    menuBackdrop: document.getElementById("menu-backdrop"),
  };
}

function fmt(s) {
  s = Number.isFinite(s) ? Math.max(0, Math.floor(s)) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

const PLAY_SVG = '<polygon points="5,3 19,12 5,21"/>';
const PAUSE_SVG =
  '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';

const BIG_PLAY_SVG_CIRCLE = '<circle cx="36" cy="36" r="35" fill="rgba(0,0,0,.55)"/>';
const BIG_PLAY_SVG_PLAY = `${BIG_PLAY_SVG_CIRCLE}<path d="M26.5 21.5 L52.5 36 L26.5 50.5 Z" fill="rgba(255,255,255,0.88)"/>`;
const BIG_PLAY_SVG_PAUSE = `${BIG_PLAY_SVG_CIRCLE}<rect x="24" y="22" width="9" height="28" rx="2.5" fill="rgba(255,255,255,0.88)"/><rect x="39" y="22" width="9" height="28" rx="2.5" fill="rgba(255,255,255,0.88)"/>`;

const VOL_FULL = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
  <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>`;
const VOL_MUTE = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
  <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>`;
const VOL_LOW = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>`;

const FS_ENTER = `<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
  <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>`;
const FS_EXIT = `<polyline points="4 14 10 14 10 20"/><polyline points="20 4 14 4 14 10"/>
  <line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>`;

function applyLayoutClass(wrap, profile) {
  wrap.classList.toggle("is-mobile", isMobileLayout(profile));
  wrap.dataset.layout = profile.layout;
}

export async function mountPlayer(meta, base) {
  const ctx = collectContext();
  let profile = getPlayerProfile();
  const getProfile = () => profile;
  applyLayoutClass(ctx.wrap, profile);

  let uiTimer;
  let bigPlayFlashTimer;
  let isDragging = false;
  let isHovering = false;
  let hasStarted = false;

  const { wrap, video, bigPlay, seekFlash, kbToast, playBtn, playIcon } = ctx;
  const {
    muteBtn,
    volSlider,
    backBtn,
    fwdBtn,
    curTime,
    durTime,
    fsBtn,
    fsIcon,
    progWrap,
    progFill,
    progHover,
    progBuf,
    progThumb,
    qualMenu,
    speedMenu,
    ccMenu,
    menuBackdrop,
  } = ctx;

  const menus = [
    { menu: qualMenu, button: ctx.qualBtn },
    { menu: speedMenu, button: ctx.speedBtn },
    { menu: ccMenu, button: ctx.ccBtn },
  ];
  menus.forEach(({ menu, button }) => {
    menu.hidden = true;
    menu.inert = true;
    button.setAttribute("aria-controls", menu.id);
    button.setAttribute("aria-expanded", "false");
  });

  function setDragging(v) {
    isDragging = v;
  }
  function getDragging() {
    return isDragging;
  }
  function setHovering(v) {
    isHovering = v;
  }

  function getProgressFrac(e) {
    const rect = progWrap.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function applyProgress(frac) {
    const w = progWrap.getBoundingClientRect().width;
    progFill.style.width = frac * 100 + "%";
    progThumb.style.left = frac * w + "px";
    progThumb.style.right = "auto";
  }

  function syncProgressAccessibility() {
    const duration = Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0;
    const time = Number.isFinite(video.currentTime) ? Math.min(duration, video.currentTime) : 0;
    progWrap.setAttribute("aria-valuemax", String(Math.round(duration)));
    progWrap.setAttribute("aria-valuenow", String(Math.round(time)));
    progWrap.setAttribute("aria-valuetext", `${fmt(time)} of ${fmt(duration)}`);
    progWrap.setAttribute("aria-disabled", String(!duration));
  }

  function seekTo(time) {
    if (!Number.isFinite(video.duration) || !video.duration) return;
    video.currentTime = Math.max(0, Math.min(video.duration, time));
    applyProgress(video.currentTime / video.duration);
    curTime.textContent = fmt(video.currentTime);
    syncProgressAccessibility();
  }

  function setHoverPreview(frac) {
    progHover.style.width = frac * 100 + "%";
  }

  function clearHoverPreview() {
    progHover.style.width = "0%";
  }

  function isAnyMenuOpen() {
    return (
      qualMenu.classList.contains("open") ||
      speedMenu.classList.contains("open") ||
      ccMenu.classList.contains("open")
    );
  }

  function closeAllMenus(restoreFocus = false) {
    const open = menus.find(({ menu }) => menu.classList.contains("open"));
    const focusInMenu = open?.menu.contains(document.activeElement);
    if ((restoreFocus || focusInMenu) && open) open.button.focus();
    menus.forEach(({ menu, button }) => {
      menu.classList.remove("open");
      menu.hidden = true;
      menu.inert = true;
      button.setAttribute("aria-expanded", "false");
    });
    menuBackdrop?.classList.remove("open");
    wrap.classList.remove("menu-open");
    syncBigPlayOverlay();
  }

  function toggleMenu(menu, focusMenu = false) {
    const isOpen = menu.classList.contains("open");
    closeAllMenus();
    if (!isOpen) {
      updateMenuBounds();
      menu.hidden = false;
      menu.inert = false;
      menu.classList.add("open");
      menus.find((entry) => entry.menu === menu).button.setAttribute("aria-expanded", "true");
      wrap.classList.add("menu-open");
      if (shouldShowMenuBackdrop(getProfile())) menuBackdrop?.classList.add("open");
      requestAnimationFrame(() => {
        if (!menu.classList.contains("open")) return;
        menu.scrollTop = 0;
        if (focusMenu || isMobileLayout(getProfile())) {
          menu.querySelector(".active:not(:disabled), button:not(:disabled), input")?.focus();
        }
      });
      showUI();
    }
  }

  function updateMenuBounds() {
    const controlHeight = document.getElementById("controls").getBoundingClientRect().height;
    wrap.style.setProperty("--menu-max-height", `${Math.max(120, wrap.getBoundingClientRect().height - controlHeight - 16)}px`);
  }

  function focusableMenuItems(menu) {
    return [...menu.querySelectorAll("button:not(:disabled), input:not(:disabled), [tabindex='0']")];
  }

  menus.forEach(({ menu, button }) => {
    button.addEventListener("keydown", (e) => {
      if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
      e.preventDefault();
      if (!menu.classList.contains("open")) toggleMenu(menu);
      const items = focusableMenuItems(menu);
      (e.key === "ArrowUp" ? items.at(-1) : items[0])?.focus();
    });
    menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeAllMenus(true);
        return;
      }
      const items = focusableMenuItems(menu);
      const index = items.indexOf(document.activeElement);
      if (e.key === "Tab" && isMobileLayout(getProfile())) {
        if ((e.shiftKey && index === 0) || (!e.shiftKey && index === items.length - 1)) {
          e.preventDefault();
          (e.shiftKey ? items.at(-1) : items[0])?.focus();
        }
        return;
      }
      if (e.target.matches("input")) return;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1
        : (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    });
  });

  function cleanupBigPlayFlash() {
    const svg = bigPlay.querySelector("svg");
    clearTimeout(bigPlayFlashTimer);
    bigPlayFlashTimer = null;
    if (document.activeElement === bigPlay) wrap.focus({ preventScroll: true });
    bigPlay.classList.remove("show", "flash-brief");
    bigPlay.tabIndex = -1;
    bigPlay.setAttribute("aria-hidden", "true");
    if (svg) svg.style.animation = "none";
  }

  function flashBigPlayOverlay(playing) {
    if (isMobileLayout(getProfile())) return;
    const svg = bigPlay.querySelector("svg");
    if (!svg) return;

    cleanupBigPlayFlash();
    svg.style.animation = "none";
    void svg.offsetWidth;

    svg.innerHTML = playing ? BIG_PLAY_SVG_PAUSE : BIG_PLAY_SVG_PLAY;
    bigPlay.classList.add("show", "flash-brief");
    bigPlay.tabIndex = -1;
    bigPlay.setAttribute("aria-hidden", "true");
    svg.style.removeProperty("animation");

    const onEnd = (e) => {
      if (e.target !== svg || e.animationName !== "big-play-flash") return;
      svg.removeEventListener("animationend", onEnd);
      cleanupBigPlayFlash();
    };
    svg.addEventListener("animationend", onEnd);
    bigPlayFlashTimer = setTimeout(() => {
      svg.removeEventListener("animationend", onEnd);
      cleanupBigPlayFlash();
    }, 950);
  }

  function syncBigPlayOverlay() {
    const svg = bigPlay.querySelector("svg");
    if (!svg) return;
    if (!hasStarted) {
      const visible = !isAnyMenuOpen();
      bigPlay.classList.add("initial-play");
      bigPlay.classList.toggle("show", visible);
      bigPlay.tabIndex = visible ? 0 : -1;
      bigPlay.setAttribute("aria-hidden", String(!visible));
      bigPlay.setAttribute("aria-label", "Play video");
      svg.innerHTML = BIG_PLAY_SVG_PLAY;
      return;
    }
    bigPlay.classList.remove("initial-play");
    if (!isMobileLayout(getProfile())) {
      if (!bigPlay.classList.contains("flash-brief")) bigPlay.classList.remove("show");
      if (document.activeElement === bigPlay) wrap.focus({ preventScroll: true });
      bigPlay.tabIndex = -1;
      bigPlay.setAttribute("aria-hidden", "true");
      return;
    }
    const { show, showPause } = getBigPlayState(
      getProfile(),
      video,
      wrap.classList.contains("ui-visible"),
    );
    const visible = show && !isAnyMenuOpen();
    if (!visible && document.activeElement === bigPlay) wrap.focus({ preventScroll: true });
    bigPlay.classList.toggle("show", visible);
    bigPlay.tabIndex = visible ? 0 : -1;
    bigPlay.setAttribute("aria-hidden", String(!visible));
    bigPlay.setAttribute("aria-label", showPause ? "Pause video" : "Play video");
    svg.innerHTML = showPause ? BIG_PLAY_SVG_PAUSE : BIG_PLAY_SVG_PLAY;
  }

  function showUI() {
    wrap.classList.add("ui-visible", "cursor-visible");
    clearTimeout(uiTimer);
    if (!video.paused) uiTimer = setTimeout(hideUI, getAutoHideDelayMs(getProfile()));
    syncBigPlayOverlay();
  }

  function hideUI() {
    clearTimeout(uiTimer);
    if (isAnyMenuOpen()) return;
    if (wrap.contains(document.activeElement) && document.activeElement.matches(":focus-visible")) return;
    wrap.classList.remove("ui-visible", "cursor-visible");
    syncBigPlayOverlay();
  }

  function showToast(msg) {
    kbToast.textContent = msg;
    kbToast.classList.remove("show");
    void kbToast.offsetWidth;
    kbToast.classList.add("show");
  }

  function flashSeek(txt) {
    seekFlash.textContent = txt;
    seekFlash.classList.remove("flash");
    void seekFlash.offsetWidth;
    seekFlash.classList.add("flash");
  }

  function setPlayIcon(playing) {
    playIcon.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
    playBtn.setAttribute("aria-label", playing ? "Pause video" : "Play video");
    playBtn.title = playing ? "Pause (k)" : "Play (k)";
  }

  function togglePlay() {
    const willPlay = video.paused;
    if (willPlay) {
      void video.play().catch((error) => {
        console.error("Playback did not start", error);
        showToast("Press play to try again");
        showUI();
      });
    }
    else video.pause();
    if (hasStarted && !isMobileLayout(getProfile())) flashBigPlayOverlay(willPlay);
  }

  function skip(sec) {
    if (!Number.isFinite(video.duration) || !video.duration) return;
    seekTo(video.currentTime + sec);
    flashSeek(sec > 0 ? `+${sec}s` : `${sec}s`);
  }

  function updateVolIcon() {
    const v = video.volume;
    const m = video.muted;
    muteBtn.setAttribute("aria-label", m || v === 0 ? "Unmute" : "Mute");
    muteBtn.title = m || v === 0 ? "Unmute (m)" : "Mute (m)";
    volSlider.setAttribute("aria-valuetext", m ? "Muted" : `${Math.round(v * 100)} percent`);
    document.getElementById("vol-icon").innerHTML =
      m || v === 0 ? VOL_MUTE
      : v < 0.5 ? VOL_LOW
      : VOL_FULL;
  }

  function toggleMute() {
    if (video.muted || video.volume === 0) {
      if (video.volume === 0) video.volume = 0.5;
      video.muted = false;
    } else video.muted = true;
    updateVolIcon();
  }

  let fsTransitionPending = false;
  if (typeof wrap.requestFullscreen !== "function" && typeof video.webkitEnterFullscreen !== "function") {
    fsBtn.hidden = true;
    fsBtn.style.display = "none";
  }

  function toggleFS() {
    if (fsTransitionPending) return;
    if (!document.fullscreenElement && typeof wrap.requestFullscreen !== "function") {
      try {
        if (typeof video.webkitEnterFullscreen === "function") video.webkitEnterFullscreen();
        else showToast("Fullscreen is not supported on this device");
      } catch {
        showToast("Fullscreen is not available right now");
      }
      return;
    }
    fsTransitionPending = true;
    const settle = () => {
      fsTransitionPending = false;
    };
    try {
      const req = !document.fullscreenElement ? wrap.requestFullscreen() : document.exitFullscreen();
      Promise.resolve(req).then(settle, () => {
        settle();
        showToast("Fullscreen is not available right now");
      });
    } catch {
      settle();
      showToast("Fullscreen is not available right now");
    }
  }

  showUI();
  syncProgressAccessibility();
  syncBigPlayOverlay();

  watchProfile((next) => {
    profile = next;
    applyLayoutClass(wrap, profile);
    updateMenuBounds();
    syncBigPlayOverlay();
    if (profile.hideVolumeChrome) {
      ctx.volCluster.style.display = "none";
      video.volume = 1;
    } else {
      ctx.volCluster.style.display = "";
      video.volume = loadPlayerPrefs()?.volume ?? 0.5;
    }
    closeAllMenus();
  });

  video.addEventListener("play", () => {
    const firstPlay = !hasStarted;
    hasStarted = true;
    if (firstPlay && !isMobileLayout(getProfile())) flashBigPlayOverlay(true);
    setPlayIcon(true);
    if (isMobileLayout(getProfile())) {
      if (wrap.classList.contains("ui-visible")) {
        clearTimeout(uiTimer);
        uiTimer = setTimeout(hideUI, getAutoHideDelayMs(getProfile()));
      }
    } else {
      clearTimeout(uiTimer);
      uiTimer = setTimeout(hideUI, getAutoHideDelayMs(getProfile()));
    }
    syncBigPlayOverlay();
  });
  video.addEventListener("pause", () => {
    setPlayIcon(false);
    if (isMobileLayout(getProfile())) {
      hideUI();
    } else {
      showUI();
    }
    syncBigPlayOverlay();
  });
  video.addEventListener("ended", () => {
    setPlayIcon(false);
    if (isMobileLayout(getProfile())) hideUI();
    else showUI();
    syncBigPlayOverlay();
  });

  playBtn.addEventListener("click", () => {
    togglePlay();
  });
  bigPlay.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePlay();
  });

  muteBtn.addEventListener("click", toggleMute);
  volSlider.addEventListener("input", () => {
    video.volume = parseFloat(volSlider.value);
    video.muted = video.volume === 0;
    updateVolIcon();
  });
  video.addEventListener("volumechange", () => {
    volSlider.value = video.muted ? 0 : video.volume;
    updateVolIcon();
    persistPlaybackPrefs({
      ...(getProfile().hideVolumeChrome ? {} : { volume: video.volume }),
      muted: video.muted,
    });
  });

  video.addEventListener("timeupdate", () => {
    syncProgressAccessibility();
    if (isDragging || isHovering || !video.duration) return;
    applyProgress(video.currentTime / video.duration);
    curTime.textContent = fmt(video.currentTime);
    if (video.buffered.length) {
      progBuf.style.width =
        (video.buffered.end(video.buffered.length - 1) / video.duration) * 100 + "%";
    }
  });

  video.addEventListener("loadedmetadata", () => {
    durTime.textContent = fmt(video.duration);
    syncProgressAccessibility();
  });
  video.addEventListener("durationchange", syncProgressAccessibility);
  video.addEventListener("seeked", syncProgressAccessibility);

  const onScrubTo = (frac) => {
    seekTo(frac * video.duration);
  };

  progWrap.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const duration = video.duration;
    if (!Number.isFinite(duration) || !duration) return;
    let target;
    switch (e.key) {
      case "ArrowLeft": case "ArrowDown": target = video.currentTime - 5; break;
      case "ArrowRight": case "ArrowUp": target = video.currentTime + 5; break;
      case "PageDown": target = video.currentTime - duration / 10; break;
      case "PageUp": target = video.currentTime + duration / 10; break;
      case "Home": target = 0; break;
      case "End": target = duration; break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    seekTo(target);
    showUI();
  });

  bindDesktopProgressInput({
    ctx,
    video,
    fmt,
    getProgressFrac,
    applyProgress,
    setHoverPreview,
    clearHoverPreview,
    setDragging,
    isDragging: getDragging,
    setHovering,
    onScrubTo,
  });
  bindDesktopVideoInput({ ctx, getProfile, togglePlay, toggleFS });

  bindMobileProgressInput({
    ctx,
    getProfile,
    video,
    fmt,
    applyProgress,
    setDragging,
    isDragging: getDragging,
    onScrubTo,
    showUI,
  });
  bindMobileVideoInput({
    ctx,
    getProfile,
    skip,
    showUI,
    hideUI,
    closeAllMenus,
    isAnyMenuOpen,
  });

  backBtn.addEventListener("click", () => skip(-10));
  fwdBtn.addEventListener("click", () => skip(10));

  wrap.addEventListener("mousemove", showUI);
  wrap.addEventListener("focusin", showUI);
  wrap.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, input, a, [role='slider']")) return;
    wrap.focus({ preventScroll: true });
  });
  wrap.addEventListener("mouseleave", () => {
    if (!video.paused) hideUI();
  });

  ctx.qualBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(qualMenu, e.detail === 0);
  });
  ctx.speedBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(speedMenu, e.detail === 0);
  });

  function shouldIgnoreMenuDismissClick(e) {
    return e.target.closest(
      ".menu-item, .menu-toggle, .cc-slider, .menu-popup input, .menu-popup label, .menu-wrap",
    );
  }

  document.addEventListener("click", (e) => {
    if (!isAnyMenuOpen()) return;
    if (shouldIgnoreMenuDismissClick(e)) return;
    closeAllMenus();
  });

  document.addEventListener(
    "touchend",
    (e) => {
      if (!isAnyMenuOpen()) return;
      if (shouldIgnoreMenuDismissClick(e)) return;
      if (!e.target.closest("#player-wrap")) return;
      closeAllMenus();
      showUI();
    },
    { passive: true },
  );

  qualMenu.addEventListener("click", (e) => e.stopPropagation());
  speedMenu.addEventListener("click", (e) => e.stopPropagation());
  menuBackdrop?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMenus(true);
    showUI();
  });

  ctx.ccBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = ccMenu.classList.contains("open");
    toggleMenu(ccMenu, e.detail === 0);
    if (!wasOpen && ccMenu.classList.contains("open")) markCcBannerMenuUsed(ctx.wrap);
  });
  ccMenu.addEventListener("click", (e) => e.stopPropagation());

  ctx.ccOff.addEventListener("click", () => setCcEnabled(false, video, ctx));
  ctx.ccOn.addEventListener("click", () => setCcEnabled(true, video, ctx));

  function wireCcSlider(slider, key) {
    slider.addEventListener("input", () => {
      applyCcSliderChange(key, slider.value, video, ctx);
    });
  }
  wireCcSlider(ctx.ccBrightness, "brightness");
  wireCcSlider(ctx.ccContrast, "contrast");
  wireCcSlider(ctx.ccSaturation, "saturation");

  speedMenu.querySelectorAll(".menu-item[data-speed]").forEach((item) => {
    item.addEventListener("click", () => {
      const spd = parseFloat(item.dataset.speed);
      video.playbackRate = spd;
      speedMenu.querySelectorAll(".menu-item").forEach((i) => {
        i.classList.remove("active");
        i.setAttribute("aria-pressed", "false");
      });
      item.classList.add("active");
      item.setAttribute("aria-pressed", "true");
      showToast(spd === 1 ? "Normal speed" : `${spd}× speed`);
      closeAllMenus(true);
    });
  });
  function syncSpeed() {
    const items = [...speedMenu.querySelectorAll(".menu-item[data-speed]")];
    if (!items.some((item) => Number(item.dataset.speed) === video.playbackRate)) return;
    items.forEach((item) => {
      const active = Number(item.dataset.speed) === video.playbackRate;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    ctx.speedBtn.setAttribute("aria-label", `Playback speed: ${video.playbackRate === 1 ? "normal" : `${video.playbackRate} times`}`);
    persistPlaybackPrefs({ speed: video.playbackRate });
  }
  video.addEventListener("ratechange", syncSpeed);

  fsBtn.addEventListener("click", toggleFS);
  document.addEventListener("fullscreenchange", () => {
    fsTransitionPending = false;
    const isFs = document.fullscreenElement === wrap;
    fsIcon.innerHTML = isFs ? FS_EXIT : FS_ENTER;
    fsBtn.setAttribute("aria-label", isFs ? "Exit fullscreen" : "Enter fullscreen");
    fsBtn.title = isFs ? "Exit fullscreen (f)" : "Fullscreen (f)";
    wrap.classList.toggle("fullscreen", isFs);
    updateMenuBounds();
  });

  wrap.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "Escape" && isAnyMenuOpen()) {
      e.preventDefault();
      closeAllMenus(true);
      return;
    }
    if (e.target.closest("input, textarea, select, button, a, [contenteditable], [role='slider']")) return;
    showUI();
    switch (e.key) {
      case " ":
      case "k":
        e.preventDefault();
        togglePlay();
        showToast(video.paused ? "Paused" : "Playing");
        break;
      case "j":
        skip(-10);
        break;
      case "l":
        skip(10);
        break;
      case "ArrowLeft":
        e.preventDefault();
        skip(-5);
        break;
      case "ArrowRight":
        e.preventDefault();
        skip(5);
        break;
      case "ArrowUp":
        e.preventDefault();
        video.volume = Math.min(1, video.volume + 0.1);
        video.muted = false;
        showToast(`Volume ${Math.round(video.volume * 100)}%`);
        break;
      case "ArrowDown":
        e.preventDefault();
        video.volume = Math.max(0, video.volume - 0.1);
        showToast(`Volume ${Math.round(video.volume * 100)}%`);
        break;
      case "m":
        toggleMute();
        showToast(video.muted ? "Muted" : "Unmuted");
        break;
      case "f":
        e.preventDefault();
        toggleFS();
        break;
      case "Home":
        e.preventDefault();
        seekTo(0);
        showToast("Start");
        break;
      case "End":
        e.preventDefault();
        seekTo(video.duration);
        break;
      default:
        if (e.key >= "0" && e.key <= "9") {
          const pct = parseInt(e.key, 10) / 10;
          seekTo(pct * video.duration);
          showToast(`${pct * 100}%`);
        }
    }
  });

  await initPlayback(meta, base, ctx, profile);
  volSlider.value = video.muted ? 0 : video.volume;
  updateVolIcon();
  syncSpeed();
  syncProgressAccessibility();
  durTime.textContent = fmt(video.duration || 0);
  syncBigPlayOverlay();
}
