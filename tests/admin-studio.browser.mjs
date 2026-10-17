import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { FIRST_VIDEO, SECOND_VIDEO, NEW_VIDEO, STUDIO_TOKEN, TEST_IMAGE, FRAME_FIXTURE, frameFixtureColor, makeFrameFixture, startAdminPreview } from "./support/admin-preview.mjs";

const require = createRequire(import.meta.url);
const modules = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || `${modules}/playwright`);
const sharp = require(`${modules}/sharp`);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifactRoot = process.env.AIDA_REVIEW_DIR || resolve("logs");
await mkdir(artifactRoot, { recursive: true });
const artifacts = resolve(artifactRoot, `admin-studio-${Date.now()}`);
await mkdir(artifacts);
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const requested = process.argv.find(argument => argument.startsWith("--profile="))?.split("=")[1];
const navigationOnly = process.argv.includes("--frame-navigation-only");
const profiles = [
  { name: "classic-desktop", mode: "classic", width: 1440, height: 900 },
  { name: "overlay-desktop", mode: "overlay", width: 1440, height: 900 },
  { name: "phone360", mode: "overlay", width: 360, height: 800, touch: true },
  { name: "phone424", mode: "overlay", width: 424, height: 924, touch: true },
  { name: "landscape844", mode: "overlay", width: 844, height: 390, touch: true },
].filter(profile => !requested || requested.split(",").includes(profile.name));
assert.ok(profiles.length, "Choose an existing Studio profile.");
const results = { fixture: "Synthetic admin APIs and a WebCodecs120fps VP8 clip; no credentials, private source files or external network.", mode: navigationOnly ? "frame-navigation-only" : "full-studio", modes: [], profiles: [], frameNavigation: [] };
let frameClip;
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
  await page.waitForFunction(expected => {
    const iframe = document.querySelector("#editor-player");
    try { return iframe?.contentWindow?.location.href === expected && iframe.contentDocument?.readyState === "complete" && iframe.contentDocument.querySelector("#video")?.readyState >= 2; }
    catch { return false; }
  }, expected.href);
  await page.frameLocator("#editor-player").locator("h1").waitFor();
}

async function reloadPreview(page) {
  await page.locator("#editor-player").evaluate(iframe => new Promise(resolveLoad => {
    iframe.addEventListener("load", () => resolveLoad(), { once: true });
    iframe.contentWindow.location.reload();
  }));
}

async function waitMutation(page, fixture, before) {
  await page.waitForFunction(() => document.querySelector("#editor-form").getAttribute("aria-busy") === "false");
  assert.ok(countPOST(fixture) > before, "An explicit edit action must issue a mutation");
}

function selectedURL(page, id) {
  const url = new URL(page.url());
  assert.equal(url.pathname, "/edit", "The Studio editor must use its canonical edit route");
  assert.equal(url.searchParams.get("v"), id, "The Studio address must match the successfully opened video");
  assert.equal(url.searchParams.has("video"), false, "Successful selection must remove the legacy video parameter");
  assert.equal(url.searchParams.get("keep"), "one two", "Selection must preserve unrelated query parameters");
  assert.equal(url.hash, "#studio", "Selection must preserve the URL fragment");
}

async function pickerFrame(page, frame) {
  try { await page.waitForFunction(({ frame, fps }) => {
    const canvas = document.querySelector("#edit-frame-canvas");
    return !document.querySelector("#edit-frame-apply")?.disabled &&
      Math.abs(Number(canvas?.dataset.frameTime) - (frame - 1) / fps) < .001 &&
      Number(document.querySelector("#edit-frame-number")?.value) === frame;
  }, { frame, fps: FRAME_FIXTURE.fps }); }
  catch (error) {
    const state = await page.evaluate(() => {
      const video = document.querySelector("#editor-player")?.contentDocument?.querySelector("#video");
      return { canvas: { ...document.querySelector("#edit-frame-canvas")?.dataset }, number: document.querySelector("#edit-frame-number")?.value,
        status: document.querySelector("#edit-frame-status")?.textContent, disabled: document.querySelector("#edit-frame-apply")?.disabled,
        video: video && { time: video.currentTime, seeking: video.seeking, readyState: video.readyState, duration: video.duration, error: video.error?.message } };
    });
    throw new Error(`Frame ${frame} did not become ready: ${JSON.stringify(state)}`, { cause: error });
  }
  const picture = await page.locator("#edit-frame-canvas").evaluate(canvas => {
    const context = canvas.getContext("2d");
    return { width: canvas.width, height: canvas.height, time: Number(canvas.dataset.frameTime), exact: canvas.dataset.frameExact,
      color: [...context.getImageData(40, 67, 1, 1).data].slice(0, 3), parity: [...context.getImageData(12, 12, 1, 1).data].slice(0, 3),
      marker: Array.from({ length: 8 }, (_, bit) => context.getImageData(14 + bit * 18, 82, 1, 1).data[0] > 128 ? 1 << bit : 0).reduce((sum, value) => sum + value, 0) };
  });
  assert.equal(picture.width, FRAME_FIXTURE.width);
  assert.equal(picture.height, FRAME_FIXTURE.height);
  assert.notEqual(picture.exact, "false", "Actual rVFC decoded-frame timing must be exact");
  assert.equal(picture.marker, frame - 1, `Frame ${frame}: pictured binary marker must match the displayed frame number and timestamp`);
  const expected = frameFixtureColor(frame - 1);
  // VP8's YUV conversion may shift RGB values; timestamps and the alternating
  // black/white patch independently distinguish the exact adjacent frame.
  expected.forEach((value, index) => assert.ok(Math.abs(picture.color[index] - value) <= 24,
    `Frame ${frame}: decoded canvas color ${picture.color} must match ${expected}`));
  assert.ok(picture.parity.every(value => (frame - 1) % 2 ? value < 35 : value > 220),
    `Frame ${frame}: alternating parity marker must distinguish adjacent real frames (${picture.parity})`);
  return picture;
}

async function openPicker(page) {
  if (await page.locator("#thumbnail-frame-toggle").getAttribute("aria-expanded") !== "true") await page.locator("#thumbnail-frame-toggle").click();
  await page.locator("#edit-frame-canvas").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector("#edit-frame-apply")?.disabled);
}

async function navigationTrace(page, name, action, expectedClicks) {
  await page.evaluate(() => {
    const samples = [], events = [], controls = ["edit-frame-prev", "edit-frame-next", "edit-frame-apply", "edit-frame-seek", "edit-frame-number"];
    const audit = window.__aidaFrameNavigation = { samples, events, expected: Number(document.querySelector("#edit-frame-number").value), active: true, canvasResizes: 0 };
    const snapshot = kind => {
      if (!audit.active || samples.length >= 1000) return;
      const canvas = document.querySelector("#edit-frame-canvas"), placeholder = document.querySelector("#edit-frame-placeholder"), apply = document.querySelector("#edit-frame-apply");
      const video = document.querySelector("#editor-player").contentDocument.querySelector("#video");
      const context = canvas.getContext("2d"), color = [...context.getImageData(40, 67, 1, 1).data];
      const marker = Array.from({ length: 8 }, (_, bit) => context.getImageData(14 + bit * 18, 82, 1, 1).data[0] > 128 ? 1 << bit : 0).reduce((sum, value) => sum + value, 0);
      samples.push({ kind, time: performance.now(), expected: audit.expected, marker, label: Number(document.querySelector("#edit-frame-number").value),
        visible: !canvas.hidden && Boolean(canvas.getClientRects().length), nonempty: color.slice(0, 3).some(value => value > 15),
        loading: (!placeholder.hidden && Boolean(placeholder.getClientRects().length)) || /loading frame/i.test(document.querySelector("#edit-frame-status").textContent),
        status: document.querySelector("#edit-frame-status").textContent,
        captureDisabled: apply.disabled, captureOpacity: getComputedStyle(apply).opacity, pending: apply.disabled || video.seeking, focus: document.activeElement.id,
        scrollX, scrollY, rects: Object.fromEntries(controls.map(id => { const element = document.getElementById(id), rect = element.getBoundingClientRect(); return [id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, opacity: getComputedStyle(element).opacity }]; })) });
    };
    const click = event => {
      const button = event.target.closest("#edit-frame-prev, #edit-frame-next");
      if (!button || button.disabled || !event.isTrusted) return;
      const delta = button.id === "edit-frame-next" ? 1 : -1;
      audit.expected = Math.min(240, Math.max(1, audit.expected + delta));
      events.push({ control: button.id, delta, detail: event.detail, expected: audit.expected });
    };
    const afterClick = event => { if (event.isTrusted && event.target.closest("#edit-frame-prev, #edit-frame-next")) snapshot("after-click"); };
    document.addEventListener("click", click, true);
    // Capture counts the accepted intent; bubble samples after the button's
    // own handler. Microtasks can run between native event listeners.
    document.addEventListener("click", afterClick);
    const observer = new MutationObserver(records => {
      audit.canvasResizes += records.filter(record => record.target.id === "edit-frame-canvas" && (record.attributeName === "width" || record.attributeName === "height")).length;
      snapshot("mutation");
    });
    observer.observe(document.querySelector("#thumbnail-frame-fields"), { attributes: true, childList: true, characterData: true, subtree: true });
    let frame;
    const sampleFrame = () => { snapshot("animation-frame"); if (audit.active) frame = requestAnimationFrame(sampleFrame); };
    snapshot("initial"); frame = requestAnimationFrame(sampleFrame);
    audit.stop = () => { audit.active = false; cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener("click", click, true); document.removeEventListener("click", afterClick); return { samples, events, expected: audit.expected, canvasResizes: audit.canvasResizes }; };
  });
  let trace;
  try {
    await action();
    await page.waitForFunction(() => !document.querySelector("#edit-frame-apply").disabled && Number(document.querySelector("#edit-frame-number").value) === window.__aidaFrameNavigation.expected);
    await painted(page);
  } finally { trace = await page.evaluate(() => window.__aidaFrameNavigation.stop()); }
  results.frameNavigation.push({ name, viewport: page.viewportSize(), ...trace });
  const first = trace.samples[0];
  assert.ok(trace.samples.some(sample => sample.kind === "animation-frame" && sample.pending), `${name}: sample actual intermediate seek paints`);
  assert.ok(trace.samples.every(sample => sample.visible && sample.nonempty), `${name}: keep the painted canvas visible and nonempty between frames`);
  assert.ok(trace.samples.every(sample => !sample.loading), `${name}: do not flash a loading overlay or status after the first decoded frame`);
  assert.ok(trace.samples.every(sample => sample.status === first.status), `${name}: keep the decoded-frame guidance stable between steps`);
  assert.ok(trace.samples.every(sample => sample.captureOpacity === first.captureOpacity), `${name}: disabling capture while decoding must not flash the Use button opacity`);
  assert.equal(trace.canvasResizes, 0, `${name}: do not clear the painted canvas by reassigning unchanged dimensions`);
  assert.equal(trace.events.length, expectedClicks, `${name}: rapid native activations must remain available while decoding`);
  for (const sample of trace.samples) {
    assert.ok(sample.marker + 1 === sample.expected || sample.captureDisabled, `${name}: Use must stay disabled until the newest requested frame is painted`);
    assert.ok(sample.focus === "edit-frame-prev" || sample.focus === "edit-frame-next", `${name}: frame stepping must retain control focus (${sample.focus})`);
    assert.ok(Math.abs(sample.scrollX - first.scrollX) < .5 && Math.abs(sample.scrollY - first.scrollY) < .5, `${name}: stepping must not scroll the page`);
    for (const [id, rect] of Object.entries(sample.rects)) {
      for (const dimension of ["x", "y", "width", "height"]) assert.ok(Math.abs(rect[dimension] - first.rects[id][dimension]) < .5, `${name}: ${id} changed ${dimension} during navigation`);
      assert.equal(rect.opacity, first.rects[id].opacity, `${name}: ${id} opacity must stay steady during warm navigation`);
    }
  }
  await pickerFrame(page, trace.expected);
}

async function stableFrameNavigation(page, fixture) {
  await page.goto(`${fixture.origin}/edit?v=${FIRST_VIDEO}&keep=one%20two#studio`);
  await page.waitForFunction(() => document.querySelector("#edit-title")?.value === "120 fps motion study");
  await samePreviewLink(page, fixture, FIRST_VIDEO);
  await openPicker(page);
  await page.locator("#edit-frame-number").fill("61");
  await page.locator("#edit-frame-number").press("Tab");
  await pickerFrame(page, 61);
  const before = countPOST(fixture);
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  for (const [selector, name, count] of [["#edit-frame-next", "rapid-next", 6], ["#edit-frame-prev", "rapid-previous", 4]]) {
    const button = page.locator(selector);
    await button.scrollIntoViewIfNeeded(); await button.focus(); await painted(page);
    const rect = await button.boundingBox();
    await navigationTrace(page, name, async () => {
      for (let index = 0; index < count; ++index) {
        if (touch) await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
        else await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
      }
    }, count);
  }
  const next = page.locator("#edit-frame-next");
  await next.scrollIntoViewIfNeeded(); await next.focus(); await painted(page);
  const rect = await next.boundingBox();
  await navigationTrace(page, "held-navigation", async () => {
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    if (touch) {
      const session = await page.context().newCDPSession(page);
      try {
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        await page.waitForTimeout(90);
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } finally { await session.detach(); }
    } else {
      await page.mouse.move(x, y); await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up();
    }
  }, 1);
  for (const [selector, name] of [["#edit-frame-next", "keyboard-next"], ["#edit-frame-prev", "keyboard-previous"]]) {
    await page.locator(selector).focus(); await painted(page);
    await navigationTrace(page, name, async () => { for (let index = 0; index < 5; ++index) await page.keyboard.press("Enter"); }, 5);
  }
  assert.equal(countPOST(fixture), before, "Frame navigation must never save or upload anything");
}

async function visualFramePicker(page, fixture) {
  const typed = { title: await page.locator("#edit-title").inputValue(), description: await page.locator("#edit-description").inputValue(), tags: await page.locator("#edit-tags").inputValue() };
  const originalRequests = fixture.state.requests.length;
  await openPicker(page);
  assert.equal(await page.locator("#edit-frame-source").count(), 0, "Picking an already uploaded frame must not ask for a local source path");
  assert.equal(await page.locator("#edit-frame-browse").count(), 0);
  await page.locator("#edit-frame-number").fill("61");
  await page.locator("#edit-frame-number").press("Tab");
  await pickerFrame(page, 61);
  await page.locator("#edit-frame-next").click();
  await pickerFrame(page, 62);
  await page.locator("#edit-frame-prev").click();
  await pickerFrame(page, 61);
  const seeking = await page.locator("#edit-frame-seek").evaluate(slider => {
    for (const time of [.25, 1.25, .75]) { slider.value = String(time); slider.dispatchEvent(new Event("input", { bubbles: true })); }
    return document.querySelector("#edit-frame-apply").disabled;
  });
  assert.equal(seeking, true, "Capture must disable synchronously while a new frame is seeking");
  const capturedPicture = await pickerFrame(page, 91);
  await noOverflow(page, "Open visual frame picker");
  await controlPresentation(page);
  for (const selector of ["#edit-frame-prev", "#edit-frame-next", "#edit-frame-apply"]) await focusPresentation(page, selector);
  if (await page.evaluate(() => navigator.maxTouchPoints > 0)) {
    const slider = page.locator("#edit-frame-seek");
    await slider.scrollIntoViewIfNeeded();
    const rect = await slider.boundingBox();
    const touch = await page.context().newCDPSession(page);
    try {
      const y = rect.y + rect.height / 2;
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: rect.x + rect.width * .25, y }] });
      for (let step = 1; step <= 4; ++step) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: rect.x + rect.width * (.25 + step * .1), y }] });
      const held = await slider.evaluate(element => { const style = getComputedStyle(element), rect = element.getBoundingClientRect(); return { x: rect.x, width: rect.width, height: rect.height, tap: style.webkitTapHighlightColor, outline: style.outlineStyle, shadow: style.boxShadow }; });
      assert.equal(held.tap, "rgba(0, 0, 0, 0)");
      assert.equal(held.outline, "none");
      assert.equal(held.shadow, "none");
      assert.ok(Math.abs(held.x - rect.x) < .5 && Math.abs(held.width - rect.width) < .5 && Math.abs(held.height - rect.height) < .5, "Held native range touch must preserve its geometry");
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally { await touch.detach(); }
    await page.waitForFunction(() => !document.querySelector("#edit-frame-apply").disabled && Number(document.querySelector("#edit-frame-canvas").dataset.frameTime) > 1);
    await pickerFrame(page, Number(await page.locator("#edit-frame-number").inputValue()));
    await page.locator("#edit-frame-number").fill("91");
    await page.locator("#edit-frame-number").press("Tab");
    await pickerFrame(page, 91);
  }
  const viewport = page.viewportSize();
  await page.locator("#thumbnail-frame-fields").screenshot({ path: resolve(artifacts, `frame-picker-${viewport.width}x${viewport.height}.png`) });
  const priorThumb = fixture.view(FIRST_VIDEO).revision;
  const before = countPOST(fixture);
  const capturedResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/thumbnail"));
  await page.locator("#edit-frame-apply").click();
  assert.equal((await capturedResponse).status(), 200);
  await waitMutation(page, fixture, before);
  const thumbnail = fixture.state.requests.filter(request => request.path.endsWith("/thumbnail")).at(-1);
  assert.equal(thumbnail.body.content_type, "image/jpeg");
  assert.equal(thumbnail.body.publish, false);
  assert.equal(thumbnail.body.revision, priorThumb);
  assert.equal(Object.hasOwn(thumbnail.body, "source_path"), false, "Frame capture must never resubmit a source video");
  assert.equal(Object.hasOwn(thumbnail.body, "frame"), false, "The API receives the pictured JPEG rather than asking FFmpeg for a source frame");
  const bytes = Buffer.from(thumbnail.body.image_base64, "base64");
  assert.equal(bytes.readUInt16BE(0), 0xffd8, "Captured payload must be a real JPEG");
  const decoded = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, FRAME_FIXTURE.width);
  assert.equal(decoded.info.height, FRAME_FIXTURE.height);
  const pixel = (67 * decoded.info.width + 40) * decoded.info.channels;
  capturedPicture.color.forEach((value, index) => assert.ok(Math.abs(decoded.data[pixel + index] - value) <= 10, "Saved JPEG must match the actual selected decoded frame"));
  const capturedMarker = Array.from({ length: 8 }, (_, bit) => decoded.data[(82 * decoded.info.width + 14 + bit * 18) * decoded.info.channels] > 128 ? 1 << bit : 0).reduce((sum, value) => sum + value, 0);
  assert.equal(capturedMarker, 90, "Captured JPEG's binary frame marker must match the picture and displayed frame91");
  for (const [name, value] of Object.entries(typed)) assert.equal(await page.locator(`#edit-${name}`).inputValue(), value, "Frame capture must preserve typed metadata");
  assert.equal(fixture.state.requests.slice(originalRequests).some(request => request.path === "/api/pipeline" || request.path === "/api/browse" || request.path === "/api/probe"), false,
    "Picking a stored video frame must never restart an upload or ask for the source file");
  await samePreviewLink(page, fixture, FIRST_VIDEO);
  await page.waitForFunction(() => document.querySelector("#thumbnail-frame-toggle").getAttribute("aria-expanded") === "false");

  await openPicker(page);
  const beforeReload = countPOST(fixture);
  await reloadPreview(page);
  await page.waitForFunction(() => document.querySelector("#thumbnail-frame-toggle").getAttribute("aria-expanded") === "false");
  assert.equal(await page.locator("#edit-frame-apply").isDisabled(), true, "Reload must invalidate the old canvas capture");
  await samePreviewLink(page, fixture, FIRST_VIDEO);
  await openPicker(page);
  await page.frameLocator("#editor-player").locator("#video").evaluate(video => { video.src = "/__fixture/missing.webm"; video.load(); });
  await page.waitForFunction(() => document.querySelector("#edit-frame-apply")?.disabled && document.querySelector("#edit-frame-status")?.textContent.trim());
  assert.equal(countPOST(fixture), beforeReload, "Reload and decode errors must never save stale frames");
  for (const [name, value] of Object.entries(typed)) assert.equal(await page.locator(`#edit-${name}`).inputValue(), value);
  await reloadPreview(page);
  await samePreviewLink(page, fixture, FIRST_VIDEO);
}

async function refreshPreservesDraft(page, fixture) {
  await openPicker(page);
  const currentURL = page.url(), preview = await page.locator("#editor-player").getAttribute("src");
  const typed = await page.locator("#edit-title").inputValue();
  const reads = fixture.state.requests.length;
  await page.locator("#edit-frame-refresh").click();
  await page.locator("#draft-prompt").waitFor({ state: "visible" });
  await page.locator("#draft-keep").click();
  assert.equal(await page.locator("#edit-title").inputValue(), typed);
  assert.equal(page.url(), currentURL);
  assert.equal(await page.locator("#editor-player").getAttribute("src"), preview);
  assert.equal(fixture.state.requests.slice(reads).some(request => request.path === `/api/videos/${FIRST_VIDEO}` && request.search === "?remote=true"), false,
    "Keeping an unsaved draft must not fetch or adopt an online revision");
  await page.locator("#editor-save").click();
  await waitText(page, "#editor-save-state", "website unchanged");
  await samePreviewLink(page, fixture, FIRST_VIDEO);
  await openPicker(page);
  const savedRevision = fixture.view(FIRST_VIDEO).revision;
  const savedPreview = await page.locator("#editor-player").getAttribute("src");
  const pattern = /\/api\/videos\/studio-000\?remote=true$/;
  let reached, release, finished, routeError;
  const entered = new Promise(resolveEntered => { reached = resolveEntered; });
  const held = new Promise(resolveHeld => { release = resolveHeld; });
  const complete = new Promise(resolveComplete => { finished = resolveComplete; });
  await page.route(pattern, async route => {
    reached(); await held;
    try { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...fixture.view(FIRST_VIDEO), revision: "r999", title: "Unseen online refresh" }) }); }
    catch (error) { if (!route.request().failure()) routeError = error; }
    finally { finished(); }
  });
  try {
    await page.locator("#edit-frame-refresh").click();
    await entered;
    await page.locator("#edit-title").fill("Typing during refresh stays local");
    release(); await complete;
    if (routeError) throw routeError;
    await waitText(page, "#thumbnail-status", "Refresh cancelled");
    assert.equal(await page.locator("#edit-title").inputValue(), "Typing during refresh stays local");
    assert.equal(page.url(), currentURL);
    assert.equal(await page.locator("#editor-player").getAttribute("src"), savedPreview);
    const beforeSave = countPOST(fixture);
    await page.locator("#editor-save").click();
    await waitMutation(page, fixture, beforeSave);
    const saved = fixture.state.requests.filter(request => request.path === `/api/videos/${FIRST_VIDEO}` && request.method === "POST").at(-1);
    assert.equal(saved.body.revision, savedRevision, "Typing must prevent a held refresh from adopting the unseen cloud revision");
    assert.equal(saved.body.title, "Typing during refresh stays local");
    await waitText(page, "#editor-save-state", "website unchanged");
  } finally { release(); await page.unroute(pattern); }
}

async function rejectedSelectionsKeepURL(page, fixture) {
  const originalURL = page.url();
  const originalTitle = await page.locator("#edit-title").inputValue();
  const originalPreview = await page.locator("#editor-player").getAttribute("src");
  const failurePattern = /\/api\/videos\/studio-003\?/;
  await page.route(failurePattern, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Fixture selection unavailable." }) }));
  try {
    await page.locator('.video-row[data-id="studio-003"]').click();
    await waitText(page, "#library-status", "selection unavailable");
    assert.equal(page.url(), originalURL, "A failed selection must leave the current video's address intact");
    assert.equal(await page.locator("#edit-title").inputValue(), originalTitle);
    assert.equal(await page.locator("#editor-player").getAttribute("src"), originalPreview);
  } finally { await page.unroute(failurePattern); }

  const abortPattern = /\/api\/videos\/studio-004\?/;
  let entered, release, complete, routeError;
  const reached = new Promise(resolveReached => { entered = resolveReached; });
  const held = new Promise(resolveHeld => { release = resolveHeld; });
  const completed = new Promise(resolveCompleted => { complete = resolveCompleted; });
  await page.route(abortPattern, async route => {
    entered();
    await held;
    try { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture.view("studio-004")) }); }
    catch (error) { if (!route.request().failure()) routeError = error; }
    finally { complete(); }
  });
  try {
    await page.locator('.video-row[data-id="studio-004"]').click();
    await reached;
    await page.locator("#edit-title").fill("Typing cancels the pending selection");
    release();
    await completed;
    if (routeError) throw routeError;
    await waitText(page, "#library-status", "Opening cancelled");
    await painted(page);
    assert.equal(page.url(), originalURL, "An aborted selection must leave the current video's address intact");
    assert.equal(await page.locator("#edit-title").inputValue(), "Typing cancels the pending selection");
    assert.equal(await page.locator("#editor-player").getAttribute("src"), originalPreview);
    await page.locator("#edit-title").fill(originalTitle);
  } finally { release(); await page.unroute(abortPattern); }
}

async function workflow(page, fixture) {
  await page.goto(`${fixture.origin}/?keep=one%20two#studio`);
  await page.locator(`.video-row[data-id="${FIRST_VIDEO}"]`).waitFor();
  assert.equal(await page.locator("#tab-videos").getAttribute("aria-selected"), "true");
  assert.equal(fixture.state.requests.some(request => request.search === "?remote=true"), false, "Initial library must not access the cloud");
  const historyLength = await page.evaluate(() => history.length);
  await page.locator(`.video-row[data-id="${FIRST_VIDEO}"]`).click();
  await waitText(page, "#editor-location", "website");
  await samePreviewLink(page, fixture, FIRST_VIDEO);
  selectedURL(page, FIRST_VIDEO);
  assert.equal(await page.evaluate(() => history.length), historyLength, "Selection should update the current address without adding a history entry");
  assert.equal(await page.locator("#editor-card-visibility").textContent(), "Public · 120 fps", "A 120 fps label must reflect actual numeric metadata");
  await page.locator(`.video-row[data-id="${SECOND_VIDEO}"]`).click();
  await page.waitForFunction(() => document.querySelector("#edit-title").value === "Motion study 2");
  selectedURL(page, SECOND_VIDEO);
  assert.equal(await page.locator("#editor-card-visibility").textContent(), "Private · 120 fps required", "Lower-frame-rate metadata must never be relabeled as 120 fps");
  await page.locator('.video-row[data-id="studio-002"]').click();
  await page.waitForFunction(() => document.querySelector("#edit-title").value === "Motion study 3");
  selectedURL(page, "studio-002");
  assert.equal(await page.locator("#editor-card-visibility").textContent(), "Private · 120 fps required", "Missing frame-rate metadata must not claim 120 fps");
  await page.locator(`.video-row[data-id="${FIRST_VIDEO}"]`).click();
  await page.waitForFunction(() => document.querySelector("#edit-title").value === "120 fps motion study");
  selectedURL(page, FIRST_VIDEO);
  await rejectedSelectionsKeepURL(page, fixture);
  assert.ok(fixture.state.requests.some(request => request.path === `/api/videos/${FIRST_VIDEO}` && request.search === "?check_online=true"));
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
  const draftURL = page.url();
  await page.locator(`.video-row[data-id="${SECOND_VIDEO}"]`).click();
  await page.locator("#draft-prompt").waitFor({ state: "visible" });
  assert.equal(page.url(), draftURL, "A selection waiting for a dirty-draft decision must not change the address");
  assert.equal(await page.locator("#edit-title").inputValue(), "Edited locally at 120 fps");
  await page.locator("#draft-keep").click();
  assert.equal(page.url(), draftURL, "Keeping the current draft must leave its address intact");
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
  await visualFramePicker(page, fixture);
  await refreshPreservesDraft(page, fixture);

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
  await openPicker(page);
  await page.locator("#edit-frame-seek").evaluate(slider => { slider.value = "1.25"; slider.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.locator(`.video-row[data-id="${SECOND_VIDEO}"]`).click();
  await page.locator("#draft-discard").click();
  await page.waitForFunction(() => document.querySelector("#thumbnail-frame-toggle").getAttribute("aria-expanded") === "false");
  assert.equal(await page.locator("#edit-frame-apply").isDisabled(), true, "Switching videos must invalidate pending frame captures");
  assert.equal(await page.locator("#edit-frame-canvas").getAttribute("data-frame-time"), null);
  await page.waitForFunction(() => document.querySelector("#edit-title").value === "Motion study 2");
  selectedURL(page, SECOND_VIDEO);
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
  await page.goto(`${fixture.origin}/?video=${FIRST_VIDEO}&keep=one%20two#studio`);
  await page.waitForFunction(() => document.querySelector("#edit-title").value === "Saved in another local tab");
  await samePreviewLink(page, fixture, FIRST_VIDEO);
  selectedURL(page, FIRST_VIDEO);
  await page.goto(`${fixture.origin}/edit?v=${FIRST_VIDEO}&video=legacy-ignored&keep=one%20two#studio`);
  await page.waitForFunction(() => document.querySelector("#edit-title").value === "Saved in another local tab");
  await samePreviewLink(page, fixture, FIRST_VIDEO);
  selectedURL(page, FIRST_VIDEO);
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
      page.on("pageerror", error => { errors.push(error.message); console.error(`${profile.name}: ${error.message}`); });
      await context.route("**/*", route => { if (new URL(route.request().url()).origin === fixture.origin) return route.continue(); external.push(route.request().url()); return route.abort(); });
      if (!frameClip) {
        frameClip = await makeFrameFixture(page, fixture.origin);
        await writeFile(resolve(artifacts, "synthetic-120fps.webm"), frameClip, { flag: "wx" });
        results.decodedFixture = { ...FRAME_FIXTURE, bytes: frameClip.length };
      }
      fixture.setFrameClip(frameClip);
      try {
        await stableFrameNavigation(page, fixture);
        if (!navigationOnly) await workflow(page, fixture);
      }
      catch (error) {
        results.failure = { profile: profile.name, errors, external, lastRequests: fixture.state.requests.slice(-10).map(({ method, path, search }) => ({ method, path, search })) };
        await page.screenshot({ path: resolve(artifacts, `${profile.name}-failure.png`), fullPage: true });
        throw error;
      }
      await noOverflow(page, profile.name);
      await controlPresentation(page);
      if (!navigationOnly) {
        await scrolling(page, profile);
        for (const selector of ["#library-search", "#edit-title", "#thumbnail-frame-toggle", "#editor-publish"]) await focusPresentation(page, selector);
      }
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
