/** One durable writer owns every metadata/catalog/thumbnail change. */
import { AdminProblem, BUCKET, VIDEO_ID, MEDIA, METADATA_LIMIT, CATALOG_LIMIT, boundedJSON, createB2Store, digest } from "./admin-b2.mjs";
import { createUploadSigner } from "./admin-upload.mjs";

const encoder = new TextEncoder();
const EDITABLE = ["title", "description", "tags", "visibility"];
const CATALOG_FIELDS = ["id", ...EDITABLE, "date", "createdAt", "duration", "width", "height", "frameRate", "hdr", "codecs", "thumbnailMode", "thumbnailUpdatedAt"];
const VARIANTS = { "thumbnail_sdr.webp": ["image/webp", 3840, 2160], "thumbnail_sdr_720p.webp": ["image/webp", 1280, 720], "thumbnail_share.jpg": ["image/jpeg", 1280, 720] };
const OPERATION = /^[A-Za-z0-9_-]{16,128}$/;
const REQUEST_LIMIT = 12_000_000;
const VARIANT_LIMIT = 1_900_000;
const NEW_METADATA = new Set([...CATALOG_FIELDS, "colorPrimaries", "colorTransfer", "colorSpace"]);
const MEDIA_LIMIT = 512 * 1024 * 1024;
const PLAYLIST_LIMIT = 512 * 1024;
const INIT_LIMIT = 32 * 1024 * 1024;

function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function stableJSON(value) { return JSON.stringify(canonical(value)); }
function bytesJSON(value, limit, label) {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.byteLength > limit) throw new AdminProblem(413, `${label} is too large for the website.`);
  return bytes;
}
function id(value) { if (typeof value !== "string" || /\s/.test(value) || !VIDEO_ID.test(value)) throw new AdminProblem(400, "Invalid video ID."); return value; }
function checkOperation(value) { if (typeof value !== "string" || /\s/.test(value) || !OPERATION.test(value)) throw new AdminProblem(400, "A valid operation_id is required."); return value; }
function normalizeMetadata(raw, videoId, entry) {
  if (!plain(raw) || typeof raw.title !== "string") throw new AdminProblem(502, "Saved video metadata is invalid.");
  const metadata = { ...raw, id: videoId };
  // Neither an old catalogue entry nor this Worker's compatibility settings
  // prove which visibility the public CDN currently enforces.
  if (!["public", "unlisted", "private"].includes(metadata.visibility)) metadata.visibility = "unknown";
  metadata.description = typeof raw.description === "string" ? raw.description : "";
  for (const key of ["tags", "date", "hdr"]) if (!Object.hasOwn(metadata, key) && entry && Object.hasOwn(entry, key)) metadata[key] = entry[key];
  if (!Array.isArray(metadata.tags)) metadata.tags = [];
  delete metadata.unlisted;
  return metadata;
}
function editorMetadata(origin, draft) {
  const metadata = { ...origin, ...(draft?.fields || {}) };
  // Older drafts may contain an automatically inferred visibility. Only an
  // explicit choice saved by the reviewed-visibility API resolves that state.
  if (origin.visibility === "unknown" && !draft?.visibilityReviewed) metadata.visibility = "unknown";
  return metadata;
}
function fields(body) {
  const result = {};
  for (const key of EDITABLE) if (Object.hasOwn(body, key)) result[key] = body[key];
  if (Object.hasOwn(result, "title") && (typeof result.title !== "string" || !result.title.trim() || result.title.length > 300)) throw new AdminProblem(400, "Use a title between 1 and 300 characters.");
  if (typeof result.title === "string") result.title = result.title.trim();
  if (Object.hasOwn(result, "description") && (typeof result.description !== "string" || result.description.length > 20_000)) throw new AdminProblem(400, "The description is too long.");
  if (Object.hasOwn(result, "visibility") && !["public", "unlisted", "private"].includes(result.visibility)) throw new AdminProblem(400, "Choose public, unlisted or private.");
  if (Object.hasOwn(result, "tags")) {
    const tags = typeof result.tags === "string" ? result.tags.split(",") : result.tags;
    if (!Array.isArray(tags) || tags.length > 50 || tags.some(tag => typeof tag !== "string" || tag.length > 100)) throw new AdminProblem(400, "Use up to 50 short tags.");
    result.tags = [...new Set(tags.map(tag => tag.trim()).filter(Boolean))];
  }
  return result;
}
function checkKeys(body, allowed) {
  if (!plain(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new AdminProblem(400, "Unsupported edit fields.");
}
function uploadFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 64) throw new AdminProblem(400, "Request between 1 and 64 media upload links.");
  const seen = new Set();
  return files.map(file => {
    checkKeys(file, ["path", "size", "sha256", "md5", "content_type"]);
    if (typeof file.path !== "string" || file.path.length > 256 || /\s/.test(file.path) || !MEDIA.test(file.path) || seen.has(file.path)) throw new AdminProblem(400, "Upload links support unique packaged media files only.");
    seen.add(file.path);
    const type = file.path.endsWith(".mpd") ? "application/dash+xml" : file.path.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4";
    const limit = /\.(mpd|m3u8)$/.test(file.path) ? PLAYLIST_LIMIT : /\/init_[0-9]+\.mp4$/.test(file.path) ? INIT_LIMIT : MEDIA_LIMIT;
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > limit || typeof file.sha256 !== "string" || file.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        typeof file.md5 !== "string" || file.md5.length !== 24 || !/^[A-Za-z0-9+/]{22}==$/.test(file.md5) || btoa(atob(file.md5)) !== file.md5 || file.content_type !== type) throw new AdminProblem(400, "A media upload needs its bounded size, checksums and exact content type.");
    return { path: file.path, size: file.size, sha256: file.sha256, md5: file.md5, content_type: type };
  });
}
function mergeCatalog(catalog, videoId, metadata) {
  const previous = catalog.find(entry => entry.id === videoId) || {};
  const result = catalog.filter(entry => entry.id !== videoId);
  if (metadata.visibility === "public") result.unshift({ ...previous, ...Object.fromEntries(CATALOG_FIELDS.filter(key => Object.hasOwn(metadata, key)).map(key => [key, metadata[key]])) });
  return result;
}

function dimensionsWebP(bytes) {
  const text = (offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 30 || text(0, 4) !== "RIFF" || text(8, 4) !== "WEBP" || view.getUint32(4, true) + 8 !== bytes.length) return null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = text(offset, 4), size = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + size > bytes.length || type === "ANIM") return null;
    if (type === "VP8X" && size >= 10) {
      if (bytes[start] & 2) return null;
      const u24 = at => bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16;
      return [u24(start + 4) + 1, u24(start + 7) + 1];
    }
    if (type === "VP8L" && size >= 5 && bytes[start] === 0x2f) { const bits = view.getUint32(start + 1, true); return [(bits & 0x3fff) + 1, (bits >>> 14 & 0x3fff) + 1]; }
    if (type === "VP8 " && size >= 10 && text(start + 3, 3) === "\x9d\x01\x2a") return [view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff];
    offset = start + size + (size & 1);
  }
  return null;
}
function dimensionsJPEG(bytes) {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
  for (let offset = 2; offset + 4 <= bytes.length;) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return null;
    const length = bytes[offset] << 8 | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) return [bytes[offset + 5] << 8 | bytes[offset + 6], bytes[offset + 3] << 8 | bytes[offset + 4]];
    offset += length;
  }
  return null;
}
export function validateVariants(variants) {
  if (variants === undefined) return [];
  if (!plain(variants) || Object.keys(variants).length !== 3 || Object.keys(variants).some(name => !Object.hasOwn(VARIANTS, name))) throw new AdminProblem(400, "Provide the full, small and share SDR thumbnails together.");
  return Object.entries(VARIANTS).map(([name, [type, maxWidth, maxHeight]]) => {
    const value = variants[name];
    if (!plain(value) || value.type !== type || typeof value.data !== "string" || value.data.length > Math.ceil(VARIANT_LIMIT / 3) * 4 || value.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw new AdminProblem(400, "Invalid thumbnail image.");
    let bytes;
    try { bytes = Uint8Array.from(atob(value.data), char => char.charCodeAt(0)); } catch { throw new AdminProblem(400, "Invalid thumbnail image."); }
    const size = type === "image/webp" ? dimensionsWebP(bytes) : dimensionsJPEG(bytes);
    if (!bytes.length || bytes.length > VARIANT_LIMIT || !size || size[0] < 1 || size[1] < 1 || size[0] > maxWidth || size[1] > maxHeight) throw new AdminProblem(400, "Thumbnail format or dimensions are invalid.");
    return { name, type, bytes };
  });
}

function json(value, status = 200) { return Response.json(value, { status, headers: { "Cache-Control": "no-store", "CDN-Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }

export class AdminLibraryService {
  constructor({ storage, store, uploadSigner, now = Date.now }) {
    this.storage = storage; this.store = store; this.uploadSigner = uploadSigner; this.now = now; this.tail = Promise.resolve();
  }
  enqueue(task) { const result = this.tail.then(task); this.tail = result.catch(() => {}); return result; }
  async origin(videoId) {
    const raw = await this.store.readJson(`${videoId}/metadata.json`);
    const catalog = await this.store.readJson("index.json", CATALOG_LIMIT) ?? [];
    if (!Array.isArray(catalog) || catalog.some(entry => !plain(entry) || typeof entry.id !== "string")) throw new AdminProblem(502, "The cloud video list is invalid.");
    const entry = catalog.find(item => item.id === videoId) || null;
    const revision = await digest(stableJSON({ metadata: raw, entry }));
    return { raw, catalog, entry, revision, metadata: raw === null ? null : normalizeMetadata(raw, videoId, entry) };
  }
  async detail(videoId, origin) {
    origin ||= await this.origin(videoId);
    if (!origin.metadata) throw new AdminProblem(404, "Video not found.");
    const draft = await this.storage.get(`draft:${videoId}`);
    const metadata = editorMetadata(origin.metadata, draft);
    if (draft?.thumbnails?.length) { metadata.thumbnailMode = "sdr"; metadata.thumbnailUpdatedAt = draft.thumbnailUpdatedAt; }
    const revision = await digest(stableJSON({ origin: origin.revision, draft: draft || null }));
    return { ...metadata, id: videoId, metadata, published_metadata: origin.metadata, entry: origin.entry,
      revision, origin_revision: origin.revision, pending: Boolean(draft), remoteChanged: Boolean(draft && draft.base !== origin.revision),
      visibility_review_required: metadata.visibility === "unknown",
      has_remote: true, uploaded: true, remoteChecked: true, has_local: false, local: false, can_preview: true,
      preview_url: `/edit/preview/watch.html?v=${videoId}&local=1`,
      thumbnail_url: `/edit/preview/local/${videoId}/thumbnail_sdr_720p.webp?revision=${revision}`,
      pendingThumbnails: draft?.thumbnails?.map(item => item.name) || [], thumbnail: "thumbnail_sdr_720p.webp" };
  }
  async readDraftThumbnail(videoId, name) {
    const draft = await this.storage.get(`draft:${videoId}`);
    return draft?.thumbnails?.find(image => image.name === name)?.key || null;
  }
  async replay(operationId, hash) {
    const done = await this.storage.get(`operation:${operationId}`);
    if (!done) return null;
    if (done.hash !== hash) throw new AdminProblem(409, "This operation_id was already used for another edit.");
    return json(done.body, done.status);
  }
  async complete(journal, body, status = 200) {
    await this.storage.put(`operation:${journal.id}`, { hash: journal.hash, body, status });
    await this.cleanup(journal);
    return json(body, status);
  }
  async cleanup(journal) {
    await this.storage.delete("journal");
    for (const image of journal.images || []) await this.storage.delete(`blob:${journal.id}:${image.name}`);
  }
  async stage(journal) {
    journal.staged ||= [];
    for (const image of journal.images || []) {
      if (journal.staged.some(item => item.name === image.name)) continue;
      const bytes = await this.storage.get(`blob:${journal.id}:${image.name}`);
      if (!(bytes instanceof Uint8Array)) throw new AdminProblem(503, "A saved thumbnail operation needs repair.");
      const key = `.aida-editor/drafts/${journal.videoId}/${journal.id}/${image.name}`;
      const uploaded = await this.store.write(key, bytes, image.type);
      journal.staged.push({ ...image, key, fileId: uploaded.fileId, hash: await digest(bytes) });
      await this.storage.put("journal", journal);
    }
  }
  async apply(journal) {
    await this.stage(journal);
    if (journal.action === "draft") {
      const draft = { ...journal.draft, thumbnails: journal.staged.length ? journal.staged : journal.draft.thumbnails || [] };
      await this.storage.put(`draft:${journal.videoId}`, draft);
      return this.complete(journal, await this.detail(journal.videoId));
    }
    // The selected images belong to the owner's draft even when publication
    // discovers a conflicting cloud edit after the private stage completed.
    if (journal.draft) await this.storage.put(`draft:${journal.videoId}`, { ...journal.draft,
      thumbnails: journal.staged.length ? journal.staged : journal.draft.thumbnails || [] });
    const current = await this.origin(journal.videoId);
    const currentHash = await digest(stableJSON(current.raw));
    const desiredHash = await digest(stableJSON(journal.metadata));
    const baseHash = journal.baseMetadataHash;
    if (!["public", "unlisted", "private"].includes(journal.metadata.visibility) ||
        (current.metadata?.visibility === "unknown" && journal.action === "publish" && !journal.draft?.visibilityReviewed)) {
      throw new AdminProblem(409, "Review and explicitly choose this video's visibility before publishing. Your draft is kept.");
    }
    if (![baseHash, desiredHash].includes(currentHash)) throw new AdminProblem(409, "The live video changed outside this save. Your draft is kept.");
    const images = journal.staged.length ? journal.staged : journal.draft?.thumbnails || [];
    const privateFirst = journal.metadata.visibility === "private" && current.raw !== null;
    const writeMetadata = async () => {
      if (journal.metadataDone) return;
      if (currentHash !== desiredHash) await this.store.write(`${journal.videoId}/metadata.json`, bytesJSON(journal.metadata, METADATA_LIMIT, "Video metadata"), "application/json");
      journal.metadataDone = true; await this.storage.put("journal", journal);
    };
    if (privateFirst) await writeMetadata();
    journal.copied ||= [];
    for (const image of images) {
      if (journal.copied.includes(image.name)) continue;
      await this.store.copy(image.fileId, `${journal.videoId}/${image.name}`, image.type);
      journal.copied.push(image.name); await this.storage.put("journal", journal);
    }
    await writeMetadata();
    const latest = await this.origin(journal.videoId);
    if (await digest(stableJSON(latest.raw)) !== desiredHash) throw new AdminProblem(409, "The live video changed during publication. Your draft is kept.");
    const entryHash = await digest(stableJSON(latest.entry));
    const desiredCatalog = mergeCatalog(latest.catalog, journal.videoId, journal.metadata);
    if (![journal.baseEntryHash, journal.desiredEntryHash].includes(entryHash)) throw new AdminProblem(409, "The live listing changed outside this save. Your draft is kept.");
    const catalogBytes = bytesJSON(desiredCatalog, CATALOG_LIMIT, "Video list");
    if (stableJSON(latest.catalog) !== stableJSON(desiredCatalog)) await this.store.write("index.json", catalogBytes, "application/json");
    await this.storage.delete(`draft:${journal.videoId}`);
    if (journal.action === "finalize") await this.storage.put(`reservation:${journal.videoId}`, { ...(await this.storage.get(`reservation:${journal.videoId}`)), finalized: true });
    return this.complete(journal, await this.detail(journal.videoId));
  }
  async recover() {
    const journal = await this.storage.get("journal");
    if (!journal) return;
    const completed = await this.storage.get(`operation:${journal.id}`);
    if (completed) {
      if (completed.hash !== journal.hash) throw new AdminProblem(503, "A saved operation needs repair.");
      await this.cleanup(journal);
      return;
    }
    try { await this.apply(journal); }
    catch (error) {
      if (error instanceof AdminProblem && error.status === 409) {
        let current;
        try { current = await this.detail(journal.videoId); } catch {}
        await this.complete(journal, { detail: error.message, ...(current ? { current } : {}) }, 409);
        return;
      }
      throw error;
    }
  }
  async journal(journal, images) {
    for (const image of images) await this.storage.put(`blob:${journal.id}:${image.name}`, image.bytes);
    journal.images = images.map(({ name, type }) => ({ name, type }));
    await this.storage.put("journal", journal);
    return this.apply(journal);
  }
  async mutate(videoId, body, action, principal) {
    // Check before replay: a completed service operation is still service-only.
    if (["reserve", "finalize", "upload-grants"].includes(action) && principal.kind !== "service") throw new AdminProblem(403, "New uploads are prepared in local Studio.");
    const operationId = checkOperation(body.operation_id), hash = await digest(stableJSON({ action, videoId, body }));
    return this.enqueue(async () => {
      if (action === "upload-grants") {
        const files = uploadFiles(body.files);
        await this.recover();
        const reservation = await this.storage.get(`reservation:${videoId}`);
        if (!reservation || reservation.finalized || reservation.media_uploads !== "signed-put" || body.lease !== reservation.lease || body.reservation_operation_id !== reservation.operationId) throw new AdminProblem(409, "A fresh active upload reservation is required.");
        const origin = await this.origin(videoId);
        if (origin.raw !== null || origin.entry) throw new AdminProblem(409, "That video is already published. Upload links cannot replace it.");
        const replay = await this.replay(operationId, hash); if (replay) return replay;
        if (typeof this.uploadSigner !== "function") throw new AdminProblem(503, "Media upload links are not configured.");
        const result = await this.uploadSigner({ videoId, files, expiresIn: 300 });
        await this.storage.put(`operation:${operationId}`, { hash, status: 200, body: result });
        return json(result);
      }
      let replay = await this.replay(operationId, hash); if (replay) return replay;
      await this.recover(); replay = await this.replay(operationId, hash); if (replay) return replay;
      if (action === "reserve") {
        if (principal.kind !== "service") throw new AdminProblem(403, "New uploads are prepared in local Studio.");
        const existing = await this.storage.get(`reservation:${videoId}`);
        if (existing?.operationId === operationId && existing.hash === hash) {
          const result = { id: videoId, lease: existing.lease };
          await this.storage.put(`operation:${operationId}`, { hash, status: 200, body: result });
          return json(result);
        }
        const origin = await this.origin(videoId);
        if (existing || origin.raw !== null || origin.entry || await this.store.hasPrefix(videoId)) throw new AdminProblem(409, "That video ID already exists. Choose a new ID.");
        const lease = crypto.randomUUID() + crypto.randomUUID();
        await this.storage.put(`reservation:${videoId}`, { lease, operationId, hash, createdAt: this.now(), finalized: false, media_uploads: "signed-put" });
        const result = { id: videoId, lease };
        await this.storage.put(`operation:${operationId}`, { hash, status: 200, body: result });
        return json(result);
      }
      if (action === "finalize") {
        if (principal.kind !== "service") throw new AdminProblem(403, "New uploads are prepared in local Studio.");
        const reservation = await this.storage.get(`reservation:${videoId}`);
        if (!reservation || reservation.finalized || body.lease !== reservation.lease || body.media_complete !== true) throw new AdminProblem(409, "A valid completed upload reservation is required.");
        const origin = await this.origin(videoId);
        if (origin.raw !== null || origin.entry) throw new AdminProblem(409, "That video ID appeared online. The local encode is kept.");
        if (!plain(body.metadata) || body.metadata.id !== videoId || Object.keys(body.metadata).some(key => !NEW_METADATA.has(key)) || body.metadata.frameRate !== 120 ||
            !["public", "unlisted", "private"].includes(body.metadata.visibility) ||
            !Array.isArray(body.metadata.codecs) || !body.metadata.codecs.length || body.metadata.codecs.length > 2 || new Set(body.metadata.codecs).size !== body.metadata.codecs.length || body.metadata.codecs.some(codec => !["AV1", "HEVC"].includes(codec)) ||
            !Number.isFinite(body.metadata.duration) || body.metadata.duration <= 0 || !Number.isInteger(body.metadata.width) || !Number.isInteger(body.metadata.height) || body.metadata.width < 1 || body.metadata.height < 1 || body.metadata.width > 16384 || body.metadata.height > 16384) throw new AdminProblem(400, "New metadata must describe the completed 120 fps encode.");
        const metadata = normalizeMetadata({ ...body.metadata, ...fields(body.metadata) }, videoId, plain(body.entry) ? body.entry : null);
        const images = validateVariants(body.variants);
        if (images.length) { metadata.thumbnailMode = "sdr"; metadata.thumbnailUpdatedAt = new Date(this.now()).toISOString(); }
        bytesJSON(metadata, METADATA_LIMIT, "Video metadata"); bytesJSON(mergeCatalog(origin.catalog, videoId, metadata), CATALOG_LIMIT, "Video list");
        await this.store.verifyPackage(videoId, metadata);
        return this.journal({ id: operationId, hash, videoId, action, metadata, baseMetadataHash: await digest(stableJSON(null)), baseEntryHash: await digest(stableJSON(null)),
          desiredEntryHash: await digest(stableJSON(mergeCatalog(origin.catalog, videoId, metadata).find(entry => entry.id === videoId) || null)) }, images);
      }
      const origin = await this.origin(videoId), current = await this.detail(videoId, origin);
      if (body.revision !== current.revision) { const error = new AdminProblem(409, "This video changed. Review the current version before saving."); error.current = current; throw error; }
      if (action === "reload") {
        await this.storage.delete(`draft:${videoId}`);
        const result = await this.detail(videoId, origin);
        await this.storage.put(`operation:${operationId}`, { hash, status: 200, body: result }); return json(result);
      }
      const previous = await this.storage.get(`draft:${videoId}`);
      const images = validateVariants(body.variants);
      const draft = { fields: { ...(previous?.fields || {}), ...fields(body) }, base: previous?.base || origin.revision,
        thumbnails: previous?.thumbnails || [], version: (previous?.version || 0) + 1,
        ...(previous?.visibilityReviewed || (origin.metadata.visibility === "unknown" && Object.hasOwn(body, "visibility")) ? { visibilityReviewed: true } : {}),
        ...(previous?.thumbnailUpdatedAt ? { thumbnailUpdatedAt: previous.thumbnailUpdatedAt } : {}) };
      if (images.length) draft.thumbnailUpdatedAt = new Date(this.now()).toISOString();
      const metadata = editorMetadata(origin.metadata, draft);
      if (images.length || draft.thumbnails.length) { metadata.thumbnailMode = "sdr"; metadata.thumbnailUpdatedAt = draft.thumbnailUpdatedAt; }
      bytesJSON(metadata, METADATA_LIMIT, "Video metadata"); bytesJSON(mergeCatalog(origin.catalog, videoId, metadata), CATALOG_LIMIT, "Video list");
      if (body.publish && metadata.visibility === "unknown") { const error = new AdminProblem(409, "Review and explicitly choose this video's visibility before publishing. Your draft is kept."); error.current = current; throw error; }
      if (body.publish && draft.base !== origin.revision) { const error = new AdminProblem(409, "The live video changed. Your draft is kept for review."); error.current = current; throw error; }
      // Persist the text before any remote mutation; retries and object resets
      // retain the owner's intended edit while B2 versions remain recoverable.
      await this.storage.put(`draft:${videoId}`, draft);
      return this.journal({ id: operationId, hash, videoId, action: body.publish ? "publish" : "draft", draft, metadata,
        baseMetadataHash: await digest(stableJSON(origin.raw)), baseEntryHash: await digest(stableJSON(origin.entry)),
        desiredEntryHash: await digest(stableJSON(mergeCatalog(origin.catalog, videoId, metadata).find(entry => entry.id === videoId) || null)) }, images);
    });
  }
  async handle(request, principal) {
    let videoId, operationId;
    try {
      if (!principal || !["owner", "service"].includes(principal.kind)) throw new AdminProblem(403, "Owner sign-in is required.");
      const url = new URL(request.url), path = url.pathname;
      if (path.includes("%") || request.url.includes("\\") || url.hash) throw new AdminProblem(404, "Not found.");
      const knownQuery = allowed => {
        if ([...url.searchParams.keys()].some(key => !allowed.includes(key)) || allowed.some(key => url.searchParams.getAll(key).length > 1) ||
            ["remote", "refresh", "check_online"].some(key => url.searchParams.has(key) && !["true", "false", "0", "1"].includes(url.searchParams.get(key)))) throw new AdminProblem(400, "Invalid video request.");
      };
      const draftImage = /^\/edit\/api\/internal\/draft-thumbnail\/([A-Za-z0-9_-]{1,128})\/(thumbnail_sdr(?:_720p)?\.webp|thumbnail_share\.jpg|thumbnail_hdr(?:_720p)?\.avif)$/.exec(path);
      if (request.method === "GET" && draftImage && !url.search) return json({ key: await this.readDraftThumbnail(id(draftImage[1]), draftImage[2]) });
      if (request.method === "GET" && path === "/edit/api/videos") {
        knownQuery(["cursor", "remote", "refresh"]);
        const page = await this.store.listVideoIds(url.searchParams.get("cursor") || ""), videos = [];
        for (const item of page.ids) { try { videos.push(await this.detail(id(item))); } catch (error) { if (error.status !== 404) throw error; } }
        return json({ videos, next_cursor: page.next_cursor });
      }
      const videoMatch = /^\/edit\/api\/videos\/([A-Za-z0-9_-]{1,128})(?:\/(thumbnail|reload|upload-grants))?$/.exec(path);
      const reserve = path === "/edit/api/uploads/reserve";
      const finalize = /^\/edit\/api\/uploads\/([A-Za-z0-9_-]{1,128})\/finalize$/.exec(path);
      if (request.method === "GET" && videoMatch && !videoMatch[2]) { knownQuery(["remote", "check_online"]); return json(await this.detail(id(videoMatch[1]))); }
      if (request.method !== "POST" || url.search || !(videoMatch || reserve || finalize)) throw new AdminProblem(404, "Not found.");
      const body = await boundedJSON(request, REQUEST_LIMIT);
      operationId = body?.operation_id;
      if (reserve) { checkKeys(body, ["id", "operation_id"]); videoId = id(body.id); return await this.mutate(videoId, body, "reserve", principal); }
      if (finalize) { checkKeys(body, ["lease", "metadata", "entry", "variants", "operation_id", "media_complete"]); videoId = id(finalize[1]); return await this.mutate(videoId, body, "finalize", principal); }
      videoId = id(videoMatch[1]);
      const action = videoMatch[2] || "edit";
      if (action === "upload-grants") {
        checkKeys(body, ["lease", "reservation_operation_id", "operation_id", "files"]);
        return await this.mutate(videoId, body, action, principal);
      }
      checkKeys(body, action === "reload" ? ["revision", "operation_id"] : [...EDITABLE, "revision", "publish", "operation_id", "variants"]);
      if (typeof body.revision !== "string" || body.revision.length > 128 || (Object.hasOwn(body, "publish") && typeof body.publish !== "boolean")) throw new AdminProblem(400, "A current video revision is required.");
      if (action === "thumbnail" && !body.variants) throw new AdminProblem(400, "Choose a thumbnail image.");
      return await this.mutate(videoId, body, action, principal);
    } catch (error) {
      const status = error instanceof AdminProblem ? error.status : 503;
      const body = { detail: error instanceof AdminProblem ? error.message : "The save could not finish. Your draft is kept." };
      if (typeof operationId === "string" && OPERATION.test(operationId)) body.operation_id = operationId;
      if (error.current) body.current = error.current;
      else if (request.method === "POST" && videoId) { try { body.current = await this.detail(videoId); } catch {} }
      return json(body, status);
    }
  }
}

export class AidaLibrary {
  constructor(state, env) {
    this.service = new AdminLibraryService({ storage: state.storage, store: createB2Store(env), uploadSigner: createUploadSigner(env) });
  }
  fetch(request) {
    let principal;
    try { principal = JSON.parse(request.headers.get("X-Aida-Internal-Principal") || "null"); } catch {}
    return this.service.handle(request, principal);
  }
}
