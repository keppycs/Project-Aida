// ── Loader ─────────────────────────────────────────────────────────────────────
const CDN_BASE = "https://cdn.keppy.dev/file/ProjectAida";
const DEFAULT_ID = "0"; // fallback when no ?v= param in URL

// Fetches metadata.json from base and passes it to init().
// Called from js/watch.js after CDN_BASE / DEFAULT_ID are defined.
function videoVisibility(meta) {
  if (meta.visibility === "public" || meta.visibility === "unlisted" || meta.visibility === "private") {
    return meta.visibility;
  }
  if (meta.unlisted) return "unlisted";
  return "public";
}

function load(base) {
  const metaUrl = `${base}/metadata.json`;
  fetch(metaUrl)
    .then((r) => {
      if (r.status === 404) throw new Error("not_found");
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .then((meta) => {
      const vis = videoVisibility(meta);
      const localDev = typeof shouldUseLocalCmaf === "function" && shouldUseLocalCmaf();
      if (vis === "private" && !localDev) {
        document.getElementById("title-text").textContent = "This video is private.";
        return;
      }
      init(meta, base);
    })
    .catch((err) => {
      console.error("Failed to load metadata.json", { url: metaUrl, base, err });
      document.getElementById("title-text").textContent =
        err.message === "not_found" ? "Video not found." : "Failed to load video.";
    });
}
