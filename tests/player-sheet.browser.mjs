import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { PUBLIC_VIDEO_ID, startPlayerPreview } from "./support/player-preview.mjs";

const require = createRequire(import.meta.url);
const modules = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || `${modules}/playwright`);
const sharp = require(`${modules}/sharp`);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = process.env.AIDA_REVIEW_DIR || `C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-sheet-${Date.now()}`;
const baseline = process.argv.includes("--baseline");
const mobileOnly = process.argv.includes("--mobile-only");
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const preview = await startPlayerPreview();
const report = { baseline, desktop: {}, mobile: [] };
let browser, page;
console.log(`Sheet artifacts: ${artifacts}`);

const painted = page => page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
async function settled(page, phase = "open", name = "home") {
  await page.waitForFunction(({ phase, name }) => {
    const panel = document.querySelector("#settings-panel");
    return panel.dataset.phase === phase && (phase === "closed" || panel.dataset.page === name)
      && !panel.getAnimations({ subtree: true }).some(animation => animation.playState === "running");
  }, { phase, name });
}
async function ready(context, viewport) {
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(preview.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#watch-status").hidden && !document.querySelector("#player-wrap").inert
    && document.querySelector("video").readyState >= 2, null, { timeout: 45000 });
  await page.evaluate(async () => {
    const video = document.querySelector("video"); video.pause();
    const frame = new Promise((resolveFrame, rejectFrame) => {
      const timeout = setTimeout(() => rejectFrame(new Error("Public 120 fps frame did not decode")), 15000);
      video.requestVideoFrameCallback(() => { clearTimeout(timeout); resolveFrame(); });
    });
    video.currentTime = 6; await frame;
  });
  await page.waitForFunction(() => !document.querySelector("#spinner").classList.contains("show")
    && Number(getComputedStyle(document.querySelector("#spinner")).opacity) < .01
    && Number(getComputedStyle(document.querySelector("#controls")).opacity) > .99);
  await painted(page);
  assert.deepEqual(page.viewportSize(), viewport);
  return page;
}
async function newContext(viewport, touch = false) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch });
  context.errors = [];
  context.network = [];
  context.consoleErrors = [];
  context.on("requestfailed", request => context.network.push({ url: request.url(), failure: request.failure()?.errorText }));
  context.on("response", response => { if (response.status() >= 400) context.network.push({ url: response.url(), status: response.status() }); });
  context.on("page", current => {
    current.on("pageerror", error => context.errors.push(error.message));
    current.on("console", message => { if (message.type() === "error") context.consoleErrors.push(message.text()); });
  });
  await context.addInitScript(() => {
    if (!/^https?:$/.test(location.protocol)) return;
    localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360, muted: true }));
    localStorage.setItem("aida-cc-banner-dismissed", "1");
  });
  await context.route("**/local/index.json", route => route.fulfill({ contentType: "application/json", body: JSON.stringify([
    { id: PUBLIC_VIDEO_ID, title: "ive got nuts of steel", duration: 25.963, frameRate: 120, visibility: "public" },
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sheet-${index}`, title: `Public motion study ${index + 1}`, duration: 12, frameRate: 120, visibility: "public" })),
  ]) }));
  await context.route("**/local/sheet-*/*", route => route.fulfill({ contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="405"><path fill="#23372e" d="M0 0h720v405H0z"/></svg>' }));
  return context;
}
async function beginTrace(current) {
  await current.evaluate(() => {
    window.__sheetFrames = [];
    window.__sheetTracing = true;
    const panel = document.querySelector("#settings-panel"), surface = document.querySelector("#settings-surface"), backdrop = document.querySelector("#menu-backdrop");
    function sample() {
      if (!window.__sheetTracing) return;
      if (!panel.hidden) {
        const style = getComputedStyle(panel), matrix = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
        const surfaceMatrix = new DOMMatrixReadOnly(getComputedStyle(surface).transform === "none" ? undefined : getComputedStyle(surface).transform);
        const backdropStyle = getComputedStyle(backdrop), rgba = backdropStyle.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
        const alpha = backdropStyle.backgroundColor === "transparent" ? 0 : rgba.length === 4 ? rgba[3] : 1;
        window.__sheetFrames.push({ time: performance.now(), phase: panel.dataset.phase, page: panel.dataset.page, inert: panel.inert,
          rect: panel.getBoundingClientRect().toJSON(), opacity: Number(style.opacity), x: matrix.m41, y: matrix.m42, a: matrix.m11, d: matrix.m22,
          surfaceA: surfaceMatrix.m11, surfaceD: surfaceMatrix.m22, backdropAlpha: alpha * Number(backdropStyle.opacity), backdropFilter: backdropStyle.backdropFilter,
          videoFilter: getComputedStyle(document.querySelector("video")).filter, videoOpacity: getComputedStyle(document.querySelector("video")).opacity,
          rootOverflow: getComputedStyle(document.documentElement).overflowY });
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
}
async function finishTrace(current) {
  return current.evaluate(() => { window.__sheetTracing = false; return window.__sheetFrames; });
}
function noScale(frames, label) {
  assert.ok(frames.length > 2, `${label}: capture real intermediate frames`);
  for (const frame of frames) for (const key of ["a", "d", "surfaceA", "surfaceD"]) assert.ok(Math.abs(frame[key] - 1) < .001, `${label}: live sheet text/controls must not scale (${key}=${frame[key]})`);
}
async function tap(current, cdp, selector) {
  await current.locator(selector).scrollIntoViewIfNeeded();
  const rect = await current.locator(selector).boundingBox();
  assert.ok(rect && rect.y >= 0 && rect.y + rect.height <= current.viewportSize().height + .1, `${selector} must be visible for native touch`);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }] });
  await current.waitForTimeout(100);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function headerDrag(current, cdp, distance, cancel = false) {
  const header = await current.locator(".settings-header").boundingBox();
  const point = { x: header.x + header.width / 2, y: header.y + 9 };
  const target = await current.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest("button")?.id ?? "header", point);
  assert.equal(target, "header", "The grab gesture must start on actual nonbutton header space");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await current.waitForTimeout(80);
  const scrollStart = await current.locator("#settings-body").evaluate(body => body.scrollTop);
  for (let step = 1; step <= 8; step++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y + distance * step / 8 }] });
    await current.waitForTimeout(20);
  }
  const held = await current.locator("#settings-panel").evaluate(panel => ({ y: new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42,
    height: panel.getBoundingClientRect().height, phase: panel.dataset.phase, scrollHeld: document.querySelector("#settings-body").scrollTop }));
  held.scrollStart = scrollStart;
  await cdp.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
  return held;
}
async function pixels(before, after) {
  const a = await sharp(before).removeAlpha().raw().toBuffer(), b = await sharp(after).removeAlpha().raw().toBuffer();
  assert.equal(a.length, b.length);
  let absolute = 0, darker = 0, changedPixels = 0, max = 0, averageBefore = 0;
  for (let i = 0; i < a.length; i += 3) {
    let changed = false;
    for (let channel = 0; channel < 3; channel++) {
      const delta = a[i + channel] - b[i + channel];
      absolute += Math.abs(delta); darker += delta; averageBefore += a[i + channel];
      max = Math.max(max, Math.abs(delta)); if (Math.abs(delta) > 2) changed = true;
    }
    if (changed) changedPixels++;
  }
  return { meanDifference: absolute / a.length, meanDarker: darker / a.length, changedPixels, max, averageBefore: averageBefore / a.length };
}
async function desktop() {
  const context = await newContext({ width: 1440, height: 1000 });
  const current = await ready(context, { width: 1440, height: 1000 });
  const rect = await current.locator("video").boundingBox();
  const clip = { x: Math.floor(rect.x + rect.width * .12), y: Math.floor(rect.y + rect.height * .24),
    width: Math.floor(rect.width * .22), height: Math.floor(rect.height * .28) };
  const before = await current.screenshot({ clip, path: `${artifacts}/desktop-before.png` });
  await beginTrace(current);
  await current.locator("#settings-btn").click();
  await current.waitForTimeout(50);
  const entry = await current.screenshot({ clip, path: `${artifacts}/desktop-entry-crop.png` });
  await settled(current);
  const after = await current.screenshot({ clip, path: `${artifacts}/desktop-open-crop.png` });
  report.desktop = { clip, paint: await pixels(before, after), entryPaint: await pixels(before, entry), backdrop: await current.locator("#menu-backdrop").evaluate(element => ({
    background: getComputedStyle(element).backgroundColor, opacity: getComputedStyle(element).opacity })) };
  await current.screenshot({ path: `${artifacts}/desktop-settings.png` });
  console.log(`Desktop paused-video paint: ${JSON.stringify(report.desktop)}`);
  assert.ok(report.desktop.paint.averageBefore > 10, "The test crop needs real lit video pixels");
  assert.ok(report.desktop.paint.meanDifference < .25 && report.desktop.paint.changedPixels === 0, "Desktop Settings must never dim the video outside its own surface");
  assert.equal(report.desktop.entryPaint.changedPixels, 0, "Desktop video must remain undimmed during entrance");
  await current.locator("#quality-btn").click(); await settled(current, "open", "quality");
  await current.screenshot({ path: `${artifacts}/desktop-quality.png` });
  await current.locator("#settings-back").click(); await settled(current);
  const video = await current.locator("video").boundingBox();
  await current.mouse.click(video.x + video.width * .2, video.y + video.height * .5);
  await current.waitForTimeout(50);
  const exit = await current.screenshot({ clip, path: `${artifacts}/desktop-exit-crop.png` });
  await settled(current, "closed");
  report.desktop.exitPaint = await pixels(before, exit);
  report.desktop.frames = await finishTrace(current);
  assert.equal(report.desktop.exitPaint.changedPixels, 0, "Desktop video must remain undimmed during exit");
  assert.ok(report.desktop.frames.some(frame => frame.phase === "opening" && frame.opacity > 0 && frame.opacity < 1));
  assert.ok(report.desktop.frames.some(frame => frame.phase === "closing" && frame.inert));
  for (const frame of report.desktop.frames) {
    assert.equal(frame.backdropAlpha, 0, "Desktop backdrop must never paint darkness, including interrupted entry/exit");
    assert.equal(frame.backdropFilter, "none");
    assert.equal(frame.videoFilter, "none"); assert.equal(frame.videoOpacity, "1");
  }
  noScale(report.desktop.frames, "desktop popup");
  assert.equal(await current.evaluate(() => document.querySelector("video").paused), true, "Outside dismissal must not activate the video");
  assert.equal(await current.evaluate(() => document.activeElement.id), "settings-btn");
  assert.deepEqual(context.errors, []);
  report.desktop.passed = true;
  await context.close(); page = null;
  console.log("PASS desktop: unchanged paused-video pixels during entry/open/exit, no dim layer, outside dismissal and focus");
}

async function geometry(current, insets = { top: 0, right: 0, bottom: 0, left: 0 }) {
  const value = await current.evaluate(() => {
    const panel = document.querySelector("#settings-panel"), surface = document.querySelector("#settings-surface"), header = document.querySelector(".settings-header");
    const style = getComputedStyle(panel), padding = getComputedStyle(surface), box = panel.getBoundingClientRect(), backdrop = getComputedStyle(document.querySelector("#menu-backdrop"));
    return { rect: box.toJSON(), viewport: { width: visualViewport.width, height: visualViewport.height, y: visualViewport.offsetTop },
      radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius],
      padding: { left: Number.parseFloat(padding.paddingLeft), right: Number.parseFloat(padding.paddingRight), bottom: Number.parseFloat(padding.paddingBottom) },
      header: header.getBoundingClientRect().toJSON(), close: document.querySelector("#settings-close").getBoundingClientRect().toJSON(),
      backdrop: backdrop.backgroundColor, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
  });
  assert.ok(Math.abs(value.rect.x) < .1 && Math.abs(value.rect.width - value.viewport.width) < .1, "Phone sheet must attach to both viewport edges");
  assert.ok(Math.abs(value.rect.bottom - value.viewport.y - value.viewport.height) < .1, "Phone sheet background must attach to the physical bottom, including safe area");
  assert.deepEqual(value.radii, ["20px", "20px", "0px", "0px"]);
  assert.equal(value.header.height, 64);
  for (const edge of ["left", "right", "bottom"]) assert.ok(value.padding[edge] >= insets[edge] - .1, `Safe ${edge} inset belongs inside the painted sheet`);
  assert.ok(value.close.x >= insets.left && value.close.right <= value.viewport.width - insets.right + .1);
  assert.ok(value.close.width >= 44 && value.close.height >= 44);
  assert.ok(value.scrollWidth <= value.clientWidth + 1, "Edge-to-edge sheet must not introduce horizontal page overflow");
  assert.equal(value.backdrop, "rgba(0, 0, 0, 0.6)", "Phone backdrop should use the darker requested surface");
  return value;
}
async function mobile(viewport) {
  const context = await newContext(viewport, true);
  const current = await ready(context, viewport), cdp = await context.newCDPSession(current);
  const result = { viewport }; report.mobile.push(result);
  await current.locator("#settings-btn").scrollIntoViewIfNeeded();
  const root = await current.evaluate(() => scrollY);
  await beginTrace(current); await tap(current, cdp, "#settings-btn"); await settled(current);
  result.entry = await finishTrace(current); result.home = await geometry(current);
  noScale(result.entry, `${viewport.width}px entry`);
  const entering = result.entry.filter(frame => frame.phase === "opening");
  assert.ok(entering.some(frame => frame.y > frame.rect.height * .7), "Phone entrance must originate below the viewport by the full sheet height, not a floating16px nudge");
  assert.ok(entering.some(frame => frame.y > 2 && frame.y < frame.rect.height * .7), "Phone entrance needs actual intermediate sliding frames");
  assert.ok(entering.some(frame => frame.backdropAlpha > 0 && frame.backdropAlpha < .59), "The first phone backdrop must visibly interpolate from transparent, without jumping to full dim");
  await current.screenshot({ path: `${artifacts}/mobile-${viewport.width}-home.png` });
  await tap(current, cdp, "#quality-btn"); await settled(current, "open", "quality");
  await geometry(current); await current.screenshot({ path: `${artifacts}/mobile-${viewport.width}-quality.png` });
  await current.locator("#quality-menu").evaluate(group => {
    for (let index = 0; index < 14; index++) {
      const row = document.createElement("button"); row.type = "button"; row.className = "menu-item sheet-overflow-fixture";
      row.textContent = `Public geometry fixture ${index + 1}`; group.append(row);
    }
  });
  await painted(current);
  assert.equal(await current.locator("#settings-body").evaluate(body => body.scrollHeight > body.clientHeight + 10), true);
  const body = await current.locator("#settings-body").boundingBox();
  const x = body.x + body.width * .55, start = body.y + body.height * .8, end = body.y + body.height * .25;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: start }] });
  await current.waitForTimeout(60);
  for (let step = 1; step <= 8; step++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: start + (end - start) * step / 8 }] }); await current.waitForTimeout(20); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await current.waitForFunction(() => document.querySelector("#settings-body").scrollTop > 10);
  assert.equal(await current.evaluate(() => scrollY), root, "Native sheet scrolling must not pan the background");
  await current.locator("#settings-back").evaluate(button => button.focus({ preventScroll: true }));
  result.canceledDrag = await headerDrag(current, cdp, 60, true);
  assert.ok(result.canceledDrag.y > 20, "The actual header drag must move the sheet under the finger");
  assert.ok(result.canceledDrag.scrollStart > 10, "Cancel must be tested after real native body scrolling");
  await settled(current, "open", "quality");
  const restoredScroll = await current.locator("#settings-body").evaluate(body => body.scrollTop);
  assert.ok(Math.abs(restoredScroll - result.canceledDrag.scrollStart) < 1, "Canceling a settled header drag must preserve the native body scroll position");
  assert.equal(await current.evaluate(() => document.activeElement.id), "settings-back", "Canceling the header drag must preserve menu focus");
  await tap(current, cdp, "#settings-back"); await settled(current);
  await current.locator(".sheet-overflow-fixture").evaluateAll(rows => rows.forEach(row => row.remove()));
  assert.equal(await current.evaluate(() => document.activeElement.id), "quality-btn");
  await geometry(current);
  await beginTrace(current);
  result.heldDismiss = await headerDrag(current, cdp, result.home.rect.height * .65);
  assert.ok(result.heldDismiss.y > 20);
  const releasing = await current.locator("#settings-panel").evaluate(panel => ({ inert: panel.inert, phase: panel.dataset.phase }));
  assert.equal(releasing.inert, true, "A released dismiss gesture must disable its controls immediately");
  await settled(current, "closed"); result.exit = await finishTrace(current);
  noScale(result.exit, `${viewport.width}px gesture exit`);
  assert.ok(result.exit.some(frame => frame.phase === "closing" && frame.y >= frame.rect.height * .8), "Phone dismissal must continue below the viewport");
  for (const frame of result.exit.filter(frame => frame.phase === "closing")) assert.equal(frame.rootOverflow, "hidden", "Root scrolling stays locked through the exit");
  assert.equal(await current.evaluate(() => scrollY), root);
  assert.equal(await current.evaluate(() => document.activeElement.id), "settings-btn");
  await tap(current, cdp, "#settings-btn");
  await current.waitForFunction(() => {
    const panel = document.querySelector("#settings-panel"), rect = document.querySelector("#settings-close").getBoundingClientRect();
    return panel.dataset.phase === "opening" && rect.top > 0 && rect.bottom < innerHeight - 1;
  });
  const press = await current.locator("#settings-close").boundingBox();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: press.x + press.width / 2, y: press.y + press.height / 2 }] });
  const heldStart = await current.locator("#settings-close").boundingBox();
  await current.waitForTimeout(100);
  const heldEnd = await current.locator("#settings-close").boundingBox();
  for (const axis of ["x", "y", "width", "height"]) assert.ok(Math.abs(heldEnd[axis] - heldStart[axis]) <= .25, `An entry-pressed control must stay under the finger (${axis})`);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await settled(current); await geometry(current);
  result.entryPress = { heldStart, heldEnd };
  await current.keyboard.press("Escape"); await settled(current, "closed");
  assert.equal(await current.evaluate(() => document.activeElement.id), "settings-btn");

  const insets = viewport.width > viewport.height ? { top: 0, right: 44, bottom: 21, left: 44 } : { top: 24, right: 0, bottom: 34, left: 0 };
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
  result.safeReadback = await current.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    document.body.append(probe); const style = getComputedStyle(probe);
    const actual = { top: Number.parseFloat(style.paddingTop), right: Number.parseFloat(style.paddingRight), bottom: Number.parseFloat(style.paddingBottom), left: Number.parseFloat(style.paddingLeft) };
    probe.remove(); return actual;
  });
  assert.deepEqual(result.safeReadback, insets, "Safe-area emulation must actually reach CSS env() before geometry is claimed");
  await tap(current, cdp, "#settings-btn"); await settled(current); result.safeGeometry = await geometry(current, insets);
  await current.screenshot({ path: `${artifacts}/mobile-${viewport.width}-safe-area.png` });
  await tap(current, cdp, "#quality-btn");
  const resized = { width: viewport.width, height: viewport.height - 60 };
  await current.setViewportSize(resized);
  await settled(current, "open", "quality");
  result.resizedGeometry = await geometry(current, insets);
  await tap(current, cdp, "#settings-close"); await settled(current, "closed");
  assert.equal(await current.evaluate(() => document.querySelector("video").paused), true);
  assert.equal(await current.evaluate(() => document.activeElement.id), "settings-btn");
  assert.deepEqual(context.errors, []); result.passed = true;
  await context.close(); page = null;
  console.log(`PASS ${viewport.width}×${viewport.height}: edge sheet, full-height motion, native scroll/drag/cancel/dismiss, safe areas and focus`);
}

try {
  browser = await chromium.launch({ executablePath, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  if (!mobileOnly) await desktop();
  if (!baseline) for (const viewport of [{ width: 360, height: 800 }, { width: 424, height: 924 }, { width: 844, height: 390 }]) await mobile(viewport);
} catch (error) {
  report.failure = error.message;
  if (page && !page.isClosed()) {
    report.failureState = await page.evaluate(() => ({ url: location.href, status: document.querySelector("#watch-status")?.textContent,
      title: document.querySelector("#watch-title")?.textContent, shaka: typeof window.shaka, ready: document.querySelector("video")?.readyState,
      inert: document.querySelector("#player-wrap")?.inert, settings: (() => { const panel = document.querySelector("#settings-panel"); return panel && {
        phase: panel.dataset.phase, page: panel.dataset.page, hidden: panel.hidden, inert: panel.inert, transform: getComputedStyle(panel).transform,
        rect: panel.getBoundingClientRect().toJSON() }; })(),
      requests: performance.getEntriesByType("resource").map(resource => ({ name: resource.name, duration: resource.duration, status: resource.responseStatus })) }));
    report.failureState.errors = page.context().errors;
    report.failureState.network = page.context().network;
    report.failureState.consoleErrors = page.context().consoleErrors;
    console.log(`Failure diagnostics: ${JSON.stringify(report.failureState)}`);
    await page.screenshot({ path: `${artifacts}/failure.png` });
  }
  throw error;
} finally {
  await writeFile(`${artifacts}/results.json`, JSON.stringify(report, null, 2));
  await browser?.close(); await preview.close();
}
