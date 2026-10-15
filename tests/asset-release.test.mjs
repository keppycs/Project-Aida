import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const docs = new URL("../docs/", import.meta.url);
const release = "player-20261016-7b6ee24";

function localReference(reference, parent) {
  if (/^(?:[a-z]+:|\/\/)/i.test(reference)) return null;
  const resolved = new URL(reference, parent);
  assert.ok(resolved.href.startsWith(docs.href), `${reference} stays inside docs`);
  assert.equal(resolved.searchParams.get("v"), release, `${reference} uses the current release`);
  assert.deepEqual([...resolved.searchParams.keys()], ["v"], `${reference} has one release parameter`);
  assert.equal(resolved.hash, "", `${reference} has no fragment`);
  return resolved;
}

test("both pages and their complete script dependency graphs use the same release", async () => {
  const visited = new Set();
  const styles = new Set();

  async function visitScript(script) {
    if (visited.has(script.pathname)) return;
    visited.add(script.pathname);
    const source = await readFile(script, "utf8");
    const imports = source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g);
    for (const [, reference] of imports) {
      if (!reference.startsWith(".")) continue;
      const dependency = localReference(reference, script);
      assert.ok(dependency.pathname.endsWith(".js"), `${reference} resolves to JavaScript`);
      await visitScript(dependency);
    }
  }

  for (const page of ["index.html", "watch.html"]) {
    const pageUrl = new URL(page, docs);
    const html = await readFile(pageUrl, "utf8");
    for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
      const script = /^<script\b/i.test(tag);
      if (!script && !/\brel=["']stylesheet["']/i.test(tag)) continue;
      const reference = tag.match(script ? /\bsrc=["']([^"']+)["']/i : /\bhref=["']([^"']+)["']/i)?.[1];
      if (!reference) continue;
      const asset = localReference(reference, pageUrl);
      if (!asset) continue;
      if (script) await visitScript(asset);
      else {
        await readFile(asset);
        styles.add(asset.pathname);
      }
    }
  }

  // Check entry points not currently referenced by these pages as well.
  for (const directory of ["js/", "js/player/"]) {
    const directoryUrl = new URL(directory, docs);
    for (const entry of await readdir(directoryUrl, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".js")) {
        await visitScript(new URL(`${entry.name}?v=${release}`, directoryUrl));
      }
    }
  }

  assert.equal(styles.size, 5, "all local site and player stylesheets were checked");
  assert.equal(visited.size, 13, "all local scripts and transitive imports were checked");
});
