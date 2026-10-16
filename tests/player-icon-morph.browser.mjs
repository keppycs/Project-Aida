import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { startPlayerPreview } from "./support/player-preview.mjs";

const require = createRequire(import.meta.url);
const modules = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || `${modules}/playwright`);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = process.env.AIDA_REVIEW_DIR || `C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-icon-morph-${Date.now()}`;
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const preview = await startPlayerPreview();
const browser = await chromium.launch({ executablePath, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const report = { cases: [] };
let page;
console.log(`Icon morph artifacts: ${artifacts}`);

async function setup({ mobile = false, reduced = false, noAudio = false, muted = false } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 424, height: 900 } : { width: 1440, height: 1000 },
    deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, reducedMotion: reduced ? "reduce" : "no-preference" });
  await context.route("**/eruda@*/**", route => route.abort());
  await context.route("https://fonts.googleapis.com/**", route => route.abort());
  await context.route("https://fonts.gstatic.com/**", route => route.abort());
  await context.addInitScript(({ noAudio, muted }) => {
    localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360, volume: .6, muted }));
    localStorage.setItem("aida-cc-banner-dismissed", "1");
    window.__iconInitialVolumeStates = [];
    new MutationObserver(records => {
      for (const record of records) if (record.target.id === "vol-icon") {
        window.__iconInitialVolumeStates.push({ previous: record.oldValue, current: record.target.getAttribute("data-icon-state") });
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-icon-state"], attributeOldValue: true });
    if (noAudio) { window.AudioContext = undefined; window.webkitAudioContext = undefined; }
  }, { noAudio, muted });
  const current = await context.newPage();
  current.setDefaultTimeout(12000);
  const errors = [];
  current.on("pageerror", error => errors.push(error.message));
  await current.goto(preview.url, { waitUntil: "domcontentloaded" });
  await current.waitForFunction(() => document.querySelector("#watch-status").hidden && !document.querySelector("#player-wrap").inert
    && document.querySelector("video").readyState >= 2 && document.querySelector("#play-icon [data-morph-path]"), null, { timeout: 45000 });
  await current.locator("#player-wrap").scrollIntoViewIfNeeded();
  await current.evaluate(() => {
    window.__iconSelectors = ["#play-icon", "#big-play svg", "#vol-icon"];
    window.__iconOriginalNodes = window.__iconSelectors.map(selector => [...document.querySelector(selector).querySelectorAll("[data-morph-path]")]);
    window.__iconSample = () => ({ at: performance.now(), icons: Object.fromEntries(window.__iconSelectors.map((selector, index) => {
      const svg = document.querySelector(selector), paths = [...svg.querySelectorAll("[data-morph-path]")], button = svg.closest("button");
      return [selector, { state: svg.dataset.iconState, d: paths.map(path => path.getAttribute("d")),
        sameNodes: paths.length === window.__iconOriginalNodes[index].length && paths.every((path, offset) => path === window.__iconOriginalNodes[index][offset]),
        rect: button.getBoundingClientRect().toJSON(), label: button.getAttribute("aria-label") }];
    })), volume: document.querySelector("video").volume, muted: document.querySelector("video").muted,
    paused: document.querySelector("video").paused, prefs: JSON.parse(localStorage.getItem("aida-player-prefs")) });
    window.__iconStart = () => {
      const trace = window.__iconTrace = { frames: [], swaps: 0, running: true };
      const observer = new MutationObserver(records => { trace.swaps += records.filter(record => record.type === "childList").length; });
      for (const selector of window.__iconSelectors) observer.observe(document.querySelector(selector), { subtree: true, childList: true });
      trace.stop = () => { trace.running = false; observer.disconnect(); };
      const frame = () => { trace.frames.push(window.__iconSample()); if (trace.running) requestAnimationFrame(frame); };
      frame();
    };
  });
  return { context, page: current, errors };
}

const sample = current => current.evaluate(() => window.__iconSample());
async function capture(current, action, tail = 400) {
  await current.evaluate(() => window.__iconStart());
  await action();
  await current.waitForTimeout(tail);
  return current.evaluate(() => { const trace = window.__iconTrace; trace.stop(); return { frames: trace.frames, swaps: trace.swaps }; });
}
function stable(trace, selector) {
  assert.equal(trace.swaps, 0, "Morphing must retain SVG nodes instead of replacing their markup");
  const first = trace.frames[0].icons[selector];
  for (const frame of trace.frames) {
    const icon = frame.icons[selector];
    assert.equal(icon.sameNodes, true, `${selector}: path identity changed`);
    for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(icon.rect[key] - first.rect[key]) < .1, `${selector}: morph changed button ${key}`);
  }
}
function morph(trace, selector, from, to) {
  stable(trace, selector);
  const frames = trace.frames.map(frame => frame.icons[selector]);
  assert.equal(frames[0].state, from); assert.equal(frames.at(-1).state, to);
  const start = JSON.stringify(frames[0].d), end = JSON.stringify(frames.at(-1).d);
  assert.notEqual(start, end, `${selector}: endpoint geometry must change`);
  const shapes = new Set(frames.map(frame => JSON.stringify(frame.d)));
  assert.ok(shapes.size >= 5, `${selector}: must paint several actual intermediate path shapes (${shapes.size})`);
  assert.ok(frames.some(frame => { const d = JSON.stringify(frame.d); return d !== start && d !== end; }), `${selector}: path must morph, not swap or crossfade endpoint shapes`);
  return { distinctShapes: shapes.size, frames: frames.length };
}
async function endpoint(current, selector, state) {
  await current.waitForTimeout(300);
  const value = await current.locator(selector).evaluate(svg => {
    const path = svg.querySelector("[data-morph-path]"), big = svg.viewBox.baseVal.width === 72;
    const points = big ? [["tip", 50, 36], ["gap", 36, 36], ["leftBar", 28, 36], ["rightBar", 43, 36]]
      : [["tip", 18.5, 12], ["gap", 12, 12], ["leftBar", 8, 12], ["rightBar", 16, 12]];
    return { state: svg.dataset.iconState, fill: Object.fromEntries(points.map(([name, x, y]) => [name, path.isPointInFill(new DOMPoint(x, y))])) };
  });
  assert.equal(value.state, state);
  assert.deepEqual(value.fill, { tip: state === "play", gap: state === "play", leftBar: true, rightBar: true }, `${selector}: actual fill must form the ${state} glyph`);
}
async function setVolume(current, value) {
  await current.locator("#vol-slider").evaluate((slider, value) => { slider.value = value; slider.dispatchEvent(new Event("input", { bubbles: true })); }, value);
}

try {
  const savedMuted = await setup({ muted: true }); page = savedMuted.page;
  const mutedMountTrace = await capture(page, async () => {});
  const initialVolumeStates = await page.evaluate(() => window.__iconInitialVolumeStates);
  assert.ok(initialVolumeStates.length > 0, "Saved mute test must observe initial icon state assignment");
  assert.ok(initialVolumeStates.every(({ previous, current }) => [null, "muted"].includes(previous) && current === "muted"),
    `Saved muted playback must mount directly as muted, including coalesced initial mutations: ${JSON.stringify(initialVolumeStates)}`);
  stable(mutedMountTrace, "#vol-icon");
  assert.ok(mutedMountTrace.frames.every(frame => frame.icons["#vol-icon"].state === "muted" && frame.muted), "Saved mute must initialize the icon and media in the same state");
  assert.ok(mutedMountTrace.frames.every(frame => frame.prefs.muted === true && frame.prefs.volume === .6), "Initial media events must preserve saved mute and nominal volume preferences");
  assert.equal(new Set(mutedMountTrace.frames.map(frame => JSON.stringify(frame.icons["#vol-icon"].d))).size, 1, "Saved mute must paint stable endpoint geometry without an initial morph");
  report.cases.push({ name: "saved mute mounts directly at muted geometry", initialVolumeStates });
  assert.deepEqual(savedMuted.errors, []); await savedMuted.context.close();

  const desktop = await setup(); page = desktop.page;
  const mountTrace = await capture(page, async () => {});
  for (const selector of ["#play-icon", "#big-play svg", "#vol-icon"]) {
    stable(mountTrace, selector);
    assert.equal(new Set(mountTrace.frames.map(frame => JSON.stringify(frame.icons[selector].d))).size, 1, `${selector}: first mount must paint its endpoint directly`);
  }
  report.cases.push({ name: "first mount snaps to selected endpoints" });
  await endpoint(page, "#play-icon", "play");
  await endpoint(page, "#big-play svg", "play");
  assert.equal((await sample(page)).icons["#vol-icon"].state, "full");
  const playTrace = await capture(page, () => page.locator("#play-btn").click());
  report.cases.push({ name: "desktop play geometry", ...morph(playTrace, "#play-icon", "play", "pause") });
  await endpoint(page, "#play-icon", "pause");
  const pauseTrace = await capture(page, () => page.locator("#play-btn").click());
  report.cases.push({ name: "desktop pause geometry", ...morph(pauseTrace, "#play-icon", "pause", "play") });

  // Native keyboard shortcuts must keep labels and geometry in step.
  await page.locator("#player-wrap").focus();
  const muteTrace = await capture(page, () => page.keyboard.press("m"));
  report.cases.push({ name: "keyboard mute geometry", ...morph(muteTrace, "#vol-icon", "full", "muted") });
  assert.equal(muteTrace.frames.at(-1).icons["#vol-icon"].label, "Unmute");
  assert.equal(muteTrace.frames.at(-1).prefs.volume, .6, "Mute must retain selected volume");
  const unmuteTrace = await capture(page, () => page.keyboard.press("m"));
  report.cases.push({ name: "keyboard unmute geometry", ...morph(unmuteTrace, "#vol-icon", "muted", "full") });
  assert.equal(unmuteTrace.frames.at(-1).volume, .6);
  const lowTrace = await capture(page, () => setVolume(page, .49));
  report.cases.push({ name: "volume below threshold", ...morph(lowTrace, "#vol-icon", "full", "low") });
  const fullTrace = await capture(page, () => setVolume(page, .5));
  report.cases.push({ name: "volume threshold", ...morph(fullTrace, "#vol-icon", "low", "full") });
  const zeroTrace = await capture(page, () => setVolume(page, 0));
  report.cases.push({ name: "volume zero", ...morph(zeroTrace, "#vol-icon", "full", "muted") });
  assert.equal(zeroTrace.frames.at(-1).muted, true);
  await capture(page, () => page.keyboard.press("m"));
  assert.equal((await sample(page)).volume, .5, "Unmuting zero volume must restore the established default");

  const reversal = await page.evaluate(async () => {
    const button = document.querySelector("#play-btn"), path = document.querySelector("#play-icon [data-morph-path]");
    window.__iconStart(); button.click();
    await new Promise(resolveFrame => setTimeout(resolveFrame, 85));
    const before = path.getAttribute("d"); button.click(); const after = path.getAttribute("d");
    await new Promise(resolveFrame => setTimeout(resolveFrame, 400));
    const trace = window.__iconTrace; trace.stop(); return { before, after, frames: trace.frames, swaps: trace.swaps };
  });
  stable(reversal, "#play-icon");
  assert.equal(reversal.after, reversal.before, "Reversal must start from the currently painted path without a one-frame jump");
  assert.equal(reversal.frames.at(-1).icons["#play-icon"].state, "play");
  await endpoint(page, "#play-icon", "play");
  report.cases.push({ name: "rapid transport reversal", frames: reversal.frames.length });

  const volumeReversal = await page.evaluate(async () => {
    const button = document.querySelector("#mute-btn"), paths = () => [...document.querySelectorAll("#vol-icon [data-morph-path]")].map(path => path.getAttribute("d"));
    window.__iconStart(); button.click(); await new Promise(resolveFrame => setTimeout(resolveFrame, 85));
    const before = paths(); button.click(); const after = paths(); await new Promise(resolveFrame => setTimeout(resolveFrame, 400));
    const trace = window.__iconTrace; trace.stop(); return { before, after, frames: trace.frames, swaps: trace.swaps };
  });
  stable(volumeReversal, "#vol-icon"); assert.deepEqual(volumeReversal.after, volumeReversal.before);
  assert.equal(volumeReversal.frames.at(-1).icons["#vol-icon"].state, "full");
  report.cases.push({ name: "rapid volume reversal", frames: volumeReversal.frames.length });

  await page.screenshot({ path: `${artifacts}/desktop-icons.png` });
  assert.deepEqual(desktop.errors, []); await desktop.context.close();

  const mobile = await setup({ mobile: true }); page = mobile.page;
  const mobileTrace = await capture(page, () => page.locator("#big-play").tap());
  report.cases.push({ name: "mobile center actual morph", ...morph(mobileTrace, "#big-play svg", "play", "pause") });
  await endpoint(page, "#big-play svg", "pause");
  await page.locator("#settings-btn").tap();
  await page.waitForFunction(() => document.querySelector("#settings-panel").dataset.phase === "open");
  await endpoint(page, "#big-play svg", "pause");
  assert.equal(await page.locator("#big-play").evaluate(button => !!button.closest("[inert]") && getComputedStyle(button).pointerEvents === "none"), true,
    "Settings must retain the center glyph while its background control stays inert");
  await page.screenshot({ path: `${artifacts}/mobile-center-settings.png` });
  assert.deepEqual(mobile.errors, []); await mobile.context.close();

  const reduced = await setup({ reduced: true }); page = reduced.page;
  const reducedTrace = await capture(page, () => page.locator("#play-btn").click());
  stable(reducedTrace, "#play-icon");
  const reducedShapes = new Set(reducedTrace.frames.map(frame => JSON.stringify(frame.icons["#play-icon"].d)));
  assert.equal(reducedShapes.size, 2, "Reduced motion must switch directly between endpoints");
  await endpoint(page, "#play-icon", "pause");
  await page.locator("#player-wrap").focus();
  const reducedMute = await capture(page, () => page.keyboard.press("m"));
  stable(reducedMute, "#vol-icon");
  assert.equal(new Set(reducedMute.frames.map(frame => JSON.stringify(frame.icons["#vol-icon"].d))).size, 2, "Reduced-motion volume must switch directly between endpoint shapes");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("#play-btn").click();
  await page.waitForTimeout(75);
  const intermediate = await sample(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(40);
  const settledReduced = await sample(page);
  assert.notDeepEqual(intermediate.icons["#play-icon"].d, settledReduced.icons["#play-icon"].d, "Enabling reduced motion mid-morph must settle its remaining geometry");
  await endpoint(page, "#play-icon", "play");
  const afterReduced = await sample(page);
  assert.deepEqual(settledReduced.icons["#play-icon"].d, afterReduced.icons["#play-icon"].d, "Cancelled morph must not resume stale work");
  report.cases.push({ name: "reduced motion and live preference change", distinctShapes: reducedShapes.size });
  assert.deepEqual(reduced.errors, []); await reduced.context.close();

  // Force the fallback audio envelope so transient video.volume values actually
  // cross the icon thresholds. The icon must still follow selected volume.
  const smooth = await setup({ noAudio: true }); page = smooth.page;
  await page.locator("#play-btn").click(); await page.waitForTimeout(350);
  await page.locator("#settings-btn").click();
  await page.waitForFunction(() => document.querySelector("#settings-panel").dataset.phase === "open");
  await page.locator("#smooth-pause-toggle").click();
  await page.locator("#settings-close").click();
  await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
  const smoothTrace = await capture(page, () => page.locator("#play-btn").click());
  stable(smoothTrace, "#vol-icon");
  assert.ok(smoothTrace.frames.some(frame => frame.volume > 0 && frame.volume < .49), "Fallback Smooth Pause must produce a real temporary volume envelope");
  assert.ok(smoothTrace.frames.every(frame => frame.icons["#vol-icon"].state === "full"), "Temporary audio envelope must not change volume icon state");
  assert.ok(smoothTrace.frames.every(frame => frame.prefs.volume === .6 && !frame.muted), "Temporary audio envelope must not replace selected volume or mute");
  assert.equal(new Set(smoothTrace.frames.map(frame => JSON.stringify(frame.icons["#vol-icon"].d))).size, 1);
  report.cases.push({ name: "Smooth Pause retains nominal volume icon", frames: smoothTrace.frames.length });
  assert.deepEqual(smooth.errors, []); await smooth.context.close();
  console.log(`PASS ${report.cases.length} SVG icon morph cases`);
} catch (error) {
  report.failure = error.stack;
  if (page && !page.isClosed()) await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {});
  console.error(error.stack); process.exitCode = 1;
} finally {
  await writeFile(`${artifacts}/report.json`, JSON.stringify(report, null, 2));
  await browser.close(); await preview.close();
}
