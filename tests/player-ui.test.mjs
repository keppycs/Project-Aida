// Run with node --test tests/player-ui.test.mjs. Set AIDA_BROWSER_EXECUTABLE
// and AIDA_TEST_ARTIFACTS (an approved temporary directory). Optionally set
// AIDA_PLAYWRIGHT_MODULE to the installed Playwright package entry/directory.
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { playerMetadata, shakaFixtureScript } from "./player-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || "playwright");
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE;
const artifactRoot = process.env.AIDA_TEST_ARTIFACTS;
assert.ok(executablePath, "Set AIDA_BROWSER_EXECUTABLE to an approved Chromium executable.");
assert.ok(artifactRoot && path.isAbsolute(artifactRoot), "Set AIDA_TEST_ARTIFACTS to an approved absolute temporary directory.");
// Playwright's disposable browser profiles, downloads and diagnostics all stay here.
process.env.TEMP = artifactRoot;
process.env.TMP = artifactRoot;
process.env.TMPDIR = artifactRoot;
const docsRoot = fileURLToPath(new URL("../docs/", import.meta.url));
let browser, server, origin, runArtifacts;
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

before(async () => {
  await mkdir(artifactRoot, { recursive: true });
  runArtifacts = await mkdtemp(path.join(artifactRoot, "player-ui-"));
  server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const filename = path.resolve(docsRoot, `.${pathname}`);
    if (!filename.startsWith(docsRoot)) { response.writeHead(403).end(); return; }
    try {
      const bytes = await readFile(filename);
      response.writeHead(200, { "Content-Type": mime[path.extname(filename)] || "application/octet-stream" }).end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true, downloadsPath: runArtifacts });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function withPlayer(t, { width = 1280, height = 900, touch = false, prefs = {}, metadata = {} } = {}, check) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.addInitScript((values) => {
    localStorage.setItem("aida-player-prefs", JSON.stringify(values));
    localStorage.setItem("aida-cc-banner-dismissed", "1");
  }, prefs);
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.includes("shaka-player") && url.endsWith(".js")) {
      await route.fulfill({ contentType: "text/javascript", body: shakaFixtureScript });
    } else if (url.endsWith("/metadata.json")) {
      await route.fulfill({ json: { ...playerMetadata, ...metadata } });
    } else if (url.endsWith("/index.json")) {
      await route.fulfill({ json: [playerMetadata] });
    } else if (!url.startsWith(origin) || route.request().resourceType() === "image") {
      await route.abort();
    } else await route.continue();
  });
  try {
    await page.goto(`${origin}/watch.html?v=ui-regression`);
    await page.waitForFunction(() => !document.getElementById("player-wrap").inert);
    await check(page, context);
    assert.deepEqual(errors, [], "player has no uncaught browser errors");
  } catch (error) {
    const filename = t.name.replace(/[^a-z0-9]+/gi, "-").slice(0, 100);
    t.diagnostic(JSON.stringify(await page.evaluate(() => ({
      active: document.activeElement?.id,
      focusVisible: document.activeElement?.matches(":focus-visible"),
      paused: document.getElementById("video")?.paused,
      playerClass: document.getElementById("player-wrap")?.className,
    })).catch(() => ({}))));
    await page.screenshot({ path: path.join(runArtifacts, `${filename}.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}

async function media(page, expression) { return page.locator("#video").evaluate(expression); }
async function expectPaused(page, paused) {
  await page.waitForFunction((expected) => document.getElementById("video").paused === expected, paused);
}
async function openMobileMenu(page, menu) {
  await page.locator("#settings-btn").tap();
  await page.locator(`[data-open-menu='${menu}']`).tap();
  await page.locator(`#${menu}`).waitFor({ state: "visible" });
}
async function expectMenuClosed(page, menu, focus) {
  await page.locator(`#${menu}`).waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement.id), focus);
  assert.equal(await page.locator("body").evaluate((el) => el.classList.contains("player-sheet-open")), false);
}
async function touchEvent(cdp, type, x, y) {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y, id: 1 }] });
}

test("desktop shortcuts work after button focus and hover keeps playback time current", async (t) => {
  await withPlayer(t, {}, async (page) => {
    await page.locator("#play-btn").click();
    await expectPaused(page, false);
    await page.keyboard.press("k");
    await expectPaused(page, true);
    await page.keyboard.press("k");
    await expectPaused(page, false);
    await page.locator("#progress-wrap").hover();
    await page.evaluate(() => window.__aidaFixture.setTime(23));
    assert.equal(await page.locator("#cur-time").textContent(), "0:23");
    assert.equal(await page.locator("#progress-buffer").evaluate((el) => el.style.width), "75%");
    await page.locator("#mute-btn").click();
    await page.keyboard.press("m");
    assert.equal(await media(page, (video) => video.muted), false);
    await page.keyboard.press("l");
    assert.equal(await media(page, (video) => video.currentTime), 33);
  });
});

test("the first click on the big-play SVG path starts an unfocused player", async (t) => {
  await withPlayer(t, {}, async (page) => {
    assert.notEqual(await page.evaluate(() => document.activeElement.id), "big-play");
    await page.locator("#big-play path").click();
    await expectPaused(page, false);
  });
});

test("desktop resize and fullscreen retain volume; mouse surface works at narrow widths", async (t) => {
  await withPlayer(t, { prefs: { volume: 0.27 } }, async (page) => {
    await page.locator("#fs-btn").click();
    await page.waitForFunction(() => !!document.fullscreenElement);
    assert.equal(await media(page, (video) => video.volume), 0.27);
    await page.locator("#fs-btn").click();
    await page.waitForFunction(() => !document.fullscreenElement);
    await page.setViewportSize({ width: 520, height: 800 });
    assert.equal(await media(page, (video) => video.volume), 0.27);
    const box = await page.locator("#player-wrap").boundingBox();
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.4);
    await expectPaused(page, false);
    await page.waitForTimeout(220);
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.4);
    await expectPaused(page, true);
  });
});

test("codec switches preserve playback and ignore competing switches", async (t) => {
  await withPlayer(t, {}, async (page) => {
    await page.locator("#play-btn").click();
    await media(page, (video) => { video.currentTime = 37; video.volume = 0.32; video.muted = true; video.playbackRate = 1.5; });
    await page.locator("#quality-btn").click();
    await page.evaluate(() => window.__aidaFixture.holdNextLoad());
    await page.getByRole("button", { name: "HEVC codec", exact: true }).click();
    await page.waitForFunction(() => window.__aidaFixture.loads.length === 2);
    assert.equal(await page.getByRole("button", { name: "HLS streaming protocol", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "HLS streaming protocol", exact: true }).dispatchEvent("click");
    await page.evaluate(() => window.__aidaFixture.releaseLoad());
    await page.waitForFunction(() => document.getElementById("quality-menu").getAttribute("aria-busy") === "false");
    assert.deepEqual(await media(page, (video) => [video.currentTime, video.paused, video.volume, video.muted, video.playbackRate]), [37, false, 0.32, true, 1.5]);
    assert.equal(await page.evaluate(() => window.__aidaFixture.loads.length), 2);
    assert.equal(await page.locator("#quality-menu").evaluate((menu) => menu.contains(document.activeElement)), true, "source reload retains focus within its open menu");
    await media(page, (video) => { video.pause(); video.currentTime = 51; });
    await page.getByRole("button", { name: "HLS streaming protocol", exact: true }).click();
    await page.waitForFunction(() => window.__aidaFixture.loads.length === 3 && document.getElementById("quality-menu").getAttribute("aria-busy") === "false");
    assert.deepEqual(await media(page, (video) => [video.currentTime, video.paused]), [51, true]);
    await page.evaluate(() => window.__aidaFixture.holdNextLoad());
    await page.getByRole("button", { name: "AV1 codec", exact: true }).click();
    await page.waitForFunction(() => window.__aidaFixture.loads.length === 4);
    await page.locator("#quality-menu [data-close-menu]").click();
    await page.evaluate(() => window.__aidaFixture.releaseLoad());
    await page.waitForFunction(() => document.getElementById("quality-menu").getAttribute("aria-busy") === "false");
    await expectMenuClosed(page, "quality-menu", "quality-btn");
  });
});

test("responsive controls fit long timestamps and expanded volume at 561–900px widths", async (t) => {
  await withPlayer(t, { width: 720, prefs: { quality: 2160 }, metadata: { colorTransfer: "smpte2084" } }, async (page) => {
    await page.evaluate(() => { window.__aidaFixture.setDuration(7205); window.__aidaFixture.setTime(3661); });
    for (const width of [561, 600, 640, 720, 800, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator("#vol-cluster").hover();
      await page.waitForTimeout(230);
      const geometry = await page.locator("#ctrl-row").evaluate((row) => {
        const player = document.getElementById("player-wrap").getBoundingClientRect();
        const fullscreen = document.getElementById("fs-btn").getBoundingClientRect();
        return { overflow: row.scrollWidth > row.clientWidth + 1, fits: fullscreen.right <= player.right && fullscreen.left >= player.left };
      });
      assert.deepEqual(geometry, { overflow: false, fits: true }, `controls fit at ${width}px`);
    }
  });
});

for (const [width, height] of [[320, 740], [390, 844], [844, 390]]) {
  test(`mobile ${width}×${height}: controls fit, saved mute recovers, pause and replay stay visible`, async (t) => {
    await withPlayer(t, { width, height, touch: true, prefs: { muted: true, volume: 0.42 } }, async (page) => {
      const overflow = await page.locator("#ctrl-row").evaluate((row) => row.scrollWidth > row.clientWidth + 1);
      assert.equal(overflow, false, "primary controls never require horizontal scrolling");
      assert.equal(await page.locator("#mute-btn").isVisible(), true);
      await page.locator("#mute-btn").tap();
      assert.equal(await media(page, (video) => video.muted), false);
      await page.locator("#progress-wrap").scrollIntoViewIfNeeded();
      const timeline = await page.locator("#progress-wrap").boundingBox();
      await page.touchscreen.tap(timeline.x + timeline.width / 2, timeline.y + timeline.height / 2);
      assert.ok(Math.abs(await media(page, (video) => video.currentTime) - 60) < 1, "initial play control leaves the timeline tappable");
      await page.locator("#big-play svg").tap();
      await expectPaused(page, false);
      await page.locator("#big-play svg").tap();
      await expectPaused(page, true);
      assert.equal(await page.locator("#big-play").getAttribute("aria-label"), "Play video");
      assert.equal(await page.locator("#big-play").getAttribute("aria-hidden"), "false");
      await page.locator("#big-play svg").tap();
      await page.evaluate(() => window.__aidaFixture.end());
      assert.equal(await page.locator("#big-play").getAttribute("aria-hidden"), "false");
      await page.locator("#big-play svg").tap();
      await expectPaused(page, false);
      assert.equal(await media(page, (video) => video.currentTime), 0);
    });
  });
}

test("mobile settings quality/speed sheets close, restore focus and fit the viewport", async (t) => {
  await withPlayer(t, { width: 390, height: 844, touch: true }, async (page) => {
    await page.locator("#settings-btn").tap();
    assert.equal(await page.locator("#settings-menu").getAttribute("role"), "dialog");
    assert.equal(await page.locator("#settings-menu").getAttribute("aria-modal"), "true");
    const speedLink = page.locator("#settings-menu [data-open-menu='speed-menu']");
    await speedLink.focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("#settings-menu [data-close-menu]").evaluate((el) => document.activeElement === el), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await speedLink.evaluate((el) => document.activeElement === el), true);
    const volume = await media(page, (video) => video.volume);
    await page.setViewportSize({ width: 390, height: 780 });
    assert.equal(await page.locator("#settings-menu").isVisible(), true, "same-profile viewport changes retain the open sheet");
    assert.equal(await media(page, (video) => video.volume), volume);
    await page.locator("#settings-menu [data-close-menu]").tap();
    await expectMenuClosed(page, "settings-menu", "settings-btn");
    assert.equal(await page.locator("#settings-menu").getAttribute("role"), "group");
    assert.equal(await page.locator("#settings-menu").getAttribute("aria-modal"), null);
    await openMobileMenu(page, "quality-menu");
    const sheet = await page.locator("#quality-menu").boundingBox();
    assert.ok(sheet.x >= -1 && sheet.x + sheet.width <= 391 && sheet.y >= 0 && sheet.y + sheet.height <= 781);
    await page.locator("#quality-menu .menu-item[data-id='2']").tap();
    await expectMenuClosed(page, "quality-menu", "settings-btn");
    assert.equal(await page.locator("#quality-label").textContent(), "1080p120");
    await openMobileMenu(page, "speed-menu");
    await page.locator("#speed-menu [data-speed='1.5']").tap();
    await expectMenuClosed(page, "speed-menu", "settings-btn");
    assert.equal(await media(page, (video) => video.playbackRate), 1.5);
    await page.locator("#settings-btn").tap();
    await page.locator("#settings-menu [data-close-menu]").tap();
    await expectMenuClosed(page, "settings-menu", "settings-btn");
    await openMobileMenu(page, "quality-menu");
    await page.locator("#quality-menu [data-close-menu]").tap();
    await expectMenuClosed(page, "quality-menu", "settings-btn");
  });
});

test("real touch scrubbing survives auto-hide and pointer cancellation restores progress", async (t) => {
  await withPlayer(t, { width: 390, height: 844, touch: true }, async (page, context) => {
    const cdp = await context.newCDPSession(page);
    await page.locator("#big-play svg").tap();
    await page.locator("#progress-wrap").scrollIntoViewIfNeeded();
    const box = await page.locator("#progress-wrap").boundingBox();
    const y = box.y + box.height / 2;
    await touchEvent(cdp, "touchStart", box.x + box.width * 0.2, y);
    await touchEvent(cdp, "touchMove", box.x + box.width * 0.8, y);
    await page.waitForTimeout(3200);
    assert.equal(await page.locator("#player-wrap").evaluate((el) => el.classList.contains("ui-visible")), true);
    await touchEvent(cdp, "touchEnd");
    assert.ok(Math.abs(await media(page, (video) => video.currentTime) - 96) < 1);
    await page.evaluate(() => window.__aidaFixture.setTime(30));
    await touchEvent(cdp, "touchStart", box.x + box.width * 0.3, y);
    await touchEvent(cdp, "touchMove", box.x + box.width * 0.7, y);
    await touchEvent(cdp, "touchCancel");
    assert.equal(await media(page, (video) => video.currentTime), 30);
    assert.equal(await page.locator("#progress-fill").evaluate((el) => el.style.width), "25%");
    assert.equal(await page.locator("#progress-wrap").evaluate((el) => el.classList.contains("scrubbing")), false);
    await cdp.detach();
  });
});

test("touch surface first tap reveals controls; double tap seeks without toggling play", async (t) => {
  await withPlayer(t, { width: 390, height: 844, touch: true }, async (page) => {
    await page.locator("#big-play svg").tap();
    await expectPaused(page, false);
    await page.waitForFunction(() => !document.getElementById("player-wrap").classList.contains("ui-visible"));
    const box = await page.locator("#player-wrap").boundingBox();
    const x = box.x + box.width * 0.82, y = box.y + box.height * 0.4;
    await page.touchscreen.tap(x, y);
    await page.waitForFunction(() => document.getElementById("player-wrap").classList.contains("ui-visible"));
    await page.evaluate(() => window.__aidaFixture.setTime(30));
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(80);
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(350);
    assert.equal(await media(page, (video) => video.currentTime), 35);
    await expectPaused(page, false);
  });
});
