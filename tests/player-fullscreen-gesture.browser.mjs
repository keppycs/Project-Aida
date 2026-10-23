import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { startPlayerPreview } from "./support/player-preview.mjs";

const require = createRequire(import.meta.url);
const modules = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || `${modules}/playwright`);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = process.env.AIDA_REVIEW_DIR || `C:/Users/keppy/AppData/Local/Temp/codex-work/aida-fullscreen-gesture-${Date.now()}`;
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const preview = await startPlayerPreview();
const report = { cases: [], errors: [] };
let browser;
console.log(`Fullscreen gesture artifacts: ${artifacts}`);

try {
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 424, height: 924 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  await context.addInitScript(() => {
    if (!/^https?:$/.test(location.protocol)) return;
    localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360, muted: true }));
    localStorage.setItem("aida-cc-banner-dismissed", "1");
    window.__fullscreenGestureEvents = [];
    for (const type of ["pointerdown", "pointerup", "pointercancel", "click"]) document.addEventListener(type, event => {
      window.__fullscreenGestureEvents.push({ type, pointerId: event.pointerId, pointerType: event.pointerType,
        target: event.target.closest("button")?.id || event.target.id || event.target.localName, x: event.clientX, y: event.clientY,
        fullscreen: document.fullscreenElement?.id, bigPlayInert: document.querySelector("#big-play")?.inert,
        phase: document.querySelector("#settings-panel")?.dataset.phase });
    }, true);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => report.errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await page.goto(preview.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#watch-status").hidden && !document.querySelector("#player-wrap").inert
    && document.querySelector("video").readyState >= 2, null, { timeout: 45000 });
  await page.evaluate(() => {
    document.querySelector("video").pause();
    window.__swipePlayback = { play: 0, pause: 0, seeked: 0 };
    for (const type of Object.keys(window.__swipePlayback)) document.querySelector("video").addEventListener(type, () => window.__swipePlayback[type]++);
  });

  const point = async (selector, x = .5, y = .5) => {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box, `${selector} needs a painted hit target`);
    return { x: box.x + box.width * x, y: box.y + box.height * y };
  };
  const fullscreen = () => page.evaluate(() => document.fullscreenElement?.id || null);
  const settled = (phase = "open", name = "home") => page.waitForFunction(({ phase, name }) => {
    const panel = document.querySelector("#settings-panel");
    return panel.dataset.phase === phase && (phase === "closed" || panel.dataset.page === name)
      && !panel.getAnimations({ subtree: true }).some(animation => animation.playState === "running");
  }, { phase, name });
  async function enter() {
    await page.locator("#fs-btn").tap();
    await page.waitForFunction(() => document.fullscreenElement?.id === "player-wrap"
      && document.querySelector("#player-wrap").classList.contains("fullscreen"));
    await page.waitForTimeout(100);
    assert.equal(await page.locator("video").evaluate(video => getComputedStyle(video).touchAction), "none", "Only fullscreen media reserves the swipe");
  }
  async function drag(start, dx, dy, { cancel = false, multi = false } = {}) {
    const points = fraction => [{ x: start.x + dx * fraction, y: start.y + dy * fraction, id: 11 },
      ...(multi ? [{ x: start.x + 32 + dx * fraction, y: start.y + dy * fraction, id: 22 }] : [])];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(0) });
    for (let step = 1; step <= 8; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(step / 8) });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
    await page.waitForTimeout(100);
  }
  async function unchanged(name, start, dx, dy, options = {}) {
    const before = await page.evaluate(() => ({ paused: document.querySelector("video").paused, counts: { ...window.__swipePlayback } }));
    await drag(start, dx, dy, options);
    assert.equal(await fullscreen(), "player-wrap", `${name} must not exit fullscreen`);
    assert.equal(await page.locator("video").evaluate(video => video.paused), before.paused, `${name} must not toggle playback`);
    assert.deepEqual(await page.evaluate(() => window.__swipePlayback), before.counts, `${name} must not seek or toggle playback`);
    report.cases.push({ name, passed: true });
  }

  assert.notEqual(await page.locator("video").evaluate(video => getComputedStyle(video).touchAction), "none", "Inline video must retain native page scrolling");
  await page.locator("#big-play").tap();
  await page.waitForFunction(() => !document.querySelector("video").paused);
  await page.waitForTimeout(100);
  assert.equal(await page.locator("video").evaluate(video => video.paused), false, "Inline center touch must toggle once, without a duplicate native click");
  await page.locator("#big-play").tap();
  await page.waitForFunction(() => document.querySelector("video").paused);
  report.cases.push({ name: "inline center touch toggles once", passed: true });
  await enter();
  const surface = await point("video", .2, .3);
  await unchanged("short downward movement", surface, 0, 30);
  // The video element now fits the picture, so a fixed +120px offset can land
  // on the relocated seek target. Start this picture gesture on bare video.
  const upwardStart = await point("video", .2, .6);
  assert.equal(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.id, upwardStart), "video");
  await unchanged("upward movement", upwardStart, 0, -110);
  await unchanged("horizontal movement", surface, 130, 20);
  await unchanged("diagonal movement without vertical dominance", surface, 95, 100);
  await unchanged("cancelled downward swipe", surface, 0, 130, { cancel: true });
  await unchanged("multiple fingers", surface, 0, 130, { multi: true });
  await unchanged("center control horizontal drag", await point("#big-play"), 110, 0);
  await unchanged("center control cancelled swipe", await point("#big-play"), 0, 130, { cancel: true });
  await unchanged("center control multiple fingers", await point("#big-play"), 0, 130, { multi: true });
  await unchanged("center release just beyond control edge", await point("#big-play", .98), 10, 0);
  await unchanged("fullscreen utility button drag", await point("#fs-btn"), 0, -130);

  // Sliders own their pointer sequence; vertical movement on them is never an
  // instruction to leave fullscreen, regardless of the player's gesture.
  await drag(await point("#progress-wrap", .3), 0, -130);
  assert.equal(await fullscreen(), "player-wrap", "Seekbar gestures must not exit fullscreen");
  assert.equal(await page.locator("video").evaluate(video => video.paused), true);
  report.cases.push({ name: "seekbar excluded", passed: true });

  await page.locator("#settings-btn").tap(); await settled();
  await drag(await point(".settings-header", .5, .4), 0, 150);
  await settled("closed");
  assert.equal(await fullscreen(), "player-wrap", "Sheet dismissal must not dismiss fullscreen");
  assert.equal(await page.locator("video").evaluate(video => video.paused), true);
  report.cases.push({ name: "Settings drag belongs only to the sheet", passed: true });

  // The public SDR fixture hides Color correction by product policy. Expose the
  // real mounted controls here solely to test their native slider ownership.
  await page.locator("#cc-wrap").evaluate(element => { element.style.display = ""; });
  await page.locator("#settings-btn").tap(); await settled();
  await page.locator("#cc-btn").tap(); await settled("open", "cc");
  await drag(await point("#cc-brightness"), 0, 90);
  assert.equal(await fullscreen(), "player-wrap", "Settings slider gesture must not exit fullscreen");
  assert.equal(await page.locator("#settings-panel").getAttribute("data-page"), "cc");
  await page.locator("#settings-close").tap(); await settled("closed");
  report.cases.push({ name: "Settings slider excluded", passed: true });

  await drag(await point("#big-play"), 0, 130);
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.locator("video").evaluate(video => video.paused), true, "Center swipe compatibility click must not toggle playback");
  report.cases.push({ name: "center control swipe exits without playback toggle", passed: true });

  // The suppression belongs to the completed gesture, never a subsequent tap.
  await page.locator("#big-play").tap();
  await page.waitForFunction(() => !document.querySelector("video").paused);
  await page.locator("#big-play").tap();
  await page.waitForFunction(() => document.querySelector("video").paused);
  report.cases.push({ name: "next tap remains immediate", passed: true });

  await enter();
  await drag(await point("video", .2, .3), 0, 130);
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.locator("video").evaluate(video => video.paused), true);
  report.cases.push({ name: "bare video swipe exits", passed: true });

  await enter();
  const race = await point("video", .2, .3);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...race, id: 11 }] });
  await page.evaluate(() => document.exitFullscreen());
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: race.x, y: race.y + 130, id: 11 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(100);
  assert.equal(await fullscreen(), null, "Fullscreen exit racing the gesture must never re-enter");
  report.cases.push({ name: "fullscreen change during gesture", passed: true });

  await enter();
  const pen = await point("video", .2, .3);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...pen, button: "left", buttons: 1, clickCount: 1, pointerType: "pen" });
  for (let step = 1; step <= 8; step++) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pen.x, y: pen.y + 130 * step / 8, button: "left", buttons: 1, pointerType: "pen" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pen.x, y: pen.y + 130, button: "left", buttons: 0, clickCount: 1, pointerType: "pen" });
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.locator("video").evaluate(video => video.paused), true, "Pen compatibility click must not toggle playback");
  report.cases.push({ name: "primary pen swipe exits", passed: true });

  await page.screenshot({ path: `${artifacts}/fullscreen-return.png` });
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(`PASS ${report.cases.length} native fullscreen gesture cases`);
} catch (error) {
  report.failure = error.message;
  const current = browser?.contexts()[0]?.pages()[0];
  if (current) {
    report.inputHistory = await current.evaluate(() => window.__fullscreenGestureEvents);
    await current.screenshot({ path: `${artifacts}/failure.png` });
  }
  throw error;
} finally {
  await writeFile(`${artifacts}/results.json`, JSON.stringify(report, null, 2));
  await browser?.close();
  await preview.close();
}
