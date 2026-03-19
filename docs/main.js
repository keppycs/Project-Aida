// ── Config ─────────────────────────────────────────────────────────────────────
const CDN_BASE = "https://cdn.keppy.dev/file/ProjectAida";
const DEFAULT_ID = "LXb3EKWsInQ"; // fallback when no ?v= param in URL

const _id = new URLSearchParams(location.search).get("v") || DEFAULT_ID;
const _base = `${CDN_BASE}/${_id}`;

fetch(`${_base}/metadata.json`)
  .then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  })
  .then((meta) => init(meta, _base))
  .catch((err) => {
    console.error("Failed to load metadata.json:", err);
    document.getElementById("title-text").textContent = "Failed to load video.";
  });
