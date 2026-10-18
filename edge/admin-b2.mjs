/** Fixed-bucket B2 transport for the owner editor. No credentials leave here. */
export const BUCKET = "ProjectAida";
export const VIDEO_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MEDIA = /^(AV1|HEVC)\/(manifest\.mpd|master\.m3u8|media_[0-9]+\.m3u8|init_[0-9]+\.mp4|chunk_[0-9]+_[0-9]+\.fmp4)$/;
export const THUMBNAILS = new Map([
  ["thumbnail_sdr.webp", "image/webp"], ["thumbnail_sdr_720p.webp", "image/webp"],
  ["thumbnail_share.jpg", "image/jpeg"], ["thumbnail_hdr.avif", "image/avif"],
  ["thumbnail_hdr_720p.avif", "image/avif"],
]);
export const METADATA_LIMIT = 128_000;
export const CATALOG_LIMIT = 1_000_000;
const AUTH = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account";
const encoder = new TextEncoder();
function storageKey(key, { write = false } = {}) {
  if (key === "index.json") return key;
  if (typeof key !== "string" || key.length > 512) throw new AdminProblem(400, "Invalid storage path.");
  const parts = key.split("/");
  if (parts.length === 2 && VIDEO_ID.test(parts[0]) && (parts[1] === "metadata.json" || THUMBNAILS.has(parts[1]))) return key;
  if (!write && parts.length === 3 && VIDEO_ID.test(parts[0]) && MEDIA.test(parts.slice(1).join("/"))) return key;
  if (parts.length === 5 && parts[0] === ".aida-editor" && parts[1] === "drafts" && VIDEO_ID.test(parts[2]) && /^[A-Za-z0-9_-]{16,128}$/.test(parts[3]) && THUMBNAILS.has(parts[4])) return key;
  throw new AdminProblem(400, "Invalid storage path.");
}

export class AdminProblem extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function boundedBytes(response, limit) {
  if (Number(response.headers.get("Content-Length")) > limit) {
    await response.body?.cancel(); throw new AdminProblem(413, "The saved file is too large.");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new AdminProblem(413, "The saved file is too large.");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function boundedJSON(response, limit) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBytes(response, limit))); }
  catch (error) { if (error instanceof AdminProblem) throw error; throw new AdminProblem(502, "Cloud storage returned invalid data."); }
}

export async function digest(bytes, algorithm = "SHA-256") {
  const data = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  return [...new Uint8Array(await crypto.subtle.digest(algorithm, data))].map(value => value.toString(16).padStart(2, "0")).join("");
}

function safeOrigin(raw, hostPattern) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !hostPattern.test(url.hostname) || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid B2 endpoint");
  return url.origin;
}

/** Injection is for credential-free tests; production always uses fixed B2 APIs. */
export function createB2Store(env, { fetcher = globalThis.fetch, now = Date.now, timeoutMs = 10_000 } = {}) {
  let cached, authorizing;
  async function fetchTimed(url, init = {}, consume = response => response) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AdminProblem(503, "Cloud storage timed out. Your draft is kept.")); }, timeoutMs); });
    try { return await Promise.race([deadline, (async () => consume(await fetcher(url, { ...init, signal: controller.signal, redirect: "manual", cache: "no-store" })))()]); }
    catch (error) { if (error instanceof AdminProblem) throw error; throw new AdminProblem(503, "Cloud storage is unavailable. Your draft is kept."); }
    finally { clearTimeout(timer); }
  }
  async function authorize() {
    if (cached?.expires > now()) return cached;
    if (authorizing) return authorizing;
    authorizing = (async () => {
      if (!env.B2_KEY_ID || !env.B2_SECRET_KEY || !/^[a-f0-9]{24}$/i.test(env.B2_BUCKET_ID || "")) throw new AdminProblem(503, "Owner storage is not configured.");
      const result = await fetchTimed(AUTH, { headers: { Authorization: `Basic ${btoa(`${env.B2_KEY_ID}:${env.B2_SECRET_KEY}`)}` } }, async response => {
        if (!response.ok) { await response.body?.cancel(); throw new AdminProblem(503, "Owner storage authorization failed."); }
        return boundedJSON(response, 32_000);
      });
      try {
        const api = safeOrigin(result.apiUrl, /^api[0-9]+\.backblazeb2\.com$/);
        const download = safeOrigin(result.downloadUrl, /^f[0-9]+\.backblazeb2\.com$/);
        if (typeof result.authorizationToken !== "string" || !result.authorizationToken || /[\r\n]/.test(result.authorizationToken) ||
            result.allowed?.bucketId !== env.B2_BUCKET_ID || result.allowed?.bucketName !== BUCKET || result.allowed?.namePrefix ||
            !Array.isArray(result.allowed?.capabilities) || !["readFiles", "writeFiles", "listFiles"].every(cap => result.allowed.capabilities.includes(cap))) throw new Error("Wrong key scope");
        return cached = { api, download, token: result.authorizationToken, expires: now() + 20 * 3600_000 };
      } catch { throw new AdminProblem(503, "The owner key must be restricted to the ProjectAida bucket with read, write and list access."); }
    })();
    try { return await authorizing; } finally { authorizing = null; }
  }
  async function api(method, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth = await authorize();
      const result = await fetchTimed(`${auth.api}/b2api/v2/${method}`, {
        method: "POST", headers: { Authorization: auth.token, "Content-Type": "application/json" }, body: JSON.stringify(body),
      }, async response => {
        if ((response.status === 401 || response.status === 403) && attempt === 0) { await response.body?.cancel(); return null; }
        if (!response.ok) { await response.body?.cancel(); throw new AdminProblem(503, "Cloud storage could not complete the save. Your draft is kept."); }
        return boundedJSON(response, CATALOG_LIMIT);
      });
      if (result !== null) return result;
      cached = null;
    }
  }
  async function readAsset(key, { method = "GET", range } = {}, consume = response => response) {
    storageKey(key);
    if (!["GET", "HEAD"].includes(method)) throw new AdminProblem(400, "Invalid storage request.");
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth = await authorize(), headers = { Authorization: auth.token, "Accept-Encoding": "identity", "Cache-Control": "no-cache" };
      if (range) headers.Range = range;
      let retry = false;
      const value = await fetchTimed(`${auth.download}/file/${BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`, { method, headers }, async response => {
        if ((response.status === 401 || response.status === 403) && attempt === 0) { await response.body?.cancel(); retry = true; return; }
        if (response.headers.get("Content-Encoding") && response.headers.get("Content-Encoding") !== "identity") { await response.body?.cancel(); throw new AdminProblem(502, "Unexpected media encoding."); }
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new AdminProblem(502, "Unexpected storage redirect."); }
        return consume(response);
      });
      if (retry) { cached = null; continue; }
      return value;
    }
  }
  async function readJson(key, limit = METADATA_LIMIT) {
    return readAsset(key, {}, async response => {
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (response.status !== 200) { await response.body?.cancel(); throw new AdminProblem(503, "Could not read the saved video."); }
      return boundedJSON(response, limit);
    });
  }
  async function write(key, bytes, type) {
    storageKey(key, { write: true });
    const upload = await api("b2_get_upload_url", { bucketId: env.B2_BUCKET_ID });
    let url;
    try {
      url = new URL(upload.uploadUrl);
      const legacyPath = new RegExp(`^/b2api/v[23]/b2_upload_file/${env.B2_BUCKET_ID}/[A-Za-z0-9_-]+$`).test(url.pathname) && !url.search;
      const currentPath = url.pathname === "/b2api/v4/b2_upload_file" && url.searchParams.get("bucket") === env.B2_BUCKET_ID &&
        /^[A-Za-z0-9_-]+$/.test(url.searchParams.get("cvt") || "") && [...url.searchParams.keys()].length === 2;
      if (url.protocol !== "https:" || !/^pod-[a-z0-9-]+\.backblaze(?:b2)?\.com$/.test(url.hostname) || url.port || url.username || url.password || url.hash || upload.bucketId !== env.B2_BUCKET_ID ||
          !(legacyPath || currentPath) || typeof upload.authorizationToken !== "string" || !upload.authorizationToken || /[\r\n]/.test(upload.authorizationToken)) throw new Error();
    } catch { throw new AdminProblem(502, "Invalid storage upload endpoint."); }
    const sha1 = await digest(bytes, "SHA-1");
    return fetchTimed(url.href, { method: "POST", headers: {
      Authorization: upload.authorizationToken, "X-Bz-File-Name": encodeURIComponent(key),
      "Content-Type": type, "Content-Length": String(bytes.byteLength), "X-Bz-Content-Sha1": sha1,
      "X-Bz-Info-b2-cache-control": "no-store",
    }, body: bytes }, async response => {
      if (!response.ok) { await response.body?.cancel(); throw new AdminProblem(503, "The cloud save needs a retry. Your draft is kept."); }
      const result = await boundedJSON(response, 32_000);
      if (result.fileName !== key || typeof result.fileId !== "string" || !result.fileId || result.contentSha1 !== sha1) throw new AdminProblem(502, "Cloud upload verification failed.");
      return { fileId: result.fileId, key, sha1 };
    });
  }
  async function copy(fileId, key, type) {
    storageKey(key, { write: true });
    const result = await api("b2_copy_file", { sourceFileId: fileId, destinationBucketId: env.B2_BUCKET_ID, fileName: key,
      metadataDirective: "REPLACE", contentType: type, fileInfo: { "b2-cache-control": "no-store" } });
    if (result.fileName !== key || typeof result.fileId !== "string") throw new AdminProblem(502, "Cloud copy verification failed.");
    return result;
  }
  async function listVideoIds(cursor = "") {
    if (cursor && (typeof cursor !== "string" || cursor.length > 512 || /[^A-Za-z0-9_./-]/.test(cursor) || cursor.includes(".."))) throw new AdminProblem(400, "Invalid video list cursor.");
    const result = await api("b2_list_file_names", { bucketId: env.B2_BUCKET_ID, delimiter: "/", maxFileCount: 20, ...(cursor ? { startFileName: cursor } : {}) });
    if (!Array.isArray(result.files)) throw new AdminProblem(502, "Invalid cloud video list.");
    const ids = result.files.filter(file => file.action === "folder" && /^[A-Za-z0-9_-]{1,128}\/$/.test(file.fileName)).map(file => file.fileName.slice(0, -1));
    const next = result.nextFileName || null;
    if (next && (typeof next !== "string" || next.length > 512 || /[^A-Za-z0-9_./-]/.test(next) || next.includes(".."))) throw new AdminProblem(502, "Invalid cloud video cursor.");
    return { ids, next_cursor: next };
  }
  async function hasPrefix(id) {
    const result = await api("b2_list_file_names", { bucketId: env.B2_BUCKET_ID, prefix: `${id}/`, maxFileCount: 1 });
    if (!Array.isArray(result.files)) throw new AdminProblem(502, "Invalid cloud video list.");
    return result.files.length > 0;
  }
  async function verifyPackage(id, metadata) {
    for (const codec of metadata.codecs) {
      await readAsset(`${id}/${codec}/manifest.mpd`, {}, async response => {
        if (response.status !== 200) { await response.body?.cancel(); throw new AdminProblem(409, "Upload every completed video rendition before finalizing."); }
        const manifest = new TextDecoder().decode(await boundedBytes(response, 512_000));
        const rates = [...manifest.matchAll(/\bframeRate\s*=\s*["']([^"']+)["']/g)].map(match => match[1]);
        if (!rates.length || rates.some(rate => !["120", "120/1", "120.0", "120.000"].includes(rate))) throw new AdminProblem(400, "Every uploaded rendition must declare 120 fps. No video was published.");
      });
    }
  }
  return { readJson, readAsset, write, copy, listVideoIds, hasPrefix, verifyPackage };
}
