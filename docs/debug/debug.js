// ── Debug config ───────────────────────────────────────────────────────────────
// DEBUG_STEM and DEBUG_IS_HDR are injected by config.js (written by the pipeline).
// When running locally, files are served from docs/{stem}/. When live, use CDN.
const _local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const _base =
  _local ?
    `../${DEBUG_STEM}`
  : `https://cdn.keppy.dev/file/ProjectAida/${encodeURIComponent(DEBUG_STEM)}`;

const CONFIG = {
  title: DEBUG_STEM,
  av1Dash: `${_base}/AV1/manifest.mpd`,
  av1Hls: `${_base}/AV1/master.m3u8`,
  h265Dash: `${_base}/H265/manifest.mpd`,
  h265Hls: `${_base}/H265/master.m3u8`,
  isHdr: typeof DEBUG_IS_HDR !== "undefined" ? DEBUG_IS_HDR : true,
};

init();
