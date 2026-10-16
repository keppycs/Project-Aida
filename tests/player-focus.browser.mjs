import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { startPlayerPreview } from "./support/player-preview.mjs";

const require = createRequire(import.meta.url);
const runtime = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || runtime);
const sharp = require(process.env.AIDA_SHARP_MODULE || resolve(runtime, "../sharp"));
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const browserRoot = resolve(dirname(executablePath), "../..");
const artifacts = process.env.AIDA_REVIEW_DIR || `C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-focus-${Date.now()}`;
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = browserRoot;
const preview = await startPlayerPreview();
const browser = await chromium.launch({ executablePath, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const results = [];
console.log(`Focus review artifacts: ${artifacts}`);

const decoration = element => {
  const style = getComputedStyle(element);
  return {
    outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth),
    border: ["Top", "Right", "Bottom", "Left"].map(side => parseFloat(style[`border${side}Width`]) === 0 || style[`border${side}Style`] === "none"
      ? "none" : `${style[`border${side}Width`]} ${style[`border${side}Style`]} ${style[`border${side}Color`]}`),
    boxShadow: style.boxShadow,
  };
};

async function wrapperCheck(page, baseline, action) {
  const actual = await page.locator("#player-wrap").evaluate(decoration);
  assert.ok(actual.outlineStyle === "none" || actual.outlineWidth === 0, `${action}: player outline ${actual.outlineWidth}px ${actual.outlineStyle}`);
  assert.deepEqual(actual.border, baseline.border, `${action}: focus changed the player border`);
  assert.equal(actual.boxShadow, baseline.boxShadow, `${action}: focus changed the player shadow`);
}

async function paintedCenterInSettings(page, { paused, touch, state }) {
  const value = await page.locator("#big-play").evaluate(button => {
    const svg = button.querySelector("svg"), rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { show: button.classList.contains("show"), opacity: Number(getComputedStyle(button).opacity),
      svgOpacity: Number(getComputedStyle(svg).opacity), pointerEvents: getComputedStyle(button).pointerEvents,
      tabIndex: button.tabIndex, ariaHidden: button.getAttribute("aria-hidden"), label: button.getAttribute("aria-label"),
      inert: !!button.closest("[inert]"), focused: document.activeElement === button,
      paths: svg.querySelectorAll("path").length, bars: svg.querySelectorAll("rect").length,
      centerHit: hit?.id ?? hit?.localName, hitCenterControl: button.contains(hit) };
  });
  assert.equal(value.show, true, `${state}: Settings must not remove the existing center visual`);
  assert.ok(value.opacity * value.svgOpacity > .98, `${state}: the center icon must stay painted behind Settings`);
  assert.equal(value.label, paused ? "Play video" : "Pause video");
  assert.equal(value.bars, paused ? 0 : 2, `${state}: center glyph must match the intended playback state`);
  assert.equal(value.paths, paused ? 1 : 0);
  assert.equal(value.pointerEvents, "none", `${state}: a painted background control must not receive pointer input`);
  assert.equal(value.tabIndex, -1); assert.equal(value.ariaHidden, "true");
  assert.equal(value.focused, false); assert.equal(value.hitCenterControl, false);
  if (touch) assert.equal(value.inert, true, `${state}: the mobile modal must keep its background inert`);
  return { state, ...value };
}

async function transparentTapFeedback(page, state) {
  const result = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("*")];
    const unstyled = [];
    const failures = nodes.flatMap(element => {
      const style = getComputedStyle(element);
      const color = style.webkitTapHighlightColor;
      // Media <source> nodes can expose an empty tap property and no painted box.
      if (color === "" && !element.getClientRects().length) {
        unstyled.push(element.localName);
        return [];
      }
      const transparent = color === "transparent" || /^rgba\([^,]+,[^,]+,[^,]+,\s*0(?:\.0+)?\s*\)$/.test(color);
      return transparent ? [] : [{ element: `${element.localName}${element.id ? `#${element.id}` : ""}`, color }];
    });
    return { checked: nodes.length - unstyled.length, unstyled, failures };
  });
  assert.ok(result.checked > 0, `${state}: tap feedback audit found no elements`);
  assert.deepEqual(result.failures, [], `${state}: native tap highlights must be transparent on every element`);
  return { state, checked: result.checked, unstyled: result.unstyled };
}

const focusFeedback = element => {
  const style = getComputedStyle(element);
  const visual = node => {
    const computed = getComputedStyle(node);
    return {
      background: computed.backgroundColor, color: computed.color,
      fill: computed.fill, stroke: computed.stroke,
      decoration: computed.textDecorationLine,
      ...(node.matches("#progress-track, #progress-thumb") ? {
        height: computed.height, width: computed.width, opacity: computed.opacity,
      } : {}),
    };
  };
  return {
    focused: document.activeElement === element,
    visible: element.matches(":focus-visible"),
    outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth),
    border: ["Top", "Right", "Bottom", "Left"].map(side => parseFloat(style[`border${side}Width`]) === 0 || style[`border${side}Style`] === "none"
      ? "none" : `${style[`border${side}Width`]} ${style[`border${side}Style`]} ${style[`border${side}Color`]}`),
    boxShadow: style.boxShadow,
    centerCircleFill: element.id === "big-play" ? getComputedStyle(element.querySelector(":scope > svg > circle")).fill : null,
    feedback: [visual(element), ...[...element.querySelectorAll("svg, path, polygon, rect, #progress-track, #progress-thumb")].map(visual)],
  };
};

async function visibleKeyboardFocus(page, selector) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(0, 0); // Hover must not mask the keyboard feedback being compared.
  await page.waitForTimeout(240);
  const baseline = await page.locator(selector).evaluate(focusFeedback);
  await page.keyboard.press("Tab");
  await page.locator(selector).focus();
  await page.waitForTimeout(240);
  const focus = await page.locator(selector).evaluate(focusFeedback);
  assert.equal(focus.focused, true, `${selector}: control did not receive keyboard focus`);
  assert.equal(focus.visible, true, `${selector}: keyboard focus should remain visible`);
  assert.ok(focus.outlineStyle === "none" || focus.outlineWidth === 0, `${selector}: focused control has an outline`);
  assert.deepEqual(focus.border, baseline.border, `${selector}: focus changed its perimeter border`);
  assert.equal(focus.boxShadow, baseline.boxShadow, `${selector}: focus added a perimeter shadow`);
  if (selector === "#big-play") {
    assert.ok(["transparent", "rgba(0, 0, 0, 0)"].includes(focus.centerCircleFill), "Focused center play must not retain a dark inset circle that creates a bright rim");
  }
  assert.notDeepEqual(focus.feedback, baseline.feedback, `${selector}: keyboard focus needs visible fill, text, icon, or slider feedback`);
  return { selector, baseline, focus };
}

async function spaceTransport(page, name, { repeat = false } = {}) {
  await page.evaluate(() => {
    const video = document.querySelector("video");
    window.__spaceReview = { play: 0, pause: 0, clicks: 0 };
    if (window.__spaceReviewBound) return;
    window.__spaceReviewBound = true;
    video.addEventListener("play", () => window.__spaceReview.play++);
    video.addEventListener("pause", () => window.__spaceReview.pause++);
    document.querySelector("#player-wrap").addEventListener("click", () => window.__spaceReview.clicks++, true);
  });
  const read = () => page.evaluate(() => {
    const video = document.querySelector("video"), panel = document.querySelector("#settings-panel");
    return { paused: video.paused, time: video.currentTime, volume: video.volume, muted: video.muted,
      focused: document.activeElement.id, page: panel.dataset.page, menuHidden: panel.hidden,
      speed: document.querySelector("#speed-label").textContent, ...window.__spaceReview };
  });
  const before = await read();
  assert.equal(before.paused, true, `${name}: Space review must start paused`);
  await page.keyboard.down("Space");
  await page.waitForFunction(() => !document.querySelector("video").paused);
  if (repeat) {
    await page.keyboard.down("Space");
    await page.keyboard.down("Space");
    await page.waitForTimeout(100);
    const held = await read();
    assert.equal(held.paused, false, `${name}: repeated keydown must not toggle again`);
    assert.equal(held.play, 1);
    assert.equal(held.pause, 0);
  }
  await page.keyboard.up("Space");
  await page.waitForTimeout(100);
  const released = await read();
  assert.equal(released.paused, false, `${name}: Space keyup must not trigger a second action`);
  assert.equal(released.play, 1);
  assert.equal(released.pause, 0);
  assert.equal(released.clicks, 0, `${name}: Space must not synthesize a native control click`);
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector("video").paused && window.__spaceReview.pause === 1);
  const after = await read();
  assert.equal(after.play, 1);
  assert.equal(after.pause, 1, `${name}: a second physical press must pause exactly once`);
  assert.equal(after.clicks, 0);
  for (const key of ["volume", "muted", "focused", "page", "menuHidden", "speed"]) {
    assert.equal(after[key], before[key], `${name}: Space changed ${key}`);
  }
  assert.ok(after.time >= before.time && after.time < before.time + 2, `${name}: Space must only advance normal playback`);
  return { name, repeat, before, released, after };
}

async function volumeRangeFeedback(page) {
  const slider = page.locator("#vol-slider");
  const baseline = await slider.evaluate(decoration);
  const read = () => slider.evaluate(element => {
    const video = document.querySelector("video");
    return { value: Number(element.value), volume: video.volume, muted: video.muted, paused: video.paused,
      time: video.currentTime, focused: document.activeElement === element, visible: element.matches(":focus-visible"),
      prefs: JSON.parse(localStorage.getItem("aida-player-prefs")) };
  });
  const yellow = pixel => [232, 255, 71].every((channel, index) => Math.abs(pixel[index] - channel) <= 3);
  const captures = [];
  const painted = async name => {
    const state = await read();
    const file = `${artifacts}/desktop-volume-${name}.png`;
    const png = await slider.screenshot({ path: file });
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x, y = Math.floor(info.height / 2)) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    // Native range thumbs move across the track's width minus their 12px diameter.
    // Inspect the painted pixels because Chromium does not reliably expose native
    // range pseudo-element colors through getComputedStyle.
    const thumbX = Math.round(6 + (info.width - 12) * state.value);
    const thumb = pixel(thumbX);
    if (state.visible) assert.ok(yellow(thumb), `${name}: keyboard focus must visibly fill the thumb yellow`);
    else assert.ok(thumb.every(channel => channel >= 250), `${name}: pointer thumb must stay white`);
    const filled = state.value >= .2 ? pixel(4) : null;
    if (filled) assert.ok(yellow(filled), `${name}: used volume track must paint Aida yellow`);
    const unused = state.value <= .8 ? pixel(info.width - 5) : null;
    if (unused) {
      assert.equal(yellow(unused), false, `${name}: unused volume track must never turn yellow`);
      assert.ok(Math.max(...unused) >= 40, `${name}: unused track must remain painted (${unused.join(", ")})`);
    }
    const actual = await slider.evaluate(decoration);
    assert.ok(actual.outlineStyle === "none" || actual.outlineWidth === 0, `${name}: volume range has an outline`);
    assert.deepEqual(actual.border, baseline.border, `${name}: volume range changed its perimeter border`);
    assert.equal(actual.boxShadow, baseline.boxShadow, `${name}: volume range added a perimeter shadow`);
    captures.push({ name, file, state, thumb, filled, unused });
    return captures.at(-1);
  };
  const unchangedPlayback = (actual, expected, action) => {
    assert.equal(actual.paused, expected.paused, `${action}: range input must not toggle playback`);
    assert.equal(actual.time, expected.time, `${action}: range input must not seek the video`);
  };

  const saved = await read();
  assert.equal(saved.value, .6, "saved volume must initialize the range");
  assert.equal(saved.volume, .6);
  assert.equal(saved.muted, false);
  assert.equal(saved.paused, true);
  await painted("saved");
  const box = await slider.boundingBox();
  await page.mouse.click(box.x + box.width * .35, box.y + box.height / 2);
  const pointer = await painted("pointer");
  assert.equal(pointer.state.focused, true, "pointer activation must leave the native range focused");
  assert.equal(pointer.state.visible, false);
  assert.ok(pointer.state.value > .25 && pointer.state.value < .45);
  assert.equal(pointer.state.volume, pointer.state.value);
  assert.equal(pointer.state.prefs.volume, pointer.state.value);
  unchangedPlayback(pointer.state, saved, "pointer volume");

  const space = await spaceTransport(page, "volume range", { repeat: true });
  const keyboard = await painted("keyboard");
  assert.equal(keyboard.state.focused, true, "Space must not blur the volume range");
  assert.equal(keyboard.state.visible, true);
  assert.equal(keyboard.state.value, pointer.state.value, "Space must not change the selected volume");
  assert.equal(keyboard.state.volume, pointer.state.volume);
  assert.equal(keyboard.state.muted, pointer.state.muted);
  assert.deepEqual(keyboard.filled, pointer.filled, "Space must preserve the used track's color");
  assert.equal(keyboard.state.paused, true);
  await page.screenshot({ path: `${artifacts}/desktop-volume-keyboard-page.png` });

  for (const [key, expected] of [["ArrowRight", pointer.state.value + .01], ["ArrowLeft", pointer.state.value], ["Home", 0], ["End", 1]]) {
    await page.keyboard.press(key);
    const state = await read();
    assert.ok(Math.abs(state.value - expected) < .00001, `${key}: native volume range must select ${expected}`);
    assert.equal(state.volume, state.value);
    assert.equal(state.prefs.volume, state.value);
    assert.equal(state.muted, state.value === 0);
    assert.equal(state.focused, true);
    unchangedPlayback(state, keyboard.state, `${key} on volume`);
    await painted(key.toLowerCase());
  }

  await page.mouse.click(box.x + box.width * .35, box.y + box.height / 2);
  const audible = await read();
  await page.locator("#mute-btn").click();
  const muted = await painted("muted");
  assert.equal(muted.state.value, 0);
  assert.equal(muted.state.muted, true);
  assert.equal(muted.state.volume, audible.volume, "muting must preserve the selected volume");
  assert.equal(muted.state.prefs.volume, audible.volume);
  await page.locator("#mute-btn").click();
  const restored = await painted("restored");
  assert.equal(restored.state.value, audible.value, "unmute must restore the selected volume and fill");
  assert.equal(restored.state.muted, false);
  assert.equal(restored.state.prefs.volume, audible.volume);
  unchangedPlayback(restored.state, keyboard.state, "mute/unmute");

  // Keep the surrounding focus review's saved playback state independent of this case.
  await slider.evaluate((element, saved) => {
    element.value = saved.volume;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("video").muted = saved.muted;
  }, saved);
  console.log("PASS desktop volume: painted partial fill, pointer then Space, native range keys, mute/restore, saved preferences");
  return { captures, space };
}

async function spaceControlFeedback(page) {
  const cases = [];
  const savedMuted = await page.locator("video").evaluate(video => video.muted);
  await page.locator("#mute-btn").click();
  cases.push(await spaceTransport(page, "mute button"));
  await page.locator("#settings-btn").focus();
  cases.push(await spaceTransport(page, "closed Settings trigger"));
  await page.locator("#settings-btn").click();
  await page.waitForFunction(() => document.querySelector("#settings-panel").dataset.phase === "open");
  cases.push(await spaceTransport(page, "open Settings heading"));
  await page.locator("#settings-btn").focus();
  cases.push(await spaceTransport(page, "open Settings trigger"));
  await page.locator("#speed-btn").click();
  await page.waitForFunction(() => document.querySelector("#settings-panel").dataset.phase === "open"
    && document.querySelector("#settings-panel").dataset.page === "speed");
  await page.locator('#speed-menu [data-speed="1.5"]').focus();
  cases.push(await spaceTransport(page, "Settings speed option"));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
  await page.locator("#mute-btn").click();
  const timeline = await page.locator("#progress-wrap").boundingBox();
  await page.mouse.click(timeline.x + timeline.width * .3, timeline.y + timeline.height / 2);
  await page.waitForFunction(() => !document.querySelector("video").seeking);
  assert.equal(await page.evaluate(() => document.activeElement.id), "progress-wrap", "pointer seeking must focus its actual control");
  cases.push(await spaceTransport(page, "timeline seek after mute control"));
  await page.locator(".back-link").focus();
  await page.mouse.click(timeline.x + timeline.width * .4, timeline.y + timeline.height / 2);
  await page.waitForFunction(() => !document.querySelector("video").seeking);
  assert.equal(await page.evaluate(() => document.activeElement.id), "progress-wrap", "seeking must replace stale focus outside the player");
  cases.push(await spaceTransport(page, "timeline seek after page link focus"));
  if (await page.locator("video").evaluate(video => video.muted) !== savedMuted) await page.locator("#mute-btn").click();
  console.log("PASS desktop Space: focused mute, Settings trigger, menu option, seek after control, no native click or repeat toggles");
  return cases;
}

try {
  for (const [label, viewport, touch] of [["desktop", { width: 1440, height: 1000 }, false], ["mobile", { width: 424, height: 900 }, true]]) {
    const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/eruda@*/**", route => route.abort());
    await context.route("https://fonts.googleapis.com/**", route => route.abort());
    await context.route("https://fonts.gstatic.com/**", route => route.abort());
    await context.addInitScript(touch => {
      localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360,
        ...(touch ? { muted: true } : { volume: .6, muted: false }) }));
      localStorage.setItem("aida-cc-banner-dismissed", "1");
    }, touch);
    try {
      await page.goto(preview.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("#watch-status").hidden && !document.querySelector("#player-wrap").inert && document.querySelector("video").readyState >= 2 && !document.querySelector("#spinner").classList.contains("show"), null, { timeout: 45000 });
      await page.locator("#player-wrap").scrollIntoViewIfNeeded();
      const baseline = await page.locator("#player-wrap").evaluate(decoration);
      const tapHighlights = [await transparentTapFeedback(page, "ready watch")];
      const session = touch ? await context.newCDPSession(page) : null;
      const pressPoint = async (x, y) => {
        if (!touch) return page.mouse.click(x, y);
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, radiusX: 3, radiusY: 3, force: 1 }] });
        await page.waitForTimeout(100);
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      const activate = async selector => {
        if (!touch) return page.locator(selector).click();
        const rect = await page.locator(selector).boundingBox();
        return pressPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      };
      const heldTouch = async (selector, name, fraction = .5) => {
        const rect = await page.locator(selector).boundingBox();
        const before = await page.locator(selector).evaluate(decoration);
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: rect.x + rect.width * fraction,
          y: rect.y + rect.height / 2, radiusX: 3, radiusY: 3, force: 1 }] });
        try {
          await page.waitForTimeout(100);
          tapHighlights.push(await transparentTapFeedback(page, `held touch ${name}`));
          const pressed = await page.locator(selector).evaluate(decoration);
          assert.ok(pressed.outlineStyle === "none" || pressed.outlineWidth === 0, `${name}: held touch added an outline`);
          assert.deepEqual(pressed.border, before.border, `${name}: held touch changed the perimeter border`);
          assert.equal(pressed.boxShadow, before.boxShadow, `${name}: held touch added a perimeter shadow`);
          await wrapperCheck(page, baseline, `held touch ${name}`);
          await page.screenshot({ path: `${artifacts}/${label}-${name}-touch-held.png` });
        } finally {
          await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        }
      };

      // Programmatic wrapper focus must inherit keyboard modality without outlining the picture.
      await page.keyboard.press("Tab");
      await page.locator("#player-wrap").focus();
      await wrapperCheck(page, baseline, "keyboard wrapper focus");
      await page.evaluate(async () => {
        const video = document.querySelector("video");
        video.pause();
        const decoded = new Promise((resolveFrame, rejectFrame) => {
          const timeout = setTimeout(() => rejectFrame(new Error("Focus screenshot frame did not decode")), 15000);
          video.requestVideoFrameCallback(() => { clearTimeout(timeout); resolveFrame(); });
        });
        video.currentTime = 6;
        await decoded;
      });
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector("#controls")).opacity) > .99 && !document.querySelector("#spinner").classList.contains("show"));
      await page.screenshot({ path: `${artifacts}/${label}-wrapper-focus.png` });
      if (touch) {
        await heldTouch("#progress-wrap", "seekbar", .25);
        await page.waitForFunction(() => !document.querySelector("video").seeking && !document.querySelector("#spinner").classList.contains("show"));
      }

      const centerSettings = [];
      await activate("#settings-btn");
      await page.waitForFunction(() => document.querySelector("#settings-panel").dataset.phase === "open");
      centerSettings.push(await paintedCenterInSettings(page, { paused: true, touch, state: "initial home" }));
      await page.screenshot({ path: `${artifacts}/${label}-initial-center-settings.png` });
      await activate("#quality-btn");
      await page.waitForFunction(() => document.querySelector("#settings-panel").dataset.page === "quality"
        && !document.querySelector("#settings-panel").getAnimations({ subtree: true }).some(animation => animation.playState === "running"));
      centerSettings.push(await paintedCenterInSettings(page, { paused: true, touch, state: "initial quality" }));
      await activate("#settings-back");
      await page.waitForFunction(() => document.querySelector("#settings-panel").dataset.page === "home"
        && !document.querySelector("#settings-panel").getAnimations({ subtree: true }).some(animation => animation.playState === "running"));
      const center = await page.locator("#big-play").boundingBox();
      await pressPoint(center.x + center.width / 2, center.y + center.height / 2);
      await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
      assert.equal(await page.locator("video").evaluate(video => video.paused), true,
        "Pressing the painted center behind Settings must only dismiss the menu");
      assert.equal(await page.evaluate(() => document.activeElement.id), "settings-btn");

      await activate("#big-play");
      await page.waitForFunction(() => !document.querySelector("video").paused);
      await wrapperCheck(page, baseline, "pointer play");
      await activate(touch ? "#big-play" : "#play-btn");
      await page.waitForFunction(() => document.querySelector("video").paused);
      await wrapperCheck(page, baseline, "pointer pause");

      const picture = await page.locator("#player-wrap").boundingBox();
      await pressPoint(picture.x + picture.width * .2, picture.y + picture.height * .35);
      if (!touch) {
        await page.waitForFunction(() => !document.querySelector("video").paused);
        await wrapperCheck(page, baseline, "surface click play");
        await page.waitForTimeout(300);
        await pressPoint(picture.x + picture.width * .2, picture.y + picture.height * .35);
        await page.waitForFunction(() => document.querySelector("video").paused);
      } else assert.equal(await page.locator("video").evaluate(video => video.paused), true);
      await wrapperCheck(page, baseline, "surface pointer focus");

      const volumeRange = touch ? null : await volumeRangeFeedback(page);
      const spaceControls = touch ? null : await spaceControlFeedback(page);

      await page.keyboard.press("Tab");
      await page.locator("#player-wrap").focus();
      await page.keyboard.press("k");
      await page.waitForFunction(() => !document.querySelector("video").paused);
      await wrapperCheck(page, baseline, "keyboard play");
      await page.keyboard.press("Space");
      await page.waitForFunction(() => document.querySelector("video").paused);
      await wrapperCheck(page, baseline, "keyboard pause");

      const focusedControls = [];
      focusedControls.push(await visibleKeyboardFocus(page, touch ? "#big-play" : "#play-btn"));
      await page.screenshot({ path: `${artifacts}/${label}-button-focus.png` });
      focusedControls.push(await visibleKeyboardFocus(page, "#progress-wrap"));
      await page.screenshot({ path: `${artifacts}/${label}-slider-focus.png` });
      await wrapperCheck(page, baseline, "focused slider");

      await activate("#settings-btn");
      await page.waitForFunction(() => document.querySelector("#settings-panel").dataset.phase === "open");
      if (touch) centerSettings.push(await paintedCenterInSettings(page, { paused: true, touch, state: "paused home" }));
      else assert.equal(await page.locator("#big-play").evaluate(button => button.classList.contains("show")), false,
        "Opening desktop Settings after playback must not create a new permanent center cue");
      tapHighlights.push(await transparentTapFeedback(page, "settings home"));
      focusedControls.push(await visibleKeyboardFocus(page, "#speed-btn"));
      await page.screenshot({ path: `${artifacts}/${label}-menu-focus.png` });
      if (touch) await heldTouch("#speed-btn", "settings-speed");
      else await activate("#speed-btn");
      await page.waitForFunction(() => document.querySelector("#settings-panel").dataset.phase === "open" && document.querySelector("#settings-panel").dataset.page === "speed");
      tapHighlights.push(await transparentTapFeedback(page, "settings speed"));
      await activate("#settings-back");
      await page.waitForFunction(() => document.querySelector("#settings-panel").dataset.phase === "open" && document.querySelector("#settings-panel").dataset.page === "home");
      await activate("#quality-btn");
      await page.waitForFunction(() => document.querySelector("#settings-panel").dataset.phase === "open" && document.querySelector("#settings-panel").dataset.page === "quality" && document.querySelector("#quality-menu-content button"));
      if (touch) centerSettings.push(await paintedCenterInSettings(page, { paused: true, touch, state: "paused quality" }));
      assert.equal(await page.locator("#quality-menu-content details, #quality-menu-content summary").count(), 0,
        "Quality controls must not hide behind a disclosure");
      assert.equal(await page.locator("#quality-menu-content > :first-child").evaluate(element =>
        element.matches("section.playback-advanced") && element.getAttribute("aria-label") === "Playback format"
          && !element.textContent.includes("Advanced playback")), true,
      "Compact playback format controls belong at the top, without the removed Advanced playback heading");
      for (const selector of ['.playback-advanced button[aria-label="AV1 codec"]', '.playback-advanced button[aria-label="DASH streaming protocol"]']) {
        assert.equal(await page.locator(selector).isVisible(), true, `${selector}: static playback controls must be immediately visible`);
        focusedControls.push(await visibleKeyboardFocus(page, selector));
      }
      if (touch) await heldTouch('.playback-advanced button[aria-label="AV1 codec"]', "quality-codec");
      tapHighlights.push(await transparentTapFeedback(page, "settings dynamic quality and advanced controls"));
      await activate("#settings-back");
      await page.waitForFunction(() => document.querySelector("#settings-panel").dataset.phase === "open" && document.querySelector("#settings-panel").dataset.page === "home");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
      assert.equal(await page.evaluate(() => document.activeElement.id), "settings-btn");
      await wrapperCheck(page, baseline, "settings Escape focus return");

      await page.locator("#player-wrap").focus();
      await page.evaluate(() => { document.querySelector("video").currentTime = 6; });
      await page.waitForFunction(() => !document.querySelector("video").seeking);
      await page.keyboard.press(".");
      await page.waitForFunction(() => !document.querySelector("video").seeking && Math.abs(document.querySelector("video").currentTime - (6 + 1 / 120)) < .0011);
      const forward = await page.locator("video").evaluate(video => video.currentTime);
      assert.ok(Math.abs(forward - (6 + 1 / 120)) < .0011, `period frame time ${forward}`);
      await page.keyboard.press(",");
      await page.waitForFunction(() => !document.querySelector("video").seeking && Math.abs(document.querySelector("video").currentTime - 6) < .0011);
      assert.ok(Math.abs(await page.locator("video").evaluate(video => video.currentTime) - 6) < .0011);
      assert.equal(await page.locator("video").evaluate(video => video.paused), true);
      await wrapperCheck(page, baseline, "frame shortcuts");

      let fullscreen = "unsupported";
      if (await page.locator("#fs-btn").isVisible() && await page.locator("#player-wrap").evaluate(element => !!element.requestFullscreen)) {
        await activate("#fs-btn");
        await page.waitForFunction(() => document.fullscreenElement?.id === "player-wrap");
        await wrapperCheck(page, baseline, "fullscreen entry");
        await activate("#fs-btn");
        await page.waitForFunction(() => !document.fullscreenElement);
        await wrapperCheck(page, baseline, "fullscreen exit");
        fullscreen = "passed";
      }
      focusedControls.push(await visibleKeyboardFocus(page, ".back-link"));
      if (await page.locator("#theatre-btn").isVisible()) {
        focusedControls.push(await visibleKeyboardFocus(page, "#theatre-btn"));
      }
      await page.goto(`${preview.origin}/index.html`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !document.querySelector("#search-input").disabled);
      tapHighlights.push(await transparentTapFeedback(page, "ready library"));
      focusedControls.push(await visibleKeyboardFocus(page, "#search-input"));
      await page.screenshot({ path: `${artifacts}/${label}-search-focus.png` });
      assert.deepEqual(errors, []);
      results.push({ label, passed: true, fullscreen, forward, focusedControls, tapHighlights, centerSettings, volumeRange, spaceControls, errors });
      console.log(`PASS ${label}: transparent native tap feedback, wrapper focus, controls, keyboard, settings, frame stepping; fullscreen ${fullscreen}`);
    } catch (error) {
      await page.screenshot({ path: `${artifacts}/${label}-failure.png` }).catch(() => {});
      results.push({ label, passed: false, error: error.message });
      throw error;
    } finally { await context.close(); }
  }
} catch (error) {
  process.exitCode = 1;
  console.error(error.stack);
} finally {
  await browser.close();
  await preview.close();
  await writeFile(`${artifacts}/results.json`, JSON.stringify(results, null, 2));
}
