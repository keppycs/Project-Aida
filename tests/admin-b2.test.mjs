import test from 'node:test';
import assert from 'node:assert/strict';
import { createB2Store, digest, AdminProblem, boundedJSON } from '../edge/admin-b2.mjs';
import { AdminLibraryService } from '../edge/admin-library.mjs';

const bucketId = '123456789012345678abcdef';
const env = { B2_KEY_ID: 'fake-test-key', B2_SECRET_KEY: 'fake-test-secret', B2_BUCKET_ID: bucketId };
const auth = () => ({ apiUrl: 'https://api001.backblazeb2.com', downloadUrl: 'https://f001.backblazeb2.com', authorizationToken: 'fake-session-token', allowed: { bucketId, bucketName: 'ProjectAida', namePrefix: null, capabilities: ['listFiles','readFiles','writeFiles'] } });
function harness(handler, options = {}) {
  const calls = [];
  const fetcher = async (raw, init) => {
    const url = new URL(raw); calls.push({ url, init });
    if (url.pathname.endsWith('/b2_authorize_account')) return Response.json(options.auth?.() || auth());
    return handler(url, init);
  };
  return { calls, store: createB2Store(env, { fetcher, timeoutMs: 50 }) };
}

test('B2 writes fixed bucket versions with verified SHA1 and never deletes', async () => {
  const bytes = new TextEncoder().encode('{"title":"120 fps"}');
  const h = harness(async (url, init) => {
    if (url.pathname.endsWith('/b2_get_upload_url')) { assert.deepEqual(JSON.parse(init.body), { bucketId }); return Response.json({ bucketId, uploadUrl: `https://pod-000-1005-03.backblaze.com/b2api/v2/b2_upload_file/${bucketId}/c001_v0001005_t0027`, authorizationToken: 'upload-token' }); }
    if (url.pathname.includes('/b2_upload_file/')) {
      assert.equal(init.headers['X-Bz-File-Name'], 'video120%2Fmetadata.json');
      assert.equal(init.headers['X-Bz-Content-Sha1'], await digest(bytes, 'SHA-1'));
      assert.equal(init.headers['X-Bz-Info-b2-cache-control'], 'no-store');
      return Response.json({ fileName: 'video120/metadata.json', fileId: 'immutable-version-1', contentSha1: await digest(bytes, 'SHA-1') });
    }
    if (url.pathname.endsWith('/b2_copy_file')) { const body = JSON.parse(init.body); assert.equal(body.destinationBucketId, bucketId); assert.equal(body.sourceFileId, 'immutable-version-1'); return Response.json({ fileName: body.fileName, fileId: 'immutable-version-2' }); }
    assert.fail(`Unexpected endpoint ${url}`);
  });
  const saved = await h.store.write('video120/metadata.json', bytes, 'application/json');
  assert.equal(saved.fileId, 'immutable-version-1'); await h.store.copy(saved.fileId, 'video120/thumbnail_sdr.webp', 'image/webp');
  assert.ok(h.calls.every(({init,url}) => init.method !== 'DELETE' && !url.pathname.includes('delete')));
});

test('scope and endpoint validation prevents sending keys to an unexpected host', async () => {
  const invalid = harness(() => assert.fail('Invalid paths must not reach cloud storage'));
  for (const path of ['video120/../secret', 'video120/.env', '.aida-editor/secret', 'video120/AV1/../../secret']) await assert.rejects(() => invalid.store.readAsset(path), error => error.status === 400);
  assert.equal(invalid.calls.length, 0);
  for (const modify of [value => { value.downloadUrl = 'https://evil.example'; }, value => { value.apiUrl = 'https://api001.backblazeb2.com/unsafe'; }, value => { value.allowed.bucketId = 'other'; }, value => { value.allowed.namePrefix = 'video120/'; }, value => { value.allowed.capabilities = ['readFiles']; }]) {
    const h = harness(() => { assert.fail('Unsafe host was contacted'); }, { auth: () => { const value = auth(); modify(value); return value; } });
    await assert.rejects(() => h.store.readJson('index.json'), error => error.status === 503);
    assert.equal(h.calls.length, 1);
  }
  const badUpload = harness(() => Response.json({ uploadUrl: 'https://evil.example/b2api/v2/b2_upload_file/x', authorizationToken: 'secret' }));
  await assert.rejects(() => badUpload.store.write('video120/metadata.json', new Uint8Array([1]), 'application/json'), error => error.status === 502);
  assert.equal(badUpload.calls.length, 2);
});

test('private media keeps Range, HEAD and bytes intact, rejects redirects/encoding and refreshes expired auth once', async () => {
  let expired = true;
  const h = harness((url, init) => {
    if (expired) { expired = false; return new Response(null, { status: 401 }); }
    assert.equal(url.pathname, '/file/ProjectAida/video120/AV1/chunk_0_1.fmp4');
    assert.equal(init.headers.Range, 'bytes=1-3'); assert.equal(init.headers['Accept-Encoding'], 'identity');
    return new Response(new Uint8Array([120,0,255]), { status: 206, headers: { 'Content-Range': 'bytes 1-3/4' } });
  });
  const result = await h.store.readAsset('video120/AV1/chunk_0_1.fmp4', { range: 'bytes=1-3' });
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new Uint8Array([120,0,255]));
  assert.equal(h.calls.filter(({url}) => url.pathname.endsWith('b2_authorize_account')).length, 2);
  const head = harness((url, init) => { assert.equal(init.method, 'HEAD'); return new Response(null, { headers: { 'Content-Length': '123' } }); });
  assert.equal((await head.store.readAsset('video120/AV1/init_0.mp4', { method: 'HEAD' })).headers.get('Content-Length'), '123');
  for (const response of [() => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }), () => new Response('encoded', { headers: { 'Content-Encoding': 'gzip' } })]) {
    await assert.rejects(() => harness(response).store.readAsset('video120/AV1/manifest.mpd'), error => error.status === 502);
  }
});

test('root listing includes private folders with a validated cursor and no public catalog dependency', async () => {
  const h = harness((url, init) => {
    const body = JSON.parse(init.body); assert.equal(body.delimiter, '/'); assert.equal(body.maxFileCount, 20); assert.equal(body.startFileName, 'next/');
    return Response.json({ files: [{ action: 'folder', fileName: 'private120/' }, { action: 'folder', fileName: '.aida-editor/' }, { action: 'upload', fileName: 'index.json' }], nextFileName: 'video120/' });
  });
  assert.deepEqual(await h.store.listVideoIds('next/'), { ids: ['private120'], next_cursor: 'video120/' });
  await assert.rejects(() => h.store.listVideoIds('../secret'), error => error.status === 400);
});

test('JSON bounds and manifest declarations reject excess bytes and non120 media', async () => {
  await assert.rejects(() => boundedJSON(new Response('{"x":"123456"}'), 5), error => error.status === 413);
  for (const rate of ['60','30','240/2']) {
    const h = harness(() => new Response(`<MPD><Representation frameRate="${rate}"/></MPD>`));
    await assert.rejects(() => h.store.verifyPackage('video120', { codecs: ['AV1'], frameRate: 120 }), error => error.status === 400);
  }
  const good = harness(() => new Response('<MPD><Representation frameRate="120"/><Representation frameRate="120/1"/></MPD>'));
  await good.store.verifyPackage('video120', { codecs: ['AV1','HEVC'], frameRate: 120 });
});

test('stalled JSON body expires through its deadline and releases the mutation queue', async () => {
  let stall = true;
  const h = harness((url, init) => {
    if (stall && url.pathname.endsWith('/metadata.json')) {
      stall = false;
      return new Response(new ReadableStream({ start(controller) { init.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true }); } }));
    }
    if (url.pathname.endsWith('/index.json')) return Response.json([]);
    return Response.json({ id:'video120', title:'Saved', visibility:'private', frameRate:120 });
  });
  const map = new Map(), storage = { get: async key => map.get(key), put: async (key,value) => map.set(key,value), delete: async key => map.delete(key) };
  const service = new AdminLibraryService({ storage, store: h.store });
  const first = service.enqueue(() => h.store.readJson('video120/metadata.json'));
  const second = service.enqueue(() => h.store.readJson('video120/metadata.json'));
  await assert.rejects(first, error => error instanceof AdminProblem && error.status === 503);
  assert.equal((await second).title, 'Saved');
});
