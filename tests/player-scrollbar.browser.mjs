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
const artifacts = process.env.AIDA_REVIEW_DIR || `C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-scrollbar-${Date.now()}`;
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const preview = await startPlayerPreview();
const filter = process.argv.find(argument => argument.startsWith("--profile="))?.split("=")[1];
const profiles = [
  { name: "classic-desktop", mode: "classic", width: 1440, height: 900 },
  { name: "overlay-desktop", mode: "overlay", width: 1440, height: 900 },
  { name: "phone424", mode: "overlay", width: 424, height: 924, touch: true },
].filter(profile => !filter || profile.name === filter);
assert.ok(profiles.length, `Unknown scrollbar profile: ${filter}`);
const report = { modes: [], profiles: [] };
let browser, page;
console.log(`Scrollbar artifacts: ${artifacts}`);

const painted = page => page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
const settled = (page, name = "home") => page.waitForFunction(name => {
  const panel = document.querySelector("#settings-panel");
  return panel.dataset.phase === "open" && panel.dataset.page === name
    && !panel.getAnimations({ subtree: true }).some(animation => animation.playState === "running");
}, name);
async function geometry(page) {
  return page.evaluate(() => {
    const body = document.querySelector("#settings-body"), thumb = document.querySelector("#settings-scroll-thumb");
    const row = body.querySelector(".settings-page:not([hidden]) .menu-item"), style = getComputedStyle(body);
    return { body: body.getBoundingClientRect().toJSON(), row: row.getBoundingClientRect().toJSON(),
      rowPadding: [getComputedStyle(row).paddingLeft, getComputedStyle(row).paddingRight],
      client: body.clientWidth, offset: body.offsetWidth, height: body.clientHeight, extent: body.scrollHeight,
      scroll: body.scrollTop, gutter: style.scrollbarGutter, overflow: style.overflowY,
      thumb: thumb.getBoundingClientRect().toJSON(), hidden: thumb.hidden, tabIndex: thumb.tabIndex,
      min: Number(thumb.getAttribute("aria-valuemin")), max: Number(thumb.getAttribute("aria-valuemax")),
      now: Number(thumb.getAttribute("aria-valuenow")), transform: getComputedStyle(thumb).transform,
      focus: document.activeElement.id, rootScroll: scrollY };
  });
}
function fullWidth(value, label) {
  assert.equal(value.overflow, "auto", `${label}: native auto overflow must own scrolling`);
  assert.equal(value.offset - value.client, 0, `${label}: Settings must reserve no native scrollbar lane`);
  assert.equal(value.gutter, "auto", `${label}: Settings must not reserve a potential scrollbar gutter`);
  assert.ok(Math.abs(value.row.x - value.body.x) < .5 && Math.abs(value.row.right - value.body.right) < .5,
    `${label}: row background must reach both body edges`);
  assert.deepEqual(value.rowPadding, ["16px", "16px"], `${label}: text must retain equal16px insets without compensating lanes`);
  for (const number of [value.thumb.x, value.thumb.y, value.thumb.width, value.thumb.height, value.min, value.max, value.now]) {
    assert.ok(Number.isFinite(number), `${label}: thumb geometry/ARIA must remain finite`);
  }
}
async function touch(cdp, type, x, y) {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y }] });
}
async function activate(page, cdp, profile, selector) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  if (!profile.touch) return page.locator(selector).click();
  const box = await page.locator(selector).boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  await touch(cdp, "touchStart", x, y);
  await page.waitForTimeout(70);
  await touch(cdp, "touchEnd");
}
async function scrollTop(page, value) {
  await page.locator("#settings-body").evaluate((body, value) => { body.scrollTop = value; }, value);
  await painted(page);
}
async function addRows(page, selector = "#settings-home") {
  await page.locator(selector).evaluate(home => {
    for (let index = 0; index < 30; index++) {
      const row = document.createElement("button");
      row.type = "button"; row.className = "menu-item scrollbar-fixture";
      row.id = `scrollbar-fixture-${index}`; row.textContent = `Public scroll fixture ${index + 1}`;
      home.append(row);
    }
  });
  await page.waitForFunction(() => !document.querySelector("#settings-scroll-thumb").hidden);
  await painted(page);
}
async function assertAria(page, label) {
  await painted(page);
  const value = await geometry(page);
  assert.equal(await page.locator("#settings-scroll-thumb").getAttribute("role"), "scrollbar");
  assert.equal(await page.locator("#settings-scroll-thumb").getAttribute("aria-controls"), "settings-body");
  assert.equal(await page.locator("#settings-scroll-thumb").getAttribute("aria-orientation"), "vertical");
  assert.equal(value.min, 0, `${label}: ARIA minimum`);
  assert.ok(value.max > 0 && value.now >= 0 && value.now <= value.max, `${label}: current ARIA value must be within actual scroll range`);
  const physical = value.scroll / (value.extent - value.height), accessible = value.now / value.max;
  assert.ok(Math.abs(physical - accessible) <= .015, `${label}: accessible thumb position must follow native scrollTop`);
  return value;
}

async function runProfile(profile) {
  const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height },
    deviceScaleFactor: 1, hasTouch: !!profile.touch, isMobile: !!profile.touch });
  const result = { name: profile.name, errors: [] };
  report.profiles.push(result);
  await context.addInitScript(() => {
    localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360, muted: true }));
    localStorage.setItem("aida-cc-banner-dismissed", "1");
    window.__scrollbarPointerIds = [];
    document.addEventListener("pointerdown", event => {
      if (event.target.closest("#settings-scroll-thumb")) window.__scrollbarPointerIds.push(event.pointerId);
    }, true);
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => result.errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await page.goto(preview.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#watch-status").hidden && !document.querySelector("#player-wrap").inert
    && document.querySelector("video").readyState >= 2, null, { timeout: 45000 });
  await page.evaluate(() => document.querySelector("video").pause());
  await activate(page, cdp, profile, "#settings-btn");
  await settled(page);
  await page.waitForFunction(() => document.querySelector("#settings-scroll-thumb"));
  result.short = await geometry(page);
  fullWidth(result.short, `${profile.name} short`);
  assert.ok(result.short.extent <= result.short.height + 1, "Home must start without overflow");
  assert.equal(result.short.hidden, true, "No-overflow thumb must not paint");
  assert.equal(await page.locator("#settings-scroll-thumb").evaluate(thumb => {
    thumb.focus(); return document.activeElement === thumb;
  }), false, "Hidden scrollbar must not accept restored/programmatic focus");
  await page.screenshot({ path: `${artifacts}/${profile.name}-short.png` });

  // Exercise a real source-generated quality row, rather than only synthetic
  // home options. Keep Auto plus the first rendition for the short endpoint.
  await activate(page, cdp, profile, "#quality-btn"); await settled(page, "quality");
  await page.locator("#quality-menu-content > .menu-item").evaluateAll(rows => rows.slice(2).forEach(row => { row.hidden = true; }));
  await page.waitForFunction(() => document.querySelector("#settings-scroll-thumb").hidden);
  await painted(page);
  result.qualityShort = await geometry(page); fullWidth(result.qualityShort, `${profile.name} quality short`);
  assert.ok(result.qualityShort.extent <= result.qualityShort.height + 1, "Short quality fixture must not overflow");
  await addRows(page, "#quality-menu");
  result.qualityOverflow = await geometry(page); fullWidth(result.qualityOverflow, `${profile.name} quality overflow`);
  for (const key of ["x", "width"]) assert.ok(Math.abs(result.qualityShort.row[key] - result.qualityOverflow.row[key]) < .5,
    `Quality overflow must not change row ${key}`);
  if (!profile.touch) {
    const qualityRow = page.locator("#quality-menu-content > .menu-item").nth(1);
    await qualityRow.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0); await qualityRow.evaluate(row => row.blur()); await page.waitForTimeout(200);
    const before = await sharp(await qualityRow.screenshot()).raw().toBuffer({ resolveWithObject: true });
    await qualityRow.hover(); await page.waitForTimeout(200);
    const after = await sharp(await qualityRow.screenshot()).raw().toBuffer({ resolveWithObject: true });
    const pixel = (image, x) => [...image.data.subarray((2 * image.info.width + x) * image.info.channels,
      (2 * image.info.width + x) * image.info.channels + 3)];
    assert.deepEqual(pixel(after, 1), pixel(after, after.info.width - 2), "Hovered quality row must paint equally at both edges");
    assert.notDeepEqual(pixel(before, 1), pixel(after, 1), "Hover must actually paint the full-width quality background");
  }
  await page.screenshot({ path: `${artifacts}/${profile.name}-quality-overflow-hover.png` });
  await page.locator("#quality-menu .scrollbar-fixture").evaluateAll(rows => rows.forEach(row => row.remove()));
  await page.locator("#quality-menu-content > .menu-item").evaluateAll(rows => rows.forEach(row => { row.hidden = false; }));
  await activate(page, cdp, profile, "#settings-back"); await settled(page);

  await addRows(page);
  result.overflow = await assertAria(page, `${profile.name} overflow`);
  fullWidth(result.overflow, `${profile.name} overflow`);
  assert.equal(result.overflow.tabIndex, 0, "Overflow thumb must be keyboard reachable");
  for (const key of ["x", "width"]) assert.ok(Math.abs(result.short.row[key] - result.overflow.row[key]) < .5,
    `Overflow must not change row ${key}`);
  assert.ok(result.overflow.thumb.width >= 12 && result.overflow.thumb.height >= 28, "Slim thumb must retain its drag hit area");
  assert.ok(result.overflow.thumb.right <= result.overflow.body.right + .5
    && result.overflow.thumb.x > result.overflow.body.right - 20, "Thumb must overlay the inside right edge");

  const body = await page.locator("#settings-body").boundingBox();
  const rootBeforeScroll = await page.evaluate(() => scrollY);
  if (profile.touch) {
    const x = body.x + body.width * .45, from = body.y + body.height * .8, to = body.y + body.height * .25;
    await touch(cdp, "touchStart", x, from); await page.waitForTimeout(60);
    for (let step = 1; step <= 8; step++) {
      await touch(cdp, "touchMove", x, from + (to - from) * step / 8); await page.waitForTimeout(25);
    }
    await touch(cdp, "touchEnd");
  } else {
    await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
    await page.mouse.wheel(0, 200);
  }
  await page.waitForFunction(() => document.querySelector("#settings-body").scrollTop > 10);
  await page.waitForTimeout(250);
  result.nativeScroll = await assertAria(page, `${profile.name} native wheel/touch`);
  assert.ok(result.nativeScroll.thumb.y > result.overflow.thumb.y + 1, "Overlay thumb must follow native scrolling");
  assert.equal(await page.evaluate(() => scrollY), rootBeforeScroll, "Settings scrolling must not scroll the background");
  // A native touch on a static header cancels fling momentum before drag setup.
  if (profile.touch) {
    const heading = await page.locator("#settings-heading").boundingBox();
    await touch(cdp, "touchStart", heading.x + heading.width / 2, heading.y + heading.height / 2); await touch(cdp, "touchEnd");
    await settled(page);
  }
  await scrollTop(page, 0);

  const thumbBox = await page.locator("#settings-scroll-thumb").boundingBox();
  const x = thumbBox.x + thumbBox.width / 2, start = thumbBox.y + thumbBox.height / 2;
  const to = Math.min(body.y + body.height - 6, start + Math.min(100, body.height / 3));
  if (profile.touch) {
    await touch(cdp, "touchStart", x, start); await touch(cdp, "touchMove", x, to); await touch(cdp, "touchCancel");
  } else {
    await page.mouse.move(x, start); await page.mouse.down(); await page.mouse.move(x, to, { steps: 8 }); await page.mouse.up();
  }
  await page.waitForFunction(() => document.querySelector("#settings-body").scrollTop > 20);
  result.drag = await assertAria(page, `${profile.name} thumb drag`);
  assert.equal(await page.locator("#settings-panel").getAttribute("data-phase"), "open", "Thumb drag/cancellation must not dismiss the sheet");
  if (profile.touch) assert.equal(await page.locator("#settings-scroll-thumb").evaluate(thumb => {
    const pointerId = window.__scrollbarPointerIds.at(-1);
    return pointerId !== undefined && thumb.hasPointerCapture(pointerId);
  }), false,
    "Cancelled native touch must release capture");
  if (!profile.touch) {
    await scrollTop(page, 0);
    const penBox = await page.locator("#settings-scroll-thumb").boundingBox();
    const penX = penBox.x + penBox.width / 2, penY = penBox.y + penBox.height / 2;
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: penX, y: penY, button: "left", buttons: 1, clickCount: 1, pointerType: "pen" });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: penX, y: Math.min(body.y + body.height - 6, penY + 75), buttons: 1, pointerType: "pen" });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: penX, y: Math.min(body.y + body.height - 6, penY + 75), button: "left", buttons: 0, clickCount: 1, pointerType: "pen" });
    await page.waitForFunction(() => document.querySelector("#settings-body").scrollTop > 20);
    result.penDrag = await assertAria(page, `${profile.name} pen thumb drag`);
  }
  await page.locator("#settings-scroll-thumb").focus();
  await page.keyboard.press("Home"); await page.waitForFunction(() => document.querySelector("#settings-body").scrollTop < 1);
  await page.keyboard.press("ArrowDown"); await page.waitForFunction(() => document.querySelector("#settings-body").scrollTop > 1);
  assert.equal(await page.evaluate(() => document.activeElement.id), "settings-scroll-thumb", "Arrow scroll must not navigate to another menu item");
  await page.keyboard.press("End");
  await page.waitForFunction(() => { const body = document.querySelector("#settings-body"); return Math.abs(body.scrollTop - body.scrollHeight + body.clientHeight) < 1; });
  result.keyboardEnd = await assertAria(page, `${profile.name} End`);
  await page.keyboard.press("PageUp"); await page.waitForFunction(before => document.querySelector("#settings-body").scrollTop < before - 10, result.keyboardEnd.scroll);
  await page.keyboard.press("PageDown"); await page.waitForFunction(before => document.querySelector("#settings-body").scrollTop >= before - 1, result.keyboardEnd.scroll);
  const focused = await page.locator("#settings-scroll-thumb").evaluate(thumb => {
    const style = getComputedStyle(thumb); return { outline: style.outlineStyle, shadow: style.boxShadow, tap: style.webkitTapHighlightColor };
  });
  assert.equal(focused.outline, "none", "Thumb focus must not introduce the rejected outline");
  assert.equal(focused.shadow, "none", "Thumb focus must not introduce a perimeter ring");
  assert.equal(focused.tap, "rgba(0, 0, 0, 0)", "Thumb must suppress the native tap flash");

  // A tiny viewport has no usable drag track. It must hide cleanly instead of
  // dividing by zero or retaining focus on an unpainted scroll affordance.
  await page.locator("#settings-body").evaluate(body => { body.style.maxHeight = "1px"; });
  await page.waitForFunction(() => document.querySelector("#settings-scroll-thumb").hidden);
  const tiny = await geometry(page);
  for (const value of [tiny.min, tiny.max, tiny.now, tiny.thumb.y, tiny.thumb.height]) assert.ok(Number.isFinite(value), "Tiny scroll viewport must not produce NaN thumb geometry");
  assert.notEqual(await page.evaluate(() => document.activeElement.id), "settings-scroll-thumb", "Hidden thumb must yield focus to a visible Settings control");
  await page.locator("#settings-body").evaluate(body => { body.style.maxHeight = ""; });
  await page.waitForFunction(() => !document.querySelector("#settings-scroll-thumb").hidden);
  await painted(page);

  await scrollTop(page, 0);
  await page.locator("#scrollbar-fixture-29").focus(); await painted(page);
  const focusReveal = await page.locator("#scrollbar-fixture-29").boundingBox(), focusBody = await page.locator("#settings-body").boundingBox();
  assert.ok(focusReveal.y >= focusBody.y - 1 && focusReveal.y + focusReveal.height <= focusBody.y + focusBody.height + 1, "Native focus must reveal an offscreen menu item");
  await assertAria(page, `${profile.name} focus reveal`);
  await page.locator("#speed-btn").focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.id), "quality-btn", "Menu ArrowDown must keep navigating menu options");
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement.id), "scrollbar-fixture-29", "End on a menu option must select the last option, not the sibling scrollbar");

  // Layout work is measured after geometry has settled, across32 scroll frames.
  // Setting native scrollTop is the input; a thumb should only repaint/transform.
  await cdp.send("Performance.enable"); await painted(page);
  const metric = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(item => [item.name, item.value]));
  const beforeMetrics = await metric();
  await page.evaluate(async () => {
    const body = document.querySelector("#settings-body"), max = body.scrollHeight - body.clientHeight;
    for (let index = 0; index < 32; index++) {
      body.scrollTop = max * index / 31;
      await new Promise(resolveFrame => requestAnimationFrame(resolveFrame));
    }
  });
  await painted(page);
  const afterMetrics = await metric();
  result.scrollLayoutCount = afterMetrics.LayoutCount - beforeMetrics.LayoutCount;
  assert.ok(result.scrollLayoutCount <= 3, `Thumb tracking must not cause per-scroll-frame layout: ${result.scrollLayoutCount} layouts/32 frames`);

  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await page.setViewportSize({ width: profile.touch ? 360 : 1100, height: profile.touch ? 800 : 700 });
  await painted(page);
  // Desktop profile changes intentionally dismiss Settings; reopen that same
  // mounted surface after it settles. Mobile rotation/resize stays in place.
  await page.waitForFunction(() => ["open", "closed"].includes(document.querySelector("#settings-panel").dataset.phase));
  if (await page.locator("#settings-panel").getAttribute("data-phase") === "closed") await activate(page, cdp, profile, "#settings-btn");
  await settled(page);
  result.enlarged = await assertAria(page, `${profile.name} enlarged text and resized viewport`);
  fullWidth(result.enlarged, `${profile.name} enlarged`);
  assert.ok(result.enlarged.thumb.bottom <= result.enlarged.body.bottom + 1 && result.enlarged.thumb.y >= result.enlarged.body.y - 1,
    "Resized thumb must remain inside the native scroll viewport");
  await scrollTop(page, 0);
  await page.locator("#speed-btn").focus(); await page.keyboard.press("Enter");
  await page.waitForTimeout(45);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
  assert.equal(await page.evaluate(() => document.activeElement.id), "settings-btn", "Interrupted page navigation must return focus to Settings");
  await activate(page, cdp, profile, "#settings-btn"); await settled(page);
  await page.locator("#settings-home .scrollbar-fixture").evaluateAll(rows => rows.forEach(row => row.remove()));
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
  await page.setViewportSize({ width: profile.width, height: profile.height });
  await painted(page);
  await page.waitForFunction(() => ["open", "closed"].includes(document.querySelector("#settings-panel").dataset.phase));
  if (await page.locator("#settings-panel").getAttribute("data-phase") === "closed") await activate(page, cdp, profile, "#settings-btn");
  await settled(page);
  await page.waitForFunction(() => document.querySelector("#settings-scroll-thumb").hidden);
  await painted(page);
  result.restored = await geometry(page); fullWidth(result.restored, `${profile.name} restored`);
  assert.equal(await page.locator("#settings-scroll-thumb").evaluate(thumb => {
    thumb.focus(); return document.activeElement === thumb;
  }), false, "Removing overflow must make the thumb nonfocusable again");
  for (const key of ["x", "width"]) assert.ok(Math.abs(result.short.row[key] - result.restored.row[key]) < .5, `Removing overflow must restore row ${key}`);
  assert.deepEqual(result.errors, []);
  console.log(`PASS ${profile.name}: zero gutters, full-width hover, native scrolling, thumb drag/cancel/keys, focus, resize and scroll layout budget`);
  await context.close();
}

try {
  for (const mode of ["classic", "overlay"]) {
    const selected = profiles.filter(profile => profile.mode === mode);
    if (!selected.length) continue;
    browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ["--hide-scrollbars"],
      args: ["--enable-automation", "--autoplay-policy=no-user-gesture-required", `${mode === "classic" ? "--disable-features" : "--enable-features"}=OverlayScrollbar`] });
    const session = await browser.newBrowserCDPSession();
    assert.ok(!(await session.send("Browser.getBrowserCommandLine")).arguments.includes("--hide-scrollbars"), "Overlay mode must not be faked with hidden browser scrollbars");
    const probe = await browser.newPage();
    await probe.setContent('<div style="width:200px;height:100px;overflow:scroll"><div style="height:500px">Native scrollbar probe</div></div>');
    const nativeGutter = await probe.locator("div").first().evaluate(element => element.offsetWidth - element.clientWidth);
    assert.ok(mode === "classic" ? nativeGutter > 0 : nativeGutter === 0, `Expected real${mode} scrollbars, measured${nativeGutter}px`);
    report.modes.push({ mode, nativeGutter, hideScrollbars: false, browserVersion: browser.version() });
    await probe.close();
    for (const profile of selected) await runProfile(profile);
    await browser.close(); browser = null;
  }
} catch (error) {
  report.failure = error.stack;
  if (page && !page.isClosed()) await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${artifacts}/report.json`, JSON.stringify(report, null, 2));
  await browser?.close();
  await preview.close();
}
