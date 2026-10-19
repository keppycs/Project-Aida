import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { FIRST_VIDEO, startAdminPreview } from "./support/admin-preview.mjs";
import { startPlayerPreview } from "./support/player-preview.mjs";

const require = createRequire(import.meta.url);
const modules = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = require(`${modules}/playwright`), sharp = require(`${modules}/sharp`);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = resolve("logs", `disclosure-motion-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const results = [];
const requested = process.argv.find(value => value.startsWith("--profile="))?.split("=")[1];
const profiles = [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 360, height: 800, touch: true }]
  .filter(profile => !requested || profile.name === requested);
const settle = (page, panel, open) => page.waitForFunction(({ panel, open }) => {
  const element = document.querySelector(panel);
  return element.hidden === !open && element.dataset.phase === (open ? "open" : "closed") && !element.getAnimations().length;
}, { panel, open });

async function transition(page, spec, open) {
  await page.evaluate(({ trigger, panel, peer }) => {
    const button = document.querySelector(trigger), section = document.querySelector(panel), next = document.querySelector(peer);
    const baseline = button.getBoundingClientRect().toJSON();
    window.disclosureCapture = new Promise((done, reject) => {
      const samples = [], start = performance.now(); let started = false;
      const sample = now => {
        const phase = section.dataset.phase;
        started ||= ["opening", "closing"].includes(phase);
        if (started) {
          const style = getComputedStyle(section), matrix = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
          samples.push({ phase, time: now - start, hidden: section.hidden, inert: section.inert, opacity: Number(style.opacity), clip: style.clipPath,
            y: matrix.m42, scale: [matrix.m11, matrix.m22], trigger: button.getBoundingClientRect().toJSON(), peer: next.getBoundingClientRect().toJSON(),
            properties: [section, next].flatMap(element => element.getAnimations().flatMap(motion => motion.effect.getKeyframes().flatMap(frame => Object.keys(frame)))) });
        }
        if (started && ["open", "closed"].includes(phase)) return done({ baseline, samples });
        if (now - start > 3000) return reject(new Error("Disclosure never settled"));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  }, spec);
  await page.locator(spec.trigger).click();
  return page.evaluate(() => window.disclosureCapture);
}

function verify(record, open, reduced) {
  const frames = record.samples.filter(sample => sample.phase === (open ? "opening" : "closing"));
  const intermediate = frames.filter(sample => sample.opacity > .01 && sample.opacity < .99);
  assert.ok(intermediate.length >= (reduced ? 1 : 3), "Actual opening/closing must paint intermediate frames");
  for (const sample of record.samples) {
    for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(sample.trigger[key] - record.baseline[key]) < .5, `Disclosure trigger moved ${key}`);
    assert.deepEqual(sample.scale, [1, 1]);
    assert.equal(sample.properties.some(property => ["height", "width", "top", "bottom", "padding", "margin"].includes(property)), false);
  }
  assert.ok(frames.every(sample => !sample.hidden && sample.inert === !open));
  for (let index = 1; index < frames.length; ++index) assert.ok(open ? frames[index].opacity >= frames[index - 1].opacity - .01 : frames[index].opacity <= frames[index - 1].opacity + .01);
  if (reduced) assert.ok(frames.every(sample => Math.abs(sample.y) < .01 && ["none", "inset(0px)"].includes(sample.clip)));
  else {
    assert.ok(intermediate.some(sample => sample.clip !== "none" && Math.abs(sample.y) > .05));
    assert.ok(Math.abs(frames.at(-1).peer.y - frames[0].peer.y) > 30, "Following content must move through intermediate positions");
  }
}

async function filmstrip(page, spec, open, name) {
  await page.locator(spec.trigger).scrollIntoViewIfNeeded();
  await page.evaluate(({ trigger, panel, peer }) => {
    document.querySelector(trigger).click();
    const root = document.querySelector(trigger).closest(".editor-form, .videos-section");
    window.disclosureFilm = document.getAnimations().filter(motion => root.contains(motion.effect.target));
    window.disclosureFilm.forEach(motion => { motion.pause(); motion.currentTime = 0; });
  }, spec);
  const clip = await page.evaluate(({ trigger, panel }) => {
    const button = document.querySelector(trigger).getBoundingClientRect(), section = document.querySelector(panel).getBoundingClientRect();
    const top = Math.max(0, Math.floor(button.top - 6));
    return { left: Math.max(0, Math.floor(section.x - 4)), top,
      width: Math.ceil(section.width + 8), height: Math.min(innerHeight - top, Math.ceil(section.bottom - button.top + 115)) };
  }, spec);
  const frames = [], paints = [];
  for (const fraction of [0, .25, .5, .75, 1]) {
    await page.evaluate(async fraction => {
      window.disclosureFilm.forEach(motion => { if (motion.playState !== "idle") motion.currentTime = Number(motion.effect.getTiming().duration) * fraction; });
      await new Promise(requestAnimationFrame);
    }, fraction);
    paints.push(await page.locator(spec.panel).evaluate(element => ({ phase: element.dataset.phase, opacity: Number(getComputedStyle(element).opacity), clip: getComputedStyle(element).clipPath,
      motions: element.getAnimations().map(motion => ({ currentTime: motion.currentTime, state: motion.playState })) })));
    // Full-page/beyond-viewport screenshots can resize Chromium internally.
    // Capture the actual visible viewport without altering live motion.
    const screenshot = await page.screenshot({ animations: "allow" }), metadata = await sharp(screenshot).metadata();
    frames.push(await sharp(screenshot).extract({ ...clip, width: Math.min(clip.width, metadata.width - clip.left), height: Math.min(clip.height, metadata.height - clip.top) }).resize({ width: 600, withoutEnlargement: true }).png().toBuffer());
  }
  const { width, height } = await sharp(frames[0]).metadata();
  await sharp({ create: { width: width * 2, height: height * 3, channels: 4, background: "#101112" } })
    .composite(frames.map((input, index) => ({ input, left: index % 2 * width, top: Math.floor(index / 2) * height })))
    .png().toFile(resolve(artifacts, `${name}-${open ? "opening" : "closing"}.png`));
  await writeFile(resolve(artifacts, `${name}-${open ? "opening" : "closing"}.json`), JSON.stringify(paints));
  assert.ok(paints.slice(1, 4).every(paint => paint.opacity > 0 && paint.opacity < 1), "Filmstrip must capture actual intermediate paints");
  await page.evaluate(() => window.disclosureFilm.forEach(motion => { if (motion.playState !== "idle") motion.finish(); }));
  await settle(page, spec.panel, open);
}

console.log(`Disclosure artifacts: ${artifacts}`);
for (const profile of profiles) for (const kind of ["studio-local", "studio-live", "frame-local", "frame-live", "public"]) {
  const publicPage = kind === "public", framePicker = kind.startsWith("frame-");
  const fixture = publicPage ? await startPlayerPreview() : await startAdminPreview({ live: kind.endsWith("live"), noPreview: true });
  const browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
  try {
    const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, hasTouch: !!profile.touch, isMobile: !!profile.touch });
    await context.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
    if (publicPage) await context.route("**/local/index.json*", route => route.fulfill({ json: [{ id: "synthetic", title: "Synthetic video", visibility: "public", tags: ["CS2"] }] }));
    if (kind === "studio-local") await context.route("**/api/dedupe/last", route => route.fulfill({ json: {
      has_duplicates: true, applied: false, prefix: "", versions_to_delete: 2, keys_with_duplicates: 1, bytes_reclaimed: 1024,
    } }));
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(publicPage ? `${fixture.origin}/index.html?local=1` : `${fixture.origin}/edit?v=${FIRST_VIDEO}`);
    const spec = publicPage ? { trigger: ".search-tools-toggle", panel: "#search-tools-body", peer: "#videos-grid" }
      : framePicker ? { trigger: "#thumbnail-frame-toggle", panel: "#thumbnail-frame-fields", peer: ".editor-actions" }
      : { trigger: "#tag-create", panel: "#tag-manager", peer: ".visibility-field" };
    await page.waitForFunction(trigger => !document.querySelector(trigger).disabled && !!window.AidaUI && (document.querySelector("#video-editor")?.getClientRects().length || document.querySelector(".search-tools-toggle")), spec.trigger);
    if (publicPage) await page.waitForFunction(() => !document.querySelector("#search-input").disabled);
    await page.locator(spec.trigger).scrollIntoViewIfNeeded();
    const performance = await context.newCDPSession(page); await performance.send("Performance.enable");
    const record = { profile: profile.name, kind, transitions: [] };
    for (const reduced of [false, true]) {
      await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
      for (const open of [true, false]) {
        const before = (await performance.send("Performance.getMetrics")).metrics.find(metric => metric.name === "LayoutCount").value;
        const capture = await transition(page, spec, open);
        const layouts = (await performance.send("Performance.getMetrics")).metrics.find(metric => metric.name === "LayoutCount").value - before;
        verify(capture, open, reduced);
        if (open && !publicPage && !framePicker) {
          const gap = await page.evaluate(() => document.querySelector("#tag-manager").getBoundingClientRect().top - document.querySelector("#tag-create").getBoundingClientRect().bottom);
          assert.ok(gap >= 0 && gap <= 16, "Manage tags must open directly beneath its button, ahead of suggestions");
        }
        assert.ok(layouts <= 10, `Disclosure did ${layouts} layouts; motion must not lay out each frame`);
        record.transitions.push({ reduced, open, layouts, ...capture });
      }
    }
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator(spec.trigger).click(); await settle(page, spec.panel, true);
    const input = publicPage ? "#tag-search" : framePicker ? "#edit-title" : "#tag-name";
    await page.locator(input).fill("draft kept");
    const poses = await page.evaluate(async ({ trigger, panel, peer }) => {
      const button = document.querySelector(trigger), section = document.querySelector(panel), next = document.querySelector(peer);
      const pose = () => { const style = getComputedStyle(section); return { opacity: Number(style.opacity), transform: style.transform, peer: next.getBoundingClientRect().y }; };
      button.click(); const poses = [];
      for (let index = 0; index < 3; ++index) {
        const motion = section.getAnimations()[0]; motion.pause(); motion.currentTime = Number(motion.effect.getTiming().duration) * .4;
        await new Promise(requestAnimationFrame);
        const before = pose(); button.click(); poses.push({ before, after: pose() });
      }
      return poses;
    }, spec);
    for (const { before, after } of poses) {
      assert.ok(before.opacity > .005 && before.opacity < .9995);
      assert.ok(Math.abs(before.opacity - after.opacity) < .01);
      assert.equal(before.transform, after.transform);
      assert.ok(Math.abs(before.peer - after.peer) < .5, "Reversal must preserve following content's painted position");
    }
    await settle(page, spec.panel, true);
    assert.equal(await page.locator(input).inputValue(), "draft kept");
    await page.locator(spec.trigger).click();
    const elsewhere = publicPage ? "#search-input" : "#edit-title";
    await page.locator(elsewhere).focus(); await settle(page, spec.panel, false);
    assert.equal(await page.locator(elsewhere).evaluate(element => document.activeElement === element), true);
    if (!publicPage && !framePicker) {
      await page.locator(spec.trigger).click(); await settle(page, spec.panel, true);
      await page.locator("#tag-manage-button").click();
      await page.waitForFunction(() => document.querySelector("#tag-manage-panel").dataset.phase === "open");
      await page.locator(spec.trigger).click();
      assert.equal(await page.locator("#tag-manage-panel").getAttribute("data-phase"), "closing", "Closing the parent must animate an open selector's exit too");
      await settle(page, spec.panel, false);
      assert.equal(await page.locator("#tag-manage-panel").evaluate(element => element.hidden), true);
    }
    await page.locator(spec.trigger).scrollIntoViewIfNeeded();
    const box = await page.locator(spec.trigger).boundingBox(), point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.locator(spec.trigger).evaluate(element => element.click());
    const touch = profile.touch ? await context.newCDPSession(page) : null;
    if (touch) await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
    const held = await page.evaluate(async ({ trigger, point }) => {
      const button = document.querySelector(trigger), boxes = [];
      for (let index = 0; index < 5; ++index) { await new Promise(requestAnimationFrame); boxes.push({ box: button.getBoundingClientRect().toJSON(), hit: document.elementFromPoint(point.x, point.y)?.closest("button") === button }); }
      return boxes;
    }, { ...spec, point });
    for (const sample of held) { assert.ok(sample.hit); for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(sample.box[key] - box[key]) < .5); }
    if (touch) { await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await touch.detach(); } else await page.mouse.up();
    await settle(page, spec.panel, false);
    await filmstrip(page, spec, true, `${profile.name}-${kind}`);
    await filmstrip(page, spec, false, `${profile.name}-${kind}`);
    if (kind === "studio-local") {
      await page.locator("#tab-maint").click();
      await page.waitForFunction(() => !document.querySelector("#apply-dedupe").disabled);
      for (const reduced of [false, true]) {
        await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
        for (const open of [true, false]) {
          await page.evaluate(() => {
            const dialog = document.querySelector("#confirm-dialog"), samples = [];
            window.dialogCapture = new Promise(done => {
              let started = false;
              const frame = () => {
                started ||= ["opening", "closing"].includes(dialog.dataset.phase);
                if (started) samples.push({ phase: dialog.dataset.phase, opacity: Number(getComputedStyle(dialog).opacity), open: dialog.open, inert: dialog.inert });
                if (started && ["open", "closed"].includes(dialog.dataset.phase)) return done(samples);
                requestAnimationFrame(frame);
              }; requestAnimationFrame(frame);
            });
          });
          if (open) await page.locator("#apply-dedupe").click(); else await page.keyboard.press("Escape");
          const samples = await page.evaluate(() => window.dialogCapture);
          assert.ok(samples.filter(sample => sample.opacity > .01 && sample.opacity < .99).length >= (reduced ? 1 : 3), "Confirmation must paint intermediate opening/closing frames");
          if (!open) {
            assert.ok(samples.filter(sample => sample.phase === "closing").every(sample => sample.open && sample.inert), "Closing confirmation must retain modality and block repeated actions");
            assert.equal(await page.evaluate(() => document.activeElement.id), "apply-dedupe");
          }
        }
      }
      assert.equal(fixture.state.requests.some(request => request.path === "/api/dedupe/apply"), false, "Motion review must never delete anything");
    }
    assert.deepEqual(errors, []);
    assert.equal(await page.locator("select").count(), 0, "No native select menus remain");
    results.push({ ...record, poses, held });
    console.log(`PASS ${profile.name} ${kind}: disclosure opening, closing, reversals, held target, draft/focus retention and reduced motion`);
  } finally { await browser.close(); await fixture.close(); }
}
await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2));
