import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { startPlayerPreview } from "./support/player-preview.mjs";

const require = createRequire(import.meta.url);
const runtime = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || runtime);
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
    await context.addInitScript(() => {
      localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360, muted: true }));
      localStorage.setItem("aida-cc-banner-dismissed", "1");
    });
    try {
      await page.goto(preview.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("#watch-status").hidden && !document.querySelector("#player-wrap").inert && document.querySelector("video").readyState >= 2 && !document.querySelector("#spinner").classList.contains("show"), null, { timeout: 45000 });
      await page.locator("#player-wrap").scrollIntoViewIfNeeded();
      const baseline = await page.locator("#player-wrap").evaluate(decoration);
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
      focusedControls.push(await visibleKeyboardFocus(page, "#speed-btn"));
      await page.screenshot({ path: `${artifacts}/${label}-menu-focus.png` });
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
      focusedControls.push(await visibleKeyboardFocus(page, "#search-input"));
      await page.screenshot({ path: `${artifacts}/${label}-search-focus.png` });
      assert.deepEqual(errors, []);
      results.push({ label, passed: true, fullscreen, forward, focusedControls, errors });
      console.log(`PASS ${label}: wrapper focus, controls, keyboard, settings, frame stepping; fullscreen ${fullscreen}`);
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
