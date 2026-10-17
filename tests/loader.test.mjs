import assert from "node:assert/strict";
import test from "node:test";
import { loadMetadata, VideoLoadError } from "../web/js/loader.js";

test("metadata edits and privacy changes are fetched again rather than reused from browser cache", async (t) => {
  let visibility = "public";
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ title: "Current title", visibility, codecs: ["AV1"] }));
  });
  assert.equal((await loadMetadata("https://cdn.example.test/video")).title, "Current title");
  visibility = "private";
  await assert.rejects(loadMetadata("https://cdn.example.test/video"), (error) =>
    error instanceof VideoLoadError && error.kind === "private");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.cache, "no-store");
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test("local private previews retain their existing opt-in access", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    title: "Local draft", visibility: "private", codecs: ["AV1", "HEVC"],
  })));
  const metadata = await loadMetadata("./local/draft", { allowPrivate: true });
  assert.equal(metadata.title, "Local draft");
});
