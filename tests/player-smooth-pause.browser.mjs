import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { startPlayerPreview } from "./support/player-preview.mjs";

const require = createRequire(import.meta.url);
const modules = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || `${modules}/playwright`);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = process.env.AIDA_REVIEW_DIR || `C:/Users/keppy/AppData/Local/Temp/codex-work/aida-smooth-pause-${Date.now()}`;
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const preview = await startPlayerPreview();
const browser = await chromium.launch({ executablePath, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const report = { cases: [] };
let page;
console.log(`Smooth Pause artifacts: ${artifacts}`);

function instrument() {
  if (!localStorage.getItem("aida-player-prefs")) localStorage.setItem("aida-player-prefs", JSON.stringify({ codec: "AV1", protocol: "DASH", quality: 360, volume: .6, muted: false }));
  localStorage.setItem("aida-cc-banner-dismissed", "1");
  window.__smooth = { writes: [], gains: [], sources: [], events: [], captures: [], playCalls: [], gainCommands: [] };
  const originalSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (key === "aida-player-prefs") window.__smooth.writes.push({ at: performance.now(), value: JSON.parse(value) });
    return originalSet.call(this, key, value);
  };
  const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
  if (NativeAudioContext) {
    class ObservedAudioContext extends NativeAudioContext {
      createGain() {
        const node = super.createGain();
        const analyser = this.createAnalyser();
        analyser.fftSize = 512;
        node.connect(analyser);
        for (const method of ["setValueAtTime", "linearRampToValueAtTime"]) {
          const native = node.gain[method].bind(node.gain);
          node.gain[method] = (...args) => {
            window.__smooth.gainCommands.push({ at: performance.now(), method, args });
            return native(...args);
          };
        }
        window.__smooth.gains.push({ node, analyser, context: this });
        return node;
      }
      createMediaElementSource(media) {
        const node = super.createMediaElementSource(media);
        const analyser = this.createAnalyser();
        analyser.fftSize = 512;
        node.connect(analyser);
        window.__smooth.sources.push({ node, media, analyser });
        return node;
      }
    }
    window.AudioContext = ObservedAudioContext;
    if (window.webkitAudioContext) window.webkitAudioContext = ObservedAudioContext;
  }
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    window.__smooth.playCalls.push({ at: performance.now(), gain: window.__smooth.gains.at(-1)?.node.gain.value ?? null,
      lastGainCommand: window.__smooth.gainCommands.at(-1) ?? null });
    return nativePlay.apply(this, args);
  };
  window.__smoothState = () => {
    const video = document.querySelector("video");
    const graph = window.__smooth.gains.at(-1);
    const level = analyser => {
      if (!analyser) return null;
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      return Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length);
    };
    return {
      at: performance.now(), paused: video.paused, time: video.currentTime, rate: video.playbackRate,
      volume: video.volume, muted: video.muted, label: document.querySelector("#play-btn").getAttribute("aria-label"),
      bigLabel: document.querySelector("#big-play").getAttribute("aria-label"),
      speedLabel: document.querySelector("#speed-label").textContent,
      gain: graph?.node.gain.value ?? null, rms: level(graph?.analyser), inputRms: level(window.__smooth.sources.at(-1)?.analyser), audioState: graph?.context.state ?? null,
    };
  };
  window.__armSmooth = label => {
    const capture = { label, actionAt: null, samples: [], storageStart: window.__smooth.writes.length };
    window.__smooth.capture = capture;
    window.__smooth.captures.push(capture);
    const started = performance.now();
    const frame = () => {
      capture.samples.push(window.__smoothState());
      if (performance.now() - started < 650) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };
  document.addEventListener("click", event => {
    if (!event.target.closest("#play-btn, #big-play")) return;
    const capture = window.__smooth.capture;
    if (!capture || capture.actionAt !== null) return;
    capture.actionAt = performance.now();
    // Browser microtask checkpoints may run between capture and target listeners.
    // A zero-delay task samples after the complete trusted click dispatch.
    setTimeout(() => capture.samples.push({ ...window.__smoothState(), immediate: true }), 0);
  }, true);
}

async function ready() {
  await page.waitForFunction(() => document.querySelector("#watch-stage").getAttribute("aria-busy") === "false" && document.querySelector("video").readyState >= 2, null, { timeout: 45000 });
}

async function settled(name = "home") {
  await page.waitForFunction(name => {
    const panel = document.querySelector("#settings-panel");
    return panel.dataset.phase === "open" && panel.dataset.page === name && !panel.getAnimations({ subtree: true }).some(animation => animation.playState === "running");
  }, name);
}

async function capture(label, action) {
  await page.evaluate(label => window.__armSmooth(label), label);
  await action();
  await page.waitForTimeout(680);
  return page.evaluate(() => {
    const capture = window.__smooth.capture;
    return { ...capture, writes: window.__smooth.writes.slice(capture.storageStart), samples: capture.samples.filter(sample => sample.at >= capture.actionAt).map(sample => ({ ...sample, elapsed: sample.at - capture.actionAt })) };
  });
}

function verifyEnvelope(capture, paused, rate, volume) {
  assert.ok(capture.actionAt !== null, `${capture.label}: actual control click was not observed`);
  const immediate = capture.samples.find(sample => sample.immediate);
  assert.equal(immediate.label, paused ? "Play video" : "Pause video", `${capture.label}: icon must reflect requested intent immediately`);
  const intermediate = capture.samples.filter(sample => sample.elapsed > 15 && sample.elapsed < 135 && !sample.paused);
  assert.ok(intermediate.some(sample => sample.rate > .25 && sample.rate < rate - .01), `${capture.label}: native playbackRate must ease through intermediate values`);
  assert.ok(intermediate.some(sample => sample.gain > .01 && sample.gain < .99), `${capture.label}: real GainNode must have intermediate envelope values`);
  assert.ok(capture.samples.every(sample => Math.abs(sample.volume - volume) < .0001), `${capture.label}: user volume must not be animated when GainNode is available`);
  assert.ok(capture.samples.every(sample => !sample.muted), `${capture.label}: envelope must not change mute`);
  assert.ok(capture.samples.every(sample => sample.speedLabel === `${rate}×`), `${capture.label}: selected speed label must stay stable`);
  const last = capture.samples.at(-1);
  assert.equal(last.paused, paused);
  assert.equal(last.rate, rate);
  assert.equal(last.gain, paused ? 0 : 1);
  assert.ok(capture.writes.length <= 1, `${capture.label}: envelope persisted ${capture.writes.length} temporary preference writes`);
  if (paused) {
    assert.equal(immediate.paused, false, "smooth pause must decelerate before the real pause");
    const stop = capture.samples.find(sample => sample.paused);
    assert.ok(stop.elapsed >= 115 && stop.elapsed <= 230, `140ms pause settled at ${stop.elapsed}ms`);
    const attenuated = capture.samples.filter(sample => !sample.paused && sample.gain < .15 && sample.inputRms > .00001);
    assert.ok(attenuated.some(sample => sample.rms / sample.inputRms < .2), `${capture.label}: real post-gain audio must attenuate before the native pause`);
    assert.equal(last.rms, 0, "paused gain graph must stay silent");
  } else {
    assert.ok(last.rms > .000001, "resumed audio must return to an audible nonzero signal");
  }
}

try {
  for (const [label, viewport, touch] of [["desktop", { width: 1440, height: 1000 }, false], ["touch", { width: 424, height: 900 }, true]]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch });
    await context.addInitScript(instrument);
    await context.route("**/eruda@*/**", route => route.abort());
    await context.route("https://fonts.googleapis.com/**", route => route.abort());
    await context.route("https://fonts.gstatic.com/**", route => route.abort());
    page = await context.newPage();
    const result = { label, errors: [] };
    report.cases.push(result);
    page.on("pageerror", error => result.errors.push(error.message));
    const cdp = touch ? await context.newCDPSession(page) : null;
    const activate = async selector => {
      if (!touch) return page.locator(selector).click();
      const box = await page.locator(selector).boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, `${selector} must be reachable by real touch`);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
      await page.waitForTimeout(80);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    const transport = touch ? "#big-play" : "#play-btn";
    const open = async () => { await page.locator("#player-wrap").focus(); await activate("#settings-btn"); await settled(); };
    const close = async () => { await activate("#settings-close"); await page.waitForFunction(() => document.querySelector("#settings-panel").hidden); };
    await page.goto(preview.url, { waitUntil: "domcontentloaded" });
    await ready();
    // Real browser regression for native .play + queued seek event ordering.
    await page.evaluate(async () => { const video = document.querySelector("video"); video.pause(); video.currentTime = 6; await video.play(); });
    await page.waitForTimeout(100);
    assert.equal(await page.locator("video").evaluate(video => video.paused), false, "default Off must be transparent to ordinary native play after a seek");
    await page.locator("video").evaluate(video => video.pause());
    await open();
    assert.equal(await page.locator("#smooth-pause-toggle").getAttribute("aria-checked"), "false");
    await page.screenshot({ path: `${artifacts}/${label}-smooth-pause-off.png` });
    await close();
    await activate(touch ? "#big-play" : "#play-btn");
    await page.waitForFunction(() => !document.querySelector("video").paused);
    result.defaultPause = await capture("default-off-pause", () => activate(transport));
    assert.equal(result.defaultPause.samples.find(sample => sample.immediate).paused, true, "Off pauses immediately");
    assert.equal(result.defaultPause.samples.at(-1).paused, true, "a control click must not bubble into a delayed surface play toggle");
    result.defaultResume = await capture("default-off-resume", () => activate(transport));
    assert.equal(result.defaultResume.samples.find(sample => sample.immediate).rate, 1);
    assert.equal(await page.evaluate(() => window.__smooth.gains.length), 0, "Off must not create an audio graph");
    await open();
    await activate("#smooth-pause-toggle");
    assert.equal(await page.locator("#smooth-pause-toggle").getAttribute("aria-checked"), "true");
    await page.waitForFunction(() => window.__smooth.gains.length === 1 && window.__smooth.gains[0].context.state === "running");
    await page.waitForFunction(() => !document.querySelector("#smooth-pause-toggle").getAnimations({ subtree: true }).some(animation => animation.playState === "running"));
    await page.screenshot({ path: `${artifacts}/${label}-smooth-pause-on.png` });
    await activate("#speed-btn");
    await settled("speed");
    await activate('#speed-menu [data-speed="1.5"]');
    await page.waitForFunction(() => document.querySelector("#settings-panel").hidden);
    await page.waitForTimeout(100);
    result.audioBefore = await page.evaluate(() => window.__smoothState());
    assert.ok(result.audioBefore.rms > .000001, "public fixture must produce a real nonzero post-gain audio signal");
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("aida-player-prefs")));
    const volume = touch ? 1 : .6;
    result.pause = await capture("smooth-pause", () => activate(transport));
    verifyEnvelope(result.pause, true, 1.5, volume);
    result.resume = await capture("smooth-resume", () => activate(transport));
    verifyEnvelope(result.resume, false, 1.5, volume);
    result.resumePlay = await page.evaluate(() => window.__smooth.playCalls.at(-1));
    assert.equal(result.resumePlay.lastGainCommand.method, "setValueAtTime");
    assert.equal(result.resumePlay.lastGainCommand.args[0], 0, "gain must be silenced immediately before native resume");
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("aida-player-prefs"))), saved, "temporary rate/gain envelope must leave preferences unchanged");

    await page.locator("#player-wrap").focus();
    await page.keyboard.press("k");
    await page.waitForTimeout(65);
    const reversedFrom = await page.evaluate(() => window.__smoothState());
    await page.keyboard.press("k");
    await page.waitForTimeout(350);
    result.reversal = { from: reversedFrom, final: await page.evaluate(() => window.__smoothState()) };
    assert.equal(result.reversal.final.paused, false);
    assert.equal(result.reversal.final.rate, 1.5);
    assert.equal(result.reversal.final.gain, 1);

    // Pause intent followed by scrub must stay paused and restore nominal state.
    await page.keyboard.press("k");
    await page.waitForTimeout(45);
    const bounds = await page.locator("#progress-wrap").boundingBox();
    const from = { x: bounds.x + bounds.width * .25, y: bounds.y + bounds.height / 2 };
    const to = { x: bounds.x + bounds.width * .35, y: from.y };
    if (touch) await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
    else { await page.mouse.move(from.x, from.y); await page.mouse.down(); }
    result.scrubDown = await page.evaluate(() => window.__smoothState());
    assert.equal(result.scrubDown.paused, true);
    assert.equal(result.scrubDown.rate, 1.5);
    if (touch) {
      await page.waitForTimeout(100);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [to] });
      await page.waitForTimeout(100);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else { await page.mouse.move(to.x, to.y, { steps: 6 }); await page.mouse.up(); }
    await page.waitForTimeout(350);
    assert.equal(await page.locator("video").evaluate(video => video.paused), true);

    await page.locator("#player-wrap").focus();
    await page.keyboard.press("k");
    await page.waitForTimeout(350);
    await page.keyboard.press("k");
    await page.waitForTimeout(35);
    await page.keyboard.press(".");
    await page.waitForFunction(() => document.querySelector("video").paused && !document.querySelector("video").seeking);
    result.frameStep = await page.evaluate(() => window.__smoothState());
    assert.equal(result.frameStep.rate, 1.5);
    assert.equal(result.frameStep.gain, 0);
    await page.waitForTimeout(250);
    assert.equal(await page.locator("video").evaluate(video => video.paused), true);

    await page.reload({ waitUntil: "domcontentloaded" });
    await ready();
    await open();
    assert.equal(await page.locator("#smooth-pause-toggle").getAttribute("aria-checked"), "true", "toggle persists across reload");
    assert.equal(await page.locator("#smooth-pause-value").textContent(), "On");
    assert.equal(await page.locator("#speed-label").textContent(), "1.5×");
    result.saved = await page.evaluate(() => JSON.parse(localStorage.getItem("aida-player-prefs")));
    assert.equal(result.saved.muted, false);
    assert.equal(result.saved.volume, .6);
    await close();
    result.restoredResume = await capture("saved-smooth-resume", () => activate(touch ? "#big-play" : "#play-btn"));
    verifyEnvelope(result.restoredResume, false, 1.5, volume);
    assert.deepEqual(result.errors, []);
    await context.close();
    page = null;
    await writeFile(`${artifacts}/results.json`, JSON.stringify(report, null, 2));
    console.log(`${label}: default-off, gain/rate envelopes, rapid reversal, scrub/frame cancellation and persistence passed`);
  }
} catch (error) {
  report.failure = error.stack;
  if (page && !page.isClosed()) {
    report.failureState = await page.evaluate(() => ({ state: window.__smoothState?.(), panel: document.querySelector("#settings-panel")?.outerHTML.slice(0, 800), storage: localStorage.getItem("aida-player-prefs") }));
    await page.screenshot({ path: `${artifacts}/failure.png` });
  }
  throw error;
} finally {
  await writeFile(`${artifacts}/results.json`, JSON.stringify(report, null, 2));
  await browser.close();
  await preview.close();
}
