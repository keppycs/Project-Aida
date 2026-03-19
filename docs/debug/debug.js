// ── Debug config ───────────────────────────────────────────────────────────────
// Reads ?v= from the URL. Base URL switches between local files and CDN
// depending on whether the page is being served locally or live.
const CDN_BASE = "https://cdn.keppy.dev/file/ProjectAida";
const _local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const _id = new URLSearchParams(location.search).get("v");

if (!_id) {
  document.getElementById("title-text").textContent = "No video ID in URL. Add ?v=ID";
} else {
  const _base = _local ? `../${_id}` : `${CDN_BASE}/${_id}`;

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
}
