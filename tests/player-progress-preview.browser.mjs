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
      target: rect("#progress-wrap"), touchTarget: rect("#progress-touch-target"), rail: rect("#progress-track"), row: rect("#ctrl-row"),
      fill: rect("#progress-fill"), buffer: rect("#progress-buffer"), thumb: rect("#progress-thumb"),
      tooltip: { text: tooltip.textContent, display: getComputedStyle(tooltip).display, opacity: Number(getComputedStyle(tooltip).opacity), bottom: tooltip.getBoundingClientRect().bottom },
      mobileLayout: document.querySelector("#player-wrap").classList.contains("is-mobile"),
    };
  });
}

function alignment(state, baseline) {
  const railCenter = state.rail.y + state.rail.height / 2;
  const thumbCenter = state.thumb.y + state.thumb.height / 2;
  assert.ok(Math.abs(thumbCenter - railCenter) <= .1, `Thumb is ${thumbCenter - railCenter}px below the rail center at DPR${state.dpr}`);
  assert.ok(Math.abs(state.target.height - 10) < .1, "Mouse seek target must remain 10px high");
  assert.ok(Math.abs(state.touchTarget.height - 44) < .1, "Touch seek target must remain 44px high");
  for (const [name, bounds] of [["mouse", state.target], ["touch", state.touchTarget]]) {
    assert.ok(Math.abs(bounds.y + bounds.height / 2 - railCenter) <= .1, `${name} seek target must be centered on the painted rail`);
    assert.ok(Math.abs(bounds.x - state.rail.x) <= .1 && Math.abs(bounds.width - state.rail.width) <= .1, `${name} seek target must match the painted rail horizontally`);
  }
  assert.ok(Math.abs(state.row.y - railCenter - 5.5) <= .1, "Rail must retain its exact original 5.5px distance above the utility row");
  if (state.tooltip.display !== "none") assert.ok(Math.abs(state.row.y - state.tooltip.bottom - 20) <= .1, "Timestamp must retain its exact original 20px distance above the utility row");
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
        const tooltip = document.querySelector("#time-tooltip");
        samples.push({ at: performance.now() - started, dpr: devicePixelRatio, target: rect("#progress-wrap"), touchTarget: rect("#progress-touch-target"), rail: rect("#progress-track"), thumb: rect("#progress-thumb"), row: rect("#ctrl-row"), tooltip: { display: getComputedStyle(tooltip).display, bottom: tooltip.getBoundingClientRect().bottom } });
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

async function hitTesting(page) {
  const hits = await page.evaluate(() => {
    const rail = document.querySelector("#progress-track").getBoundingClientRect();
    const band = [];
    for (const fraction of [.35, .5, .65]) for (const offset of [-23, -21, -6, -4, 0, 4, 6, 21, 23]) {
      const element = document.elementFromPoint(rail.x + rail.width * fraction, rail.y + rail.height / 2 + offset);
      band.push({ fraction, offset, mouseTarget: !!element?.closest("#progress-wrap"), touchTarget: !!element?.closest("#progress-wrap, #progress-touch-target"), target: element?.id || element?.tagName });
    }
    const controls = [...document.querySelectorAll("#ctrl-row button, #vol-slider")].flatMap(control => {
      const rect = control.getBoundingClientRect();
      if (!rect.width || !rect.height || getComputedStyle(control).visibility === "hidden") return [];
      return [1, rect.height / 2, rect.height - 1].map(offset => {
        const element = document.elementFromPoint(rect.x + rect.width / 2, rect.y + offset);
        return { id: control.id, offset, ownsHit: element === control || control.contains(element), target: element?.id || element?.tagName };
      });
    });
    return { band, controls };
  });
  for (const hit of hits.band) {
    assert.equal(hit.mouseTarget, false, `Painted keyboard slider must stay out of native pointer targeting at ${hit.offset}px from rail, reached ${hit.target}`);
    assert.equal(hit.touchTarget, Math.abs(hit.offset) <= 21, `Touch target at ${hit.offset}px from rail, ${hit.fraction * 100}% width reached ${hit.target}`);
  }
  assert.ok(hits.controls.length > 0);
  for (const hit of hits.controls) assert.equal(hit.ownsHit, true, `${hit.id} must own its target ${hit.offset}px from its top, reached ${hit.target}`);
  return hits;
}

async function activatePoint(page, touch, point) {
  if (touch) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

async function seekBoundaryActions(page, touch) {
  const rail = await page.locator("#progress-track").boundingBox();
  const actions = [];
  for (const [fraction, offset] of [[.4, touch ? -21 : -4], [.6, touch ? 21 : 4]]) {
    const point = { x: rail.x + rail.width * fraction, y: rail.y + rail.height / 2 + offset };
    if (!touch) {
      await page.mouse.move(point.x, point.y);
      assert.equal(await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)).cursor, point), "pointer", "Actual mouse inside its narrow band must show the seek cursor, including on hybrid devices");
    }
    await activatePoint(page, touch, point);
    await page.waitForFunction(fraction => {
      const video = document.querySelector("video");
      return !video.seeking && Math.abs(video.currentTime / video.duration - fraction) < .005;
    }, fraction);
    assert.equal(await page.evaluate(() => document.activeElement.id), "progress-wrap", "Native seeking must focus the real keyboard slider");
    assert.equal(await page.locator("video").evaluate(video => video.paused), true, "Seeking must not leak a picture click or change paused playback");
    actions.push({ fraction, offset, time: await page.locator("video").evaluate(video => video.currentTime) });
  }
  await page.keyboard.press("Space");
  await page.waitForFunction(() => !document.querySelector("video").paused);
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector("video").paused);
  const button = await page.locator("#settings-btn").boundingBox();
  const before = await progressState(page);
  await activatePoint(page, touch, { x: button.x + button.width / 2, y: button.y + 1 });
  await page.waitForFunction(() => document.querySelector("#settings-panel").dataset.phase === "open");
  if (touch) await page.locator("#settings-close").tap();
  else await page.locator("#settings-close").click();
  await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
  const after = await progressState(page);
  assert.equal(after.time, before.time, "Utility button top edge must not seek through the touch layer");
  assert.equal(after.paused, true, "Utility button action must not toggle playback");
  await seekFrame(page, 6);
  return actions;
}

async function mousePictureActions(page, label) {
  await page.locator("#player-wrap").focus();
  await page.evaluate(() => {
    window.__unexpectedSeeks = 0;
    document.querySelector("video").addEventListener("seeking", () => window.__unexpectedSeeks += 1);
  });
  const rail = await page.locator("#progress-track").boundingBox();
  const actions = [];
  for (const offset of [-6, -20, 6, 20]) {
    const point = { x: rail.x + rail.width * .63, y: rail.y + rail.height / 2 + offset };
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(180);
    const hovered = await progressState(page);
    assert.ok(hovered.tooltip.opacity < .01, "Cold mouse area must not show the seek timestamp");
    assert.ok(Math.abs(hovered.rail.height - 3) < .1, "Cold mouse area must not grow the seek rail");
    assert.notEqual(await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)).cursor, point), "pointer", "Cold mouse area must retain the picture cursor");
    const paused = hovered.paused;
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(paused => document.querySelector("video").paused !== paused, paused);
    assert.equal(await page.evaluate(() => document.activeElement.id), "player-wrap", "Cold mouse picture click must focus the player for Space");
    actions.push({ offset, paused: !paused });
  }
  assert.equal(await page.evaluate(() => window.__unexpectedSeeks), 0, "Cold mouse picture actions must never seek");
  if (label === "desktop" || label === "hybrid") {
    const point = { x: rail.x + rail.width * .63, y: rail.y + rail.height / 2 - 20 };
    const paused = await page.locator("video").evaluate(video => video.paused);
    await page.mouse.dblclick(point.x, point.y);
    await page.waitForFunction(() => document.fullscreenElement?.id === "player-wrap");
    geometry(await progressState(page));
    await hitTesting(page);
    assert.equal(await page.locator("video").evaluate(video => video.paused), paused, "Cold-area double-click must preserve playback when entering fullscreen");
    await page.locator("#fs-btn").click();
    await page.waitForFunction(() => !document.fullscreenElement);
    geometry(await progressState(page));
  }
  await seekFrame(page, 6);
  return actions;
}

async function interruptedScrub(page, context, touch, mode) {
  const session = touch ? await context.newCDPSession(page) : null;
  await seekFrame(page, 6);
  const before = await progressState(page);
  const center = before.rail.y + before.rail.height / 2;
  const from = { x: before.rail.x + before.rail.width * .4, y: center + (touch ? -20 : 0) };
  const to = { x: before.rail.x + before.rail.width * .65, y: center - 40 };
  await page.evaluate(() => document.querySelector("#progress-wrap").addEventListener("gotpointercapture", event => { window.__seekPointer = event.pointerId; }, { once: true }));
  try {
    if (touch) {
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
      await page.waitForTimeout(40);
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [to] });
    } else {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 6 });
    }
    await page.waitForFunction(() => document.querySelector("#progress-wrap").classList.contains("scrubbing") && document.querySelector("#progress-wrap").hasPointerCapture(window.__seekPointer));
    const dragging = await progressState(page);
    assert.ok(Math.abs(dragging.fill.width / dragging.rail.width - .65) < .005, "Captured scrubbing must track outside both seek bands");
    if (mode === "cancel") await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    else {
      await page.evaluate(() => document.querySelector("#progress-wrap").releasePointerCapture(window.__seekPointer));
      if (touch) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: to.x + 1, y: to.y }] });
      else await page.mouse.move(to.x + 1, to.y);
    }
    await page.waitForFunction(() => !document.querySelector("#progress-wrap").classList.contains("scrubbing"));
    if (mode !== "cancel") {
      if (touch) await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      else await page.mouse.up();
    }
    const after = await progressState(page);
    assert.equal(after.time, before.time, `${mode} must discard the uncommitted seek preview`);
    assert.equal(after.paused, before.paused, `${mode} must preserve playback state`);
    assert.ok(Math.abs(after.fill.width / after.rail.width - before.time / before.duration) < .005, `${mode} must restore the actual played fill`);
    return { mode, touch, before, dragging, after };
  } finally { if (session) await session.detach(); }
}

async function nativePageScroll(page, context, touch) {
  const before = await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.id = "test-native-scroll-tail";
    fixture.style.height = "1200px";
    document.body.append(fixture);
    const player = document.querySelector("#player-wrap").getBoundingClientRect();
    return { scroll: scrollY, x: innerWidth / 2, y: Math.min(innerHeight - 40, player.bottom + 70) };
  });
  let session;
  try {
    if (touch) {
      session = await context.newCDPSession(page);
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: before.x, y: before.y }] });
      for (const distance of [30, 60, 100, 140]) {
        await page.waitForTimeout(30);
        await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: before.x, y: before.y - distance }] });
      }
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await page.mouse.move(before.x, before.y);
      await page.mouse.wheel(0, 180);
    }
    await page.waitForFunction(scroll => scrollY > scroll + 20, before.scroll);
    return { input: touch ? "touch" : "wheel", delta: await page.evaluate(scroll => scrollY - scroll, before.scroll) };
  } finally {
    if (session) await session.detach();
    await page.evaluate(scroll => { document.querySelector("#test-native-scroll-tail").remove(); window.scrollTo(0, scroll); }, before.scroll);
    await page.locator("#player-wrap").scrollIntoViewIfNeeded();
  }
}

async function hitRegionScreenshot(page, path) {
  await page.evaluate(() => {
    for (const [selector, color] of [["#progress-touch-target", "rgba(53,190,255,.25)"], ["#progress-wrap", "rgba(232,255,71,.5)"]]) {
      const overlay = document.createElement("div");
      overlay.className = "test-seek-hit-region";
      Object.assign(overlay.style, { position: "absolute", inset: "0", background: color, pointerEvents: "none", zIndex: "20" });
      document.querySelector(selector).append(overlay);
    }
  });
  try { await page.locator("#player-wrap").screenshot({ path }); }
  finally { await page.locator(".test-seek-hit-region").evaluateAll(elements => elements.forEach(element => element.remove())); }
}

function geometry(state) {
  alignment(state);
  assert.equal(state.overlayPresent, false, "Decorative progress-hover overlay must remain absent");
  assert.ok(state.rail.height >= 2.9 && state.rail.height <= 5.1, "Visible rail must retain its existing resting/hover geometry");
  assert.ok(Math.abs(state.fill.height - state.rail.height) < .1);
  assert.ok(Math.abs(state.fill.left - state.rail.left) < .1);
  assert.ok(Math.abs(state.fill.width / state.rail.width - state.time / state.duration) < .002, "Played fill must represent actual currentTime");
  assert.ok(Math.abs(state.thumb.x + state.thumb.width / 2 - state.fill.right) < 1, "Thumb must remain aligned with the played fill");
  assert.ok(state.buffer.width > 0 && state.buffer.width <= state.rail.width + 1, "Buffered progress must remain present within the rail");
  assert.ok(Math.abs(state.buffer.left - state.rail.left) < .1);
  assert.ok(state.thumb.width >= 11 && state.thumb.height >= 11);
}

async function scrub(page, context, touch, resume, destination, resting, screenshotPath, outsideBand = false) {
  if (resume) await page.locator("video").evaluate(video => video.play());
  else await page.locator("video").evaluate(video => video.pause());
  await page.locator("#player-wrap").focus();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(180);
  const rect = await page.locator("#progress-wrap").boundingBox();
  const from = { x: rect.x + rect.width * .18, y: rect.y + rect.height / 2 };
  const to = { x: rect.x + rect.width * destination, y: from.y - (outsideBand ? 40 : 0) };
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
  return { input: touch ? "touch" : "mouse", resume, outsideBand, downSamples, dragging, releaseSamples, after };
}

try {
  for (const [label, viewport, dpr, touch] of [
    ["desktop", { width: 1440, height: 1000 }, 1, false],
    ["desktop-dpr125", { width: 1440, height: 1000 }, 1.25, false],
    ["desktop-dpr2", { width: 1440, height: 1000 }, 2, false],
    ["compact", { width: 553, height: 1052 }, 1.2, false],
    ["mobile", { width: 424, height: 900 }, 1, true],
    ["mobile-dpr2", { width: 424, height: 900 }, 2, true],
    ["hybrid", { width: 1440, height: 1000 }, 1, true],
  ]) {
    if (process.env.AIDA_PROGRESS_PROFILES && !process.env.AIDA_PROGRESS_PROFILES.split(",").includes(label)) continue;
    const context = await browser.newContext({ viewport, deviceScaleFactor: dpr, hasTouch: touch, isMobile: touch && label !== "hybrid", reducedMotion: "no-preference" });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/eruda@*/**", route => route.abort());
    await context.route("https://fonts.googleapis.com/**", route => route.abort());
    await context.route("https://fonts.gstatic.com/**", route => route.abort());
    await context.addInitScript(() => {
      localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360, muted: true }));
      localStorage.setItem("aida-cc-banner-dismissed", "1");
      window.__seekEvents = [];
      for (const type of ["pointerdown", "pointerup", "touchstart", "click"]) document.addEventListener(type, event => {
        const point = event.touches?.[0] || event;
        const rect = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON();
        window.__seekEvents.push({ type, target: event.target.id || event.target.tagName, pointer: event.pointerType, x: point.clientX, y: point.clientY, time: document.querySelector("video")?.currentTime, scroll: scrollY,
          ...(type === "pointerdown" || type === "touchstart" ? { rawHit: document.elementFromPoint(point.clientX, point.clientY)?.id, pointerEvents: getComputedStyle(event.target).pointerEvents, inertAncestor: event.target.closest("[inert]")?.id, slider: rect("#progress-wrap"), touch: rect("#progress-touch-target"), settings: rect("#settings-btn"), row: rect("#ctrl-row") } : {}) });
        if (window.__seekEvents.length > 20) window.__seekEvents.shift();
      }, true);
    });
    try {
      await page.goto(preview.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("#watch-status").hidden && !document.querySelector("#player-wrap").inert && document.querySelector("video").readyState >= 2, null, { timeout: 45000 });
      await page.locator("#player-wrap").scrollIntoViewIfNeeded();
      await seekFrame(page, 6);
      await page.waitForFunction(() => document.querySelector("#progress-buffer").getBoundingClientRect().width > 0);
      const before = await progressState(page);
      geometry(before);
      const hits = await hitTesting(page);
      const mouseActions = !touch || label === "hybrid" ? await mousePictureActions(page, label) : undefined;
      const boundaryActions = await seekBoundaryActions(page, touch);
      const hybridMouse = label === "hybrid" ? await seekBoundaryActions(page, false) : undefined;
      await page.locator("#player-wrap").focus();
      await page.mouse.move(2, 2);
      await page.waitForTimeout(180);
      const hovers = [];
      const hoverSamples = !touch ? await transitionSamples(page, () => page.mouse.move(before.target.x + before.target.width * .25, before.rail.y + before.rail.height / 2), before, true) : [];
      if (!touch) for (const fraction of [.25, .72]) {
        await page.mouse.move(before.target.x + before.target.width * fraction, before.rail.y + before.rail.height / 2);
        await page.waitForTimeout(220);
        const after = await progressState(page);
        geometry(after);
        alignment(after, before);
        assert.ok(Math.abs(after.rail.height - 5) <= .1, "Actual mouse hover inside its narrow band must grow the rail");
        assert.equal(await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)).cursor, { x: before.rail.x + before.rail.width * fraction, y: before.rail.y + before.rail.height / 2 }), "pointer", "Actual mouse hover inside its narrow band must show the seek cursor");
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
      if (["desktop", "mobile", "hybrid"].includes(label)) await hitRegionScreenshot(page, `${artifacts}/${label}-hit-regions.png`);
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
      const capturedScrub = await scrub(page, context, touch, false, .56, before, undefined, true);
      const lostCapture = await interruptedScrub(page, context, touch, "lostcapture");
      const cancelled = touch ? await interruptedScrub(page, context, true, "cancel") : undefined;
      await page.locator("video").evaluate(video => video.pause());
      const nativeScroll = await nativePageScroll(page, context, touch);
      assert.equal(await page.locator("#progress-hover").count(), 0);
      assert.deepEqual(errors, []);
      results.push({ label, passed: true, before, hits, mouseActions, boundaryActions, hybridMouse, hoverSamples, hovers, focusSamples, focused, pausedScrub, resumedScrub, capturedScrub, lostCapture, cancelled, nativeScroll, errors });
      console.log(`PASS ${label}: unchanged compact paint at DPR${dpr}, 10px mouse/44px touch targets, picture input, Space, captured/cancelled scrubs and native scrolling`);
    } catch (error) {
      await page.screenshot({ path: `${artifacts}/${label}-failure.png` }).catch(() => {});
      const diagnostics = await page.evaluate(() => ({ events: window.__seekEvents, focus: document.activeElement.id, menu: document.querySelector("#settings-panel")?.dataset.phase, paused: document.querySelector("video")?.paused }));
      console.error(JSON.stringify({ label, diagnostics }));
      results.push({ label, passed: false, error: error.message, diagnostics });
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
