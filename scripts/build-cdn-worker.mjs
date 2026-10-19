/** Offline, fixed-source CDN Worker bundle. Writes only a fresh project file. */
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAG_IMPORT = 'import { hydrateVideoTags, normalizeRegistry } from "../web/js/tags.js";';

export function bundleSources(worker, tags) {
  if (worker.split(TAG_IMPORT).length !== 2 || /^\s*import\b/m.test(tags)) throw new Error('The reviewed CDN import graph changed. Review the bundler before building.');
  const helpers = tags.replace(/^export (?=function )/gm, '');
  if (/^\s*export\b/m.test(helpers)) throw new Error('The shared tag module has unsupported exports.');
  const result = worker.replace(TAG_IMPORT, `const { hydrateVideoTags, normalizeRegistry } = (() => {\n${helpers}\nreturn { hydrateVideoTags, normalizeRegistry };\n})();`);
  if (/^\s*import\b/m.test(result)) throw new Error('The CDN bundle still has unresolved imports.');
  return '// Generated offline by node scripts/build-cdn-worker.mjs; contains reviewed Aida source only.\n' + result;
}

async function projectPath(name, { createParents = false, file = false } = {}) {
  const path = resolve(ROOT, name), local = relative(ROOT, path);
  if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) throw new Error('The CDN output must stay inside this project.');
  const parts = local.split(sep); let cursor = ROOT;
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const last = index === parts.length - 1;
    if (last && !file) break;
    let info;
    try { info = await lstat(cursor); }
    catch (error) {
      if (error.code !== 'ENOENT' || !createParents || last) throw error;
      await mkdir(cursor); info = await lstat(cursor);
    }
    if (info.isSymbolicLink() || (info.fileAttributes & 0x400) || resolve(await realpath(cursor)).toLowerCase() !== resolve(cursor).toLowerCase()) throw new Error('Linked CDN build paths are unavailable.');
    if (!last && !info.isDirectory()) throw new Error('The CDN build parent is not a directory.');
    if (last && file && !info.isFile()) throw new Error('The CDN source is not a regular file.');
  }
  return path;
}

export async function buildCdnWorker(output) {
  if (typeof output !== 'string' || !output || !output.endsWith('.mjs')) throw new Error('Choose a fresh project-local .mjs output file.');
  const destination = await projectPath(output, { createParents: true });
  const sources = [];
  for (const name of ['edge/cdn-worker.mjs', 'web/js/tags.js']) {
    const path = await projectPath(name, { file: true });
    const info = await lstat(path);
    if (info.size > 1_000_000) throw new Error('The CDN build source is unexpectedly large.');
    sources.push(await readFile(path, 'utf8'));
  }
  const source = bundleSources(...sources);
  await writeFile(destination, source, { flag: 'wx' });
  return { output: relative(ROOT, destination), bytes: Buffer.byteLength(source) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/build-cdn-worker.mjs PROJECT_LOCAL_OUTPUT.mjs');
    console.log(JSON.stringify(await buildCdnWorker(process.argv[2])));
  } catch (error) { console.error(error.code === 'EEXIST' ? 'The CDN output already exists. Choose a fresh output path.' : error.message); process.exitCode = 1; }
}
