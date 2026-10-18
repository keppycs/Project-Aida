import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const STUDIO_TOKEN = "synthetic-studio-session";
export const FIRST_VIDEO = "studio-000";
export const SECOND_VIDEO = "studio-001";
export const NEW_VIDEO = "studio-new";
export const TEST_IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=", "base64");

const FIXTURE_FPS = 120;
export const FRAME_FIXTURE = { fps: FIXTURE_FPS, frames: 240, width: 160, height: 90 };
export function frameFixtureColor(index) { return [30 + index % 180, 40 + index * 5 % 160, 50 + index * 11 % 150]; }

function ebmlSize(value) {
  for (let size = 1; size <= 8; ++size) {
    if (BigInt(value) >= (1n << BigInt(size * 7)) - 1n) continue;
    let encoded = BigInt(value) | 1n << BigInt(size * 7);
    const result = Buffer.alloc(size);
    for (let index = size - 1; index >= 0; --index) { result[index] = Number(encoded & 255n); encoded >>= 8n; }
    return result;
  }
  throw new Error("Synthetic WebM element is too large");
}
function uint(value) {
  let encoded = BigInt(value), size = 1;
  while (encoded >= 1n << BigInt(size * 8)) ++size;
  const result = Buffer.alloc(size);
  for (let index = size - 1; index >= 0; --index) { result[index] = Number(encoded & 255n); encoded >>= 8n; }
  return result;
}
function element(id, ...children) {
  const body = Buffer.concat(children);
  return Buffer.concat([Buffer.from(id, "hex"), ebmlSize(body.length), body]);
}
function muxFrames(frames) {
  const { fps, width, height } = FRAME_FIXTURE;
  const header = element("1a45dfa3", element("4286", uint(1)), element("42f7", uint(1)),
    element("42f2", uint(4)), element("42f3", uint(8)), element("4282", Buffer.from("webm")),
    element("4287", uint(2)), element("4285", uint(2)));
  const duration = Buffer.alloc(8);
  duration.writeDoubleBE(frames.length * 1_000_000 / fps);
  const info = element("1549a966", element("2ad7b1", uint(1000)), element("4489", duration),
    element("4d80", Buffer.from("Aida synthetic120")), element("5741", Buffer.from("Aida synthetic120")));
  const tracks = element("1654ae6b", element("ae", element("d7", uint(1)), element("73c5", uint(1)),
    element("83", uint(1)), element("86", Buffer.from("V_VP8")), element("23e383", uint(Math.round(1e9 / fps))),
    element("e0", element("b0", uint(width)), element("ba", uint(height)))));
  let offset = info.length + tracks.length;
  const cuePoints = [];
  const clusters = frames.map(frame => {
    cuePoints.push(element("bb", element("b3", uint(frame.timestamp)),
      element("b7", element("f7", uint(1)), element("f1", uint(offset)))));
    const cluster = element("1f43b675", element("e7", uint(frame.timestamp)),
      element("a3", Buffer.from([0x81, 0, 0, 0x80]), Buffer.from(frame.bytes)));
    offset += cluster.length;
    return cluster;
  });
  return Buffer.concat([header, element("18538067", info, tracks, ...clusters, element("1c53bb6b", ...cuePoints))]);
}

/** Real distinct VP8 frames at120Hz, generated through WebCodecs without FFmpeg. */
export async function makeFrameFixture(page, origin) {
  await page.goto(`${origin}/__fixture/encoder`);
  const frames = await page.evaluate(async specification => {
    const { fps, frames: count, width, height } = specification;
    const config = { codec: "vp8", width, height, bitrate: 2_000_000, framerate: fps, latencyMode: "realtime", hardwareAcceleration: "prefer-software" };
    if (!globalThis.VideoEncoder || !(await VideoEncoder.isConfigSupported(config)).supported) throw new Error("WebCodecs VP8 encoding is required for decoded frame-picker verification");
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    const chunks = [];
    let encodeError;
    const encoder = new VideoEncoder({ output: chunk => { const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes); chunks.push({ timestamp: chunk.timestamp, bytes: [...bytes] }); }, error: error => { encodeError = error; } });
    encoder.configure(config);
    for (let index = 0; index < count; ++index) {
      context.fillStyle = `rgb(${30 + index % 180},${40 + index * 5 % 160},${50 + index * 11 % 150})`;
      context.fillRect(0, 0, width, height);
      context.fillStyle = index % 2 ? "#000" : "#fff";
      context.fillRect(0, 0, 24, 24);
      context.fillStyle = "#000"; context.font = "18px monospace";
      context.fillText(String(index + 1), 55, 50);
      for (let bit = 0; bit < 8; ++bit) {
        context.fillStyle = index & 1 << bit ? "#fff" : "#000";
        context.fillRect(8 + bit * 18, 76, 12, 12);
      }
      const timestamp = Math.floor(index * 1e6 / fps), next = Math.floor((index + 1) * 1e6 / fps);
      const frame = new VideoFrame(canvas, { timestamp, duration: next - timestamp });
      encoder.encode(frame, { keyFrame: true }); frame.close();
      if (encoder.encodeQueueSize > 20) await encoder.flush();
    }
    await encoder.flush(); encoder.close();
    if (encodeError) throw encodeError;
    if (chunks.length !== count) throw new Error("Synthetic encoder dropped distinct test frames");
    return chunks;
  }, FRAME_FIXTURE);
  return muxFrames(frames.sort((a, b) => a.timestamp - b.timestamp));
}

// All metadata, credentials, source paths and decoded media here are synthetic.
// The fixture reads only the admin source files and never contacts B2/CDN.
export async function startAdminPreview() {
  const records = new Map(Array.from({ length: 28 }, (_, index) => {
    const id = `studio-${String(index).padStart(3, "0")}`;
    return [id, { id, title: index === 0 ? "120 fps motion study" : `Motion study ${index + 1}`, description: "First line.\nSecond line.", tags: ["motion", "120 fps"], frameRate: index === 1 ? 60 : index === 2 ? undefined : 120, visibility: index === 0 ? "public" : "private", revision: "r1", local: true, uploaded: true, pending: false, remoteChecked: true, remoteChanged: false, has_local: true, has_remote: true, can_preview: true, preview_url: `/preview/watch.html?v=${id}&local=1&private=1`, thumbnail_url: `/api/video-media/${id}/thumbnail_sdr.webp?revision=r1`, createdAt: 1000 - index }];
  }));
  const state = { requests: [], nextListError: false, nextMutation: null, held: null, frameClip: null };
  const detailHolds = new Map();
  const holdDetail = (id, search, override = {}, { updateRecord = false } = {}) => {
    let markStarted, release, markFinished;
    const started = new Promise(resolveStarted => { markStarted = resolveStarted; });
    const waiting = new Promise(resolveWaiting => { release = resolveWaiting; });
    const finished = new Promise(resolveFinished => { markFinished = resolveFinished; });
    detailHolds.set(`${id}${search}`, { markStarted, waiting, markFinished, override, release, updateRecord });
    return { started, release, finished };
  };
  const eventStreams = new Set();
  const emit = event => { for (const response of eventStreams) { if (!response.destroyed) response.write(`data: ${JSON.stringify(event)}\n\n`); } };
  const copy = value => structuredClone(value);
  const view = id => copy(records.get(id));
  const bump = record => {
    record.revision = `r${Number(record.revision.slice(1)) + 1}`;
    record.thumbnail_url = `/api/video-media/${record.id}/thumbnail_sdr.webp?revision=${record.revision}`;
    return record;
  };
  const send = (response, code, value, type = "application/json") => {
    if (response.destroyed) return;
    response.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    response.end(type === "application/json" ? JSON.stringify(value) : value);
  };
  const hold = async kind => { await new Promise(resolveHeld => { state.held = { kind, release: resolveHeld }; }); state.held = null; };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/__fixture/encoder") return send(response, 200, "<!doctype html><title>Synthetic WebCodecs fixture</title>", "text/html");
      if (url.pathname === "/__fixture/frame.webm") {
        if (!state.frameClip) return send(response, 503, { detail: "Synthetic frame fixture is not ready" });
        let start = 0, end = state.frameClip.length - 1;
        const range = request.headers.range;
        if (range) {
          const match = /^bytes=([0-9]+)-([0-9]*)$/.exec(range);
          if (!match || Number(match[1]) > end) { response.writeHead(416).end(); return; }
          start = Number(match[1]); end = Math.min(end, match[2] ? Number(match[2]) : end);
        }
        response.writeHead(range ? 206 : 200, { "content-type": "video/webm", "cache-control": "no-store", "accept-ranges": "bytes", "content-length": end - start + 1,
          ...(range ? { "content-range": `bytes ${start}-${end}/${state.frameClip.length}` } : {}) });
        return response.end(request.method === "HEAD" ? undefined : state.frameClip.subarray(start, end + 1));
      }
      let body = null;
      if (request.method === "POST") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      }
      state.requests.push({ method: request.method, path: url.pathname, search: url.search, headers: { session: request.headers["x-aida-session"] || "" }, body });
      if (request.method === "POST" && request.headers["x-aida-session"] !== STUDIO_TOKEN) return send(response, 403, { detail: "Missing fixture session." });
      if (url.pathname === "/api/events") { response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" }); response.write(": fixture connected\n\n"); eventStreams.add(response); response.once("close", () => eventStreams.delete(response)); return; }
      if (url.pathname === "/api/defaults") return send(response, 200, { gen_thumbnails: true, upload_to_b2: false, delete_after_upload: false, fast_transcode: true, visibility: "private", visibilities: ["public", "unlisted", "private"] });
      if (url.pathname === "/api/credentials" && request.method === "GET") return send(response, 200, { key_id: "fixture-key", app_key: "", bucket: "fixture-bucket", endpoint: "fixture.invalid", configured: true });
      if (["/api/dedupe/last", "/api/sync/last"].includes(url.pathname)) return send(response, 200, null);
      if (url.pathname === "/api/browse") return send(response, 200, { path: `${ROOT.replaceAll("\\", "/")}/logs/synthetic-source.mp4` });
      if (url.pathname === "/api/probe") return send(response, 200, { width: 2560, height: 1440, fps: 120, duration: 10, source_codec: "hevc", is_hdr: false });
      if (url.pathname === "/api/pipeline") {
        const record = { ...view(FIRST_VIDEO), id: NEW_VIDEO, title: body.title || "New local upload", description: body.description || "", tags: [], visibility: body.visibility, revision: "r1", has_remote: false, uploaded: false, pending: true, remoteChanged: false, preview_url: `/preview/watch.html?v=${NEW_VIDEO}&local=1&private=1`, thumbnail_url: `/api/video-media/${NEW_VIDEO}/thumbnail_sdr.webp?revision=r1` };
        records.set(NEW_VIDEO, record);
        send(response, 200, { video_id: NEW_VIDEO });
        emit({ type: "encode_start" });
        setTimeout(() => emit({ type: "encode_done", ok: true, message: "Video prepared locally.", video_id: NEW_VIDEO, editor_url: `/edit?v=${NEW_VIDEO}` }), 30);
        return;
      }
      if (url.pathname === "/api/videos") {
        if (state.nextListError) { state.nextListError = false; return send(response, 503, { detail: "Fixture library unavailable. Try again." }); }
        return send(response, 200, { videos: [...records.values()].map(copy), remote: url.searchParams.get("remote") === "true" });
      }
      const match = url.pathname.match(/^\/api\/videos\/([^/]+)(\/thumbnail|\/reload)?$/);
      if (match) {
        const id = decodeURIComponent(match[1]), record = records.get(id);
        if (!record) return send(response, 404, { detail: "Video not found." });
        if (request.method === "GET") {
          const key = `${id}${url.search}`, held = detailHolds.get(key);
          if (held) {
            held.markStarted(); await held.waiting; detailHolds.delete(key);
            if (held.updateRecord) Object.assign(record, held.override);
            send(response, 200, { ...view(id), ...held.override }); held.markFinished(); return;
          }
          return send(response, 200, view(id));
        }
        if (request.method !== "POST") return send(response, 405, {});
        if (body.revision !== record.revision) return send(response, 409, { detail: "This saved version changed. Review it first.", current: view(id) });
        if (match[2] === "/reload") {
          Object.assign(record, { title: "Online version to review", description: "Fresh online description.", tags: ["online"], visibility: "public", pending: false, remoteChanged: false });
          bump(record);
          return send(response, 200, view(id));
        }
        if (match[2] === "/thumbnail") {
          record.pending = true;
          bump(record);
          return send(response, 200, view(id));
        }
        const failure = state.nextMutation;
        state.nextMutation = null;
        if (failure === "stale") {
          Object.assign(record, { title: "Saved in another local tab", remoteChanged: false });
          bump(record);
          return send(response, 409, { detail: "This saved version changed. Review it first.", current: view(id) });
        }
        for (const field of ["title", "description", "tags", "visibility"]) record[field] = copy(body[field]);
        record.pending = !body.publish;
        bump(record);
        if (failure === "publish") {
          record.pending = true;
          await hold("publish");
          return send(response, 503, { detail: "Upload failed. Your local edits are saved; try again.", current: view(id) });
        }
        if (failure === "remote") {
          record.remoteChanged = true;
          record.pending = true;
          return send(response, 409, { detail: "The online video changed. Review it first.", current: view(id) });
        }
        return send(response, 200, view(id));
      }
      if (url.pathname.startsWith("/api/video-media/")) return send(response, 200, TEST_IMAGE, "image/png");
      if (url.pathname === "/preview/watch.html") {
        // Exercise the actual watch markup and projection stylesheet while the
        // decoder uses only our generated clip. Playback/bootstrap scripts are
        // intentionally omitted: this fixture does not claim player-engine QA.
        let html = await readFile(resolve(ROOT, "web/watch.html"), "utf8");
        html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
          .replace('<div id="player-wrap" tabindex="0" aria-label="Video player" inert>', '<div id="player-wrap" tabindex="0" aria-label="Video player">')
          .replace('<div id="watch-status"', '<div hidden id="watch-status"')
          .replace('<video id="video" playsinline crossorigin="anonymous"></video>', `<video id="video" muted playsinline preload="auto" src="/__fixture/frame.webm?v=${encodeURIComponent(url.searchParams.get("v") || "")}"></video>`);
        if (url.searchParams.get("embed") === "1") {
          const projection = await readFile(resolve(ROOT, "admin/preview.css"), "utf8");
          html = html.replace("</head>", `<style id="aida-studio-preview-style">${projection}</style></head>`);
        }
        html = html.replace("</body>", `<script>document.querySelector("#video").addEventListener("loadedmetadata",()=>{document.querySelector("#watch-title").textContent="Synthetic120fps video preview";const description=document.querySelector("#watch-description");description.textContent="240 distinct synthetic frames, encoded at120fps for local decoder verification. ".repeat(8);description.hidden=false;});</script></body>`);
        return send(response, 200, html, "text/html; charset=utf-8");
      }
      const previewAssets = { "/preview/css/site.css": "css/site.css", "/preview/css/player.css": "css/player.css", "/preview/css/player-mobile.css": "css/player-mobile.css", "/preview/css/watch.css": "css/watch.css", "/preview/assets/favicons/flushed.svg": "assets/favicons/flushed.svg" };
      if (previewAssets[url.pathname]) return send(response, 200, await readFile(resolve(ROOT, "web", previewAssets[url.pathname])), url.pathname.endsWith(".css") ? "text/css; charset=utf-8" : "image/svg+xml");
      const staticFiles = { "/": "index.html", "/edit": "index.html", "/static/admin.css": "admin.css", "/static/admin.js": "admin.js", "/static/editor.js": "editor.js" };
      const name = staticFiles[url.pathname];
      if (name) {
        let content = await readFile(resolve(ROOT, "admin", name));
        if (name === "index.html") content = Buffer.from(content.toString().replace("<head>", `<head><meta name="aida-session" content="${STUDIO_TOKEN}">`));
        return send(response, 200, content, name.endsWith("html") ? "text/html; charset=utf-8" : name.endsWith("css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
      }
      send(response, 404, {});
    } catch (error) { send(response, 500, { detail: error.message }); }
  });
  await new Promise((resolveReady, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveReady); });
  return { origin: `http://127.0.0.1:${server.address().port}`, state, view, holdDetail, setFrameClip: bytes => { state.frameClip = bytes; }, setNextMutation: value => { state.nextMutation = value; }, failNextList: () => { state.nextListError = true; }, releaseHeld: () => state.held?.release(), close: () => new Promise(resolveClosed => { state.held?.release(); for (const held of detailHolds.values()) held.release(); server.closeAllConnections(); server.close(resolveClosed); }) };
}
