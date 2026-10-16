import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { startPlayerPreview } from "./support/player-preview.mjs";

const require = createRequire(import.meta.url);
const runtime = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || runtime);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = process.env.AIDA_REVIEW_DIR || `C:/Users/keppy/AppData/Local/Temp/codex-work/aida-progress-preview-${Date.now()}`;
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const preview = await startPlayerPreview();
const browser = await chromium.launch({ executablePath, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const results = [];
console.log(`Progress preview artifacts: ${artifacts}`);

async function seekFrame(page, time) {
  await page.evaluate(async time => {
    const video = document.querySelector("video");
    video.pause();
    const decoded = new Promise((resolveFrame, rejectFrame) => {
      const timeout = setTimeout(() => rejectFrame(new Error("Progress review frame did not decode")), 15000);
      video.requestVideoFrameCallback(() => { clearTimeout(timeout); resolveFrame(); });
    });
    video.currentTime = time;
    await decoded;
  }, time);
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector("#controls")).opacity) > .999 && Number(getComputedStyle(document.querySelector("#spinner")).opacity) < .001);
}

async function progressState(page) {
  return page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    const video = document.querySelector("video"), tooltip = document.querySelector("#time-tooltip");
    return {
      time: video.currentTime, duration: video.duration, paused: video.paused,
      dpr: devicePixelRatio,
      overlayPresent: !!document.querySelector("#progress-hover"),
      target: rect("#progress-wrap"), rail: rect("#progress-track"),
      fill: rect("#progress-fill"), buffer: rect("#progress-buffer"), thumb: rect("#progress-thumb"),
      tooltip: { text: tooltip.textContent, display: getComputedStyle(tooltip).display, opacity: Number(getComputedStyle(tooltip).opacity) },
      mobileLayout: document.querySelector("#player-wrap").classList.contains("is-mobile"),
    };
  });
}

function alignment(state, baseline) {
  const railCenter = state.rail.y + state.rail.height / 2;
  const thumbCenter = state.thumb.y + state.thumb.height / 2;
  assert.ok(Math.abs(thumbCenter - railCenter) <= .1, `Thumb is ${thumbCenter - railCenter}px below the rail center at DPR${state.dpr}`);
  assert.ok(Math.abs(state.target.height - 44) < .1, "Seek hit geometry must remain44px high");
  if (baseline) {
    const restingCenter = baseline.rail.y + baseline.rail.height / 2;
    assert.ok(Math.abs(railCenter - restingCenter) <= .1, "Rail center must not move when its height changes");
    assert.ok(Math.abs(thumbCenter - restingCenter) <= .1, "Thumb center must stay on the resting rail center");
    for (const dimension of ["x", "y", "width", "height"]) assert.ok(Math.abs(state.target[dimension] - baseline.target[dimension]) < .1, `Seek target ${dimension} changed`);
  }
}

async function transitionSamples(page, action, baseline, expectHeightAnimation = false) {
  await page.evaluate(() => {
    window.__railSamples = new Promise(resolveSamples => {
      const started = performance.now(), samples = [];
      const sample = () => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        samples.push({ at: performance.now() - started, dpr: devicePixelRatio, target: rect("#progress-wrap"), rail: rect("#progress-track"), thumb: rect("#progress-thumb") });
        if (performance.now() - started < 220) requestAnimationFrame(sample);
        else resolveSamples(samples);
      };
      sample();
    });
  });
  await action();
  const samples = await page.evaluate(() => window.__railSamples);
  for (const sample of samples) alignment(sample, baseline);
  if (expectHeightAnimation) assert.ok(samples.some(sample => sample.rail.height > 3.05 && sample.rail.height < 4.95), "Must sample an actual intermediate rail-height frame");
  return samples;
}

async function closeup(page, path) {
  const clip = await page.locator("#progress-thumb").evaluate(thumb => {
    const player = document.querySelector("#player-wrap").getBoundingClientRect(), target = document.querySelector("#progress-wrap").getBoundingClientRect(), rect = thumb.getBoundingClientRect();
    const x = Math.max(player.left, rect.x + rect.width / 2 - 150), y = Math.max(player.top, target.top - 35);
    return { x, y, width: Math.min(300, player.right - x), height: Math.min(100, player.bottom - y) };
  });
  await page.screenshot({ path, clip });
}

function geometry(state) {
  alignment(state);
  assert.equal(state.overlayPresent, false, "Decorative progress-hover overlay must remain absent");
  assert.ok(Math.abs(state.target.height - 44) < .1, "Seek hit target must remain44px high");
  assert.ok(state.rail.height >= 2.9 && state.rail.height <= 5.1, "Visible rail must retain its existing resting/hover geometry");
  assert.ok(Math.abs(state.fill.height - state.rail.height) < .1);
  assert.ok(Math.abs(state.fill.left - state.rail.left) < .1);
  assert.ok(Math.abs(state.fill.width / state.rail.width - state.time / state.duration) < .002, "Played fill must represent actual currentTime");
  assert.ok(Math.abs(state.thumb.x + state.thumb.width / 2 - state.fill.right) < 1, "Thumb must remain aligned with the played fill");
  assert.ok(state.buffer.width > 0 && state.buffer.width <= state.rail.width + 1, "Buffered progress must remain present within the rail");
  assert.ok(Math.abs(state.buffer.left - state.rail.left) < .1);
  assert.ok(state.thumb.width >= 11 && state.thumb.height >= 11);
}

async function scrub(page, context, touch, resume, destination, resting, screenshotPath) {
  if (resume) await page.locator("video").evaluate(video => video.play());
  else await page.locator("video").evaluate(video => video.pause());
  await page.locator("#player-wrap").focus();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(180);
  const rect = await page.locator("#progress-wrap").boundingBox();
  const from = { x: rect.x + rect.width * .18, y: rect.y + rect.height / 2 };
  const to = { x: rect.x + rect.width * destination, y: from.y };
  let session;
  if (touch) {
    session = await context.newCDPSession(page);
  }
  const downSamples = await transitionSamples(page, async () => {
    if (touch) await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
    else { await page.mouse.move(from.x, from.y); await page.mouse.down(); }
  }, resting, touch);
  await page.waitForFunction(() => document.querySelector("video").paused);
  await page.waitForTimeout(80);
  if (touch) {
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: (from.x + to.x) / 2, y: to.y }] });
    await page.waitForTimeout(40);
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [to] });
  } else await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.waitForTimeout(160);
  const dragging = await progressState(page);
  alignment(dragging, resting);
  assert.equal(dragging.overlayPresent, false);
  assert.equal(dragging.paused, true);
  assert.ok(Math.abs(dragging.fill.width / dragging.rail.width - destination) < .005, "Dragging must still preview the thumb and fill");
  assert.notEqual(dragging.tooltip.display, "none", "Scrubbing timestamp must remain available on touch and mouse");
  assert.ok(dragging.tooltip.opacity > .99);
  const previewSeconds = Math.floor(dragging.duration * destination);
  assert.equal(dragging.tooltip.text, `${Math.floor(previewSeconds / 60)}:${String(previewSeconds % 60).padStart(2, "0")}`, "Scrubbing timestamp must follow the requested position");
  if (screenshotPath) await closeup(page, screenshotPath);
  const releaseSamples = await transitionSamples(page, async () => {
    if (touch) await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    else await page.mouse.up();
  }, resting);
  await page.waitForFunction(resume => !document.querySelector("video").seeking && document.querySelector("video").paused === !resume, resume);
  const after = await progressState(page);
  assert.ok(Math.abs(after.time / after.duration - destination) < .025, "Released scrub must seek to the requested point");
  assert.equal(after.paused, !resume, "Scrub must preserve the prior playback/pause state");
  alignment(after, resting);
  return { input: touch ? "touch" : "mouse", resume, downSamples, dragging, releaseSamples, after };
}

try {
  for (const [label, viewport, dpr, touch] of [
    ["desktop", { width: 1440, height: 1000 }, 1, false],
    ["desktop-dpr125", { width: 1440, height: 1000 }, 1.25, false],
    ["desktop-dpr2", { width: 1440, height: 1000 }, 2, false],
    ["compact", { width: 553, height: 1052 }, 1.2, false],
    ["mobile", { width: 424, height: 900 }, 1, true],
    ["mobile-dpr2", { width: 424, height: 900 }, 2, true],
  ]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: dpr, hasTouch: touch, isMobile: touch, reducedMotion: "no-preference" });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/eruda@*/**", route => route.abort());
    await context.route("https://fonts.googleapis.com/**", route => route.abort());
    await context.route("https://fonts.gstatic.com/**", route => route.abort());
    await context.addInitScript(() => localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360, muted: true })));
    try {
      await page.goto(preview.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("#watch-status").hidden && !document.querySelector("#player-wrap").inert && document.querySelector("video").readyState >= 2, null, { timeout: 45000 });
      await page.locator("#player-wrap").scrollIntoViewIfNeeded();
      await seekFrame(page, 6);
      await page.waitForFunction(() => document.querySelector("#progress-buffer").getBoundingClientRect().width > 0);
      const before = await progressState(page);
      geometry(before);
      const hovers = [];
      const hoverSamples = !touch ? await transitionSamples(page, () => page.mouse.move(before.target.x + before.target.width * .25, before.target.y + 8), before, true) : [];
      if (!touch) for (const fraction of [.25, .72]) {
        await page.mouse.move(before.target.x + before.target.width * fraction, before.target.y + 8);
        await page.waitForTimeout(220);
        const after = await progressState(page);
        geometry(after);
        alignment(after, before);
        assert.equal(after.time, before.time, "Hovering a timestamp must not seek the video");
        const seconds = Math.floor(after.duration * fraction);
        const expected = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        assert.equal(after.tooltip.text, expected, "Hover timestamp must follow the pointer");
        if (!after.mobileLayout) {
          assert.notEqual(after.tooltip.display, "none");
          assert.ok(after.tooltip.opacity > .99);
        }
        hovers.push(after);
      }
      await page.locator("#player-wrap").screenshot({ path: `${artifacts}/${label}-hover.png` });
      if (!touch) await closeup(page, `${artifacts}/${label}-hover-closeup.png`);
      await page.mouse.move(2, 2);
      await page.waitForTimeout(180);
      const focusSamples = await transitionSamples(page, async () => {
        await page.keyboard.press("Tab");
        await page.locator("#progress-wrap").focus();
      }, before, true);
      const focused = await progressState(page);
      geometry(focused);
      alignment(focused, before);
      await page.locator("#progress-wrap").evaluate(element => element.blur());
      await page.waitForTimeout(180);
      const pausedScrub = await scrub(page, context, touch, false, touch ? .42 : .62, before, touch ? `${artifacts}/${label}-touch-drag-closeup.png` : undefined);
      const resumedScrub = await scrub(page, context, touch, true, touch ? .7 : .33, before);
      await page.locator("video").evaluate(video => video.pause());
      assert.equal(await page.locator("#progress-hover").count(), 0);
      assert.deepEqual(errors, []);
      results.push({ label, passed: true, before, hoverSamples, hovers, focusSamples, focused, pausedScrub, resumedScrub, errors });
      console.log(`PASS ${label}: vertical centers stable at DPR${dpr} through hover/focus/drag transitions, timeline and playback state preserved`);
    } catch (error) {
      await page.screenshot({ path: `${artifacts}/${label}-failure.png` }).catch(() => {});
      results.push({ label, passed: false, error: error.message });
      throw error;
    } finally { await context.close(); }
  }
} catch (error) {
  process.exitCode = 1;
  console.error(error.stack);
} finally {
  await browser.close(); await preview.close();
  await writeFile(`${artifacts}/results.json`, JSON.stringify(results, null, 2));
}
