/** Fixed-bucket B2 transport for the owner editor. No credentials leave here. */
import { PackageError, PACKAGE_LIMITS, parseDash, parseMaster, parseMedia } from "./admin-package.mjs";
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
  if (key === "index.json" || key === "tags.json") return key;
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
  async function fetchTimed(url, init = {}, consume = response => response, budget = null) {
    if (budget) {
      if (budget.requests >= PACKAGE_LIMITS.requests) throw new AdminProblem(503, "Package verification reached its request budget. Retry finalization; nothing was published.");
      budget.requests++;
    }
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AdminProblem(503, "Cloud storage timed out. Your draft is kept.")); }, timeoutMs); });
    try { return await Promise.race([deadline, (async () => consume(await fetcher(url, { ...init, signal: controller.signal, redirect: "manual", cache: "no-store" })))()]); }
    catch (error) { if (error instanceof AdminProblem) throw error; throw new AdminProblem(503, "Cloud storage is unavailable. Your draft is kept."); }
    finally { clearTimeout(timer); }
  }
  async function authorize(budget) {
    if (cached?.expires > now()) return cached;
    if (authorizing) return authorizing;
    authorizing = (async () => {
      if (!env.B2_KEY_ID || !env.B2_SECRET_KEY || !/^[a-f0-9]{24}$/i.test(env.B2_BUCKET_ID || "")) throw new AdminProblem(503, "Owner storage is not configured.");
      const result = await fetchTimed(AUTH, { headers: { Authorization: `Basic ${btoa(`${env.B2_KEY_ID}:${env.B2_SECRET_KEY}`)}` } }, async response => {
        if (!response.ok) { await response.body?.cancel(); throw new AdminProblem(503, "Owner storage authorization failed."); }
        return boundedJSON(response, 32_000);
      }, budget);
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
  async function api(method, body, budget = null, limit = CATALOG_LIMIT) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth = await authorize(budget);
      const result = await fetchTimed(`${auth.api}/b2api/v2/${method}`, {
        method: "POST", headers: { Authorization: auth.token, "Content-Type": "application/json" }, body: JSON.stringify(body),
      }, async response => {
        if ((response.status === 401 || response.status === 403) && attempt === 0) { await response.body?.cancel(); return null; }
        if (!response.ok) { await response.body?.cancel(); throw new AdminProblem(503, "Cloud storage could not complete the save. Your draft is kept."); }
        return boundedJSON(response, limit);
      }, budget);
      if (result !== null) return result;
      cached = null;
    }
  }
  async function readAsset(key, { method = "GET", range, budget } = {}, consume = response => response) {
    storageKey(key);
    if (!["GET", "HEAD"].includes(method)) throw new AdminProblem(400, "Invalid storage request.");
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth = await authorize(budget), headers = { Authorization: auth.token, "Accept-Encoding": "identity", "Cache-Control": "no-cache" };
      if (range) headers.Range = range;
      let retry = false;
      const value = await fetchTimed(`${auth.download}/file/${BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`, { method, headers }, async response => {
        if ((response.status === 401 || response.status === 403) && attempt === 0) { await response.body?.cancel(); retry = true; return; }
        if (response.headers.get("Content-Encoding") && response.headers.get("Content-Encoding") !== "identity") { await response.body?.cancel(); throw new AdminProblem(502, "Unexpected media encoding."); }
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new AdminProblem(502, "Unexpected storage redirect."); }
        return consume(response);
      }, budget);
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
    if (!VIDEO_ID.test(id || "") || metadata?.frameRate !== 120 || !Number.isFinite(metadata.duration) || metadata.duration <= 0 ||
        !Array.isArray(metadata.codecs) || !metadata.codecs.length || metadata.codecs.length > 2 || new Set(metadata.codecs).size !== metadata.codecs.length || metadata.codecs.some(codec => !["AV1", "HEVC"].includes(codec))) throw new AdminProblem(400, "A completed 120 fps package is required.");
    const budget = { requests: 0 }, required = new Set();
    let textBytes = 0, representations = 0;
    const text = key => readAsset(key, { budget }, async response => {
      if (response.status !== 200) { await response.body?.cancel(); throw new AdminProblem(409, "Upload every manifest and playlist before finalizing."); }
      const bytes = await boundedBytes(response, PACKAGE_LIMITS.manifestBytes);
      textBytes += bytes.length;
      if (textBytes > PACKAGE_LIMITS.textBytes) throw new AdminProblem(413, "The package playlists exceed the verification size limit.");
      required.add(key);
      try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new AdminProblem(400, "Package manifests must contain valid UTF-8."); }
    });
    try {
      for (const codec of metadata.codecs) {
        const prefix = `${id}/${codec}/`, renditions = parseDash(await text(prefix + "manifest.mpd"), codec, metadata);
        representations += renditions.length;
        if (representations > PACKAGE_LIMITS.representations) throw new PackageError("The package has too many representations.");
        parseMaster(await text(prefix + "master.m3u8"), renditions);
        for (const rendition of renditions) {
          for (const asset of parseMedia(await text(prefix + rendition.playlist), rendition)) required.add(prefix + asset);
          if (required.size > PACKAGE_LIMITS.files) throw new PackageError("The package has too many referenced files.");
        }
      }
    } catch (error) { if (error instanceof PackageError) throw new AdminProblem(400, error.message); throw error; }
    // B2's completed-object inventory verifies every reference without reading
    // media bodies or spending one subrequest per video/audio segment.
    const missing = new Set(required), prefix = `${id}/`;
    let cursor, pages = 0, listed = 0;
    do {
      if (++pages > PACKAGE_LIMITS.inventoryPages) throw new AdminProblem(413, "The upload inventory exceeds the verification limit.");
      const page = await api("b2_list_file_names", { bucketId: env.B2_BUCKET_ID, prefix, maxFileCount: PACKAGE_LIMITS.inventoryPageSize, ...(cursor ? { startFileName: cursor } : {}) }, budget, PACKAGE_LIMITS.inventoryBytes);
      if (!Array.isArray(page.files) || page.files.length > PACKAGE_LIMITS.inventoryPageSize) throw new AdminProblem(502, "Invalid uploaded-file inventory.");
      let previous;
      for (const file of page.files) {
        if (typeof file.fileName !== "string" || !file.fileName.startsWith(prefix) || (previous && file.fileName <= previous) || (cursor && file.fileName < cursor)) throw new AdminProblem(502, "Invalid uploaded-file inventory path.");
        previous = file.fileName;
        if (++listed > PACKAGE_LIMITS.files) throw new AdminProblem(413, "The upload has too many files for verification.");
        if (missing.has(file.fileName)) {
          if (file.action !== "upload" || typeof file.fileId !== "string" || !file.fileId || !Number.isSafeInteger(file.contentLength) || file.contentLength <= 0) throw new AdminProblem(409, "A referenced upload is missing or empty.");
          missing.delete(file.fileName);
        }
      }
      const next = page.nextFileName || null;
      if (next && (typeof next !== "string" || !next.startsWith(prefix) || next.length > 512 || !previous || next <= previous || next === cursor || /[^A-Za-z0-9_./-]/.test(next) || next.split("/").some(part => part === "." || part === ".."))) throw new AdminProblem(502, "Invalid uploaded-file inventory cursor.");
      cursor = next;
    } while (cursor);
    if (missing.size) throw new AdminProblem(409, "Upload every referenced initialization and media segment before finalizing.");
    return { representations, referencedFiles: required.size, inventoryPages: pages, requests: budget.requests };
  }
  return { readJson, readAsset, write, copy, listVideoIds, hasPrefix, verifyPackage };
}
