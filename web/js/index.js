import {
  fetchCatalog,
  mediaBase,
  watchUrl,
  formatDate,
  formatDuration,
  renderVideoCard,
  detectDisplayHdr,
  attachThumbnailFallbacks,
} from "./catalog.js?v=master-tags-v1";
import { createSearchIndex, parseSearch, removeSearchToken, searchVideos, suggestTags, tagQuery } from "./search.js?v=master-tags-v1";
import { withBrowseQuery } from "./browse-context.js?v=master-tags-v1";
import { normalizeTag } from "./tags.js?v=master-tags-v1";

const searchInput = document.getElementById("search-input");
const searchClear = document.getElementById("search-clear");
const hero = document.getElementById("hero");
const heroSkeleton = document.getElementById("hero-skeleton");
const heroContent = document.getElementById("hero-content");
const videosSection = document.getElementById("videos");
const videosGrid = document.getElementById("videos-grid");
const videosCount = document.getElementById("videos-count");
const resultsSummary = document.getElementById("results-summary");
const statusPanel = document.getElementById("videos-status");
const statusAction = document.getElementById("status-action");
const skeletonCards = [...videosGrid.children].map((card) => card.cloneNode(true));
const tagSearch = document.getElementById("tag-search");
const suggestions = document.getElementById("tag-suggestions");
const filterList = document.getElementById("search-filters");
searchInput.value = new URLSearchParams(location.search).get("q") || "";
// Avoid an unrelated hero skeleton flashing on a direct search link.
hero.hidden = Boolean(searchInput.value.trim());

let allVideos = [];
let hdrCapable = false;
let loadState = "loading";
let searchIndex = createSearchIndex([]);

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
  const hdr = video.hdr && hdrCapable && video.thumbnailMode !== "sdr";
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
  videosGrid.replaceChildren(...videos.map((video) => {
    const card = renderVideoCard(video, { hdrCapable });
    card.href = withBrowseQuery(card.getAttribute("href"), searchInput.value);
    return card;
  }));
  attachThumbnailFallbacks(videosGrid);
}

function renderTagSuggestions() {
  const tags = suggestTags(searchIndex, tagSearch.value);
  suggestions.replaceChildren(...tags.map(tag => {
    const row = document.createElement("div");
    row.className = "tag-suggestion";
    const name = document.createElement("span");
    name.className = "tag-suggestion-name";
    name.textContent = tag.name;
    const count = document.createElement("span");
    count.className = "tag-suggestion-count";
    count.textContent = `${tag.count} ${tag.count === 1 ? "video" : "videos"}`;
    const copy = document.createElement("span");
    copy.className = "tag-suggestion-copy";
    copy.append(name, count);
    row.append(copy);
    for (const excluded of [false, true]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = excluded ? "Exclude" : "Include";
      button.setAttribute("aria-label", `${button.textContent} ${tag.name}`);
      button.addEventListener("click", () => {
        const token = tagQuery(tag.name, excluded);
        const names = new Set([tag.name, ...tag.aliases].map(normalizeTag));
        const existing = parseSearch(searchInput.value).filter(item => item.kind === "tag" && names.has(normalizeTag(item.value)));
        let query = searchInput.value;
        for (const item of existing.reverse()) query = `${query.slice(0, item.start)} ${query.slice(item.end)}`;
        searchInput.value = `${query} ${token}`.trim();
        renderResults();
      });
      row.append(button);
    }
    return row;
  }));
  document.getElementById("tag-suggestions-status").textContent = tags.length
    ? "Suggestions use tags on videos in this collection."
    : tagSearch.value.trim() ? "No matching tags." : "No tags in this collection yet.";
}

function renderFilters() {
  const tokens = parseSearch(searchInput.value).filter(token => token.kind === "tag");
  filterList.hidden = !tokens.length;
  filterList.replaceChildren(...tokens.map(token => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "search-filter";
    chip.textContent = `${token.excluded ? "Exclude: " : ""}${token.value} ×`;
    chip.setAttribute("aria-label", `Remove ${token.excluded ? "excluded " : ""}tag filter ${token.value}`);
    chip.addEventListener("click", () => {
      searchInput.value = removeSearchToken(searchInput.value, token);
      renderResults();
      searchInput.focus({ preventScroll: true });
    });
    return chip;
  }));
}

function clearSearch() {
  searchInput.value = "";
  renderResults();
  searchInput.focus({ preventScroll: true });
}

function renderResults() {
  if (loadState !== "ready") return;
  const url = new URL(location.href);
  if (searchInput.value) url.searchParams.set("q", searchInput.value);
  else url.searchParams.delete("q");
  if (url.href !== location.href) history.replaceState(history.state, "", url);
  const query = searchInput.value.trim().toLocaleLowerCase();
  searchClear.hidden = !searchInput.value;
  hero.hidden = Boolean(query) || !allVideos.length;
  renderFilters();
  statusPanel.hidden = true;

  if (!allVideos.length) {
    videosGrid.replaceChildren();
    resultsSummary.textContent = "No videos yet.";
    showStatus("No videos yet", "There are no public videos yet. Check back for the first upload.", "Refresh videos", load);
    return;
  }

  const matches = query ? searchVideos(searchIndex, searchInput.value) : allVideos;

  renderGrid(matches);
  if (query) {
    resultsSummary.textContent = `${matches.length} ${matches.length === 1 ? "video" : "videos"} found for “${searchInput.value.trim()}”`;
    if (!matches.length) {
      showStatus("No matches this time", "Try different words or tags, remove an exclusion, or return to the full collection.", "Clear search", clearSearch, "⌕");
    }
  } else {
    resultsSummary.textContent = "";
  }
}

async function load() {
  const retryControl = statusPanel.contains(document.activeElement) ? document.activeElement : null;
  let focusMoved = false;
  const trackFocus = (event) => {
    if (event.target !== retryControl && event.target !== document.body) focusMoved = true;
  };
  const canRestoreFocus = () => retryControl && !focusMoved
    && [document.body, retryControl].includes(document.activeElement);
  if (retryControl) document.addEventListener("focusin", trackFocus);
  loadState = "loading";
  searchInput.disabled = true;
  searchClear.hidden = true;
  hero.hidden = Boolean(searchInput.value.trim());
  hero.setAttribute("aria-busy", "true");
  videosSection.setAttribute("aria-busy", "true");
  heroSkeleton.hidden = false;
  heroContent.hidden = true;
  statusPanel.hidden = true;
  videosCount.textContent = "";
  resultsSummary.textContent = "Loading videos…";
  videosGrid.replaceChildren(...skeletonCards.map((card) => card.cloneNode(true)));

  try {
    [allVideos, hdrCapable] = await Promise.all([fetchCatalog(), detectDisplayHdr().catch(() => false)]);
    loadState = "ready";
    searchIndex = createSearchIndex(allVideos);
    renderTagSuggestions();
    videosCount.textContent = String(allVideos.length);
    searchInput.disabled = false;
    if (allVideos.length) renderHero(allVideos[0]);
    renderResults();
    if (canRestoreFocus()) searchInput.focus({ preventScroll: true });
  } catch (error) {
    loadState = "error";
    allVideos = [];
    hero.hidden = true;
    videosGrid.replaceChildren();
    resultsSummary.textContent = "Videos couldn't be loaded.";
    showStatus("Couldn't load videos", "We couldn’t load the videos. Check your connection and try again.", "Try again", load, "!");
    if (canRestoreFocus()) statusAction.focus({ preventScroll: true });
    console.warn("Unable to load the Aida catalogue:", error);
  } finally {
    if (retryControl) document.removeEventListener("focusin", trackFocus);
    hero.setAttribute("aria-busy", "false");
    videosSection.setAttribute("aria-busy", "false");
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
tagSearch.addEventListener("input", renderTagSuggestions);
window.addEventListener("popstate", () => {
  searchInput.value = new URLSearchParams(location.search).get("q") || "";
  renderResults();
});
load();
