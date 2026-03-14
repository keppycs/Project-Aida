// ── Debug config ───────────────────────────────────────────────────────────────
// DEBUG_STEM and DEBUG_IS_HDR are injected by config.js (written by the pipeline).
const CONFIG = {
  title: DEBUG_STEM,
  av1Dash: `${DEBUG_STEM}/AV1/manifest.mpd`,
  av1Hls: `${DEBUG_STEM}/AV1/master.m3u8`,
  h265Dash: `${DEBUG_STEM}/H265/manifest.mpd`,
  h265Hls: `${DEBUG_STEM}/H265/master.m3u8`,
  isHdr: typeof DEBUG_IS_HDR !== "undefined" ? DEBUG_IS_HDR : true,
};

init();
