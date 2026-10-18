import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminHandler } from '../edge/admin-worker.mjs';
import { AdminAuthError } from '../edge/admin-auth.mjs';

const principal = { kind: 'owner', email: 'owner@example.test', sub: 'verified' };
function setup(options = {}) {
  const forwarded = [], reads = [], assetCalls = [], names = [];
  const env = { LIBRARY: { idFromName(name) { names.push(name); return 'global-id'; }, get(value) { assert.equal(value,'global-id'); return { async fetch(request) {
    forwarded.push(request);
    const url = new URL(request.url);
    if (url.pathname.includes('/internal/draft-thumbnail/')) return Response.json({ key: options.draft || null });
    if (options.missing) return Response.json({ detail: 'Video not found.' }, { status:404 });
    return Response.json({ id:'private120', metadata:{ id:'private120', title:'Private', visibility:'private', frameRate:120 }, revision:'abc' });
  } }; } } };
  const handler = createAdminHandler({ authorize: options.authorize || (async () => options.principal || principal), assets: async request => { assetCalls.push(request); return new Response('<html>editor</html>', { headers:{'Content-Type':'text/html'} }); }, storeFactory: () => ({ async readAsset(key, params) { reads.push({ key, ...params }); return options.origin?.(key,params) || new Response(params.method === 'HEAD' ? null : new Uint8Array([120,255,0,1]), { status:206, headers:{'Content-Length':'4','Content-Range':'bytes 0-3/100','X-Bz-File-Id':'secret-id','Set-Cookie':'secret-cookie'} }); } }) });
  const request = (path, init) => handler(new Request(`https://keppy.dev${path}`, init), env);
  return { request, forwarded, reads, assetCalls, names, env };
}
function security(response) {
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0');
  assert.equal(response.headers.get('Cloudflare-CDN-Cache-Control'),'no-store');
  assert.equal(response.headers.get('X-Frame-Options'),'SAMEORIGIN');
  assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'self'/);
  const csp = response.headers.get('Content-Security-Policy');
  assert.match(csp, /(?:^|; )script-src 'self' https:\/\/cdn\.jsdelivr\.net\/npm\/shaka-player@5\.0\.7\/dist\/shaka-player\.compiled\.js(?:;|$)/);
  assert.match(csp, /(?:^|; )connect-src 'self'(?:;|$)/);
  assert.match(csp, /(?:^|; )script-src-attr 'none'(?:;|$)/);
  assert.match(csp, /(?:^|; )media-src 'self' blob:(?:;|$)/);
  assert.doesNotMatch(csp, /script-src[^;]*(?:unsafe-inline|unsafe-eval|\*)|connect-src[^;]*(?:https:|\*)/);
  assert.equal(response.headers.has('Set-Cookie'),false); assert.equal(response.headers.has('X-Bz-File-Id'),false);
}

test('every owner route authenticates before assets or cloud reads and fails closed', async () => {
  const s = setup({ authorize: async () => { throw new AdminAuthError(401,'Sign in to edit.'); } });
  for (const path of ['/edit','/edit/assets/editor.js','/edit/api/videos','/edit/preview/local/private120/AV1/manifest.mpd']) {
    const response = await s.request(path); assert.equal(response.status,401); assert.equal((await response.json()).detail,'Sign in to edit.'); security(response);
  }
  assert.equal(s.forwarded.length,0); assert.equal(s.reads.length,0); assert.equal(s.assetCalls.length,0);
  const method = setup({ authorize: async () => { throw new AdminAuthError(405,'Method not allowed.'); } });
  assert.equal((await method.request('/edit/api/videos',{method:'DELETE'})).status,405);
});

test('service credentials are restricted to API and internal principal cannot be forged', async () => {
  const machine = setup({ principal:{kind:'service',sub:'machine'} });
  for (const path of ['/edit','/edit/assets/editor.js','/edit/preview/watch.html','/edit/preview/local/private120/metadata.json']) assert.equal((await machine.request(path)).status,403);
  assert.equal((await machine.request('/edit/api/session')).status,200);
  const s = setup();
  const response = await s.request('/edit/api/videos/private120',{method:'POST',headers:{'Content-Type':'application/json','X-Aida-Internal-Principal':'{"kind":"owner","sub":"forged"}',Cookie:'private-cookie',Authorization:'Bearer fake'},body:'{}'});
  assert.equal(response.status,200); security(response);
  const forwarded = s.forwarded[0]; assert.deepEqual(JSON.parse(forwarded.headers.get('X-Aida-Internal-Principal')),principal);
  assert.equal(forwarded.headers.has('Cookie'),false); assert.equal(forwarded.headers.has('Authorization'),false);
  assert.deepEqual(s.names,['ProjectAida']);
  assert.equal((await s.request('/edit/api/internal/draft-thumbnail/private120/thumbnail_sdr.webp')).status,404);
});

test('protected private preview normalizes metadata while source 120fps media bytes and ranges stay intact', async () => {
  const s = setup();
  const metadata = await s.request('/edit/preview/local/private120/metadata.json'); security(metadata);
  assert.equal((await metadata.json()).frameRate,120); assert.equal(s.reads.length,0);
  const media = await s.request('/edit/preview/local/private120/AV1/chunk_0_1.fmp4',{headers:{Range:'bytes=0-3'}}); security(media);
  assert.equal(media.status,206); assert.equal(media.headers.get('Content-Range'),'bytes 0-3/100');
  assert.deepEqual(new Uint8Array(await media.arrayBuffer()),new Uint8Array([120,255,0,1]));
  assert.deepEqual(s.reads[0],{key:'private120/AV1/chunk_0_1.fmp4',method:'GET',range:'bytes=0-3'});
  const head = await s.request('/edit/preview/local/private120/AV1/init_0.mp4',{method:'HEAD'}); assert.equal(await head.text(),''); security(head);
  const index = await s.request('/edit/preview/local/index.json'); assert.deepEqual(await index.json(),[]);
});

test('draft thumbnails read only the DO supplied private object and missing IDs cannot probe B2', async () => {
  const key = '.aida-editor/drafts/private120/operation_1234567890/thumbnail_sdr.webp';
  const s = setup({ draft:key });
  const image = await s.request('/edit/preview/local/private120/thumbnail_sdr.webp?revision=abc'); assert.equal(image.status,206); assert.equal(s.reads[0].key,key);
  assert.equal(image.headers.get('Content-Type'),'image/webp');
  const absent = setup({ missing:true }); assert.equal((await absent.request('/edit/preview/local/private120/AV1/manifest.mpd')).status,404); assert.equal(absent.reads.length,0);
});

test('service media API streams private assets without granting browser previews or forwarding raw API paths', async()=>{
  const s=setup({principal:{kind:'service',sub:'machine'}});
  const response=await s.request('/edit/api/media/private120/AV1/chunk_0_1.fmp4',{headers:{Range:'bytes=0-3'}});
  assert.equal(response.status,206);security(response);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),new Uint8Array([120,255,0,1]));
  assert.deepEqual(s.reads[0],{key:'private120/AV1/chunk_0_1.fmp4',method:'GET',range:'bytes=0-3'});
  assert.equal(new URL(s.forwarded[0].url).pathname,'/edit/api/videos/private120');
  assert.equal(JSON.parse(s.forwarded[0].headers.get('X-Aida-Internal-Principal')).kind,'service');
  const head=await s.request('/edit/api/media/private120/AV1/init_0.mp4',{method:'HEAD'});assert.equal(head.status,206);assert.equal(await head.text(),'');
  const metadata=await s.request('/edit/api/media/private120/metadata.json');assert.equal((await metadata.json()).visibility,'private');
  assert.equal((await s.request('/edit/preview/local/private120/AV1/init_0.mp4')).status,403);
});

test('service media alias keeps strict path/query/range/method and missing-video gates',async()=>{
  const s=setup({principal:{kind:'service',sub:'machine'}});
  for(const path of ['/edit/api/media/private120/.env','/edit/api/media/private120/AV1/source.mp4','/edit/api/media/private120/AV1/init_0.mp4?token=fake','/edit/api/media/private120/AV1/init_0.mp4?revision=a&revision=b','/edit/api/media/private120/AV1/init_0.mp4?revision='+ 'x'.repeat(129),'/edit/api/media/private120/%2e%2e%2f.env'])assert.equal((await s.request(path)).status,404,path);
  assert.equal((await s.request('/edit/api/media/private120/AV1/init_0.mp4',{headers:{Range:'bytes=0-1,4-5'}})).status,416);
  assert.equal((await s.request('/edit/api/media/private120/AV1/init_0.mp4',{method:'POST',body:'{}'})).status,405);
  assert.equal(s.reads.length,0);
  const missing=setup({principal:{kind:'service'},missing:true});assert.equal((await missing.request('/edit/api/media/private120/AV1/init_0.mp4')).status,404);assert.equal(missing.reads.length,0);
  const anonymous=setup({authorize:async()=>{throw new AdminAuthError(401,'Sign in.');}});assert.equal((await anonymous.request('/edit/api/media/private120/AV1/init_0.mp4')).status,401);assert.equal(anonymous.reads.length,0);
});

test('unknown files, paths, queries and multiranges cannot reach the private bucket', async () => {
  const s = setup();
  for (const path of ['/elsewhere','/edit/preview/local/private120/.env','/edit/preview/local/private120/AV1/source.mp4','/edit/preview/local/private120/thumbnail_sdr.webp?token=secret','/edit/preview/local/private120/thumbnail_sdr.webp?revision=a&revision=b','/edit/preview/local/private120/%2e%2e%2f.env']) {
    assert.equal((await s.request(path)).status,404,path);
  }
  assert.equal((await s.request('/edit/preview/local/private120/AV1/manifest.mpd',{headers:{Range:'bytes=0-1,5-8'}})).status,416);
  assert.equal(s.reads.length,0);
});

test('static editor assets remain private and unexpected errors never expose credentials', async () => {
  const s = setup(); const page = await s.request('/edit?v=private120'); security(page); assert.match(await page.text(),/editor/);
  const broken = setup({ origin: () => { throw new Error('B2_SECRET_KEY=fake-secret'); } });
  const response = await broken.request('/edit/preview/local/private120/AV1/manifest.mpd');
  assert.equal(response.status,503); assert.doesNotMatch(await response.text(),/fake-secret|B2_SECRET/); security(response);
});
