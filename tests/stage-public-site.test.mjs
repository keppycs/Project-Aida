import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { PUBLIC_FILES, ROOT, stagePublicSite } from "../scripts/stage-public-site.mjs";

const FIXTURES = join(ROOT, "logs", "stage-public-site-tests");
async function fixture(t) {
  await mkdir(FIXTURES, { recursive: true });
  const root = await mkdtemp(join(FIXTURES, "fixture-"));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(FIXTURES) + sep));
    await rm(root, { recursive: true, force: true }); // Only this test's reproducible fixtures.
  });
  const source = join(root, "web"), destination = join(root, "pages");
  for (const name of PUBLIC_FILES) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await writeFile(join(source, name), `synthetic public content: ${name}\n`);
  }
  return { root, source, destination };
}

async function listed(root, prefix = "") {
  const names = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...await listed(join(root, entry.name), name));
    else names.push(name);
  }
  return names.sort();
}

test("stages exactly the reviewed assets and never opens private trees", async t => {
  const { source, destination } = await fixture(t);
  for (const privateRoot of ["local", "youtube reference"]) {
    await mkdir(join(source, privateRoot));
    await writeFile(join(source, privateRoot, ".env"), "SYNTHETIC_PRIVATE_FIXTURE=not-public\n");
  }
  const approved = await stagePublicSite({ source, destination });
  assert.deepEqual(approved, [...PUBLIC_FILES].sort());
  assert.deepEqual(await listed(destination), approved);
  for (const name of PUBLIC_FILES) assert.deepEqual(await readFile(join(destination, name)), await readFile(join(source, name)));
});

for (const name of [".env", "js/.env.production", "assets/private.pem", "js/watch.js.bak", "css/notes.txt", "surprise/index.html"]) {
  test(`rejects unreviewed public file ${name} before creating output`, async t => {
    const { source, destination } = await fixture(t);
    await mkdir(dirname(join(source, name)), { recursive: true });
    await writeFile(join(source, name), "synthetic rejected fixture\n");
    await assert.rejects(stagePublicSite({ source, destination }), /Unreviewed or invalid/);
    await assert.rejects(lstat(destination), { code: "ENOENT" });
  });
}

test("preserves an existing destination and refuses partial publication", async t => {
  const { source, destination } = await fixture(t);
  await mkdir(destination);
  await writeFile(join(destination, "keep.txt"), "pre-existing fixture\n");
  await assert.rejects(stagePublicSite({ source, destination }), /already exists/);
  assert.deepEqual(await listed(destination), ["keep.txt"]);
  assert.equal(await readFile(join(destination, "keep.txt"), "utf8"), "pre-existing fixture\n");
});

test("rejects overlapping source and destination paths", async t => {
  const { root, source } = await fixture(t);
  for (const destination of [source, root, join(source, "output")]) {
    await assert.rejects(stagePublicSite({ source, destination }), /disjoint/);
  }
});

test("rejects linked source directories and linked destination ancestors", async t => {
  const { root, source } = await fixture(t);
  const linkedSource = join(root, "linked-source"), linkedOutput = join(root, "linked-output");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(source, linkedSource, linkType);
  await assert.rejects(stagePublicSite({ source: linkedSource, destination: join(root, "pages") }), /Linked or redirected/);
  await mkdir(join(root, "output-target"));
  await symlink(join(root, "output-target"), linkedOutput, linkType);
  await assert.rejects(stagePublicSite({ source, destination: join(linkedOutput, "pages") }), /Linked or redirected/);
  assert.deepEqual(await readdir(join(root, "output-target")), []);
});

test("rejects a linked public subtree without opening its target", async t => {
  const { root, source, destination } = await fixture(t);
  const target = join(root, "link-target");
  await mkdir(target);
  await symlink(target, join(source, "js", "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(stagePublicSite({ source, destination }), /Linked or redirected/);
  await assert.rejects(lstat(destination), { code: "ENOENT" });
});

test("rejects missing required public assets and project path escapes", async t => {
  const { source, destination } = await fixture(t);
  await rm(join(source, "index.html")); // Generated test fixture only.
  await assert.rejects(stagePublicSite({ source, destination }), /required reviewed/);
  const escape = resolve(ROOT, "..", "outside-fixture");
  assert.ok(relative(ROOT, escape).startsWith(".."));
  await assert.rejects(stagePublicSite({ source: escape, destination }), /inside this project/);
  await assert.rejects(stagePublicSite({ source, destination: escape }), /inside this project/);
});
