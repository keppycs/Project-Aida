// js/index.js
const INDEX_URL = "https://cdn.keppy.dev/file/ProjectAida/index.json";
const CDN_BASE = "https://cdn.keppy.dev/file/ProjectAida";

const searchInput = document.getElementById("search-input");
const heroSkeleton = document.getElementById("hero-skeleton");
const heroContent = document.getElementById("hero-content");
const videosGrid = document.getElementById("videos-grid");
const noResults = document.getElementById("no-results");

let allVideos = [];
let filteredVideos = [];

// ── Fetch and render ──
async function load() {
  try {
    const res = await fetch(INDEX_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allVideos = await res.json();

    if (!allVideos.length) {
      heroSkeleton.style.display = "none";
      noResults.style.display = "block";
      return;
    }

    // Sort chronologically (newest first)
    allVideos.sort((a, b) => new Date(b.date) - new Date(a.date));

    renderHero(allVideos[0]);
    renderGrid(allVideos);
  } catch (err) {
    console.error("Failed to load index:", err);
    heroSkeleton.style.display = "none";
    noResults.style.display = "block";
  }
}

function renderHero(video) {
  heroContent.href = `/watch?v=${video.id}`;
  document.getElementById("hero-img").src = `${CDN_BASE}/${video.id}/thumbnail.png`;
  document.getElementById("hero-img").alt = video.title;
  document.getElementById("hero-title").textContent = video.title;
  document.getElementById("hero-desc").textContent = video.description || "";
  document.getElementById("hero-date").textContent = formatDate(video.createdAt);
  const dur = formatDuration(video.duration);
  const heroDur = document.getElementById("hero-duration");
  heroDur.textContent = dur;
  heroDur.style.display = dur ? "" : "none";

  heroSkeleton.style.display = "none";
  heroContent.style.display = "block";
}

function renderGrid(videos) {
  // Skip the first entry — it's already shown in the hero
  videosGrid.innerHTML = videos
    .slice(1)
    .map((v) => createCardHTML(v))
    .join("");
}

function createCardHTML(video) {
  return `
    <a href="/watch?v=${video.id}" class="video-card">
      <div class="video-card-thumbnail">
        <img src="${CDN_BASE}/${video.id}/thumb.jpg" alt="${escapeHtml(video.title)}" loading="lazy" />
      </div>
      <div class="video-card-content">
        <div class="video-card-title">${escapeHtml(video.title)}</div>
        <div class="video-card-meta">
          <span>${formatDate(video.createdAt)}</span>
          ${video.duration ? `<span>${formatDuration(video.duration)}</span>` : ""}
        </div>
      </div>
    </a>
  `;
}

function createSkeletonCardHTML() {
  return `
    <div class="skeleton-card">
      <div class="skeleton-card-thumb"></div>
      <div class="skeleton-card-content">
        <div class="skeleton-card-line"></div>
        <div class="skeleton-card-line"></div>
      </div>
    </div>
  `;
}

// ── Search ──
searchInput.addEventListener("input", (e) => {
  const query = e.target.value.toLowerCase();

  if (!query) {
    renderGrid(allVideos);
    noResults.style.display = "none";
    return;
  }

  filteredVideos = allVideos.filter(
    (v) =>
      v.title.toLowerCase().includes(query) ||
      (v.description && v.description.toLowerCase().includes(query)) ||
      (v.tags && v.tags.some((t) => t.toLowerCase().includes(query))),
  );

  if (filteredVideos.length) {
    renderGrid(filteredVideos);
    noResults.style.display = "none";
  } else {
    videosGrid.innerHTML = "";
    noResults.style.display = "block";
  }
});

// ── Utilities ──
function formatDate(ts) {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatDuration(seconds) {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ── Init ──
load();
