// ── Production loader ──────────────────────────────────────────────────────────
const _id = new URLSearchParams(location.search).get("v") || DEFAULT_ID;
load(`${CDN_BASE}/${_id}`);
