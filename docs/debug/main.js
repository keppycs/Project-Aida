// ── Debug loader ───────────────────────────────────────────────────────────────
// Local: serves files from docs/debug/{id}/  Live: fetches from CDN.
const _local = location.hostname === "localhost" || location.hostname === "192.168.1.12";
const _id = new URLSearchParams(location.search).get("v") || DEFAULT_ID;
load(_local ? `./${_id}` : `${CDN_BASE}/${_id}`);
