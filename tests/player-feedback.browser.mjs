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
    const wrap = document.querySelector("#player-wrap");
    const activation = event => {
      if (event.type === "keydown" && !["k", " ", "Enter"].includes(event.key)) return;
      window.__feedbackLastAction = performance.now();
      events.push({ at: window.__feedbackLastAction - started, type: "activation", input: event.type });
    };
    wrap.addEventListener("click", activation, true);
    wrap.addEventListener("keydown", activation, true);
    window.__feedbackTrace = new Promise(resolveTrace => {
      const sample = () => {
        const parent = getComputedStyle(button), child = getComputedStyle(svg);
        const matrix = child.transform === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(child.transform);
        const buttonRect = button.getBoundingClientRect(), svgRect = svg.getBoundingClientRect();
        frames.push({
          at: performance.now() - started, parent: Number(parent.opacity), svg: Number(child.opacity),
          effective: Number(parent.opacity) * Number(child.opacity),
          className: button.className, animationName: child.animationName, inlineAnimation: svg.style.animation,
          pointerEvents: parent.pointerEvents, ariaHidden: button.getAttribute("aria-hidden"), tabIndex: button.tabIndex,
          scaleX: matrix.a, scaleY: matrix.d, buttonRect: buttonRect.toJSON(),
          svgCenter: { x: svgRect.x + svgRect.width / 2, y: svgRect.y + svgRect.height / 2 },
        });
        if (performance.now() < window.__feedbackStopAt && performance.now() - started < 6000) requestAnimationFrame(sample);
        else {
          types.forEach(type => button.removeEventListener(type, listener));
          wrap.removeEventListener("click", activation, true);
          wrap.removeEventListener("keydown", activation, true);
          resolveTrace({ frames, events, lastActionAt: window.__feedbackLastAction - started });
        }
      };
      sample();
    });
  });
  await action();
  await page.evaluate(tail => { window.__feedbackStopAt = performance.now() + tail; }, tail);
  return page.evaluate(() => window.__feedbackTrace);
}

function singlePulse(trace, reducedMotion = false, retarget = false) {
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
  const cue = frames.find(frame => frame.className.includes("flash-brief"));
  assert.ok(cue && cue.at - trace.lastActionAt < 65, "Center feedback entrance must start promptly after input");
  const entered = frames.find(frame => frame.at >= cue.at && frame.effective >= .999 && Math.abs(frame.scaleX - 1) < .001 && Math.abs(frame.scaleY - 1) < .001);
  assert.ok(entered, "Cue must complete its entrance at full opacity and scale");
  const enterMs = entered.at - cue.at;
  assert.ok(enterMs >= (retarget ? 0 : 40) && enterMs <= 80, `Fresh entrance must be about60ms; retargeting may shorten it (actual${enterMs})`);
  const entrance = frames.filter(frame => frame.at >= cue.at && frame.at < entered.at);
  if (!retarget) assert.ok(entrance.some(frame => frame.effective > .05 && frame.effective < .95), "Must paint an actual intermediate entry fade");
  let maximumRetriggerDrop = 0;
  if (retarget) for (const activation of trace.events.filter(event => event.type === "activation")) {
    const before = trace.frames.findLast(frame => frame.at < activation.at);
    const after = trace.frames.find(frame => frame.at >= activation.at);
    if (!before || !after || before.effective <= .08) continue;
    maximumRetriggerDrop = Math.max(maximumRetriggerDrop, before.effective - after.effective);
    assert.ok(after.effective >= before.effective - .08, "Repeated input must retain the painted opacity without blinking off");
    assert.ok(after.scaleX >= before.scaleX - .008, "Repeated input must retain the painted scale without shrinking abruptly");
  }
  const firstDrop = frames.find(frame => frame.at > entered.at && frame.effective < .98);
  const finished = frames.find(frame => frame.at > cue.at && !frame.className.includes("flash-brief"));
  assert.ok(firstDrop, "Cue must fade after holding");
  const heldMs = firstDrop.at - entered.at;
  const fadeMs = frames[fadedIndex].at - firstDrop.at;
  assert.ok(heldMs >= 380 && heldMs <= 445, `Opaque hold must last about400ms (actual${heldMs})`);
  assert.ok(frames.filter(frame => frame.at >= entered.at && frame.at <= entered.at + 375).every(frame => frame.effective >= .98 && Math.abs(frame.scaleX - 1) < .001), "Opacity and scale must stay flat throughout the hold after entry");
  const cueFrames = frames.filter(frame => frame.className.includes("flash-brief"));
  const restingRect = trace.frames[0].buttonRect;
  for (const frame of cueFrames) {
    for (const dimension of ["x", "y", "width", "height"]) assert.ok(Math.abs(frame.buttonRect[dimension] - restingRect[dimension]) < .1, `Passive cue must not alter button ${dimension}`);
    assert.ok(Math.abs(frame.svgCenter.x - frame.buttonRect.x - frame.buttonRect.width / 2) < .1 && Math.abs(frame.svgCenter.y - frame.buttonRect.y - frame.buttonRect.height / 2) < .1, "SVG growth/shrink must remain centered on the unchanged button");
    assert.ok(frame.scaleX >= .939 && frame.scaleX <= 1.001 && Math.abs(frame.scaleX - frame.scaleY) < .001, "Scale must remain slight and uniform");
  }
  const exit = frames.filter(frame => frame.at >= entered.at + 400 && frame.effective > .05 && frame.effective < .95);
  if (!reducedMotion) {
    assert.ok(fadeMs >= 95 && fadeMs <= 180, `Fade must last about150ms (actual to nearzero${fadeMs})`);
    assert.ok(finished && finished.at - cue.at >= (retarget ? enterMs + 515 : 575) && finished.at - cue.at <= (retarget ? enterMs + 610 : 670), "Cue must complete entry, full hold and fade");
    if (!retarget) assert.ok(entrance.some(frame => frame.scaleX > .9405 && frame.scaleX < .995), "Entry fade must gently grow the SVG");
    assert.ok(exit.some(frame => frame.scaleX > .9405 && frame.scaleX < .995), "Exit fade must gently shrink the SVG");
  } else {
    assert.ok(fadeMs >= 40 && fadeMs <= 110, `Reduced motion must shorten only the fade (actual${fadeMs})`);
    assert.ok(finished && finished.at - cue.at >= 505 && finished.at - cue.at <= 595);
    assert.ok(cueFrames.every(frame => Math.abs(frame.scaleX - 1) < .001 && Math.abs(frame.scaleY - 1) < .001), "Reduced motion must use opacity only with no scale");
  }
  return { peak, appearanceMs: cue.at - trace.lastActionAt, enterMs, heldMs, fadeMs, maximumRetriggerDrop, scaleRange: [Math.min(...cueFrames.map(frame => frame.scaleX)), Math.max(...cueFrames.map(frame => frame.scaleX))], finishedMs: finished?.at - cue.at, rebound, strongestRise, end };
}

async function check(name, page, action, { persistent = false, reducedMotion = false, silent = false, retarget = false, tail } = {}) {
  const trace = await capture(page, action, tail ?? (persistent ? 650 : 1000));
  try {
    let summary;
    const afterAction = trace.frames.filter(frame => frame.at >= trace.lastActionAt);
    const peak = Math.max(...afterAction.map(frame => frame.effective));
    if (silent) {
      assert.ok(afterAction.every(frame => !frame.className.includes("flash-brief")), "Bottom-bar activation must never trigger a center cue");
      const settled = afterAction.filter(frame => frame.at >= trace.lastActionAt + 180);
      assert.ok(settled.length && settled.every(frame => frame.effective <= .01), "An existing initial control/cue must hide without replay after bottom-bar activation");
      summary = { cueFrames: 0, maximumAfterExit: Math.max(...settled.map(frame => frame.effective)) };
    } else if (persistent) {
      const settled = trace.frames.filter(frame => frame.at > trace.lastActionAt + 180);
      assert.ok(settled.length > 0);
      assert.ok(settled.every(frame => frame.effective > .98), "Mobile control must remain visible while chrome is shown");
      assert.ok(settled.every(frame => !frame.className.includes("flash-brief")));
      assert.ok(settled.every(frame => Math.abs(frame.scaleX - 1) < .001 && Math.abs(frame.scaleY - 1) < .001), "Native mobile controls must never receive the passive cue scale");
      assert.equal(trace.events.some(event => event.animationName === "big-play-flash"), false);
      summary = { minimumVisible: Math.min(...settled.map(frame => frame.effective)) };
    } else summary = singlePulse(trace, reducedMotion, retarget);
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

async function setup({ mobile = false, reduced = false, record = false, delayPlay = 0 } = {}) {
  const viewport = mobile ? { width: 424, height: 900 } : { width: 1440, height: 1000 };
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, reducedMotion: reduced ? "reduce" : "no-preference", ...(record ? { recordVideo: { dir: artifacts, size: viewport } } : {}) });
  await context.route("**/eruda@*/**", route => route.abort());
  await context.route("https://fonts.googleapis.com/**", route => route.abort());
  await context.route("https://fonts.gstatic.com/**", route => route.abort());
  await context.addInitScript(() => localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360, muted: true })));
  if (delayPlay) await context.addInitScript(delay => {
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      return new Promise((resolvePlay, rejectPlay) => setTimeout(() => nativePlay.call(this).then(resolvePlay, rejectPlay), delay));
    };
  }, delayPlay);
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

async function surfacePoint(page) {
  const box = await page.locator("#player-wrap").boundingBox();
  return { x: box.x + box.width * .2, y: box.y + box.height * .35 };
}

async function fullscreenDoubleClick(page, paused) {
  await page.locator("#player-wrap").focus();
  if (await page.locator("video").evaluate(video => video.paused) !== paused) await page.keyboard.press("k");
  await page.waitForFunction(paused => document.querySelector("video").paused === paused, paused);
  const intent = await page.locator("#play-btn").getAttribute("aria-label");
  const point = await surfacePoint(page);
  await page.mouse.dblclick(point.x, point.y, { delay: 80 });
  await page.waitForFunction(() => document.fullscreenElement === document.querySelector("#player-wrap"));
  assert.equal(await page.locator("#play-btn").getAttribute("aria-label"), intent);
  await page.waitForFunction(paused => document.querySelector("video").paused === paused, paused);
  await page.evaluate(() => document.exitFullscreen());
  await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
  results.push({ name: `native fullscreen double-click from${paused ? "paused" : "playing"}`, passed: true });
}

try {
  if (!reducedOnly) {
    const desktop = await setup({ record: true });
    await check("desktop initial native play", desktop.page, () => desktop.page.locator("#big-play").click());
    await desktop.page.waitForFunction(() => !document.querySelector("video").paused);
    await check("desktop bottom-bar native click stays silent", desktop.page, () => desktop.page.locator("#play-btn").click(), { silent: true });
    await desktop.page.locator("#play-btn").focus();
    await check("desktop bottom-bar Enter stays silent", desktop.page, () => desktop.page.keyboard.press("Enter"), { silent: true });
    await check("desktop bottom-bar Space stays silent", desktop.page, () => desktop.page.keyboard.press("Space"), { silent: true });
    await desktop.page.locator("#player-wrap").focus();
    await check("desktop keyboard toggle", desktop.page, () => desktop.page.keyboard.press("k"));
    await check("desktop surface toggle", desktop.page, async () => { const point = await surfacePoint(desktop.page); await desktop.page.mouse.click(point.x, point.y); });
    await fullscreenDoubleClick(desktop.page, false);
    await fullscreenDoubleClick(desktop.page, true);
    if (!baselineOnly) {
      await check("desktop rapid repeated toggles", desktop.page, async () => {
        for (let index = 0; index < 3; index++) { await desktop.page.keyboard.press("k"); await desktop.page.waitForTimeout(120); }
      }, { retarget: true });
      await check("bottom bar cancels a held center cue", desktop.page, async () => {
        await desktop.page.keyboard.press("k");
        await desktop.page.waitForTimeout(100);
        await desktop.page.locator("#play-btn").click();
      }, { silent: true });
    }
    const recording = desktop.page.video();
    await desktop.context.close();
    await recording.saveAs(`${artifacts}/${baselineOnly ? "baseline" : "desktop"}-feedback.webm`);
    if (!baselineOnly) {
      const barFirst = await setup({ delayPlay: 800 });
      await check("bottom-bar delayed first play stays silent", barFirst.page, () => barFirst.page.locator("#play-btn").click(), { silent: true, tail: 1300 });
      await barFirst.page.waitForFunction(() => !document.querySelector("video").paused);
      await barFirst.context.close();
      const centerFirst = await setup({ delayPlay: 800 });
      await check("center delayed first play never replays", centerFirst.page, () => centerFirst.page.locator("#big-play").click(), { tail: 1350 });
      await centerFirst.page.waitForFunction(() => !document.querySelector("video").paused);
      await centerFirst.context.close();
    }
  }

  if (!baselineOnly) {
    const reduced = await setup({ reduced: true });
    await reduced.page.locator("#big-play").click();
    await reduced.page.waitForFunction(() => !document.querySelector("video").paused);
    await reduced.page.waitForTimeout(900);
    await reduced.page.locator("#player-wrap").focus();
    await check("desktop reduced-motion toggle", reduced.page, () => reduced.page.keyboard.press("k"), { reducedMotion: true });
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
      await check("mobile persistent pause control", mobile.page, tap, { persistent: true });
      assert.equal(await mobile.page.locator("video").evaluate(video => video.paused), false);
      await check("mobile persistent play control", mobile.page, tap, { persistent: true });
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
