import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { FIRST_VIDEO, SECOND_VIDEO, STUDIO_TOKEN, makeFrameFixture, startAdminPreview } from "./support/admin-preview.mjs";

const require = createRequire(import.meta.url);
const modules = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || `${modules}/playwright`);
const sharp = require(`${modules}/sharp`);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = resolve(process.env.AIDA_REVIEW_DIR || "logs", `admin-live-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const selected = process.argv.find(argument => argument.startsWith("--profile="))?.split("=")[1];
const profiles = [
  { name: "classic-desktop", mode: "classic", width: 1440, height: 900 },
  { name: "phone360", mode: "overlay", width: 360, height: 800, touch: true },
  { name: "landscape844", mode: "overlay", width: 844, height: 390, touch: true }
].filter(profile => !selected || selected.split(",").includes(profile.name));
assert.ok(profiles.length, "Select an existing live-editor profile.");
const results = { fixture: "Protected-route mock, synthetic metadata and real 120fps VP8 frames. No Access, B2, credentials or live writes.", profiles: [] };
let frameClip;
const painted = page => page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
const waitText = (page, selector, text) => page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });

async function startLivePreview() {
  const base = await startAdminPreview();
  const state = { requests: [], auth: "valid", invalidPreview: false, failNextMutation: false, journal: new Map(), thumbnails: new Map() };
  const send = (response, code, value, type = "application/json") => {
    response.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    response.end(type === "application/json" ? JSON.stringify(value) : value);
  };
  const rewrite = value => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    if (result.preview_url) result.preview_url = result.preview_url.replace("/preview/", "/edit/preview/");
    if (result.thumbnail_url) result.thumbnail_url = result.thumbnail_url.replace("/api/video-media/", "/edit/preview/local/");
    return result;
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      let body;
      if (request.method === "POST") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString());
      }
      state.requests.push({ method: request.method, path: url.pathname, search: url.search, headers: { editor: request.headers["x-aida-editor"], session: request.headers["x-aida-session"] }, body });
      if (url.pathname.startsWith("/edit/api/")) {
        if (state.auth === "redirect") { response.writeHead(302, { location: "/__fixture/login" }); return response.end(); }
        if (state.auth === "html") return send(response, 200, "<!doctype html><title>Fixture sign-in</title>", "text/html");
        if (state.auth !== "valid") return send(response, Number(state.auth), { detail: "Fixture sign-in expired." });
        if (url.pathname === "/edit/api/session") return send(response, 200, { authenticated: true, email: "owner@example.invalid" });
        if (request.method === "POST") {
          if (request.headers["x-aida-editor"] !== "1" || request.headers["x-aida-session"]) return send(response, 403, { detail: "Wrong live-editor header." });
          assert.match(body.operation_id, /^[0-9a-f-]{36}$/i);
          const completed = state.journal.get(body.operation_id);
          if (completed) {
            assert.equal(JSON.stringify(body), completed.body, "Journal retries must retain the submitted revision and payload");
            return send(response, 200, completed.result);
          }
          if (state.failNextMutation) { state.failNextMutation = false; return send(response, 503, { detail: "Synthetic save failed. Try again." }); }
        }
        const forwarded = await fetch(`${base.origin}${url.pathname.replace("/edit/api/", "/api/")}${url.search}`, {
          method: request.method, headers: { "Content-Type": "application/json", "X-Aida-Session": STUDIO_TOKEN }, ...(body ? { body: JSON.stringify(body) } : {})
        });
        const result = rewrite(await forwarded.json());
        if (forwarded.ok && url.pathname.endsWith("/thumbnail") && body?.variants) {
          const id = url.pathname.split("/")[4];
          for (const [name, image] of Object.entries(body.variants)) state.thumbnails.set(`${id}/${name}`, image);
        }
        if (request.method === "POST" && state.failAfterCommit) {
          state.failAfterCommit = false;
          state.journal.set(body.operation_id, { body: JSON.stringify(body), result });
          return send(response, 503, { detail: "Synthetic save failed. Try again.", current: result, operation_id: body.operation_id });
        }
        return send(response, forwarded.status, result);
      }
      if (url.pathname === "/edit" || url.pathname.startsWith("/edit/assets/")) {
        const names = { "/edit": "live.html", "/edit/assets/admin.css": "admin.css", "/edit/assets/editor.js": "editor.js" };
        const name = names[url.pathname];
        if (!name) return send(response, 404, {});
        return send(response, 200, await readFile(resolve("admin", name)), name.endsWith("html") ? "text/html" : name.endsWith("css") ? "text/css" : "text/javascript");
      }
      if (url.pathname === "/edit/preview/watch.html" && state.invalidPreview) return send(response, 200, "<!doctype html><title>Fixture sign-in</title><p>Sign in</p>", "text/html");
      if (url.pathname.startsWith("/edit/preview/local/")) {
        const image = state.thumbnails.get(url.pathname.slice("/edit/preview/local/".length));
        if (image) return send(response, 200, Buffer.from(image.data, "base64"), image.type);
      }
      const path = url.pathname.startsWith("/edit/preview/local/") ? url.pathname.replace("/edit/preview/local/", "/api/video-media/") : url.pathname.replace("/edit/preview/", "/preview/");
      const forwarded = await fetch(`${base.origin}${path}${url.search}`, { headers: request.headers.range ? { Range: request.headers.range } : {} });
      const headers = { "content-type": forwarded.headers.get("content-type") || "application/octet-stream", "cache-control": "no-store" };
      for (const name of ["content-range", "accept-ranges"]) if (forwarded.headers.get(name)) headers[name] = forwarded.headers.get(name);
      response.writeHead(forwarded.status, headers);
      response.end(Buffer.from(await forwarded.arrayBuffer()));
    } catch (error) { send(response, 500, { detail: error.message }); }
  });
  await new Promise((ready, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ready); });
  return { ...base, state, base, origin: `http://127.0.0.1:${server.address().port}`, close: async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); await base.close(); } };
}

async function presentation(page, label) {
  const failures = await page.evaluate(() => {
    const failures = [];
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) failures.push("horizontal overflow");
    if (document.documentElement.clientWidth !== innerWidth) failures.push("page scrollbar gutter");
    for (const element of document.querySelectorAll("*")) {
      if (!element.getClientRects().length) continue;
      const style = getComputedStyle(element);
      if (style.webkitTapHighlightColor !== "rgba(0, 0, 0, 0)") failures.push(`tap highlight ${element.id || element.tagName}`);
      if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth)) failures.push(`outline ${element.id || element.tagName}`);
      if (element.matches('button,a[href],input:not([type="radio"]):not([type="file"]),textarea,.file-button,.visibility-options span')) {
        const rect = element.getBoundingClientRect();
        if (rect.width < 43.5 || rect.height < 43.5) failures.push(`small target ${element.id || element.tagName} ${rect.width}x${rect.height}`);
      }
      if (element.matches(".video-row")) {
        const row = element.getBoundingClientRect(), copy = element.querySelector(".video-row-copy").getBoundingClientRect();
        if (copy.top < row.top || copy.bottom > row.bottom) failures.push(`overlapping row copy ${element.dataset.id}`);
      }
    }
    return failures;
  });
  assert.deepEqual(failures, [], label);
}

async function readyPreview(page, fixture, id = FIRST_VIDEO) {
  const expected = new URL(fixture.base.view(id).preview_url.replace("/preview/", "/edit/preview/"), fixture.origin);
  expected.searchParams.set("studio_revision", fixture.base.view(id).revision);
  assert.equal(await page.locator("#editor-preview-link").getAttribute("href"), expected.href);
  expected.searchParams.set("embed", "1");
  assert.equal(await page.locator("#editor-player").getAttribute("src"), expected.href);
  await page.waitForFunction(href => {
    const iframe = document.querySelector("#editor-player");
    return iframe.contentWindow?.location.href === href && iframe.contentDocument?.querySelector("#video")?.readyState >= 2;
  }, expected.href);
  assert.equal(await page.frameLocator("#editor-player").locator(".watch-info").isVisible(), false);
}

async function variants(payload, expectedWidth, expectedHeight) {
  assert.equal(payload.publish, false);
  assert.equal(payload.image_base64, undefined, "Live mutations carry actual encoded variants only");
  const names = ["thumbnail_sdr.webp", "thumbnail_sdr_720p.webp", "thumbnail_share.jpg"];
  assert.deepEqual(Object.keys(payload.variants).sort(), [...names].sort());
  const dimensions = [];
  for (const name of names) {
    const image = payload.variants[name], bytes = Buffer.from(image.data, "base64");
    const metadata = await sharp(bytes).metadata();
    const full = name === "thumbnail_sdr.webp", type = name.endsWith("jpg") ? "jpeg" : "webp";
    assert.equal(metadata.format, type, `${name}: real encoded format`);
    assert.equal(image.type, `image/${type}`);
    assert.ok(bytes.length <= 1900000);
    assert.ok(metadata.width <= (full ? 3840 : 1280) && metadata.height <= (full ? 2160 : 720));
    assert.ok(metadata.width <= expectedWidth && metadata.height <= expectedHeight, "No thumbnail upscaling");
    assert.ok(Math.abs(metadata.width / metadata.height - expectedWidth / expectedHeight) < .005, "Keep source aspect ratio");
    dimensions.push({ name, format: metadata.format, width: metadata.width, height: metadata.height, bytes: bytes.length });
  }
  return dimensions;
}

async function runWorkflow(page, fixture, profile) {
  const posts = () => fixture.state.requests.filter(item => item.method === "POST");
  await page.goto(`${fixture.origin}/edit?v=${FIRST_VIDEO}&keep=one%20two#studio`);
  await page.locator("#video-editor").waitFor({ state: "visible" });
  await readyPreview(page, fixture);
  assert.equal(new URL(page.url()).searchParams.get("v"), FIRST_VIDEO);
  assert.equal(new URL(page.url()).searchParams.get("keep"), "one two");
  assert.equal(new URL(page.url()).hash, "#studio");
  for (const selector of ["#library-new", "#panel-encode", "#panel-maint", "#panel-creds", "#source-path"]) assert.equal(await page.locator(selector).count(), 0, `${selector} stays local`);
  assert.equal(await page.locator("#editor-save").textContent(), "Save draft");
  assert.equal(await page.locator("#editor-publish").textContent(), "Save to website");
  await page.locator("#edit-title").fill("Owner draft title");
  await page.locator("#edit-description").fill("A saved draft.\nSecond line.");
  await page.locator('#selected-tags button[aria-label="Remove motion tag"]').click();
  await page.locator("#tag-search").fill("owner");
  await page.locator('#tag-suggestions button[data-tag-id="owner"]').click();
  await page.locator('input[name="edit-visibility"][value="private"]').check();
  await page.locator("#editor-save").click();
  await waitText(page, "#editor-save-state", "Draft saved");
  let mutation = posts().at(-1);
  assert.deepEqual({ title: mutation.body.title, description: mutation.body.description, tags: mutation.body.tags, visibility: mutation.body.visibility, publish: mutation.body.publish }, { title: "Owner draft title", description: "A saved draft.\nSecond line.", tags: ["120 fps", "owner"], visibility: "private", publish: false });
  assert.equal(mutation.headers.editor, "1");
  assert.equal(mutation.headers.session, undefined);
  await readyPreview(page, fixture);
  assert.equal(await page.locator("#editor-live-link").isVisible(), false, "Private draft keeps preview protected");
  await page.locator("#editor-publish").click();
  await waitText(page, "#editor-save-state", "website updated");
  assert.equal(posts().at(-1).body.publish, true);

  // A failed action can be retried with the exact same journal identifier.
  await page.locator("#edit-title").fill("Retry this draft");
  fixture.state.failAfterCommit = true;
  await page.locator("#editor-save").click();
  await waitText(page, "#editor-save-state", "Synthetic save failed");
  const failed = posts().at(-1).body;
  await page.locator("#editor-save").click();
  await waitText(page, "#editor-save-state", "Draft saved");
  assert.deepEqual(posts().at(-1).body, failed, "Identical failed action keeps operation_id and body");

  const image = await sharp({ create: { width: 4096, height: 2304, channels: 3, background: "#a84a3e" } }).png().toBuffer();
  await page.locator("#edit-thumbnail-file").setInputFiles({ name: "synthetic-image.png", mimeType: "image/png", buffer: image });
  await waitText(page, "#thumbnail-status", "Thumbnail saved in your draft");
  const imageVariants = await variants(posts().at(-1).body, 4096, 2304);
  assert.deepEqual(imageVariants.map(item => [item.width, item.height]), [[3840, 2160], [1280, 720], [1280, 720]]);

  await readyPreview(page, fixture);
  await page.locator("#thumbnail-frame-toggle").click();
  await page.locator("#edit-frame-apply").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector("#edit-frame-apply").disabled);
  await page.locator("#edit-frame-number").fill("61");
  await page.locator("#edit-frame-number").press("Tab");
  await page.waitForFunction(() => document.querySelector("#edit-frame-canvas").dataset.frameExact === "true" && Math.abs(Number(document.querySelector("#edit-frame-canvas").dataset.frameTime) - .5) < .0001 && !document.querySelector("#edit-frame-apply").disabled);
  const thumbnailResponse = page.waitForResponse(response => response.url().endsWith(`/edit/api/videos/${FIRST_VIDEO}/thumbnail`) && response.request().method() === "POST");
  await page.locator("#edit-frame-apply").click();
  await thumbnailResponse;
  await waitText(page, "#thumbnail-status", "Thumbnail saved in your draft");
  const framePayload = posts().at(-1).body;
  const frameVariants = await variants(framePayload, 160, 90);
  const { data, info } = await sharp(Buffer.from(framePayload.variants["thumbnail_sdr.webp"].data, "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let marker = 0;
  for (let bit = 0; bit < 8; ++bit) if (data[(82 * info.width + 14 + bit * 18) * info.channels] > 127) marker |= 1 << bit;
  assert.equal(marker, 60, "Encoded live WebP must contain the selected decoded120fps frame");
  await readyPreview(page, fixture);
  await page.waitForFunction(() => document.querySelector("#editor-thumb-preview").naturalWidth === 160);
  await page.locator("#thumbnail-frame-toggle").click();
  await page.waitForFunction(() => !document.querySelector("#edit-frame-apply").disabled);
  await page.locator("#edit-frame-number").fill("61");
  await page.locator("#edit-frame-number").press("Tab");
  await page.waitForFunction(() => document.querySelector("#edit-frame-canvas").dataset.frameTime === "0.5" && !document.querySelector("#edit-frame-apply").disabled);
  await page.screenshot({ path: resolve(artifacts, `${profile.name}-owner-editor.png`), fullPage: true });
  await page.locator("#edit-frame-close").click();

  const authStates = [];
  for (const mode of ["401", "403", "html", "redirect"]) {
    const title = `Keep my draft after ${mode}`;
    await page.locator("#edit-title").fill(title);
    fixture.state.auth = mode;
    await page.locator("#editor-save").click();
    await page.locator("#auth-notice").waitFor({ state: "visible" });
    assert.equal(await page.locator("#edit-title").inputValue(), title);
    assert.equal(await page.locator("#auth-sign-in").getAttribute("target"), "_blank");
    assert.equal(await page.locator("#auth-sign-in").getAttribute("href"), `${fixture.origin}/edit?v=${FIRST_VIDEO}`);
    const count = posts().length;
    const preview = await page.locator("#editor-player").evaluate(frame => { frame.contentWindow.__liveDraftSentinel = "working"; return frame.src; });
    await presentation(page, `${profile.name} expired ${mode}`);
    if (mode === "403") {
      await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      await painted(page);
      await presentation(page, `${profile.name} expired enlarged`);
      const banner = await page.locator(".auth-notice-content").evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { width: element.clientWidth, content: element.scrollWidth, top: rect.top, bottom: rect.bottom, viewport: innerHeight };
      });
      assert.ok(banner.content <= banner.width + 1, `Auth banner must wrap at enlarged text: ${JSON.stringify(banner)}`);
      assert.ok(banner.top >= 0 && banner.bottom <= banner.viewport, "Sign-in recovery stays inside the viewport");
      await page.screenshot({ path: resolve(artifacts, `${profile.name}-expired-enlarged.png`), fullPage: true });
      await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
      await painted(page);
    }
    fixture.state.auth = "valid";
    await page.locator("#auth-retry").click();
    await page.locator("#auth-notice").waitFor({ state: "hidden" });
    await waitText(page, "#editor-save-state", "Signed in");
    assert.equal(posts().length, count, "Auth recovery must not replay mutations");
    assert.equal(await page.locator("#edit-title").inputValue(), title);
    assert.equal(await page.locator("#editor-player").getAttribute("src"), preview);
    assert.equal(await page.locator("#editor-player").evaluate(frame => frame.contentWindow.__liveDraftSentinel), "working", "Working preview stays mounted after sign-in");
    authStates.push(mode);
  }

  // If Access redirected the iframe, session recovery reloads only that GET.
  const draft = await page.locator("#edit-title").inputValue(), count = posts().length;
  fixture.state.auth = "403";
  fixture.state.invalidPreview = true;
  await page.locator("#editor-player").evaluate(frame => { frame.src = frame.src; });
  await page.locator("#auth-notice").waitFor({ state: "visible" });
  fixture.state.auth = "valid";
  fixture.state.invalidPreview = false;
  await page.locator("#auth-retry").click();
  await page.locator("#auth-notice").waitFor({ state: "hidden" });
  await readyPreview(page, fixture);
  assert.equal(await page.locator("#edit-title").inputValue(), draft);
  assert.equal(posts().length, count);
  await page.locator(`.video-row[data-id="${SECOND_VIDEO}"]`).click();
  await page.locator("#draft-prompt").waitFor({ state: "visible" });
  await page.locator("#draft-keep").click();
  assert.equal(new URL(page.url()).searchParams.get("v"), FIRST_VIDEO, "Declined navigation preserves canonical URL");
  await page.locator(`.video-row[data-id="${SECOND_VIDEO}"]`).click();
  await page.locator("#draft-discard").click();
  await page.waitForURL(url => url.searchParams.get("v") === SECOND_VIDEO);
  assert.equal(new URL(page.url()).searchParams.get("video"), null);
  assert.equal(new URL(page.url()).pathname, "/edit");
  return { imageVariants, frameVariants, frameMarker: marker, authStates, mutations: posts().length };
}

async function scrollingAndFocus(page, profile) {
  await presentation(page, `${profile.name} normal`);
  await page.locator("#edit-title").scrollIntoViewIfNeeded();
  await page.keyboard.press("Tab");
  await page.locator("#edit-title").focus();
  await page.waitForTimeout(180);
  const focus = await page.locator("#edit-title").evaluate(element => { const style = getComputedStyle(element); return { visible: element.matches(":focus-visible"), fill: style.backgroundColor, outline: style.outlineStyle, shadow: style.boxShadow }; });
  assert.equal(focus.visible, true);
  assert.equal(focus.outline, "none");
  assert.equal(focus.shadow, "none");
  assert.equal(focus.fill, "rgb(65, 69, 38)");
  await page.evaluate(() => scrollTo(0, 0));
  await page.mouse.move(profile.width / 2, Math.min(200, profile.height / 2));
  await page.mouse.wheel(0, 350);
  await page.waitForFunction(() => scrollY > 100);
  const thumb = page.locator(".page-scroll-thumb");
  await thumb.waitFor({ state: "visible" });
  const before = await page.evaluate(() => scrollY), rect = await thumb.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2 + 40, { steps: 4 });
  await page.mouse.up();
  assert.ok(await page.evaluate(() => scrollY) > before, "Overlay thumb drives native document scroll");
  if (profile.touch) {
    await page.evaluate(() => scrollTo(0, 100));
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: profile.width - 24, y: profile.height - 70 }] });
    for (let step = 1; step <= 6; ++step) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: profile.width - 24, y: profile.height - 70 - step * 15 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction(() => scrollY > 130);
    await session.detach();
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await painted(page);
  await presentation(page, `${profile.name} enlarged`);
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; scrollTo(0, 0); });
  await painted(page);
}

console.log(`Live editor browser artifacts: ${artifacts}`);
try {
  for (const profile of profiles) {
    const fixture = await startLivePreview();
    let browser, page;
    const errors = [], external = [];
    try {
      browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ["--hide-scrollbars"], args: [`${profile.mode === "classic" ? "--disable-features" : "--enable-features"}=OverlayScrollbar`] });
      const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: 1, hasTouch: Boolean(profile.touch), isMobile: Boolean(profile.touch) });
      await context.route("**/*", route => { if (new URL(route.request().url()).origin === fixture.origin) return route.continue(); external.push(route.request().url()); return route.abort(); });
      page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      if (!frameClip) { frameClip = await makeFrameFixture(page, fixture.origin); await writeFile(resolve(artifacts, "synthetic-120fps.webm"), frameClip, { flag: "wx" }); }
      fixture.setFrameClip(frameClip);
      const workflow = await runWorkflow(page, fixture, profile);
      await scrollingAndFocus(page, profile);
      await page.screenshot({ path: resolve(artifacts, `${profile.name}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      results.profiles.push({ name: profile.name, passed: true, ...workflow });
      console.log(`PASS ${profile.name}`);
    } catch (error) {
      results.failure = { profile: profile.name, error: error.message, errors, external, requests: fixture.state.requests.slice(-12).map(({ path, method, search }) => ({ path, method, search })) };
      if (page) await page.screenshot({ path: resolve(artifacts, `${profile.name}-failure.png`), fullPage: true });
      throw error;
    } finally { await browser?.close(); await fixture.close(); }
  }
} finally { await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2), { flag: "wx" }); }
