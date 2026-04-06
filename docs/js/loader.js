// ── Loader ─────────────────────────────────────────────────────────────────────
const CDN_BASE = "https://cdn.keppy.dev/file/ProjectAida";
const DEFAULT_ID = "0"; // fallback when no ?v= param in URL

// Fetches metadata.json from base and passes it to init().
// Called from js/watch.js after CDN_BASE / DEFAULT_ID are defined.
function load(base) {
  const metaUrl = `${base}/metadata.json`;
  fetch(metaUrl)
    .then((r) => {
      if (r.status === 404) throw new Error("not_found");
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .then((meta) => init(meta, base))
    .catch((err) => {
      console.error("Failed to load metadata.json", { url: metaUrl, base, err });
      document.getElementById("title-text").textContent =
        err.message === "not_found" ? "Video not found." : "Failed to load video.";
    });
}
