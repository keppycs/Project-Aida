import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { startPlayerPreview } from "./support/player-preview.mjs";

const require = createRequire(import.meta.url);
const runtime = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || runtime);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
// Keep Playwright's video helper and profile lookup inside this task's approved browser folder.
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const artifacts = process.env.AIDA_REVIEW_DIR || `C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-v2-${Date.now()}`;
await mkdir(artifacts, { recursive: true });
process.env.TEMP = artifacts;
process.env.TMP = artifacts;
console.log(`Review artifacts: ${artifacts}`);
const preview = await startPlayerPreview();
const browser = await chromium.launch({
  executablePath, headless: !process.argv.includes("--headed"),
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const results = [];
let activeContext;

async function check(name, action) {
  try {
    const detail = await action();
    results.push({ name, passed: true, detail });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.stack });
    console.error(`FAIL ${name}: ${error.message}`);
    if (activeContext?.pages()[0]) console.error("Failure player state", await activeContext.pages()[0].evaluate(() => ({
      wrap: document.querySelector("#player-wrap")?.className,
      phase: document.querySelector("#settings-panel")?.dataset.phase,
      page: document.querySelector("#settings-panel")?.dataset.page,
      inert: document.querySelector("#settings-panel")?.inert,
      panelAnimations: document.querySelector("#settings-panel")?.getAnimations({ subtree: true }).map((animation) => ({ state: animation.playState, time: animation.currentTime })),
      focus: document.activeElement?.id,
    })).catch(() => ({})));
    if (activeContext?.pages()[0]) await activeContext.pages()[0].screenshot({ path: `${artifacts}/failure-${results.length}.png` }).catch(() => {});
    throw error;
  }
}

async function createReviewPage(viewport, { touch = false, reducedMotion = "no-preference", video = false } = {}) {
  const context = await browser.newContext({
    viewport, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1,
    reducedMotion, ...(video ? { recordVideo: { dir: artifacts, size: viewport } } : {}),
  });
  activeContext = context;
  await context.route("https://fonts.googleapis.com/**", (route) => route.abort());
  await context.route("https://fonts.gstatic.com/**", (route) => route.abort());
  await context.route("**/eruda@*/**", (route) => route.abort());
  await context.addInitScript(() => {
    localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360, muted: true }));
    localStorage.setItem("aida-cc-banner-dismissed", "1");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(preview.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#watch-status")?.hidden && !document.querySelector("#player-wrap")?.inert, null, { timeout: 45000 });
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2, null, { timeout: 45000 });
  await page.evaluate(() => document.querySelector("video").pause());
  await page.locator("#player-wrap").scrollIntoViewIfNeeded();
  // Wait for the initially visible chrome to paint before geometry screenshots.
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector("#controls")).opacity) > 0.99 && !document.querySelector("#spinner").classList.contains("show"), null, { timeout: 15000 });
  return { context, page };
}

const settingsState = () => {
  const panel = document.querySelector("#settings-panel");
  const body = document.querySelector("#settings-body");
  const style = getComputedStyle(panel);
  const matrix = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
  return {
    hidden: panel.hidden, inert: panel.inert, phase: panel.dataset.phase,
    page: panel.dataset.page, opacity: Number(style.opacity),
    transform: style.transform, y: matrix.m42, x: matrix.m41,
    height: panel.getBoundingClientRect().height,
    bodyHeight: body.getBoundingClientRect().height,
    focus: document.activeElement?.id || document.activeElement?.tagName,
  };
};

async function settled(page, state = "open") {
  await page.waitForFunction((phase) => {
    const panel = document.querySelector("#settings-panel");
    return panel.dataset.phase === phase && !panel.getAnimations({ subtree: true }).some((animation) => animation.playState === "running");
  }, state);
}

async function sampleAfterAction(page, selector, delay = 50) {
  await page.evaluate(({ selector, delay }) => {
    const target = document.querySelector(selector);
    window.__reviewSample = new Promise((resolveSample) => {
      target.addEventListener("click", () => {
        let immediatelyInert;
        queueMicrotask(() => { immediatelyInert = document.querySelector("#settings-panel").inert; });
        setTimeout(() => {
          const panel = document.querySelector("#settings-panel");
          const body = document.querySelector("#settings-body");
          const style = getComputedStyle(panel);
          const pages = [...body.querySelectorAll(".settings-page")].map((element) => ({
            id: element.id, hidden: element.hidden, inert: element.inert,
            opacity: Number(getComputedStyle(element).opacity), transform: getComputedStyle(element).transform,
            x: new DOMMatrixReadOnly(getComputedStyle(element).transform === "none" ? undefined : getComputedStyle(element).transform).m41,
          }));
          resolveSample({
            opacity: Number(style.opacity), transform: style.transform,
            hidden: panel.hidden, inert: panel.inert, phase: panel.dataset.phase,
            immediatelyInert,
            height: panel.getBoundingClientRect().height,
            bodyHeight: body.getBoundingClientRect().height, pages,
          });
        }, delay);
      }, { once: true });
    });
  }, { selector, delay });
  await page.locator(selector).click();
  return page.evaluate(() => window.__reviewSample);
}

async function geometry(page, label) {
  const metrics = await page.evaluate(() => {
    const rect = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const wrap = rect("#player-wrap"), center = rect("#big-play");
    const row = rect("#ctrl-row"), track = rect("#progress-track");
    return {
      wrap, center, row, track,
      centerErrorX: Math.abs(center.x + center.width / 2 - wrap.x - wrap.width / 2),
      centerErrorY: Math.abs(center.y + center.height / 2 - wrap.y - wrap.height / 2),
      railGap: row.y - track.bottom,
      overflow: document.documentElement.scrollWidth - innerWidth,
      buttons: [...document.querySelectorAll("#player-wrap button")].filter((button) => {
        const style = getComputedStyle(button);
        return !button.closest("[hidden], [inert]") && style.visibility !== "hidden" && style.display !== "none" && button.getBoundingClientRect().height > 0;
      }).map((button) => ({ id: button.id, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
    };
  });
  assert.ok(metrics.centerErrorX <= 1, `${label}: center x off by ${metrics.centerErrorX}px`);
  assert.ok(metrics.centerErrorY <= 1, `${label}: center y off by ${metrics.centerErrorY}px`);
  assert.ok(Math.abs(metrics.row.height - 44) <= 1, `${label}: utility row ${metrics.row.height}px`);
  assert.ok(metrics.railGap >= 0 && metrics.railGap <= 8, `${label}: visible rail ${metrics.railGap}px above utility row`);
  assert.ok(metrics.overflow <= 1, `${label}: horizontal overflow ${metrics.overflow}px`);
  for (const button of metrics.buttons) {
    assert.ok(button.width >= 43.9 && button.height >= 43.9, `${label}: ${button.id} target ${button.width}×${button.height}px`);
  }
  return metrics;
}

async function seekAndDecode(page, time) {
  return page.evaluate(async (time) => {
    const video = document.querySelector("video");
    video.pause();
    const decoded = new Promise((resolveFrame, rejectFrame) => {
      const timeout = setTimeout(() => rejectFrame(new Error("No decoded frame after seek")), 15000);
      video.requestVideoFrameCallback((_, frame) => { clearTimeout(timeout); resolveFrame(frame.mediaTime); });
    });
    video.currentTime = time;
    return decoded;
  }, time);
}

async function stepDecoded(page, key) {
  await page.locator("#player-wrap").focus();
  await page.evaluate(() => {
    const video = document.querySelector("video");
    window.__decodedStep = new Promise((resolveFrame, rejectFrame) => {
      const timeout = setTimeout(() => rejectFrame(new Error("Frame-step did not decode")), 15000);
      video.requestVideoFrameCallback((_, frame) => { clearTimeout(timeout); resolveFrame({ mediaTime: frame.mediaTime, time: video.currentTime, paused: video.paused }); });
    });
  });
  await page.keyboard.press(key);
  return page.evaluate(() => window.__decodedStep);
}

async function realScrub(page, context, touch) {
  const rail = await page.locator("#progress-wrap").boundingBox();
  const from = { x: rail.x + rail.width * 0.2, y: rail.y + rail.height / 2 };
  const to = { x: rail.x + rail.width * 0.62, y: from.y };
  if (touch) {
    const session = await context.newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
    // An instantaneous synthetic fling makes Chromium suppress the following tap's
    // compatibility click. Preserve normal finger cadence and the live input session.
    await page.waitForTimeout(80);
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: (from.x + to.x) / 2, y: to.y }] });
    await page.waitForTimeout(40);
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [to] });
    await page.waitForTimeout(80);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
  }
  await page.waitForFunction(() => !document.querySelector("video").seeking);
  const result = await page.evaluate(() => ({ time: document.querySelector("video").currentTime, duration: document.querySelector("video").duration, paused: document.querySelector("video").paused }));
  assert.ok(Math.abs(result.time / result.duration - 0.62) < 0.03, `scrub ended at ${result.time}/${result.duration}`);
  assert.equal(result.paused, true, "scrubbing a paused video must stay paused");
  return result;
}

async function captureMotionDemo(viewport, touch, label) {
  const demo = await createReviewPage(viewport, { touch, video: true });
  const activate = (selector) => touch ? demo.page.locator(selector).tap() : demo.page.locator(selector).click();
  await seekAndDecode(demo.page, 6);
  await demo.page.locator("#player-wrap").screenshot({ path: `${artifacts}/${label}-controls.png` });
  await demo.page.waitForTimeout(250);
  await activate("#settings-btn");
  await settled(demo.page);
  await demo.page.waitForTimeout(700);
  await activate("#quality-btn");
  await settled(demo.page);
  await demo.page.screenshot({ path: `${artifacts}/${label}-settings.png` });
  await demo.page.waitForTimeout(700);
  await activate("#settings-back");
  await settled(demo.page);
  await demo.page.waitForTimeout(500);
  await activate("#speed-btn");
  await settled(demo.page);
  await demo.page.waitForTimeout(700);
  await activate("#settings-back");
  await settled(demo.page);
  await demo.page.waitForTimeout(500);
  await activate("#settings-close");
  await settled(demo.page, "closed");
  await demo.page.waitForTimeout(500);
  const clip = demo.page.video();
  await demo.context.close();
  await clip.saveAs(`${artifacts}/${label}-motion.webm`);
  return `${artifacts}/${label}-motion.webm`;
}

try {
  if (!process.argv.includes("--demo-only")) {
  for (const viewport of [{ width: 360, height: 800 }, { width: 424, height: 900 }, { width: 430, height: 932 }, { width: 844, height: 390 }, { width: 1440, height: 1000 }]) {
    const touch = viewport.width < 1000;
    const { page, context } = await createReviewPage(viewport, { touch });
    await check(`true center and compact controls at ${viewport.width}×${viewport.height}`, () => geometry(page, `${viewport.width}`));
    await page.locator("#player-wrap").screenshot({ path: `${artifacts}/player-${viewport.width}.png` });
    await context.close();
  }

  const desktop = await createReviewPage({ width: 1440, height: 1000 });
  const page = desktop.page;
  await check("settings entrance has visible intermediate motion", async () => {
    const frame = await sampleAfterAction(page, "#settings-btn");
    assert.equal(frame.hidden, false);
    assert.ok(frame.opacity > 0 && frame.opacity < 1, `entry opacity=${frame.opacity}`);
    await settled(page);
    const after = await page.evaluate(settingsState);
    assert.equal(after.opacity, 1);
    const translation = await page.evaluate((transform) => {
      const matrix = new DOMMatrixReadOnly(transform === "none" ? undefined : transform);
      return { x: matrix.m41, y: matrix.m42 };
    }, frame.transform);
    assert.ok(Math.abs(translation.x - after.x) > 0.1 || Math.abs(translation.y - after.y) > 0.1, "entry must have actual intermediate displacement");
    return frame;
  });
  await check("settings page transition moves and interpolates height", async () => {
    const before = await page.evaluate(settingsState);
    const frame = await sampleAfterAction(page, "#quality-btn");
    await settled(page);
    const after = await page.evaluate(settingsState);
    assert.equal(after.page, "quality");
    assert.ok(frame.pages.some((item) => !item.hidden && item.opacity > 0 && Math.abs(item.x) > 0.1), "page swap has no intermediate moving content");
    assert.ok(Math.abs(after.height - before.height) > 2, "quality should have a distinct natural panel height");
    assert.ok(Math.abs(frame.height - before.height) > 0.5 && Math.abs(frame.height - after.height) > 0.5, `height jumped ${before.height} -> ${frame.height} -> ${after.height}`);
    await page.screenshot({ path: `${artifacts}/desktop-quality.png` });
    return { before, frame, after };
  });
  await check("back returns home and restores trigger focus", async () => {
    const frame = await sampleAfterAction(page, "#settings-back");
    await settled(page);
    assert.equal((await page.evaluate(settingsState)).page, "home");
    assert.equal(await page.evaluate(() => document.activeElement.id), "quality-btn");
    assert.ok(frame.pages.some((item) => !item.hidden && item.opacity > 0 && Math.abs(item.x) > 0.1), "back has no sliding frame");
    return frame;
  });
  await check("exit animates while becoming inert immediately", async () => {
    const frame = await sampleAfterAction(page, "#settings-close");
    assert.equal(frame.immediatelyInert, true);
    assert.equal(frame.inert, true);
    assert.equal(frame.hidden, false, "hiding immediately clips the exit animation");
    assert.ok(frame.opacity > 0 && frame.opacity < 1, `exit opacity=${frame.opacity}`);
    await settled(page, "closed");
    const after = await page.evaluate(settingsState);
    assert.equal(after.hidden, true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "settings-btn");
    return frame;
  });
  await check("rapid toggles settle without stranding a panel", async () => {
    // A real pointer press must still reach the gear before the previous motion ends.
    for (let index = 0; index < 5; index++) {
      await page.locator("#settings-btn").click({ force: true });
      await page.waitForTimeout(25);
    }
    await settled(page);
    let state = await page.evaluate(settingsState);
    assert.equal(state.hidden, false);
    assert.equal(state.inert, false);
    assert.equal(state.opacity, 1);
    await page.locator("#settings-close").click();
    await settled(page, "closed");
    state = await page.evaluate(settingsState);
    assert.equal(state.hidden, true);
    return state;
  });
  await check("quality exit can reverse without a page or height jump", async () => {
    await page.locator("#settings-btn").click();
    await settled(page);
    await page.locator("#quality-btn").click();
    await settled(page);
    const before = await page.evaluate(settingsState);
    await page.locator("#settings-btn").click({ force: true });
    await page.waitForTimeout(30);
    await page.locator("#settings-btn").click({ force: true });
    const reopened = await page.evaluate(settingsState);
    assert.equal(reopened.page, "quality");
    assert.ok(Math.abs(reopened.height - before.height) <= 1, `quality height jumped ${before.height} -> ${reopened.height}`);
    await settled(page);
    assert.equal((await page.evaluate(settingsState)).page, "quality");
    await page.locator("#settings-close").click();
    await settled(page, "closed");
    return { before, reopened };
  });
  await check("outside dismissal never toggles playback", async () => {
    await page.locator("#settings-btn").click();
    await settled(page);
    const wrap = await page.locator("#player-wrap").boundingBox();
    await page.mouse.click(wrap.x + 20, wrap.y + 20);
    await settled(page, "closed");
    await page.waitForTimeout(350);
    assert.equal(await page.locator("video").evaluate((video) => video.paused), true);
  });
  await check("mouse drag scrubs the real media", () => realScrub(page, desktop.context, false));
  await check("period and comma decode adjacent 120 fps source frames", async () => {
    const initial = await seekAndDecode(page, 6);
    const forward = await stepDecoded(page, ".");
    const backward = await stepDecoded(page, ",");
    assert.ok(Math.abs(forward.mediaTime - initial - 1 / 120) < 0.0011, `decoded forward ${initial} -> ${forward.mediaTime}`);
    assert.ok(Math.abs(backward.mediaTime - initial) < 0.0011, `decoded backward ${backward.mediaTime}, expected ${initial}`);
    assert.ok(Math.abs(forward.time - (6 + 1 / 120)) < 0.0011, `currentTime forward ${forward.time}`);
    assert.equal(forward.paused, true);
    assert.equal(backward.paused, true);
    return { initial, forward, backward };
  });
  await desktop.context.close();

  const mobile = await createReviewPage({ width: 424, height: 900 }, { touch: true });
  await check("touch drag scrubs the real media", () => realScrub(mobile.page, mobile.context, true));
  await check("first Settings tap after touch seeking opens and traps visible focus targets", async () => {
    await mobile.page.locator("#settings-btn").tap();
    await settled(mobile.page);
    const visited = [];
    for (let index = 0; index < 12; index++) {
      await mobile.page.keyboard.press("Tab");
      const target = await mobile.page.evaluate(() => {
        const element = document.activeElement;
        return { id: element.id, inside: !!element.closest("#settings-panel"), hidden: !!element.closest("[hidden], [inert]"), visible: element.getBoundingClientRect().height > 0 };
      });
      assert.equal(target.inside, true, `focus escaped to ${target.id}`);
      assert.equal(target.hidden, false, `focus entered hidden ${target.id}`);
      assert.equal(target.visible, true);
      visited.push(target.id);
    }
    await mobile.page.locator("#speed-btn").tap();
    await settled(mobile.page);
    await mobile.page.screenshot({ path: `${artifacts}/mobile-speed.png` });
    await mobile.page.locator("#settings-back").tap();
    await settled(mobile.page);
    await mobile.page.locator("#quality-btn").tap();
    await settled(mobile.page);
    await mobile.page.screenshot({ path: `${artifacts}/mobile-quality.png` });
    await mobile.page.locator("#settings-back").tap();
    await settled(mobile.page);
    await mobile.page.locator("#settings-close").tap();
    await settled(mobile.page, "closed");
    return visited;
  });
  await mobile.context.close();

  const reduced = await createReviewPage({ width: 430, height: 932 }, { touch: true, reducedMotion: "reduce" });
  await check("reduced motion keeps a brief fade without displacement", async () => {
    const frame = await sampleAfterAction(reduced.page, "#settings-btn", 35);
    assert.ok(frame.opacity > 0 && frame.opacity < 1, `reduced motion entry opacity=${frame.opacity}`);
    const matrix = await reduced.page.evaluate((transform) => {
      const matrix = new DOMMatrixReadOnly(transform === "none" ? undefined : transform);
      return { x: matrix.m41, y: matrix.m42 };
    }, frame.transform);
    await settled(reduced.page);
    const after = await reduced.page.evaluate(settingsState);
    assert.ok(Math.abs(matrix.x - after.x) < 0.1 && Math.abs(matrix.y - after.y) < 0.1, "reduced motion must suppress spatial movement");
    const exit = await sampleAfterAction(reduced.page, "#settings-close", 35);
    assert.ok(exit.opacity > 0 && exit.opacity < 1, `reduced motion exit opacity=${exit.opacity}`);
    assert.equal(exit.inert, true);
    assert.equal(exit.immediatelyInert, true);
    await settled(reduced.page, "closed");
    return { frame, exit };
  });
  await reduced.context.close();
  }
  await check("record deliberate mobile motion review", () => captureMotionDemo({ width: 424, height: 900 }, true, "mobile"));
  await check("record deliberate desktop motion review", () => captureMotionDemo({ width: 1440, height: 1000 }, false, "desktop"));
} catch (error) {
  process.exitCode = 1;
  console.error(error.stack);
} finally {
  await activeContext?.close().catch(() => {});
  await browser.close();
  await preview.close();
  await writeFile(`${artifacts}/results.json`, JSON.stringify({ url: preview.url, results }, null, 2));
  console.log(`Review artifacts: ${artifacts}`);
  console.log(`${results.filter((result) => result.passed).length}/${results.length} checks passed`);
}
