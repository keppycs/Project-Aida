import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { FIRST_VIDEO, SECOND_VIDEO, NEW_VIDEO, STUDIO_TOKEN, TEST_IMAGE, startAdminPreview } from "./support/admin-preview.mjs";

const require = createRequire(import.meta.url);
const modules = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || `${modules}/playwright`);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifactRoot = process.env.AIDA_REVIEW_DIR || resolve("logs");
await mkdir(artifactRoot, { recursive: true });
const artifacts = resolve(artifactRoot, `admin-studio-${Date.now()}`);
await mkdir(artifacts);
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const requested = process.argv.find(argument => argument.startsWith("--profile="))?.split("=")[1];
const profiles = [
  { name: "classic-desktop", mode: "classic", width: 1440, height: 900 },
  { name: "overlay-desktop", mode: "overlay", width: 1440, height: 900 },
  { name: "phone360", mode: "overlay", width: 360, height: 800, touch: true },
  { name: "phone424", mode: "overlay", width: 424, height: 924, touch: true },
  { name: "landscape844", mode: "overlay", width: 844, height: 390, touch: true },
].filter(profile => !requested || requested.split(",").includes(profile.name));
assert.ok(profiles.length, "Choose an existing Studio profile.");
const results = { fixture: "Synthetic admin APIs only; no credentials, source files, media or external network.", modes: [], profiles: [] };
const painted = page => page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
const waitText = (page, selector, text) => page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
const countPOST = fixture => fixture.state.requests.filter(request => request.method === "POST").length;

async function noOverflow(page, label) {
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(geometry.scroll <= geometry.client + 1, `${label}: horizontal overflow ${JSON.stringify(geometry)}`);
  assert.equal(geometry.client, geometry.viewport, `${label}: page scrollbar must occupy zero width`);
}

async function controlPresentation(page) {
  const findings = await page.evaluate(() => {
    const failures = [];
    for (const element of document.querySelectorAll("*")) {
      if (!element.getClientRects().length) continue;
      const style = getComputedStyle(element);
      if (style.webkitTapHighlightColor !== "rgba(0, 0, 0, 0)") failures.push(`Tap highlight: ${element.tagName}#${element.id}`);
      if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) failures.push(`Outline: ${element.tagName}#${element.id}`);
      if (element.matches('button, a[href], input:not([type="radio"]):not([type="checkbox"]):not([type="file"]), select, textarea, .visibility-options span, .check, .file-button')) {
        const rect = element.getBoundingClientRect();
        if (rect.width < 43.5 || rect.height < 43.5) failures.push(`Small target: ${element.tagName}#${element.id} ${rect.width}x${rect.height}`);
      }
    }
    return failures;
  });
  assert.deepEqual(findings, [], "Controls must retain 44px targets, transparent tap feedback and no outlines");
}

async function focusPresentation(page, selector) {
  const locator = page.locator(selector);
  await locator.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await locator.evaluate(element => element.blur());
  await painted(page);
  const read = element => { const style = getComputedStyle(element), rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y + scrollY, width: rect.width, height: rect.height, fill: style.backgroundColor, ink: style.color, outline: style.outlineStyle, shadow: style.boxShadow, border: ["Top", "Right", "Bottom", "Left"].map(side => [style[`border${side}Width`], style[`border${side}Color`]]) }; };
  const before = await locator.evaluate(read);
  await page.keyboard.press("Tab");
  await locator.focus();
  await page.waitForTimeout(180);
  const after = await locator.evaluate(read);
  assert.equal(after.outline, "none", `${selector}: no focus outline`);
  assert.equal(after.shadow, before.shadow, `${selector}: no focus ring`);
  assert.deepEqual(after.border, before.border, `${selector}: no focus border`);
  for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(after[key] - before[key]) < .5, `${selector}: focus moved ${key}`);
  assert.ok(after.fill !== before.fill || after.ink !== before.ink, `${selector}: keyboard focus must have visible fill or ink feedback`);
}

async function samePreviewLink(page, fixture, id) {
  const expected = new URL(fixture.view(id).preview_url, fixture.origin);
  expected.searchParams.set("studio_revision", fixture.view(id).revision);
  assert.equal(await page.locator("#editor-player").getAttribute("src"), expected.href);
  assert.equal(await page.locator("#editor-preview-link").getAttribute("href"), expected.href);
  await page.frameLocator("#editor-player").locator("h1").waitFor();
}

async function waitMutation(page, fixture, before) {
  await page.waitForFunction(() => document.querySelector("#editor-form").getAttribute("aria-busy") === "false");
  assert.ok(countPOST(fixture) > before, "An explicit edit action must issue a mutation");
}

async function workflow(page, fixture) {
  await page.goto(fixture.origin);
  await page.locator(`.video-row[data-id="${FIRST_VIDEO}"]`).waitFor();
  assert.equal(await page.locator("#tab-videos").getAttribute("aria-selected"), "true");
  assert.equal(fixture.state.requests.some(request => request.search === "?remote=true"), false, "Initial library must not access the cloud");
  await page.locator(`.video-row[data-id="${FIRST_VIDEO}"]`).click();
  await waitText(page, "#editor-location", "website");
  await samePreviewLink(page, fixture, FIRST_VIDEO);
  assert.equal(await page.locator("#editor-card-visibility").textContent(), "Public · 120 fps", "A 120 fps label must reflect actual numeric metadata");
  await page.locator(`.video-row[data-id="${SECOND_VIDEO}"]`).click();
  await page.waitForFunction(() => document.querySelector("#edit-title").value === "Motion study 2");
  assert.equal(await page.locator("#editor-card-visibility").textContent(), "Private · 120 fps required", "Lower-frame-rate metadata must never be relabeled as 120 fps");
  await page.locator('.video-row[data-id="studio-002"]').click();
  await page.waitForFunction(() => document.querySelector("#edit-title").value === "Motion study 3");
  assert.equal(await page.locator("#editor-card-visibility").textContent(), "Private · 120 fps required", "Missing frame-rate metadata must not claim 120 fps");
  await page.locator(`.video-row[data-id="${FIRST_VIDEO}"]`).click();
  await page.waitForFunction(() => document.querySelector("#edit-title").value === "120 fps motion study");
  assert.ok(fixture.state.requests.some(request => request.path === `/api/videos/${FIRST_VIDEO}` && request.search === "?remote=true"));
  const anchors = async () => page.evaluate(() => Object.fromEntries(["#library-search", "#library-refresh"].map(selector => { const { x, width } = document.querySelector(selector).getBoundingClientRect(); return [selector, { x, width }]; })));
  const beforeSearch = await anchors();
  await page.locator("#library-search").fill("no such video at all");
  await waitText(page, "#library-status", "No matching");
  assert.equal(await page.locator(".video-row").count(), 0);
  assert.equal(await page.locator("#library-search").evaluate(element => document.activeElement === element), true);
  assert.deepEqual(await anchors(), beforeSearch, "Filtering must not alter horizontal control geometry");
  await page.locator("#library-search").fill("motion");
  assert.equal(await page.locator(".video-row").count(), 28);
  await page.locator("#library-search").fill("");

  await page.locator("#edit-title").fill("Edited locally at 120 fps");
  await page.locator("#edit-description").fill("Line one.\nLine two, preserved.");
  await page.locator("#edit-tags").fill("motion, 120 fps, edited");
  await page.locator('input[name="edit-visibility"][value="unlisted"]').check();
  await page.locator(`.video-row[data-id="${SECOND_VIDEO}"]`).click();
  await page.locator("#draft-prompt").waitFor({ state: "visible" });
  assert.equal(await page.locator("#edit-title").inputValue(), "Edited locally at 120 fps");
  await page.locator("#draft-keep").click();
  const beforeSave = countPOST(fixture);
  await page.locator("#editor-save").click();
  await waitMutation(page, fixture, beforeSave);
  await waitText(page, "#editor-save-state", "website unchanged");
  const save = fixture.state.requests.filter(request => request.method === "POST").at(-1);
  assert.equal(save.headers.session, STUDIO_TOKEN);
  assert.equal(save.body.publish, false);
  assert.equal(save.body.description, "Line one.\nLine two, preserved.");
  assert.deepEqual(save.body.tags, ["motion", "120 fps", "edited"]);
  assert.equal(save.body.visibility, "unlisted");
  await samePreviewLink(page, fixture, FIRST_VIDEO);

  await page.locator("#edit-title").fill("Typed while choosing thumbnails");
  await page.locator("#edit-thumbnail-file").setInputFiles({ name: "studio-thumbnail.png", mimeType: "image/png", buffer: TEST_IMAGE });
  await waitText(page, "#thumbnail-status", "Thumbnail saved");
  assert.equal(await page.locator("#edit-title").inputValue(), "Typed while choosing thumbnails");
  let thumb = fixture.state.requests.filter(request => request.path.endsWith("/thumbnail")).at(-1);
  assert.equal(thumb.body.image_base64, TEST_IMAGE.toString("base64"));
  assert.equal(thumb.body.content_type, "image/png");
  assert.equal(thumb.body.publish, false);
  assert.equal(thumb.headers.session, STUDIO_TOKEN);
  await page.locator("#thumbnail-frame-toggle").click();
  await page.locator("#edit-frame-browse").click();
  await page.waitForFunction(() => document.querySelector("#edit-frame-source").value.includes("synthetic-source.mp4"));
  await page.locator("#edit-frame-number").fill("321");
  const priorThumb = fixture.view(FIRST_VIDEO).revision;
  await page.locator("#edit-frame-apply").click();
  await page.waitForFunction(revision => document.querySelector("#editor-player").src.includes(`studio_revision=${revision}`) === false, priorThumb);
  await page.waitForFunction(() => document.querySelector("#editor-form").getAttribute("aria-busy") === "false");
  thumb = fixture.state.requests.filter(request => request.path.endsWith("/thumbnail")).at(-1);
  assert.equal(thumb.body.frame, 321);
  assert.ok(thumb.body.source_path.endsWith("/logs/synthetic-source.mp4"));
  assert.equal(thumb.body.revision, priorThumb);

  fixture.setNextMutation("publish");
  const oldRevision = fixture.view(FIRST_VIDEO).revision;
  await page.locator("#editor-publish").click();
  for (let attempt = 0; !fixture.state.held && attempt < 100; ++attempt) await new Promise(resolveWait => setTimeout(resolveWait, 10));
  assert.equal(fixture.state.held?.kind, "publish");
  await page.locator("#edit-title").fill("Newest typing stays after failed upload");
  fixture.releaseHeld();
  await waitText(page, "#editor-save-state", "Upload failed");
  assert.equal(await page.locator("#edit-title").inputValue(), "Newest typing stays after failed upload");
  assert.equal(await page.locator("#editor-save").isEnabled(), true);
  assert.equal(await page.locator("#editor-publish").isEnabled(), true);
  const retryRevision = fixture.view(FIRST_VIDEO).revision;
  assert.notEqual(retryRevision, oldRevision);
  await page.locator("#editor-publish").click();
  await waitText(page, "#editor-save-state", "website updated");
  const retry = fixture.state.requests.filter(request => request.method === "POST" && request.path === `/api/videos/${FIRST_VIDEO}`).at(-1);
  assert.equal(retry.body.revision, retryRevision, "Retry must use the revision returned with the failed upload");
  assert.equal(retry.body.title, "Newest typing stays after failed upload");
  assert.equal(retry.body.publish, true);

  await page.locator("#edit-title").fill("Local draft during online conflict");
  fixture.setNextMutation("remote");
  await page.locator("#editor-publish").click();
  await waitText(page, "#conflict-notice", "changed online");
  assert.equal(await page.locator("#edit-title").inputValue(), "Local draft during online conflict");
  assert.equal(await page.locator("#editor-publish").isDisabled(), true);
  await page.locator("#conflict-reload").click();
  await page.locator("#draft-prompt").waitFor({ state: "visible" });
  await page.locator("#draft-discard").click();
  await waitText(page, "#editor-save-state", "Latest online version loaded");
  assert.equal(await page.locator("#edit-title").inputValue(), "Online version to review");
  assert.equal(await page.locator("#editor-publish").isEnabled(), true);
  const reload = fixture.state.requests.filter(request => request.path.endsWith("/reload")).at(-1);
  assert.equal(reload.headers.session, STUDIO_TOKEN);

  await page.locator("#edit-title").fill("My edits while another local tab saves");
  fixture.setNextMutation("stale");
  await page.locator("#editor-save").click();
  await waitText(page, "#conflict-reload", "Review saved");
  assert.equal(await page.locator("#editor-publish").isEnabled(), true, "A stale local form is not an online conflict");
  assert.equal(await page.locator("#edit-title").inputValue(), "My edits while another local tab saves");
  const reloadCount = fixture.state.requests.filter(request => request.path.endsWith("/reload")).length;
  await page.locator("#conflict-reload").click();
  await page.locator("#draft-discard").click();
  await waitText(page, "#editor-save-state", "Saved version loaded");
  assert.equal(await page.locator("#edit-title").inputValue(), "Saved in another local tab");
  assert.equal(fixture.state.requests.filter(request => request.path.endsWith("/reload")).length, reloadCount, "Reviewing a stale local form must not discard saved drafts through cloud reload");

  await page.locator("#edit-title").fill("Unsaved selection test");
  await page.locator(`.video-row[data-id="${SECOND_VIDEO}"]`).click();
  await page.locator("#draft-discard").click();
  await page.waitForFunction(() => document.querySelector("#edit-title").value === "Motion study 2");
  fixture.failNextList();
  await page.locator("#library-refresh").click();
  await waitText(page, "#library-status", "unavailable");
  await page.locator("#library-retry").click();
  await page.locator("#library-retry").waitFor({ state: "hidden" });
  await page.waitForFunction(() => !document.querySelector("#library-refresh").disabled);
  assert.equal(await page.locator(".video-row").count(), 28);
  await page.locator(`.video-row[data-id="${FIRST_VIDEO}"]`).click();
  await page.waitForFunction(() => document.querySelector("#edit-title").value === "Saved in another local tab");
  await samePreviewLink(page, fixture, FIRST_VIDEO);
  await page.locator("#tab-maint").click();
  await page.locator("#sync-upload").click();
  await page.locator("#panel-videos").waitFor({ state: "visible" });
  assert.equal(fixture.state.requests.some(request => request.path === "/api/sync/upload"), false, "Maintenance must route publishing through the reviewed editor");
  await page.locator("#edit-title").fill("Keep this draft through encoding");
  await page.locator("#tab-encode").click();
  assert.equal(await page.locator("#visibility").inputValue(), "private");
  await page.locator("#browse-source").click();
  await waitText(page, "#source-info", "120.0 fps");
  await page.locator("#title").fill("A new private upload");
  await page.locator("#start-pipeline").click();
  await page.locator("#panel-videos").waitFor({ state: "visible" });
  await page.locator("#draft-prompt").waitFor({ state: "visible" });
  assert.equal(await page.locator("#edit-title").inputValue(), "Keep this draft through encoding");
  await page.locator(`.video-row[data-id="${NEW_VIDEO}"]`).waitFor();
  await page.locator("#draft-keep").click();
  await page.locator(`.video-row[data-id="${NEW_VIDEO}"]`).click();
  await page.locator("#draft-discard").click();
  await page.waitForFunction(() => document.querySelector("#edit-title").value === "A new private upload");
  await page.goto(`${fixture.origin}/?video=${FIRST_VIDEO}`);
  await page.waitForFunction(() => document.querySelector("#edit-title").value === "Saved in another local tab");
  await samePreviewLink(page, fixture, FIRST_VIDEO);
  assert.ok(fixture.state.requests.filter(request => request.method === "POST").every(request => request.headers.session === STUDIO_TOKEN));
}

async function scrolling(page, profile) {
  const list = page.locator("#video-list");
  await list.scrollIntoViewIfNeeded();
  const beforeWidth = await list.evaluate(element => ({ width: element.getBoundingClientRect().width, client: element.clientWidth }));
  assert.ok(Math.abs(beforeWidth.width - beforeWidth.client) < .5, "Library native scrollbar must consume zero width");
  await list.evaluate(element => { element.scrollTop = 0; });
  const rect = await list.boundingBox();
  await page.mouse.move(rect.x + 40, Math.max(30, rect.y + 40));
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(250);
  assert.ok(await list.evaluate(element => element.scrollTop) > 0, "Library wheel scrolling must stay native");
  await list.evaluate(element => { element.scrollTop = 0; });
  await list.focus();
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(250);
  assert.ok(await list.evaluate(element => element.scrollTop) > 0, "Library keyboard scrolling must stay native");
  await list.evaluate(element => { element.scrollTop = 0; });
  await painted(page);
  const thumb = list.locator("..").locator(".scroll-thumb");
  await thumb.waitFor({ state: "visible" });
  const thumbRect = await thumb.boundingBox();
  const selected = await page.locator('.video-row[aria-pressed="true"]').getAttribute("data-id");
  await page.mouse.move(thumbRect.x + thumbRect.width / 2, thumbRect.y + thumbRect.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumbRect.x + thumbRect.width / 2, thumbRect.y + thumbRect.height / 2 + 80, { steps: 6 });
  await page.mouse.up();
  assert.ok(await list.evaluate(element => element.scrollTop) > 0, "Overlay thumb drag must scroll the actual library");
  assert.equal(await page.locator('.video-row[aria-pressed="true"]').getAttribute("data-id"), selected, "Thumb drag must not select an adjacent row");
  if (profile.touch) {
    await list.evaluate(element => { element.scrollTop = 0; });
    await list.scrollIntoViewIfNeeded();
    const touchRect = await list.boundingBox();
    const x = touchRect.x + touchRect.width / 2, y = Math.min(profile.height - 45, Math.max(160, touchRect.y + 160));
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 6; ++step) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 15 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(250);
    await session.detach();
    assert.ok(await list.evaluate(element => element.scrollTop) > 0, "Native touch scroll must move the library");
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await painted(page);
  const pageThumb = page.locator(".page-scroll-thumb");
  await pageThumb.waitFor({ state: "visible" });
  const pageRect = await pageThumb.boundingBox();
  await page.mouse.move(pageRect.x + pageRect.width / 2, pageRect.y + pageRect.height / 2);
  await page.mouse.down();
  await page.mouse.move(pageRect.x + pageRect.width / 2, pageRect.y + pageRect.height / 2 + 60, { steps: 6 });
  await page.mouse.up();
  assert.ok(await page.evaluate(() => window.scrollY) > 0, "Page overlay thumb must drive native document scroll");
  assert.deepEqual(await list.evaluate(element => ({ width: element.getBoundingClientRect().width, client: element.clientWidth })), beforeWidth, "Scrollbar changes must preserve list width");
}

console.log(`Studio browser artifacts: ${artifacts}`);
try {
  for (const profile of profiles) {
    const fixture = await startAdminPreview();
    let browser;
    try {
      browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--enable-automation", `${profile.mode === "classic" ? "--disable-features" : "--enable-features"}=OverlayScrollbar`] });
      const browserSession = await browser.newBrowserCDPSession();
      const commandLine = await browserSession.send("Browser.getBrowserCommandLine");
      assert.equal(commandLine.arguments.includes("--hide-scrollbars"), false, "Hidden scrollbars cannot verify native overlay behavior");
      const probe = await browser.newPage();
      await probe.setContent('<div style="width:200px;height:100px;overflow:scroll"><div style="height:500px">Native scrollbar probe</div></div>');
      const gutter = await probe.locator("div").first().evaluate(element => element.offsetWidth - element.clientWidth);
      assert.ok(profile.mode === "classic" ? gutter > 0 : gutter === 0, `Requested ${profile.mode} scrollbars; native probe measured ${gutter}px`);
      results.modes.push({ profile: profile.name, mode: profile.mode, nativeGutter: gutter, hideScrollbars: false });
      await probe.close();
      await browserSession.detach();
      const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: 1, hasTouch: Boolean(profile.touch), isMobile: Boolean(profile.touch) });
      const page = await context.newPage();
      const errors = [], external = [];
      page.on("pageerror", error => errors.push(error.message));
      await context.route("**/*", route => { if (new URL(route.request().url()).origin === fixture.origin) return route.continue(); external.push(route.request().url()); return route.abort(); });
      await workflow(page, fixture);
      await noOverflow(page, profile.name);
      await controlPresentation(page);
      await scrolling(page, profile);
      for (const selector of ["#library-search", "#edit-title", "#thumbnail-frame-toggle", "#editor-publish"]) await focusPresentation(page, selector);
      await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      await painted(page);
      await noOverflow(page, `${profile.name} enlarged text`);
      await controlPresentation(page);
      await page.evaluate(() => { document.documentElement.style.fontSize = ""; window.scrollTo(0, 0); });
      await painted(page);
      const screenshot = resolve(artifacts, `${profile.name}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      assert.deepEqual(errors, [], `${profile.name}: no script errors`);
      assert.deepEqual(external, [], `${profile.name}: fixture must never access external services`);
      results.profiles.push({ name: profile.name, viewport: `${profile.width}x${profile.height}`, passed: true, screenshot, mutations: countPOST(fixture) });
      console.log(`PASS ${profile.name}`);
    } finally { await browser?.close(); await fixture.close(); }
  }
} catch (error) { results.error = error.message; throw error; }
finally { await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2), { flag: "wx" }); }
console.log(`Studio profiles passed: ${results.profiles.length}`);
