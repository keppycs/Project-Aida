import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { PUBLIC_VIDEO_ID, startPlayerPreview } from "./support/player-preview.mjs";
import { parseFrameRate } from "../web/js/player/frame-step.js";

const require = createRequire(import.meta.url);
const modules = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || `${modules}/playwright`);
const sharp = require(`${modules}/sharp`);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = process.env.AIDA_REVIEW_DIR || `C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-sheet-${Date.now()}`;
const baseline = process.argv.includes("--baseline");
const mobileOnly = process.argv.includes("--mobile-only");
const landscapeOnly = process.argv.includes("--landscape-only");
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const preview = await startPlayerPreview();
const report = { baseline, desktop: {}, mobile: [] };
let browser, page;
console.log(`Sheet artifacts: ${artifacts}`);

const painted = page => page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
async function settled(page, phase = "open", name = "home") {
  await page.waitForFunction(({ phase, name }) => {
    const panel = document.querySelector("#settings-panel");
    return panel.dataset.phase === phase && (phase === "closed" || panel.dataset.page === name)
      && !panel.getAnimations({ subtree: true }).some(animation => animation.playState === "running");
  }, { phase, name });
}
async function ready(context, viewport) {
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(preview.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#watch-status").hidden && !document.querySelector("#player-wrap").inert
    && document.querySelector("video").readyState >= 2, null, { timeout: 45000 });
  await page.evaluate(async () => {
    const video = document.querySelector("video"); video.pause();
    const frame = new Promise((resolveFrame, rejectFrame) => {
      const timeout = setTimeout(() => rejectFrame(new Error("Public 120 fps frame did not decode")), 15000);
      video.requestVideoFrameCallback(() => { clearTimeout(timeout); resolveFrame(); });
    });
    video.currentTime = 6; await frame;
  });
  await page.waitForFunction(() => !document.querySelector("#spinner").classList.contains("show")
    && Number(getComputedStyle(document.querySelector("#spinner")).opacity) < .01
    && Number(getComputedStyle(document.querySelector("#controls")).opacity) > .99);
  await painted(page);
  assert.deepEqual(page.viewportSize(), viewport);
  return page;
}
async function newContext(viewport, touch = false) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch });
  context.errors = [];
  context.network = [];
  context.consoleErrors = [];
  context.on("requestfailed", request => context.network.push({ url: request.url(), failure: request.failure()?.errorText }));
  context.on("response", response => { if (response.status() >= 400) context.network.push({ url: response.url(), status: response.status() }); });
  context.on("page", current => {
    current.on("pageerror", error => context.errors.push(error.message));
    current.on("console", message => { if (message.type() === "error") context.consoleErrors.push(message.text()); });
  });
  await context.addInitScript(() => {
    if (!/^https?:$/.test(location.protocol)) return;
    localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360, muted: true }));
    localStorage.setItem("aida-cc-banner-dismissed", "1");
    window.__sheetInputHistory = [];
    const record = value => {
      window.__sheetInputHistory.push({ time: performance.now(), ...value });
      if (window.__sheetInputHistory.length > 100) window.__sheetInputHistory.shift();
    };
    for (const type of ["pointerdown", "pointerup", "pointercancel", "click"]) document.addEventListener(type, event => {
      record({ type, target: event.target.id || event.target.closest("button")?.id || event.target.localName,
        phase: document.querySelector("#settings-panel")?.dataset.phase, x: event.clientX, y: event.clientY });
    }, true);
    new MutationObserver(records => {
      for (const mutation of records) if (mutation.target.id === "settings-panel") {
        record({ type: "phase", from: mutation.oldValue, phase: mutation.target.dataset.phase });
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-phase"], attributeOldValue: true });
    // Register before app listeners so this records the painted state at the
    // start of a real fresh gesture, before Settings can reverse its exit.
    document.addEventListener("pointerdown", event => {
      if (!window.__sheetReopenInput) return;
      const panel = document.querySelector("#settings-panel");
      window.__sheetReopenInput.push({ time: performance.now(), phase: panel.dataset.phase,
        y: new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42,
        x: event.clientX, touchY: event.clientY, pointerType: event.pointerType,
        target: event.target.id, rootOverflow: getComputedStyle(document.documentElement).overflowY });
    }, true);
  });
  await context.route("**/local/index.json", route => route.fulfill({ contentType: "application/json", body: JSON.stringify([
    { id: PUBLIC_VIDEO_ID, title: "ive got nuts of steel", duration: 25.963, frameRate: 120, visibility: "public" },
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sheet-${index}`, title: `Public motion study ${index + 1}`, duration: 12, frameRate: 120, visibility: "public" })),
  ]) }));
  await context.route("**/local/sheet-*/*", route => route.fulfill({ contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="405"><path fill="#23372e" d="M0 0h720v405H0z"/></svg>' }));
  return context;
}
async function beginTrace(current) {
  await current.evaluate(() => {
    window.__sheetFrames = [];
    window.__sheetTracing = true;
    const panel = document.querySelector("#settings-panel"), surface = document.querySelector("#settings-surface"), backdrop = document.querySelector("#menu-backdrop");
    function sample() {
      if (!window.__sheetTracing) return;
      if (!panel.hidden) {
        const style = getComputedStyle(panel), matrix = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
        const surfaceMatrix = new DOMMatrixReadOnly(getComputedStyle(surface).transform === "none" ? undefined : getComputedStyle(surface).transform);
        const backdropStyle = getComputedStyle(backdrop), rgba = backdropStyle.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
        const alpha = backdropStyle.backgroundColor === "transparent" ? 0 : rgba.length === 4 ? rgba[3] : 1;
        window.__sheetFrames.push({ time: performance.now(), phase: panel.dataset.phase, page: panel.dataset.page, inert: panel.inert,
          rect: panel.getBoundingClientRect().toJSON(), opacity: Number(style.opacity), x: matrix.m41, y: matrix.m42, a: matrix.m11, d: matrix.m22,
          surfaceA: surfaceMatrix.m11, surfaceD: surfaceMatrix.m22, backdropAlpha: alpha * Number(backdropStyle.opacity), backdropFilter: backdropStyle.backdropFilter,
          videoFilter: getComputedStyle(document.querySelector("video")).filter, videoOpacity: getComputedStyle(document.querySelector("video")).opacity,
          rootOverflow: getComputedStyle(document.documentElement).overflowY });
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
}
async function finishTrace(current) {
  return current.evaluate(() => { window.__sheetTracing = false; return window.__sheetFrames; });
}
function noScale(frames, label) {
  assert.ok(frames.length > 2, `${label}: capture real intermediate frames`);
  for (const frame of frames) for (const key of ["a", "d", "surfaceA", "surfaceD"]) assert.ok(Math.abs(frame[key] - 1) < .001, `${label}: live sheet text/controls must not scale (${key}=${frame[key]})`);
}
async function tap(current, cdp, selector) {
  await current.locator(selector).scrollIntoViewIfNeeded();
  const rect = await current.locator(selector).boundingBox();
  assert.ok(rect && rect.y >= 0 && rect.y + rect.height <= current.viewportSize().height + .1, `${selector} must be visible for native touch`);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }] });
  await current.waitForTimeout(100);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function headerDrag(current, cdp, distance, cancel = false) {
  const header = await current.locator(".settings-header").boundingBox();
  const point = { x: header.x + header.width / 2, y: header.y + 9 };
  const target = await current.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest("button")?.id ?? "header", point);
  assert.equal(target, "header", "The grab gesture must start on actual nonbutton header space");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await current.waitForTimeout(80);
  const scrollStart = await current.locator("#settings-body").evaluate(body => body.scrollTop);
  for (let step = 1; step <= 8; step++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y + distance * step / 8 }] });
    await current.waitForTimeout(20);
  }
  const held = await current.locator("#settings-panel").evaluate(panel => ({ y: new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42,
    height: panel.getBoundingClientRect().height, phase: panel.dataset.phase, scrollHeld: document.querySelector("#settings-body").scrollTop }));
  held.scrollStart = scrollStart;
  await cdp.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
  return held;
}
async function pixels(before, after) {
  const a = await sharp(before).removeAlpha().raw().toBuffer(), b = await sharp(after).removeAlpha().raw().toBuffer();
  assert.equal(a.length, b.length);
  let absolute = 0, darker = 0, changedPixels = 0, max = 0, averageBefore = 0;
  for (let i = 0; i < a.length; i += 3) {
    let changed = false;
    for (let channel = 0; channel < 3; channel++) {
      const delta = a[i + channel] - b[i + channel];
      absolute += Math.abs(delta); darker += delta; averageBefore += a[i + channel];
      max = Math.max(max, Math.abs(delta)); if (Math.abs(delta) > 2) changed = true;
    }
    if (changed) changedPixels++;
  }
  return { meanDifference: absolute / a.length, meanDarker: darker / a.length, changedPixels, max, averageBefore: averageBefore / a.length };
}
async function centerInMenu(current, paused, mobile) {
  const value = await current.locator("#big-play").evaluate(button => {
    const svg = button.querySelector("svg"), rect = button.getBoundingClientRect(), sheet = document.querySelector("#settings-panel").getBoundingClientRect();
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, hit = document.elementFromPoint(point.x, point.y);
    return { page: document.querySelector("#settings-panel").dataset.page,
      show: button.classList.contains("show"), opacity: Number(getComputedStyle(button).opacity), svgOpacity: Number(getComputedStyle(svg).opacity),
      pointerEvents: getComputedStyle(button).pointerEvents, tabIndex: button.tabIndex, ariaHidden: button.getAttribute("aria-hidden"),
      label: button.getAttribute("aria-label"),
      glyph: Object.fromEntries([["tip", 50, 36], ["gap", 36, 36], ["leftBar", 28, 36], ["rightBar", 43, 36]]
        .map(([name, x, y]) => [name, svg.querySelector("[data-morph-path]")?.isPointInFill(new DOMPoint(x, y)) ?? false])),
      inert: !!button.closest("[inert]"), focused: document.activeElement === button, hit: hit?.id ?? hit?.localName,
      hitCenter: button.contains(hit), point, pointInViewport: point.x > 0 && point.x < innerWidth && point.y > 0 && point.y < innerHeight,
      coveredBySheet: point.x >= sheet.left && point.x <= sheet.right && point.y >= sheet.top && point.y <= sheet.bottom };
  });
  assert.equal(value.show, true, "Opening Settings must preserve the existing center visual");
  assert.ok(value.opacity * value.svgOpacity > .98, "The center icon must remain painted behind Settings, including physically covered states");
  assert.equal(value.label, paused ? "Play video" : "Pause video");
  assert.deepEqual(value.glyph, { tip: paused, gap: paused, leftBar: true, rightBar: true }, "The painted center geometry must match the intended playback state");
  assert.equal(value.pointerEvents, "none", "A visible background icon must not steal modal pointer input");
  assert.equal(value.tabIndex, -1); assert.equal(value.ariaHidden, "true");
  assert.equal(value.focused, false); assert.equal(value.hitCenter, false);
  if (mobile) assert.equal(value.inert, true, "The mobile modal must keep the painted center control inert");
  return { paused, ...value };
}
async function centerPaintProof(current, name) {
  const rect = await current.locator("#big-play").boundingBox();
  const clip = { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
  const shown = await current.screenshot({ clip, path: `${artifacts}/${name}-center-painted.png` });
  const visibility = await current.locator("#big-play").evaluate(button => button.style.visibility);
  let hidden;
  try {
    await current.locator("#big-play").evaluate(button => { button.style.visibility = "hidden"; });
    await painted(current); hidden = await current.screenshot({ clip });
  } finally {
    await current.locator("#big-play").evaluate((button, value) => { button.style.visibility = value; }, visibility);
    await painted(current);
  }
  const difference = await pixels(shown, hidden);
  assert.ok(difference.changedPixels > 40, "The exposed center glyph must paint real pixels through the modal backdrop, rather than merely retain a CSS class");
  return difference;
}
async function desktop() {
  const context = await newContext({ width: 1440, height: 1000 });
  const current = await ready(context, { width: 1440, height: 1000 });
  const rect = await current.locator("video").boundingBox();
  const clip = { x: Math.floor(rect.x + rect.width * .12), y: Math.floor(rect.y + rect.height * .24),
    width: Math.floor(rect.width * .22), height: Math.floor(rect.height * .28) };
  const before = await current.screenshot({ clip, path: `${artifacts}/desktop-before.png` });
  await beginTrace(current);
  await current.locator("#settings-btn").click();
  await current.waitForTimeout(50);
  const entry = await current.screenshot({ clip, path: `${artifacts}/desktop-entry-crop.png` });
  await settled(current);
  const after = await current.screenshot({ clip, path: `${artifacts}/desktop-open-crop.png` });
  report.desktop = { clip, paint: await pixels(before, after), entryPaint: await pixels(before, entry), backdrop: await current.locator("#menu-backdrop").evaluate(element => ({
    background: getComputedStyle(element).backgroundColor, opacity: getComputedStyle(element).opacity })) };
  report.desktop.centerStates = [await centerInMenu(current, true, false)];
  report.desktop.centerPaint = await centerPaintProof(current, "desktop-settings");
  await current.screenshot({ path: `${artifacts}/desktop-settings.png` });
  console.log(`Desktop paused-video paint: ${JSON.stringify(report.desktop)}`);
  assert.ok(report.desktop.paint.averageBefore > 10, "The test crop needs real lit video pixels");
  assert.ok(report.desktop.paint.meanDifference < .25 && report.desktop.paint.changedPixels === 0, "Desktop Settings must never dim the video outside its own surface");
  assert.equal(report.desktop.entryPaint.changedPixels, 0, "Desktop video must remain undimmed during entrance");
  await current.locator("#quality-btn").click(); await settled(current, "open", "quality");
  report.desktop.centerStates.push(await centerInMenu(current, true, false));
  report.desktop.qualityLayout = await qualityLayout(current);
  await current.screenshot({ path: `${artifacts}/desktop-quality.png` });
  report.desktop.enlargedQuality = await enlargedQuality(current, "desktop");
  await current.locator("#settings-back").click(); await settled(current);
  const video = await current.locator("video").boundingBox();
  await current.mouse.click(video.x + video.width * .2, video.y + video.height * .5);
  await current.waitForTimeout(50);
  const exit = await current.screenshot({ clip, path: `${artifacts}/desktop-exit-crop.png` });
  await settled(current, "closed");
  report.desktop.exitPaint = await pixels(before, exit);
  report.desktop.frames = await finishTrace(current);
  assert.equal(report.desktop.exitPaint.changedPixels, 0, "Desktop video must remain undimmed during exit");
  assert.ok(report.desktop.frames.some(frame => frame.phase === "opening" && frame.opacity > 0 && frame.opacity < 1));
  assert.ok(report.desktop.frames.some(frame => frame.phase === "closing" && frame.inert));
  for (const frame of report.desktop.frames) {
    assert.equal(frame.backdropAlpha, 0, "Desktop backdrop must never paint darkness, including interrupted entry/exit");
    assert.equal(frame.backdropFilter, "none");
    assert.equal(frame.videoFilter, "none"); assert.equal(frame.videoOpacity, "1");
  }
  noScale(report.desktop.frames, "desktop popup");
  assert.equal(await current.evaluate(() => document.querySelector("video").paused), true, "Outside dismissal must not activate the video");
  assert.equal(await current.evaluate(() => document.activeElement.id), "settings-btn");
  await current.locator("#settings-btn").click(); await settled(current);
  await current.locator("#quality-btn").click(); await settled(current, "open", "quality");
  report.desktop.qualitySelection = await qualitySelection(current, report.desktop.qualityLayout);
  await current.keyboard.press("Escape"); await settled(current, "closed");
  assert.deepEqual(context.errors, []);
  report.desktop.passed = true;
  await context.close(); page = null;
  console.log("PASS desktop: unchanged paused-video pixels during entry/open/exit, no dim layer, outside dismissal and focus");
}

async function geometry(current, insets = { top: 0, right: 0, bottom: 0, left: 0 }) {
  const value = await current.evaluate(() => {
    const panel = document.querySelector("#settings-panel"), surface = document.querySelector("#settings-surface"), header = document.querySelector(".settings-header");
    const style = getComputedStyle(panel), padding = getComputedStyle(surface), box = panel.getBoundingClientRect(), backdrop = getComputedStyle(document.querySelector("#menu-backdrop"));
    return { rect: box.toJSON(), viewport: { width: visualViewport.width, height: visualViewport.height, y: visualViewport.offsetTop },
      radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius],
      padding: { left: Number.parseFloat(padding.paddingLeft), right: Number.parseFloat(padding.paddingRight), bottom: Number.parseFloat(padding.paddingBottom) },
      header: header.getBoundingClientRect().toJSON(), close: document.querySelector("#settings-close").getBoundingClientRect().toJSON(),
      backdrop: backdrop.backgroundColor, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
  });
  assert.ok(Math.abs(value.rect.x) < .1 && Math.abs(value.rect.width - value.viewport.width) < .1, "Phone sheet must attach to both viewport edges");
  assert.ok(Math.abs(value.rect.bottom - value.viewport.y - value.viewport.height) < .1, "Phone sheet background must attach to the physical bottom, including safe area");
  assert.deepEqual(value.radii, ["20px", "20px", "0px", "0px"]);
  assert.equal(value.header.height, 64);
  for (const edge of ["left", "right", "bottom"]) assert.ok(value.padding[edge] >= insets[edge] - .1, `Safe ${edge} inset belongs inside the painted sheet`);
  assert.ok(value.close.x >= insets.left && value.close.right <= value.viewport.width - insets.right + .1);
  assert.ok(value.close.width >= 44 && value.close.height >= 44);
  assert.ok(value.scrollWidth <= value.clientWidth + 1, "Edge-to-edge sheet must not introduce horizontal page overflow");
  assert.equal(value.backdrop, "rgba(0, 0, 0, 0.6)", "Phone backdrop should use the darker requested surface");
  return value;
}
async function qualityLayout(current) {
  const source = await current.evaluate(async id => {
    const base = `/local/${id}`;
    const [metadata, manifest] = await Promise.all([
      fetch(`${base}/metadata.json`).then(response => response.json()),
      fetch(`${base}/AV1/manifest.mpd`).then(response => response.text()),
    ]);
    const xml = new DOMParser().parseFromString(manifest, "application/xml");
    return [...xml.querySelectorAll("Representation[height]")].map(track => ({
      height: Number(track.getAttribute("height")),
      frameRate: track.getAttribute("frameRate") || track.closest("AdaptationSet")?.getAttribute("frameRate") || metadata.frameRate,
    }));
  }, PUBLIC_VIDEO_ID);
  const sourceRates = Object.fromEntries(source.map(track => {
    const rate = parseFrameRate(track.frameRate);
    assert.ok(rate, `${track.height}p must expose a real parsed source frame rate`);
    return [track.height, String(Number(rate.toFixed(3)))];
  }));
  const value = await current.evaluate(() => {
    const content = document.querySelector("#quality-menu-content"), advanced = content.querySelector(".playback-advanced");
    const bodyElement = document.querySelector("#settings-body"), body = bodyElement.getBoundingClientRect();
    const surface = document.querySelector("#settings-surface"), surfaceStyle = getComputedStyle(surface);
    const bounds = element => element.getBoundingClientRect().toJSON();
    return { disclosureCount: content.querySelectorAll("details, summary").length,
      formatLabel: advanced.getAttribute("aria-label"), removedHeadingPresent: advanced.textContent.includes("Advanced playback"),
      visibleHeadings: [...advanced.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter(element => element.getClientRects().length).length,
      firstSection: content.firstElementChild === advanced,
      body: body.toJSON(), advanced: advanced && bounds(advanced),
      contentFits: bodyElement.scrollHeight <= bodyElement.clientHeight + 1, surface: bounds(surface),
      bottomPadding: Number.parseFloat(surfaceStyle.paddingBottom),
      controls: [...advanced.querySelectorAll("button")].map(button => ({ label: button.getAttribute("aria-label"), rect: bounds(button) })),
      formatGroups: [...advanced.querySelectorAll(".playback-choice")].map(group => {
        const label = group.querySelector(".playback-choice-label"), track = group.querySelector(".menu-toggle-row"), style = getComputedStyle(track);
        return { label: label.textContent, ariaLabel: group.getAttribute("aria-label"), rect: bounds(group), labelRect: bounds(label), track: bounds(track),
          gap: [style.rowGap, style.columnGap].map(value => Number.parseFloat(value) || 0), background: style.backgroundColor,
          radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(Number.parseFloat),
          buttons: [...track.querySelectorAll("button")].map(button => {
            const style = getComputedStyle(button);
            return { text: button.textContent, rect: bounds(button),
              radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(Number.parseFloat),
              borders: ["Top", "Right", "Bottom", "Left"].map(side => ({ width: Number.parseFloat(style[`border${side}Width`]),
                style: style[`border${side}Style`], color: style[`border${side}Color`] })) };
          }) };
      }),
      tiers: [...content.querySelectorAll('.menu-item[data-id]:not([data-id="-1"])')].map(row => ({
        id: row.dataset.id, ariaLabel: row.getAttribute("aria-label"),
        resolution: row.querySelector(".quality-option-label").textContent,
        labelChildren: row.querySelector(".quality-option-label").childElementCount,
        label: bounds(row.querySelector(".quality-option-label")), bitrate: bounds(row.querySelector(".menu-badge")) })),
      options: [...content.querySelectorAll(".menu-item[data-id]")].map(row => ({
        label: row.querySelector(".quality-option-label").textContent, row: bounds(row),
        text: [bounds(row.querySelector(".quality-option-label")), bounds(row.querySelector(".menu-badge"))] })),
      resolution: bounds(content.querySelector(".quality-resolution-heading")), auto: bounds(content.querySelector("#quality-auto-item")) };
  });
  value.sourceRates = sourceRates;
  assert.ok(Object.keys(sourceRates).length > 0, "The fixture must expose actual source renditions");
  for (const tier of value.tiers) {
    const match = /^(\d+)p at ([\d.]+) frames per second$/.exec(tier.ariaLabel);
    assert.ok(match, "Compact visual labels must retain readable source-rate accessibility labels");
    assert.equal(match[2], sourceRates[match[1]], "Accessible FPS must match the parsed source rate");
    assert.equal(tier.resolution, `${match[1]}p${sourceRates[match[1]]}`, "Resolution and source FPS must form one compact string");
    assert.equal(tier.labelChildren, 0, "Compact resolution labels must use uniform text without a separate FPS span");
  }
  assert.equal(await current.locator("#quality-menu-content").evaluate(content => /\bABR\b/.test(content.textContent)), false,
    "Quality must not expose the removed ABR placeholder");
  assert.equal(value.disclosureCount, 0, "Quality must show playback format controls directly, without a hidden disclosure");
  assert.equal(value.formatLabel, "Playback format");
  assert.equal(value.removedHeadingPresent, false, "The removed Advanced playback title must not return");
  assert.equal(value.visibleHeadings, 0, "The compact format controls must not acquire an extra visible heading");
  assert.equal(value.firstSection, true, "Playback format belongs before the resolution choices");
  assert.ok(Math.abs(value.advanced.height - 82) <= 1, "The side-by-side format groups should occupy 82px at normal text size");
  assert.deepEqual(value.formatGroups.map(group => [group.label, group.ariaLabel]), [["Codec", "Codec"], ["Protocol", "Protocol"]],
    "Codec and Protocol must remain distinct labeled groups");
  const [codec, protocol] = value.formatGroups;
  assert.ok(Math.abs(codec.rect.top - protocol.rect.top) < .2 && codec.rect.right <= protocol.rect.left + .1,
    "Codec and Protocol must sit side by side at normal text size");
  assert.deepEqual(value.formatGroups.map(group => group.buttons.map(button => button.text)), [["AV1", "HEVC"], ["DASH", "HLS"]]);
  for (const group of value.formatGroups) {
    assert.ok(group.labelRect.bottom <= group.track.top + .1 && group.labelRect.left >= group.rect.left - .1,
      `${group.label}: the label must sit above its joined choices`);
    assert.deepEqual(group.gap, [0, 0], `${group.label}: joined choices must not have gaps`);
    assert.ok(group.background !== "transparent" && group.background !== "rgba(0, 0, 0, 0)" && group.radii.every(radius => radius > 0),
      `${group.label}: one shared fill and outer radius must join the choices`);
    const [first, second] = group.buttons;
    assert.ok(Math.abs(first.rect.right - second.rect.left) < .2
      && Math.abs(first.rect.top - second.rect.top) < .2 && Math.abs(first.rect.height - second.rect.height) < .2,
    `${group.label}: the two targets must meet along one center edge`);
    for (const [index, button] of group.buttons.entries()) {
      assert.deepEqual(button.radii, [0, 0, 0, 0], `${button.text}: individual choices must not acquire separate rounded tracks`);
      assert.deepEqual(button.borders.map(border => border.width), index === 0 ? [0, 0, 0, 0] : [0, 0, 0, 1],
        `${button.text}: only the second choice's 1px left border should divide the shared track`);
    }
    assert.ok(second.borders[3].style === "solid" && second.borders[3].color !== "transparent" && second.borders[3].color !== "rgba(0, 0, 0, 0)",
      `${group.label}: the single center divider must remain painted`);
  }
  assert.ok(value.advanced.bottom <= value.resolution.top + .1 && value.resolution.bottom <= value.auto.top + .1,
    "The painted order must be compact format controls, Resolution, then Auto");
  assert.equal(value.controls.length, 4, "Both codec and delivery choices should appear immediately");
  for (const control of value.controls) {
    assert.ok(control.rect.width >= 44 && control.rect.height >= 44, `${control.label}: visible touch target must remain at least 44px`);
    assert.ok(control.rect.top >= value.body.top - .1 && control.rect.bottom <= value.body.bottom + .1,
      `${control.label}: advanced controls must be visible before any scrolling or expansion`);
  }
  assert.ok(value.options.length > 2, "Quality must expose actual resolution choices and Auto");
  for (const option of value.options) {
    assert.ok(option.row.width >= 44 && option.row.height >= 44, `${option.label}: each complete option remains a touch target`);
    for (const text of option.text) assert.ok(text.left >= option.row.left - .1 && text.right <= option.row.right + .1
      && text.top >= option.row.top - .1 && text.bottom <= option.row.bottom + .1,
    `${option.label}: text must stay inside its own row`);
  }
  if (value.contentFits) {
    const trailingSpace = value.surface.bottom - value.bottomPadding - value.tiers.at(-1).bitrate.bottom;
    const lastRowSpace = value.surface.bottom - value.bottomPadding
      - await current.locator('#quality-menu-content > .menu-item:last-child').evaluate(row => row.getBoundingClientRect().bottom);
    value.trailingSpace = { afterBitrate: trailingSpace, afterRow: lastRowSpace };
    assert.ok(lastRowSpace >= -.1 && lastRowSpace <= 16,
      "A fitting Quality page must size to its content instead of keeping a large empty sheet below the last row");
  }
  return value;
}
async function qualitySelection(current, layout, cdp = null) {
  const activate = selector => cdp ? tap(current, cdp, selector) : current.locator(selector).click();
  const openQuality = async () => {
    await activate("#settings-btn"); await settled(current);
    await activate("#quality-btn"); await settled(current, "open", "quality");
  };
  const originalId = await current.locator('#quality-menu-content > .menu-item[aria-pressed="true"]').getAttribute("data-id");
  const original = layout.tiers.find(tier => tier.id === originalId);
  assert.ok(original, "The round trip must begin on the fixture's actual manual rendition");
  assert.equal(await current.locator("#quality-auto-badge").textContent(), "", "Manual mode must leave Auto free of helper text");
  await activate("#quality-auto-item"); await settled(current, "closed");
  await openQuality();
  await current.waitForFunction(rates => {
    const label = document.querySelector("#quality-auto-badge").textContent;
    const sourceLabel = Object.entries(rates).some(([height, rate]) => label === `${height}p${rate}`);
    return document.querySelector("#quality-auto-item").getAttribute("aria-pressed") === "true"
      && sourceLabel
      && document.querySelector("#quality-label").textContent === `Auto · ${label}`;
  }, layout.sourceRates);
  const auto = await current.evaluate(() => ({ badge: document.querySelector("#quality-auto-badge").textContent,
    height: document.querySelector("video").videoHeight, home: document.querySelector("#quality-label").textContent }));
  await activate(`#quality-menu-content > .menu-item[data-id="${originalId}"]`); await settled(current, "closed");
  assert.equal(await current.locator("#quality-label").textContent(), original.resolution, "Home must show the selected compact manual label");
  await openQuality();
  assert.equal(await current.locator("#quality-auto-badge").textContent(), "", "Returning to manual must clear the previous actual Auto resolution");
  assert.equal(await current.locator(`#quality-menu-content > .menu-item[data-id="${originalId}"]`).getAttribute("aria-pressed"), "true");
  assert.equal(await current.locator("#quality-auto-item").getAttribute("aria-pressed"), "false");
  assert.equal(await current.locator("video").evaluate(video => video.paused), true, "Changing quality must preserve paused playback");
  return { auto, manual: original.resolution };
}
async function enlargedQuality(current, label, cdp = null) {
  const original = await current.evaluate(() => document.documentElement.style.fontSize);
  const viewport = current.viewportSize();
  try {
    await current.evaluate(() => { document.documentElement.style.fontSize = "200%"; document.querySelector("#settings-body").scrollTop = 0; });
    // A tall phone can fit every enlarged row. Also exercise the narrower
    // available-height state where the native sheet scroller is actually needed.
    if (cdp) { await current.setViewportSize({ width: viewport.width, height: Math.min(viewport.height, 600) }); await settled(current, "open", "quality"); }
    await painted(current);
    const value = await current.evaluate(() => {
      const body = document.querySelector("#settings-body"), panel = document.querySelector("#settings-panel");
      const controls = [...document.querySelectorAll(".playback-advanced button, #quality-menu-content > .menu-item")];
      const text = [...document.querySelectorAll(".playback-advanced .menu-toggle, .quality-option-label, #quality-menu-content .menu-badge")];
      return { rootFont: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        pageWidth: document.documentElement.clientWidth, pageScrollWidth: document.documentElement.scrollWidth,
        bodyWidth: body.clientWidth, bodyScrollWidth: body.scrollWidth, bodyHeight: body.clientHeight, bodyScrollHeight: body.scrollHeight,
        panel: panel.getBoundingClientRect().toJSON(),
        controls: controls.map(control => ({ text: control.textContent, rect: control.getBoundingClientRect().toJSON() })),
        textOverflow: text.filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.textContent) };
    });
    assert.ok(value.rootFont >= 30, "Enlarged-text checks must actually double the root text size");
    assert.ok(value.pageScrollWidth <= value.pageWidth + 1 && value.bodyScrollWidth <= value.bodyWidth + 1,
      `${label}: enlarged text must not introduce horizontal page or Settings scrolling`);
    assert.deepEqual(value.textOverflow, [], `${label}: enlarged text must fit or wrap within its control`);
    for (const control of value.controls) assert.ok(control.rect.width >= 44 && control.rect.height >= 44,
      `${label}: enlarged ${control.text} must retain its 44px target`);
    assert.ok(value.bodyScrollHeight > value.bodyHeight + 10, "Enlarged Quality content should use native vertical overflow within the viewport");
    const body = await current.locator("#settings-body").boundingBox();
    if (cdp) {
      const point = { x: body.x + body.width * .55, y: body.y + body.height * .8 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      for (let step = 1; step <= 8; step++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y - body.height * .5 * step / 8 }] });
        await current.waitForTimeout(20);
      }
      await current.waitForTimeout(100); // Finish this native scroll at rest before restoring text size.
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else { await current.mouse.move(body.x + body.width / 2, body.y + body.height / 2); await current.mouse.wheel(0, 350); }
    await current.waitForFunction(() => document.querySelector("#settings-body").scrollTop > 10);
    value.scrollTop = await current.locator("#settings-body").evaluate(body => body.scrollTop);
    await current.screenshot({ path: `${artifacts}/${label}-quality-text-200.png` });
    return value;
  } finally {
    await current.evaluate(original => { document.documentElement.style.fontSize = original; document.querySelector("#settings-body").scrollTop = 0; }, original);
    if (cdp) { await current.setViewportSize(viewport); await settled(current, "open", "quality"); }
    await painted(current);
  }
}
async function mobile(viewport) {
  const context = await newContext(viewport, true);
  const current = await ready(context, viewport), cdp = await context.newCDPSession(current);
  const result = { viewport }; report.mobile.push(result);
  await current.locator("#settings-btn").scrollIntoViewIfNeeded();
  const root = await current.evaluate(() => scrollY);
  await beginTrace(current); await tap(current, cdp, "#settings-btn"); await settled(current);
  result.entry = await finishTrace(current); result.home = await geometry(current);
  result.centerStates = [await centerInMenu(current, true, true)];
  if (viewport.width < viewport.height) {
    assert.equal(result.centerStates[0].coveredBySheet, false);
    result.centerPaint = await centerPaintProof(current, `mobile-${viewport.width}-settings`);
  }
  noScale(result.entry, `${viewport.width}px entry`);
  const entering = result.entry.filter(frame => frame.phase === "opening");
  assert.ok(entering.some(frame => frame.y > frame.rect.height * .7), "Phone entrance must originate below the viewport by the full sheet height, not a floating16px nudge");
  assert.ok(entering.some(frame => frame.y > 2 && frame.y < frame.rect.height * .7), "Phone entrance needs actual intermediate sliding frames");
  assert.ok(entering.some(frame => frame.backdropAlpha > 0 && frame.backdropAlpha < .59), "The first phone backdrop must visibly interpolate from transparent, without jumping to full dim");
  await current.screenshot({ path: `${artifacts}/mobile-${viewport.width}-home.png` });
  await tap(current, cdp, "#quality-btn"); await settled(current, "open", "quality");
  result.quality = await geometry(current); result.qualityLayout = await qualityLayout(current);
  result.centerStates.push(await centerInMenu(current, true, true));
  assert.ok(result.quality.rect.height > result.home.rect.height + 40,
    "Mobile Quality should provide a taller sheet than Settings home for its always-visible playback controls");
  assert.ok(result.quality.rect.height <= viewport.height - 12 + 1,
    "Mobile Quality must remain inside the available viewport while sizing to its compact content");
  await current.screenshot({ path: `${artifacts}/mobile-${viewport.width}-quality.png` });
  if (viewport.width === 360) result.enlargedQuality = await enlargedQuality(current, "mobile-360", cdp);
  result.qualitySelection = await qualitySelection(current, result.qualityLayout, cdp);
  await current.locator("#quality-menu").evaluate(group => {
    for (let index = 0; index < 14; index++) {
      const row = document.createElement("button"); row.type = "button"; row.className = "menu-item sheet-overflow-fixture";
      row.textContent = `Public geometry fixture ${index + 1}`; group.append(row);
    }
  });
  await painted(current);
  assert.equal(await current.locator("#settings-body").evaluate(body => body.scrollHeight > body.clientHeight + 10), true);
  const body = await current.locator("#settings-body").boundingBox();
  const x = body.x + body.width * .55, start = body.y + body.height * .8, end = body.y + body.height * .25;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: start }] });
  await current.waitForTimeout(60);
  for (let step = 1; step <= 8; step++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: start + (end - start) * step / 8 }] }); await current.waitForTimeout(20); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await current.waitForFunction(() => document.querySelector("#settings-body").scrollTop > 10);
  assert.equal(await current.evaluate(() => scrollY), root, "Native sheet scrolling must not pan the background");
  await current.locator("#settings-back").evaluate(button => button.focus({ preventScroll: true }));
  result.canceledDrag = await headerDrag(current, cdp, 60, true);
  assert.ok(result.canceledDrag.y > 20, "The actual header drag must move the sheet under the finger");
  assert.ok(result.canceledDrag.scrollStart > 10, "Cancel must be tested after real native body scrolling");
  await settled(current, "open", "quality");
  const restoredScroll = await current.locator("#settings-body").evaluate(body => body.scrollTop);
  assert.ok(Math.abs(restoredScroll - result.canceledDrag.scrollStart) < 1, "Canceling a settled header drag must preserve the native body scroll position");
  assert.equal(await current.evaluate(() => document.activeElement.id), "settings-back", "Canceling the header drag must preserve menu focus");
  await tap(current, cdp, "#settings-back"); await settled(current);
  await current.locator(".sheet-overflow-fixture").evaluateAll(rows => rows.forEach(row => row.remove()));
  assert.equal(await current.evaluate(() => document.activeElement.id), "quality-btn");
  await geometry(current);
  await beginTrace(current);
  result.heldDismiss = await headerDrag(current, cdp, result.home.rect.height * .65);
  assert.ok(result.heldDismiss.y > 20);
  const releasing = await current.locator("#settings-panel").evaluate(panel => ({ inert: panel.inert, phase: panel.dataset.phase }));
  assert.equal(releasing.inert, true, "A released dismiss gesture must disable its controls immediately");
  await settled(current, "closed"); result.exit = await finishTrace(current);
  noScale(result.exit, `${viewport.width}px gesture exit`);
  assert.ok(result.exit.some(frame => frame.phase === "closing" && frame.y >= frame.rect.height * .8), "Phone dismissal must continue below the viewport");
  for (const frame of result.exit.filter(frame => frame.phase === "closing")) assert.equal(frame.rootOverflow, "hidden", "Root scrolling stays locked through the exit");
  assert.equal(await current.evaluate(() => scrollY), root);
  assert.equal(await current.evaluate(() => document.activeElement.id), "settings-btn");
  await tap(current, cdp, "#settings-btn");
  await current.waitForFunction(() => {
    const panel = document.querySelector("#settings-panel"), rect = document.querySelector("#settings-close").getBoundingClientRect();
    return panel.dataset.phase === "opening" && rect.top > 0 && rect.bottom < innerHeight - 1;
  });
  const press = await current.locator("#settings-close").boundingBox();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: press.x + press.width / 2, y: press.y + press.height / 2 }] });
  const heldStart = await current.locator("#settings-close").boundingBox();
  await current.waitForTimeout(100);
  const heldEnd = await current.locator("#settings-close").boundingBox();
  for (const axis of ["x", "y", "width", "height"]) assert.ok(Math.abs(heldEnd[axis] - heldStart[axis]) <= .25, `An entry-pressed control must stay under the finger (${axis})`);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await settled(current); await geometry(current);
  result.entryPress = { heldStart, heldEnd };
  await current.keyboard.press("Escape"); await settled(current, "closed");
  assert.equal(await current.evaluate(() => document.activeElement.id), "settings-btn");

  // The very first fresh touch on Settings must reverse a swipe exit. Do not
  // wait for closed or use click(), which can conceal the swallowed-touch bug.
  const opener = await current.locator("#settings-btn").boundingBox();
  await tap(current, cdp, "#settings-btn"); await settled(current);
  await beginTrace(current);
  await headerDrag(current, cdp, result.home.rect.height * .65);
  await current.evaluate(() => { window.__sheetReopenInput = []; });
  const reopenPoint = { x: opener.x + opener.width / 2, y: opener.y + opener.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [reopenPoint] });
  const reopened = await current.evaluate(() => {
    const panel = document.querySelector("#settings-panel");
    return { input: window.__sheetReopenInput.at(-1), phase: panel.dataset.phase, hidden: panel.hidden,
      inert: panel.inert, y: new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42,
      rootOverflow: getComputedStyle(document.documentElement).overflowY };
  });
  assert.equal(reopened.input?.phase, "closing", "The fresh native gesture must arrive during the previous swipe exit");
  assert.equal(reopened.input.pointerType, "touch");
  assert.equal(reopened.phase, "opening", "The first touch must begin reopening immediately, without waiting for exit completion");
  assert.equal(reopened.hidden, false); assert.equal(reopened.inert, false);
  assert.ok(reopened.y <= reopened.input.y + .5, "Reopening must reverse from the current painted pose without jumping down");
  assert.equal(reopened.rootOverflow, "hidden", "Reversing the exit must keep the background scroll lock");
  await current.waitForTimeout(100);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await settled(current); result.immediateReopen = reopened;
  result.reopenFrames = await finishTrace(current); noScale(result.reopenFrames, `${viewport.width}px swipe reversal`);
  assert.equal(await current.locator("#settings-panel").evaluate(panel => panel.dataset.phase), "open",
    "Releasing the reopening gesture must not toggle Settings closed again");
  assert.equal(await current.evaluate(() => document.querySelector("video").paused), true,
    "Routing a fresh Settings gesture must not activate the background video");
  assert.equal(await current.evaluate(() => scrollY), root);
  await current.keyboard.press("Escape"); await settled(current, "closed");
  assert.equal(await current.evaluate(() => document.activeElement.id), "settings-btn");

  await tap(current, cdp, "#settings-btn"); await settled(current);
  await headerDrag(current, cdp, result.home.rect.height * .65);
  await current.evaluate(() => { window.__sheetReopenInput = []; });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [reopenPoint] });
  result.canceledReopen = await current.evaluate(() => ({ input: window.__sheetReopenInput.at(-1),
    phase: document.querySelector("#settings-panel").dataset.phase }));
  assert.equal(result.canceledReopen.input?.phase, "closing");
  assert.equal(result.canceledReopen.phase, "opening");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await settled(current);
  await current.locator("#settings-close").focus();
  await current.keyboard.press("Enter"); await settled(current, "closed");
  assert.equal(await current.evaluate(() => document.activeElement.id), "settings-btn",
    "Canceling a fresh reopen must not leave click suppression that swallows the next keyboard activation");

  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [reopenPoint] });
  await current.waitForTimeout(100);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  assert.equal(await current.locator("#settings-panel").evaluate(panel => panel.dataset.phase), "closed",
    "Canceling a normal Settings press must not open the sheet");
  await current.locator("#settings-btn").focus(); await current.keyboard.press("Enter"); await settled(current);
  await current.locator("#settings-close").focus(); await current.keyboard.press("Enter"); await settled(current, "closed");
  assert.equal(await current.evaluate(() => document.activeElement.id), "settings-btn",
    "A canceled Settings touch must preserve subsequent keyboard activation and focus return");

  const insets = viewport.width > viewport.height ? { top: 0, right: 44, bottom: 21, left: 44 } : { top: 24, right: 0, bottom: 34, left: 0 };
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
  result.safeReadback = await current.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    document.body.append(probe); const style = getComputedStyle(probe);
    const actual = { top: Number.parseFloat(style.paddingTop), right: Number.parseFloat(style.paddingRight), bottom: Number.parseFloat(style.paddingBottom), left: Number.parseFloat(style.paddingLeft) };
    probe.remove(); return actual;
  });
  assert.deepEqual(result.safeReadback, insets, "Safe-area emulation must actually reach CSS env() before geometry is claimed");
  await tap(current, cdp, "#settings-btn"); await settled(current); result.safeGeometry = await geometry(current, insets);
  await current.screenshot({ path: `${artifacts}/mobile-${viewport.width}-safe-area.png` });
  await tap(current, cdp, "#quality-btn");
  const resized = { width: viewport.width, height: viewport.height - 60 };
  await current.setViewportSize(resized);
  await settled(current, "open", "quality");
  result.resizedGeometry = await geometry(current, insets);
  await tap(current, cdp, "#settings-close"); await settled(current, "closed");
  assert.equal(await current.evaluate(() => document.querySelector("video").paused), true);
  assert.equal(await current.evaluate(() => document.activeElement.id), "settings-btn");

  const toggleCenter = async () => {
    if (viewport.width < viewport.height) await tap(current, cdp, "#big-play");
    else {
      // Native page scrolling can leave the picture's fixed center partially
      // outside a short landscape viewport. Do not relocate it for this test.
      await current.locator("#player-wrap").evaluate(wrap => wrap.focus({ preventScroll: true }));
      await current.keyboard.press("k");
    }
  };
  await toggleCenter();
  await current.waitForFunction(() => !document.querySelector("video").paused && document.querySelector("#big-play").getAttribute("aria-label") === "Pause video");
  await tap(current, cdp, "#settings-btn"); await settled(current);
  result.centerStates.push(await centerInMenu(current, false, true));
  await current.screenshot({ path: `${artifacts}/mobile-${viewport.width}-playing-settings.png` });
  await tap(current, cdp, "#quality-btn"); await settled(current, "open", "quality");
  result.centerStates.push(await centerInMenu(current, false, true));
  await tap(current, cdp, "#settings-back"); await settled(current);
  const center = await centerInMenu(current, false, true);
  if (viewport.width < viewport.height) {
    assert.equal(center.pointInViewport, true); assert.equal(center.coveredBySheet, false,
      "Portrait Home must leave the video-center sample exposed above the sheet");
    assert.equal(center.hit, "menu-backdrop", "The modal backdrop must intercept the painted center");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [center.point] });
    await current.waitForTimeout(100);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else await tap(current, cdp, "#settings-close");
  await settled(current, "closed");
  assert.equal(await current.locator("video").evaluate(video => video.paused), false,
    "Pressing the painted pause icon behind Settings must dismiss the menu without pausing video");
  assert.equal(await current.evaluate(() => document.activeElement.id), "settings-btn");
  await toggleCenter(); await current.waitForFunction(() => document.querySelector("video").paused);
  assert.deepEqual(context.errors, []); result.passed = true;
  await context.close(); page = null;
  console.log(`PASS ${viewport.width}×${viewport.height}: edge sheet, full-height motion, native scroll/drag/cancel/dismiss, safe areas and focus`);
}

try {
  browser = await chromium.launch({ executablePath, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  if (!mobileOnly && !landscapeOnly) await desktop();
  if (!baseline) for (const viewport of [{ width: 360, height: 800 }, { width: 424, height: 924 }, { width: 844, height: 390 }]
    .filter(viewport => !landscapeOnly || viewport.width > viewport.height)) await mobile(viewport);
} catch (error) {
  report.failure = error.message;
  if (page && !page.isClosed()) {
    report.failureState = await page.evaluate(() => ({ url: location.href, status: document.querySelector("#watch-status")?.textContent,
      title: document.querySelector("#watch-title")?.textContent, shaka: typeof window.shaka, ready: document.querySelector("video")?.readyState,
      inert: document.querySelector("#player-wrap")?.inert, settings: (() => { const panel = document.querySelector("#settings-panel"); return panel && {
        phase: panel.dataset.phase, page: panel.dataset.page, hidden: panel.hidden, inert: panel.inert, transform: getComputedStyle(panel).transform,
        rect: panel.getBoundingClientRect().toJSON() }; })(),
      inputHistory: window.__sheetInputHistory,
      requests: performance.getEntriesByType("resource").map(resource => ({ name: resource.name, duration: resource.duration, status: resource.responseStatus })) }));
    report.failureState.errors = page.context().errors;
    report.failureState.network = page.context().network;
    report.failureState.consoleErrors = page.context().consoleErrors;
    console.log(`Failure diagnostics: ${JSON.stringify(report.failureState)}`);
    await page.screenshot({ path: `${artifacts}/failure.png` });
  }
  throw error;
} finally {
  await writeFile(`${artifacts}/results.json`, JSON.stringify(report, null, 2));
  await browser?.close(); await preview.close();
}
