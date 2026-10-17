/**
 * Private B2 origin, public/unlisted Aida playback only.
 * Deploy as an ES-module Worker with encrypted B2_KEY_ID/B2_SECRET_KEY bindings.
 * The B2 key should be scoped to ProjectAida with readFiles only. Never put it
 * in the site or forward visitor credentials to B2. Optional LEGACY_VISIBILITY
 * JSON maps reviewed older folder IDs to "public" or "unlisted" only while
 * their metadata lacks visibility. Unknown older uploads stay private.
 *
 * Every request checks current origin metadata before releasing any asset.
 * Downstream responses deliberately use no-store: previously public browser
 * caches must not bypass the check after a video's visibility changes. This
 * initial policy trades repeat-download bandwidth for simple revocation.
 * Video bodies stream unchanged, including 120 fps and HTTP byte ranges.
 */
const BUCKET = "ProjectAida";
const ROOT = `/file/${BUCKET}/`;
const AUTHORIZE = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account";
const VIDEO_ID = /^[A-Za-z0-9_-]{1,128}$/;
const THUMBNAILS = new Map([
  ["thumbnail_hdr.avif", "image/avif"],
  ["thumbnail_hdr_720p.avif", "image/avif"],
  ["thumbnail_sdr.webp", "image/webp"],
  ["thumbnail_sdr_720p.webp", "image/webp"],
  ["thumbnail_share.jpg", "image/jpeg"],
]);
const METADATA_LIMIT = 128_000;
const CATALOG_LIMIT = 1_000_000;
// Fits the free Worker's subrequest limit, including B2 authorization + index.
const MAX_CATALOG_ENTRIES = 40;
const CATALOG_CONCURRENCY = 4;
const CATALOG_FIELDS = ["title", "description", "tags", "date", "createdAt", "duration", "width", "height", "frameRate", "hdr", "codecs"];
const INDEX_ONLY_FIELDS = new Set(["tags", "date", "hdr"]);

function routeRequest(request) {
  const raw = request.url;
  const url = new URL(raw);
  // There is no public API, version selector, download-by-id or arbitrary path.
  // Forbid encoding entirely: all packaged filenames and video IDs are ASCII.
  if (url.username || url.password || raw.includes("?") || raw.includes("#") ||
      url.pathname.includes("%") || raw.includes("\\") || !url.pathname.startsWith(ROOT)) return null;
  const path = url.pathname.slice(ROOT.length);
  if (path === "index.json") return { url, path, catalog: true, type: "application/json; charset=utf-8" };
  const [id, ...parts] = path.split("/");
  if (!VIDEO_ID.test(id)) return null;
  const asset = parts.join("/");
  if (asset === "metadata.json") return { url, path, id, metadata: true, type: "application/json; charset=utf-8" };
  if (THUMBNAILS.has(asset)) return { url, path, id, type: THUMBNAILS.get(asset) };
  const match = /^(AV1|HEVC)\/(manifest\.mpd|master\.m3u8|media_[0-9]+\.m3u8|init_[0-9]+\.mp4|chunk_[0-9]+_[0-9]+\.fmp4)$/.exec(asset);
  if (!match) return null;
  const type = asset.endsWith(".mpd") ? "application/dash+xml" : asset.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4";
  return { url, path, id, type };
}

function publicHeaders(extra = {}) {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Cache-Control": "no-store",
    "CDN-Cache-Control": "no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=31536000",
    ...extra,
  });
}

function reply(status, message, request, extra = {}) {
  return new Response(request.method === "HEAD" || status === 204 ? null : message, {
    status, headers: publicHeaders({ "Content-Type": "text/plain; charset=utf-8", ...extra }),
  });
}

function jsonReply(value, request) {
  return new Response(request.method === "HEAD" ? null : JSON.stringify(value), {
    headers: publicHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}

async function boundedJson(response, limit) {
  if (Number(response.headers.get("Content-Length")) > limit) {
    await response.body?.cancel();
    throw new Error("Origin JSON too large");
  }
  if (!response.body) throw new Error("Missing origin JSON");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      size += value.byteLength;
      if (size > limit) throw new Error("Origin JSON too large");
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

function metadataVisibility(meta, id, env) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta) ||
      typeof meta.id !== "string" || !VIDEO_ID.test(meta.id) || typeof meta.title !== "string") return null;
  if (Object.hasOwn(meta, "visibility")) return ["public", "unlisted", "private"].includes(meta.visibility) ? meta.visibility : null;
  if (Object.hasOwn(meta, "unlisted") && typeof meta.unlisted !== "boolean") return null;
  // Original uploads predate visibility. Only a reviewed compatibility map may
  // release them. The URL folder is authoritative: some historical metadata.id
  // values do not match their published folder IDs.
  if (typeof env.LEGACY_VISIBILITY !== "string" || env.LEGACY_VISIBILITY.length > 8192) return null;
  let legacy;
  try { legacy = JSON.parse(env.LEGACY_VISIBILITY); } catch { return null; }
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy) ||
      Object.keys(legacy).length > MAX_CATALOG_ENTRIES ||
      Object.entries(legacy).some(([key, value]) => !VIDEO_ID.test(key) || !["public", "unlisted"].includes(value)) ||
      !Object.hasOwn(legacy, id)) return null;
  const visibility = legacy[id];
  return meta.unlisted && visibility === "public" ? null : visibility;
}

/** Inject fetch/clock/timeouts for deterministic, credential-free unit tests. */
export function createHandler({ fetcher = globalThis.fetch, now = Date.now, timeoutMs = 10_000 } = {}) {
  let tokenCache = null;
  let pendingAuth = null;

  async function timedFetch(url, init, consume = response => response) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await consume(await fetcher(url, {
        ...init, signal: controller.signal, redirect: "manual", cache: "no-store",
      }));
    } finally { clearTimeout(timer); }
  }

  function sameCredentials(state, env) {
    return state && state.keyId === env.B2_KEY_ID && state.secret === env.B2_SECRET_KEY;
  }

  async function authorize(env) {
    if (typeof env.B2_KEY_ID !== "string" || !env.B2_KEY_ID || typeof env.B2_SECRET_KEY !== "string" || !env.B2_SECRET_KEY) throw new Error("Missing B2 binding");
    if (sameCredentials(tokenCache, env) && tokenCache.expires > now()) return tokenCache;
    if (sameCredentials(pendingAuth, env)) return pendingAuth.promise;
    const state = { keyId: env.B2_KEY_ID, secret: env.B2_SECRET_KEY };
    state.promise = timedFetch(AUTHORIZE, {
      headers: { Authorization: `Basic ${btoa(`${state.keyId}:${state.secret}`)}`, Accept: "application/json" },
    }, async response => {
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error("B2 authorization unavailable");
      }
      const auth = await boundedJson(response, 32_000);
      const origin = new URL(auth.downloadUrl);
      if (origin.protocol !== "https:" || !/^f[0-9]+\.backblazeb2\.com$/.test(origin.hostname) || origin.port || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
          typeof auth.authorizationToken !== "string" || !auth.authorizationToken || /[\r\n]/.test(auth.authorizationToken) ||
          (auth.allowed != null && (typeof auth.allowed !== "object" || Array.isArray(auth.allowed))) ||
          (auth.allowed?.bucketName && auth.allowed.bucketName !== BUCKET) ||
          (auth.allowed?.capabilities != null && (!Array.isArray(auth.allowed.capabilities) ||
            auth.allowed.capabilities.some(capability => typeof capability !== "string") || !auth.allowed.capabilities.includes("readFiles")))) throw new Error("Invalid B2 authorization");
      const token = { ...state, promise: undefined, origin: origin.origin, token: auth.authorizationToken, expires: now() + 20 * 60 * 60 * 1000 };
      tokenCache = token;
      return token;
    });
    pendingAuth = state;
    try { return await state.promise; }
    finally { if (pendingAuth === state) pendingAuth = null; }
  }

  async function originRequest(path, env, { method = "GET", range, consume = response => response } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth = await authorize(env);
      const headers = { Authorization: auth.token, "Cache-Control": "no-cache", "Accept-Encoding": "identity" };
      if (range) headers.Range = range;
      const result = await timedFetch(`${auth.origin}${ROOT}${path}`, { method, headers }, async response => {
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          return { refresh: true };
        }
        return { value: await consume(response) };
      });
      if (!result.refresh) return result.value;
      if (tokenCache === auth) tokenCache = null;
    }
    throw new Error("Origin access unavailable");
  }

  async function readMetadata(id, env) {
    return originRequest(`${id}/metadata.json`, env, { consume: async response => {
      if (response.status !== 200) {
        await response.body?.cancel();
        if (response.status === 404) return null;
        throw new Error("Origin metadata unavailable");
      }
      const meta = await boundedJson(response, METADATA_LIMIT);
      const visibility = metadataVisibility(meta, id, env);
      return visibility ? { meta, visibility } : null;
    } });
  }

  async function catalog(env) {
    const entries = await originRequest("index.json", env, { consume: async response => {
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error("Origin catalogue unavailable");
      }
      return boundedJson(response, CATALOG_LIMIT);
    } });
    if (!Array.isArray(entries) || entries.length > MAX_CATALOG_ENTRIES) throw new Error("Invalid catalogue");
    const indexed = new Map();
    for (const entry of entries) {
      if (entry && typeof entry === "object" && typeof entry.id === "string" && VIDEO_ID.test(entry.id) && !indexed.has(entry.id)) indexed.set(entry.id, entry);
    }
    const ids = [...indexed.keys()];
    const results = new Array(ids.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CATALOG_CONCURRENCY, ids.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= ids.length) return;
        const id = ids[index];
        const checked = await readMetadata(id, env);
        if (checked?.visibility !== "public") continue;
        // Current metadata wins, including removed descriptions; never send the
        // stale catalogue's old title/description after a publishing edit.
        const entry = { id, visibility: "public" };
        for (const field of CATALOG_FIELDS) {
          if (Object.hasOwn(checked.meta, field)) entry[field] = checked.meta[field];
          // The current transcoder stores these presentation fields only in
          // index.json. Preserve them after authorization without resurrecting
          // an old title or removed description from the catalogue.
          else if (INDEX_ONLY_FIELDS.has(field) && Object.hasOwn(indexed.get(id), field)) entry[field] = indexed.get(id)[field];
        }
        results[index] = entry;
      }
    }));
    return results.filter(Boolean);
  }

  return async function handleRequest(request, env = {}) {
    try {
      const route = routeRequest(request);
      if (!route) return reply(404, "Not found", request);
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) return reply(405, "Method not allowed", request, { Allow: "GET, HEAD, OPTIONS" });
      if (route.url.protocol === "http:") {
        route.url.protocol = "https:";
        return reply(308, "Use HTTPS", request, { Location: route.url.href });
      }
      if (route.url.protocol !== "https:") return reply(404, "Not found", request);
      if (request.method === "OPTIONS") return reply(204, "", request);
      if (route.catalog) return jsonReply(await catalog(env), request);

      const checked = await readMetadata(route.id, env);
      if (!checked || !["public", "unlisted"].includes(checked.visibility)) return reply(404, "Not found", request);
      if (route.metadata) return jsonReply({ ...checked.meta, visibility: checked.visibility }, request);

      const range = request.headers.get("Range");
      if (range && (range.length > 100 || !/^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$/.test(range))) return reply(416, "Invalid range", request);
      const upstream = await originRequest(route.path, env, { method: request.method, range });
      const encoding = upstream.headers.get("Content-Encoding");
      if (![200, 206, 416].includes(upstream.status) || (encoding && encoding.toLowerCase() !== "identity")) {
        await upstream.body?.cancel();
        return reply(upstream.status === 404 ? 404 : 503, upstream.status === 404 ? "Not found" : "Temporarily unavailable", request);
      }
      const headers = publicHeaders({ "Content-Type": route.type });
      for (const name of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
        const value = upstream.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      if (request.method === "HEAD" || upstream.status === 416) {
        await upstream.body?.cancel();
        if (upstream.status === 416) headers.set("Content-Length", "0");
        return new Response(null, { status: upstream.status, headers });
      }
      // Do not buffer or alter media. Fetch resolves at response headers; its
      // connection timeout is cleared while the original body streams through.
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch {
      // Never expose B2 bodies, authorization details, URLs or secret values.
      return reply(503, "Temporarily unavailable", request);
    }
  };
}

export const handleRequest = createHandler();
export default { fetch: handleRequest };
