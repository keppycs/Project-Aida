import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { PUBLIC_VIDEO_ID, startPlayerPreview } from "./support/player-preview.mjs";

const require = createRequire(import.meta.url);
const modules = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || `${modules}/playwright`);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = process.env.AIDA_REVIEW_DIR || `C:/Users/keppy/AppData/Local/Temp/codex-work/aida-settings-performance-${Date.now()}`;
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const preview = await startPlayerPreview();
const browser = await chromium.launch({ executablePath, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const report = { errors: [], transitions: [] };
let page;
console.log(`Settings performance artifacts: ${artifacts}`);

function cadence(frames) {
  const gaps = frames.slice(1).map((time, index) => time - frames[index]).sort((a, b) => a - b);
  return { samples: gaps.length, medianMs: gaps[Math.floor(gaps.length * .5)] || 0, p95Ms: gaps[Math.floor(gaps.length * .95)] || 0, maxMs: gaps.at(-1) || 0 };
}

try {
  const context = await browser.newContext({ viewport: { width: 424, height: 900 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360, muted: true }));
    localStorage.setItem("aida-cc-banner-dismissed", "1");
  });
  await context.route("**/local/index.json", route => route.fulfill({ contentType: "application/json", body: JSON.stringify([
    { id: PUBLIC_VIDEO_ID, title: "Public 120 fps fixture", visibility: "public" },
    { id: "public-performance-card", title: "Public recommendation fixture", visibility: "public", frameRate: 120 },
  ]) }));
  await context.route("**/local/public-performance-card/*", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="405"><path fill="#586b60" d="M0 0h720v405H0z"/></svg>' }));
  page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.goto(preview.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#watch-stage").getAttribute("aria-busy") === "false" && document.querySelector("video").readyState >= 2);
  const cdp = await context.newCDPSession(page);
  const tap = async (selector, movingUp = false) => {
    const bounds = await page.locator(selector).boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 900, `${selector} must be reachable by actual touch`);
    // Aim into the leading edge of an ascending header: its previous-frame
    // center can move onto a different row before native CDP dispatch arrives.
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + (movingUp ? 2 : bounds.height / 2) }] });
    if (movingUp) {
      const target = await page.evaluate(() => window.__menuInput?.findLast(event => event.type === "pointerdown")?.button);
      if (target !== selector.slice(1)) await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      assert.equal(target, selector.slice(1), "The native press must actually begin on the intended moving control");
    }
    await page.waitForTimeout(100);
    if (movingUp) {
      const hold = await page.evaluate(() => ({
        initial: window.__menuInput.findLast(event => event.type === "pointerdown").back,
        held: document.querySelector("#settings-back").getBoundingClientRect().toJSON(),
      }));
      const drift = Math.max(...["x", "y", "width", "height"].map(key => Math.abs(hold.held[key] - hold.initial[key])));
      (report.heldPresses ??= []).push({ selector, ...hold, maxDriftCssPx: drift });
      if (drift > .25) await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      assert.ok(drift <= .25, `Back moved ${drift}px during a native100ms hold; its geometry must remain under the finger`);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const settled = async (name = "home") => page.waitForFunction(name => {
    const panel = document.querySelector("#settings-panel");
    return panel.dataset.phase === "open" && panel.dataset.page === name && !panel.getAnimations({ subtree: true }).some(animation => animation.playState === "running");
  }, name, { timeout: 5000 });
  await page.evaluate(() => { document.querySelector("video").pause(); document.querySelector("video").currentTime = 6; });
  await tap("#settings-btn");
  await settled();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  // Isolate the menu's cost while paused: the playing seek fill already creates
  // per-frame layout work, so total playing-page Layout counts cannot isolate this regression.
  for (const [name, selector, destination] of process.env.AIDA_FUNCTIONAL_ONLY ? [] : [
    ["speed", "#speed-btn", "speed"], ["speed-back", "#settings-back", "home"],
    ["quality", "#quality-btn", "quality"], ["quality-back", "#settings-back", "home"],
  ]) {
    const events = [];
    const collect = ({ value }) => events.push(...value);
    cdp.on("Tracing.dataCollected", collect);
    await cdp.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.frame", transferMode: "ReportEvents" });
    await page.evaluate(() => {
      window.__menuFrames = [];
      window.__menuSampling = true;
      const frame = now => { window.__menuFrames.push(now); if (window.__menuSampling) requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    });
    await tap(selector);
    await page.waitForTimeout(45);
    const intermediate = await page.locator("#settings-panel").evaluate(panel => panel.getAnimations({ subtree: true })
      .filter(animation => animation.playState === "running")
      .map(animation => ({ target: animation.effect.target.id, progress: animation.effect.getComputedTiming().progress,
        properties: [...new Set(animation.effect.getKeyframes().flatMap(frame => Object.keys(frame).filter(key => !["offset", "computedOffset", "easing", "composite"].includes(key))))] })));
    await settled(destination);
    const frames = await page.evaluate(() => { window.__menuSampling = false; return window.__menuFrames; });
    const complete = new Promise(resolveDone => cdp.once("Tracing.tracingComplete", resolveDone));
    await cdp.send("Tracing.end");
    await complete;
    cdp.off("Tracing.dataCollected", collect);
    await writeFile(`${artifacts}/${name}-trace.json`, JSON.stringify({ traceEvents: events }));
    const summary = { name, intermediate, cadence: cadence(frames), events: {} };
    for (const kind of ["Layout", "Paint", "UpdateLayoutTree"]) {
      const matching = events.filter(event => event.name === kind && event.ph === "X");
      summary.events[kind] = { count: matching.length, durationMs: matching.reduce((total, event) => total + (event.dur || 0), 0) / 1000 };
    }
    report.transitions.push(summary);
    await writeFile(`${artifacts}/results.json`, JSON.stringify(report, null, 2));
    assert.ok(intermediate.some(animation => animation.progress > 0 && animation.progress < 1 && animation.properties.includes("transform")), `${name} must have a real intermediate transform frame`);
    for (const animation of intermediate) assert.ok(animation.properties.every(property => ["transform", "opacity", "backgroundColor", "color"].includes(property)), `${name} must not animate layout geometry: ${animation.properties}`);
    assert.ok(summary.events.Layout.count <= 10, `${name} caused ${summary.events.Layout.count} Layout events; menu motion must not relayout each frame`);
    assert.ok(summary.cadence.samples >= 5 && summary.cadence.maxMs < 150, `${name} stalled the test renderer; this is a responsiveness guard, not a physical-phone FPS assertion`);
    console.log(`${name}: ${summary.events.Layout.count} Layout events, ${summary.events.Paint.count} Paint events`);
  }

  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await page.evaluate(() => {
    window.__menuInput = [];
    for (const type of ["pointerdown", "pointerup", "pointercancel", "click"]) document.addEventListener(type, event => {
      const back = document.querySelector("#settings-back");
      window.__menuInput.push({ type, at: performance.now(), target: event.target.id, button: event.target.closest("button")?.id,
        text: event.target.closest("button")?.textContent.trim().slice(0, 50), speed: event.target.closest("button")?.dataset.speed,
        x: event.clientX, y: event.clientY, back: back.getBoundingClientRect().toJSON(), page: document.querySelector("#settings-panel").dataset.page });
    }, true);
  });
  await tap("#settings-close");
  await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
  await tap("#big-play");
  await page.waitForFunction(() => !document.querySelector("video").paused);
  await tap("#settings-btn");
  await settled();
  const idleEvents = [];
  const collectIdle = ({ value }) => idleEvents.push(...value);
  cdp.on("Tracing.dataCollected", collectIdle);
  await cdp.send("Tracing.start", { categories: "devtools.timeline", transferMode: "ReportEvents" });
  await page.waitForTimeout(400);
  const idleComplete = new Promise(resolveDone => cdp.once("Tracing.tracingComplete", resolveDone));
  await cdp.send("Tracing.end");
  await idleComplete;
  cdp.off("Tracing.dataCollected", collectIdle);
  await writeFile(`${artifacts}/playing-menu-idle-trace.json`, JSON.stringify({ traceEvents: idleEvents }));
  report.playingMenuIdle = { layoutCount: idleEvents.filter(event => event.name === "Layout" && event.ph === "X").length,
    paintCount: idleEvents.filter(event => event.name === "Paint" && event.ph === "X").length };
  assert.ok(report.playingMenuIdle.layoutCount <= 10, "The obscured timeline must not create layout every video/display frame behind open Settings");
  const initialTime = await page.locator("video").evaluate(video => video.currentTime);
  await tap("#speed-btn");
  await page.waitForTimeout(25);
  assert.ok(await page.locator("#settings-panel").evaluate(panel => panel.getAnimations({ subtree: true }).some(animation => animation.playState === "running")), "Back must interrupt active submenu motion");
  await tap("#settings-back", true);
  await settled();
  assert.equal(await page.evaluate(() => document.activeElement.id), "speed-btn");
  await tap("#quality-btn");
  await page.waitForTimeout(25);
  await tap("#settings-back", true);
  await settled();
  assert.equal(await page.evaluate(() => document.activeElement.id), "quality-btn");
  await tap("#quality-btn");
  await page.waitForTimeout(100);
  assert.ok(await page.locator("#settings-panel").evaluate(panel => panel.getAnimations({ subtree: true }).some(animation => animation.playState === "running")), "Cancellation must interrupt live motion");
  const cancelTarget = await page.locator("#settings-back").boundingBox();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cancelTarget.x + cancelTarget.width / 2, y: cancelTarget.y + 2 }] });
  assert.equal(await page.evaluate(() => window.__menuInput.findLast(event => event.type === "pointerdown").button), "settings-back");
  await page.waitForTimeout(60);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await page.waitForFunction(() => {
    const surface = document.querySelector("#settings-surface");
    return Math.abs(new DOMMatrixReadOnly(getComputedStyle(surface).transform).m42) < .1;
  }, null, { timeout: 5000 });
  await settled("quality");
  assert.equal(await page.locator("video").evaluate(video => video.playbackRate), 1, "A canceled Back press must not activate a speed choice");
  await tap("#settings-back");
  await settled();
  assert.equal(await page.locator("video").evaluate(video => video.paused), false);
  assert.ok(await page.locator("video").evaluate(video => video.currentTime) > initialTime + .25, "Public120fps playback must continue during menu navigation");
  await tap("#speed-btn");
  await settled("speed");
  await tap('#speed-menu [data-speed="1.25"]');
  await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
  assert.equal(await page.locator("video").evaluate(video => video.playbackRate), 1.25);
  assert.equal(await page.evaluate(() => document.activeElement.id), "settings-btn");
  await tap("#settings-btn");
  await settled();
  assert.equal(await page.locator("#speed-label").textContent(), "1.25×");
  await tap("#quality-btn");
  await settled("quality");
  await page.screenshot({ path: `${artifacts}/mobile-quality-settled.png` });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
  assert.deepEqual(report.errors, []);
  report.playingInteractions = "Native touch interrupted Speed/Quality/Back, canceled press recovery, speed selection, continued playback and focus restoration passed";
  report.passed = true;
  console.log(`PASS: playing menu idle ${report.playingMenuIdle.layoutCount} Layout events; native interruption, values and focus passed`);
  await context.close();
} catch (error) {
  report.failure = error.message;
  if (page && !page.isClosed()) {
    report.input = await page.evaluate(() => window.__menuInput ?? []);
    report.failureState = await page.locator("#settings-panel").evaluate(panel => ({ page: panel.dataset.page, phase: panel.dataset.phase,
      playbackRate: document.querySelector("video").playbackRate,
      panel: panel.getBoundingClientRect().toJSON(), surface: document.querySelector("#settings-surface")?.getBoundingClientRect().toJSON() }));
    await page.screenshot({ path: `${artifacts}/failure.png` });
  }
  throw error;
} finally {
  await writeFile(`${artifacts}/results.json`, JSON.stringify(report, null, 2));
  await browser.close();
  await preview.close();
}
