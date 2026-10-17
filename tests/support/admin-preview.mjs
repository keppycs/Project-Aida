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

// All metadata, credentials, source paths and media here are synthetic. The
// fixture reads only the four admin source files and never contacts B2/CDN.
export async function startAdminPreview() {
  const records = new Map(Array.from({ length: 28 }, (_, index) => {
    const id = `studio-${String(index).padStart(3, "0")}`;
    return [id, { id, title: index === 0 ? "120 fps motion study" : `Motion study ${index + 1}`, description: "First line.\nSecond line.", tags: ["motion", "120 fps"], frameRate: index === 1 ? 60 : index === 2 ? undefined : 120, visibility: index === 0 ? "public" : "private", revision: "r1", local: true, uploaded: true, pending: false, remoteChecked: true, remoteChanged: false, has_local: true, has_remote: true, can_preview: true, preview_url: `/preview/watch.html?v=${id}&local=1&private=1`, thumbnail_url: `/api/video-media/${id}/thumbnail_sdr.webp?revision=r1`, createdAt: 1000 - index }];
  }));
  const state = { requests: [], nextListError: false, nextMutation: null, held: null };
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
        if (request.method === "GET") return send(response, 200, view(id));
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
      if (url.pathname === "/preview/watch.html") return send(response, 200, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}body{margin:0;background:#101112;color:#fafafa;font:16px system-ui}header,main{padding:20px}header{color:#e8ff47}section{aspect-ratio:16/9;background:#282b2f;display:grid;place-items:center}p{line-height:1.6}footer{padding:20px;min-height:250px}</style></head><body><header>Aida · synthetic watch preview</header><main><section>120 fps preview fixture</section><h1>Video preview</h1><p>This is a synthetic page, without video files or network media.</p></main><footer>Full watch-page preview.</footer></body></html>', "text/html; charset=utf-8");
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
  return { origin: `http://127.0.0.1:${server.address().port}`, state, view, setNextMutation: value => { state.nextMutation = value; }, failNextList: () => { state.nextListError = true; }, releaseHeld: () => state.held?.release(), close: () => new Promise(resolveClosed => { state.held?.release(); server.closeAllConnections(); server.close(resolveClosed); }) };
}
