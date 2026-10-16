import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { PUBLIC_VIDEO_ID, startPlayerPreview } from "./support/player-preview.mjs";

const require = createRequire(import.meta.url);
const modules = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || `${modules}/playwright`);
const sharp = require(`${modules}/sharp`);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = process.env.AIDA_REVIEW_DIR || `C:/Users/keppy/AppData/Local/Temp/codex-work/aida-settings-layer-${Date.now()}`;
const baseline = process.argv.includes("--baseline");
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const preview = await startPlayerPreview();
const browser = await chromium.launch({ executablePath, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const results = [];
console.log(`Settings layer artifacts: ${artifacts}`);

async function settled(page, name = "home") {
  await page.waitForFunction(name => {
    const panel = document.querySelector("#settings-panel");
    return panel.dataset.phase === "open" && panel.dataset.page === name &&
      !panel.getAnimations({ subtree: true }).some(animation => animation.playState === "running");
  }, name);
}

async function paintCheck(page, label) {
  const state = await page.evaluate(() => {
    const panel = document.querySelector("#settings-panel"), body = document.querySelector("#settings-body");
    const image = document.querySelector("#more-videos-grid img"), row = document.querySelector("#speed-btn");
    const rect = body.getBoundingClientRect();
    // The page's six-pixel top padding is empty; use an interior x covered by the thumbnail.
    const point = { x: Math.round(rect.x + 32), y: Math.round(rect.y + 2) };
    const rowRect = row.getBoundingClientRect();
    return {
      phase: panel.dataset.phase, page: panel.dataset.page, point,
      panel: panel.getBoundingClientRect().toJSON(), body: rect.toJSON(),
      image: image.getBoundingClientRect().toJSON(),
      panelBackground: getComputedStyle(panel).backgroundColor,
      wrapperZIndex: getComputedStyle(document.querySelector("#player-wrap")).zIndex,
      recommendationInert: !!image.closest("[inert]"),
      rowHit: document.elementFromPoint(rowRect.x + rowRect.width / 2, rowRect.y + rowRect.height / 2)?.closest("button")?.id,
    };
  });
  assert.ok(state.point.x > state.image.left && state.point.x < state.image.right && state.point.y > state.image.top && state.point.y < state.image.bottom,
    "The recommendation must overlap the sampled sheet gutter to exercise the stacking bug");
  const screenshot = await page.screenshot({ path: `${artifacts}/${label}.png` });
  const { data, info } = await sharp(screenshot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (state.point.y * info.width + state.point.x) * info.channels;
  state.pixel = [...data.subarray(offset, offset + 3)];
  results.push({ label, ...state });
  await writeFile(`${artifacts}/results.json`, JSON.stringify(results, null, 2));
  assert.deepEqual(state.pixel, [27, 29, 32], "Settings must paint its opaque background above later recommendation thumbnails");
  assert.equal(state.rowHit, "speed-btn", "Settings must remain the actual touch target");
  assert.equal(state.recommendationInert, true);
  return state;
}

try {
  for (const width of [424]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const errors = [];
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await context.addInitScript(() => {
      localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360, muted: true }));
      localStorage.setItem("aida-cc-banner-dismissed", "1");
    });
    await context.route("**/local/index.json", route => route.fulfill({ contentType: "application/json", body: JSON.stringify([
      { id: PUBLIC_VIDEO_ID, title: "ive got nuts of steel", description: "Public player review fixture.\nSettings must remain above recommendations.\nAll playback uses the public 120 fps video.", tags: ["public fixture", "120 fps"], visibility: "public", frameRate: 120 },
      { id: "settings-layer-public-fixture", title: "Public recommendation fixture", visibility: "public", createdAt: 1774446541, duration: 12, frameRate: 120 },
    ]) }));
    await context.route("**/local/settings-layer-public-fixture/*", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="405"><path fill="#f00" d="M0 0h720v405H0z"/></svg>' }));
    if (baseline) {
      const oldCss = await readFile(process.env.AIDA_BASELINE_MOBILE_CSS || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-mobile-settings-layer-1792113842495/web/css/player-mobile.css", "utf8");
      await context.route("**/css/player-mobile.css?*", route => route.fulfill({ contentType: "text/css", body: oldCss }));
    }
    await page.goto(preview.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#watch-stage").getAttribute("aria-busy") === "false" && document.querySelector("video").readyState >= 2 && document.querySelector("#more-videos-grid img")?.naturalWidth > 0);
    await page.evaluate(async () => {
      const video = document.querySelector("video");
      video.pause();
      const decoded = new Promise((resolveFrame, rejectFrame) => {
        const timeout = setTimeout(() => rejectFrame(new Error("Public review frame did not decode")), 15000);
        video.requestVideoFrameCallback(() => { clearTimeout(timeout); resolveFrame(); });
      });
      video.currentTime = 6;
      await decoded;
      const image = document.querySelector("#more-videos-grid img").getBoundingClientRect();
      const gear = document.querySelector("#settings-btn").getBoundingClientRect();
      // Move toward recommendations while keeping the real player opener in the viewport.
      const target = innerHeight - 107;
      const delta = Math.max(1, Math.min(image.y + image.height / 2 - target, gear.y - 50));
      scrollBy(0, delta);
    });
    const cdp = await context.newCDPSession(page);
    const tap = async selector => {
      const rect = await page.locator(selector).boundingBox();
      assert.ok(rect && rect.y >= 0 && rect.y + rect.height <= 900, `${selector} must be visible for a real touch`);
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await page.waitForTimeout(100);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    await tap("#settings-btn");
    await settled(page);
    await paintCheck(page, `${width}-${baseline ? "baseline" : "corrected"}-settings-home`);
    await tap("#quality-btn");
    await settled(page, "quality");
    assert.ok(await page.locator("#quality-menu button").count() > 0);
    await page.screenshot({ path: `${artifacts}/${width}-quality-detail.png` });
    await tap("#settings-back");
    await settled(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), "quality-btn");
    await tap("#settings-close");
    await page.waitForFunction(() => document.querySelector("#settings-panel").dataset.phase === "closed");
    assert.equal(await page.evaluate(() => document.activeElement.id), "settings-btn");
    assert.equal(await page.locator("#more-videos").evaluate(node => node.inert), false);
    await tap("#settings-btn");
    await settled(page);
    await paintCheck(page, `${width}-reopened-settings-home`);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
    assert.equal(await page.evaluate(() => document.activeElement.id), "settings-btn");
    assert.deepEqual(errors, []);
    results.push({ width, interactions: "native touch open/detail/back/close/reopen, Escape and focus restoration passed", errors });
    console.log(`PASS ${width}px: populated recommendations remain below Settings; native touch navigation and focus restoration passed`);
    await context.close();
  }
} finally {
  await writeFile(`${artifacts}/results.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await preview.close();
}
