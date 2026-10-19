import {
  fetchCatalog, mediaBase, formatDate,
  renderVideoCard, detectDisplayHdr, attachThumbnailFallbacks,
} from "./catalog.js?v=master-tags-v1";
import { browseQuery, videosUrl, withBrowseQuery, requestBrowseReturn } from "./browse-context.js?v=ux-baseline-v2";
import { registryFromVideos, resolveVideoTags } from "./tags.js?v=master-tags-v1";
import { tagQuery } from "./search.js?v=master-tags-v1";
import { loadMetadata, VideoLoadError } from "./loader.js?v=cdn-security-v1";
import { mountPlayer } from "./player/shell.js?v=overlay-scrollbar-v36";

const id = new URLSearchParams(location.search).get("v") || "0";
const originatingQuery = browseQuery(location.search);
for (const link of document.querySelectorAll(".back-link, #watch-status-videos")) {
  link.href = videosUrl(originatingQuery);
  for (const type of ["click", "auxclick"]) link.addEventListener(type, () => requestBrowseReturn(originatingQuery));
}
const local = typeof window.shouldUseLocalCmaf === "function" && window.shouldUseLocalCmaf();
const base = mediaBase(id, { local });
const stage = document.getElementById("watch-stage");
const playerWrap = document.getElementById("player-wrap");
const video = document.getElementById("video");
const status = document.getElementById("watch-status");
const retryButton = document.getElementById("watch-retry");
let currentMeta = null;
let catalog = [];
let playbackFailed = false;

function showFailure(kind, message) {
  const playerHadFocus = playerWrap.contains(document.activeElement);
  playbackFailed = true;
  stage.setAttribute("aria-busy", "false");
  playerWrap.inert = true;
  video.pause();
  status.hidden = false;
  status.classList.add("is-error");
  document.getElementById("watch-status-spinner").hidden = true;
  const descriptions = {
    not_found: "This link may be out of date, or the video may have been removed.",
    private: "This video isn't available to watch here.",
    invalid: "We couldn't read this video's information. Try again in a moment.",
    unsupported: "Your browser couldn't play the available formats. Try another browser or device.",
    network: "Check your connection and try again.",
    playback: "Playback was interrupted. Try loading the video again.",
  };
  const titles = {
    not_found: "Video not found", private: "This video is private", invalid: "Video unavailable",
    network: "Couldn't load video", unsupported: "Playback unavailable", playback: "Couldn't play video",
  };
  document.getElementById("watch-status-title").textContent = message || titles[kind] || titles.playback;
  document.getElementById("watch-status-detail").textContent = descriptions[kind] || descriptions.playback;
  retryButton.hidden = kind === "private" || kind === "not_found" || kind === "unsupported";
  document.getElementById("watch-status-videos").hidden = false;
  if (playerHadFocus) {
    (retryButton.hidden ? document.getElementById("watch-status-videos") : retryButton).focus({ preventScroll: true });
  }
  if (!currentMeta) document.getElementById("watch-title").textContent = titles[kind] || "Video unavailable";
  if (document.fullscreenElement === playerWrap) void document.exitFullscreen().catch(() => {});
  if (video.webkitDisplayingFullscreen && typeof video.webkitExitFullscreen === "function") {
    try { video.webkitExitFullscreen(); } catch {}
  }
}

function renderDetails(meta) {
  // Descriptions and tags currently live in the catalog, while playback data lives in metadata.
  const entry = catalog.find((item) => String(item.id) === id);
  document.title = `${meta.title} · Aida`;
  document.getElementById("watch-title").textContent = meta.title;
  const metaRow = document.getElementById("watch-meta");
  metaRow.replaceChildren();
  const date = formatDate(meta.createdAt || entry?.createdAt);
  for (const text of [date]) {
    if (!text) continue;
    const span = document.createElement("span");
    span.textContent = text;
    metaRow.append(span);
  }
  const description = document.getElementById("watch-description");
  const descriptionText = meta.description ?? entry?.description;
  description.textContent = typeof descriptionText === "string" ? descriptionText : "";
  description.hidden = !description.textContent.trim();
  const tagList = document.getElementById("watch-tags");
  tagList.replaceChildren();
  const taggedVideo = { ...entry, ...meta, tags: meta.tags ?? entry?.tags };
  if (Object.hasOwn(meta, "tags") && !Object.hasOwn(meta, "tagIds")) delete taggedVideo.tagIds;
  const registry = registryFromVideos([taggedVideo, ...catalog]);
  const tags = resolveVideoTags(taggedVideo, registry);
  if (tags.length) {
    for (const tag of tags) {
      const link = document.createElement("a");
      link.href = videosUrl(tagQuery(tag.name));
      link.textContent = tag.name;
      tagList.append(link);
    }
  }
  tagList.hidden = !tagList.childElementCount;
}

async function renderMoreVideos() {
  const others = catalog.filter((item) => String(item.id) !== id).slice(0, 4);
  if (!others.length) return;
  const hdrCapable = await detectDisplayHdr().catch(() => false);
  const grid = document.getElementById("more-videos-grid");
  grid.replaceChildren(...others.map((item) => {
    const card = renderVideoCard(item, { hdrCapable, local });
    card.href = withBrowseQuery(card.getAttribute("href"), originatingQuery);
    return card;
  }));
  attachThumbnailFallbacks(grid);
  document.getElementById("more-videos").hidden = false;
}

retryButton.addEventListener("click", () => location.reload());
window.addEventListener("aida:playback-error", (event) => showFailure(event.detail?.kind || "playback", event.detail?.message));

void fetchCatalog({ local }).then((items) => {
  catalog = items;
  if (currentMeta) renderDetails(currentMeta);
  void renderMoreVideos();
}).catch((error) => console.warn("Couldn't load more videos", error));

async function boot() {
  try {
    if (id === "." || id === "..") throw new VideoLoadError("not_found", "Video not found");
    currentMeta = await loadMetadata(base, { allowPrivate: local });
    renderDetails(currentMeta);
    video.poster = `${base}/thumbnail_sdr.webp`;
    await mountPlayer(currentMeta, base);
    stage.setAttribute("aria-busy", "false");
    if (!playbackFailed) {
      status.hidden = true;
      playerWrap.inert = false;
    }
  } catch (error) {
    console.error("Couldn't initialize video", error);
    showFailure(error.kind || "playback");
  }
}
void boot();
