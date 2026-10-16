import "./warn-shim.js?v=prechat-20261016-dd37ee5";
import { parseFrameRate } from "./frame-step.js?v=progress-hover-removed-v4";

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
    if (typeof o.smoothPause === "boolean") prefs.smoothPause = o.smoothPause;
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

const CC_DEFAULTS = Object.freeze({
  enabled: true,
  brightness: 1,
  contrast: 1.7,
  saturation: 1.3,
});

let ccState = { ...CC_DEFAULTS };

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
  ccBtn.dispatchEvent(new CustomEvent("aida:setting-change", { bubbles: true }));
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

export function markCcBannerMenuUsed(wrap) {
  wrap.querySelector("#cc-notice")?.remove();
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

async function loadSource(meta, base, preferCodec, preferProtocol, ctx, { preservePlayback = false } = {}) {
  const chosen = await selectSource(meta, base, preferCodec, preferProtocol);
  if (!chosen) {
    throw reportPlaybackError(
      "This browser cannot play the available video formats. Try another browser or device.",
      "unsupported",
    );
  }

  currentMeta = meta;
  currentBase = base;
  currentCodec = chosen.codec;
  currentProtocol = chosen.protocol;

  const { codecBadge, protocolBadge } = ctx;
  codecBadge.textContent = chosen.codec;
  protocolBadge.textContent = chosen.protocol;
  codecBadge.classList.add("show");
  protocolBadge.classList.add("show");

  window.dispatchEvent(new CustomEvent("aida:source-changing"));
  const playbackRate = PLAYBACK_SPEEDS.has(ctx.video.playbackRate)
    ? ctx.video.playbackRate : (loadPlayerPrefs()?.speed ?? 1);
  const previous = preservePlayback ? {
    time: Number.isFinite(ctx.video.currentTime) ? ctx.video.currentTime : 0,
    paused: ctx.video.paused,
  } : null;
  try {
    await player.load(chosen.src, previous?.time ?? null, chosen.mime);
    ctx.video.playbackRate = playbackRate;
    if (previous) {
      if (previous.paused) ctx.video.pause();
      else await ctx.video.play();
    }
    window.dispatchEvent(new CustomEvent("aida:playback-ready"));
  } catch (e) {
    console.error("Load failed", e);
    ctx.spinner.classList.remove("show");
    throw reportPlaybackError("The video could not be loaded. Check your connection and try again.");
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
  ctx.video.volume = profile.hideVolumeChrome ? 1.0 : (prefs?.volume ?? 0.5);
  ctx.video.muted = prefs?.muted ?? false;
  ctx.video.playbackRate = prefs?.speed ?? 1;
  if (profile.hideVolumeChrome) ctx.volCluster.style.display = "none";
  else ctx.volCluster.style.display = "";

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

export function getPlaybackFrameRate() {
  const active = player?.getVariantTracks().find((track) => track.active);
  return parseFrameRate(active?.frameRate) ?? parseFrameRate(currentMeta?.frameRate);
}

function displayFrameRate(rate) {
  const value = parseFrameRate(rate);
  return value ? String(Number(value.toFixed(3))) : "";
}

function settingsChanged(ctx) {
  ctx.qualLabel.dispatchEvent(new CustomEvent("aida:setting-change", { bubbles: true }));
}

function buildQualityMenu(ctx) {
  if (!player) return;

  const { qualMenu } = ctx;
  const content = qualMenu.querySelector("#quality-menu-content") || qualMenu;
  const focused = document.activeElement;
  const focusedLabel = content.contains(focused) ? focused.getAttribute("aria-label") : null;
  const focusedId = content.contains(focused) ? focused.dataset.id : null;
  const advancedWasOpen = content.querySelector("details")?.open ?? false;
  const restoreFocus = () => {
    if (qualMenu.hidden || (!focusedLabel && focusedId == null)) return;
    [...content.querySelectorAll("button")].find((button) => focusedLabel
      ? button.getAttribute("aria-label") === focusedLabel
      : button.dataset.id === focusedId)?.focus();
  };
  content.replaceChildren();

  const tracks = player.getVariantTracks()
    .filter((track) => track.height)
    .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);

  const check = '<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
  const autoItem = document.createElement("button");
  autoItem.type = "button";
  autoItem.className = "menu-item" + (selectedQuality === -1 ? " active" : "");
  autoItem.dataset.id = "-1";
  autoItem.id = "quality-auto-item";
  autoItem.setAttribute("aria-pressed", String(selectedQuality === -1));
  autoItem.innerHTML = `${check}<span class="quality-option-label">Auto</span><span class="menu-badge" id="quality-auto-badge">ABR</span>`;
  autoItem.addEventListener("click", () => selectQuality(-1, ctx));
  content.appendChild(autoItem);

  tracks.forEach((track) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "menu-item";
    item.dataset.id = String(track.id);
    const kbps = Math.round(track.bandwidth / 1000);
    const fps = displayFrameRate(track.frameRate || currentMeta?.frameRate);
    item.setAttribute("aria-label", `${track.height}p${fps ? ` at ${fps} frames per second` : ""}`);
    item.setAttribute("aria-pressed", "false");
    item.innerHTML = `${check}<span class="quality-option-label">${track.height}p${fps ? `<span class="quality-fps">${fps} fps</span>` : ""}</span><span class="menu-badge">${kbps > 1000 ? (kbps / 1000).toFixed(1) + " Mbps" : kbps + " kbps"}</span>`;
    item.addEventListener("click", () => selectQuality(track.id, ctx));
    content.appendChild(item);
  });

  const advanced = document.createElement("details");
  advanced.className = "playback-advanced";
  advanced.open = advancedWasOpen;
  const summary = document.createElement("summary");
  summary.textContent = "Advanced playback";
  advanced.appendChild(summary);
  const addChoice = (title, choices, selected, enabled, choose) => {
    const header = document.createElement("div");
    header.className = "menu-header";
    header.textContent = title;
    advanced.appendChild(header);
    const row = document.createElement("div");
    row.className = "menu-toggle-row";
    choices.forEach((value) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "menu-toggle" + (selected === value ? " active" : "");
      button.textContent = value;
      button.setAttribute("aria-label", `${value} ${title === "Codec" ? "codec" : "streaming protocol"}`);
      button.setAttribute("aria-pressed", String(selected === value));
      button.disabled = !enabled(value);
      button.addEventListener("click", async () => {
        if (button.disabled || selected === value) return;
        row.querySelectorAll("button").forEach((choice) => { choice.disabled = true; });
        try { await choose(value); } catch {}
        finally {
          row.querySelectorAll("button").forEach((choice) => {
            choice.disabled = !enabled(choice.textContent);
          });
        }
      });
      row.appendChild(button);
    });
    advanced.appendChild(row);
  };
  addChoice("Codec", ["AV1", "HEVC"], currentCodec,
    (value) => (currentMeta?.codecs || []).includes(value),
    (value) => loadSource(currentMeta, currentBase, value, currentProtocol, ctx, { preservePlayback: true }));
  addChoice("Protocol", ["DASH", "HLS"], currentProtocol, () => true,
    (value) => loadSource(currentMeta, currentBase, currentCodec, value, ctx, { preservePlayback: true }));
  content.appendChild(advanced);

  if (selectedHeight !== null) {
    const target = tracks.find((track) => track.height === selectedHeight);
    if (target) {
      selectedQuality = target.id;
      player.configure("abr.enabled", false);
      player.selectVariantTrack(target, true);
      ctx.qualLabel.textContent = trackLabel(target);
      content.querySelectorAll(".menu-item").forEach((item) => {
        const active = Number(item.dataset.id) === target.id;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      persistPlayerPrefs();
      settingsChanged(ctx);
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
  const fps = displayFrameRate(track.frameRate || currentMeta?.frameRate);
  return `${track.height}p${fps ? ` \u00b7 ${fps} fps` : ""}`;
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
  settingsChanged(ctx);
}

function updateQualityLabel(ctx) {
  if (selectedQuality !== -1 || !player) return;
  const active = player.getVariantTracks().find((t) => t.active);
  const label = active ? trackLabel(active) : null;
  ctx.qualLabel.textContent = label ? `Auto · ${label}` : "Auto";
  const autoBadge = document.getElementById("quality-auto-badge");
  if (autoBadge) autoBadge.textContent = label ?? "ABR";
  settingsChanged(ctx);
}
