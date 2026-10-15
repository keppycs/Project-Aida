/** Video-specific link previews in front of the existing GitHub Pages site. */
const SITE = "https://keppy.dev";
const CDN = "https://cdn.keppy.dev/file/ProjectAida";
const WATCH_PATHS = new Set(["/watch", "/watch.html"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_DESCRIPTION = "Watch Keppy's videos in 120 fps on Aida.";

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function text(value, fallback, limit) {
  return typeof value === "string" && value.trim()
    ? value.trim().replace(/\s+/g, " ").slice(0, limit) : fallback;
}

function siteOrigin(env) {
  const url = new URL(env.SITE_ORIGIN || SITE);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SITE_ORIGIN must be an HTTPS origin");
  }
  return url.origin;
}

function watchUrl(id, origin) {
  return `${origin}/watch?v=${encodeURIComponent(id)}`;
}

function embedUrl(id, origin) {
  return `${origin}/embed?v=${encodeURIComponent(id)}`;
}

async function timedFetch(fetcher, url, init = {}, consume = (response) => response) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.method === "HEAD" ? 1500 : 5000);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    return await consume(response);
  } finally {
    clearTimeout(timer);
  }
}

async function boundedText(response, maximum) {
  if (Number(response.headers.get("Content-Length")) > maximum) {
    await response.body?.cancel();
    throw new Error("Response is too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let result = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return result + decoder.decode();
      size += value.byteLength;
      if (size > maximum) throw new Error("Response is too large");
      result += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

async function readVideo(id, fetcher) {
  try {
    // Revalidate visibility rather than caching a previously public title at the edge.
    return await timedFetch(fetcher, `${CDN}/${id}/metadata.json`, {
      headers: { "Accept": "application/json", "Cache-Control": "no-cache" },
      cache: "no-store", cf: { cacheTtl: 0, cacheTtlByStatus: { "100-599": -1 } }, redirect: "error",
    }, async (response) => {
      if (response.status === 404) return { status: 404 };
      if (!response.ok) return { status: 503 };
      const meta = JSON.parse(await boundedText(response, 128000));
      if (!meta || typeof meta !== "object" || Array.isArray(meta) || meta.id !== id) return { status: 503 };
      const visibility = meta.visibility ?? (meta.unlisted ? "unlisted" : "public");
      if (!["public", "unlisted"].includes(visibility)) return { status: 404 };
      return { status: 200, meta };
    });
  } catch {
    return { status: 503 };
  }
}

async function findImage(id, fetcher) {
  // Existing uploads work immediately; new uploads gain a broadly supported JPEG.
  for (const [file, type] of [
    ["thumbnail_share.jpg", "image/jpeg"],
    ["thumbnail_sdr_720p.webp", "image/webp"],
    ["thumbnail_sdr.webp", "image/webp"],
  ]) {
    const url = `${CDN}/${id}/${file}`;
    try {
      const response = await timedFetch(fetcher, url, { method: "HEAD", redirect: "error" });
      if (response.ok) return { url, type };
    } catch { /* Try an older thumbnail if this one is absent or unavailable. */ }
  }
  return null;
}

function shareData(id, meta, image, origin) {
  return {
    id, image: image ? { url: `${origin}/preview-image?v=${encodeURIComponent(id)}`, type: image.type } : null,
    url: watchUrl(id, origin), player: embedUrl(id, origin),
    title: text(meta.title, "Untitled video", 200),
    description: text(meta.description, DEFAULT_DESCRIPTION, 300),
  };
}

function metaTag(key, value, attribute = "property") {
  return `<meta ${attribute}="${key}" content="${escapeHtml(value)}" />`;
}

export function renderShareHead(data, { embed = false } = {}) {
  const tags = [
    `<title>${escapeHtml(data ? `${data.title} · Aida` : "Watch · Aida")}</title>`,
    metaTag("description", data?.description || DEFAULT_DESCRIPTION, "name"),
    metaTag("og:site_name", "Aida"),
    metaTag("og:title", data?.title || "Aida"),
    metaTag("og:description", data?.description || DEFAULT_DESCRIPTION),
    metaTag("og:type", data ? "video.other" : "website"),
    metaTag("twitter:card", data?.image ? "summary_large_image" : "summary", "name"),
    metaTag("twitter:title", data?.title || "Aida", "name"),
    metaTag("twitter:description", data?.description || DEFAULT_DESCRIPTION, "name"),
  ];
  if (data) {
    tags.push(`<link rel="canonical" href="${escapeHtml(data.url)}" />`, metaTag("og:url", data.url));
    if (data.image) {
      tags.push(
        metaTag("og:image", data.image.url), metaTag("og:image:secure_url", data.image.url),
        metaTag("og:image:type", data.image.type), metaTag("og:image:alt", data.title),
        metaTag("twitter:image", data.image.url, "name"), metaTag("twitter:image:alt", data.title, "name"),
      );
    }
    tags.push(
      metaTag("og:video", data.player), metaTag("og:video:secure_url", data.player),
      metaTag("og:video:type", "text/html"), metaTag("og:video:width", "1280"), metaTag("og:video:height", "720"),
      `<link rel="alternate" type="application/json+oembed" href="${escapeHtml(new URL(`/oembed?url=${encodeURIComponent(data.url)}&format=json`, data.url).href)}" title="${escapeHtml(data.title)}" />`,
    );
  }
  if (embed) tags.push(
    '<meta name="robots" content="noindex" />',
    // Reuse the actual player, including its codec selection and 120 fps streams.
    `<style>
      html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; background: #000; }
      body > .skip-link, .site-header, .site-footer, .watch-navigation,
      .watch-info, .shortcut-guide, .more-videos { display: none !important; }
      body .watch-main, body.theatre-mode .watch-main { position: fixed; inset: 0; width: 100%; max-width: none; margin: 0; padding: 0; }
      body .watch-stage, body.theatre-mode .watch-stage { width: 100%; height: 100%; margin: 0; border: 0; border-radius: 0; }
      body > #player-wrap, body .watch-stage #player-wrap, body.theatre-mode .watch-stage #player-wrap { width: 100%; height: 100%; max-height: none; min-height: 0; border-radius: 0; aspect-ratio: auto; }
    </style>`,
  );
  return tags.join("\n    ");
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").toLowerCase();
}

/** Only rewrite the controlled watch template's head; never touch the player body. */
export function rewriteWatchHtml(html, data, options) {
  return html.replace(/(<head\b[^>]*>)([\s\S]*?)(<\/head\s*>)/i, (_match, open, head, close) => {
    const cleaned = head.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, "")
      .replace(/<(?:meta|link)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi, (tag) => {
        const key = attribute(tag, "property") || attribute(tag, "name");
        if (/^<meta\b/i.test(tag) && (key === "description" || key.startsWith("og:") || key.startsWith("twitter:") || /\scharset\s*=/i.test(tag))) return "";
        if (/^<link\b/i.test(tag) && (attribute(tag, "rel") === "canonical" || attribute(tag, "type") === "application/json+oembed")) return "";
        return tag;
      });
    return `${open}\n    <meta charset="UTF-8" />\n    ${renderShareHead(data, options)}${cleaned}${close}`;
  });
}

function errorResponse(status, json = false) {
  const message = status === 404 ? "Video not found" : status === 400 ? "Invalid video URL" : "Preview temporarily unavailable";
  return new Response(json ? JSON.stringify({ error: message }) : message, {
    status, headers: {
      "Content-Type": json ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      ...(json ? { "Access-Control-Allow-Origin": "*" } : {}),
    },
  });
}

function oembedId(url, origin) {
  try {
    const target = new URL(url);
    // Production www links are aliases; no third-party fetch target comes from input.
    const origins = new Set([origin, ...(origin === SITE ? ["https://www.keppy.dev"] : [])]);
    if (!origins.has(target.origin) || target.username || target.password || !WATCH_PATHS.has(target.pathname)) return null;
    const id = target.searchParams.get("v");
    return VIDEO_ID.test(id || "") ? id : null;
  } catch { return null; }
}

function embedSize(params) {
  const limit = (key, fallback) => {
    if (!params.has(key)) return fallback;
    const value = Number(params.get(key));
    return Number.isInteger(value) && value > 0 ? value : NaN;
  };
  const width = Math.floor(Math.min(1280, limit("maxwidth", 1280), limit("maxheight", 720) * 16 / 9));
  return Number.isFinite(width) && width >= 2 ? { width, height: Math.max(1, Math.floor(width * 9 / 16)) } : null;
}

async function routeRequest(request, env, fetcher) {
  const url = new URL(request.url);
  const embed = url.pathname === "/embed";
  const oembed = url.pathname === "/oembed";
  const imageRoute = url.pathname === "/preview-image";
  if (!WATCH_PATHS.has(url.pathname) && !embed && !oembed && !imageRoute) return fetcher(request);
  if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const origin = siteOrigin(env);
  const id = oembed ? oembedId(url.searchParams.get("url"), origin) : (url.searchParams.get("v") || "0");
  if (!id || !VIDEO_ID.test(id)) return errorResponse(400, oembed);
  if (oembed && url.searchParams.has("format") && url.searchParams.get("format") !== "json") return new Response("Only JSON is supported", { status: 501 });
  const size = oembed ? embedSize(url.searchParams) : null;
  if (oembed && !size) return errorResponse(400, true);

  const video = await readVideo(id, fetcher);
  if (video.status !== 200 && (embed || oembed || imageRoute)) return errorResponse(video.status, oembed);
  const image = video.meta && !oembed ? await findImage(id, fetcher) : null;
  if (imageRoute) {
    if (!image) return errorResponse(404);
    try {
      const source = await timedFetch(fetcher, image.url, { method: request.method, redirect: "error" });
      if (!source.ok) return errorResponse(source.status === 404 ? 404 : 503);
      // Older B2 uploads used application/octet-stream. Correct it without
      // changing any bucket objects, preserving private-video checks above.
      return new Response(request.method === "HEAD" ? null : source.body, { headers: {
        "Content-Type": image.type, "Content-Disposition": "inline",
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      } });
    } catch { return errorResponse(503); }
  }
  const data = video.meta ? shareData(id, video.meta, image, origin) : null;
  if (oembed) {
    const body = {
      version: "1.0", type: "video", provider_name: "Aida", provider_url: origin,
      title: data.title, ...size,
      html: `<iframe src="${escapeHtml(data.player)}" width="${size.width}" height="${size.height}" title="${escapeHtml(data.title)}" loading="lazy" allow="fullscreen; picture-in-picture; encrypted-media" allowfullscreen style="border:0;max-width:100%"></iframe>`,
    };
    return new Response(request.method === "HEAD" ? null : JSON.stringify(body), { headers: {
      "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    } });
  }

  // A same-zone route subrequest goes to the existing origin, not back into this Worker.
  const source = new URL("/watch.html", origin);
  source.searchParams.set("v", id);
  let response, html;
  try {
    ({ response, html } = await timedFetch(fetcher, source.href, {
      headers: { Accept: "text/html" }, redirect: "manual",
    }, async (response) => ({
      response,
      html: response.ok && response.headers.get("Content-Type")?.includes("text/html")
        ? await boundedText(response, 1024000) : null,
    })));
  } catch { return errorResponse(503); }
  if (html === null) return response;
  const headers = new Headers(response.headers);
  for (const name of ["Content-Length", "Content-Encoding", "ETag", "Last-Modified"]) headers.delete(name);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  if (embed) {
    headers.delete("X-Frame-Options");
    const csp = (headers.get("Content-Security-Policy") || "").replace(/(?:^|;)\s*frame-ancestors\s+[^;]*/gi, "");
    headers.set("Content-Security-Policy", `${csp}${csp ? "; " : ""}frame-ancestors *`);
    headers.set("X-Robots-Tag", "noindex");
  }
  return new Response(request.method === "HEAD" ? null : rewriteWatchHtml(html, data, { embed }), { headers });
}

export async function handleRequest(request, env = {}, fetcher = fetch) {
  const response = await routeRequest(request, env, fetcher);
  return request.method === "HEAD" ? new Response(null, response) : response;
}

export default {
  fetch(request, env) { return handleRequest(request, env); },
};
