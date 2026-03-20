// ── Production loader ──────────────────────────────────────────────────────────
const CDN_BASE   = "https://cdn.keppy.dev/file/ProjectAida";
const DEFAULT_ID = "LXb3EKWsInQ"; // fallback when no ?v= param in URL

const _id   = new URLSearchParams(location.search).get("v") || DEFAULT_ID;
load(`${CDN_BASE}/${_id}`);
