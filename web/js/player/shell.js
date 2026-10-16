import { getPlayerProfile, watchProfile, isMobileLayout } from "./capabilities.js?v=progress-hover-removed-v4";
import {
  initPlayback, applyCcSliderChange, setCcEnabled,
  loadPlayerPrefs, persistPlaybackPrefs, getPlaybackFrameRate,
} from "./engine.js?v=progress-hover-removed-v4";
import { getAutoHideDelayMs, getBigPlayState, shouldShowMenuBackdrop } from "./chrome.js?v=progress-hover-removed-v4";
import { bindProgressInput, bindSurfaceInput } from "./input.js?v=progress-hover-removed-v4";
import { createSettings } from "./settings.js?v=progress-hover-removed-v4";
import { createFrameStepper } from "./frame-step.js?v=progress-hover-removed-v4";

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
    curTime: document.getElementById("cur-time"),
    durTime: document.getElementById("dur-time"),
    fsBtn: document.getElementById("fs-btn"),
    fsIcon: document.getElementById("fs-icon"),
    progWrap: document.getElementById("progress-wrap"),
    progFill: document.getElementById("progress-fill"),
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
  let progressFrame;

  const { wrap, video, bigPlay, seekFlash, kbToast, playBtn, playIcon } = ctx;
  const {
    muteBtn,
    volSlider,
    curTime,
    durTime,
    fsBtn,
    fsIcon,
    progWrap,
    progFill,
    progBuf,
    progThumb,
    qualMenu,
    speedMenu,
    ccMenu,
    menuBackdrop,
  } = ctx;

  const frameStepper = createFrameStepper(video, { getFrameRate: getPlaybackFrameRate });
  const settings = createSettings({ wrap, onActivity: showUI });
  const isAnyMenuOpen = () => settings.isOpen;
  const closeAllMenus = (restoreFocus = false) => settings.close(restoreFocus);
  const updateMenuBounds = () => settings.resize();
  document.getElementById("settings-panel").addEventListener("aida:settings-settled", showUI);

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
    progFill.style.width = frac * 100 + "%";
    progThumb.style.left = frac * 100 + "%";
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
    frameStepper.reset();
    video.currentTime = Math.max(0, Math.min(video.duration, time));
    applyProgress(video.currentTime / video.duration);
    curTime.textContent = fmt(video.currentTime);
    syncProgressAccessibility();
  }

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
    if (!isAnyMenuOpen()) {
      document.getElementById("controls").inert = false;
    }
    clearTimeout(uiTimer);
    if (!video.paused) uiTimer = setTimeout(hideUI, getAutoHideDelayMs(getProfile()));
    syncBigPlayOverlay();
    if (!video.paused && !progressFrame) progressFrame = requestAnimationFrame(animateProgress);
  }

  function animateProgress() {
    progressFrame = null;
    if (video.paused || document.hidden || !wrap.classList.contains("ui-visible")) return;
    if (!isDragging && video.duration > 0) {
      applyProgress(video.currentTime / video.duration);
      const label = fmt(video.currentTime);
      if (curTime.textContent !== label) curTime.textContent = label;
    }
    progressFrame = requestAnimationFrame(animateProgress);
  }

  function hideUI() {
    clearTimeout(uiTimer);
    if (video.paused || video.ended || isDragging || isAnyMenuOpen()) return;
    if (wrap.contains(document.activeElement) && document.activeElement.matches(":focus-visible")) return;
    wrap.classList.remove("ui-visible", "cursor-visible");
    document.getElementById("controls").inert = true;
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
    if (!progressFrame) progressFrame = requestAnimationFrame(animateProgress);
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
    showUI();
    syncBigPlayOverlay();
  });
  video.addEventListener("ended", () => {
    setPlayIcon(false);
    showUI();
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
    if (isDragging || !video.duration) return;
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

  bindProgressInput({ ctx, video, fmt, applyProgress, setDragging, onScrubTo, showUI });
  bindSurfaceInput({ ctx, showUI, hideUI, togglePlay, toggleFS, skip, isMenuOpen: isAnyMenuOpen });

  wrap.addEventListener("pointermove", (event) => { if (event.pointerType === "mouse") showUI(); });
  wrap.addEventListener("focusin", showUI);
  wrap.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, input, a, summary, #settings-panel, #menu-backdrop, [role='slider']")) return;
    wrap.focus({ preventScroll: true });
  });
  wrap.addEventListener("mouseleave", () => {
    if (!video.paused) hideUI();
  });

  qualMenu.addEventListener("click", (event) => {
    if (event.target.closest(".menu-item[data-id]")) closeAllMenus(true);
  });

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
    document.getElementById("speed-label").textContent = video.playbackRate === 1 ? "Normal" : `${video.playbackRate}×`;
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
    if (isAnyMenuOpen()) return;
    if ([",", "."].includes(e.key) && !e.shiftKey && !e.isComposing && !e.target.closest("input, textarea, select, a, [contenteditable], [role='slider']")) {
      e.preventDefault();
      void frameStepper.step(e.key === "," ? -1 : 1).then(result => {
        if (result.ok) {
          applyProgress(result.time / video.duration);
          curTime.textContent = fmt(result.time);
          syncProgressAccessibility();
        } else if (result.reason === "unknown-frame-rate") showToast("Frame rate unavailable for this video");
      });
      showUI();
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

  window.addEventListener("aida:playback-ready", () => frameStepper.reset());
  window.addEventListener("aida:playback-error", () => closeAllMenus());
  window.visualViewport?.addEventListener("resize", updateMenuBounds);
  await initPlayback(meta, base, ctx, profile);
  volSlider.value = video.muted ? 0 : video.volume;
  updateVolIcon();
  syncSpeed();
  syncProgressAccessibility();
  durTime.textContent = fmt(video.duration || 0);
  syncBigPlayOverlay();
}
