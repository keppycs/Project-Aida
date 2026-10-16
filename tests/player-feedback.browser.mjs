import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { startPlayerPreview } from "./support/player-preview.mjs";

const require = createRequire(import.meta.url);
const runtime = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || runtime);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = process.env.AIDA_REVIEW_DIR || `C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-feedback-${Date.now()}`;
const baselineOnly = process.argv.includes("--baseline");
const reducedOnly = process.argv.includes("--reduced-only");
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const preview = await startPlayerPreview();
const browser = await chromium.launch({ executablePath, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const results = [];
console.log(`Feedback artifacts: ${artifacts}`);

async function capture(page, action, tail = 950) {
  await page.evaluate(() => {
    const button = document.querySelector("#big-play"), svg = button.querySelector("svg");
    const started = performance.now(), frames = [], events = [];
    window.__feedbackStopAt = Infinity;
    window.__feedbackLastAction = started;
    const listener = event => {
      if (event.target !== button && event.target !== svg) return;
      events.push({ at: performance.now() - started, type: event.type, target: event.target === svg ? "svg" : "button", animationName: event.animationName, propertyName: event.propertyName });
    };
    const types = ["animationstart", "animationend", "animationcancel", "transitionstart", "transitionend", "transitioncancel"];
    types.forEach(type => button.addEventListener(type, listener));
    window.__feedbackTrace = new Promise(resolveTrace => {
      const sample = () => {
        const parent = getComputedStyle(button), child = getComputedStyle(svg);
        frames.push({
          at: performance.now() - started, parent: Number(parent.opacity), svg: Number(child.opacity),
          effective: Number(parent.opacity) * Number(child.opacity),
          className: button.className, animationName: child.animationName, inlineAnimation: svg.style.animation,
          pointerEvents: parent.pointerEvents, ariaHidden: button.getAttribute("aria-hidden"), tabIndex: button.tabIndex,
        });
        if (performance.now() < window.__feedbackStopAt && performance.now() - started < 6000) requestAnimationFrame(sample);
        else {
          types.forEach(type => button.removeEventListener(type, listener));
          resolveTrace({ frames, events, lastActionAt: window.__feedbackLastAction - started });
        }
      };
      sample();
    });
  });
  await action();
  await page.evaluate(tail => { window.__feedbackLastAction = performance.now(); window.__feedbackStopAt = performance.now() + tail; }, tail);
  return page.evaluate(() => window.__feedbackTrace);
}

function singlePulse(trace) {
  const frames = trace.frames.filter(frame => frame.at >= trace.lastActionAt);
  const peak = Math.max(...frames.map(frame => frame.effective));
  assert.ok(peak > .75, `Feedback never became visible (peak${peak})`);
  const peakIndex = frames.findIndex(frame => frame.effective === peak);
  const fadedIndex = frames.findIndex((frame, index) => index > peakIndex && frame.effective <= .05);
  assert.ok(fadedIndex >= 0, "Feedback did not fade to near zero");
  const tail = frames.slice(fadedIndex);
  let minimum = tail[0].effective, rebound = 0;
  for (const frame of tail) { rebound = Math.max(rebound, frame.effective - minimum); minimum = Math.min(minimum, frame.effective); }
  assert.ok(rebound <= .08, `Feedback reappeared after fading: rebound${rebound}`);
  let strongestRise = 0;
  for (let index = peakIndex + 1; index < frames.length; index++) strongestRise = Math.max(strongestRise, frames[index].effective - frames[index - 1].effective);
  assert.ok(strongestRise < .08, `Feedback had a second rise after its peak: ${strongestRise}`);
  const end = frames.at(-1);
  assert.ok(end.effective <= .01);
  assert.equal(end.className.includes("flash-brief"), false);
  assert.equal(end.pointerEvents, "none");
  assert.equal(end.ariaHidden, "true");
  assert.equal(end.tabIndex, -1);
  return { peak, fadedAt: frames[fadedIndex].at, rebound, strongestRise, end };
}

async function check(name, page, action, persistent = false, reducedMotion = false) {
  const trace = await capture(page, action, persistent ? 650 : 950);
  try {
    let summary;
    const afterAction = trace.frames.filter(frame => frame.at >= trace.lastActionAt);
    const peak = Math.max(...afterAction.map(frame => frame.effective));
    if (reducedMotion && peak <= .08) {
      const end = trace.frames.at(-1);
      assert.ok(end.effective <= .01);
      assert.equal(end.className.includes("flash-brief"), false);
      assert.equal(end.pointerEvents, "none");
      assert.equal(end.ariaHidden, "true");
      assert.equal(end.tabIndex, -1);
      summary = { feedbackSuppressed: true, peak, rebound: 0, end };
    } else if (persistent) {
      const settled = trace.frames.filter(frame => frame.at > trace.lastActionAt + 180);
      assert.ok(settled.length > 0);
      assert.ok(settled.every(frame => frame.effective > .98), "Mobile control must remain visible while chrome is shown");
      assert.ok(settled.every(frame => !frame.className.includes("flash-brief")));
      assert.equal(trace.events.some(event => event.animationName === "big-play-flash"), false);
      summary = { minimumVisible: Math.min(...settled.map(frame => frame.effective)) };
    } else summary = singlePulse(trace);
    results.push({ name, passed: true, summary, trace });
    console.log(`PASS ${name}: ${JSON.stringify(summary)}`);
  } catch (error) {
    const frames = trace.frames.filter(frame => frame.at >= trace.lastActionAt);
    const peak = Math.max(...frames.map(frame => frame.effective));
    const peakIndex = frames.findIndex(frame => frame.effective === peak);
    const fadedIndex = frames.findIndex((frame, index) => index > peakIndex && frame.effective <= .05);
    const rebound = fadedIndex < 0 ? null : Math.max(...frames.slice(fadedIndex).map(frame => frame.effective));
    results.push({ name, passed: false, error: error.message, summary: { peak, fadedAt: frames[fadedIndex]?.at, rebound }, trace });
    console.error(`FAIL ${name}: ${error.message}; peak=${peak}, rebound=${rebound}`);
    process.exitCode = 1;
  }
}

async function setup({ mobile = false, reduced = false, record = false } = {}) {
  const viewport = mobile ? { width: 424, height: 900 } : { width: 1440, height: 1000 };
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, reducedMotion: reduced ? "reduce" : "no-preference", ...(record ? { recordVideo: { dir: artifacts, size: viewport } } : {}) });
  await context.route("**/eruda@*/**", route => route.abort());
  await context.route("https://fonts.googleapis.com/**", route => route.abort());
  await context.route("https://fonts.gstatic.com/**", route => route.abort());
  await context.addInitScript(() => localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360, muted: true })));
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(preview.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#watch-status").hidden && !document.querySelector("#player-wrap").inert && document.querySelector("video").readyState >= 2, null, { timeout: 45000 });
  await page.locator("#player-wrap").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const initial = await page.locator("#big-play").evaluate(button => ({ parent: Number(getComputedStyle(button).opacity), svg: Number(getComputedStyle(button.querySelector("svg")).opacity), tabIndex: button.tabIndex, hidden: button.getAttribute("aria-hidden") }));
  assert.ok(initial.parent * initial.svg > .98, "Initial play control must remain visible");
  assert.equal(initial.tabIndex, 0);
  assert.equal(initial.hidden, "false");
  return { context, page };
}

try {
  if (!reducedOnly) {
    const desktop = await setup({ record: true });
    await check("desktop initial native play", desktop.page, () => desktop.page.locator("#big-play").click());
    await desktop.page.waitForFunction(() => !document.querySelector("video").paused);
    await desktop.page.locator("video").evaluate(video => video.pause());
    await desktop.page.waitForTimeout(200);
    await check("desktop native click", desktop.page, () => desktop.page.locator("#play-btn").click());
    await desktop.page.locator("#player-wrap").focus();
    await check("desktop keyboard toggle", desktop.page, () => desktop.page.keyboard.press("k"));
    if (!baselineOnly) {
      await check("desktop rapid repeated toggles", desktop.page, async () => {
        for (let index = 0; index < 3; index++) { await desktop.page.keyboard.press("k"); await desktop.page.waitForTimeout(120); }
      });
    }
    const recording = desktop.page.video();
    await desktop.context.close();
    await recording.saveAs(`${artifacts}/${baselineOnly ? "baseline" : "desktop"}-feedback.webm`);
  }

  if (!baselineOnly) {
    const reduced = await setup({ reduced: true });
    await reduced.page.locator("#big-play").click();
    await reduced.page.waitForFunction(() => !document.querySelector("video").paused);
    await reduced.page.waitForTimeout(900);
    await reduced.page.locator("#player-wrap").focus();
    await check("desktop reduced-motion toggle", reduced.page, () => reduced.page.keyboard.press("k"), false, true);
    assert.equal(await reduced.page.locator("video").evaluate(video => video.paused), true);
    await reduced.context.close();

    if (!reducedOnly) {
      const mobile = await setup({ mobile: true });
      const session = await mobile.context.newCDPSession(mobile.page);
      const tap = async () => {
        const rect = await mobile.page.locator("#big-play").boundingBox();
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }] });
        await mobile.page.waitForTimeout(100);
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      await check("mobile persistent pause control", mobile.page, tap, true);
      assert.equal(await mobile.page.locator("video").evaluate(video => video.paused), false);
      await check("mobile persistent play control", mobile.page, tap, true);
      assert.equal(await mobile.page.locator("video").evaluate(video => video.paused), true);
      await mobile.context.close();
    }
  }
} catch (error) {
  process.exitCode = 1;
  console.error(error.stack);
} finally {
  await browser.close(); await preview.close();
  await writeFile(`${artifacts}/results.json`, JSON.stringify(results, null, 2));
}
