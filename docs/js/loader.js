// ── Loader ─────────────────────────────────────────────────────────────────────
// Fetches metadata.json from base and passes it to init().
// Called by each page's own main.js with the appropriate base URL.
function load(base) {
  fetch(`${base}/metadata.json`)
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(meta => init(meta, base))
    .catch(err => {
      console.error("Failed to load metadata.json:", err);
      document.getElementById("title-text").textContent = "Failed to load video.";
    });
}
