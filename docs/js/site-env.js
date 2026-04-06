/**
 * Live vs dev: favicon + when &local=1 may point CMAF at ./local/{id}.
 * Kept in one file so watch/index stay simple; tracked in git (unlike docs/local/ chunks).
 *
 * Add hostnames here if you deploy the static site to another production domain.
 */
const AIDA_LIVE_HOSTS = new Set(["keppy.dev", "www.keppy.dev"]);

function isAidaLiveSite() {
  return AIDA_LIVE_HOSTS.has(location.hostname);
}

/**
 * On the public site, playback always uses the CDN. The local= param is ignored.
 * Off the live host (localhost, LAN, preview), add &local=1 to load ./local/{id}/ CMAF.
 */
function shouldUseLocalCmaf() {
  if (isAidaLiveSite()) return false;
  const v = (new URLSearchParams(location.search).get("local") || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function applyAidaFavicon() {
  const link = document.querySelector("link[rel~='icon']");
  if (!link) return;
  if (isAidaLiveSite()) {
    link.href = "assets/favicons/flushed.svg";
    link.type = "image/svg+xml";
  } else {
    link.href = "assets/favicons/bug.png";
    link.type = "image/png";
  }
}

window.shouldUseLocalCmaf = shouldUseLocalCmaf;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", applyAidaFavicon);
} else {
  applyAidaFavicon();
}
