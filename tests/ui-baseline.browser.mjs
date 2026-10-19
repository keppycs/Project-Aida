import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { FIRST_VIDEO, startAdminPreview } from "./support/admin-preview.mjs";
import { startPlayerPreview } from "./support/player-preview.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = resolve("logs", `ui-baseline-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(dirname(executablePath), "../..");
const requested = process.argv.find(value => value.startsWith("--profile="))?.split("=")[1];
const profiles = [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 360, height: 800, touch: true }]
  .filter(profile => !requested || profile.name === requested);
assert.ok(profiles.length);
const browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
const results = [];
const settled = (page, selector, phase) => page.waitForFunction(({ selector, phase }) => document.querySelector(selector).dataset.phase === phase, { selector, phase });
async function check(page, name, run) {
  try { const evidence = await run(); results.push({ name, passed: true, evidence }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, failure: error.message }); console.log(`FAIL ${name}: ${error.message.split("\n")[0]}`); await page.screenshot({ path: resolve(artifacts, `${name}-failure.png`) }); }
}
async function compose(page, input, text, key) {
  await page.locator(input).focus();
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => { window.compositionKeys = []; document.addEventListener("keydown", event => window.compositionKeys.push({ key: event.key, composing: event.isComposing, code: event.keyCode }), { capture: true }); });
  await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  await page.keyboard.press(key);
  const keys = await page.evaluate(() => window.compositionKeys);
  assert.ok(keys.some(event => event.composing && event.key === key), "The browser must deliver a real composing key event");
  await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
  await cdp.detach();
  return keys;
}

console.log(`UI baseline artifacts: ${artifacts}`);
try {
  for (const profile of profiles) {
    for (const scenario of ["dialog-focus", "tag-composition", "selector-composition", "held-thumb", "pending-tag-input", "job-reconnect", "log-reading", "probe-stale"]) {
      const fixture = await startAdminPreview({ noPreview: true });
      const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, hasTouch: !!profile.touch, isMobile: !!profile.touch });
      await context.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
      if (scenario === "dialog-focus") await context.route("**/api/dedupe/last", route => route.fulfill({ json: { has_duplicates: true, applied: false, prefix: "", versions_to_delete: 2, keys_with_duplicates: 1, bytes_reclaimed: 1024 } }));
      const page = await context.newPage();
      try {
        await page.goto(`${fixture.origin}/edit?v=${FIRST_VIDEO}`);
        await page.waitForFunction(() => !document.querySelector("#tag-create").disabled);
        await check(page, `${profile.name}-${scenario}`, async () => {
          if (scenario === "probe-stale") {
            await page.locator("#tab-encode").click(); await page.locator("#title").fill("");
            let release, reached;
            const gate = new Promise(done => { release = done; }), started = new Promise(done => { reached = done; });
            await context.route("**/api/probe", async route => {
              const old = route.request().postDataJSON().path.endsWith("old.mp4");
              if (old) { reached(); await gate; }
              await route.fulfill({ json: { width: old ? 1280 : 2560, height: 1440, fps: old ? 60 : 120, duration: 10, source_codec: "hevc", is_hdr: false } }).catch(() => {});
            });
            await page.locator("#source-path").fill(`${artifacts}/old.mp4`); await started;
            await page.locator("#source-path").fill(`${artifacts}/new.mp4`);
            await page.waitForFunction(() => document.querySelector("#source-info").textContent.includes("120.0 fps"));
            release(); await page.waitForTimeout(150);
            assert.match(await page.locator("#source-info").textContent(), /2560.*120\.0 fps/, "A late probe must not replace information for the newer file");
            assert.equal(await page.locator("#title").inputValue(), "new"); return { newestSourceKept: true };
          }
          if (scenario === "job-reconnect" || scenario === "log-reading") {
            await page.locator("#tab-encode").click();
            fixture.emit({ type: "encode_start" });
            fixture.emit({ type: "progress", channel: "encode", stage: "AV1", current: 37, total: 100 });
            const progress = '#encode-progress [data-stage="AV1"] progress';
            await page.waitForFunction(selector => document.querySelector(selector).value === .37, progress);
            if (scenario === "log-reading") {
              for (let index = 0; index < 80; ++index) fixture.emit({ type: "log", channel: "encode", message: `Synthetic output line ${index}` });
              await page.waitForFunction(() => document.querySelector("#encode-log-body").textContent.includes("line 79"));
              const selected = await page.locator("#encode-log-body").evaluate(log => {
                log.scrollTop = 0;
                const range = document.createRange(); range.setStart(log.firstChild, 0); range.setEnd(log.firstChild, 9);
                getSelection().removeAllRanges(); getSelection().addRange(range); return getSelection().toString();
              });
              fixture.emit({ type: "log", channel: "encode", message: "Latest output" });
              await page.waitForFunction(() => document.querySelector("#encode-log-body").textContent.includes("Latest output"));
              assert.equal(await page.locator("#encode-log-body").evaluate(log => log.scrollTop), 0, "New logs must not override manual reading position");
              assert.equal(await page.evaluate(() => getSelection().toString()), selected, "Appending output must retain text selection");
              fixture.disconnectEvents();
              await page.waitForFunction(() => document.querySelector("#encode-status").textContent.startsWith("Connection interrupted"));
              await page.waitForFunction(() => document.querySelector("#encode-status").textContent === "Running pipeline…");
              assert.equal(await page.locator("#encode-log-body").evaluate(log => log.scrollTop), 0);
              assert.equal(await page.evaluate(() => getSelection().toString()), selected, "Reconnecting must retain selection in unchanged log content");
              return { readingAndSelectionKept: true };
            }
            await page.reload();
            await page.waitForFunction(selector => document.querySelector(selector).value === .37, progress);
            assert.equal(await page.locator("#start-pipeline").isDisabled(), true, "Reloading an active job must not offer a duplicate start");
            const other = await context.newPage(); await other.goto(`${fixture.origin}/edit`);
            await other.waitForFunction(selector => document.querySelector(selector).value === .37, progress);
            fixture.emit({ type: "progress", channel: "encode", stage: "AV1", current: 61, total: 100 });
            for (const tab of [page, other]) await tab.waitForFunction(selector => document.querySelector(selector).value === .61, progress);
            fixture.disconnectEvents();
            fixture.emit({ type: "progress", channel: "encode", stage: "AV1", current: 74, total: 100 });
            for (const tab of [page, other]) await tab.waitForFunction(selector => document.querySelector(selector).value === .74, progress);
            await page.locator("#tab-creds").click();
            fixture.emit({ type: "encode_done", ok: true, message: "Synthetic job complete", video_id: FIRST_VIDEO });
            await page.waitForFunction(() => !document.querySelector("#start-pipeline").disabled);
            assert.equal(await page.locator("#panel-creds").isVisible(), true, "Job completion must respect newer manual navigation");
            await page.evaluate(() => localStorage.setItem("aida-admin-tab", "creds"));
            await page.goto(`${fixture.origin}/edit`);
            await page.waitForFunction(() => document.querySelector("#encode-status").textContent === "Synthetic job complete");
            assert.equal(await page.locator("#panel-creds").isVisible(), true, "Restoring completed work must not replay its navigation");
            assert.equal(fixture.state.requests.some(request => request.path === "/api/pipeline"), false);
            return { twoTabs: true, reloadProgress: .37, liveProgress: .61, recoveredProgress: .74 };
          }
          if (scenario === "dialog-focus") {
            await page.locator("#tab-maint").click();
            await page.waitForFunction(() => !document.querySelector("#apply-dedupe").disabled);
            const focus = [];
            for (let cycle = 0; cycle < 3; ++cycle) {
              await page.locator("#apply-dedupe").click(); await settled(page, "#confirm-dialog", "open");
              focus.push({ cycle, ...await page.evaluate(() => ({ inside: document.querySelector("#confirm-dialog").contains(document.activeElement), target: document.activeElement.id || document.activeElement.tagName })) });
              await page.keyboard.press("Escape"); await settled(page, "#confirm-dialog", "closed");
            }
            assert.ok(focus.every(value => value.inside), `Every opening must move focus into the modal: ${JSON.stringify(focus)}`);
            return focus;
          }
          if (scenario === "tag-composition") {
            const count = await page.locator("#selected-tags button").count();
            const keys = await compose(page, "#tag-search", "cs", "Enter");
            assert.equal(await page.locator("#selected-tags button").count(), count, "Confirming IME text must not add a suggested tag");
            return keys;
          }
          await page.locator("#tag-create").click(); await settled(page, "#tag-manager", "open");
          if (scenario === "selector-composition") {
            await page.locator("#tag-manage-button").click(); await settled(page, "#tag-manage-panel", "open");
            const keys = await compose(page, "#tag-manage-search", "cs", "Enter");
            assert.equal(await page.locator("#tag-manage-button").getAttribute("aria-expanded"), "true", "IME confirmation must not select an option or dismiss the menu");
            return keys;
          }
          if (scenario === "held-thumb") {
            // Use the actual nested scrollbar, including its stopped pointerup.
            await page.locator("#tag-create").click(); await settled(page, "#tag-manager", "closed");
            await page.locator("#tag-create").scrollIntoViewIfNeeded();
            await page.evaluate(() => {
              document.querySelector("#tag-create").click();
              const motion = document.querySelector("#tag-manager").getAnimations()[0]; motion.pause(); motion.currentTime = Number(motion.effect.getTiming().duration) * .8;
              document.querySelector("#tag-manage-button").click();
            });
            await settled(page, "#tag-manage-panel", "open");
            const thumb = page.locator("#tag-manage-panel .scroll-thumb"); await thumb.waitFor({ state: "visible" });
            const box = await thumb.boundingBox(), x = box.x + box.width / 2, y = box.y + 5;
            const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains("scroll-thumb"), { x, y });
            assert.ok(hit, "The real scrollbar must be inside the painted panel");
            if (profile.touch) {
              const cdp = await context.newCDPSession(page);
              await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
              await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await cdp.detach();
            } else { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up(); }
            await page.waitForFunction(() => document.querySelector("#tag-manager").dataset.phase === "open", null, { timeout: 1200 });
            return { released: true };
          }
          let release, started;
          const gate = new Promise(done => { release = done; }), reached = new Promise(done => { started = done; });
          await context.route("**/api/tags", async route => { if (route.request().method() === "POST") { started(); await gate; } await route.continue(); });
          await page.locator("#tag-name").fill("First submitted tag");
          await page.locator("#tag-save").click(); await reached;
          await page.locator("#tag-name").fill("Newer unsaved tag name");
          release();
          await page.waitForFunction(() => document.querySelector("#tag-manager").getAttribute("aria-busy") === "false");
          assert.equal(await page.locator("#tag-name").inputValue(), "Newer unsaved tag name");
          assert.match(await page.locator("#tag-manager-status").textContent(), /newer.*unsaved/i, "Save feedback must distinguish pending edits from the submitted version");
          return { inputKept: true };
        });
      } finally { await context.close(); await fixture.close(); }
    }

    const fixture = await startPlayerPreview();
    const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, hasTouch: !!profile.touch, isMobile: !!profile.touch });
    const indexHTML = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
    const entries = Array.from({ length: 36 }, (_, index) => ({ id: `baseline-${index}`, title: `CS2 clip ${index}`, tags: ["CS2"], visibility: "public", frameRate: 120, duration: 12 }));
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== fixture.origin || url.pathname === "/__fixture/shaka.js") return route.fulfill({ contentType: "text/javascript", body: "" });
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: indexHTML });
      if (url.pathname === "/local/index.json") return route.fulfill({ json: entries });
      if (/^\/local\/[^/]+\/metadata.json$/.test(url.pathname)) return route.fulfill({ json: entries.find(entry => url.pathname.includes(`/${entry.id}/`)) });
      if (/thumbnail/.test(url.pathname)) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="405"><path fill="#29302a" d="M0 0h720v405H0z"/></svg>' });
      if (url.pathname === "/js/player/shell.js") return route.fulfill({ contentType: "text/javascript", body: "export async function mountPlayer() {}" });
      return route.continue();
    });
    const page = await context.newPage();
    const ready = () => page.waitForFunction(() => document.querySelector("#videos")?.getAttribute("aria-busy") === "false");
    try {
      await page.goto(`${fixture.origin}/?q=CS2`); await ready();
      await check(page, `${profile.name}-search-composition`, async () => {
        const keys = await compose(page, "#search-input", "CS", "Escape");
        assert.notEqual(await page.locator("#search-input").inputValue(), "", "IME Escape must not clear the entire search"); return keys;
      });
      await page.locator("#search-input").fill("CS2");
      await check(page, `${profile.name}-return-position`, async () => {
        const card = page.locator("#videos-grid .video-card").nth(28);
        await card.scrollIntoViewIfNeeded();
        const before = await page.evaluate(() => scrollY); assert.ok(before > 500);
        await card.click(); await page.waitForFunction(() => document.querySelector("#watch-stage")?.getAttribute("aria-busy") === "false");
        await page.locator(".back-link").click(); await ready();
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        const after = await page.evaluate(() => scrollY);
        assert.ok(Math.abs(before - after) < 2, `Back to videos must retain the collection position (${before} → ${after})`);
        return { before, after };
      });
      await check(page, `${profile.name}-native-back-position`, async () => {
        const card = page.locator("#videos-grid .video-card").nth(28);
        await card.scrollIntoViewIfNeeded();
        const before = await page.evaluate(() => scrollY);
        await card.click(); await page.waitForFunction(() => document.querySelector("#watch-stage")?.getAttribute("aria-busy") === "false");
        await page.goBack(); await ready();
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        const after = await page.evaluate(() => scrollY);
        assert.ok(Math.abs(before - after) < 2, `Native Back must keep the collection position (${before} → ${after})`);
        return { before, after };
      });
      await check(page, `${profile.name}-return-yields-to-input`, async () => {
        const card = page.locator("#videos-grid .video-card").nth(28);
        await card.scrollIntoViewIfNeeded(); await card.click();
        await page.waitForFunction(() => document.querySelector("#watch-stage")?.getAttribute("aria-busy") === "false");
        let release, reached;
        const gate = new Promise(done => { release = done; }), started = new Promise(done => { reached = done; });
        await page.route("**/local/index.json", async route => { reached(); await gate; await route.fulfill({ json: entries }); });
        await page.locator(".back-link").click(); await started;
        await page.keyboard.press("Tab");
        const active = await page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
        const before = await page.evaluate(() => scrollY);
        release(); await ready();
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        assert.equal(await page.evaluate(() => scrollY), before, "Late results must yield to newer keyboard navigation");
        assert.equal(await page.evaluate(() => document.activeElement.id || document.activeElement.tagName), active, "Passive return must not steal focus");
        await page.unroute("**/local/index.json");
        return { interrupted: true, active, y: before };
      });
    } finally { await context.close(); await fixture.close(); }
  }
} finally { await browser.close(); await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2)); }
assert.ok(results.every(result => result.passed), `UI baseline failures: ${results.filter(result => !result.passed).map(result => result.name).join(", ")}`);
