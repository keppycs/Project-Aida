/** Publish only reviewed website assets; private local/reference trees are never opened. */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// New public files require an explicit review here before Pages can publish them.
export const PUBLIC_FILES = Object.freeze([
  "CNAME", "index.html", "watch.html",
  "assets/favicons/bug.png", "assets/favicons/flushed.svg",
  "assets/fonts/JetBrainsMono[wght].ttf",
  "css/index.css", "css/player-mobile.css", "css/player.css", "css/site.css", "css/watch.css",
  "js/catalog.js", "js/index.js", "js/loader.js", "js/site-env.js", "js/watch.js",
  "js/browse-context.js", "js/search.js", "js/tags.js", "js/ui.js",
  "js/player/capabilities.js", "js/player/chrome.js", "js/player/desktop-input.js",
  "js/player/engine.js", "js/player/frame-step.js", "js/player/icon-morph.js",
  "js/player/index.js", "js/player/input.js", "js/player/mobile-input.js",
  "js/player/scrollbar.js", "js/player/settings.js", "js/player/shell.js",
  "js/player/smooth-pause.js", "js/player/warn-shim.js",
]);
const files = new Set(PUBLIC_FILES);
const directories = new Set(PUBLIC_FILES.flatMap(name => {
  const parts = name.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}));
const privateRoots = new Set(["local", "youtube reference"]);

function inside(parent, child) {
  const name = relative(parent, child);
  return name === "" || (!isAbsolute(name) && name !== ".." && !name.startsWith(`..${sep}`));
}

function projectPath(name) {
  const path = resolve(ROOT, name);
  if (path === ROOT || !inside(ROOT, path)) throw new Error("Staging paths must stay inside this project.");
  return path;
}

function rejectLink(info) {
  if (info.isSymbolicLink() || (info.fileAttributes & 0x400)) throw new Error("Linked or redirected website paths are unavailable.");
}

async function directoryChain(path, allowMissing = false) {
  let current = ROOT;
  for (const part of ["", ...relative(ROOT, path).split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (allowMissing && error.code === "ENOENT") return; throw error; }
    rejectLink(info);
    if (!info.isDirectory()) throw new Error("Website directory path is not a regular directory.");
  }
}

async function inspectSource(source) {
  const found = [];
  async function visit(folder, prefix = "") {
    for (const entry of (await readdir(folder)).sort()) {
      // Skip these complete trees without opening or following their contents.
      if (!prefix && privateRoots.has(entry)) continue;
      const name = prefix ? `${prefix}/${entry}` : entry;
      const path = join(folder, entry), info = await lstat(path);
      rejectLink(info);
      if (directories.has(name) && info.isDirectory()) await visit(path, name);
      else if (files.has(name) && info.isFile()) found.push(name);
      else throw new Error(`Unreviewed or invalid public website path: ${name}`);
    }
  }
  await visit(source);
  if (found.length !== PUBLIC_FILES.length) throw new Error("A required reviewed public website asset is missing.");
  return found.sort();
}

export async function stagePublicSite({ source = join(ROOT, "web"), destination } = {}) {
  if (typeof destination !== "string" || !destination) throw new Error("A new project-local staging destination is required.");
  source = projectPath(source);
  destination = projectPath(destination);
  if (inside(source, destination) || inside(destination, source)) throw new Error("Source and staging destination must be disjoint.");
  await directoryChain(source);
  await directoryChain(dirname(destination), true);
  // Even an existing empty destination is never replaced.
  try { await lstat(destination); throw new Error("The staging destination already exists; choose a new path."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const approved = await inspectSource(source);
  await mkdir(dirname(destination), { recursive: true });
  await directoryChain(dirname(destination));
  await mkdir(destination);
  for (const name of approved) {
    const input = join(source, name), output = join(destination, name);
    // Recheck every source ancestor before opening and never follow a file link.
    await directoryChain(dirname(input));
    const info = await lstat(input);
    rejectLink(info);
    if (!info.isFile()) throw new Error("A public website asset changed type while staging.");
    const handle = await open(input, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("A public website asset changed while staging.");
      await mkdir(dirname(output), { recursive: true });
      await directoryChain(dirname(output));
      await writeFile(output, await handle.readFile(), { flag: "wx" });
    } finally { await handle.close(); }
  }
  return approved;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith("-")) {
    console.error("Usage: node scripts/stage-public-site.mjs NEW_PROJECT_LOCAL_DESTINATION");
    process.exitCode = 1;
  } else {
    stagePublicSite({ destination: args[0] }).then(approved => console.log(`Staged ${approved.length} reviewed public website assets.`))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
