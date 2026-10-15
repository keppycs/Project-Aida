import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker, { handleRequest, rewriteWatchHtml } from "../edge/share-worker.mjs";

const template = await readFile(new URL("../docs/watch.html", import.meta.url), "utf8");
const site = "https://keppy.dev";
const cdn = "https://cdn.keppy.dev/file/ProjectAida";
const id = "test-video_120";
const previewImageUrl = `${site}/preview-image?v=${id}`;
const imageBytes = new Uint8Array([0, 255, 2, 128, 13, 10, 0, 77]);
const title = 'Title </title><script>alert("x")</script> & café';
const description = 'Description " onload="alert(1) <img src=x> & more';
const escapedTitle = "Title &lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; café";
const escapedDescription = "Description &quot; onload=&quot;alert(1) &lt;img src=x&gt; &amp; more";
const metadata = { id, title, description, visibility: "public", frameRate: 120 };

function fixture({ meta = metadata, raw, metadataStatus = 200, metadataThrows = false,
  images = ["thumbnail_share.jpg"], imageGetStatus = 200, imageGetThrows = false,
  originStatus = 200, originHtml = template } = {}) {
  const calls = [];
  const fetcher = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init.method || (input instanceof Request ? input.method : "GET");
    calls.push({ url, method, init });
    if (url === `${cdn}/${id}/metadata.json`) {
      if (metadataThrows) throw new Error("Metadata offline");
      return new Response(raw ?? JSON.stringify(meta), { status: metadataStatus });
    }
    if (url.startsWith(`${cdn}/${id}/thumbnail_`)) {
      assert.ok(method === "HEAD" || method === "GET");
      if (method === "GET" && imageGetThrows) throw new Error("Image offline");
      const status = images.includes(url.split("/").pop()) ? (method === "GET" ? imageGetStatus : 200) : 404;
      return new Response(method === "HEAD" ? null : status === 200 ? imageBytes : "UPSTREAM_IMAGE_ERROR", {
        status, headers: {
          // Existing B2 thumbnails use this MIME type; the public image route
          // must supply the selected image's actual type to preview crawlers.
          "Content-Type": "application/octet-stream", "Content-Disposition": "attachment",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }
    if (url === `${site}/watch.html?v=${id}`) {
      return new Response(originHtml, { status: originStatus, headers: {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600",
        "Content-Length": "123", "Content-Encoding": "gzip", ETag: "old-template",
        "Last-Modified": "Wed, 14 Oct 2026 00:00:00 GMT", "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; object-src 'none'",
      } });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  return { calls, fetcher };
}

function request(path, options) {
  return new Request(new URL(path, site), options);
}

function oembedPath(params = {}) {
  return `/oembed?${new URLSearchParams({ url: `${site}/watch?v=${id}`, ...params })}`;
}

function body(html) {
  return html.slice(html.indexOf("<body>"));
}

function contents(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...html.matchAll(new RegExp(`<meta (?:property|name)="${escaped}" content="([^"]*)"`, "g"))]
    .map((match) => match[1]);
}

function assertSafeHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  for (const name of ["content-length", "content-encoding", "etag", "last-modified"]) {
    assert.equal(response.headers.get(name), null, name);
  }
}

for (const path of ["/watch", "/watch.html"]) {
  for (const visibility of ["public", "unlisted"]) {
    test(`${path} serves escaped ${visibility} preview metadata while preserving the player`, async () => {
      const { calls, fetcher } = fixture({ meta: { ...metadata, visibility } });
      const response = await handleRequest(request(`${path}?v=${id}&t=15&local=1`), {}, fetcher);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.equal(body(html), body(template));
      assert.deepEqual(contents(html, "og:title"), [escapedTitle]);
      assert.deepEqual(contents(html, "og:description"), [escapedDescription]);
      assert.deepEqual(contents(html, "og:url"), [`${site}/watch?v=${id}`]);
      assert.deepEqual(contents(html, "og:image"), [previewImageUrl]);
      assert.deepEqual(contents(html, "og:image:secure_url"), [previewImageUrl]);
      assert.deepEqual(contents(html, "twitter:image"), [previewImageUrl]);
      assert.deepEqual(contents(html, "og:image:type"), ["image/jpeg"]);
      assert.deepEqual(contents(html, "twitter:card"), ["summary_large_image"]);
      assert.deepEqual(contents(html, "og:video"), [`${site}/embed?v=${id}`]);
      assert.match(html, /rel="alternate" type="application\/json\+oembed"/);
      assert.match(html, /<title>Title &lt;\/title&gt;/);
      assert.doesNotMatch(html, /<script>alert\(/);
      assert.doesNotMatch(html, /<img src=x>/);
      assert.equal(html.match(/<title\b/g).length, 1);
      assert.match(html, /src="js\/watch.js"/);
      assert.match(html, /href="css\/player.css"/);
      assertSafeHeaders(response);
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
      assert.equal(calls[0].init.headers["Cache-Control"], "no-cache");
      assert.equal(calls[0].init.cf.cacheTtl, 0);
      assert.equal(calls[0].init.cache, "no-store");
      assert.equal(calls[0].init.cf.cacheTtlByStatus["100-599"], -1);
      assert.equal(calls[0].init.redirect, "error");
      assert.ok(calls.every((call) => !call.url.includes("index.json")));
    });
  }
}

test("head rewriting replaces duplicate metadata and keeps unrelated template assets", () => {
  const duplicated = template.replace("</head>", `
    <TITLE>Outdated duplicate</TITLE><meta charset='latin1'>
    <meta property='og:title' content='Outdated title'>
    <meta content="Outdated image" property=og:image>
    <meta name='twitter:card' content='summary'>
    <meta name=description content="Outdated description">
    <link rel='canonical' href='https://example.invalid/'>
    <link type='application/json+oembed' href='https://example.invalid/oembed'>
    </head>`);
  const data = { id, title, description, url: `${site}/watch?v=${id}`,
    player: `${site}/embed?v=${id}`, image: { url: `${cdn}/${id}/thumbnail_share.jpg`, type: "image/jpeg" } };
  const result = rewriteWatchHtml(duplicated, data);
  assert.equal(body(result), body(template));
  assert.equal(result.match(/<title\b/gi).length, 1);
  assert.equal(result.match(/<meta\s+charset=/gi).length, 1);
  assert.equal(result.match(/rel="canonical"/g).length, 1);
  assert.equal(result.match(/application\/json\+oembed/g).length, 1);
  assert.deepEqual(contents(result, "og:title"), [escapedTitle]);
  assert.deepEqual(contents(result, "description"), [escapedDescription]);
  assert.doesNotMatch(result, /Outdated|example\.invalid|latin1/);
  assert.match(result, /name="viewport"/);
  assert.match(result, /rel="icon"/);
  assert.match(result, /shaka-player@/);
});

test("old uploads fall back from JPEG to existing WebP thumbnails", async (t) => {
  for (const file of ["thumbnail_sdr_720p.webp", "thumbnail_sdr.webp"]) {
    await t.test(file, async () => {
      const { calls, fetcher } = fixture({ images: [file] });
      const html = await (await handleRequest(request(`/watch?v=${id}`), {}, fetcher)).text();
      assert.deepEqual(contents(html, "og:image"), [previewImageUrl]);
      assert.deepEqual(contents(html, "og:image:type"), ["image/webp"]);
      const probes = calls.filter((call) => call.method === "HEAD");
      assert.ok(probes[0].url.endsWith("thumbnail_share.jpg"));
      assert.ok(probes.at(-1).url.endsWith(file));
    });
  }
});

test("image proxy streams existing JPEG or WebP bytes with the correct public MIME type", async (t) => {
  for (const [file, type] of [
    ["thumbnail_share.jpg", "image/jpeg"],
    ["thumbnail_sdr_720p.webp", "image/webp"],
    ["thumbnail_sdr.webp", "image/webp"],
  ]) {
    for (const method of ["GET", "HEAD"]) {
      await t.test(`${method} ${file}`, async () => {
        const { calls, fetcher } = fixture({ images: [file] });
        const response = await handleRequest(request(`/preview-image?v=${id}`, { method }), {}, fetcher);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), type);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.equal(response.headers.get("content-disposition"), "inline");
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), method === "HEAD" ? new Uint8Array() : imageBytes);
        assert.equal(calls[0].url, `${cdn}/${id}/metadata.json`);
        assert.equal(calls.at(-1).url, `${cdn}/${id}/${file}`);
        assert.equal(calls.at(-1).method, method);
        assert.ok(calls.every((call) => !call.url.startsWith(`${site}/watch.html`)));
      });
    }
  }
});

test("image proxy fails safely when no thumbnail exists or selected image disappears", async (t) => {
  for (const [name, options, status] of [
    ["no existing thumbnail", { images: [] }, 404],
    ["image vanishes after HEAD", { imageGetStatus: 404 }, 404],
    ["image server error", { imageGetStatus: 500 }, 503],
    ["image network error", { imageGetThrows: true }, 503],
  ]) {
    await t.test(name, async () => {
      const { fetcher } = fixture(options);
      const response = await handleRequest(request(`/preview-image?v=${id}`), {}, fetcher);
      assert.equal(response.status, status);
      assert.match(response.headers.get("content-type"), /text\/plain/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.doesNotMatch(await response.text(), /UPSTREAM_IMAGE_ERROR|SECRET_TITLE|SECRET_DESCRIPTION/);
    });
  }
});

test("no thumbnail produces a useful text card and oEmbed without a broken image", async () => {
  const { fetcher } = fixture({ images: [] });
  const html = await (await handleRequest(request(`/watch?v=${id}`), {}, fetcher)).text();
  assert.deepEqual(contents(html, "twitter:card"), ["summary"]);
  assert.deepEqual(contents(html, "og:image"), []);
  assert.deepEqual(contents(html, "twitter:image"), []);
  assert.deepEqual(contents(html, "og:title"), [escapedTitle]);
  const json = await (await handleRequest(request(oembedPath()), {}, fetcher)).json();
  assert.equal(json.title, title);
  assert.equal(Object.hasOwn(json, "thumbnail_url"), false);
});

const failures = [
  ["private", { meta: { ...metadata, visibility: "private", title: "SECRET_TITLE", description: "SECRET_DESCRIPTION" } }, 404],
  ["invalid visibility", { meta: { ...metadata, visibility: "invalid", title: "SECRET_TITLE" } }, 404],
  ["malformed JSON", { raw: '{"title":"SECRET_TITLE"' }, 503],
  ["mismatched ID", { meta: { ...metadata, id: "other-video", title: "SECRET_TITLE" } }, 503],
  ["array metadata", { meta: [metadata] }, 503],
  ["oversized metadata", { raw: " ".repeat(128001) }, 503],
  ["missing metadata", { metadataStatus: 404 }, 404],
  ["upstream error", { metadataStatus: 500 }, 503],
  ["network error", { metadataThrows: true }, 503],
];

for (const [name, options, status] of failures) {
  test(`${name} reveals no video metadata and cannot be embedded`, async () => {
    const { calls, fetcher } = fixture(options);
    const response = await handleRequest(request(`/watch?v=${id}`), {}, fetcher);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(contents(html, "og:title"), ["Aida"]);
    assert.deepEqual(contents(html, "og:image"), []);
    assert.deepEqual(contents(html, "og:video"), []);
    assert.equal(body(html), body(template));
    assert.doesNotMatch(html, /SECRET_TITLE|SECRET_DESCRIPTION|<script>alert\(/);
    for (const path of [`/embed?v=${id}`, oembedPath(), `/preview-image?v=${id}`]) {
      const rejected = await handleRequest(request(path), {}, fetcher);
      assert.equal(rejected.status, status, path);
      assert.equal(rejected.headers.get("cache-control"), "no-store");
      assert.doesNotMatch(await rejected.text(), /SECRET_TITLE|SECRET_DESCRIPTION/);
    }
    assert.equal(calls.filter((call) => call.method === "HEAD").length, 0);
  });
}

test("legacy unlisted metadata remains shareable", async () => {
  const { visibility, ...legacy } = metadata;
  const { fetcher } = fixture({ meta: { ...legacy, unlisted: true } });
  const result = await (await handleRequest(request(oembedPath()), {}, fetcher)).json();
  assert.equal(result.title, title);
});

test("invalid IDs are rejected before any fetch", async () => {
  for (const invalid of ["../secret", "a/b", "with space", "<script>", "café", "x".repeat(129)]) {
    const { calls, fetcher } = fixture();
    for (const route of ["/watch", "/watch.html", "/embed", "/preview-image"]) {
      const response = await handleRequest(request(`${route}?${new URLSearchParams({ v: invalid })}`), {}, fetcher);
      assert.equal(response.status, 400, `${route}: ${invalid}`);
    }
    assert.equal(calls.length, 0);
  }
});

test("oEmbed only accepts local HTTPS watch URLs and valid JSON requests", async () => {
  const invalidUrls = ["", "not-a-url", "http://keppy.dev/watch?v=test", "https://evil.test/watch?v=test",
    "https://keppy.dev.evil.test/watch?v=test", "https://user:pass@keppy.dev/watch?v=test",
    "https://keppy.dev:8443/watch?v=test", `${site}/embed?v=${id}`, `${site}/watch`, `${site}/watch?v=a%2Fb`];
  const { calls, fetcher } = fixture();
  for (const url of invalidUrls) {
    const response = await handleRequest(request(oembedPath({ url })), {}, fetcher);
    assert.equal(response.status, 400, url);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  }
  const unsupported = await handleRequest(request(oembedPath({ format: "xml" })), {}, fetcher);
  assert.equal(unsupported.status, 501);
  assert.equal(calls.length, 0);
  for (const path of ["https://www.keppy.dev/watch?v=", `${site}/watch.html?v=`]) {
    assert.equal((await handleRequest(request(oembedPath({ url: path + id })), {}, fetcher)).status, 200);
  }
});

test("oEmbed escapes iframe markup and scales dimensions within both bounds", async () => {
  const { calls, fetcher } = fixture();
  for (const [params, expected] of [
    [{}, { width: 1280, height: 720 }],
    [{ maxwidth: "640" }, { width: 640, height: 360 }],
    [{ maxheight: "100" }, { width: 177, height: 99 }],
    [{ maxwidth: "500", maxheight: "100" }, { width: 177, height: 99 }],
    [{ maxwidth: "9000", maxheight: "9000" }, { width: 1280, height: 720 }],
  ]) {
    const response = await handleRequest(request(oembedPath(params)), {}, fetcher);
    const data = await response.json();
    assert.equal(data.version, "1.0");
    assert.equal(data.type, "video");
    assert.equal(data.title, title);
    assert.equal(data.provider_url, site);
    assert.deepEqual({ width: data.width, height: data.height }, expected);
    assert.equal(Object.hasOwn(data, "thumbnail_url"), false);
    assert.match(data.html, new RegExp(`width="${expected.width}" height="${expected.height}"`));
    assert.ok(data.html.includes(`title="${escapedTitle}"`));
    assert.ok(data.html.includes(`src="${site}/embed?v=${id}"`));
    assert.doesNotMatch(data.html, /<script>|onload=|autoplay/);
    assert.match(data.html, /allowfullscreen/);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assertSafeHeaders(response);
  }
  assert.equal(calls.filter((call) => call.method === "HEAD").length, 0);
});

test("invalid oEmbed bounds are rejected before fetch", async () => {
  const { calls, fetcher } = fixture();
  for (const params of [ { maxwidth: "0" }, { maxheight: "-1" }, { maxwidth: "1" },
    { maxwidth: "Infinity" }, { maxwidth: "20.5" }, { maxheight: "bad" }, { maxwidth: "" } ]) {
    assert.equal((await handleRequest(request(oembedPath(params)), {}, fetcher)).status, 400, JSON.stringify(params));
  }
  assert.equal(calls.length, 0);
});

test("embed reuses the player with full-frame layout and appropriate framing headers", async () => {
  const { fetcher } = fixture();
  const response = await handleRequest(request(`/embed?v=${id}`), {}, fetcher);
  const html = await response.text();
  assert.equal(body(html), body(template));
  assert.match(html, /body \.watch-main[^{}]*\{ position: fixed; inset: 0;/);
  assert.match(html, /body\.theatre-mode \.watch-main/);
  assert.match(html, /#player-wrap \{[^}]*height: 100%;[^}]*aspect-ratio: auto;/);
  assert.match(html, /\.watch-info[^}]*display: none !important;/);
  assert.deepEqual(contents(html, "robots"), ["noindex"]);
  assert.equal(response.headers.get("x-robots-tag"), "noindex");
  assert.equal(response.headers.get("x-frame-options"), null);
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors \*/);
  assert.doesNotMatch(csp, /frame-ancestors 'none'/);
  assert.equal(csp.match(/frame-ancestors/g).length, 1);
  assertSafeHeaders(response);
});

test("metadata timeout includes a stalled response body", async (t) => {
  const realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => realTimeout(callback, Math.min(delay, 10)));
  const { fetcher } = fixture();
  let aborted = false;
  const stalledFetch = async (url, init) => {
    if (String(url).endsWith("/metadata.json")) {
      return new Response(new ReadableStream({
        start(controller) {
          init.signal.addEventListener("abort", () => {
            aborted = true;
            controller.error(new Error("Body read aborted"));
          }, { once: true });
        },
      }));
    }
    return fetcher(url, init);
  };
  const html = await (await handleRequest(request(`/watch?v=${id}`), {}, stalledFetch)).text();
  assert.equal(aborted, true);
  assert.doesNotMatch(html, /thumbnail_share\.jpg/);
  assert.deepEqual(contents(html, "og:title"), ["Aida"]);
});

test("embeds also support the original player-only watch template", async () => {
  const legacy = '<!doctype html><html><head><title>Project Aida</title></head><body><div id="player-wrap"><video id="video" playsinline></video></div></body></html>';
  const { fetcher } = fixture({ originHtml: legacy });
  const html = await (await handleRequest(request(`/embed?v=${id}`), {}, fetcher)).text();
  assert.equal(body(html), body(legacy));
  assert.match(html, /body > #player-wrap[^{}]*\{[^}]*height: 100%;/);
  assert.deepEqual(contents(html, "og:title"), [escapedTitle]);
});

test("HEAD returns the same headers with no success body for watch, embed and oEmbed", async () => {
  const { fetcher } = fixture();
  for (const path of [`/watch?v=${id}`, `/watch.html?v=${id}`, `/embed?v=${id}`, oembedPath()]) {
    const get = await handleRequest(request(path), {}, fetcher);
    const head = await handleRequest(request(path, { method: "HEAD" }), {}, fetcher);
    assert.equal(head.status, get.status);
    assert.deepEqual([...head.headers], [...get.headers]);
    assert.equal(await head.text(), "", path);
  }
});

test("HEAD error responses never contain a body", async () => {
  const { fetcher } = fixture({ meta: { ...metadata, visibility: "private" } });
  for (const path of ["/embed?v=a%2Fb", `/embed?v=${id}`, `/preview-image?v=${id}`, "/preview-image?v=a%2Fb", oembedPath(), oembedPath({ format: "xml" })]) {
    const response = await handleRequest(request(path, { method: "HEAD" }), {}, fetcher);
    assert.ok(response.status >= 400);
    assert.equal(await response.text(), "", path);
  }
});

test("other methods are rejected without fetching and unrelated routes pass through", async () => {
  const { calls, fetcher } = fixture();
  for (const path of [`/watch?v=${id}`, `/preview-image?v=${id}`]) {
    const response = await handleRequest(request(path, { method: "POST" }), {}, fetcher);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  }
  assert.equal(calls.length, 0);
  const original = request("/css/watch.css");
  let forwarded;
  const passthrough = await handleRequest(original, {}, async (input) => { forwarded = input; return new Response("asset"); });
  assert.equal(forwarded, original);
  assert.equal(await passthrough.text(), "asset");
});

test("Cloudflare fetch wrapper ignores ExecutionContext as a fetch implementation", async (t) => {
  const { calls, fetcher } = fixture();
  t.mock.method(globalThis, "fetch", fetcher);
  const context = { waitUntil() { throw new Error("Context must not be called as fetch"); } };
  const response = await worker.fetch(request(`/watch?v=${id}`), {}, context);
  assert.equal(response.status, 200);
  assert.ok(calls.length > 0);
  assert.deepEqual(contents(await response.text(), "og:title"), [escapedTitle]);
});
