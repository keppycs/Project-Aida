import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { startPlayerPreview } from "./support/player-preview.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = resolve("logs", `search-tags-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
const preview = await startPlayerPreview();
const browser = await chromium.launch({ executablePath, headless: true });
const cs2 = { id: "game-cs2", name: "Counter-Strike 2", aliases: ["CS2", "Counterstrike 2"] };
const lethal = { id: "game-lethal", name: "Lethal Company", aliases: ["LC"] };
const entries = [
  { id: "featured", title: "Latest unrelated clip", tags: ["Football"], createdAt: 4 },
  { id: "nuts", title: "Nuts of steel", tagIds: [lethal.id], tagDefinitions: [lethal], tags: [lethal.name], createdAt: 3 },
  { id: "clutch", title: "Last round clutch", tagIds: [cs2.id], tagDefinitions: [cs2], tags: [cs2.name], createdAt: 2 },
  { id: "round", title: "A silent round", tagIds: [cs2.id], tagDefinitions: [cs2], tags: [cs2.name], createdAt: 1 },
].map(entry => ({ ...entry, visibility: "public", description: "Synthetic catalogue fixture", duration: 12, frameRate: 120, codecs: ["AV1"], width: 1280, height: 720 }));
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="405"><path fill="#29302a" d="M0 0h720v405H0z"/><text x="40" y="220" fill="#e8ff47" font-size="48">Aida search fixture</text></svg>';
const indexHTML = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const results = [];

try {
  for (const profile of [{ name: "desktop", width: 1440, height: 1000 }, { name: "phone", width: 360, height: 800, touch: true }]) {
    const context = await browser.newContext({ viewport: profile, isMobile: !!profile.touch, hasTouch: !!profile.touch });
    const requests = [], errors = [];
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== preview.origin) return route.fulfill({ contentType: "text/javascript", body: "" });
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: indexHTML });
      if (url.pathname === "/local/index.json") return route.fulfill({ contentType: "application/json", body: JSON.stringify(entries) });
      if (/^\/local\/[^/]+\/metadata.json$/.test(url.pathname)) {
        const entry = entries.find(item => url.pathname === `/local/${item.id}/metadata.json`);
        return route.fulfill({ contentType: "application/json", status: entry ? 200 : 404, body: JSON.stringify(entry || {}) });
      }
      if (/^\/local\/[^/]+\/thumbnail/.test(url.pathname)) return route.fulfill({ contentType: "image/svg+xml", body: image });
      if (url.pathname === "/js/player/shell.js") return route.fulfill({ contentType: "text/javascript", body: "export async function mountPlayer() {}" });
      return route.continue();
    });
    const page = await context.newPage();
    page.on("request", request => requests.push({ url: request.url(), method: request.method() }));
    page.on("pageerror", error => errors.push(error.message));
    const ready = () => page.waitForFunction(() => document.querySelector("#videos")?.getAttribute("aria-busy") === "false");
    const titles = () => page.locator("#videos-grid .video-card-title").allTextContents();
    await page.goto(`${preview.origin}/index.html`);
    await ready();
    assert.equal(await page.locator("#hero").isVisible(), true);
    await page.locator("#search-input").fill("Counter Strike");
    assert.deepEqual(await titles(), ["Last round clutch", "A silent round"]);
    assert.equal(await page.locator("#hero").isVisible(), false);
    await page.locator("#search-input").fill("CS2");
    assert.equal(await page.locator("#videos-grid .video-card").count(), 2);
    await page.locator("#search-input").fill("cs2 clutch");
    assert.deepEqual(await titles(), ["Last round clutch"]);
    await page.locator("#search-input").fill("-tag:CS2");
    assert.deepEqual(await titles(), ["Latest unrelated clip", "Nuts of steel"]);
    await page.locator("#search-input").fill('"nuts of steel"');
    assert.deepEqual(await titles(), ["Nuts of steel"]);
    await page.locator("#search-input").fill("no-match");
    assert.equal(await page.locator("#hero").isVisible(), false);
    assert.equal(await page.locator("#videos-status").isVisible(), true);
    await page.locator("#search-clear").click();
    assert.equal(await page.locator("#hero").isVisible(), true);
    assert.equal(await page.locator("#videos-grid .video-card").count(), 4);

    await page.locator("#search-tools summary").click();
    await page.locator("#tag-search").fill("cs2");
    assert.equal(await page.locator(".tag-suggestion-name").textContent(), cs2.name);
    await page.locator("#search-input").fill("tag:cs2");
    await page.getByRole("button", { name: "Exclude Counter-Strike 2", exact: true }).click();
    assert.equal(await page.locator("#search-input").inputValue(), '-tag:"Counter-Strike 2"');
    assert.deepEqual(await titles(), ["Latest unrelated clip", "Nuts of steel"]);
    await page.getByRole("button", { name: "Remove excluded tag filter Counter-Strike 2", exact: true }).click();
    assert.equal(await page.locator("#search-input").inputValue(), "");
    await page.getByRole("button", { name: "Include Counter-Strike 2", exact: true }).click();
    assert.equal(await page.locator("#videos-grid .video-card").count(), 2);
    await page.screenshot({ path: `${artifacts}/${profile.name}-tags.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const small = await page.locator("#search-tools button, .search-filter, #tag-search, #search-tools summary").evaluateAll(elements => elements.filter(element => {
      if (!element.getClientRects().length) return false;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width < 44 || box.height < 44 || style.outlineStyle !== "none" || style.webkitTapHighlightColor !== "rgba(0, 0, 0, 0)";
    }).map(element => element.outerHTML));
    assert.deepEqual(small, [], "Search controls need44px targets and transparent tap feedback without rings");
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Open tag controls must fit enlarged text");
    await page.screenshot({ path: `${artifacts}/${profile.name}-tags-enlarged.png`, fullPage: true });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });

    await page.locator("#search-input").fill("nuts");
    const card = page.locator("#videos-grid .video-card").first();
    assert.equal(new URL(await card.getAttribute("href"), page.url()).searchParams.get("q"), "nuts");
    await card.click();
    await page.waitForFunction(() => document.querySelector("#watch-stage")?.getAttribute("aria-busy") === "false");
    assert.equal(new URL(await page.locator(".back-link").getAttribute("href"), page.url()).searchParams.get("q"), "nuts");
    await page.locator(".back-link").click();
    await ready();
    assert.equal(await page.locator("#search-input").inputValue(), "nuts");
    assert.deepEqual(await titles(), ["Nuts of steel"]);
    assert.equal(await page.locator("#hero").isVisible(), false);
    await page.screenshot({ path: `${artifacts}/${profile.name}-return.png`, fullPage: true });
    await page.reload();
    await ready();
    assert.equal(await page.locator("#search-input").inputValue(), "nuts");
    // Ordinary browser Back/Forward keeps each page's query, too.
    await page.locator("#videos-grid .video-card").click();
    await page.waitForURL(/watch\.html/);
    await page.goBack();
    await ready();
    assert.equal(await page.locator("#search-input").inputValue(), "nuts");
    await page.goto(`${preview.origin}/watch.html?v=nuts&local=1`);
    await page.waitForFunction(() => document.querySelector("#watch-stage")?.getAttribute("aria-busy") === "false");
    assert.equal(new URL(await page.locator(".back-link").getAttribute("href"), page.url()).search, "");
    assert.equal(await page.locator("#watch-tags a").textContent(), lethal.name);
    assert.equal(new URL(await page.locator("#watch-tags a").getAttribute("href"), page.url()).searchParams.get("q"), 'tag:"Lethal Company"');
    assert.deepEqual(errors, []);
    assert.equal(requests.some(request => request.method !== "GET" || /\/analytics|\/api\/search/.test(request.url)), false, "Searching makes no tracking or search API requests");
    results.push({ profile: profile.name, passed: true });
    await context.close();
    console.log(`PASS ${profile.name}: game aliases, query syntax, tag controls, search return, no search telemetry`);
  }
  await writeFile(`${artifacts}/results.json`, JSON.stringify(results, null, 2));
  console.log(`Search review artifacts: ${artifacts}`);
} finally { await browser.close(); await preview.close(); }
