/**
 * Live vs dev: favicon + when &local=1 may point CMAF at ./local/{id}.
 * Off-live hosts can opt into Eruda with &debug=1 for mobile debugging.
 * Kept in one file so watch/index stay simple; tracked in git (unlike web/local/ chunks).
 *
 * Add hostnames here if you deploy the static site to another production domain.
 */
const ERUDA_DEV_CDN = "https://cdn.jsdelivr.net/npm/eruda@3.4.1/eruda.js";
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

/** Explicit devtools opt-in keeps normal localhost/LAN previews clear of overlays. */
function loadErudaForLocalDev() {
  if (isAidaLiveSite() || new URLSearchParams(location.search).get("debug") !== "1") return;
  if (window.eruda) return;
  const script = document.createElement("script");
  script.src = ERUDA_DEV_CDN;
  script.async = true;
  script.onload = () => {
    try {
      window.eruda.init();
    } catch (e) {
      console.warn("Eruda init failed:", e);
    }
  };
  document.head.appendChild(script);
}

window.isAidaLiveSite = isAidaLiveSite;
window.shouldUseLocalCmaf = shouldUseLocalCmaf;

function applySiteEnv() {
  applyAidaFavicon();
  loadErudaForLocalDev();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", applySiteEnv);
} else {
  applySiteEnv();
}
