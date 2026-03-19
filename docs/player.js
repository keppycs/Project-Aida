// ── Codec detection ─────────────────────────────────────────────────────────────
const AV1_CODEC = 'video/mp4; codecs="av01.0.08H.10.0.110.09.16.09.0"';
const H265_CODEC = 'video/mp4; codecs="hvc1.1.6.H150.B0"';

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
    return (r?.supported && r?.smooth) ?? false;
  } catch {
    return false;
  }
}

const supportsAV1Dash = () => canDecode("media-source", AV1_CODEC);
const supportsAV1Hls = () => canDecode("file", AV1_CODEC);
const supportsH265Dash = () => canDecode("media-source", H265_CODEC);
const supportsH265Hls = () => canDecode("file", H265_CODEC);

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
  selectedQuality = -1; // -1 = auto

// ── Display HDR detection ─────────────────────────────────────────────────────
// Detects whether the *display* is HDR-capable, not the content.
// Used to decide whether to show the tonemapping button.
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
    signals.mediaCapabilities = r?.supported && r?.smooth;
  } catch {}

  const isHDR = signals.dynamicRange || (signals.mediaCapabilities && signals.wideGamut);
  console.debug("[HDR detect]", signals, "→", isHDR);
  return isHDR;
}

// ── Init ───────────────────────────────────────────────────────────────────────
// meta: parsed metadata.json
// base: base URL for manifest paths, no trailing slash
async function init(meta, base) {
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) {
    alert("Your browser does not support this player.");
    return;
  }

  player = new shaka.Player();
  await player.attach(video);
  video.volume = 0.5;

  player.configure({
    streaming: {
      bufferingGoal: 12,
      rebufferingGoal: 2,
      bufferBehind: 30,
      safeSeekOffset: 2,
    },
    abr: {
      enabled: true,
      defaultBandwidthEstimate: 50000000,
      bandwidthUpgradeTarget: 0.85,
      bandwidthDowngradeTarget: 0.95,
    },
  });

  player.addEventListener("error", (e) => console.error("Shaka error", e.detail));
  player.addEventListener("buffering", (e) => spinner.classList.toggle("show", e.buffering));
  player.addEventListener("adaptation", updateQualityLabel);
  player.addEventListener("variantchanged", updateQualityLabel);

  titleText.textContent = meta.title;

  const hasAV1 = meta.codecs.includes("AV1");
  const hasH265 = meta.codecs.includes("H265");

  let src, mime, codecLabel, protocolLabel;

  if (hasAV1 && (await supportsAV1Dash())) {
    src = `${base}/AV1/manifest.mpd`;
    mime = "application/dash+xml";
    codecLabel = "AV1";
    protocolLabel = "DASH";
  } else if (hasAV1 && (await supportsAV1Hls())) {
    src = `${base}/AV1/master.m3u8`;
    mime = "application/x-mpegURL";
    codecLabel = "AV1";
    protocolLabel = "HLS";
  } else if (hasH265 && (await supportsH265Dash())) {
    src = `${base}/H265/manifest.mpd`;
    mime = "application/dash+xml";
    codecLabel = "H.265";
    protocolLabel = "DASH";
  } else if (hasH265 && (await supportsH265Hls())) {
    src = `${base}/H265/master.m3u8`;
    mime = "application/x-mpegURL";
    codecLabel = "H.265";
    protocolLabel = "HLS";
  } else {
    showUnsupportedNotice();
    return;
  }

  codecBadge.textContent = codecLabel;
  protocolBadge.textContent = protocolLabel;
  codecBadge.classList.add("show");
  protocolBadge.classList.add("show");

  try {
    await player.load(src, null, mime);
    buildQualityMenu();
  } catch (e) {
    console.error("Load failed", e);
  }

  // ── HDR from stream — detect post-load from track metadata ──────────────────
  const tracks = player.getVariantTracks();
  const isHdr = tracks.some((t) => t.hdr === "PQ" || t.hdr === "HLG");

  if (isHdr) {
    hdrBadge.classList.add("show");
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
video.addEventListener("click", togglePlay);

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
  const frac = video.currentTime / video.duration;
  applyProgress(frac);
  curTime.textContent = fmt(video.currentTime);
  if (video.buffered.length) {
    const end = video.buffered.end(video.buffered.length - 1);
    progBuf.style.width = (end / video.duration) * 100 + "%";
  }
});

video.addEventListener("loadedmetadata", () => {
  durTime.textContent = fmt(video.duration);
});

progWrap.addEventListener("mousemove", (e) => {
  const frac = getProgressX(e);
  const rect = progWrap.getBoundingClientRect();
  timeTip.textContent = fmt(frac * (video.duration || 0));
  timeTip.style.left = e.clientX - rect.left + "px";
});

progWrap.addEventListener("mousedown", (e) => {
  isDragging = true;
  applyProgress(getProgressX(e));
});

document.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  const frac = getProgressX(e);
  applyProgress(frac);
  curTime.textContent = fmt(frac * (video.duration || 0));
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
  if (!video.paused) uiTimer = setTimeout(hideUI, 3000);
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
  const tracks = player
    .getVariantTracks()
    .filter((t) => t.height)
    .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);

  qualMenu.innerHTML = '<div class="menu-header">Quality</div>';

  const autoItem = document.createElement("button");
  autoItem.className = "menu-item active";
  autoItem.dataset.id = "-1";
  autoItem.innerHTML = `
    <svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
    Auto
    <span class="menu-badge">ABR</span>`;
  autoItem.addEventListener("click", () => selectQuality(-1));
  qualMenu.appendChild(autoItem);

  const heightCount = {};
  tracks.forEach((t) => {
    heightCount[t.height] = (heightCount[t.height] || 0) + 1;
  });
  const heightSeen = {};

  tracks.forEach((track) => {
    const item = document.createElement("button");
    item.className = "menu-item";
    item.dataset.id = track.id;

    const kbps = Math.round(track.bandwidth / 1000);
    const fps = track.frameRate ? Math.round(track.frameRate) : "";

    heightSeen[track.height] = (heightSeen[track.height] || 0) + 1;
    const isDupe = heightCount[track.height] > 1;
    const isFirst = heightSeen[track.height] === 1;
    const label = `${String(track.height).padStart(4, "\u00A0")}p${fps}${isDupe && isFirst ? " Max" : ""}`;

    item.innerHTML = `
      <svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      ${label}
      <span class="menu-badge">${kbps > 1000 ? (kbps / 1000).toFixed(1) + " Mbps" : kbps + " kbps"}</span>`;
    item.addEventListener("click", () => selectQuality(track.id));
    qualMenu.appendChild(item);
  });

  updateQualityLabel();
}

function selectQuality(id) {
  selectedQuality = id;
  if (id === -1) {
    player.configure("abr.enabled", true);
    qualLabel.textContent = "Auto";
  } else {
    player.configure("abr.enabled", false);
    const track = player.getVariantTracks().find((t) => t.id === id);
    if (track) {
      player.selectVariantTrack(track, true);
      qualLabel.textContent = track.height + "p";
    }
  }
  qualMenu.querySelectorAll(".menu-item").forEach((item) => {
    item.classList.toggle("active", parseInt(item.dataset.id) === id);
  });
  closeAllMenus();
}

function updateQualityLabel() {
  if (selectedQuality !== -1 || !player) return;
  const active = player.getVariantTracks().find((t) => t.active);
  if (active) qualLabel.textContent = "Auto · " + active.height + "p";
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
