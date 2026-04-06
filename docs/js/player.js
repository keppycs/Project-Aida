// ── Suppress noisy Shaka warnings ───────────────────────────────────────────────
// Shaka attempts CEA-608/708 closed caption parsing on all HLS streams and warns
// when it can't determine the bitstream format. Since we don't use captions, filter
// this out rather than polluting the console.
const _origWarn = console.warn.bind(console);
console.warn = (...args) => {
  if (typeof args[0] === "string" && args[0].includes("CEA")) return;
  _origWarn(...args);
};

// ── Codec detection ─────────────────────────────────────────────────────────────
const AV1_CODEC = 'video/mp4; codecs="av01.0.08H.10.0.110.09.16.09.0"';
const HEVC_CODEC = 'video/mp4; codecs="hvc1.1.6.H150.B0"';

// Check supported only — smooth is reported conservatively by browsers
// (e.g. Chrome reports smooth=false for 4K120 PQ AV1 even on capable hardware).
async function canDecode(type, contentType) {
  try {
    const r = await navigator.mediaCapabilities?.decodingInfo({
      type,
      video: {
        contentType,
        width: 3840,
        height: 2160,
        bitrate: 20000000,
        framerate: 120,
        transferFunction: "pq",
        colorGamut: "rec2020",
      },
    });
    return r?.supported ?? false;
  } catch {
    return false;
  }
}

const supportsAV1Dash = () => canDecode("media-source", AV1_CODEC);
const supportsAV1Hls = () => canDecode("file", AV1_CODEC);
const supportsHEVCDash = () => canDecode("media-source", HEVC_CODEC);
const supportsHEVCHls = () => canDecode("file", HEVC_CODEC);

// HDR transfer functions — mirrors config.py HDR_TRANSFERS
const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67", "smpte428", "bt2020-10", "bt2020-12"]);

// Mobile detection — used to adjust volume default, hide vol cluster, and enable touch
const isMobile = navigator.maxTouchPoints > 0;

// ── Elements ───────────────────────────────────────────────────────────────────
const wrap = document.getElementById("player-wrap");
const video = document.getElementById("video");
const bigPlay = document.getElementById("big-play");
const spinner = document.getElementById("spinner");
const seekFlash = document.getElementById("seek-flash");
const kbToast = document.getElementById("kb-toast");
const playBtn = document.getElementById("play-btn");
const playIcon = document.getElementById("play-icon");
const muteBtn = document.getElementById("mute-btn");
const volSlider = document.getElementById("vol-slider");
const backBtn = document.getElementById("back-btn");
const fwdBtn = document.getElementById("fwd-btn");
const curTime = document.getElementById("cur-time");
const durTime = document.getElementById("dur-time");
const fsBtn = document.getElementById("fs-btn");
const fsIcon = document.getElementById("fs-icon");
const progWrap = document.getElementById("progress-wrap");
const progFill = document.getElementById("progress-fill");
const progBuf = document.getElementById("progress-buffer");
const progThumb = document.getElementById("progress-thumb");
const timeTip = document.getElementById("time-tooltip");
const qualBtn = document.getElementById("quality-btn");
const qualMenu = document.getElementById("quality-menu");
const qualLabel = document.getElementById("quality-label");
const speedBtn = document.getElementById("speed-btn");
const speedMenu = document.getElementById("speed-menu");
const hdrBadge = document.getElementById("hdr-badge");
const codecBadge = document.getElementById("codec-badge");
const protocolBadge = document.getElementById("protocol-badge");
const titleText = document.getElementById("title-text");
const ccWrap = document.getElementById("cc-wrap");
const ccBtn = document.getElementById("cc-btn");
const ccMenu = document.getElementById("cc-menu");
const ccOff = document.getElementById("cc-off");
const ccOn = document.getElementById("cc-on");
const ccBrightness = document.getElementById("cc-brightness");
const ccContrast = document.getElementById("cc-contrast");
const ccSaturation = document.getElementById("cc-saturation");
const ccBrightnessVal = document.getElementById("cc-brightness-val");
const ccContrastVal = document.getElementById("cc-contrast-val");
const ccSaturationVal = document.getElementById("cc-saturation-val");

// ── State ──────────────────────────────────────────────────────────────────────
let player,
  uiTimer,
  isDragging = false,
  selectedQuality = -1, // -1 = auto, or Shaka track ID (current stream only)
  selectedHeight = null, // persists across codec/protocol switches; null = auto
  currentMeta = null,
  currentBase = null,
  currentCodec = null, // "AV1" | "HEVC"
  currentProtocol = null; // "DASH" | "HLS"

const PLAYER_PREFS_KEY = "aida-player-prefs";
const PREFS_CODECS = new Set(["AV1", "HEVC"]);
const PREFS_PROTOCOLS = new Set(["DASH", "HLS"]);

/** @returns {{ codec?: string, protocol?: string, quality?: "auto" | number } | null} */
function loadPlayerPrefs() {
  try {
    const raw = localStorage.getItem(PLAYER_PREFS_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return null;
    const prefs = {};
    if (typeof o.codec === "string" && PREFS_CODECS.has(o.codec)) prefs.codec = o.codec;
    if (typeof o.protocol === "string" && PREFS_PROTOCOLS.has(o.protocol))
      prefs.protocol = o.protocol;
    if (o.quality === "auto") prefs.quality = "auto";
    else if (typeof o.quality === "number" && Number.isFinite(o.quality) && o.quality > 0)
      prefs.quality = Math.round(o.quality);
    return Object.keys(prefs).length ? prefs : null;
  } catch {
    return null;
  }
}

function persistPlayerPrefs() {
  if (!currentCodec || !currentProtocol) return;
  const payload = {
    codec: currentCodec,
    protocol: currentProtocol,
    quality: selectedHeight === null ? "auto" : selectedHeight,
  };
  try {
    localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify(payload));
  } catch {}
}

// ── Color correction (HDR content on SDR displays only) ───────────────────
// CSS filter on the <video> element; persisted in localStorage. Hidden entirely on
// HDR-capable displays. On SDR, defaults to On so PQ HDR does not look washed out.
const CC_STORAGE_KEY = "aida-color-correction";
/** User dismissed the SDR banner with ✕ — do not show again on future loads. */
const CC_BANNER_DISMISSED_KEY = "aida-cc-banner-dismissed";
/** User opened the Color menu at least once — do not show the banner again. */
const CC_BANNER_MENU_USED_KEY = "aida-cc-banner-menu-used";
const CC_BANNER_AUTO_MS = 30000;

/** Defaults: on at first visit (SDR). */
const CC_DEFAULTS = Object.freeze({
  enabled: true,
  brightness: 1,
  contrast: 1.7,
  saturation: 1.3,
});

let ccState = { ...CC_DEFAULTS };
/** Auto-dismiss timer for the SDR color-correction banner (30s; does not persist). */
let ccBannerTimer = null;

function clampCc(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function normalizeColorCorrection(o) {
  const b = Number(o.brightness);
  const c = Number(o.contrast);
  const s = Number(o.saturation);
  return {
    enabled: Boolean(o.enabled),
    brightness: Number.isFinite(b) ? clampCc(b, 0.5, 2) : CC_DEFAULTS.brightness,
    contrast: Number.isFinite(c) ? clampCc(c, 0.5, 2.5) : CC_DEFAULTS.contrast,
    saturation: Number.isFinite(s) ? clampCc(s, 0, 2) : CC_DEFAULTS.saturation,
  };
}

function loadColorCorrectionState() {
  try {
    const raw = localStorage.getItem(CC_STORAGE_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && typeof o === "object") return normalizeColorCorrection(o);
    }
  } catch {}
  return { ...CC_DEFAULTS };
}

function persistColorCorrection() {
  try {
    localStorage.setItem(CC_STORAGE_KEY, JSON.stringify(ccState));
  } catch {}
}

function formatCcParam(n) {
  const t = Number(n);
  if (!Number.isFinite(t)) return "—";
  return (Math.round(t * 100) / 100).toFixed(2);
}

function applyColorCorrection() {
  if (!ccState.enabled) {
    video.style.filter = "";
    return;
  }
  const { brightness, contrast, saturation } = ccState;
  video.style.filter = `brightness(${brightness}) contrast(${contrast}) saturate(${saturation})`;
}

function syncCcUiFromState() {
  ccOff.classList.toggle("active", !ccState.enabled);
  ccOn.classList.toggle("active", ccState.enabled);
  ccBrightness.value = String(ccState.brightness);
  ccContrast.value = String(ccState.contrast);
  ccSaturation.value = String(ccState.saturation);
  ccBrightnessVal.textContent = formatCcParam(ccState.brightness);
  ccContrastVal.textContent = formatCcParam(ccState.contrast);
  ccSaturationVal.textContent = formatCcParam(ccState.saturation);
  ccBtn.classList.toggle("active", ccState.enabled);
  ccBtn.title = ccState.enabled ? "Color correction: On" : "Color correction: Off";
}

function setCcEnabled(on) {
  ccState.enabled = on;
  applyColorCorrection();
  syncCcUiFromState();
  persistColorCorrection();
}

function shouldShowCcBanner() {
  return (
    !localStorage.getItem(CC_BANNER_DISMISSED_KEY) && !localStorage.getItem(CC_BANNER_MENU_USED_KEY)
  );
}

function clearCcBannerTimer() {
  if (ccBannerTimer != null) {
    clearTimeout(ccBannerTimer);
    ccBannerTimer = null;
  }
}

function markCcBannerDismissed() {
  try {
    localStorage.setItem(CC_BANNER_DISMISSED_KEY, "1");
  } catch {}
  clearCcBannerTimer();
  document.getElementById("cc-notice")?.remove();
}

function markCcBannerMenuUsed() {
  try {
    localStorage.setItem(CC_BANNER_MENU_USED_KEY, "1");
  } catch {}
  clearCcBannerTimer();
  document.getElementById("cc-notice")?.remove();
}

function showColorCorrectionNotice() {
  clearCcBannerTimer();
  const notice = document.createElement("div");
  notice.id = "cc-notice";
  notice.className = "player-notice player-notice-timed";
  notice.style.setProperty("--cc-banner-duration", `${CC_BANNER_AUTO_MS}ms`);
  notice.innerHTML = `
    <div class="player-notice-body">
      <span><strong>Color correction</strong> is enabled to compensate for the HDR video on your non-HDR compatible setup. Please adjust the brightness, contrast, and saturation to taste in the Color menu.</span>
      <button type="button" class="player-notice-close" aria-label="Dismiss">✕</button>
    </div>
    <div class="player-notice-progress" aria-hidden="true">
      <div class="player-notice-progress-bar"></div>
    </div>
  `;
  wrap.appendChild(notice);
  notice
    .querySelector(".player-notice-close")
    .addEventListener("click", () => markCcBannerDismissed());
  ccBannerTimer = setTimeout(() => {
    ccBannerTimer = null;
    notice.remove();
  }, CC_BANNER_AUTO_MS);
}

// ── Display HDR detection ─────────────────────────────────────────────────────
// Detects whether the *display* is HDR-capable, not the content.
async function detectHDR() {
  const signals = {
    dynamicRange: window.matchMedia("(dynamic-range: high)").matches,
    wideGamut:
      window.matchMedia("(color-gamut: p3)").matches ||
      window.matchMedia("(color-gamut: rec2020)").matches,
    mediaCapabilities: false,
  };
  try {
    const r = await navigator.mediaCapabilities?.decodingInfo({
      type: "media-source",
      video: {
        contentType: 'video/mp4; codecs="hvc1"',
        width: 1920,
        height: 1080,
        bitrate: 10000000,
        framerate: 60,
        transferFunction: "pq",
        colorGamut: "rec2020",
      },
    });
    signals.mediaCapabilities = r?.supported ?? false;
  } catch {}
  const isHDR = signals.dynamicRange || (signals.mediaCapabilities && signals.wideGamut);
  console.debug("[HDR detect]", signals, "→", isHDR);
  return isHDR;
}

// ── Source selection ──────────────────────────────────────────────────────────
// Returns the best {src, mime, codec, protocol} given availability + preference.
// preferCodec / preferProtocol override auto-detection when set.
async function selectSource(meta, base, preferCodec, preferProtocol) {
  const hasAV1 = meta.codecs.includes("AV1");
  const hasHEVC = meta.codecs.includes("HEVC");

  const candidates = [];

  if (hasAV1) {
    if (await supportsAV1Dash())
      candidates.push({
        codec: "AV1",
        protocol: "DASH",
        src: `${base}/AV1/manifest.mpd`,
        mime: "application/dash+xml",
      });
    if (await supportsAV1Hls())
      candidates.push({
        codec: "AV1",
        protocol: "HLS",
        src: `${base}/AV1/master.m3u8`,
        mime: "application/x-mpegURL",
      });
  }
  if (hasHEVC) {
    if (await supportsHEVCDash())
      candidates.push({
        codec: "HEVC",
        protocol: "DASH",
        src: `${base}/HEVC/manifest.mpd`,
        mime: "application/dash+xml",
      });
    if (await supportsHEVCHls())
      candidates.push({
        codec: "HEVC",
        protocol: "HLS",
        src: `${base}/HEVC/master.m3u8`,
        mime: "application/x-mpegURL",
      });
  }

  if (!candidates.length) return null;

  // Apply preferences — filter by codec/protocol if specified, fall back to best available
  let filtered = candidates;
  if (preferCodec)
    filtered =
      filtered.filter((c) => c.codec === preferCodec).length ?
        filtered.filter((c) => c.codec === preferCodec)
      : filtered;
  if (preferProtocol)
    filtered =
      filtered.filter((c) => c.protocol === preferProtocol).length ?
        filtered.filter((c) => c.protocol === preferProtocol)
      : filtered;

  return filtered[0];
}

// ── Load source ───────────────────────────────────────────────────────────────
async function loadSource(meta, base, preferCodec, preferProtocol) {
  const chosen = await selectSource(meta, base, preferCodec, preferProtocol);
  if (!chosen) {
    showUnsupportedNotice();
    return;
  }

  currentMeta = meta;
  currentBase = base;
  currentCodec = chosen.codec;
  currentProtocol = chosen.protocol;

  codecBadge.textContent = chosen.codec;
  protocolBadge.textContent = chosen.protocol;
  codecBadge.classList.add("show");
  protocolBadge.classList.add("show");

  try {
    await player.load(chosen.src, null, chosen.mime);
  } catch (e) {
    console.error("Load failed", e);
  }
}

// ── Init ───────────────────────────────────────────────────────────────────────
// meta: parsed metadata.json  |  base: base URL, no trailing slash
async function init(meta, base) {
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) {
    alert("Your browser does not support this player.");
    return;
  }

  player = new shaka.Player();
  await player.attach(video);
  // On mobile the OS owns volume — default to full and hide the vol cluster
  video.volume = isMobile ? 1.0 : 0.5;
  if (isMobile) document.getElementById("vol-cluster").style.display = "none";

  player.configure({
    streaming: {
      bufferingGoal: 20,
      rebufferingGoal: 3,
      bufferBehind: 20,
      safeSeekOffset: 2,
      lowLatencyMode: false,
    },
    abr: {
      enabled: true,
      defaultBandwidthEstimate: 20_000_000,
      bandwidthUpgradeTarget: 0.85,
      bandwidthDowngradeTarget: 0.95,
      switchInterval: 4,
    },
  });

  player.addEventListener("error", (e) => console.error("Shaka error", e.detail));
  player.addEventListener("buffering", (e) => spinner.classList.toggle("show", e.buffering));
  player.addEventListener("adaptation", updateQualityLabel);
  player.addEventListener("variantchanged", updateQualityLabel);
  player.addEventListener("trackschanged", buildQualityMenu);

  titleText.textContent = meta.title;

  // HDR driven by metadata — not from Shaka track data which is unreliable for DASH
  const isHdr = HDR_TRANSFERS.has(meta.colorTransfer);
  hdrBadge.textContent = isHdr ? "HDR" : "SDR";
  hdrBadge.classList.toggle("sdr", !isHdr);
  hdrBadge.classList.add("show");
  if (isHdr) {
    const hdrCapable = await detectHDR();
    if (hdrCapable) {
      // HDR display: no color correction UI — native HDR tone mapping.
      ccWrap.style.display = "none";
      video.style.filter = "";
    } else {
      ccState = loadColorCorrectionState();
      syncCcUiFromState();
      applyColorCorrection();
      ccWrap.style.display = "";
      if (shouldShowCcBanner()) showColorCorrectionNotice();
    }
  }

  const prefs = loadPlayerPrefs();
  if (prefs) {
    if (prefs.quality === "auto") {
      selectedHeight = null;
      selectedQuality = -1;
    } else if (typeof prefs.quality === "number") {
      selectedHeight = prefs.quality;
    }
  }

  await loadSource(meta, base, prefs?.codec ?? null, prefs?.protocol ?? null);
}

function showUnsupportedNotice() {
  const notice = document.createElement("div");
  notice.id = "unsupported-notice";
  notice.className = "player-notice";
  notice.innerHTML = `
    <span>Your browser or device does not support any available video codec. Try a different browser.</span>
    <button type="button" class="player-notice-close" aria-label="Dismiss">✕</button>
  `;
  wrap.appendChild(notice);
  notice.querySelector(".player-notice-close").addEventListener("click", () => notice.remove());
}

// ── Formatting ─────────────────────────────────────────────────────────────────
function fmt(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// ── Play / Pause ───────────────────────────────────────────────────────────────
const PLAY_SVG = '<polygon points="5,3 19,12 5,21"/>';
const PAUSE_SVG =
  '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';

function setPlayIcon(playing) {
  playIcon.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
}

function togglePlay() {
  if (video.paused) {
    video.play();
    bigPlay.classList.remove("show");
  } else {
    video.pause();
    bigPlay.classList.add("show");
  }
}

video.addEventListener("play", () => setPlayIcon(true));
video.addEventListener("pause", () => setPlayIcon(false));
video.addEventListener("ended", () => {
  setPlayIcon(false);
  bigPlay.classList.add("show");
});

playBtn.addEventListener("click", togglePlay);
bigPlay.addEventListener("click", togglePlay);
// On mobile, taps on the video are handled by the touch section below
if (!isMobile) video.addEventListener("click", togglePlay);

// ── Volume ─────────────────────────────────────────────────────────────────────
const VOL_FULL = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
  <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>`;
const VOL_MUTE = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
  <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>`;
const VOL_LOW = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>`;

function updateVolIcon() {
  const v = video.volume,
    m = video.muted;
  document.getElementById("vol-icon").innerHTML =
    m || v === 0 ? VOL_MUTE
    : v < 0.5 ? VOL_LOW
    : VOL_FULL;
}

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

// ── Progress ───────────────────────────────────────────────────────────────────
function getProgressX(e) {
  const rect = progWrap.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

function applyProgress(frac) {
  progFill.style.width = frac * 100 + "%";
  progThumb.style.right = -0.5 + "px";
  progThumb.style.left = frac * 100 + "%";
}

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

progWrap.addEventListener("mousemove", (e) => {
  timeTip.textContent = fmt(getProgressX(e) * (video.duration || 0));
  timeTip.style.left = e.clientX - progWrap.getBoundingClientRect().left + "px";
});
progWrap.addEventListener("mousedown", (e) => {
  isDragging = true;
  applyProgress(getProgressX(e));
});
document.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  applyProgress(getProgressX(e));
  curTime.textContent = fmt(getProgressX(e) * (video.duration || 0));
});
document.addEventListener("mouseup", (e) => {
  if (!isDragging) return;
  isDragging = false;
  video.currentTime = getProgressX(e) * video.duration;
});

// ── Skip ───────────────────────────────────────────────────────────────────────
function skip(sec) {
  video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + sec));
  flashSeek(sec > 0 ? `+${sec}s` : `${sec}s`);
}

backBtn.addEventListener("click", () => skip(-10));
fwdBtn.addEventListener("click", () => skip(10));

function flashSeek(txt) {
  seekFlash.textContent = txt;
  seekFlash.classList.remove("flash");
  void seekFlash.offsetWidth;
  seekFlash.classList.add("flash");
}

// ── UI visibility ──────────────────────────────────────────────────────────────
function showUI() {
  wrap.classList.add("ui-visible", "cursor-visible");
  clearTimeout(uiTimer);
  if (!video.paused) uiTimer = setTimeout(hideUI, isMobile ? 2000 : 3000);
}

function hideUI() {
  if (isAnyMenuOpen()) return;
  wrap.classList.remove("ui-visible", "cursor-visible");
}

function isAnyMenuOpen() {
  return (
    qualMenu.classList.contains("open") ||
    speedMenu.classList.contains("open") ||
    ccMenu.classList.contains("open")
  );
}

wrap.addEventListener("mousemove", showUI);
wrap.addEventListener("mouseleave", () => {
  if (!video.paused) hideUI();
});
video.addEventListener("pause", showUI);
video.addEventListener("play", () => {
  clearTimeout(uiTimer);
  uiTimer = setTimeout(hideUI, 3000);
});

// ── Menus ──────────────────────────────────────────────────────────────────────
function toggleMenu(menu) {
  const isOpen = menu.classList.contains("open");
  closeAllMenus();
  if (!isOpen) {
    menu.classList.add("open");
    showUI();
  }
}

function closeAllMenus() {
  qualMenu.classList.remove("open");
  speedMenu.classList.remove("open");
  ccMenu.classList.remove("open");
}

qualBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleMenu(qualMenu);
});
speedBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleMenu(speedMenu);
});
document.addEventListener("click", closeAllMenus);
qualMenu.addEventListener("click", (e) => e.stopPropagation());
speedMenu.addEventListener("click", (e) => e.stopPropagation());

ccBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const wasOpen = ccMenu.classList.contains("open");
  toggleMenu(ccMenu);
  if (!wasOpen && ccMenu.classList.contains("open")) markCcBannerMenuUsed();
});
ccMenu.addEventListener("click", (e) => e.stopPropagation());

ccOff.addEventListener("click", () => setCcEnabled(false));
ccOn.addEventListener("click", () => setCcEnabled(true));

function wireCcSlider(slider, key) {
  slider.addEventListener("input", () => {
    const v = parseFloat(slider.value);
    if (!Number.isFinite(v)) return;
    ccState[key] = v;
    if (!ccState.enabled) ccState.enabled = true;
    applyColorCorrection();
    syncCcUiFromState();
    persistColorCorrection();
  });
}
wireCcSlider(ccBrightness, "brightness");
wireCcSlider(ccContrast, "contrast");
wireCcSlider(ccSaturation, "saturation");

// ── Quality menu ───────────────────────────────────────────────────────────────
function buildQualityMenu() {
  if (!player) return;

  qualMenu.innerHTML = "";

  // ── Codec toggle ──
  const codecHeader = document.createElement("div");
  codecHeader.className = "menu-header";
  codecHeader.textContent = "Codec";
  qualMenu.appendChild(codecHeader);

  const codecRow = document.createElement("div");
  codecRow.className = "menu-toggle-row";

  const codecs = currentMeta?.codecs || [];
  [
    ["AV1", "AV1"],
    ["HEVC", "HEVC"],
  ].forEach(([value, label]) => {
    const btn = document.createElement("button");
    btn.className = "menu-toggle" + (currentCodec === value ? " active" : "");
    btn.textContent = label;
    if (!codecs.includes(value)) {
      btn.disabled = true;
      btn.classList.add("disabled");
    }
    btn.addEventListener("click", async () => {
      if (btn.disabled || currentCodec === value) return;
      await loadSource(currentMeta, currentBase, value, currentProtocol);
    });
    codecRow.appendChild(btn);
  });
  qualMenu.appendChild(codecRow);

  // ── Protocol toggle ──
  const protHeader = document.createElement("div");
  protHeader.className = "menu-header";
  protHeader.textContent = "Protocol";
  qualMenu.appendChild(protHeader);

  const protRow = document.createElement("div");
  protRow.className = "menu-toggle-row";

  ["DASH", "HLS"].forEach((value) => {
    const btn = document.createElement("button");
    btn.className = "menu-toggle" + (currentProtocol === value ? " active" : "");
    btn.textContent = value;
    btn.addEventListener("click", async () => {
      if (currentProtocol === value) return;
      await loadSource(currentMeta, currentBase, currentCodec, value);
    });
    protRow.appendChild(btn);
  });
  qualMenu.appendChild(protRow);

  // ── Quality ──
  const qualHeader = document.createElement("div");
  qualHeader.className = "menu-header";
  qualHeader.textContent = "Quality";
  qualMenu.appendChild(qualHeader);

  const tracks = player
    .getVariantTracks()
    .filter((t) => t.height)
    .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);

  const autoItem = document.createElement("button");
  autoItem.className = "menu-item" + (selectedQuality === -1 ? " active" : "");
  autoItem.dataset.id = "-1";
  autoItem.id = "quality-auto-item";
  autoItem.innerHTML = `
    <svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
    Auto
    <span class="menu-badge" id="quality-auto-badge">ABR</span>`;
  autoItem.addEventListener("click", () => selectQuality(-1));
  qualMenu.appendChild(autoItem);

  tracks.forEach((track) => {
    const item = document.createElement("button");
    item.className = "menu-item";
    item.dataset.id = track.id;

    const kbps = Math.round(track.bandwidth / 1000);
    // Fall back to meta.frameRate — HLS manifests lack FRAME-RATE attributes
    // so Shaka only populates track.frameRate for some tracks.
    const fps = Math.round(track.frameRate || currentMeta?.frameRate || 0) || "";
    const label = `${String(track.height).padStart(4, "\u00A0")}p${fps}`;

    item.innerHTML = `
      <svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      ${label}
      <span class="menu-badge">${kbps > 1000 ? (kbps / 1000).toFixed(1) + " Mbps" : kbps + " kbps"}</span>`;
    item.addEventListener("click", () => selectQuality(track.id));
    qualMenu.appendChild(item);
  });

  // Restore previously selected quality by height.
  // Falls back to auto if no match found in the new track list.
  if (selectedHeight !== null) {
    const target = tracks.find((t) => t.height === selectedHeight);
    if (target) {
      selectedQuality = target.id;
      player.configure("abr.enabled", false);
      player.selectVariantTrack(target, true);
      qualLabel.textContent = trackLabel(target);
      qualMenu.querySelectorAll(".menu-item").forEach((item) => {
        item.classList.toggle("active", parseInt(item.dataset.id) === target.id);
      });
      persistPlayerPrefs();
      return;
    }
    // Height no longer exists in this stream — fall back to auto
    selectedHeight = null;
  }

  selectedQuality = -1;
  player.configure("abr.enabled", true);
  updateQualityLabel();
  persistPlayerPrefs();
}

function trackLabel(track) {
  const fps = Math.round(track.frameRate || currentMeta?.frameRate || 0);
  return `${track.height}p${fps || ""}`;
}

function selectQuality(id) {
  selectedQuality = id;
  if (id === -1) {
    selectedHeight = null;
    player.configure("abr.enabled", true);
    qualLabel.textContent = "Auto";
  } else {
    player.configure("abr.enabled", false);
    const track = player.getVariantTracks().find((t) => t.id === id);
    if (track) {
      selectedHeight = track.height;
      player.selectVariantTrack(track, true);
      qualLabel.textContent = trackLabel(track);
    }
  }
  qualMenu.querySelectorAll(".menu-item").forEach((item) => {
    item.classList.toggle("active", parseInt(item.dataset.id) === id);
  });
  persistPlayerPrefs();
}

function updateQualityLabel() {
  if (selectedQuality !== -1 || !player) return;
  const active = player.getVariantTracks().find((t) => t.active);
  const label = active ? trackLabel(active) : null;
  qualLabel.textContent = label ? `Auto · ${label}` : "Auto";
  const autoBadge = document.getElementById("quality-auto-badge");
  if (autoBadge) autoBadge.textContent = label ?? "ABR";
}

// ── Speed menu ─────────────────────────────────────────────────────────────────
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

// ── Fullscreen ─────────────────────────────────────────────────────────────────
const FS_ENTER = `<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
  <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>`;
const FS_EXIT = `<polyline points="4 14 10 14 10 20"/><polyline points="20 4 14 4 14 10"/>
  <line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>`;

function toggleFS() {
  if (!document.fullscreenElement) wrap.requestFullscreen();
  else document.exitFullscreen();
}

fsBtn.addEventListener("click", toggleFS);
document.addEventListener("fullscreenchange", () => {
  const isFs = !!document.fullscreenElement;
  fsIcon.innerHTML = isFs ? FS_EXIT : FS_ENTER;
  wrap.classList.toggle("fullscreen", isFs);
});

// ── Keyboard ───────────────────────────────────────────────────────────────────
function showToast(msg) {
  kbToast.textContent = msg;
  kbToast.classList.remove("show");
  void kbToast.offsetWidth;
  kbToast.classList.add("show");
}

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
  }
  if (e.key >= "0" && e.key <= "9") {
    const pct = parseInt(e.key) / 10;
    video.currentTime = pct * video.duration;
    showToast(`${pct * 100}%`);
  }
});

// ── Touch support ─────────────────────────────────────────────────────────────────────
if (isMobile) {
  const SWIPE_THRESHOLD = 10; // px before a touch is considered a swipe

  let touchStartX = 0;
  let touchStartY = 0;
  let touchMoved = false;
  let swipeActive = false;
  let swipeStartVol = 0;
  let swipeStartTime = 0;

  // ── Progress bar touch ──────────────────────────────────────────────────────────
  progWrap.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      isDragging = true;
      const rect = progWrap.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width));
      applyProgress(frac);
      showUI();
    },
    { passive: false },
  );

  progWrap.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();
      if (!isDragging) return;
      const rect = progWrap.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width));
      applyProgress(frac);
      curTime.textContent = fmt(frac * (video.duration || 0));
      timeTip.textContent = fmt(frac * (video.duration || 0));
      timeTip.style.left = e.touches[0].clientX - rect.left + "px";
    },
    { passive: false },
  );

  progWrap.addEventListener("touchend", (e) => {
    if (!isDragging) return;
    isDragging = false;
    const rect = progWrap.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.changedTouches[0].clientX - rect.left) / rect.width));
    video.currentTime = frac * video.duration;
    showUI();
  });

  // ── Video area tap and swipe ───────────────────────────────────────────────
  wrap.addEventListener(
    "touchstart",
    (e) => {
      if (e.target.closest("#controls, .menu-popup")) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchMoved = false;
      swipeActive = false;
      swipeStartVol = video.volume;
      swipeStartTime = video.currentTime;
    },
    { passive: true },
  );

  wrap.addEventListener(
    "touchmove",
    (e) => {
      if (e.target.closest("#controls, .menu-popup, #progress-wrap, .cc-slider")) return;
      const dx = e.touches[0].clientX - touchStartX;
      const dy = e.touches[0].clientY - touchStartY;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);

      if (adx > SWIPE_THRESHOLD || ady > SWIPE_THRESHOLD) touchMoved = true;

      // Vertical swipe only (ignore horizontal to avoid fighting scroll)
      if (ady > SWIPE_THRESHOLD && ady > adx * 1.5) {
        e.preventDefault();
        swipeActive = true;
        const rect = wrap.getBoundingClientRect();
        const rightHalf = touchStartX > rect.left + rect.width / 2;

        if (rightHalf) {
          // Right half → volume: 200px = full range
          const newVol = Math.max(0, Math.min(1, swipeStartVol + -dy / 200));
          video.volume = newVol;
          showToast(`Volume ${Math.round(newVol * 100)}%`);
        } else {
          // Left half → seek: 150px = 30s
          const delta = (-dy / 150) * 30;
          const newTime = Math.max(0, Math.min(video.duration, swipeStartTime + delta));
          video.currentTime = newTime;
          const secs = Math.round(Math.abs(delta));
          flashSeek(delta >= 0 ? `+${secs}s` : `−${secs}s`);
        }
        showUI();
      }
    },
    { passive: false },
  );

  wrap.addEventListener(
    "touchend",
    (e) => {
      if (e.target.closest("#controls, .menu-popup, #progress-wrap, .cc-slider")) return;
      if (swipeActive) {
        swipeActive = false;
        showUI();
        return;
      }
      if (touchMoved) {
        showUI();
        return;
      }

      // Clean tap on video area
      const uiVisible = wrap.classList.contains("ui-visible");
      if (!uiVisible) {
        // First tap: show UI, don't toggle play
        showUI();
      } else if (isAnyMenuOpen()) {
        // Menu open: close it, keep UI
        closeAllMenus();
        showUI();
      } else {
        // UI visible, no menu: toggle play
        togglePlay();
        showUI();
      }
    },
    { passive: true },
  );

  // Reset UI timer whenever any control is interacted with
  wrap.addEventListener(
    "touchend",
    (e) => {
      if (e.target.closest(".ctrl-btn, .menu-toggle, .menu-item, .cc-slider")) showUI();
    },
    { passive: true },
  );
}
