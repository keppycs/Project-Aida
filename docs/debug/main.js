// ── Debug loader ───────────────────────────────────────────────────────────────
// Local: serves files from docs/debug/{id}/
// Live:  fetches from CDN (same as production)
const CDN_BASE = "https://cdn.keppy.dev/file/ProjectAida";
const _local   = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const _id      = new URLSearchParams(location.search).get("v");

if (!_id) {
  document.getElementById("title-text").textContent = "No video ID in URL. Add ?v=ID";
} else {
  load(_local ? `./${_id}` : `${CDN_BASE}/${_id}`);
}
