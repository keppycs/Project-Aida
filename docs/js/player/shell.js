import { getPlayerProfile, watchProfile } from "./capabilities.js";
import {
  initPlayback,
  applyCcSliderChange,
  setCcEnabled,
  markCcBannerMenuUsed,
} from "./engine.js";
import { bindProgressInteractions, bindVideoSurfaceInteractions } from "./input.js";

function collectContext() {
  const wrap = document.getElementById("player-wrap");
  return {
    wrap,
    video: document.getElementById("video"),
    bigPlay: document.getElementById("big-play"),
    spinner: document.getElementById("spinner"),
    seekFlash: document.getElementById("seek-flash"),
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
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

const PLAY_SVG = '<polygon points="5,3 19,12 5,21"/>';
const PAUSE_SVG =
  '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';

const BIG_PLAY_SVG_CIRCLE =
  '<circle cx="36" cy="36" r="35" fill="rgba(0,0,0,.55)" stroke="rgba(255,255,255,.25)" stroke-width="1"/>';
const BIG_PLAY_SVG_PLAY = `${BIG_PLAY_SVG_CIRCLE}<path d="M29 21.5 L55 36 L29 50.5 Z" fill="rgba(255,255,255,0.88)" stroke="rgba(255,255,255,0.14)" stroke-width="0.75" stroke-linejoin="round"/>`;
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
  wrap.classList.toggle("layout-compact", profile.layout === "compact");
  wrap.dataset.layout = profile.layout;
}

export async function mountPlayer(meta, base) {
  const ctx = collectContext();
  let profile = getPlayerProfile();
  const getProfile = () => profile;
  applyLayoutClass(ctx.wrap, profile);

  let uiTimer;
  let isDragging = false;

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
    progBuf,
    progThumb,
    qualMenu,
    speedMenu,
    ccMenu,
    menuBackdrop,
  } = ctx;

  function setDragging(v) {
    isDragging = v;
  }
  function getDragging() {
    return isDragging;
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

  function isAnyMenuOpen() {
    return (
      qualMenu.classList.contains("open") ||
      speedMenu.classList.contains("open") ||
      ccMenu.classList.contains("open")
    );
  }

  function closeAllMenus() {
    qualMenu.classList.remove("open");
    speedMenu.classList.remove("open");
    ccMenu.classList.remove("open");
    menuBackdrop?.classList.remove("open");
  }

  function toggleMenu(menu) {
    const isOpen = menu.classList.contains("open");
    closeAllMenus();
    if (!isOpen) {
      menu.classList.add("open");
      if (getProfile().layout === "compact") menuBackdrop?.classList.add("open");
      requestAnimationFrame(() => {
        menu.scrollTop = 0;
      });
      showUI();
    }
  }

  function syncBigPlayOverlay() {
    const compact = getProfile().layout === "compact";
    const svg = bigPlay.querySelector("svg");
    if (!svg) return;
    if (compact) {
      const show = video.paused || wrap.classList.contains("ui-visible");
      bigPlay.classList.toggle("show", show);
      svg.innerHTML = video.paused ? BIG_PLAY_SVG_PLAY : BIG_PLAY_SVG_PAUSE;
    } else {
      bigPlay.classList.toggle("show", video.paused);
      svg.innerHTML = BIG_PLAY_SVG_PLAY;
    }
  }

  function showUI() {
    wrap.classList.add("ui-visible", "cursor-visible");
    clearTimeout(uiTimer);
    const delay = getProfile().layout === "compact" ? 2000 : 3000;
    if (!video.paused) uiTimer = setTimeout(hideUI, delay);
    syncBigPlayOverlay();
  }

  function hideUI() {
    clearTimeout(uiTimer);
    if (isAnyMenuOpen()) return;
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
  }

  function togglePlay() {
    if (video.paused) void video.play();
    else video.pause();
  }

  function skip(sec) {
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + sec));
    flashSeek(sec > 0 ? `+${sec}s` : `${sec}s`);
  }

  function updateVolIcon() {
    const v = video.volume;
    const m = video.muted;
    document.getElementById("vol-icon").innerHTML =
      m || v === 0 ? VOL_MUTE
      : v < 0.5 ? VOL_LOW
      : VOL_FULL;
  }

  function toggleFS() {
    if (!document.fullscreenElement) wrap.requestFullscreen();
    else document.exitFullscreen();
  }

  await initPlayback(meta, base, ctx, profile);

  syncBigPlayOverlay();

  watchProfile((next) => {
    profile = next;
    applyLayoutClass(wrap, profile);
    syncBigPlayOverlay();
    if (profile.hideVolumeChrome) {
      ctx.volCluster.style.display = "none";
      video.volume = 1;
    } else {
      ctx.volCluster.style.display = "";
    }
    closeAllMenus();
  });

  video.addEventListener("play", () => {
    setPlayIcon(true);
    clearTimeout(uiTimer);
    const delay = getProfile().layout === "compact" ? 2000 : 3000;
    uiTimer = setTimeout(hideUI, delay);
    syncBigPlayOverlay();
  });
  video.addEventListener("pause", () => {
    setPlayIcon(false);
    showUI();
  });
  video.addEventListener("ended", () => {
    setPlayIcon(false);
    showUI();
  });

  playBtn.addEventListener("click", () => {
    togglePlay();
  });
  bigPlay.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePlay();
  });

  muteBtn.addEventListener("click", () => {
    video.muted = !video.muted;
    updateVolIcon();
  });
  volSlider.addEventListener("input", () => {
    video.volume = parseFloat(volSlider.value);
    video.muted = video.volume === 0;
    updateVolIcon();
  });
  video.addEventListener("volumechange", () => {
    volSlider.value = video.muted ? 0 : video.volume;
    updateVolIcon();
  });

  video.addEventListener("timeupdate", () => {
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
  });

  bindProgressInteractions({
    ctx,
    getProfile,
    video,
    fmt,
    getProgressFrac,
    applyProgress,
    setDragging,
    isDragging: getDragging,
    onScrubTo: (frac) => {
      video.currentTime = frac * video.duration;
    },
    showUI,
  });

  bindVideoSurfaceInteractions({
    ctx,
    getProfile,
    togglePlay,
    showUI,
    hideUI,
    closeAllMenus,
    isAnyMenuOpen,
  });

  backBtn.addEventListener("click", () => skip(-10));
  fwdBtn.addEventListener("click", () => skip(10));

  wrap.addEventListener("mousemove", showUI);
  wrap.addEventListener("mouseleave", () => {
    if (!video.paused) hideUI();
  });

  ctx.qualBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(qualMenu);
  });
  ctx.speedBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(speedMenu);
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

  ctx.ccBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = ccMenu.classList.contains("open");
    toggleMenu(ccMenu);
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
      speedMenu.querySelectorAll(".menu-item").forEach((i) => i.classList.remove("active"));
      item.classList.add("active");
      showToast(spd === 1 ? "Normal speed" : `${spd}× speed`);
      closeAllMenus();
    });
  });

  fsBtn.addEventListener("click", toggleFS);
  document.addEventListener("fullscreenchange", () => {
    const isFs = !!document.fullscreenElement;
    fsIcon.innerHTML = isFs ? FS_EXIT : FS_ENTER;
    wrap.classList.toggle("fullscreen", isFs);
  });

  document.addEventListener("keydown", (e) => {
    if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
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
        showToast("−5s");
        break;
      case "ArrowRight":
        e.preventDefault();
        skip(5);
        showToast("+5s");
        break;
      case "ArrowUp":
        e.preventDefault();
        video.volume = Math.min(1, video.volume + 0.1);
        showToast(`Volume ${Math.round(video.volume * 100)}%`);
        break;
      case "ArrowDown":
        e.preventDefault();
        video.volume = Math.max(0, video.volume - 0.1);
        showToast(`Volume ${Math.round(video.volume * 100)}%`);
        break;
      case "m":
        video.muted = !video.muted;
        showToast(video.muted ? "Muted" : "Unmuted");
        break;
      case "f":
        toggleFS();
        break;
      case "Home":
        video.currentTime = 0;
        showToast("Start");
        break;
      case "End":
        video.currentTime = video.duration;
        break;
      default:
        if (e.key >= "0" && e.key <= "9") {
          const pct = parseInt(e.key, 10) / 10;
          video.currentTime = pct * video.duration;
          showToast(`${pct * 100}%`);
        }
    }
  });
}
