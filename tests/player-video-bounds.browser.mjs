import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { startPlayerPreview } from "./support/player-preview.mjs";

const require = createRequire(import.meta.url);
const modules = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || `${modules}/playwright`);
const sharp = require(`${modules}/sharp`);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = process.env.AIDA_REVIEW_DIR || resolve("logs", `player-video-bounds-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const preview = await startPlayerPreview();
const browser = await chromium.launch({ executablePath, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const report = { cases: [], errors: [] };
let page;
console.log(`Video bounds artifacts: ${artifacts}`);

async function checkBottomSeam(name, picture, shaded) {
  const gradient = page.locator(".grad-bot");
  const original = await gradient.evaluate(element => {
    const original = element.style.cssText;
    element.style.transition = "none"; element.style.opacity = "0";
    return original;
  });
  await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
  const plain = await page.screenshot();
  await gradient.evaluate((element, original) => {
    element.style.opacity = "1";
    requestAnimationFrame(() => { element.style.cssText = original; });
  }, original);
  const pixels = async data => sharp(data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const [before, after] = await Promise.all([pixels(plain), pixels(shaded)]);
  const dpr = before.info.width / (await page.evaluate(() => innerWidth));
  const left = Math.ceil((picture.left + picture.width * .2) * dpr);
  const right = Math.floor((picture.right - picture.width * .2) * dpr);
  const rows = [];
  for (let y = Math.floor(picture.bottom * dpr) - 3; y <= Math.ceil(picture.bottom * dpr) + 1; y++) {
    if (y < 0 || y >= before.info.height) continue;
    let base = 0, paint = 0, count = 0;
    for (let x = left; x < right; x++) {
      const offset = (y * before.info.width + x) * 3;
      const light = before.data[offset] + before.data[offset + 1] + before.data[offset + 2];
      if (light < 40) continue;
      base += light; paint += after.data[offset] + after.data[offset + 1] + after.data[offset + 2]; count++;
    }
    if (count > 10) rows.push({ y, attenuation: paint / base });
  }
  assert.ok(rows.length >= 2, `${name}: the decoded picture edge must be visible for a seam check`);
  const last = rows.at(-1), previous = rows.at(-2);
  report.cases.at(-1).bottomPaint = rows;
  assert.ok(last.attenuation <= previous.attenuation + .06 && last.attenuation < .4,
    `${name}: bottom picture row ${last.y} escaped the gradient (${last.attenuation.toFixed(3)} vs ${previous.attenuation.toFixed(3)} above)`);
}

async function check(name, touch, insets = { left: 0, right: 0, bottom: 0 }) {
  // A paused Chromium video can lose its painted frame when fullscreen changes.
  // Decode a real frame in the new bounds before inspecting its screenshot.
  await page.evaluate(async () => {
    const video = document.querySelector("video");
    if (video.paused && Number.isFinite(video.duration) && video.duration > 0) {
      const frame = new Promise(resolvePaint => video.requestVideoFrameCallback(resolvePaint));
      await video.play(); await frame; video.pause();
    }
  });
  await page.waitForTimeout(220);
  const value = await page.evaluate(() => {
    const video = document.querySelector("video"), box = video.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const width = video.videoWidth * scale, height = video.videoHeight * scale;
    const picture = { left: box.left + (box.width - width) / 2, right: box.right - (box.width - width) / 2,
      top: box.top + (box.height - height) / 2, bottom: box.bottom - (box.height - height) / 2, width, height };
    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    const surface = document.querySelector("#player-picture");
    return { picture, surface: { rect: surface.getBoundingClientRect().toJSON(), overflow: getComputedStyle(surface).overflow,
      containsTransport: ["video", "controls", "progress-touch-target", "big-play"].every(id => surface.contains(document.getElementById(id))),
      containsSettings: surface.contains(document.querySelector("#settings-panel")) },
      videoBox: box.toJSON(), controls: rect("#controls"), rail: rect("#progress-wrap"), target: rect("#progress-touch-target"),
      settings: rect("#settings-btn"), fullscreen: rect("#fs-btn"), center: rect("#big-play"),
      scrim: rect(".grad-bot"), title: rect("#title-bar"), viewport: { width: innerWidth, height: innerHeight } };
  });
  report.cases.push({ name, ...value });
  const screenshot = await page.screenshot({ path: resolve(artifacts, `${name}.png`) });
  const { picture, controls, rail, target, settings, fullscreen, center, scrim } = value;
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1, `${name}: ${label} (${actual} vs ${expected})`);
  assert.equal(value.surface.overflow, "hidden", `${name}: one shared surface must clip video and playback UI`);
  assert.equal(value.surface.containsTransport, true);
  assert.equal(value.surface.containsSettings, false, `${name}: Settings must retain its independent sheet bounds`);
  assert.ok(Math.abs(scrim.bottom - value.surface.rect.bottom) < .1 && scrim.height === (touch ? 64 : 72),
    `${name}: the gradient must retain its normal height and end at the shared clip`);
  near(controls.bottom, Math.min(picture.bottom - 4, value.viewport.height - insets.bottom), "controls must sit at the visible video's bottom");
  near(controls.left, Math.max(picture.left + (touch ? 8 : 12), insets.left), "controls must follow the visible video's left edge");
  near(controls.right, Math.min(picture.right - (touch ? 8 : 12), value.viewport.width - insets.right), "controls must follow the visible video's right edge");
  near(target.left, rail.left, "touch target must follow the seek rail");
  near(target.right, rail.right, "touch target must retain the seek rail width");
  near(target.y + target.height / 2, rail.y + rail.height / 2, "touch target must stay centered on the rail");
  near(scrim.top, picture.bottom - (touch ? 64 : 72), "readability fade must retain its position over the picture");
  near(scrim.bottom, picture.bottom, "readability scrim and video must share the fitted surface's bottom edge");
  near(scrim.left, picture.left, "readability scrim must fit the video width");
  near(scrim.right, picture.right, "readability scrim must fit the video width");
  near(center.x + center.width / 2, picture.left + picture.width / 2, "center play horizontal placement");
  near(center.y + center.height / 2, picture.top + picture.height / 2, "center play vertical placement");
  for (const [label, rect] of Object.entries({ settings, fullscreen, target })) {
    assert.ok(rect.top >= picture.top - 1 && rect.bottom <= picture.bottom + 1, `${name}: ${label} must remain over the picture`);
    assert.ok(rect.width >= 44 && rect.height >= 44, `${name}: ${label} must retain its touch target`);
  }
  if (!touch) near(value.title.top, picture.top, "title must follow the video's top edge");
  if (name.endsWith("fullscreen")) await checkBottomSeam(name, picture, screenshot);
  if (name === "phone-fullscreen") await page.screenshot({ path: resolve(artifacts, "phone-bottom-edge.png"),
    clip: { x: Math.ceil(picture.left), y: Math.floor(picture.bottom) - 24, width: Math.floor(picture.width), height: 48 } });
  console.log(`PASS ${name}`);
  return value;
}

try {
  for (const touch of [true, false]) {
    const context = await browser.newContext({ viewport: touch ? { width: 424, height: 924 } : { width: 1440, height: 1000 },
      deviceScaleFactor: Number(process.env.AIDA_BOUNDS_DPR || 1), hasTouch: touch, isMobile: touch });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => report.errors.push(error.message));
    await page.route("**/player/engine.js?*", async route => {
      const response = await route.fetch(), source = await response.text();
      assert.ok(source.includes("player = new shaka.Player();"));
      await route.fulfill({ response, body: source.replace("player = new shaka.Player();", "player = window.__boundsPlayback = new shaka.Player();") });
    });
    await context.addInitScript(() => {
      localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360, muted: true }));
      localStorage.setItem("aida-cc-banner-dismissed", "1");
    });
    await page.goto(preview.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#watch-status").hidden && !document.querySelector("#player-wrap").inert
      && document.querySelector("video").readyState >= 2, null, { timeout: 45000 });
    await page.evaluate(() => document.querySelector("video").pause());
    const label = touch ? "phone" : "desktop";
    const activate = selector => touch ? page.locator(selector).tap() : page.locator(selector).click();
    let landscapeSheetWidth;
    if (touch && !process.argv.includes("--seam-only")) {
      // Picture fitting must preserve the existing sheet layout. Measure it
      // inline rather than prescribing a separate landscape-width policy.
      await page.setViewportSize({ width: 924, height: 424 });
      await activate("#settings-btn");
      await page.waitForFunction(() => document.querySelector("#settings-panel").dataset.phase === "open");
      landscapeSheetWidth = (await page.locator("#settings-panel").boundingBox()).width;
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
      await page.setViewportSize({ width: 424, height: 924 });
    }
    await check(`${label}-inline`, touch);
    await activate("#fs-btn");
    await page.waitForFunction(() => document.fullscreenElement?.id === "player-wrap");
    await check(`${label}-fullscreen`, touch);
    if (process.argv.includes("--seam-only")) { await context.close(); continue; }
    if (touch) {
      await activate("#settings-btn");
      await page.waitForFunction(() => document.querySelector("#settings-panel").dataset.phase === "open");
      await page.waitForTimeout(400);
      const sheet = await page.locator("#settings-panel").boundingBox();
      assert.ok(Math.abs(sheet.y + sheet.height - 924) < 1, "Portrait Settings must remain at the device bottom");
      await page.screenshot({ path: resolve(artifacts, "phone-fullscreen-settings.png") });
      await page.setViewportSize({ width: 924, height: 424 });
      await page.waitForTimeout(300);
      const landscapeSheet = await page.locator("#settings-panel").boundingBox();
      assert.ok(Math.abs(landscapeSheet.y + landscapeSheet.height - 424) < 1, "Landscape Settings must remain at the device bottom");
      assert.ok(Math.abs(landscapeSheet.width - landscapeSheetWidth) < 1, "Fullscreen must preserve the existing landscape Settings width");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
      assert.equal(await page.evaluate(() => document.activeElement.id), "settings-btn");
      await check("phone-landscape-fullscreen", touch);
      await page.setViewportSize({ width: 424, height: 924 });
      const portrait = await check("phone-portrait-after-rotation", touch);
      // Real touch seeking must use the moved 44px target, without toggling playback.
      await page.touchscreen.tap(portrait.target.x + portrait.target.width * .4, portrait.target.y + 4);
      await page.waitForFunction(() => !document.querySelector("video").seeking);
      const seek = await page.locator("video").evaluate(video => ({ fraction: video.currentTime / video.duration, paused: video.paused }));
      assert.ok(Math.abs(seek.fraction - .4) < .02, "Moved seek target must seek to the touched fraction");
      assert.equal(seek.paused, true, "Seeking must not toggle playback");
      await activate("#big-play");
      await page.waitForFunction(() => !document.querySelector("video").paused);
      await activate("#big-play");
      await page.waitForFunction(() => document.querySelector("video").paused);
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 24, left: 0, right: 0, bottom: 34 } });
      await check("phone-portrait-safe-area", touch, { left: 0, right: 0, bottom: 34 });
      await page.setViewportSize({ width: 924, height: 424 });
      await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, left: 44, right: 44, bottom: 21 } });
      await check("phone-landscape-safe-area", touch, { left: 44, right: 44, bottom: 21 });
      await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, left: 0, right: 0, bottom: 0 } });
      await page.setViewportSize({ width: 424, height: 924 });
    } else {
      await page.setViewportSize({ width: 1000, height: 1440 });
      await check("desktop-portrait-fullscreen", touch);
    }
    await activate("#fs-btn");
    await page.waitForFunction(() => !document.fullscreenElement);
    await check(`${label}-fullscreen-return`, touch);
    // The Studio uses the shared player in a container whose ratio can vary.
    await page.locator("#player-wrap").evaluate(element => { element.style.height = "240px"; element.style.aspectRatio = "auto"; });
    await check(`${label}-short-container`, touch);
    await page.locator("#player-wrap").evaluate(element => { element.style.height = element.style.aspectRatio = ""; });
    await activate("#fs-btn");
    await page.waitForFunction(() => document.fullscreenElement?.id === "player-wrap");
    // Replace this test's media with real synthetic frames to exercise intrinsic
    // dimension changes independently of container resize or mocked getters.
    await page.evaluate(async () => {
      // Detach the fixture's DASH controller before assigning a different source.
      await window.__boundsPlayback.destroy();
      const canvas = document.createElement("canvas");
      canvas.width = 720; canvas.height = 1280;
      const paint = () => {
        const context = canvas.getContext("2d");
        context.fillStyle = "#24434d"; context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#b8cc2a"; context.fillRect(0, canvas.height * .45, canvas.width, canvas.height * .1);
      };
      paint();
      const stream = canvas.captureStream(0), video = document.querySelector("video");
      const metadata = new Promise(resolveReady => video.addEventListener("loadedmetadata", resolveReady, { once: true }));
      video.srcObject = stream;
      stream.getVideoTracks()[0].requestFrame();
      // Let the source's queued abort/emptied events settle before playing;
      // Smooth Pause correctly cancels pending playback on those events.
      await metadata;
      await video.play();
      window.__boundsSource = { canvas, paint, stream };
    });
    await page.waitForFunction(() => document.querySelector("video").videoWidth === 720);
    await page.evaluate(() => document.querySelector("video").pause());
    await check(`${label}-portrait-source`, touch);
    await page.evaluate(() => {
      const { canvas, paint, stream } = window.__boundsSource;
      canvas.width = canvas.height = 640; paint();
      void document.querySelector("video").play(); stream.getVideoTracks()[0].requestFrame();
    });
    await page.waitForFunction(() => document.querySelector("video").videoWidth === 640);
    await page.evaluate(() => document.querySelector("video").pause());
    await check(`${label}-changed-source-dimensions`, touch);
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.message;
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(artifacts, "failure.png") });
  process.exitCode = 1;
  console.error(error.stack);
} finally {
  await browser.close();
  await preview.close();
  await writeFile(resolve(artifacts, "results.json"), JSON.stringify(report, null, 2), { flag: "wx" });
}
