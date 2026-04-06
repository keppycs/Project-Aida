// ── Watch loader: CDN, or ./local/{id} when off-live and &local=1 (see site-env.js) ──
const _id = new URLSearchParams(location.search).get("v") || DEFAULT_ID;
const _base = shouldUseLocalCmaf() ? `./local/${_id}` : `${CDN_BASE}/${_id}`;
load(_base);
