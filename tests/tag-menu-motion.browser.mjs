import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { FIRST_VIDEO, startAdminPreview } from "./support/admin-preview.mjs";

const require = createRequire(import.meta.url);
const modules = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = require(`${modules}/playwright`);
const sharp = require(`${modules}/sharp`);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = resolve("logs", `tag-menu-motion-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const requested = process.argv.find(value => value.startsWith("--profile="))?.split("=")[1];
const profiles = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 360, height: 800, touch: true },
].filter(profile => !requested || requested.split(",").includes(profile.name));
assert.ok(profiles.length);
const results = [];
const settle = (page, prefix, open) => page.waitForFunction(({ prefix, open }) => {
  const panel = document.getElementById(`${prefix}-panel`);
  return panel.hidden === !open && panel.dataset.phase === (open ? "open" : "closed") && !panel.getAnimations().length;
}, { prefix, open });

async function capture(page, prefix, open) {
  await page.evaluate(({ prefix, open }) => {
    const panel = document.getElementById(`${prefix}-panel`), button = document.getElementById(`${prefix}-button`);
    const neighbour = document.getElementById("tag-name");
    const baseline = [button, neighbour].map(element => element.getBoundingClientRect().toJSON());
    window.menuCapture = new Promise((resolveCapture, reject) => {
      const samples = [], start = performance.now();
      let started = false;
      function frame(now) {
        const phase = panel.dataset.phase;
        started ||= phase === "opening" || phase === "closing";
        if (started) {
          const style = getComputedStyle(panel), matrix = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
          samples.push({ time: now - start, phase, hidden: panel.hidden, opacity: Number(style.opacity), y: matrix.m42,
            scale: [matrix.m11, matrix.m22], clip: style.clipPath, inert: panel.inert,
            boxes: [button, neighbour].map(element => element.getBoundingClientRect().toJSON()),
            properties: panel.getAnimations().flatMap(animation => animation.effect.getKeyframes().flatMap(keyframe => Object.keys(keyframe))) });
        }
        if (started && phase === (open ? "open" : "closed")) return resolveCapture({ samples, baseline });
        if (now - start > 3000) return reject(new Error("Menu transition did not settle"));
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  }, { prefix, open });
  await page.locator(`#${prefix}-button`).click();
  return page.evaluate(() => window.menuCapture);
}

function verifyTransition(record, open, reduced) {
  const phase = open ? "opening" : "closing";
  const frames = record.samples.filter(sample => sample.phase === phase);
  const intermediate = frames.filter(sample => sample.opacity > .01 && sample.opacity < .99);
  assert.ok(intermediate.length >= (reduced ? 1 : 3), `${phase}: expected painted intermediate frames, got ${intermediate.length}`);
  assert.ok(frames.every(sample => !sample.hidden && sample.inert === !open));
  for (const sample of record.samples) {
    sample.boxes.forEach((box, index) => {
      for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(box[key] - record.baseline[index][key]) < .5, `${phase}: moved a control's ${key}`);
    });
    assert.deepEqual(sample.scale, [1, 1], "Menu motion must never scale text or controls");
    assert.equal(sample.properties.some(property => ["height", "width", "top", "bottom", "padding", "margin"].includes(property)), false);
  }
  for (let index = 1; index < frames.length; ++index) {
    assert.ok(open ? frames[index].opacity >= frames[index - 1].opacity - .01 : frames[index].opacity <= frames[index - 1].opacity + .01, `${phase}: opacity must progress smoothly`);
  }
  if (reduced) assert.ok(frames.every(sample => Math.abs(sample.y) < .01 && ["none", "inset(0px)"].includes(sample.clip)), "Reduced motion uses a short fade without travel or clipping");
  else {
    assert.ok(intermediate.some(sample => Math.abs(sample.y) > .05 && sample.clip !== "none"), "Normal motion must reveal and translate the menu");
    assert.ok(intermediate.some(sample => [...sample.clip.matchAll(/([\d.]+)%/g)].some(match => Number(match[1]) > 0 && Number(match[1]) < 100)), "Normal motion must paint a partially clipped frame in both directions");
  }
}

async function filmstrip(page, prefix, open, name) {
  await page.locator(`#${prefix}-button`).scrollIntoViewIfNeeded();
  await page.evaluate(({ prefix, open }) => {
    document.getElementById(`${prefix}-button`).click();
    const panel = document.getElementById(`${prefix}-panel`);
    window.menuFilm = panel.getAnimations()[0];
    window.menuFilm.pause();
    window.menuFilm.currentTime = 0;
    window.menuArrow = document.getElementById(`${prefix}-button`).querySelector("svg").getAnimations()[0];
    window.menuArrow?.pause();
  }, { prefix, open });
  const clip = await page.evaluate(prefix => {
    const panel = document.getElementById(`${prefix}-panel`).getBoundingClientRect();
    const button = document.getElementById(`${prefix}-button`).getBoundingClientRect();
    const x = Math.max(0, Math.floor(Math.min(panel.x, button.x) - 10)), y = Math.max(0, Math.floor(Math.min(panel.y, button.y) - 12));
    return { left: x, top: y, width: Math.min(innerWidth - x, Math.ceil(Math.max(panel.right, button.right) - x + 10)),
      height: Math.min(innerHeight - y, Math.ceil(Math.max(panel.bottom, button.bottom) - y + 12)) };
  }, prefix);
  const frames = [], paints = [];
  for (const fraction of [0, .25, .5, .75, 1]) {
    await page.evaluate(async fraction => {
      const time = window.menuFilm.effect.getTiming().duration * fraction;
      window.menuFilm.currentTime = time;
      if (window.menuArrow) window.menuArrow.currentTime = Math.min(time, window.menuArrow.effect.getTiming().duration);
      await new Promise(requestAnimationFrame);
    }, fraction);
    paints.push(await page.locator(`#${prefix}-panel`).evaluate(panel => ({ phase: panel.dataset.phase, opacity: Number(getComputedStyle(panel).opacity), clip: getComputedStyle(panel).clipPath, box: panel.getBoundingClientRect().toJSON() })));
    // Full-page capture can resize Chromium and reposition a viewport-fitted
    // menu. Capture only the live viewport so the filmstrip proves its paint.
    const screenshot = await page.screenshot({ animations: "allow" });
    const size = await sharp(screenshot).metadata();
    frames.push(await sharp(screenshot).extract({ ...clip, width: Math.min(clip.width, size.width - clip.left), height: Math.min(clip.height, size.height - clip.top) }).png().toBuffer());
  }
  const { width, height } = await sharp(frames[0]).metadata();
  await sharp({ create: { width: width * 2, height: height * 3, channels: 4, background: "#101112" } })
    .composite(frames.map((input, index) => ({ input, left: index % 2 * width, top: Math.floor(index / 2) * height })))
    .png().toFile(resolve(artifacts, `${name}-${prefix}-${open ? "opening" : "closing"}.png`));
  await writeFile(resolve(artifacts, `${name}-${prefix}-${open ? "opening" : "closing"}.json`), JSON.stringify(paints));
  assert.ok(paints.slice(1, 4).every(paint => paint.opacity > 0 && paint.opacity < 1), "Filmstrip must retain intermediate live paints");
  assert.ok(paints.slice(1, 4).some(paint => [...paint.clip.matchAll(/([\d.]+)%/g)].some(match => Number(match[1]) > 0 && Number(match[1]) < 100)), "Filmstrip must show partially clipped menu content");
  await page.evaluate(() => { if (window.menuFilm.playState !== "idle") window.menuFilm.finish(); if (window.menuArrow && window.menuArrow.playState !== "idle") window.menuArrow.finish(); });
  await settle(page, prefix, open);
}

async function reversals(page, prefix) {
  await page.locator(`#${prefix}-button`).click();
  await settle(page, prefix, true);
  await page.locator(`#${prefix}-search`).fill("cs");
  const poses = await page.evaluate(async prefix => {
    const panel = document.getElementById(`${prefix}-panel`), button = document.getElementById(`${prefix}-button`);
    const pose = () => {
      const style = getComputedStyle(panel), values = style.clipPath === "none" ? ["0"] : style.clipPath.slice(6, -1).split(/\s+/);
      const [top, right = top, bottom = top, left = right] = values;
      const insets = [top, right, bottom, left].map((value, index) => parseFloat(value) * (value.endsWith("%") ? (index % 2 ? panel.offsetWidth : panel.offsetHeight) / 100 : 1));
      return { opacity: Number(style.opacity), transform: style.transform, clip: style.clipPath, insets };
    };
    const reverse = async () => {
      const motion = panel.getAnimations()[0]; motion.pause(); motion.currentTime = motion.effect.getTiming().duration * .4;
      await new Promise(requestAnimationFrame);
      const before = pose(); button.click(); const after = pose();
      return { before, after };
    };
    button.click();
    const first = await reverse(), second = await reverse(), third = await reverse();
    return [first, second, third];
  }, prefix);
  for (const { before, after } of poses) {
    assert.ok(before.opacity > .005 && before.opacity < .9995, "Reversal must be tested from an intermediate painted frame");
    assert.ok(Math.abs(before.opacity - after.opacity) < .01, "A reversed transition must retain its painted opacity");
    assert.equal(after.transform, before.transform, "A reversed transition must retain its painted position");
    before.insets.forEach((value, index) => assert.ok(Math.abs(value - after.insets[index]) < .05, "A reversed transition must retain its painted reveal"));
  }
  await settle(page, prefix, true);
  assert.equal(await page.locator(`#${prefix}-search`).inputValue(), "cs", "Rapid reopening must retain query input");
  await page.locator(`#${prefix}-search`).press("Escape");
  await page.locator("#tag-aliases").focus();
  await settle(page, prefix, false);
  assert.equal(await page.locator("#tag-aliases").evaluate(element => document.activeElement === element), true, "Close completion must not steal focus");
  return poses;
}

async function heldPointer(page, prefix, profile) {
  const button = page.locator(`#${prefix}-button`);
  await button.scrollIntoViewIfNeeded();
  const rect = await button.boundingBox(), point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const touch = profile.touch ? await page.context().newCDPSession(page) : null;
  await button.evaluate(element => element.click());
  if (touch) await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
  const frames = await page.evaluate(async ({ prefix, point }) => {
    const button = document.getElementById(`${prefix}-button`), frames = [];
    for (let index = 0; index < 5; ++index) {
      await new Promise(requestAnimationFrame);
      frames.push({ box: button.getBoundingClientRect().toJSON(), hit: document.elementFromPoint(point.x, point.y)?.closest("button") === button });
    }
    return frames;
  }, { prefix, point });
  if (touch) { await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await touch.detach(); }
  else await page.mouse.up();
  for (const frame of frames) {
    assert.ok(frame.hit, "A held pointer must stay on its trigger during menu motion");
    for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(frame.box[key] - rect[key]) < .5);
  }
  await settle(page, prefix, false);
}

console.log(`Tag menu motion artifacts: ${artifacts}`);
for (const profile of profiles) for (const live of [false, true]) {
  const fixture = await startAdminPreview({ live, noPreview: true });
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, hasTouch: !!profile.touch, isMobile: !!profile.touch });
    await context.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${fixture.origin}/edit?v=${FIRST_VIDEO}`);
    await page.waitForFunction(() => !document.querySelector("#tag-create").disabled);
    await page.locator("#tag-create").click();
    await page.waitForFunction(() => document.querySelector("#tag-manager").dataset.phase === "open");
    await page.locator("#tag-manage-button").click();
    await page.locator('#tag-manage-options [data-value="cs2"]').click();
    await settle(page, "tag-manage", false);
    const performance = await context.newCDPSession(page);
    await performance.send("Performance.enable");
    for (const prefix of ["tag-manage", "tag-merge"]) {
      const record = { profile: profile.name, live, prefix };
      await page.locator(`#${prefix}-button`).scrollIntoViewIfNeeded();
      for (const reduced of [false, true]) {
        await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
        for (const open of [true, false]) {
          const before = (await performance.send("Performance.getMetrics")).metrics.find(metric => metric.name === "LayoutCount").value;
          const transition = await capture(page, prefix, open);
          const layouts = (await performance.send("Performance.getMetrics")).metrics.find(metric => metric.name === "LayoutCount").value - before;
          verifyTransition(transition, open, reduced);
          assert.ok(layouts <= 8, `Menu motion must not lay out each frame: ${layouts} layouts`);
          record[`${reduced ? "reduced" : "normal"}-${open ? "open" : "close"}`] = { ...transition, layouts };
        }
      }
      await page.emulateMedia({ reducedMotion: "no-preference" });
      record.reversals = await reversals(page, prefix);
      await heldPointer(page, prefix, profile);
      await page.locator(`#${prefix}-button`).evaluate(element => element.click());
      await page.emulateMedia({ reducedMotion: "reduce" });
      await settle(page, prefix, true);
      await page.locator(`#${prefix}-search`).press("Escape");
      await settle(page, prefix, false);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const name = `${profile.name}-${live ? "live" : "local"}`;
      await filmstrip(page, prefix, true, name);
      await filmstrip(page, prefix, false, name);
      results.push(record);
    }
    assert.deepEqual(errors, []);
    assert.equal(fixture.state.requests.filter(request => request.method === "POST").length, 0, "Motion tests must not save any changes");
    console.log(`PASS ${profile.name} ${live ? "live" : "local"}: both menus animate through intermediate frames, reverse smoothly, preserve held pointer/focus and respect reduced motion`);
    await performance.detach();
  } finally { await browser.close(); await fixture.close(); }
}
await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
