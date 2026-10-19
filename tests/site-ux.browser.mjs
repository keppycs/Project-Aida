import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { PUBLIC_VIDEO_ID, startPlayerPreview } from "./support/player-preview.mjs";
import { rewriteWatchHtml } from "../edge/share-worker.mjs";

const require = createRequire(import.meta.url);
const modules = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || `${modules}/playwright`);
const sharp = require(`${modules}/sharp`);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = process.env.AIDA_REVIEW_DIR || `C:/Users/keppy/AppData/Local/Temp/codex-work/aida-site-ux-${Date.now()}`;
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const preview = await startPlayerPreview();
const filter = process.argv.find(argument => argument.startsWith("--profile="))?.split("=")[1];
const videosOnly = process.argv.includes("--videos-only");
const profiles = [
  { name: "classic-desktop", mode: "classic", width: 1440, height: 900 },
  { name: "overlay-desktop", mode: "overlay", width: 1440, height: 900 },
  { name: "phone360", mode: "overlay", width: 360, height: 800, touch: true },
  { name: "phone424", mode: "overlay", width: 424, height: 924, touch: true },
  { name: "landscape844", mode: "overlay", width: 844, height: 390, touch: true },
].filter(profile => !filter || profile.name === filter);
assert.ok(profiles.length, `Unknown site UX profile: ${filter}`);
const publicEntry = { id: PUBLIC_VIDEO_ID, title: "Public 120 fps motion study", description: "A public video fixture for reviewing the videos page and player.",
  createdAt: 1774446542, duration: 25.963, frameRate: 120, width: 2560, height: 1440, codecs: ["AV1", "HEVC"], visibility: "public", tags: ["public", "120 fps", "a", "4K"] };
const catalog = [publicEntry, ...Array.from({ length: 23 }, (_, index) => ({ id: `ux-${index}`, title: `Motion study ${String(index + 2).padStart(2, "0")}`,
  description: "Public synthetic catalog fixture", createdAt: 1774446541 - index, duration: 12 + index, frameRate: 120, visibility: "public", tags: ["public"] }))];
const longTitle = `Long title ${"UnbrokenText".repeat(30)}`;
const thumbnail = '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="405"><path fill="#23372e" d="M0 0h720v405H0z"/><path fill="#40594b" d="m0 405 200-250 165 165 130-90 225 175z"/></svg>';
const results = { modes: [], profiles: [] };
let browser, page;
console.log(`Site UX artifacts: ${artifacts}`);

const painted = page => page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
async function state(page, selectors) {
  return page.evaluate(selectors => ({
    viewport: innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
    rootOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
    rootGutter: getComputedStyle(document.documentElement).scrollbarGutter,
    anchors: Object.fromEntries(selectors.map(selector => {
      const element = document.querySelector(selector);
      return [selector, element?.getClientRects().length ? element.getBoundingClientRect().toJSON() : null];
    })),
  }), selectors);
}
function horizontalStable(before, after, label, optional = []) {
  for (const [selector, rect] of Object.entries(before.anchors)) {
    const next = after.anchors[selector];
    if (optional.includes(selector) && (!rect || !next)) continue;
    assert.ok(rect && next, `${label}: required geometry anchor ${selector} must remain present`);
    for (const dimension of ["x", "width"]) assert.ok(Math.abs(rect[dimension] - next[dimension]) < .5,
      `${label}: ${selector} ${dimension} shifted ${next[dimension] - rect[dimension]}px`);
  }
}
async function noHorizontalOverflow(page, label) {
  const geometry = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
    main: document.querySelector("main")?.getBoundingClientRect().toJSON() }));
  assert.ok(geometry.scroll <= geometry.client + 1, `${label}: horizontal overflow ${JSON.stringify(geometry)}`);
}
async function clearAligned(page) {
  const geometry = await page.evaluate(() => ({ input: document.querySelector("#search-input").getBoundingClientRect().toJSON(),
    button: document.querySelector("#search-clear").getBoundingClientRect().toJSON() }));
  assert.ok(geometry.button.width >= 44 && geometry.button.height >= 44, "Search clear must retain a44px target");
  assert.ok(Math.abs(geometry.input.y + geometry.input.height / 2 - geometry.button.y - geometry.button.height / 2) < .25,
    "Clear must stay vertically centered in its input");
}
async function centeredHeaderSearch(page, label) {
  const geometry = await page.evaluate(() => {
    const header = document.querySelector(".site-header"), form = document.querySelector("#search-form");
    return { header: header.getBoundingClientRect().toJSON(), form: form.getBoundingClientRect().toJSON(),
      brand: header.querySelector(".brand").getBoundingClientRect().toJSON(),
      input: document.querySelector("#search-input").getBoundingClientRect().toJSON(),
      headerOwnsForm: form.closest("header") === header, stacked: matchMedia("(max-width: 700px)").matches };
  });
  const { header, form, brand, input } = geometry;
  assert.equal(geometry.headerOwnsForm, true, `${label}: search must belong to the header`);
  assert.ok(Math.abs(form.x + form.width / 2 - header.x - header.width / 2) < .5, `${label}: search must be centered in the header`);
  assert.ok(form.x >= header.x - .5 && form.right <= header.right + .5 && form.y >= header.y && form.bottom <= header.bottom,
    `${label}: search must fit within the header`);
  const overlapsX = Math.min(form.right, brand.right) - Math.max(form.x, brand.x) > .5;
  const overlapsY = Math.min(form.bottom, brand.bottom) - Math.max(form.y, brand.y) > .5;
  assert.ok(!(overlapsX && overlapsY), `${label}: search and brand must not collide`);
  assert.ok(input.width >= 44 && input.height >= 44, `${label}: search must retain a44px target`);
  if (geometry.stacked) {
    assert.ok(brand.bottom <= form.y, `${label}: mobile search must sit below the brand`);
    assert.ok(Math.abs(form.width - header.width) < .5, `${label}: mobile search must use the full header width`);
  }
  return geometry;
}
function neutralColor(color, label) {
  const channels = color.match(/[\d.]+/g)?.map(Number) || [];
  assert.ok(channels.length >= 3 && (channels.length < 4 || channels[3] > 0), `${label}: a visible color is required, received ${color}`);
  assert.ok(Math.max(...channels.slice(0, 3)) - Math.min(...channels.slice(0, 3)) <= 24,
    `${label}: search feedback must be neutral, received ${color}`);
}
async function focusPresentation(page, selector, { caretOnly = false, activate = null } = {}) {
  if (caretOnly) assert.equal(selector, "#search-input", "Caret-only feedback is limited to the search input");
  const read = element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return { rect: { x: rect.x, y: rect.y + scrollY, width: rect.width, height: rect.height }, outline: style.outlineStyle,
      outlineWidth: style.outlineWidth, shadow: style.boxShadow,
      border: ["Top", "Right", "Bottom", "Left"].map(side => Number.parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== "none"
        ? [style[`border${side}Width`], style[`border${side}Style`], style[`border${side}Color`]] : "unpainted"), background: style.backgroundColor, color: style.color,
      focused: document.activeElement === element, caret: style.caretColor };
  };
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.locator(selector).evaluate(element => element.blur());
  await page.mouse.move(0, 0);
  await painted(page);
  const before = await page.locator(selector).evaluate(read);
  if (activate) await activate();
  else {
    await page.keyboard.press("Tab");
    await page.locator(selector).evaluate(element => element.focus({ preventScroll: true }));
  }
  await page.waitForTimeout(220);
  const after = await page.locator(selector).evaluate(read);
  assert.ok(after.outline === "none" || Number.parseFloat(after.outlineWidth) === 0, `${selector} must not acquire an outline`);
  assert.equal(after.shadow, before.shadow, `${selector} must not acquire a focus shadow/ring`);
  assert.deepEqual(after.border, before.border, `${selector} must not acquire an interaction border`);
  for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(after.rect[key] - before.rect[key]) < .2, `${selector} focus changed ${key}`);
  if (caretOnly) {
    assert.equal(after.focused, true, "Search must retain native focus");
    assert.equal(after.background, before.background, "Search focus must not highlight its background");
    assert.equal(after.color, before.color, "Search focus must not change its text color");
    const rgb = color => (color.match(/[\d.]+/g) || []).map(Number);
    const caret = rgb(after.caret), background = rgb(after.background);
    assert.ok(caret.length >= 3 && (caret.length < 4 || caret[3] > 0), "Search caret must remain visible");
    assert.ok(Math.max(...caret.slice(0, 3).map((channel, index) => Math.abs(channel - background[index]))) >= 100,
      "Search caret must contrast with the unchanged input background");
  } else assert.ok(after.background !== before.background || after.color !== before.color, `${selector} needs geometry-stable visible keyboard feedback`);
  return { before, after };
}
async function caretSearchPresentation(page, cdp, touch, label) {
  const input = page.locator("#search-input"), modes = {};
  for (const mode of ["pointer", "keyboard", ...(touch ? ["touch"] : [])]) {
    modes[mode] = await focusPresentation(page, "#search-input", { caretOnly: true,
      activate: mode === "pointer" ? () => input.click() : mode === "touch" ? async () => {
        const box = await input.boundingBox();
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
        await page.waitForTimeout(100);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } : null });
    const value = await input.inputValue();
    await page.keyboard.press("End");
    await page.keyboard.insertText("x");
    assert.equal(await input.inputValue(), `${value}x`, `${label} ${mode}: focused native search must remain editable`);
    await page.keyboard.press("Backspace");
    assert.equal(await input.inputValue(), value);
    assert.equal(await input.evaluate(element => element.selectionStart === element.selectionEnd), true, "Search caret must be collapsed after editing");
  }
  const selection = await page.locator("#search-input").evaluate(input => {
    const style = getComputedStyle(input, "::selection");
    return { background: style.backgroundColor, color: style.color };
  });
  neutralColor(selection.background, `${label} selected text background`);
  return { modes, selection };
}
async function doubleText(page) {
  await page.evaluate(() => {
    // Snapshot first so inherited sizes are doubled exactly once, including px-based styles.
    const sizes = [...document.querySelectorAll("body *")].map(element => [element, Number.parseFloat(getComputedStyle(element).fontSize)]);
    for (const [element, size] of sizes) if (size > 0) element.style.setProperty("font-size", `${size * 2}px`, "important");
  });
  await painted(page);
}
async function nativeScroll(page, cdp, touch, selector = null) {
  const before = await page.evaluate(selector => selector ? document.querySelector(selector).scrollTop : scrollY, selector);
  const rect = selector ? await page.locator(selector).boundingBox() : { x: 0, y: 0, width: (await page.viewportSize()).width, height: (await page.viewportSize()).height };
  if (touch) {
    const x = rect.x + rect.width * .55, from = rect.y + rect.height * .8, to = rect.y + rect.height * .25;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from }] });
    await page.waitForTimeout(60);
    for (let step = 1; step <= 8; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: from + (to - from) * step / 8 }] });
      await page.waitForTimeout(25);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await page.mouse.move(rect.x + rect.width * .55, rect.y + rect.height * .6);
    await page.mouse.wheel(0, 350);
  }
  await page.waitForFunction(({ selector, before }) => (selector ? document.querySelector(selector).scrollTop : scrollY) > before + 10, { selector, before }, { timeout: 4000 });
}
async function resetScroll(page, cdp, touch, selector = null) {
  if (touch) {
    // Stop native momentum on a non-actionable header/gutter before fixture setup.
    const point = selector ? await page.locator("#settings-heading").boundingBox() : { x: 0, y: 120, width: 8, height: 10 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x + point.width / 2, y: point.y + point.height / 2 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  await page.evaluate(selector => { if (selector) document.querySelector(selector).scrollTop = 0; else scrollTo(0, 0); }, selector);
  await painted(page);
}
async function seekPublicFrame(page) {
  await page.evaluate(async () => {
    const video = document.querySelector("video");
    video.pause();
    const decoded = new Promise((resolveFrame, rejectFrame) => {
      const timeout = setTimeout(() => rejectFrame(new Error("Public120fps review frame did not decode")), 15000);
      video.requestVideoFrameCallback(() => { clearTimeout(timeout); resolveFrame(); });
    });
    video.currentTime = 6;
    await decoded;
  });
  await page.waitForFunction(() => !document.querySelector("#spinner").classList.contains("show") && Number(getComputedStyle(document.querySelector("#spinner")).opacity) < .01
    && Number(getComputedStyle(document.querySelector("#controls")).opacity) > .99 && !document.querySelector("video").seeking);
  await painted(page);
}

async function runProfile(browser, profile) {
  const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: 1, hasTouch: !!profile.touch, isMobile: !!profile.touch });
  const result = { name: profile.name, states: {}, menu: {}, errors: [] };
  const debugRequests = [];
  context.on("request", request => { if (/eruda/i.test(request.url())) debugRequests.push(request.url()); });
  results.profiles.push(result);
  let catalogMode = "populated", releaseInitial, requestGate;
  let initialGate = new Promise(resolveCatalog => { releaseInitial = resolveCatalog; });
  await context.addInitScript(() => {
    localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360, muted: true }));
    localStorage.setItem("aida-cc-banner-dismissed", "1");
  });
  await context.route("**/local/index.json", async route => {
    if (initialGate) await initialGate;
    if (requestGate) { const heldRequest = requestGate; requestGate = null; await heldRequest; }
    const entries = catalogMode === "empty" ? [] : catalogMode === "long" ? catalog.map(entry => ({ ...entry, title: longTitle, tags: ["LongTag".repeat(35)] })) : catalog;
    await route.fulfill({ status: catalogMode === "error" ? 503 : 200, contentType: "application/json", body: JSON.stringify(entries) });
  });
  await context.route("**/local/ux-*/*", route => route.fulfill({ contentType: "image/svg+xml", body: thumbnail }));
  // A generated public fixture image makes visual review independent of CDN
  // thumbnail latency; the decoded watch frame still uses the real120fps media.
  await context.route(`**/local/${PUBLIC_VIDEO_ID}/thumbnail*`, route => route.fulfill({ contentType: "image/svg+xml", body: thumbnail }));
  await context.route(`**/local/${PUBLIC_VIDEO_ID}/metadata.json`, route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...publicEntry,
    colorPrimaries: "bt709", colorTransfer: "bt709", colorSpace: "bt709" }) }));
  await context.route("**/eruda@*/**", route => route.abort());
  page = await context.newPage();
  page.on("pageerror", error => result.errors.push(error.message));
  page.setDefaultTimeout(15000);
  const cdp = await context.newCDPSession(page);
  const anchors = [".site-header", ".brand", ".site-main", "#search-form", ".search-field", ".videos-toolbar", "#videos-grid > :first-child"];
  await page.goto(`${preview.origin}/index.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts.ready);
  result.states.loading = await state(page, anchors);
  assert.equal(await page.locator("#search-input").isDisabled(), true);
  await page.locator(".brand").focus();
  initialGate = null;
  releaseInitial();
  await page.waitForFunction(() => document.querySelector("#videos").getAttribute("aria-busy") === "false" && document.querySelectorAll("#videos-grid .video-card").length === 24);
  await painted(page);
  assert.equal(await page.evaluate(() => document.activeElement.matches(".brand")), true, "Initial loading completion must preserve focus moved to the home link");
  result.states.populated = await state(page, anchors);
  assert.equal(await page.evaluate(() => document.documentElement.clientWidth), profile.width, "Page chrome must reserve no scrollbar gutter");
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter), "auto");
  const pageThumb = page.locator(".site-page-thumb");
  await pageThumb.waitFor({ state: "visible" });
  const scrollGeometry = await pageThumb.evaluate(thumb => ({ width: thumb.getBoundingClientRect().width,
    height: thumb.getBoundingClientRect().height, max: document.documentElement.scrollHeight - innerHeight }));
  assert.equal(scrollGeometry.width, 10, "Only the thumb may occupy overlay space");
  assert.ok(scrollGeometry.height >= 44);
  await pageThumb.focus(); await pageThumb.press("End"); await painted(page);
  assert.ok(Math.abs(await page.evaluate(() => scrollY) - scrollGeometry.max) < 2, "Overlay keyboard access must scroll the actual document");
  await pageThumb.press("Home"); await painted(page);
  const thumbBox = await pageThumb.boundingBox(), dragY = Math.min(70, profile.height - thumbBox.height - 2);
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + 10);
  await page.mouse.down(); await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + 10 + dragY, { steps: 5 }); await page.mouse.up();
  await painted(page);
  assert.ok(await page.evaluate(() => scrollY) > 10, "Dragging the overlay thumb must scroll the actual document");
  assert.ok(page.url().includes("/index.html"), "Thumb drag must never activate an adjacent video");
  await page.evaluate(() => scrollTo(0, 0)); await painted(page);
  assert.equal(await page.locator(".search-label, label[for='search-input']").count(), 0, "Header search must not render a label");
  assert.equal(await page.getByRole("searchbox", { name: "Search", exact: true }).count(), 1, "Search must keep its accessible name");
  assert.equal(await page.locator("#search-input").getAttribute("placeholder"), "Search");
  result.searchHeader = { normal: await centeredHeaderSearch(page, `${profile.name} normal text`) };
  horizontalStable(result.states.loading, result.states.populated, `${profile.name} loading→populated`);
  await page.locator("#search-input").fill("zzzz-no-public-match");
  await page.waitForFunction(() => !document.querySelector("#videos-status").hidden && !document.querySelector("#videos-grid").children.length);
  await clearAligned(page);
  result.states.noResults = await state(page, anchors);
  horizontalStable(result.states.populated, result.states.noResults, `${profile.name} populated→no results`, ["#videos-grid > :first-child"]);
  await page.locator("#search-clear").click();
  await page.waitForFunction(() => document.querySelectorAll("#videos-grid .video-card").length === 24);
  result.states.cleared = await state(page, anchors);
  horizontalStable(result.states.populated, result.states.cleared, `${profile.name} clear search`);
  assert.equal(await page.evaluate(() => document.activeElement.id), "search-input");
  await noHorizontalOverflow(page, `${profile.name} videos page`);
  await resetScroll(page, cdp, profile.touch);
  await page.waitForFunction(() => [...document.querySelectorAll("#hero-img img")].every(image => image.complete && image.naturalWidth > 0));
  await page.screenshot({ path: `${artifacts}/${profile.name}-index.png` });
  await nativeScroll(page, cdp, profile.touch);
  await resetScroll(page, cdp, profile.touch);
  await page.locator("#videos-grid .video-card").first().focus();
  const keyboardBefore = await page.evaluate(() => scrollY);
  await page.keyboard.press("PageDown");
  await page.waitForFunction(before => scrollY > before + 10, keyboardBefore);
  result.searchPresentation = { normal: await caretSearchPresentation(page, cdp, profile.touch, `${profile.name} normal text`) };
  await page.locator(".site-header").screenshot({ path: `${artifacts}/${profile.name}-search-caret.png`, caret: "initial" });

  for (const mode of ["empty", "error"]) {
    catalogMode = mode;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#videos").getAttribute("aria-busy") === "false");
    assert.equal(await page.locator("#videos-status").isVisible(), true);
    result.states[mode] = await state(page, anchors);
    horizontalStable(result.states.populated, result.states[mode], `${profile.name} ${mode}`, ["#videos-grid > :first-child"]);
    await noHorizontalOverflow(page, `${profile.name} ${mode}`);
    catalogMode = "populated";
    let releaseRetry;
    if (mode === "error") requestGate = new Promise(resolveRetry => { releaseRetry = resolveRetry; });
    await page.locator("#status-action").click();
    if (releaseRetry) {
      await page.waitForFunction(() => document.querySelector("#videos").getAttribute("aria-busy") === "true");
      await page.locator(".brand").focus();
      // Wheel is native in both pointer profiles and has no touch-fling momentum
      // that could keep moving independently of the asynchronous catalog result.
      await nativeScroll(page, cdp, false);
      await page.waitForTimeout(220);
      const before = await page.evaluate(() => ({ active: document.activeElement.matches(".brand"), scroll: scrollY }));
      releaseRetry();
      await page.waitForFunction(() => document.querySelectorAll("#videos-grid .video-card").length === 24);
      await painted(page);
      const after = await page.evaluate(() => ({ active: document.activeElement.matches(".brand"), scroll: scrollY }));
      assert.ok(before.active && after.active, "Retry completion must not reclaim keyboard focus after it moves elsewhere");
      assert.ok(Math.abs(after.scroll - before.scroll) < 1, "Retry completion must not reclaim the user's scroll position");
      result.states.retryPreserved = { before, after };
    }
    await page.waitForFunction(() => document.querySelectorAll("#videos-grid .video-card").length === 24);
  }
  assert.ok(result.states.populated.rootOverflow, "Populated fixture must require actual root scrolling");
  if (profile.height >= 800) assert.ok(["empty", "error", "noResults"].some(name => result.states[name].rootOverflow === false), "A short state must remove root overflow to test scrollbar stability");
  catalogMode = "long";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#videos-grid .video-card").length === 24);
  await doubleText(page);
  await noHorizontalOverflow(page, `${profile.name} long titles and200% text`);
  result.searchHeader.enlarged = await centeredHeaderSearch(page, `${profile.name}200% text`);
  await page.locator("#search-input").fill("public");
  await clearAligned(page);
  result.searchPresentation.enlarged = await caretSearchPresentation(page, cdp, profile.touch, `${profile.name}200% text`);
  const clearFocus = await focusPresentation(page, "#search-clear");
  neutralColor(clearFocus.after.background, `${profile.name} search clear keyboard focus fill`);
  result.videosPassed = true;
  if (videosOnly) {
    assert.deepEqual(result.errors, []);
    assert.deepEqual(debugRequests, [], "Normal videos page must not load a debug overlay");
    result.passed = true;
    await context.close(); page = null;
    await writeFile(`${artifacts}/results.json`, JSON.stringify(results, null, 2));
    console.log(`PASS ${profile.name}: final videos labels, all recovery states, native scroll/focus, actual gutters and200%text`);
    return;
  }

  catalogMode = "populated";
  await page.goto(preview.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#watch-status").hidden && document.querySelector("video").readyState >= 2);
  await page.evaluate(() => document.fonts.ready);
  await seekPublicFrame(page);
  assert.equal(await page.locator("#share-btn, .shortcut-guide, footer.site-footer").count(), 0, "Removed watch chrome must stay absent");
  assert.equal(await page.locator(".watch-info").evaluate(element => /now watching/i.test(element.textContent)), false);
  for (const box of await page.locator("#watch-tags a").evaluateAll(tags => tags.map(tag => tag.getBoundingClientRect().toJSON()))) assert.ok(box.width >= 44 && box.height >= 44, "Short watch tags must retain44px targets");
  await noHorizontalOverflow(page, `${profile.name} watch`);
  await resetScroll(page, cdp, profile.touch);
  await page.screenshot({ path: `${artifacts}/${profile.name}-watch.png` });
  await focusPresentation(page, ".back-link");
  const activate = async selector => {
    await page.locator(selector).scrollIntoViewIfNeeded();
    if (!profile.touch) return page.locator(selector).click();
    const box = await page.locator(selector).boundingBox();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
    await page.waitForTimeout(100);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const settled = async (name = "home") => page.waitForFunction(name => {
    const panel = document.querySelector("#settings-panel");
    return panel.dataset.phase === "open" && panel.dataset.page === name && !panel.getAnimations({ subtree: true }).some(animation => animation.playState === "running");
  }, name);
  const menuAnchors = ["#settings-body", "#smooth-pause-toggle", "#speed-btn", "#quality-btn", "#speed-label", "#quality-label", "#settings-home .setting-switch", "#settings-home .menu-chevron"];
  const addRows = async selector => page.locator(selector).evaluate(group => {
    // Exceed even a full-height viewport at the minimum 44px row size.
    const rowCount = Math.ceil(innerHeight / 44) + 2;
    for (let index = 0; index < rowCount; index++) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "menu-item settings-row ux-overflow-fixture";
      const label = document.createElement("span"), value = document.createElement("span");
      label.textContent = `Public fixture option ${index + 1}`; value.textContent = "Value"; value.className = "setting-value";
      button.append(label, value); group.append(button);
    }
  });
  if (profile.touch) { await page.mouse.move(3, 3); await page.mouse.wheel(0, 120); await page.waitForTimeout(220); }
  await page.locator("#settings-btn").scrollIntoViewIfNeeded();
  const rootBeforeModal = await page.evaluate(() => scrollY);
  const modalAnchors = await state(page, [".site-header", ".site-main", "#watch-stage"]);
  await activate("#settings-btn");
  await settled();
  horizontalStable(modalAnchors, await state(page, [".site-header", ".site-main", "#watch-stage"]), `${profile.name} open modal`);
  result.menu.homeShort = await state(page, menuAnchors);
  await page.screenshot({ path: `${artifacts}/${profile.name}-settings.png` });
  if (profile.touch) {
    const before = await page.evaluate(() => scrollY);
    const panelBox = await page.locator("#settings-panel").boundingBox();
    await page.mouse.move(profile.width / 2, Math.max(8, panelBox.y - 30));
    await page.mouse.wheel(0, 260);
    await page.waitForTimeout(220);
    const after = await page.evaluate(() => scrollY);
    result.menu.backdropScroll = { before, after };
    assert.equal(after, before, "A mobile modal backdrop must not wheel-scroll the inert page");
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(220);
    assert.equal(await page.evaluate(() => scrollY), before, "A mobile modal must contain PageDown scrolling");
    // Pointerdown on the backdrop intentionally dismisses. Its native touch
    // gesture must still not pan the background during that exit.
    const from = Math.max(24, panelBox.y - 24), to = Math.max(6, from - 100);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: profile.width / 2, y: from }] });
    await page.waitForTimeout(60);
    for (let step = 1; step <= 8; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: profile.width / 2, y: from + (to - from) * step / 8 }] });
      await page.waitForTimeout(25);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(220);
    assert.equal(await page.evaluate(() => scrollY), before, "Backdrop dismissal must not leak its touch gesture to the background");
    await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
    await activate("#settings-btn");
    await settled();
  }
  await addRows("#settings-home");
  await painted(page);
  assert.equal(await page.locator("#settings-body").evaluate(body => body.scrollHeight > body.clientHeight + 10), true, "Fixture must actually overflow the native menu scroller");
  result.menu.homeOverflow = await state(page, menuAnchors);
  horizontalStable(result.menu.homeShort, result.menu.homeOverflow, `${profile.name} home scrollbar appears`);
  const rootBeforeMenuScroll = await page.evaluate(() => scrollY);
  await nativeScroll(page, cdp, profile.touch, "#settings-body");
  assert.equal(await page.evaluate(() => scrollY), rootBeforeMenuScroll, "Menu scrolling must not move the inert page");
  await resetScroll(page, cdp, profile.touch, "#settings-body");
  await page.locator("#speed-btn").focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.id), "quality-btn");
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains("ux-overflow-fixture")), true);
  assert.ok(await page.locator("#settings-body").evaluate(body => body.scrollTop) > 0);
  await resetScroll(page, cdp, profile.touch, "#settings-body");
  await activate("#quality-btn");
  await settled("quality");
  // Keep a real Auto and120fps rendition row while deliberately making this
  // UI-only geometry fixture short, including the390px landscape viewport.
  await page.locator("#quality-menu-content > .menu-item").evaluateAll(items => items.slice(2).forEach(item => { item.hidden = true; }));
  await painted(page);
  const qualityAnchors = ["#settings-body", "#quality-menu-content .menu-item", "#quality-menu-content .menu-item .menu-badge"];
  result.menu.qualityBefore = await state(page, qualityAnchors);
  assert.ok(result.menu.qualityBefore.anchors["#quality-menu-content .menu-item"], "Use an actual populated quality row");
  assert.equal(await page.locator("#settings-body").evaluate(body => body.scrollHeight > body.clientHeight + 1), false, "Quality fixture starts without content overflow");
  await addRows("#quality-menu");
  await painted(page);
  assert.equal(await page.locator("#settings-body").evaluate(body => body.scrollHeight > body.clientHeight + 10), true, "Quality fixture must create actual native content overflow");
  result.menu.qualityOverflow = await state(page, qualityAnchors);
  horizontalStable(result.menu.qualityBefore, result.menu.qualityOverflow, `${profile.name} quality scrollbar appears`);
  await activate("#settings-back");
  await settled();
  result.menu.homeReturned = await state(page, menuAnchors);
  horizontalStable(result.menu.homeOverflow, result.menu.homeReturned, `${profile.name} overflow quality→home`);
  await page.locator("#settings-home .ux-overflow-fixture").evaluateAll(rows => rows.forEach(row => row.remove()));
  await painted(page);
  horizontalStable(result.menu.homeShort, await state(page, menuAnchors), `${profile.name} home scrollbar disappears`);
  await focusPresentation(page, "#speed-btn");
  const rootBeforeDismiss = await page.evaluate(() => scrollY);
  if (profile.touch) assert.equal(rootBeforeDismiss, rootBeforeModal, "Mobile menu setup and focus must not move the locked page");
  await page.keyboard.press("Escape");
  if (profile.touch) {
    await page.waitForTimeout(40);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY), "hidden", "Modal root lock must survive the exit fade");
  }
  await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
  assert.equal(await page.evaluate(() => scrollY), rootBeforeDismiss, "Closing Settings must preserve the existing native root scroll position");
  result.menu.rootScroll = { opened: rootBeforeModal, beforeDismiss: rootBeforeDismiss, afterDismiss: await page.evaluate(() => scrollY) };
  horizontalStable(modalAnchors, await state(page, [".site-header", ".site-main", "#watch-stage"]), `${profile.name} close modal`);
  if (profile.touch) assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY), "hidden", "Closing Settings restores native root scrolling");

  // This UI-only capability fixture exposes the existing mounted HDR controls;
  // its SDR public video is not evidence of HDR decoding or display support.
  await page.locator("#cc-wrap").evaluate(element => { element.style.display = ""; });
  await activate("#settings-btn");
  await settled();
  await activate("#cc-btn");
  await settled("cc");
  result.menu.ccRanges = [];
  for (const id of ["cc-brightness", "cc-contrast", "cc-saturation"]) {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    await page.locator(`#${id}`).evaluate(input => input.blur());
    await page.mouse.move(0, 0);
    await painted(page);
    const before = await page.locator(`#${id}`).evaluate(input => ({ value: Number(input.value), step: Number(input.step), rect: input.getBoundingClientRect().toJSON() }));
    const unfocused = await page.locator(`#${id}`).screenshot();
    await page.keyboard.press("Tab");
    await page.locator(`#${id}`).focus();
    await painted(page);
    const focused = await page.locator(`#${id}`).screenshot();
    const beforePixels = await sharp(unfocused).removeAlpha().raw().toBuffer();
    const afterPixels = await sharp(focused).removeAlpha().raw().toBuffer();
    assert.equal(afterPixels.length, beforePixels.length);
    let changedPixels = 0;
    for (let pixel = 0; pixel < beforePixels.length; pixel += 3) if ([0, 1, 2].some(channel => Math.abs(beforePixels[pixel + channel] - afterPixels[pixel + channel]) > 8)) changedPixels++;
    assert.ok(changedPixels >= 20, `${id} needs an actual visible keyboard track/thumb cue, beyond merely being focused`);
    await page.keyboard.press("ArrowRight");
    const after = await page.locator(`#${id}`).evaluate(input => {
      const style = getComputedStyle(input);
      return { id: input.id, value: Number(input.value), rect: input.getBoundingClientRect().toJSON(), appearance: style.appearance,
        outline: style.outlineStyle, outlineWidth: style.outlineWidth, label: input.labels?.[0]?.textContent, focusVisible: input.matches(":focus-visible") };
    });
    assert.ok(before.rect.height >= 44 && before.rect.width >= 44, `${id} must retain a44px native range target`);
    assert.equal(after.appearance, "none", `${id} should share the adjacent player's custom range presentation`);
    assert.ok(after.label?.length && after.focusVisible, `${id} needs its native associated label and keyboard focus`);
    assert.ok(after.outline === "none" || Number.parseFloat(after.outlineWidth) === 0);
    assert.ok(Math.abs(after.value - before.value - before.step) < .0001, `${id} must retain native arrow-key adjustment`);
    for (const dimension of ["x", "width", "height"]) assert.ok(Math.abs(after.rect[dimension] - before.rect[dimension]) < .2, `${id} focus changed ${dimension}`);
    result.menu.ccRanges.push({ ...after, focusedCueChangedPixels: changedPixels });
  }
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
  await page.locator("#watch-title").evaluate((title, text) => { title.textContent = text; }, longTitle);
  await doubleText(page);
  await noHorizontalOverflow(page, `${profile.name} watch200% text and long title`);
  await activate("#settings-btn");
  await settled();
  await activate("#cc-btn");
  await settled("cc");
  result.menu.ccEnlarged = await page.locator("#cc-menu").evaluate(menu => ({ width: menu.clientWidth, scrollWidth: menu.scrollWidth,
    rows: [...menu.querySelectorAll(".cc-slider-row")].map(row => ({ width: row.clientWidth, scrollWidth: row.scrollWidth,
      range: row.querySelector("input").getBoundingClientRect().toJSON(), label: row.querySelector("label").getBoundingClientRect().toJSON(),
      value: row.querySelector(".cc-val").getBoundingClientRect().toJSON() })) }));
  assert.ok(result.menu.ccEnlarged.scrollWidth <= result.menu.ccEnlarged.width + 1, "200%CC labels must not overflow the menu");
  for (const row of result.menu.ccEnlarged.rows) {
    assert.ok(row.scrollWidth <= row.width + 1, "200%CC label, native range and numeric value must fit");
    assert.ok(row.range.width >= 44 && row.range.height >= 44);
    assert.ok(row.label.x + row.label.width <= row.range.x + .5 && row.range.x + row.range.width <= row.value.x + .5, "CC columns must not overlap");
  }
  await page.screenshot({ path: `${artifacts}/${profile.name}-cc200.png` });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
  if (profile.name === "landscape844") {
    // Constrain this fixture to keep exercising native error scrolling in a
    // short landscape surface after the former theatre layout was removed.
    await page.locator("#player-wrap").evaluate(player => { player.style.maxHeight = "260px"; });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("aida:playback-error", { detail: { kind: "network", message: "Public fixture network interruption" } })));
    await page.locator("#watch-status").scrollIntoViewIfNeeded();
    result.errorOverlay = await page.locator("#watch-status").evaluate(status => ({ height: status.clientHeight, scrollHeight: status.scrollHeight,
      overflow: getComputedStyle(status).overflowY, gutter: getComputedStyle(status).scrollbarGutter }));
    assert.ok(result.errorOverlay.scrollHeight > result.errorOverlay.height + 10, "Short landscape error fixture must actually overflow");
    assert.ok(["auto", "scroll"].includes(result.errorOverlay.overflow), "Error actions need a native scroll surface");
    assert.equal(result.errorOverlay.gutter, "auto", "The error overlay must reserve no gutter");
    const messageThumb = page.locator(".watch-stage > .site-scroll-thumb");
    await messageThumb.waitFor({ state: "visible" });
    await messageThumb.focus(); await messageThumb.press("End"); await painted(page);
    assert.ok(await page.locator("#watch-status").evaluate(status => status.scrollTop > 0), "Message scrollbar keys must use native scrolling");
    await page.locator("#watch-status").evaluate(status => { status.scrollTop = 0; }); await painted(page);
    await nativeScroll(page, cdp, true, "#watch-status");
    await page.locator("#watch-retry").focus();
    assert.equal(await page.evaluate(() => document.activeElement.id), "watch-retry");
    const hit = await page.locator("#watch-retry").evaluate(button => {
      const rect = button.getBoundingClientRect(), status = document.querySelector("#watch-status").getBoundingClientRect();
      return { height: rect.height, inside: rect.top >= status.top - 1 && rect.bottom <= status.bottom + 1,
        target: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button")?.id };
    });
    assert.ok(hit.height >= 44 && hit.inside && hit.target === "watch-retry", "Native scroll/focus must keep Retry reachable in the short error surface");
    await page.screenshot({ path: `${artifacts}/${profile.name}-error200.png` });
    await activate("#watch-retry");
    await page.waitForFunction(() => {
      const status = document.querySelector("#watch-status"), video = document.querySelector("video");
      return !!status && status.hidden && !!video && video.readyState >= 2;
    });
  }
  assert.deepEqual(result.errors, []);
  assert.deepEqual(debugRequests, [], "Normal pages must not load a debug overlay");
  result.passed = true;
  await context.close();
  page = null;
  await writeFile(`${artifacts}/results.json`, JSON.stringify(results, null, 2));
  console.log(`PASS ${profile.name}: states, stable native gutters, native scrolling,200%text, focus and watch cleanup`);
}

try {
  for (const mode of ["classic", "overlay"]) {
    const selected = profiles.filter(profile => profile.mode === mode);
    if (!selected.length) continue;
    browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ["--hide-scrollbars"],
      args: ["--enable-automation", "--autoplay-policy=no-user-gesture-required", `${mode === "classic" ? "--disable-features" : "--enable-features"}=OverlayScrollbar`] });
    const session = await browser.newBrowserCDPSession();
    const commandLine = await session.send("Browser.getBrowserCommandLine");
    assert.ok(!commandLine.arguments.includes("--hide-scrollbars"), "Hidden scrollbars are not an overlay-mode test");
    const probe = await browser.newPage();
    await probe.setContent('<div style="width:200px;height:100px;overflow:scroll"><div style="height:500px">Native scrollbar probe</div></div>');
    const measurement = await probe.locator("div").first().evaluate(element => ({ gutter: element.offsetWidth - element.clientWidth,
      overflow: element.scrollHeight > element.clientHeight, scrollbarWidth: getComputedStyle(element).scrollbarWidth }));
    assert.ok(measurement.overflow);
    assert.ok(mode === "classic" ? measurement.gutter > 0 : measurement.gutter === 0, `Requested${mode} native scrollbars, measured${JSON.stringify(measurement)}`);
    results.modes.push({ mode, browserVersion: browser.version(), ...measurement, hideScrollbars: false });
    console.log(`VERIFIED ${mode}: native scrollbox gutter${measurement.gutter}px; --hide-scrollbars absent`);
    await probe.close();
    const embed = await browser.newPage({ viewport: { width: 844, height: 390 } });
    const source = await readFile(new URL("../web/watch.html", import.meta.url), "utf8");
    const embedHtml = rewriteWatchHtml(source, null, { embed: true }).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
    await embed.route("**/embed-fixture", route => route.fulfill({ contentType: "text/html", body: embedHtml }));
    await embed.goto(`${preview.origin}/embed-fixture`, { waitUntil: "load" });
    const embedGeometry = await embed.evaluate(() => ({ viewport: innerWidth, client: document.documentElement.clientWidth,
      gutter: getComputedStyle(document.documentElement).scrollbarGutter, bodyGutter: getComputedStyle(document.body).scrollbarGutter,
      overflow: getComputedStyle(document.documentElement).overflowY, stage: document.querySelector("#watch-stage").getBoundingClientRect().toJSON(),
      player: document.querySelector("#player-wrap").getBoundingClientRect().toJSON() }));
    assert.equal(embedGeometry.gutter, "auto", "The worker's clipped embed must override the later root site gutter");
    assert.equal(embedGeometry.bodyGutter, "auto");
    assert.equal(embedGeometry.overflow, "hidden");
    assert.equal(embedGeometry.client, embedGeometry.viewport);
    for (const rect of [embedGeometry.stage, embedGeometry.player]) assert.ok(Math.abs(rect.x) < .1 && Math.abs(rect.width - embedGeometry.viewport) < .1, "Embedded video must fill the viewport without reserved side gutters");
    results.modes.at(-1).embed = embedGeometry;
    await embed.close();
    for (const profile of selected) await runProfile(browser, profile);
    await browser.close();
    browser = null;
  }
} catch (error) {
  results.failure = error.message;
  if (page && !page.isClosed()) await page.screenshot({ path: `${artifacts}/failure.png` });
  throw error;
} finally {
  await writeFile(`${artifacts}/results.json`, JSON.stringify(results, null, 2));
  await browser?.close();
  await preview.close();
}
