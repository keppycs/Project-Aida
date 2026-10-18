import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { startAdminPreview } from "./support/admin-preview.mjs";

const require = createRequire(import.meta.url);
const modules = "C:/Users/keppy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const { chromium } = require(process.env.AIDA_PLAYWRIGHT_MODULE || `${modules}/playwright`);
const executablePath = process.env.AIDA_BROWSER_EXECUTABLE || "C:/Users/keppy/AppData/Local/Temp/codex-work/aida-player-review-1792104966336/browser/chromium-1234/chrome-win64/chrome.exe";
const artifacts = resolve(process.env.AIDA_REVIEW_DIR || "logs", `central-settings-${Date.now()}`);
await mkdir(artifacts, { recursive: true });
process.env.TEMP = process.env.TMP = artifacts;
const fixture = await startAdminPreview();
const browser = await chromium.launch({ executablePath, headless: true });
const results = [];

try {
  for (const profile of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844, touch: true }]) {
    for (const mode of ["central", "invalid", "legacy"]) {
      let releaseCredentials;
      const held = new Promise(done => { releaseCredentials = done; });
      const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, isMobile: Boolean(profile.touch), hasTouch: Boolean(profile.touch) });
      await context.addInitScript(() => {
        localStorage.setItem("aida-admin-tab", "maint");
        window.rawCredentialsPainted = false;
        new MutationObserver(() => {
          if (document.querySelector("#legacy-credentials")?.getClientRects().length) window.rawCredentialsPainted = true;
        }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
      });
      const requests = [];
      await context.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== fixture.origin) return route.abort();
        requests.push({ path: url.pathname, method: request.method(), body: request.postData() });
        if (url.pathname === "/api/videos") return route.fulfill({ json: { videos: [] } });
        if (url.pathname === "/api/credentials") {
          if (request.method() === "POST") return route.fulfill({ json: { message: "Synthetic legacy credentials saved." } });
          await held;
          return route.fulfill(mode === "invalid" ? { status: 503, json: { detail: "The secure uploader configuration needs attention." } } : { json: mode === "central" ? { cloud_mode: "central", configured: true } : { cloud_mode: "legacy", configured: true, key_id: "synthetic-legacy-id", app_key: "", bucket: "synthetic-bucket", endpoint: "synthetic.invalid" } });
        }
        return route.continue();
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.goto(fixture.origin);
        await page.locator("#tab-creds").click();
        await page.locator("#cloud-connection-status").filter({ hasText: "Checking connection" }).waitFor();
        assert.equal(await page.locator("#legacy-credentials").isVisible(), false, "Raw credentials stay hidden while mode is unknown");
        assert.equal(await page.locator("#tab-maint").isVisible(), false);
        assert.equal(await page.evaluate(() => rawCredentialsPainted), false);
        // Preserve the stored Maintenance preference after this explicit pending
        // Settings visit so the response must resolve it safely in each mode.
        await page.evaluate(() => localStorage.setItem("aida-admin-tab", "maint"));
        releaseCredentials();
        if (mode === "legacy") {
          await page.waitForFunction(() => document.querySelector("#tab-maint").getAttribute("aria-selected") === "true");
          assert.equal(await page.locator("#tab-maint").isVisible(), true);
          await page.locator("#tab-creds").click();
          assert.equal(await page.locator("#legacy-credentials").isVisible(), true);
          assert.equal(await page.locator("#cr-key").inputValue(), "synthetic-legacy-id");
          await page.locator("#save-creds").click();
          await page.locator("#creds-status").filter({ hasText: "Synthetic legacy credentials saved" }).waitFor();
          assert.ok(requests.some(request => request.path === "/api/credentials" && request.method === "POST"));
        } else {
          await page.locator("#tab-creds").click();
          await page.locator("#cloud-connection-status").filter({ hasText: mode === "central" ? "Connected through secure uploader" : "configuration needs attention" }).waitFor();
          assert.equal(await page.locator("#legacy-credentials").isVisible(), false);
          assert.equal(await page.locator("#tab-maint").isVisible(), false);
          assert.equal(await page.evaluate(() => rawCredentialsPainted), false, "Central/error mode never paints the broad credentials form");
          await page.locator("#save-creds").evaluate(button => button.click());
          await page.locator("#scan-bucket").evaluate(button => button.click());
          await page.locator("#apply-dedupe").evaluate(button => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
          await page.waitForFunction(() => document.querySelector("#cloud-connection-status").textContent !== "Checking connection…");
          assert.equal(requests.some(request => request.method === "POST"), false);
          assert.equal(requests.some(request => request.path.startsWith("/api/dedupe/") || request.path === "/api/sync/last"), false);
          await page.locator("#tab-encode").focus();
          await page.keyboard.press("ArrowRight");
          assert.equal(await page.evaluate(() => document.activeElement.id), "tab-creds", "Keyboard navigation skips hidden Maintenance");
          await page.screenshot({ path: resolve(artifacts, `${profile.name}-${mode}.png`), fullPage: true });
        }
        assert.deepEqual(errors, []);
        results.push({ profile: profile.name, mode, passed: true });
        console.log(`PASS ${profile.name} ${mode}`);
      } finally { releaseCredentials(); await context.close(); }
    }
  }
} finally {
  await writeFile(resolve(artifacts, "results.json"), JSON.stringify(results, null, 2), { flag: "wx" });
  await browser.close();
  await fixture.close();
}
console.log(`Central settings artifacts: ${artifacts}`);
