/** Access-authenticated owner surface. Public playback stays in its own Worker. */
import { AdminAuthError, authorizeRequest } from "./admin-auth.mjs";
import { serveAdminAsset } from "./admin-assets.mjs";
import { AidaLibrary } from "./admin-library.mjs";
import { AdminProblem, MEDIA, THUMBNAILS, createB2Store } from "./admin-b2.mjs";

export { AidaLibrary };

// The published file is immutable; jsDelivr's generated .min.js alias is not SRI-safe.
const EDITOR_CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net/npm/shaka-player@5.0.7/dist/shaka-player.compiled.js",
  "script-src-attr 'none'",
  "connect-src 'self'",
  // Embedded preview CSS and geometry updates use inline styles, never inline scripts.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://cdn.keppy.dev/file/ProjectAida/",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

function privateResponse(response, request) {
  const headers = new Headers(response.headers);
  for (const name of ["Set-Cookie", "X-Bz-File-Id", "X-Bz-File-Name", "X-Bz-Upload-Timestamp", "X-Bz-Content-Sha1"]) headers.delete(name);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("Content-Security-Policy", EDITOR_CSP);
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
}
function problem(status, message) { return Response.json({ detail: message }, { status }); }

export function createAdminHandler({ authorize = authorizeRequest, assets = serveAdminAsset, storeFactory = createB2Store } = {}) {
  let cachedEnv, store;
  return async function fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (!(url.pathname === "/edit" || url.pathname.startsWith("/edit/")) || url.pathname.includes("%") || request.url.includes("\\") || url.hash) return privateResponse(problem(404, "Not found."), request);
      const principal = await authorize(request, env);
      if (principal.kind === "service" && !url.pathname.startsWith("/edit/api/")) throw new AdminProblem(403, "This session is for local Studio requests only.");
      if (url.pathname.startsWith("/edit/api/internal/")) throw new AdminProblem(404, "Not found.");
      if (url.pathname === "/edit/api/session" && request.method === "GET") return privateResponse(Response.json({ authenticated: true, kind: principal.kind, email: principal.email || null }), request);
      if (!env.LIBRARY) throw new AdminProblem(503, "The owner editor is not configured.");
      const stub = env.LIBRARY.get(env.LIBRARY.idFromName("ProjectAida"));
      const mediaAPI = url.pathname.startsWith("/edit/api/media/");
      if (url.pathname.startsWith("/edit/api/") && !mediaAPI) {
        const headers = new Headers({ "X-Aida-Internal-Principal": JSON.stringify(principal) });
        if (request.headers.has("Content-Type")) headers.set("Content-Type", request.headers.get("Content-Type"));
        const forwarded = new Request(request.url, { method: request.method, headers, ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body, duplex: "half" }) });
        return privateResponse(await stub.fetch(forwarded), request);
      }
      if (url.pathname === "/edit/preview/local/index.json" && request.method === "GET") return privateResponse(Response.json([]), request);
      const media = /^\/edit\/(?:preview\/local|api\/media)\/([A-Za-z0-9_-]{1,128})\/(.+)$/.exec(url.pathname);
      if (media) {
        if (!["GET", "HEAD"].includes(request.method)) throw new AdminProblem(405, "Method not allowed.");
        const [, id, asset] = media;
        if ([...url.searchParams.keys()].some(key => key !== "revision") || url.searchParams.getAll("revision").length > 1 || (url.searchParams.get("revision") || "").length > 128 || !(asset === "metadata.json" || THUMBNAILS.has(asset) || MEDIA.test(asset))) throw new AdminProblem(404, "File not found.");
        const result = await stub.fetch(new Request(`${url.origin}/edit/api/videos/${id}`, { headers: { "X-Aida-Internal-Principal": JSON.stringify(principal) } }));
        if (!result.ok) return privateResponse(result, request);
        const detail = await result.json();
        if (asset === "metadata.json") return privateResponse(Response.json(detail.metadata), request);
        const range = request.headers.get("Range");
        if (range && (range.length > 100 || !/^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$/.test(range))) throw new AdminProblem(416, "Invalid byte range.");
        if (cachedEnv !== env) { cachedEnv = env; store = storeFactory(env); }
        let key = `${id}/${asset}`;
        if (THUMBNAILS.has(asset)) {
          const draft = await stub.fetch(new Request(`${url.origin}/edit/api/internal/draft-thumbnail/${id}/${asset}`, { headers: { "X-Aida-Internal-Principal": JSON.stringify(principal) } }));
          if (draft.ok) key = (await draft.json()).key || key;
        }
        const origin = await store.readAsset(key, { method: request.method, range });
        if (![200, 206, 416].includes(origin.status)) { await origin.body?.cancel(); throw new AdminProblem(origin.status === 404 ? 404 : 503, "The private preview file is unavailable."); }
        const headers = new Headers();
        for (const name of ["Content-Length", "Content-Range", "Accept-Ranges"]) if (origin.headers.has(name)) headers.set(name, origin.headers.get(name));
        headers.set("Accept-Ranges", "bytes");
        headers.set("Content-Type", THUMBNAILS.get(asset) || (asset.endsWith(".mpd") ? "application/dash+xml" : asset.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4"));
        return privateResponse(new Response(request.method === "HEAD" ? null : origin.body, { status: origin.status, headers }), request);
      }
      if (mediaAPI) throw new AdminProblem(404, "File not found.");
      const asset = await assets(request, env);
      if (asset) return privateResponse(asset, request);
      throw new AdminProblem(404, "Not found.");
    } catch (error) {
      const status = Number.isInteger(error.status) && [400, 401, 403, 404, 405, 409, 413, 416, 502, 503].includes(error.status) ? error.status : 503;
      const message = error instanceof AdminProblem || error instanceof AdminAuthError ? error.message : "The owner editor is temporarily unavailable.";
      return privateResponse(problem(status, message), request);
    }
  };
}

export default { fetch: createAdminHandler() };
