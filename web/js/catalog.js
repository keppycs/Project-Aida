/** Shared public catalogue, safe links, and thumbnail rendering for both pages. */
export const CDN_BASE = "https://cdn.keppy.dev/file/ProjectAida";

function defaultLocal() {
  return typeof window.isAidaLiveSite === "function"
    ? !window.isAidaLiveSite()
    : !["keppy.dev", "www.keppy.dev"].includes(location.hostname);
}

export function videoVisibility(video) {
  if (["public", "unlisted", "private"].includes(video.visibility)) return video.visibility;
  return video.unlisted ? "unlisted" : "public";
}

export function isPublicVideo(video) {
  return videoVisibility(video) === "public";
}

export function mediaBase(videoId, { local = defaultLocal() } = {}) {
  return `${local ? "./local" : CDN_BASE}/${encodeURIComponent(videoId)}`;
}

export function watchUrl(videoId, { local = defaultLocal() } = {}) {
  return `watch.html?v=${encodeURIComponent(videoId)}${local ? "&local=1" : ""}`;
}

export async function fetchCatalog({ local = defaultLocal() } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(local ? "./local/index.json" : `${CDN_BASE}/index.json`, {
      signal: controller.signal,
      cache: "no-cache",
    });
    if (!response.ok) throw new Error(`Catalogue request failed (${response.status})`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("Invalid catalogue response");
    return data
      .filter((video) => video && typeof video.id === "string" && video.id.length && isPublicVideo(video))
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  } finally {
    clearTimeout(timeout);
  }
}

export function formatDate(timestamp) {
  if (!Number.isFinite(Number(timestamp)) || Number(timestamp) <= 0) return "";
  const date = new Date(Number(timestamp) * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

export function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return "";
  const total = Math.floor(Number(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remaining}` : `${minutes}:${remaining}`;
}

/** Wide gamut alone does not establish HDR display support. */
export async function detectDisplayHdr() {
  if (window.matchMedia("(dynamic-range: high)").matches) return true;
  const wideGamut = window.matchMedia("(color-gamut: p3)").matches || window.matchMedia("(color-gamut: rec2020)").matches;
  if (!wideGamut || !navigator.mediaCapabilities?.decodingInfo) return false;
  let timer;
  try {
    const result = await Promise.race([
      navigator.mediaCapabilities.decodingInfo({
        type: "media-source",
        video: { contentType: 'video/mp4; codecs="hvc1"', width: 1920, height: 1080, bitrate: 10000000, framerate: 60, transferFunction: "pq", colorGamut: "rec2020" },
      }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1200); }),
    ]);
    return result?.supported ?? false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function renderVideoCard(video, { hdrCapable = false, local = defaultLocal() } = {}) {
  const card = document.createElement("a");
  card.className = "video-card";
  card.href = watchUrl(video.id, { local });
  const thumbnail = document.createElement("div");
  thumbnail.className = "video-card-thumbnail";
  const image = document.createElement("img");
  const base = mediaBase(video.id, { local });
  const files = video.hdr && hdrCapable
    ? ["thumbnail_hdr_720p.avif", "thumbnail_sdr_720p.webp", "thumbnail_sdr.webp"]
    : ["thumbnail_sdr_720p.webp", "thumbnail_sdr.webp"];
  image.src = `${base}/${files.shift()}`;
  image.dataset.fallbackSources = JSON.stringify(files.map((file) => `${base}/${file}`));
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  thumbnail.append(image);
  const duration = formatDuration(video.duration);
  if (duration) {
    const badge = document.createElement("span");
    badge.className = "thumbnail-duration";
    badge.textContent = duration;
    badge.setAttribute("aria-label", `Duration ${duration}`);
    thumbnail.append(badge);
  }
  const content = document.createElement("div");
  content.className = "video-card-content";
  const title = document.createElement("h3");
  title.className = "video-card-title";
  title.textContent = video.title || "Untitled video";
  content.append(title);
  const date = formatDate(video.createdAt);
  if (date) {
    const meta = document.createElement("div");
    meta.className = "video-card-meta";
    meta.textContent = date;
    content.append(meta);
  }
  card.append(thumbnail, content);
  return card;
}

/** Fall back through SDR sizes, then show a deliberate empty-preview treatment. */
export function attachThumbnailFallbacks(container) {
  container.querySelectorAll("img[data-fallback-sources]").forEach((image) => {
    if (image.dataset.fallbackAttached) return;
    image.dataset.fallbackAttached = "true";
    const sources = JSON.parse(image.dataset.fallbackSources);
    const onError = () => {
      if (sources.length) {
        image.src = sources.shift();
        return;
      }
      const placeholder = document.createElement("div");
      placeholder.className = "thumbnail-placeholder";
      placeholder.setAttribute("aria-hidden", "true");
      const mark = document.createElement("span");
      mark.className = "thumbnail-placeholder-mark";
      mark.textContent = "a";
      const label = document.createElement("span");
      label.className = "thumbnail-placeholder-label";
      label.textContent = "Preview unavailable";
      placeholder.append(mark, label);
      image.replaceWith(placeholder);
    };
    image.addEventListener("error", onError);
    if (image.complete && !image.naturalWidth && image.currentSrc) onError();
  });
}
