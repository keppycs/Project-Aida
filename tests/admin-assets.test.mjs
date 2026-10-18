import assert from "node:assert/strict";
import { test } from "node:test";
import assets from "../edge/generated/admin-assets.mjs";
import { serveAdminAsset } from "../edge/admin-assets.mjs";

const request = (path, method = "GET") => new Request(`https://keppy.dev${path}`, { method });

test("owner bundle contains application code only, with no local files or alternative entry points", async () => {
  assert.ok(Object.keys(assets).length > 20);
  for (const path of Object.keys(assets)) {
    assert.ok(path === "/edit" || path === "/edit/" || /^\/edit\/(?:assets|preview)\//.test(path), path);
    assert.doesNotMatch(path, /(?:^|\/)(?:local|\.env|node_modules|logs|\.git)(?:\/|$)|metadata\.json|index\.json/);
  }
  for (const path of ["/", "/edit/.env", "/edit/preview/local/example/metadata.json", "/edit/preview/../.env", "/edit/assets/../../.env", "/edit/preview/js/missing.js", "/edit/preview/local/index.json"]) {
    assert.equal(await serveAdminAsset(request(path)), null, path);
  }
  const page = await serveAdminAsset(request("/edit?v=example120"));
  assert.equal(page.headers.get("Cache-Control"), "private, no-store");
  const html = await page.text();
  assert.match(html, /aida-editor-mode[^>]+live/);
  assert.match(html, /\/edit\/assets\/editor\.js/);
  assert.doesNotMatch(html, /id="(?:upload-form|b2-key-id|b2-app-key)"/);
  const head = await serveAdminAsset(request("/edit/assets/editor.js", "HEAD"));
  assert.equal(await head.text(), "");
  assert.equal(await serveAdminAsset(request("/edit", "POST")), null);
});

test("only embedded owner previews receive the player-only projection before first paint", async () => {
  const standalone = await (await serveAdminAsset(request("/edit/preview/watch.html?v=example120&local=1"))).text();
  const embedded = await (await serveAdminAsset(request("/edit/preview/watch.html?v=example120&local=1&embed=1"))).text();
  assert.doesNotMatch(standalone, /aida-studio-preview-style/);
  assert.match(embedded, /aida-studio-preview-style/);
  assert.ok(embedded.indexOf("aida-studio-preview-style") < embedded.indexOf("</head>"));
  const environment = await (await serveAdminAsset(request("/edit/preview/js/site-env.js"))).text();
  assert.match(environment, /window\.shouldUseLocalCmaf = \(\) => true/);
  assert.equal(assets["/edit/assets/editor.js"].binary, false);
});
