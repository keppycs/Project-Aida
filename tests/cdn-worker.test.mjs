import assert from "node:assert/strict";
import test from "node:test";
import worker, { createHandler } from "../edge/cdn-worker.mjs";

const cdn = "https://cdn.keppy.dev";
const prefix = "/file/ProjectAida/";
const origin = "https://f003.backblazeb2.com";
const authorize = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account";
const id = "test-video_120";
const env = { B2_KEY_ID: "test-key", B2_SECRET_KEY: "test-secret" };
const meta = { id, title: "Current title", description: "Current description", visibility: "public", frameRate: 120, duration: 3, codecs: ["AV1", "HEVC"] };
const assets = ["metadata.json", "thumbnail_hdr.avif", "thumbnail_hdr_720p.avif", "thumbnail_sdr.webp", "thumbnail_sdr_720p.webp", "thumbnail_share.jpg", "AV1/manifest.mpd", "AV1/master.m3u8", "AV1/media_0.m3u8", "AV1/init_0.mp4", "AV1/chunk_0_1.fmp4", "HEVC/manifest.mpd", "HEVC/master.m3u8", "HEVC/media_8.m3u8", "HEVC/init_8.mp4", "HEVC/chunk_8_1.fmp4"];

function request(path = `${id}/metadata.json`, options) {
  return new Request(`${cdn}${prefix}${path}`, options);
}

function fixture({ metadata = meta, rawMetadata, metadataStatus = 200, index = [{ id, title: "STALE_TITLE", description: "STALE_DESCRIPTION" }], authorization, authStatus = 200, authThrows = false, assetStatus = 200, assetBody = () => "media bytes", assetHeaders = {}, onFetch, timeoutMs, cache, now } = {}) {
  const calls = [];
  const fetcher = async (input, init = {}) => {
    const url = String(input);
    const call = { url, init, method: init.method || "GET", headers: new Headers(init.headers) };
    calls.push(call);
    const override = await onFetch?.(call, calls);
    if (override) return override;
    if (url === authorize) {
      if (authThrows) throw new Error("SECRET_UPSTREAM_DETAILS");
      return Response.json(authorization ?? { downloadUrl: origin, authorizationToken: "origin-read-token", allowed: { bucketName: "ProjectAida", capabilities: ["readFiles"] } }, { status: authStatus });
    }
    assert.ok(url.startsWith(`${origin}${prefix}`), `Only fixed B2 bucket: ${url}`);
    if (url.endsWith("/index.json")) return Response.json(index);
    if (url.endsWith("/metadata.json")) {
      const value = typeof metadata === "function" ? metadata(url) : metadata;
      return new Response(rawMetadata ?? JSON.stringify(value), { status: metadataStatus });
    }
    return new Response(call.method === "HEAD" ? null : assetBody(), { status: assetStatus, headers: {
      "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=31536000", "X-Bz-File-Name": "PRIVATE_ORIGIN_DETAILS", "Set-Cookie": "PRIVATE_COOKIE", ...assetHeaders,
    } });
  };
  return { calls, handle: createHandler({ fetcher, timeoutMs, cache, now }) };
}

// Models Cloudflare's Cache API: the key ignores request headers, but a Range
// lookup against a full Content-Length response returns a partial response.
function memoryCache(now = Date.now) {
  const stored = new Map();
  const matches = [];
  const puts = [];
  return {
    stored, matches, puts,
    async match(req) {
      matches.push(req);
      const item = stored.get(req.url);
      if (!item || item.expires <= now()) return undefined;
      const headers = new Headers(item.headers);
      const range = req.headers.get("Range");
      if (!range) return new Response(item.bytes, { headers });
      const [, from, to] = /^bytes=([0-9]*)-([0-9]*)$/.exec(range);
      const start = from ? Number(from) : Math.max(0, item.bytes.length - Number(to));
      const end = from && to ? Math.min(Number(to), item.bytes.length - 1) : item.bytes.length - 1;
      if (start >= item.bytes.length || end < start) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${item.bytes.length}` } });
      const bytes = item.bytes.slice(start, end + 1);
      headers.set("Content-Length", String(bytes.length));
      headers.set("Content-Range", `bytes ${start}-${end}/${item.bytes.length}`);
      return new Response(bytes, { status: 206, headers });
    },
    async put(req, response) {
      puts.push({ request: req, headers: new Headers(response.headers), status: response.status });
      assert.equal(req.method, "GET");
      assert.equal(req.headers.get("Range"), null);
      assert.equal(response.status, 200);
      const ttl = Number(/max-age=([0-9]+)/.exec(response.headers.get("Cache-Control"))[1]);
      stored.set(req.url, { bytes: new Uint8Array(await response.arrayBuffer()), headers: new Headers(response.headers), expires: now() + ttl * 1000 });
    },
  };
}

function executionContext() {
  const tasks = [];
  return { waitUntil(task) { tasks.push(task); }, async drain() { await Promise.all(tasks); } };
}

test("module exports an ES-module Worker", () => {
  assert.equal(typeof worker.fetch, "function");
});

for (const visibility of ["private", "invalid", null, false]) {
  test(`${String(visibility)} visibility blocks every packaged asset and HEAD`, async () => {
    const { calls, handle } = fixture({ metadata: { ...meta, visibility, title: "PRIVATE_TITLE", description: "PRIVATE_DESCRIPTION" } });
    for (const asset of assets) {
      for (const method of ["GET", "HEAD"]) {
        const response = await handle(request(`${id}/${asset}`, { method }), env);
        assert.equal(response.status, 404, `${method} ${asset}`);
        assert.equal(response.headers.get("Cache-Control"), "no-store");
        assert.doesNotMatch(await response.text(), /PRIVATE_|origin-read-token|test-secret/);
      }
    }
    assert.ok(calls.filter(call => call.url !== authorize).every(call => call.url.endsWith("/metadata.json")));
  });
}

for (const visibility of ["public", "unlisted"]) {
  test(`${visibility} allows all packaged paths without leaking origin headers`, async () => {
    const { handle } = fixture({ metadata: { ...meta, visibility } });
    for (const asset of assets) {
      const response = await handle(request(`${id}/${asset}`), env);
      assert.equal(response.status, 200, asset);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("CDN-Cache-Control"), "no-store");
      assert.equal(response.headers.get("Cloudflare-CDN-Cache-Control"), "no-store");
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
      assert.equal(response.headers.get("Set-Cookie"), null);
      assert.equal(response.headers.get("X-Bz-File-Name"), null);
    }
  });
}

test("legacy metadata stays playable, including historical folder/id mismatch", async () => {
  const { visibility, ...legacy } = meta;
  const { handle } = fixture({ metadata: { ...legacy, id: "id2" } });
  const response = await handle(request("legacy-folder/metadata.json"), { ...env, LEGACY_VISIBILITY: JSON.stringify({ "legacy-folder": "public" }) });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.id, "id2");
  assert.equal(data.visibility, "public");
});

test("legacy unlisted is playable but never listed", async () => {
  const { visibility, ...legacy } = meta;
  const { handle } = fixture({ metadata: { ...legacy, unlisted: true } });
  const legacyEnv = { ...env, LEGACY_VISIBILITY: JSON.stringify({ [id]: "unlisted" }) };
  assert.equal((await handle(request(`${id}/AV1/chunk_0_1.fmp4`), legacyEnv)).status, 200);
  assert.deepEqual(await (await handle(request("index.json"), legacyEnv)).json(), []);
});

test("unknown legacy uploads and invalid compatibility maps fail closed", async () => {
  const { visibility, ...legacy } = meta;
  for (const LEGACY_VISIBILITY of [undefined, "{}", "broken", "[]", "null", JSON.stringify({ [id]: "private" }), JSON.stringify({ [id]: "public", "../invalid": "public" }), JSON.stringify({ unknown: "public" })]) {
    const { handle } = fixture({ metadata: legacy });
    assert.equal((await handle(request(`${id}/AV1/init_0.mp4`), { ...env, LEGACY_VISIBILITY })).status, 404);
  }
});

test("legacy compatibility never overrides explicit visibility or malformed metadata", async () => {
  const legacyEnv = { ...env, LEGACY_VISIBILITY: JSON.stringify({ [id]: "public" }) };
  for (const metadata of [{ ...meta, visibility: "private" }, { ...meta, visibility: null }, { ...meta, visibility: "invalid" }, { id, title: "Legacy unlisted", unlisted: true }]) {
    const { handle } = fixture({ metadata });
    assert.equal((await handle(request(`${id}/AV1/init_0.mp4`), legacyEnv)).status, 404);
  }
});

for (const metadata of [null, [], {}, { title: "Missing ID" }, { id, title: null }, { ...meta, id: "../secret" }, { id, title: "Legacy", unlisted: "false" }]) {
  test(`malformed metadata fails closed: ${JSON.stringify(metadata)}`, async () => {
    const { calls, handle } = fixture({ metadata });
    const response = await handle(request(`${id}/thumbnail_share.jpg`), env);
    assert.equal(response.status, 404);
    assert.equal(calls.filter(call => call.url.endsWith(".jpg")).length, 0);
  });
}

test("malformed JSON, oversized declared/chunked metadata, and missing metadata never release assets", async () => {
  for (const options of [{ rawMetadata: "bad json" }, { rawMetadata: " ".repeat(128_001) }, { metadataStatus: 404 }, { metadataStatus: 500 }, { onFetch: call => call.url.endsWith("/metadata.json") ? new Response("{}", { headers: { "Content-Length": "128001" } }) : null }]) {
    const { calls, handle } = fixture(options);
    const response = await handle(request(`${id}/AV1/init_0.mp4`), env);
    assert.ok([404, 503].includes(response.status));
    assert.equal(calls.filter(call => call.url.endsWith(".mp4")).length, 0);
  }
});

test("rejects arbitrary B2 APIs, other buckets, unexpected files and non-catalogue queries before authorization", async () => {
  const { calls, handle } = fixture();
  for (const path of [
    "/", "/b2api/v2/b2_download_file_by_id?fileId=secret", "/file/OtherBucket/index.json", "/file/ProjectAida/", "/file/ProjectAida/.env", "/file/ProjectAida/%2e%2e/secret", "/file/ProjectAida/test%2fsecret/metadata.json", "/file/ProjectAida/test%252fsecret/metadata.json",
    `${prefix}${id}/metadata.json?version=old`, `${prefix}${id}/metadata.json?fileId=old`, `${prefix}${id}/metadata.json?Authorization=secret`, `${prefix}${id}/metadata.json?`,
    `${prefix}${id}/source.mp4`, `${prefix}${id}/log.txt`, `${prefix}${id}/extra/metadata.json`, `${prefix}${id}/AV1/metadata.json`, `${prefix}${id}/VP9/master.m3u8`, `${prefix}${id}/AV1/chunk_x_1.fmp4`, `${prefix}${id}/AV1/other.mp4`,
  ]) {
    assert.equal((await handle(new Request(`${cdn}${path}`), env)).status, 404, path);
  }
  assert.equal(calls.length, 0);
});

test("only read methods and simple Range CORS preflights are supported", async () => {
  const { calls, handle } = fixture();
  const response = await handle(request(undefined, { method: "POST", body: "PRIVATE_UPLOAD" }), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "GET, HEAD, OPTIONS");
  const preflight = await handle(request(undefined, { method: "OPTIONS", headers: { Origin: "https://keppy.dev", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "range" } }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Headers"), "Range");
  assert.equal(preflight.headers.get("Access-Control-Allow-Credentials"), null);
  assert.equal(calls.length, 0);
});

test("HTTP redirects to HTTPS before origin access", async () => {
  const { calls, handle } = fixture();
  const response = await handle(new Request(`http://cdn.keppy.dev${prefix}${id}/metadata.json`), env);
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("Location"), `${cdn}${prefix}${id}/metadata.json`);
  assert.equal(calls.length, 0);
});

test("visitor credentials and cache/conditional headers never reach origin", async () => {
  const { calls, handle } = fixture();
  await handle(request(`${id}/AV1/chunk_0_1.fmp4`, { headers: {
    Authorization: "Bearer VISITOR_SECRET", Cookie: "private=VISITOR_COOKIE", "X-Forwarded-Host": "evil.example", "If-None-Match": "*", "If-Modified-Since": "Wed, 01 Jan 2020 00:00:00 GMT", "Cache-Control": "only-if-cached", Range: "bytes=0-99",
  } }), env);
  for (const call of calls) {
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.cf?.cacheTtl, undefined, "Cloudflare rejects cf TTL overrides combined with cache:no-store");
    assert.doesNotMatch(JSON.stringify([...call.headers]), /VISITOR_|evil\.example|only-if-cached/);
    assert.equal(call.headers.get("Cookie"), null);
    assert.equal(call.headers.get("If-None-Match"), null);
    assert.equal(call.headers.get("If-Modified-Since"), null);
    if (call.url !== authorize) {
      assert.equal(call.headers.get("Authorization"), "origin-read-token");
      assert.equal(call.headers.get("Accept-Encoding"), "identity");
    }
  }
  assert.equal(calls.find(call => call.url.endsWith("/metadata.json")).headers.get("Range"), null);
  assert.equal(calls.at(-1).headers.get("Range"), "bytes=0-99");
});

test("range responses preserve exact streaming bytes and transport headers", async () => {
  let released = false;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const bytes = new Uint8Array([0, 255, 4, 120]);
  const { handle } = fixture({ assetStatus: 206, assetHeaders: { "Content-Range": "bytes 4-7/100", "Content-Length": "4", "Accept-Ranges": "bytes" }, assetBody: () => new ReadableStream({ async start(controller) { await waiting; released = true; controller.enqueue(bytes); controller.close(); } }) });
  const response = await handle(request(`${id}/AV1/chunk_0_1.fmp4`, { headers: { Range: "bytes=4-7" } }), env);
  assert.equal(released, false, "response returns before any video bytes are available");
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Range"), "bytes 4-7/100");
  assert.equal(response.headers.get("Content-Length"), "4");
  assert.equal(response.headers.get("Accept-Ranges"), "bytes");
  assert.equal(response.headers.get("Content-Type"), "video/mp4");
  release();
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("HEAD still checks visibility and forwards HEAD with range headers and no body", async () => {
  const { calls, handle } = fixture({ assetStatus: 206, assetHeaders: { "Content-Range": "bytes 0-9/100", "Content-Length": "10", "Accept-Ranges": "bytes" } });
  const response = await handle(request(`${id}/HEVC/init_8.mp4`, { method: "HEAD", headers: { Range: "bytes=0-9" } }), env);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Length"), "10");
  assert.equal(await response.text(), "");
  assert.equal(calls.find(call => call.url.endsWith("/metadata.json")).method, "GET");
  assert.equal(calls.at(-1).method, "HEAD");
});

test("invalid ranges fail without origin media requests; origin 416 retains total length", async () => {
  const { calls, handle } = fixture();
  for (const range of ["bytes=0-1,3-4", "items=0-1", "bytes=-", "bytes=anything", `bytes=${"1".repeat(101)}-`]) {
    assert.equal((await handle(request(`${id}/AV1/init_0.mp4`, { headers: { Range: range } }), env)).status, 416);
  }
  assert.equal(calls.filter(call => call.url.endsWith(".mp4")).length, 0);
  const originRange = fixture({ assetStatus: 416, assetHeaders: { "Content-Range": "bytes */100" } });
  const response = await originRange.handle(request(`${id}/AV1/init_0.mp4`, { headers: { Range: "bytes=100-" } }), env);
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("Content-Range"), "bytes */100");
  assert.equal(await response.text(), "");
});

test("a previously public asset immediately becomes inaccessible when origin metadata changes", async () => {
  let current = "public";
  const { calls, handle } = fixture({ metadata: () => ({ ...meta, visibility: current }) });
  assert.equal((await handle(request(`${id}/AV1/chunk_0_1.fmp4`), env)).status, 200);
  current = "private";
  assert.equal((await handle(request(`${id}/AV1/chunk_0_1.fmp4`), env)).status, 404);
  assert.equal(calls.filter(call => call.url.endsWith("/metadata.json")).length, 2);
  assert.equal(calls.filter(call => call.url.endsWith(".fmp4")).length, 1);
});

test("catalogue freshly gates public videos and replaces stale title/description, preserving folder IDs", async () => {
  const index = ["public", "private", "unlisted", "legacy", "removed", "bad", "public"].map(value => ({ id: value, title: "STALE_SECRET", description: "STALE_SECRET" }));
  index.push({ id: "../other", title: "INVALID" });
  const { calls, handle } = fixture({ index, metadata: url => {
    const folder = url.split("/").at(-2);
    if (folder === "removed") return null;
    if (folder === "bad") return { ...meta, visibility: "unexpected" };
    if (folder === "legacy") return { id: "id2", title: "Updated legacy", frameRate: 120 };
    return { ...meta, visibility: folder };
  } });
  const response = await handle(request("index.json"), { ...env, LEGACY_VISIBILITY: JSON.stringify({ legacy: "public" }) });
  assert.equal(response.status, 200);
  const entries = await response.json();
  assert.deepEqual(entries.map(entry => entry.id), ["public", "legacy"]);
  assert.equal(entries[0].title, "Current title");
  assert.equal(entries[0].description, "Current description");
  assert.equal(entries[1].title, "Updated legacy");
  assert.equal(Object.hasOwn(entries[1], "description"), false);
  assert.doesNotMatch(JSON.stringify(entries), /STALE_SECRET|INVALID|"private"|"unlisted"/);
  assert.equal(calls.filter(call => call.url.endsWith("public/metadata.json")).length, 1);
});

test("malformed or oversized catalogue fails closed before metadata fanout", async () => {
  for (const index of [{ invalid: true }, [{ id, title: "x".repeat(1_000_001) }]]) {
    const { calls, handle } = fixture({ index });
    assert.equal((await handle(request("index.json"), env)).status, 503);
    assert.equal(calls.filter(call => call.url.endsWith("/metadata.json")).length, 0);
  }
});

test("catalogue pagination covers more than 40 videos with bounded fresh checks per request", async () => {
  const index = Array.from({ length: 91 }, (_, number) => ({ id: `video-${number}` }));
  const { calls, handle } = fixture({ index });
  const listed = [];
  let url = request("index.json").url;
  for (let page = 0; url; page++) {
    const start = calls.length;
    const response = await handle(new Request(url), env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Access-Control-Expose-Headers"), /\bLink\b/);
    const entries = await response.json();
    assert.equal(entries.length, page < 2 ? 40 : 11);
    assert.equal(calls.slice(start).filter(call => call.url.endsWith("/metadata.json")).length, entries.length);
    assert.ok(calls.length - start <= 42, "page fits free Worker's subrequest budget");
    listed.push(...entries.map(entry => entry.id));
    const link = response.headers.get("Link");
    if (page < 2) assert.equal(link, `<${cdn}${prefix}index.json?page=${page + 1}>; rel="next"`);
    url = link?.match(/^<([^>]+)>; rel="next"$/)[1];
  }
  assert.deepEqual(listed, index.map(entry => entry.id));
  const beyond = await handle(request("index.json?page=99"), env);
  assert.deepEqual(await beyond.json(), []);
  assert.equal(beyond.headers.get("Link"), null);
});

test("catalogue empty filtered pages still link onward and each page rechecks visibility", async () => {
  let publicVisible = true;
  const index = Array.from({ length: 41 }, (_, number) => ({ id: `video-${number}` }));
  const { calls, handle } = fixture({ index, metadata: url => ({ ...meta, visibility: url.includes("/video-40/") && publicVisible ? "public" : "private" }) });
  const first = await handle(request("index.json"), env);
  assert.deepEqual(await first.json(), []);
  assert.equal(first.headers.get("Link"), `<${cdn}${prefix}index.json?page=1>; rel="next"`);
  const second = await handle(request("index.json?page=1"), env);
  assert.deepEqual((await second.json()).map(entry => entry.id), ["video-40"]);
  publicVisible = false;
  assert.deepEqual(await (await handle(request("index.json?page=1"), env)).json(), []);
  assert.equal(calls.filter(call => call.url.endsWith("video-40/metadata.json")).length, 2);
});

test("catalogue accepts only one canonical nonnegative integer page query", async () => {
  const { calls, handle } = fixture();
  for (const query of ["?", "?page", "?page=", "?page=-1", "?page=01", "?page=1.0", "?page=+1", "?page=%31", "?page=1&page=2", "?page=1&version=old", "?version=old", "?page=9007199254740991"]) {
    assert.equal((await handle(request(`index.json${query}`), env)).status, 404, query);
  }
  assert.equal(calls.length, 0);
  assert.equal((await handle(request("index.json?page=0"), env)).status, 200);
});

test("legacy compatibility map supports more than 40 reviewed videos within its size bound", async () => {
  const { visibility, ...legacy } = meta;
  const legacyMap = Object.fromEntries(Array.from({ length: 80 }, (_, number) => [`video-${number}`, "public"]));
  const { handle } = fixture({ metadata: legacy });
  assert.equal((await handle(request("video-79/metadata.json"), { ...env, LEGACY_VISIBILITY: JSON.stringify(legacyMap) })).status, 200);
});

test("internal media cache reduces origin reads while checking visibility before every hit", async () => {
  const cache = memoryCache();
  const ctx = executionContext();
  let visibility = "public";
  const { calls, handle } = fixture({ cache, metadata: () => ({ ...meta, visibility }), assetHeaders: { "Content-Length": "11" } });
  const path = `${id}/AV1/chunk_0_1.fmp4`;
  const first = await handle(request(path), env, ctx);
  assert.equal(await first.text(), "media bytes");
  await ctx.drain();
  assert.equal(cache.puts.length, 1);
  const second = await handle(request(path, { headers: { Cookie: "SECRET", Authorization: "Bearer SECRET", "If-None-Match": "*", "If-Modified-Since": "Thu, 01 Jan 2037 00:00:00 GMT" } }), env, ctx);
  assert.equal(second.status, 200);
  assert.equal(await second.text(), "media bytes");
  assert.equal(second.headers.get("Cache-Control"), "no-store");
  assert.equal(second.headers.get("CDN-Cache-Control"), "no-store");
  assert.equal(second.headers.get("Cloudflare-CDN-Cache-Control"), "no-store");
  assert.equal(cache.matches.at(-1).headers.get("If-None-Match"), null);
  assert.equal(cache.matches.at(-1).headers.get("If-Modified-Since"), null);
  assert.equal(cache.matches.at(-1).headers.get("Cookie"), null);
  assert.equal(calls.filter(call => call.url.endsWith(".fmp4")).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith("/metadata.json")).length, 2);
  visibility = "private";
  for (const options of [undefined, { method: "HEAD" }, { headers: { Range: "bytes=0-3" } }]) assert.equal((await handle(request(path, options), env, ctx)).status, 404);
  assert.equal(cache.matches.length, 2, "private metadata denies before cache lookup");
  assert.equal(calls.filter(call => call.url.endsWith(".fmp4")).length, 1);
});

test("metadata edits and origin metadata revisions select new media cache entries", async () => {
  const cache = memoryCache();
  const ctx = executionContext();
  let title = "Old title";
  let metadataETag = "one";
  let bytes = "first bytes";
  const { calls, handle } = fixture({ cache, assetHeaders: { "Content-Length": "11" }, assetBody: () => bytes,
    onFetch: call => call.url.endsWith("/metadata.json") ? Response.json({ ...meta, title }, { headers: { ETag: metadataETag } }) : null });
  const path = `${id}/HEVC/init_8.mp4`;
  assert.equal(await (await handle(request(path), env, ctx)).text(), "first bytes");
  await ctx.drain();
  title = "New title";
  bytes = "newer bytes";
  assert.equal(await (await handle(request(path), env, ctx)).text(), "newer bytes");
  await ctx.drain();
  metadataETag = "two";
  bytes = "third bytes";
  assert.equal(await (await handle(request(path), env, ctx)).text(), "third bytes");
  await ctx.drain();
  assert.equal(cache.stored.size, 3);
  assert.equal(calls.filter(call => call.url.endsWith(".mp4")).length, 3);
});

test("internal media cache entries expire within five minutes", async () => {
  let time = 0;
  const cache = memoryCache(() => time);
  const ctx = executionContext();
  const { calls, handle } = fixture({ cache, now: () => time, assetHeaders: { "Content-Length": "11" } });
  const path = `${id}/AV1/chunk_0_1.fmp4`;
  await (await handle(request(path), env, ctx)).text();
  await ctx.drain();
  assert.equal(cache.puts[0].headers.get("Cache-Control"), "public, max-age=300");
  time = 299_999;
  await (await handle(request(path), env, ctx)).text();
  assert.equal(calls.filter(call => call.url.endsWith(".fmp4")).length, 1);
  time = 300_000;
  await (await handle(request(path), env, ctx)).text();
  await ctx.drain();
  assert.equal(calls.filter(call => call.url.endsWith(".fmp4")).length, 2);
});

test("cached full media serves exact Range, suffix Range, HEAD and unsatisfiable Range", async () => {
  const cache = memoryCache();
  const ctx = executionContext();
  const { calls, handle } = fixture({ cache, assetHeaders: { "Content-Length": "11" } });
  const path = `${id}/AV1/chunk_0_1.fmp4`;
  await (await handle(request(path), env, ctx)).text();
  await ctx.drain();
  const partial = await handle(request(path, { headers: { Range: "bytes=1-4" } }), env, ctx);
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("Content-Range"), "bytes 1-4/11");
  assert.equal(partial.headers.get("Content-Length"), "4");
  assert.equal(await partial.text(), "edia");
  const suffix = await handle(request(path, { headers: { Range: "bytes=-5" } }), env, ctx);
  assert.equal(await suffix.text(), "bytes");
  const head = await handle(request(path, { method: "HEAD", headers: { Range: "bytes=1-4" } }), env, ctx);
  assert.equal(head.status, 206);
  assert.equal(head.headers.get("Content-Length"), "4");
  assert.equal(await head.text(), "");
  const invalid = await handle(request(path, { headers: { Range: "bytes=100-" } }), env, ctx);
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("Content-Range"), "bytes */11");
  assert.equal(invalid.headers.get("Content-Length"), "0");
  assert.equal(await invalid.text(), "");
  assert.equal(calls.filter(call => call.url.endsWith(".fmp4")).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith("/metadata.json")).length, 5);
});

test("Range cache misses preserve origin partial streaming and never store partial responses", async () => {
  const cache = memoryCache();
  const ctx = executionContext();
  const { calls, handle } = fixture({ cache, assetStatus: 206, assetHeaders: { "Content-Length": "4", "Content-Range": "bytes 4-7/11" }, assetBody: () => "a by" });
  const response = await handle(request(`${id}/AV1/chunk_0_1.fmp4`, { headers: { Range: "bytes=4-7" } }), env, ctx);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Range"), "bytes 4-7/11");
  assert.equal(await response.text(), "a by");
  await ctx.drain();
  assert.equal(cache.puts.length, 0);
  assert.equal(calls.at(-1).headers.get("Range"), "bytes=4-7");
});

test("only init and chunk media are cached; editable assets and catalogue remain fresh", async () => {
  const cache = memoryCache();
  const ctx = executionContext();
  const { handle } = fixture({ cache, assetHeaders: { "Content-Length": "11" } });
  for (const path of ["index.json", `${id}/metadata.json`, `${id}/thumbnail_share.jpg`, `${id}/AV1/manifest.mpd`, `${id}/AV1/master.m3u8`, `${id}/AV1/media_0.m3u8`]) {
    await (await handle(request(path), env, ctx)).text();
  }
  await ctx.drain();
  assert.equal(cache.puts.length, 0);
  assert.equal(cache.matches.length, 0);
});

test("cache keys isolate origin and media path and cannot be requested directly", async () => {
  const cache = memoryCache();
  const ctx = executionContext();
  const { calls, handle } = fixture({ cache, assetHeaders: { "Content-Length": "11" } });
  const path = `${id}/AV1/init_0.mp4`;
  for (const url of [request(path).url, request(`${id}/HEVC/init_0.mp4`).url, `https://alternate.example${prefix}${path}`]) {
    await (await handle(new Request(url), env, ctx)).text();
  }
  await ctx.drain();
  assert.equal(cache.stored.size, 3);
  assert.ok([...cache.stored.keys()].every(key => /^\?aida-media-revision=[a-f0-9]{64}$/.test(new URL(key).search)));
  assert.equal(calls.filter(call => call.url.endsWith(".mp4")).length, 3);
  const before = calls.length;
  assert.equal((await handle(new Request([...cache.stored.keys()][0]), env, ctx)).status, 404);
  assert.equal(calls.length, before);
});

test("cache skips unknown or excessive lengths, partial objects and absent lifetime context", async () => {
  for (const assetHeaders of [{}, { "Content-Length": "33554433" }, { "Content-Length": "11", "Content-Range": "bytes 0-10/11" }]) {
    const cache = memoryCache();
    const ctx = executionContext();
    const { handle } = fixture({ cache, assetHeaders });
    assert.equal(await (await handle(request(`${id}/AV1/init_0.mp4`), env, ctx)).text(), "media bytes");
    await ctx.drain();
    assert.equal(cache.puts.length, 0);
  }
  const cache = memoryCache();
  const { handle } = fixture({ cache, assetHeaders: { "Content-Length": "11" } });
  assert.equal(await (await handle(request(`${id}/AV1/init_0.mp4`), env)).text(), "media bytes");
  assert.equal(cache.puts.length, 0);
});

test("cache failures fall back to authorized origin playback", async () => {
  for (const cache of [
    { async match() { throw new Error("Cache unavailable"); }, async put() { throw new Error("Cache full"); } },
    { async match() {}, put() { throw new Error("Synchronous cache failure"); } },
  ]) {
    const ctx = executionContext();
    const { handle } = fixture({ cache, assetHeaders: { "Content-Length": "11" } });
    assert.equal(await (await handle(request(`${id}/AV1/init_0.mp4`), env, ctx)).text(), "media bytes");
    await ctx.drain();
  }
});

test("media caching never buffers playback before response headers", async () => {
  const cache = memoryCache();
  const ctx = executionContext();
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const { handle } = fixture({ cache, assetHeaders: { "Content-Length": "4" }, assetBody: () => new ReadableStream({ async start(controller) {
    await ready;
    controller.enqueue(new Uint8Array([120, 0, 255, 8]));
    controller.close();
  } }) });
  const response = await handle(request(`${id}/AV1/init_0.mp4`), env, ctx);
  assert.equal(response.status, 200);
  release();
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([120, 0, 255, 8]));
  await ctx.drain();
  assert.equal(cache.puts.length, 1);
});

test("catalogue preserves real uploader index-only tags, HDR and date after fresh authorization", async () => {
  const index = [{ id, title: "STALE_TITLE", description: "REMOVED_DESCRIPTION", tags: ["120fps", "HDR"], hdr: true, date: "17-10-2026" }];
  const { description, ...metadata } = meta;
  const { handle } = fixture({ index, metadata: { ...metadata, colorTransfer: "smpte2084" } });
  const response = await handle(request("index.json"), env);
  const entries = await response.json();
  assert.equal(entries[0].title, "Current title");
  assert.equal(Object.hasOwn(entries[0], "description"), false);
  assert.deepEqual(entries[0].tags, ["120fps", "HDR"]);
  assert.equal(entries[0].hdr, true);
  assert.equal(entries[0].date, "17-10-2026");
});

test("catalogue metadata fanout is limited to four concurrent requests", async () => {
  let inFlight = 0;
  let maximum = 0;
  const { handle } = fixture({ index: Array.from({ length: 8 }, (_, number) => ({ id: `video-${number}` })), onFetch: async call => {
    if (!call.url.endsWith("/metadata.json")) return;
    maximum = Math.max(maximum, ++inFlight);
    await new Promise(resolve => setTimeout(resolve, 2));
    inFlight--;
  } });
  assert.equal((await handle(request("index.json"), env)).status, 200);
  assert.equal(maximum, 4);
});

test("B2 failures, redirects and hostile download origins fail without leaking details", async () => {
  for (const options of [
    { authThrows: true }, { authStatus: 401 }, { authStatus: 302 },
    { authorization: { downloadUrl: "http://f003.backblazeb2.com", authorizationToken: "SECRET" } },
    { authorization: { downloadUrl: "https://evil.example", authorizationToken: "SECRET" } },
    { authorization: { downloadUrl: "https://f003.backblazeb2.com.evil.example", authorizationToken: "SECRET" } },
    { authorization: { downloadUrl: `${origin}/arbitrary/path`, authorizationToken: "SECRET" } },
    { authorization: { downloadUrl: origin, authorizationToken: "SECRET", allowed: { bucketName: "OtherBucket" } } },
    { authorization: { downloadUrl: origin, authorizationToken: "SECRET", allowed: { capabilities: ["writeFiles"] } } },
    { authorization: { downloadUrl: origin, authorizationToken: "SECRET", allowed: { capabilities: "readFiles" } } },
    { authorization: { downloadUrl: origin, authorizationToken: "SECRET", allowed: ["readFiles"] } },
    { assetStatus: 302 }, { assetStatus: 500 }, { assetHeaders: { "Content-Encoding": "gzip" } },
  ]) {
    const { handle } = fixture(options);
    const response = await handle(request(`${id}/thumbnail_share.jpg`), env);
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "Temporarily unavailable");
  }
});

test("missing secret bindings produce no upstream request", async () => {
  const { calls, handle } = fixture();
  assert.equal((await handle(request(), {})).status, 503);
  assert.equal(calls.length, 0);
});

test("expired B2 token refreshes once, while repeated denial fails closed", async () => {
  let denials = 0;
  const one = fixture({ onFetch: call => call.url.endsWith("/metadata.json") && denials++ === 0 ? new Response("SECRET_B2_ERROR", { status: 401 }) : null });
  assert.equal((await one.handle(request(), env)).status, 200);
  assert.equal(one.calls.filter(call => call.url === authorize).length, 2);
  const repeated = fixture({ onFetch: call => call.url.endsWith("/metadata.json") ? new Response("SECRET_B2_ERROR", { status: 403 }) : null });
  const response = await repeated.handle(request(), env);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "Temporarily unavailable");
  assert.equal(repeated.calls.filter(call => call.url === authorize).length, 2);
});

test("authorization is shared across concurrent requests and isolated after secret rotation", async () => {
  const { calls, handle } = fixture();
  await Promise.all([handle(request(), env), handle(request(), env)]);
  assert.equal(calls.filter(call => call.url === authorize).length, 1);
  await handle(request(), { ...env, B2_SECRET_KEY: "rotated-test-secret" });
  assert.equal(calls.filter(call => call.url === authorize).length, 2);
  assert.equal(calls.findLast(call => call.url === authorize).headers.get("Authorization"), `Basic ${btoa("test-key:rotated-test-secret")}`);
});

test("stalled metadata body is aborted within the authorization timeout", async () => {
  const { handle } = fixture({ timeoutMs: 20, onFetch: call => call.url.endsWith("/metadata.json") ? new Response(new ReadableStream({ start(controller) { call.init.signal.addEventListener("abort", () => controller.error(new Error("stalled")), { once: true }); } })) : null });
  const response = await handle(request(`${id}/AV1/chunk_0_1.fmp4`), env);
  assert.equal(response.status, 503);
});
