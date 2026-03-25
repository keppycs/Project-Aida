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
const H265_CODEC = 'video/mp4; codecs="hvc1.1.6.H150.B0"';

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
const supportsH265Dash = () => canDecode("media-source", H265_CODEC);
const supportsH265Hls = () => canDecode("file", H265_CODEC);

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
const tmBtn = document.getElementById("tm-btn");

// ── State ──────────────────────────────────────────────────────────────────────
let player,
  uiTimer,
  isDragging = false,
  selectedQuality = -1, // -1 = auto, or Shaka track ID (current stream only)
  selectedHeight = null, // persists across codec/protocol switches; null = auto
  currentMeta = null,
  currentBase = null,
  currentCodec = null, // "AV1" | "H265"
  currentProtocol = null; // "DASH" | "HLS"

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
  const hasH265 = meta.codecs.includes("H265");

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
  if (hasH265) {
    if (await supportsH265Dash())
      candidates.push({
        codec: "H265",
        protocol: "DASH",
        src: `${base}/H265/manifest.mpd`,
        mime: "application/dash+xml",
      });
    if (await supportsH265Hls())
      candidates.push({
        codec: "H265",
        protocol: "HLS",
        src: `${base}/H265/master.m3u8`,
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

  codecBadge.textContent = chosen.codec === "H265" ? "H.265" : chosen.codec;
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
    if (!hdrCapable) {
      const saved = localStorage.getItem("tm-filter");
      const on = saved === "enabled"; // default OFF
      tmBtn.style.display = "";
      applyTonemapping(on);
      updateTmBtn(on);
      if (!localStorage.getItem("tm-filter-noticed")) {
        showTmNotice();
        localStorage.setItem("tm-filter-noticed", "1");
      }
    }
  }

  await loadSource(meta, base, null, null);
}

// ── Tonemapping ────────────────────────────────────────────────────────────────
function applyTonemapping(on) {
  video.style.filter = on ? "brightness(1) contrast(1.7) saturate(1.3)" : "";
}

function updateTmBtn(on) {
  tmBtn.classList.toggle("active", on);
  tmBtn.title = on ? "Tonemapping: ON" : "Tonemapping: OFF";
}

function showTmNotice() {
  const notice = document.createElement("div");
  notice.id = "tm-notice";
  notice.innerHTML = `
    <span>HDR display not detected. If colours look washed out, use the <strong>Tonemapping</strong> button to enable it.</span>
    <button id="tm-notice-close">✕</button>
  `;
  wrap.appendChild(notice);
  document.getElementById("tm-notice-close").addEventListener("click", () => notice.remove());
  setTimeout(() => notice?.remove(), 10000);
}

function showUnsupportedNotice() {
  const notice = document.createElement("div");
  notice.id = "tm-notice";
  notice.innerHTML = `
    <span>Your browser or device does not support any available video codec. Try a different browser.</span>
    <button id="tm-notice-close">✕</button>
  `;
  wrap.appendChild(notice);
  document.getElementById("tm-notice-close").addEventListener("click", () => notice.remove());
}

tmBtn.addEventListener("click", () => {
  const on = video.style.filter === "";
  applyTonemapping(on);
  updateTmBtn(on);
  localStorage.setItem("tm-filter", on ? "enabled" : "disabled");
});

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
  return qualMenu.classList.contains("open") || speedMenu.classList.contains("open");
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
    ["H265", "H.265"],
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
      return;
    }
    // Height no longer exists in this stream — fall back to auto
    selectedHeight = null;
  }

  selectedQuality = -1;
  player.configure("abr.enabled", true);
  updateQualityLabel();
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
      if (e.target.closest("#controls, .menu-popup, #progress-wrap")) return;
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
      if (e.target.closest("#controls, .menu-popup, #progress-wrap")) return;
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
      if (e.target.closest(".ctrl-btn, .menu-toggle, .menu-item")) showUI();
    },
    { passive: true },
  );
}
