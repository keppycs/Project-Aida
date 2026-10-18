import test from 'node:test';
import assert from 'node:assert/strict';
import { createB2Store, digest, AdminProblem, boundedJSON } from '../edge/admin-b2.mjs';
import { AdminLibraryService } from '../edge/admin-library.mjs';
import { packageFixture } from './admin-package-fixtures.mjs';

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

test('JSON bounds and structurally incomplete or non120 manifests fail closed', async () => {
  await assert.rejects(() => boundedJSON(new Response('{"x":"123456"}'), 5), error => error.status === 413);
  for (const rate of ['60','30','119.88']) {
    const f=packageFixture(),h=harness(()=>new Response(f.mpd.replace('frameRate="120/1"',`frameRate="${rate}"`)));
    await assert.rejects(() => h.store.verifyPackage('video120', f.metadata), error => error.status === 400 && /120 fps/.test(error.message));
  }
  const fake = harness(() => new Response('<!-- frameRate="120" --><MPD><Representation frameRate="120"/></MPD>'));
  await assert.rejects(() => fake.store.verifyPackage('video120', { codecs: ['AV1'], frameRate: 120, duration:8 }), error => error.status === 400);
});

function packageHarness({ objects = packageFixture().objects, missing, empty, pageSize=5000, expire=false, inventory=value=>value }={}) {
  const expired=new Set();
  return harness((url,init)=>{
    if(expire&&!expired.has(url.pathname)){expired.add(url.pathname);return new Response(null,{status:401});}
    if(url.pathname.endsWith('/b2_list_file_names')){
      const body=JSON.parse(init.body);assert.equal(body.prefix,'video120/');assert.equal(body.maxFileCount,5000);
      const all=[...objects].filter(([key])=>key!==missing).map(([key,value])=>({fileName:'video120/'+key,action:'upload',fileId:'version-'+key,contentLength:key===empty?0:typeof value==='string'?Buffer.byteLength(value):value.length})).sort((a,b)=>a.fileName.localeCompare(b.fileName));
      const begin=body.startFileName?all.findIndex(file=>file.fileName>=body.startFileName):0;
      return Response.json(inventory({files:all.slice(begin,begin+pageSize),nextFileName:all[begin+pageSize]?.fileName||null}));
    }
    const key=url.pathname.replace('/file/ProjectAida/video120/','');
    assert.ok(key.endsWith('.mpd')||key.endsWith('.m3u8'),'Verifier must not GET media bodies');
    return objects.has(key)&&key!==missing?new Response(objects.get(key)):new Response(null,{status:404});
  });
}

test('package verification checks every audio/video reference using bounded inventory instead of media downloads',async()=>{
  const objects=new Map([...packageFixture('AV1').objects,...packageFixture('HEVC').objects]);
  const h=packageHarness({objects,pageSize:15});
  const result=await h.store.verifyPackage('video120',{frameRate:120,duration:8,codecs:['AV1','HEVC']});
  assert.equal(result.representations,6);assert.equal(result.referencedFiles,28);assert.equal(result.inventoryPages,2);assert.equal(result.requests,h.calls.length);assert.ok(result.requests<=24);
  assert.ok(h.calls.every(({url})=>!url.pathname.includes('b2_upload')&&!url.pathname.includes('b2_copy')));
});

test('missing middle/final chunks, empty init and absent HLS renditions block finalization',async()=>{
  for(const missing of ['AV1/chunk_0_1.fmp4','AV1/chunk_1_2.fmp4','AV1/chunk_2_2.fmp4','AV1/media_2.m3u8','AV1/master.m3u8']){
    const h=packageHarness({missing});await assert.rejects(()=>h.store.verifyPackage('video120',{frameRate:120,duration:8,codecs:['AV1']}),error=>error.status===409,missing);
  }
  const h=packageHarness({empty:'AV1/init_1.mp4'});await assert.rejects(()=>h.store.verifyPackage('video120',{frameRate:120,duration:8,codecs:['AV1']}),error=>error.status===409);
});

test('production six-tier plus audio packages fit verifier request budget; repeated auth refresh stops before excess fetches',async()=>{
  const objects=new Map([...packageFixture('AV1',6).objects,...packageFixture('HEVC',6).objects]);
  const h=packageHarness({objects});const result=await h.store.verifyPackage('video120',{frameRate:120,duration:8,codecs:['AV1','HEVC']});
  assert.equal(result.representations,14);assert.equal(result.requests,20);
  const retry=packageHarness({objects,expire:true});await assert.rejects(()=>retry.store.verifyPackage('video120',{frameRate:120,duration:8,codecs:['AV1','HEVC']}),error=>error.status===503);assert.equal(retry.calls.length,24);
});

test('inventory cursors/pages and invalid text encoding cannot escape verification bounds',async()=>{
  for(const inventory of [page=>({...page,nextFileName:page.files[0].fileName}),page=>({...page,files:[{...page.files[0],fileName:'another-video/metadata.json'}]})]){
    const h=packageHarness({inventory});await assert.rejects(()=>h.store.verifyPackage('video120',{frameRate:120,duration:8,codecs:['AV1']}),error=>error.status===502);
  }
  const pages=packageHarness({pageSize:3});await assert.rejects(()=>pages.store.verifyPackage('video120',{frameRate:120,duration:8,codecs:['AV1']}),error=>error.status===413);assert.equal(pages.calls.filter(({url})=>url.pathname.endsWith('b2_list_file_names')).length,4);
  const malformed=packageFixture().objects;malformed.set('AV1/manifest.mpd',new Uint8Array([0xc3,0x28]));
  await assert.rejects(()=>packageHarness({objects:malformed}).store.verifyPackage('video120',{frameRate:120,duration:8,codecs:['AV1']}),error=>error.status===400);
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
