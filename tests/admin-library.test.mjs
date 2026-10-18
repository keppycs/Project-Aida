import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminLibraryService, validateVariants } from '../edge/admin-library.mjs';
import { AdminProblem } from '../edge/admin-b2.mjs';

const clone = value => value === undefined ? undefined : structuredClone(value);
class MemoryStorage {
  data = new Map();
  async get(key) { return clone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, clone(value)); }
  async delete(key) { return this.data.delete(key); }
}
class VersionedStore {
  data = new Map(); versions = new Map(); calls = []; fail = null; before = null;
  constructor(metadata) {
    if (metadata) this.data.set('video120/metadata.json', clone(metadata));
    this.data.set('index.json', metadata?.visibility === 'public' ? [{ ...metadata }, { id: 'other', title: 'Other', visibility: 'public', frameRate: 120 }] : []);
  }
  async readJson(key) { return clone(this.data.get(key) ?? null); }
  async write(key, bytes, type) {
    this.calls.push(['write', key]);
    await this.before?.(key);
    if (this.fail === key) { this.fail = null; throw new Error('simulated lost storage response'); }
    const fileId = `version-${this.versions.size + 1}`;
    const value = type === 'application/json' ? JSON.parse(new TextDecoder().decode(bytes)) : new Uint8Array(bytes);
    this.versions.set(fileId, { key, value }); this.data.set(key, clone(value)); return { fileId };
  }
  async copy(fileId, key) {
    this.calls.push(['copy', key]);
    if (this.fail === key) { this.fail = null; throw new Error('simulated copy outage'); }
    assert.ok(this.versions.has(fileId));
    const value = clone(this.versions.get(fileId).value);
    const next = `version-${this.versions.size + 1}`;
    this.versions.set(next, { key, value }); this.data.set(key, value); return { fileId: next };
  }
  async listVideoIds(cursor) { this.cursor = cursor; return { ids: [...this.data.keys()].filter(key => key.endsWith('/metadata.json')).map(key => key.split('/')[0]), next_cursor: null }; }
  async hasPrefix(id) { return [...this.data.keys()].some(key => key.startsWith(`${id}/`)); }
  async verifyPackage(id, metadata) { this.calls.push(['verify', id]); assert.equal(metadata.frameRate, 120); }
}
const meta = (extra = {}) => ({ id: 'video120', title: 'Original', description: 'Before', tags: ['120'], visibility: 'public', frameRate: 120, duration: 10, width: 1920, height: 1080, codecs: ['AV1'], colorTransfer: 'smpte2084', ...extra });
const owner = { kind: 'owner', email: 'owner@example.test' }, machine = { kind: 'service' };
let count = 0;
const operation = () => `operation_${String(++count).padStart(16, '0')}`;
function fixture(metadata = meta()) {
  const storage = new MemoryStorage(), store = new VersionedStore(metadata);
  const create = () => new AdminLibraryService({ storage, store, now: () => 1_700_000_000_000 });
  const service = create();
  async function request(path, body, principal = owner, target = service) {
    return target.handle(new Request(`https://keppy.dev/edit/api/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), principal);
  }
  const read = async () => (await request('videos/video120')).json();
  const edit = async (values = {}, target = service) => request('videos/video120', { revision: (await read()).revision, operation_id: operation(), ...values }, owner, target);
  return { storage, store, create, service, request, read, edit };
}
const webp = 'UklGRjQAAABXRUJQVlA4ICgAAABwAQCdASoCAAIAAUAmJaACdAFAAAD++s8//3wJ//vfD/+++H90j2AA';
// Minimal structurally valid SOF frame: only dimensions are inspected server-side.
const jpeg = Buffer.from([255,216,255,192,0,11,8,0,2,0,2,1,1,17,0,255,217]).toString('base64');
const variants = () => ({ 'thumbnail_sdr.webp': { type: 'image/webp', data: webp }, 'thumbnail_sdr_720p.webp': { type: 'image/webp', data: webp }, 'thumbnail_share.jpg': { type: 'image/jpeg', data: jpeg } });

test('private owner reads preserve technical fields and normalize unsafe visibility', async () => {
  const f = fixture(meta({ id: 'historical-id', visibility: 'garbage' }));
  const detail = await f.read();
  assert.equal(detail.id, 'video120'); assert.equal(detail.visibility, 'private'); assert.equal(detail.frameRate, 120);
  assert.equal(detail.metadata.colorTransfer, 'smpte2084'); assert.equal(detail.has_remote, true); assert.equal(detail.can_preview, true);
  assert.equal((await f.request('videos/video120', undefined, null)).status, 403);
  assert.equal((await f.request('videos/video120?remote=banana')).status, 400);
  assert.equal((await f.request('videos/video120?remote=true&check_online=true')).status, 200);
  const list = await (await f.request('videos?cursor=video120/')).json();
  assert.equal(list.videos[0].visibility, 'private'); assert.equal(f.store.cursor, 'video120/');
});

test('text drafts write no B2 objects, preserve technical metadata, and detect outside changes', async () => {
  const f = fixture();
  const saved = await (await f.edit({ title: 'Draft', publish: false })).json();
  assert.equal(saved.pending, true); assert.equal(saved.metadata.title, 'Draft'); assert.equal(saved.published_metadata.title, 'Original');
  assert.equal(f.store.calls.length, 0);
  f.store.data.set('video120/metadata.json', meta({ colorTransfer: 'bt709' }));
  const current = await f.read();
  assert.equal(current.metadata.colorTransfer, 'bt709'); assert.equal(current.remoteChanged, true);
  const conflict = await f.edit({ publish: true });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).current.pending, true);
  assert.equal(f.store.calls.length, 0);
});

test('publishes serialize stale revisions, merge other videos and replay identical operations', async () => {
  const f = fixture(), revision = (await f.read()).revision;
  const first = { revision, title: 'Published', publish: true, operation_id: operation() };
  const second = { revision, title: 'Stale', publish: true, operation_id: operation() };
  const results = await Promise.all([f.request('videos/video120', first), f.request('videos/video120', second)]);
  assert.deepEqual(results.map(result => result.status), [200,409]);
  assert.equal(f.store.data.get('video120/metadata.json').frameRate, 120);
  assert.equal(f.store.data.get('index.json').find(item => item.id === 'other').title, 'Other');
  const writes = f.store.calls.length;
  const replay = await f.request('videos/video120', first);
  assert.equal(replay.status, 200); assert.equal(f.store.calls.length, writes);
  assert.equal((await f.request('videos/video120', { ...first, title: 'Different' })).status, 409);
});

test('image draft stages privately, publishes all variants and makes metadata private first', async () => {
  const f = fixture();
  const draft = await (await f.edit({ variants: variants(), publish: false })).json();
  assert.equal(draft.thumbnailMode, 'sdr'); assert.equal(draft.pendingThumbnails.length, 3);
  assert.ok(f.store.calls.every(([,key]) => key.startsWith('.aida-editor/drafts/')));
  assert.equal(f.store.data.has('video120/thumbnail_sdr.webp'), false);
  const pointer = await f.service.readDraftThumbnail('video120', 'thumbnail_sdr.webp');
  assert.ok(pointer.startsWith('.aida-editor/drafts/video120/'));
  const start = f.store.calls.length;
  assert.equal((await f.edit({ visibility: 'private', publish: true })).status, 200);
  assert.deepEqual(f.store.calls[start], ['write', 'video120/metadata.json']);
  assert.equal(f.store.calls.slice(start).filter(([kind]) => kind === 'copy').length, 3);
  assert.equal(f.store.data.get('index.json').some(entry => entry.id === 'video120'), false);
  assert.equal((await f.read()).pending, false);
});

test('variant tuple rejects spoofed MIME, incomplete names, animation and oversize dimensions before cloud writes', async () => {
  assert.equal(validateVariants(variants()).length, 3);
  const bad = variants(); bad['thumbnail_share.jpg'].data = webp;
  assert.throws(() => validateVariants(bad), AdminProblem);
  const incomplete = variants(); delete incomplete['thumbnail_share.jpg']; assert.throws(() => validateVariants(incomplete));
  const wide = Buffer.from(webp, 'base64'); wide.writeUInt16LE(5000, 26);
  const wrong = variants(); wrong['thumbnail_sdr.webp'].data = wide.toString('base64'); assert.throws(() => validateVariants(wrong));
  const f = fixture(); assert.equal((await f.edit({ variants: bad, publish: true })).status, 400); assert.equal(f.store.calls.length, 0);
});

test('durable journal resumes a partial publication after a DO restart and preserves versions', async () => {
  const f = fixture(), body = { revision: (await f.read()).revision, title: 'After', variants: variants(), publish: true, operation_id: operation() };
  f.store.fail = 'index.json';
  assert.equal((await f.request('videos/video120', body)).status, 503);
  assert.ok(await f.storage.get('journal')); assert.equal((await f.read()).pending, true);
  const before = f.store.versions.size;
  const resumed = await f.request('videos/video120', body, owner, f.create());
  assert.equal(resumed.status, 200); assert.equal((await resumed.json()).pending, false);
  assert.equal(f.store.data.get('index.json')[0].title, 'After'); assert.ok(f.store.versions.size > before);
  assert.equal(f.store.calls.filter(([kind,key]) => kind === 'copy' && key === 'video120/thumbnail_sdr.webp').length, 1);
  assert.equal(await f.storage.get('journal'), undefined);
});

test('completed operations survive a crash before journal cleanup without replaying old publication', async () => {
  const f = fixture(), body = { revision:(await f.read()).revision, title:'Completed', publish:true, operation_id:operation() };
  const normalDelete = f.storage.delete.bind(f.storage);
  let crash = true;
  f.storage.delete = async key => { if (key === 'journal' && crash) { crash = false; throw new Error('crash after completed result'); } return normalDelete(key); };
  assert.equal((await f.request('videos/video120', body)).status,503);
  assert.equal((await f.storage.get(`operation:${body.operation_id}`)).status,200);
  f.store.data.set('video120/metadata.json',meta({title:'Outside after success'}));
  const calls = f.store.calls.length;
  const next = await f.request('videos/video120',{revision:(await f.read()).revision,title:'Next draft',publish:false,operation_id:operation()},owner,f.create());
  assert.equal(next.status,200); assert.equal(f.store.calls.length,calls);
  assert.equal((await f.request('videos/video120',body,owner,f.create())).status,200);
  assert.equal(f.store.data.get('video120/metadata.json').title,'Outside after success');
});

test('a publication conflict retains newly staged thumbnail references in the draft', async () => {
  const f = fixture();
  let changed = false;
  f.store.before = key => {
    if (!changed && key.startsWith('.aida-editor/')) { changed = true; f.store.data.set('video120/metadata.json',meta({title:'Outside while staging'})); }
  };
  const body = { revision:(await f.read()).revision,title:'Our draft',variants:variants(),publish:true,operation_id:operation() };
  assert.equal((await f.request('videos/video120',body)).status,409);
  const kept = await f.read(); assert.equal(kept.remoteChanged,true); assert.equal(kept.pendingThumbnails.length,3); assert.equal(kept.title,'Our draft');
  const pointer = await f.service.readDraftThumbnail('video120','thumbnail_sdr.webp');
  assert.ok(pointer.startsWith('.aida-editor/drafts/video120/')); assert.ok(f.store.data.has(pointer));
  assert.equal((await f.request('videos/video120',body,owner,f.create())).status,409);
  assert.equal((await f.read()).pendingThumbnails.length,3); assert.equal(await f.storage.get('journal'),undefined);
});

test('out-of-band target index changes conflict without replacing unrelated catalog entries', async () => {
  const f = fixture();
  f.store.before = key => { if (key === 'video120/metadata.json') f.store.data.set('index.json', [{ ...meta(), title: 'Outside change' }, { id: 'new-other', title: 'New' }]); };
  const response = await f.edit({ title: 'Our edit', publish: true });
  assert.equal(response.status, 409); assert.equal(f.store.data.get('index.json')[0].title, 'Outside change');
  assert.equal((await response.json()).current.pending, true);
  const g = fixture();
  g.store.before = key => { if (key === 'video120/metadata.json') g.store.data.set('index.json', [{ ...meta(), title: 'Our edit', unexpected: 'outside change' }]); };
  assert.equal((await g.edit({ title: 'Our edit', publish: true })).status, 409);
  assert.equal(g.store.data.get('index.json')[0].unexpected, 'outside change');
});

test('new uploads require service reservation, completed 120fps media and replay lost responses', async () => {
  const f = fixture(null), reserve = { id: 'new120', operation_id: operation() };
  assert.equal((await f.request('uploads/reserve', reserve)).status, 403);
  const held = await (await f.request('uploads/reserve', reserve, machine)).json();
  assert.ok(held.lease); assert.deepEqual(await (await f.request('uploads/reserve', reserve, machine)).json(), held);
  assert.equal((await f.request('uploads/reserve', { ...reserve, operation_id: operation() }, machine)).status, 409);
  const finish = { lease: held.lease, metadata: meta({ id: 'new120' }), entry: {}, variants: variants(), media_complete: true, operation_id: operation() };
  assert.equal((await f.request('uploads/new120/finalize', { ...finish, metadata: meta({ id: 'new120', frameRate: 60 }) }, machine)).status, 400);
  const result = await f.request('uploads/new120/finalize', finish, machine); assert.equal(result.status, 200);
  const calls = f.store.calls.length;
  assert.equal((await f.request('uploads/new120/finalize', finish, machine, f.create())).status, 200);
  assert.equal(f.store.calls.length, calls); assert.equal(f.store.data.get('new120/metadata.json').frameRate, 120);
  assert.equal(f.store.calls.filter(([kind]) => kind === 'verify').length, 1);
});

test('oversized metadata/catalog and unsupported edits fail before B2 mutations', async () => {
  const f = fixture(meta({ historical: 'x'.repeat(128000) }));
  assert.equal((await f.edit({ title: 'Too big', publish: true })).status, 413); assert.equal(f.store.calls.length, 0);
  const g = fixture(); g.store.data.set('index.json', [{ id: 'huge', title: 'x'.repeat(1000000) }]);
  assert.equal((await g.edit({ variants: variants(), publish: true })).status, 413); assert.equal(g.store.calls.length, 0);
  const h = fixture(); assert.equal((await h.edit({ frameRate: 60, publish: true })).status, 400); assert.equal(h.store.calls.length, 0);
});
