import "./warn-shim.js?v=player-20261016-7b6ee24";

const AV1_CODEC = 'video/mp4; codecs="av01.0.08H.10.0.110.09.16.09.0"';
const HEVC_CODEC = 'video/mp4; codecs="hvc1.1.6.H150.B0"';

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

const HDR_TRANSFERS = new Set([
  "smpte2084",
  "arib-std-b67",
  "smpte428",
  "bt2020-10",
  "bt2020-12",
]);

let player;
let currentMeta = null;
let currentBase = null;
let currentCodec = null;
let currentProtocol = null;
let selectedQuality = -1;
let selectedHeight = null;
let sourceLoadPending = false;

const PLAYER_PREFS_KEY = "aida-player-prefs";
const PREFS_CODECS = new Set(["AV1", "HEVC"]);
const PREFS_PROTOCOLS = new Set(["DASH", "HLS"]);
const PLAYBACK_SPEEDS = new Set([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]);

export function loadPlayerPrefs() {
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
    if (typeof o.volume === "number" && Number.isFinite(o.volume) && o.volume >= 0 && o.volume <= 1)
      prefs.volume = o.volume;
    if (typeof o.muted === "boolean") prefs.muted = o.muted;
    if (typeof o.speed === "number" && PLAYBACK_SPEEDS.has(o.speed))
      prefs.speed = o.speed;
    return Object.keys(prefs).length ? prefs : null;
  } catch {
    return null;
  }
}

export function persistPlaybackPrefs(values) {
  try {
    localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify({ ...(loadPlayerPrefs() || {}), ...values }));
  } catch {}
}

function persistPlayerPrefs() {
  if (!currentCodec || !currentProtocol) return;
  persistPlaybackPrefs({
    codec: currentCodec,
    protocol: currentProtocol,
    quality: selectedHeight === null ? "auto" : selectedHeight,
  });
}

function reportPlaybackError(message, kind = "playback") {
  window.dispatchEvent(new CustomEvent("aida:playback-error", { detail: { message, kind } }));
  const error = new Error(message);
  error.kind = kind;
  return error;
}

const CC_STORAGE_KEY = "aida-color-correction";
const CC_BANNER_DISMISSED_KEY = "aida-cc-banner-dismissed";
const CC_BANNER_MENU_USED_KEY = "aida-cc-banner-menu-used";
const CC_BANNER_AUTO_MS = 30000;

const CC_DEFAULTS = Object.freeze({
  enabled: true,
  brightness: 1,
  contrast: 1.7,
  saturation: 1.3,
});

let ccState = { ...CC_DEFAULTS };
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

function applyColorCorrection(video) {
  if (!ccState.enabled) {
    video.style.filter = "";
    return;
  }
  const { brightness, contrast, saturation } = ccState;
  video.style.filter = `brightness(${brightness}) contrast(${contrast}) saturate(${saturation})`;
}

function syncCcUiFromState(ctx) {
  const {
    ccOff,
    ccOn,
    ccBrightness,
    ccContrast,
    ccSaturation,
    ccBrightnessVal,
    ccContrastVal,
    ccSaturationVal,
    ccBtn,
  } = ctx;
  ccOff.classList.toggle("active", !ccState.enabled);
  ccOn.classList.toggle("active", ccState.enabled);
  ccOff.setAttribute("aria-pressed", String(!ccState.enabled));
  ccOn.setAttribute("aria-pressed", String(ccState.enabled));
  ccBrightness.value = String(ccState.brightness);
  ccContrast.value = String(ccState.contrast);
  ccSaturation.value = String(ccState.saturation);
  ccBrightnessVal.textContent = formatCcParam(ccState.brightness);
  ccContrastVal.textContent = formatCcParam(ccState.contrast);
  ccSaturationVal.textContent = formatCcParam(ccState.saturation);
  ccBtn.classList.toggle("active", ccState.enabled);
  ccBtn.title = ccState.enabled ? "Color correction: On" : "Color correction: Off";
}

export function setCcEnabled(on, video, ctx) {
  ccState.enabled = on;
  applyColorCorrection(video);
  syncCcUiFromState(ctx);
  persistColorCorrection();
}

export function applyCcSliderChange(key, rawValue, video, ctx) {
  const v = parseFloat(rawValue);
  if (!Number.isFinite(v)) return;
  ccState[key] = v;
  if (!ccState.enabled) ccState.enabled = true;
  applyColorCorrection(video);
  syncCcUiFromState(ctx);
  persistColorCorrection();
}

function shouldShowCcBanner() {
  try {
    return !localStorage.getItem(CC_BANNER_DISMISSED_KEY) && !localStorage.getItem(CC_BANNER_MENU_USED_KEY);
  } catch {
    return false;
  }
}

function clearCcBannerTimer() {
  if (ccBannerTimer != null) {
    clearTimeout(ccBannerTimer);
    ccBannerTimer = null;
  }
}

function markCcBannerDismissed(wrap) {
  try {
    localStorage.setItem(CC_BANNER_DISMISSED_KEY, "1");
  } catch {}
  clearCcBannerTimer();
  wrap.querySelector("#cc-notice")?.remove();
}

export function markCcBannerMenuUsed(wrap) {
  try {
    localStorage.setItem(CC_BANNER_MENU_USED_KEY, "1");
  } catch {}
  clearCcBannerTimer();
  wrap.querySelector("#cc-notice")?.remove();
}

function showColorCorrectionNotice(wrap) {
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
  notice.querySelector(".player-notice-close").addEventListener("click", () => markCcBannerDismissed(wrap));
  ccBannerTimer = setTimeout(() => {
    ccBannerTimer = null;
    notice.remove();
  }, CC_BANNER_AUTO_MS);
}

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
        framerate: 120,
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

function syncSourceSwitchButtons(ctx) {
  ctx.qualMenu.setAttribute("aria-busy", String(sourceLoadPending));
  ctx.qualMenu.querySelectorAll("[data-source-switch]").forEach((button) => {
    button.disabled = sourceLoadPending || button.dataset.sourceUnavailable === "true";
  });
}

async function loadSource(meta, base, preferCodec, preferProtocol, ctx) {
  if (sourceLoadPending) return;
  const focused = document.activeElement;
  const sourceFocusLabel = ctx.qualMenu.contains(focused) && focused.matches("[data-source-switch]")
    ? focused.getAttribute("aria-label") : null;
  if (sourceFocusLabel) ctx.qualMenu.querySelector("[data-close-menu]")?.focus({ preventScroll: true });
  sourceLoadPending = true;
  syncSourceSwitchButtons(ctx);
  try {
    const chosen = await selectSource(meta, base, preferCodec, preferProtocol);
    if (!chosen) {
      throw reportPlaybackError(
        "This browser cannot play the available video formats. Try another browser or device.",
        "unsupported",
      );
    }

    const { video, codecBadge, protocolBadge } = ctx;
    const previousPlayback = currentMeta ? {
      time: Number.isFinite(video.currentTime) ? video.currentTime : null,
      paused: video.paused,
      volume: video.volume,
      muted: video.muted,
      speed: video.playbackRate,
    } : null;
    const playbackRate = PLAYBACK_SPEEDS.has(video.playbackRate)
      ? video.playbackRate : (loadPlayerPrefs()?.speed ?? 1);

    currentMeta = meta;
    currentBase = base;
    currentCodec = chosen.codec;
    currentProtocol = chosen.protocol;
    codecBadge.textContent = chosen.codec;
    protocolBadge.textContent = chosen.protocol;
    codecBadge.classList.add("show");
    protocolBadge.classList.add("show");

    try {
      await player.load(chosen.src, previousPlayback?.time ?? null, chosen.mime);
    } catch (e) {
      console.error("Load failed", e);
      ctx.spinner.classList.remove("show");
      throw reportPlaybackError("The video could not be loaded. Check your connection and try again.");
    }

    video.playbackRate = previousPlayback?.speed ?? playbackRate;
    if (previousPlayback) {
      video.volume = previousPlayback.volume;
      video.muted = previousPlayback.muted;
      if (previousPlayback.paused) video.pause();
      else {
        void video.play().catch((error) => {
          console.warn("Playback could not resume after changing video format. Press play to continue.", error);
        });
      }
    }
    window.dispatchEvent(new CustomEvent("aida:playback-ready"));
  } finally {
    sourceLoadPending = false;
    syncSourceSwitchButtons(ctx);
    if (sourceFocusLabel && !ctx.qualMenu.hidden &&
        (ctx.qualMenu.contains(document.activeElement) || document.activeElement === document.body)) {
      [...ctx.qualMenu.querySelectorAll("[data-source-switch]:not(:disabled)")]
        .find((button) => button.getAttribute("aria-label") === sourceFocusLabel)?.focus({ preventScroll: true });
    }
  }
}

export async function initPlayback(meta, base, ctx, profile) {
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) {
    throw reportPlaybackError("This browser does not support video playback. Try another browser.", "unsupported");
  }

  player = new shaka.Player();
  await player.attach(ctx.video);

  const prefs = loadPlayerPrefs();
  ctx.video.volume = prefs?.volume ?? 0.5;
  ctx.video.muted = prefs?.muted ?? false;
  ctx.video.playbackRate = prefs?.speed ?? 1;

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

  player.addEventListener("error", (e) => {
    console.error("Shaka error", e.detail);
    if (e.detail?.severity === shaka.util.Error.Severity.CRITICAL) {
      ctx.spinner.classList.remove("show");
      reportPlaybackError("Playback stopped. Check your connection and try again.");
    }
  });
  player.addEventListener("buffering", (e) => ctx.spinner.classList.toggle("show", e.buffering));
  player.addEventListener("adaptation", () => updateQualityLabel(ctx));
  player.addEventListener("variantchanged", () => updateQualityLabel(ctx));
  player.addEventListener("trackschanged", () => buildQualityMenu(ctx));

  ctx.titleText.textContent = meta.title;

  const localBadge = document.getElementById("local-badge");
  if (localBadge) {
    let isLocal = false;
    try {
      const resolved = new URL(base, location.href);
      isLocal = resolved.pathname.includes("/local/");
    } catch {
      isLocal = String(base).includes("/local/");
    }
    localBadge.classList.toggle("show", isLocal);
  }

  const isHdr = HDR_TRANSFERS.has(meta.colorTransfer);
  const { hdrBadge } = ctx;
  hdrBadge.textContent = isHdr ? "HDR" : "SDR";
  hdrBadge.classList.toggle("sdr", !isHdr);
  hdrBadge.classList.add("show");
  if (isHdr) {
    const hdrCapable = await detectHDR();
    if (hdrCapable) {
      ctx.ccWrap.style.display = "none";
      ctx.video.style.filter = "";
    } else {
      ccState = loadColorCorrectionState();
      syncCcUiFromState(ctx);
      applyColorCorrection(ctx.video);
      ctx.ccWrap.style.display = "";
      if (shouldShowCcBanner()) showColorCorrectionNotice(ctx.wrap);
    }
  }

  if (prefs) {
    if (prefs.quality === "auto") {
      selectedHeight = null;
      selectedQuality = -1;
    } else if (typeof prefs.quality === "number") {
      selectedHeight = prefs.quality;
    }
  }

  await loadSource(meta, base, prefs?.codec ?? null, prefs?.protocol ?? null, ctx);
}

function buildQualityMenu(ctx) {
  if (!player) return;

  const { qualMenu } = ctx;
  const focused = document.activeElement;
  const focusedLabel = qualMenu.contains(focused) ? focused.getAttribute("aria-label") : null;
  const focusedId = qualMenu.contains(focused) ? focused.dataset.id : null;
  const restoreFocus = () => {
    if (qualMenu.hidden || (!focusedLabel && focusedId == null)) return;
    [...qualMenu.querySelectorAll("button")].find((button) => focusedLabel
      ? button.getAttribute("aria-label") === focusedLabel
      : button.dataset.id === focusedId)?.focus();
  };
  qualMenu.innerHTML = "";

  const heading = document.createElement("div");
  heading.className = "menu-heading";
  const title = document.createElement("span");
  title.textContent = "Video quality";
  const closeButton = document.createElement("button");
  closeButton.className = "menu-close";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Close video quality");
  closeButton.dataset.closeMenu = "";
  closeButton.textContent = "×";
  heading.append(title, closeButton);
  qualMenu.appendChild(heading);

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
    btn.type = "button";
    btn.className = "menu-toggle" + (currentCodec === value ? " active" : "");
    btn.textContent = label;
    btn.dataset.sourceSwitch = "codec";
    btn.setAttribute("aria-label", `${label} codec`);
    btn.setAttribute("aria-pressed", String(currentCodec === value));
    if (!codecs.includes(value)) {
      btn.disabled = true;
      btn.dataset.sourceUnavailable = "true";
      btn.classList.add("disabled");
    }
    btn.addEventListener("click", async () => {
      if (btn.disabled || currentCodec === value) return;
      try { await loadSource(currentMeta, currentBase, value, currentProtocol, ctx); } catch {}
    });
    codecRow.appendChild(btn);
  });
  qualMenu.appendChild(codecRow);

  const protHeader = document.createElement("div");
  protHeader.className = "menu-header";
  protHeader.textContent = "Protocol";
  qualMenu.appendChild(protHeader);

  const protRow = document.createElement("div");
  protRow.className = "menu-toggle-row";

  ["DASH", "HLS"].forEach((value) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-toggle" + (currentProtocol === value ? " active" : "");
    btn.textContent = value;
    btn.dataset.sourceSwitch = "protocol";
    btn.setAttribute("aria-label", `${value} streaming protocol`);
    btn.setAttribute("aria-pressed", String(currentProtocol === value));
    btn.addEventListener("click", async () => {
      if (currentProtocol === value) return;
      try { await loadSource(currentMeta, currentBase, currentCodec, value, ctx); } catch {}
    });
    protRow.appendChild(btn);
  });
  qualMenu.appendChild(protRow);
  syncSourceSwitchButtons(ctx);

  const qualHeader = document.createElement("div");
  qualHeader.className = "menu-header";
  qualHeader.textContent = "Quality";
  qualMenu.appendChild(qualHeader);

  const tracks = player
    .getVariantTracks()
    .filter((t) => t.height)
    .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);

  const autoItem = document.createElement("button");
  autoItem.type = "button";
  autoItem.className = "menu-item" + (selectedQuality === -1 ? " active" : "");
  autoItem.dataset.id = "-1";
  autoItem.id = "quality-auto-item";
  autoItem.setAttribute("aria-pressed", String(selectedQuality === -1));
  autoItem.innerHTML = `
    <svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
    Auto
    <span class="menu-badge" id="quality-auto-badge">ABR</span>`;
  autoItem.addEventListener("click", () => selectQuality(-1, ctx));
  qualMenu.appendChild(autoItem);

  tracks.forEach((track) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "menu-item";
    item.dataset.id = String(track.id);

    const kbps = Math.round(track.bandwidth / 1000);
    const fps = Math.round(track.frameRate || currentMeta?.frameRate || 0) || "";
    const label = `${String(track.height).padStart(4, "\u00A0")}p${fps}`;
    item.setAttribute("aria-label", `${track.height}p${fps ? ` at ${fps} frames per second` : ""}`);
    item.setAttribute("aria-pressed", "false");

    item.innerHTML = `
      <svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      ${label}
      <span class="menu-badge">${kbps > 1000 ? (kbps / 1000).toFixed(1) + " Mbps" : kbps + " kbps"}</span>`;
    item.addEventListener("click", () => selectQuality(track.id, ctx));
    qualMenu.appendChild(item);
  });

  if (selectedHeight !== null) {
    const target = tracks.find((t) => t.height === selectedHeight);
    if (target) {
      selectedQuality = target.id;
      player.configure("abr.enabled", false);
      player.selectVariantTrack(target, true);
      ctx.qualLabel.textContent = trackLabel(target);
      qualMenu.querySelectorAll(".menu-item").forEach((item) => {
        item.classList.toggle("active", parseInt(item.dataset.id, 10) === target.id);
        item.setAttribute("aria-pressed", String(parseInt(item.dataset.id, 10) === target.id));
      });
      persistPlayerPrefs();
      restoreFocus();
      return;
    }
    selectedHeight = null;
  }

  selectedQuality = -1;
  autoItem.classList.add("active");
  autoItem.setAttribute("aria-pressed", "true");
  player.configure("abr.enabled", true);
  updateQualityLabel(ctx);
  persistPlayerPrefs();
  restoreFocus();
}

function trackLabel(track) {
  const fps = Math.round(track.frameRate || currentMeta?.frameRate || 0);
  return `${track.height}p${fps || ""}`;
}

function selectQuality(id, ctx) {
  selectedQuality = id;
  if (id === -1) {
    selectedHeight = null;
    player.configure("abr.enabled", true);
    ctx.qualLabel.textContent = "Auto";
  } else {
    player.configure("abr.enabled", false);
    const track = player.getVariantTracks().find((t) => t.id === id);
    if (track) {
      selectedHeight = track.height;
      player.selectVariantTrack(track, true);
      ctx.qualLabel.textContent = trackLabel(track);
    }
  }
  ctx.qualMenu.querySelectorAll(".menu-item").forEach((item) => {
    item.classList.toggle("active", parseInt(item.dataset.id, 10) === id);
    item.setAttribute("aria-pressed", String(parseInt(item.dataset.id, 10) === id));
  });
  persistPlayerPrefs();
}

function updateQualityLabel(ctx) {
  if (selectedQuality !== -1 || !player) return;
  const active = player.getVariantTracks().find((t) => t.active);
  const label = active ? trackLabel(active) : null;
  ctx.qualLabel.textContent = label ? `Auto · ${label}` : "Auto";
  const autoBadge = document.getElementById("quality-auto-badge");
  if (autoBadge) autoBadge.textContent = label ?? "ABR";
}
