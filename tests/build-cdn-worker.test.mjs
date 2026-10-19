import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { ROOT, buildCdnWorker, bundleSources } from '../scripts/build-cdn-worker.mjs';

async function fixture(t) {
  const base = join(ROOT, 'logs', 'cdn-build-tests'); await mkdir(base, { recursive: true });
  const path = await mkdtemp(join(base, 'fixture-'));
  t.after(async () => {
    assert.ok(resolve(path).startsWith(resolve(base) + sep));
    await rm(path, { recursive: true, force: true }); // Only this test's generated files.
  });
  return path;
}

test('offline CDN build has no unresolved imports and exports the same testable Worker', async t => {
  const folder = await fixture(t), output = join(folder, 'worker.mjs');
  const result = await buildCdnWorker(relative(ROOT, output)); assert.ok(result.bytes > 1000);
  const source = await readFile(output, 'utf8'); assert.equal(/^\s*import\b/m.test(source), false);
  const worker = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  assert.equal(typeof worker.createHandler, 'function'); assert.equal(typeof worker.default.fetch, 'function');
  const calls = [], handle = worker.createHandler({ fetcher: async input => {
    const url = String(input); calls.push(url);
    if (url.includes('b2_authorize_account')) return Response.json({ downloadUrl: 'https://f003.backblazeb2.com', authorizationToken: 'synthetic', allowed: { bucketName: 'ProjectAida', capabilities: ['readFiles'] } });
    if (url.endsWith('/metadata.json')) return Response.json({ id: 'video', title: 'Video', visibility: 'public', tags: ['CS2'] });
    if (url.endsWith('/tags.json')) return Response.json({ version: 1, tags: [{ id: 'game', name: 'Counter-Strike 2', aliases: ['CS2'] }], redirects: {} });
    assert.fail('Unexpected CDN origin request');
  } });
  const response = await handle(new Request('https://cdn.keppy.dev/file/ProjectAida/video/metadata.json'), { B2_KEY_ID: 'synthetic', B2_SECRET_KEY: 'synthetic' });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).tags, ['Counter-Strike 2']); assert.equal(calls.length, 3);
});

test('CDN build refuses overwriting and output outside the project', async t => {
  const folder = await fixture(t), output = join(folder, 'keep.mjs');
  await writeFile(output, 'keep this content');
  await assert.rejects(buildCdnWorker(relative(ROOT, output)), { code: 'EEXIST' }); assert.equal(await readFile(output, 'utf8'), 'keep this content');
  await assert.rejects(buildCdnWorker('../outside.mjs'), /inside this project/);
  await assert.rejects(buildCdnWorker(''), /fresh project-local/);
});

test('unreviewed CDN import changes fail before producing a deployable bundle', async () => {
  const worker = await readFile(join(ROOT, 'edge/cdn-worker.mjs'), 'utf8'), tags = await readFile(join(ROOT, 'web/js/tags.js'), 'utf8');
  assert.throws(() => bundleSources(worker + '\nimport "./unexpected.mjs";', tags), /unresolved imports/);
  assert.throws(() => bundleSources(worker, tags + '\nimport "./unexpected.mjs";'), /import graph/);
});
