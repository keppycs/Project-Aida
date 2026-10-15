import {
  fetchCatalog,
  mediaBase,
  watchUrl,
  formatDate,
  formatDuration,
  renderVideoCard,
  detectDisplayHdr,
  attachThumbnailFallbacks,
} from "./catalog.js";

const searchInput = document.getElementById("search-input");
const searchClear = document.getElementById("search-clear");
const hero = document.getElementById("hero");
const heroSkeleton = document.getElementById("hero-skeleton");
const heroContent = document.getElementById("hero-content");
const library = document.getElementById("videos");
const videosGrid = document.getElementById("videos-grid");
const libraryCount = document.getElementById("library-count");
const resultsSummary = document.getElementById("results-summary");
const statusPanel = document.getElementById("library-status");
const statusAction = document.getElementById("status-action");
const skeletonCards = [...videosGrid.children].map((card) => card.cloneNode(true));
searchInput.value = new URLSearchParams(location.search).get("q") || "";

let allVideos = [];
let hdrCapable = false;
let loadState = "loading";

function showStatus(title, description, actionText = "", onAction = null, symbol = "↗") {
  document.getElementById("status-title").textContent = title;
  document.getElementById("status-description").textContent = description;
  document.getElementById("status-symbol").textContent = symbol;
  statusAction.textContent = actionText;
  statusAction.hidden = !actionText;
  statusAction.onclick = onAction;
  statusPanel.hidden = false;
}

function renderHero(video) {
  const url = watchUrl(video.id);
  document.getElementById("hero-image-link").href = url;
  document.getElementById("hero-watch").href = url;
  document.getElementById("hero-watch").setAttribute("aria-label", `Watch ${video.title || "the latest video"}`);
  const image = document.createElement("img");
  const base = mediaBase(video.id);
  const hdr = video.hdr && hdrCapable;
  image.src = `${base}/${hdr ? "thumbnail_hdr.avif" : "thumbnail_sdr.webp"}`;
  image.dataset.fallbackSources = JSON.stringify(hdr ? [`${base}/thumbnail_sdr.webp`] : []);
  image.alt = "";
  image.decoding = "async";
  image.fetchPriority = "high";
  document.getElementById("hero-img").replaceChildren(image);
  document.getElementById("hero-title").textContent = video.title || "Untitled video";
  const description = document.getElementById("hero-desc");
  description.textContent = video.description || "";
  description.hidden = !video.description;
  const date = document.getElementById("hero-date");
  date.textContent = formatDate(video.createdAt);
  date.hidden = !date.textContent;
  const duration = document.getElementById("hero-image-duration");
  duration.textContent = formatDuration(video.duration);
  duration.hidden = !duration.textContent;
  heroSkeleton.hidden = true;
  heroContent.hidden = false;
  attachThumbnailFallbacks(heroContent);
}

function renderGrid(videos) {
  videosGrid.replaceChildren(...videos.map((video) => renderVideoCard(video, { hdrCapable })));
  attachThumbnailFallbacks(videosGrid);
}

function clearSearch() {
  searchInput.value = "";
  renderResults();
  searchInput.focus();
}

function renderResults() {
  if (loadState !== "ready") return;
  const query = searchInput.value.trim().toLocaleLowerCase();
  searchClear.hidden = !searchInput.value;
  hero.hidden = Boolean(query) || !allVideos.length;
  statusPanel.hidden = true;

  if (!allVideos.length) {
    videosGrid.replaceChildren();
    resultsSummary.textContent = "The library is empty.";
    showStatus("The collection starts here", "There are no public videos yet. Check back for the first upload.", "Refresh library", load);
    return;
  }

  const matches = query ? allVideos.filter((video) => {
    const tags = Array.isArray(video.tags) ? video.tags.join(" ") : "";
    return [video.title, video.description, tags].some((value) => String(value || "").toLocaleLowerCase().includes(query));
  }) : allVideos;

  renderGrid(matches);
  if (query) {
    resultsSummary.textContent = `${matches.length} ${matches.length === 1 ? "video" : "videos"} found for “${searchInput.value.trim()}”`;
    if (!matches.length) {
      showStatus("No matches this time", "Try a different title, description, or tag, or return to the full collection.", "Clear search", clearSearch, "⌕");
    }
  } else {
    resultsSummary.textContent = "";
  }
}

async function load() {
  loadState = "loading";
  searchInput.disabled = true;
  searchClear.hidden = true;
  hero.hidden = false;
  hero.setAttribute("aria-busy", "true");
  library.setAttribute("aria-busy", "true");
  heroSkeleton.hidden = false;
  heroContent.hidden = true;
  statusPanel.hidden = true;
  libraryCount.textContent = "";
  resultsSummary.textContent = "Loading the library…";
  videosGrid.replaceChildren(...skeletonCards.map((card) => card.cloneNode(true)));

  try {
    [allVideos, hdrCapable] = await Promise.all([fetchCatalog(), detectDisplayHdr().catch(() => false)]);
    loadState = "ready";
    libraryCount.textContent = String(allVideos.length);
    searchInput.disabled = false;
    if (allVideos.length) renderHero(allVideos[0]);
    renderResults();
  } catch (error) {
    loadState = "error";
    allVideos = [];
    hero.hidden = true;
    videosGrid.replaceChildren();
    resultsSummary.textContent = "The library couldn't be loaded.";
    showStatus("The library is out of reach", "We couldn’t load the videos. Check your connection and try again.", "Try again", load, "!");
    console.warn("Unable to load the Aida catalogue:", error);
  } finally {
    hero.setAttribute("aria-busy", "false");
    library.setAttribute("aria-busy", "false");
  }
}

document.getElementById("search-form").addEventListener("submit", (event) => event.preventDefault());
searchInput.addEventListener("input", renderResults);
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && searchInput.value) {
    event.preventDefault();
    clearSearch();
  }
});
searchClear.addEventListener("click", clearSearch);
load();
