import assert from "node:assert/strict";
import test from "node:test";
import { CDN_BASE, fetchCatalog } from "../web/js/catalog.js";

test("catalogue follows pages past forty videos, even an empty filtered page", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    const page = Number(new URL(url).searchParams.get("page") || 0);
    const entries = page === 1 ? [] : Array.from({ length: 40 }, (_, n) => ({
      id: `video-${page * 40 + n}`, title: "Public video", visibility: "public", createdAt: page * 40 + n,
    }));
    return Response.json(entries, { headers: page < 2 ? { Link: `<${CDN_BASE}/index.json?page=${page + 1}>; rel="next"` } : {} });
  });
  const entries = await fetchCatalog({ local: false });
  assert.equal(entries.length, 80);
  assert.equal(entries[0].id, "video-119");
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.options.cache === "no-store"));
});

test("duplicates during a catalogue update use current data and remain unique", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => String(url).includes("page=1")
    ? Response.json([{ id: "same", title: "Updated", visibility: "public" }, { id: "private", visibility: "private" }])
    : Response.json([{ id: "same", title: "Older", visibility: "public" }], { headers: { Link: `<${CDN_BASE}/index.json?page=1>; rel="next"` } }));
  assert.deepEqual((await fetchCatalog({ local: false })).map(video => video.title), ["Updated"]);
});

test("foreign, credentialed, looping and malformed next links are never fetched", async (t) => {
  for (const next of [
    "https://evil.example/index.json?page=1", `${CDN_BASE}/other.json?page=1`,
    "https://name:secret@cdn.keppy.dev/file/ProjectAida/index.json?page=1",
    `${CDN_BASE}/index.json?page=0`, `${CDN_BASE}/index.json?page=2`,
    `${CDN_BASE}/index.json?page=1&fileId=private`, `${CDN_BASE}/index.json?page=1&page=1`,
    `${CDN_BASE}/index.json?page=1#fragment`, `${CDN_BASE}/index.json?page=01`,
  ]) {
    let calls = 0;
    const mock = t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return Response.json([], { headers: { Link: `<${next}>; rel="next"` } });
    });
    await assert.rejects(fetchCatalog({ local: false }), /Invalid catalogue pagination/);
    assert.equal(calls, 1);
    mock.mock.restore();
  }
});

test("local and pre-pagination catalogues retain the existing array format", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json([{ id: "public", visibility: "public" }, { id: "private", visibility: "private" }]));
  assert.deepEqual((await fetchCatalog({ local: true })).map(video => video.id), ["public"]);
});

test("local previews read shared aliases without resaving each video", async t => {
  t.mock.method(globalThis, "fetch", async url => String(url).endsWith("tags.json")
    ? Response.json({ version: 1, tags: [{ id: "game", name: "Current game name", aliases: ["Old game", "CG"] }], redirects: {} })
    : Response.json([{ id: "clip", tags: ["Old game"], tagIds: ["game"], visibility: "public" }]));
  const [video] = await fetchCatalog({ local: true });
  assert.deepEqual(video.tags, ["Current game name"]);
  assert.deepEqual(video.tagDefinitions[0].aliases, ["Old game", "CG"]);
});

test("older local previews allow an absent registry but report failed reads", async t => {
  const catalog = [{ id: "clip", tags: ["Legacy game"], visibility: "public" }];
  let status = 404;
  t.mock.method(globalThis, "fetch", async url => String(url).endsWith("tags.json") ? new Response("", { status }) : Response.json(catalog));
  assert.deepEqual(await fetchCatalog({ local: true }), catalog);
  status = 503;
  await assert.rejects(fetchCatalog({ local: true }), /Local tag list/);
});
