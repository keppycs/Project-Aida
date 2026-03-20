// ── Debug loader ───────────────────────────────────────────────────────────────
// Local: serves files from docs/debug/{id}/  Live: fetches from CDN.
const _local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const _id    = new URLSearchParams(location.search).get("v") || DEFAULT_ID;
load(_local ? `./${_id}` : `${CDN_BASE}/${_id}`);
