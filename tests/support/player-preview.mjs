import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const PUBLIC_VIDEO_ID = "XxY3g8Qzx_k";
export const PUBLIC_CDN = "https://cdn.keppy.dev/file/ProjectAida";
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../web");
const SHAKA_URL = "https://cdn.jsdelivr.net/npm/shaka-player@5.0.7/dist/shaka-player.compiled.js";
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp",
  ".avif": "image/avif", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

// This fixture describes a public CDN video. It never reads the local media files.
const PUBLIC_METADATA = {
  id: PUBLIC_VIDEO_ID, title: "ive got nuts of steel", createdAt: 1774446542,
  duration: 25.963, frameRate: 120, width: 2560, height: 1440,
  colorPrimaries: "bt709", colorTransfer: "bt709", colorSpace: "bt709",
  codecs: ["AV1", "HEVC"], visibility: "public",
};

async function proxyPublicFile(request, response, url) {
  const headers = { "accept-encoding": "identity", ...(request.headers.range ? { range: request.headers.range } : {}) };
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 45000);
  const disconnect = () => { if (!response.writableEnded) abort.abort(); };
  response.once("close", disconnect);
  try {
    const upstream = await fetch(url, { method: request.method, headers, signal: abort.signal });
    response.statusCode = upstream.status;
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      if (name === "content-length" && upstream.headers.get("content-encoding")) continue;
      const value = upstream.headers.get(name);
      if (value) response.setHeader(name, value);
    }
    response.setHeader("cache-control", "no-store");
    if (request.method === "HEAD" || !upstream.body) return response.end();
    const source = Readable.fromWeb(upstream.body);
    // A late fetch abort can arrive after pipeline has removed its own listeners.
    source.on("error", () => {});
    await pipeline(source, response);
  } finally {
    clearTimeout(timeout);
    response.off("close", disconnect);
  }
}

export async function startPlayerPreview({ port = 0 } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const pathname = decodeURIComponent(url.pathname);
      if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405).end();
        return;
      }
      if (pathname === "/__fixture/shaka.js") {
        await proxyPublicFile(request, response, SHAKA_URL);
        return;
      }
      if (pathname === "/local/index.json") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end("[]");
        return;
      }
      const mediaPrefix = `/local/${PUBLIC_VIDEO_ID}/`;
      if (pathname.startsWith(mediaPrefix)) {
        const name = pathname.slice(mediaPrefix.length);
        if (!name || name.split("/").some((part) => part === "." || part === "..")) {
          response.writeHead(400).end();
          return;
        }
        if (name === "metadata.json") {
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify(PUBLIC_METADATA));
        } else {
          await proxyPublicFile(request, response, `${PUBLIC_CDN}/${PUBLIC_VIDEO_ID}/${name}`);
        }
        return;
      }
      // In particular, do not stat, list, or read web/local or saved reference pages.
      if (pathname.startsWith("/local/") || pathname.startsWith("/youtube reference/") || pathname.includes("\\")) {
        response.writeHead(404).end();
        return;
      }
      const relative = pathname === "/" ? "watch.html" : pathname.slice(1);
      const allowed = /^(?:watch\.html|index\.html|(?:css|js|assets)\/)/.test(relative);
      const file = resolve(WEB_ROOT, relative);
      if (!allowed || !file.startsWith(`${WEB_ROOT}${sep}`)) {
        response.writeHead(404).end();
        return;
      }
      if (!(await stat(file)).isFile()) {
        response.writeHead(404).end();
        return;
      }
      let data = await readFile(file);
      if (extname(file) === ".html") {
        data = Buffer.from(data.toString().replace(SHAKA_URL, "/__fixture/shaka.js"));
      }
      response.writeHead(200, {
        "content-type": MIME[extname(file)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : data);
    } catch (error) {
      if (response.destroyed || request.destroyed) return;
      if (!response.headersSent) response.writeHead(error.code === "ENOENT" ? 404 : 502);
      response.end();
      if (!["ENOENT", "ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_DESTROYED"].includes(error.code)) console.error("Preview request failed", error.message);
    }
  });
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveReady);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    url: `${origin}/watch.html?v=${PUBLIC_VIDEO_ID}&local=1`,
    close: () => new Promise((resolveClosed) => {
      server.closeAllConnections();
      server.close(resolveClosed);
    }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = process.argv.find((value) => value.startsWith("--port="));
  const preview = await startPlayerPreview({ port: argument ? Number(argument.split("=")[1]) : 4173 });
  console.log(`Public 120 fps preview: ${preview.url}`);
  const stop = async () => { await preview.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
