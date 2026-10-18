import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createAdminHandler } from "../edge/admin-worker.mjs";
import { makeFrameFixture } from "./support/admin-preview.mjs";

const require = createRequire(import.meta.url);
const modules = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || `${modules}/playwright`);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = resolve(process.env.AIDA_REVIEW_DIR || "logs", `admin-security-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;

// The canonical published file and its SHA-256 were checked against jsDelivr's
// https://data.jsdelivr.com/v1/package/npm/shaka-player@5.0.7/flat on 2026-10-18.
// The generated .min.js alias explicitly warns against SRI; use the package file.
const vendorURL = "https://cdn.jsdelivr.net/npm/shaka-player@5.0.7/dist/shaka-player.compiled.js";
const vendor = process.env.AIDA_SHAKA_SCRIPT
  ? await readFile(process.env.AIDA_SHAKA_SCRIPT)
  : Buffer.from(await (await fetch(vendorURL)).arrayBuffer());
assert.equal(createHash("sha256").update(vendor).digest("base64"), "xP62sgnCqCmtkA+WAm7G7/erzvZEyiA459DqHRKzJZY=");
assert.equal(createHash("sha384").update(vendor).digest("base64"), "QmUMkgEfxfKsqPJEzI+KDHoe3v4Ci8Xql0RFiGN093TYQZUBJLXARMl8fVNhubqw");

const freshRecord = (visibility = "private", review = false) => ({
  id: "security120", title: "Synthetic 120 fps security preview", description: "Synthetic editor metadata.", tags: ["120 fps"],
  frameRate: 120, visibility, visibility_review_required: review, revision: "security-r1", pending: false, has_remote: true,
  can_preview: true, preview_url: "/edit/preview/watch.html?v=security120&local=1", thumbnail_url: "",
  metadata: { id: "security120", title: "Synthetic 120 fps security preview", frameRate: 120, visibility: "private", codecs: [] },
});
const state = { record: freshRecord(), requests: [] };
const handler = createAdminHandler({ authorize: async () => ({ kind: "owner", sub: "synthetic-owner" }) });
const env = { LIBRARY: { idFromName: () => "fixture", get: () => ({ async fetch(request) {
  const url = new URL(request.url);
  if (request.method === "POST") {
    const body = await request.json();
    state.requests.push(body);
    assert.ok(["private", "unlisted", "public"].includes(body.visibility));
    state.record = { ...state.record, ...body, visibility_review_required: false, revision: "security-r2", pending: !body.publish };
  }
  return Response.json(url.pathname === "/edit/api/videos" ? [state.record] : state.record);
} }) } };
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const response = await handler(new Request(`http://127.0.0.1:${server.address().port}${incoming.url}`, {
      method: incoming.method, headers: incoming.headers,
      ...(chunks.length ? { body: Buffer.concat(chunks), duplex: "half" } : {}),
    }), env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { outgoing.writeHead(500); outgoing.end(error.message); }
});
await new Promise(ready => server.listen(0, "127.0.0.1", ready));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const results = { fixture: "Actual authenticated asset handler, real pinned Shaka bytes, synthetic owner/API and distinct 120 fps VP8 frames. No live credentials or writes.", profiles: [] };
let frameClip;

async function makeContext(profile, tampered = false) {
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.touch, hasTouch: profile.touch });
  await context.addInitScript(() => {
    window.securityViolations = [];
    document.addEventListener("securitypolicyviolation", event => securityViolations.push({ directive: event.effectiveDirective, uri: event.blockedURI }));
  });
  await context.route("**/*", route => {
    const url = route.request().url();
    if (url === vendorURL) return route.fulfill({ status: 200, headers: { "Content-Type": "text/javascript", "Access-Control-Allow-Origin": "*" }, body: tampered ? Buffer.concat([vendor, Buffer.from("\nwindow.tamperedDependencyExecuted = true;\n")]) : vendor });
    if (new URL(url).origin === origin || url.startsWith("blob:")) return route.continue();
    return route.abort();
  });
  return context;
}

async function waitEditor(page) {
  await page.goto(`${origin}/edit?v=security120`);
  await page.waitForFunction(() => !document.querySelector("#video-editor").classList.contains("hidden"));
  await page.locator("#editor-player").contentFrame().locator("#watch-status.is-error").waitFor();
}

try {
  const tamperedContext = await makeContext({ viewport: { width: 1440, height: 900 }, touch: false }, true);
  const tamperedPage = await tamperedContext.newPage();
  const blocked = [];
  tamperedPage.on("console", message => { if (/integrity|digest/i.test(message.text())) blocked.push(message.text()); });
  await tamperedPage.goto(`${origin}/edit/preview/watch.html?v=security120&embed=1&local=1`);
  await tamperedPage.locator("#watch-status.is-error").waitFor();
  assert.equal(await tamperedPage.evaluate(() => typeof window.shaka), "undefined");
  assert.equal(await tamperedPage.evaluate(() => window.tamperedDependencyExecuted), undefined);
  assert.ok(blocked.some(message => /integrity|digest/i.test(message)), "Browser must report its SRI rejection of altered vendor bytes");
  await tamperedContext.close();
  results.tamperedDependencyBlocked = true;

  for (const profile of [{ name: "desktop", viewport: { width: 1440, height: 900 }, touch: false }, { name: "phone", viewport: { width: 390, height: 844 }, touch: true }]) {
    const context = await makeContext(profile);
    const page = await context.newPage();
    state.record = freshRecord("unknown", true);
    state.requests.length = 0;
    await waitEditor(page);
    const preview = page.locator("#editor-player").contentFrame();
    assert.equal(await preview.locator("html").evaluate(() => window.shaka.Player.version), "v5.0.7");
    assert.deepEqual(await page.evaluate(() => securityViolations), []);
    assert.deepEqual(await preview.locator("html").evaluate(() => securityViolations), []);
    const bounds = await preview.locator("html").evaluate(() => {
      const frame = document.querySelector("#watch-stage").getBoundingClientRect();
      return { width: frame.width, height: frame.height, viewportWidth: innerWidth, viewportHeight: innerHeight, header: getComputedStyle(document.querySelector(".site-header")).display, projection: Boolean(document.querySelector("#aida-studio-preview-style")) };
    });
    assert.equal(bounds.header, "none"); assert.equal(bounds.projection, true);
    assert.equal(bounds.width, bounds.viewportWidth); assert.equal(bounds.height, bounds.viewportHeight);
    assert.equal(await page.locator('input[name="edit-visibility"]:checked').count(), 0);
    assert.match(await page.locator("#editor-card-visibility").textContent(), /^Visibility needs review · 120 fps$/);
    assert.match(await page.locator(".video-row-meta").textContent(), /^Visibility needs review/);
    assert.equal(await page.locator("#editor-save-state").textContent(), "Visibility needs review");
    assert.equal(await page.locator("#editor-publish").isDisabled(), true);
    assert.equal(await page.locator("#editor-live-link").isVisible(), false);
    await page.locator("#edit-title").fill("Title edit without a visibility decision");
    await page.locator("#editor-form").evaluate(form => form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })));
    await page.locator("#editor-publish").evaluate(button => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(state.requests.length, 0, "A forced submit/click cannot publish or save an inferred visibility");
    assert.match(await page.locator("#editor-save-state").textContent(), /Visibility needs review/);
    await page.screenshot({ path: resolve(artifacts, `${profile.name}-visibility-review.png`), fullPage: true });
    await page.locator('input[name="edit-visibility"][value="private"]').check();
    assert.equal(await page.locator("#editor-publish").isEnabled(), true);
    await page.locator("#editor-publish").click();
    await page.waitForFunction(() => document.querySelector("#editor-save-state").textContent.includes("Saved to website"));
    assert.equal(state.requests.length, 1); assert.equal(state.requests[0].visibility, "private"); assert.equal(state.requests[0].publish, true);

    // Defensive UI handling covers missing/invalid raw values and a flagged legacy draft.
    for (const [visibility, review] of [[undefined, false], ["__proto__", false], ["public", true]]) {
      state.record = freshRecord(visibility, review);
      if (visibility === undefined) delete state.record.visibility;
      await waitEditor(page);
      assert.equal(await page.locator('input[name="edit-visibility"]:checked').count(), 0);
      assert.match(await page.locator("#editor-card-visibility").textContent(), /^Visibility needs review/);
      assert.equal(await page.locator("#editor-publish").isDisabled(), true);
    }
    for (const visibility of ["private", "unlisted", "public"]) {
      state.record = freshRecord(visibility);
      await waitEditor(page);
      assert.equal(await page.locator('input[name="edit-visibility"]:checked').inputValue(), visibility);
      assert.equal(await page.locator("#editor-publish").isEnabled(), true);
    }

    // Exercise the media-src blob permission with distinct real 120 fps frames.
    if (!frameClip) {
      const encoder = await context.newPage();
      frameClip = await makeFrameFixture(encoder, origin);
      await writeFile(resolve(artifacts, "synthetic-120fps.webm"), frameClip, { flag: "wx" });
      await encoder.close();
    }
    await preview.locator("html").evaluate(async (_, bytes) => {
      const video = document.createElement("video");
      video.muted = true; video.playsInline = true; video.hidden = true;
      document.body.appendChild(video);
      video.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "video/webm" }));
      try { await video.play(); }
      catch (error) { throw new Error(`${error.message}; media=${video.error?.code}:${video.error?.message}; bytes=${bytes.length}; csp=${JSON.stringify(securityViolations)}`); }
      await new Promise(resolveFrame => video.requestVideoFrameCallback(resolveFrame));
      video.pause();
      URL.revokeObjectURL(video.src); video.remove();
    }, [...frameClip]);
    assert.deepEqual(await preview.locator("html").evaluate(() => securityViolations), []);

    // The actual response policy rejects inline scripts, other CDN scripts and external fetches.
    const denied = await page.evaluate(async () => {
      const inline = document.createElement("script"); inline.textContent = "window.inlineSecurityProbe = true"; document.head.appendChild(inline);
      const external = document.createElement("script"); external.src = "https://cdn.jsdelivr.net/npm/other-library/index.js";
      const scriptBlocked = new Promise(resolveBlocked => { external.onload = () => resolveBlocked(false); external.onerror = () => resolveBlocked(true); });
      document.head.appendChild(external);
      const connectBlocked = await fetch("https://cdn.jsdelivr.net/security-probe").then(() => false, () => true);
      const sameOrigin = await fetch("/edit/api/session").then(response => response.ok);
      await new Promise(resolveTurn => setTimeout(resolveTurn, 0));
      return { inlineRan: Boolean(window.inlineSecurityProbe), scriptBlocked: await scriptBlocked, connectBlocked, sameOrigin, violations: securityViolations };
    });
    assert.equal(denied.inlineRan, false); assert.equal(denied.scriptBlocked, true); assert.equal(denied.connectBlocked, true); assert.equal(denied.sameOrigin, true);
    assert.ok(denied.violations.some(value => value.directive === "connect-src"));
    assert.ok(denied.violations.some(value => value.directive === "script-src-elem" && value.uri === "inline"));
    assert.ok(denied.violations.some(value => value.directive === "script-src-elem" && value.uri.startsWith("https://cdn.jsdelivr.net/")));
    results.profiles.push({ name: profile.name, matchingDependencyLoaded: true, privatePreviewLayoutAndAssets: true, distinct120fpsBlobDecoded: true, visibilityRequiresChoice: true, explicitVisibilityPreserved: true, restrictiveCspEnforced: true });
    await context.close();
    console.log(`PASS ${profile.name}`);
  }
} finally {
  await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2), { flag: "wx" });
  await browser.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}
console.log(`Security browser artifacts: ${artifacts}`);
