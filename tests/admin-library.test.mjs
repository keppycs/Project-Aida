import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminLibraryService, stableJSON, validateVariants } from '../edge/admin-library.mjs';
import { AdminProblem, digest } from '../edge/admin-b2.mjs';
import { createHandler } from '../edge/cdn-worker.mjs';
import { legacyTagId } from '../web/js/tags.js';

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
function fixture(metadata = meta(), legacy = {}, uploadSigner) {
  const storage = new MemoryStorage(), store = new VersionedStore(metadata);
  const create = () => new AdminLibraryService({ storage, store, uploadSigner, now: () => 1_700_000_000_000, legacy });
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
function legacyMetadata(extra = {}) { const { visibility, ...metadata } = meta(extra); return metadata; }
function anonymousMetadata(store, legacy) {
  const handler = createHandler({ fetcher: async input => {
    const url = new URL(String(input));
    if (url.href === 'https://api.backblazeb2.com/b2api/v2/b2_authorize_account') return Response.json({ downloadUrl: 'https://f003.backblazeb2.com', authorizationToken: 'fake-read-token', allowed: { bucketName: 'ProjectAida', capabilities: ['readFiles'] } });
    if (url.href === 'https://f003.backblazeb2.com/file/ProjectAida/tags.json') return store.data.has('tags.json') ? Response.json(store.data.get('tags.json')) : new Response(null, { status: 404 });
    assert.equal(url.href, 'https://f003.backblazeb2.com/file/ProjectAida/video120/metadata.json');
    return Response.json(store.data.get('video120/metadata.json'));
  } });
  return () => handler(new Request('https://cdn.keppy.dev/file/ProjectAida/video120/metadata.json'), { B2_KEY_ID: 'fake', B2_SECRET_KEY: 'fake', LEGACY_VISIBILITY: JSON.stringify(legacy) });
}

test('tag registry creates aliases, renames stable identities, and replays an operation without another version', async () => {
  const f = fixture(), before = await (await f.request('tags')).json();
  assert.equal(before.version, 1); assert.equal(before.tags[0].id, legacyTagId('120'));
  const body = { revision: before.revision, tag: { name: 'Counter-Strike 2', aliases: ['CS2'] }, operation_id: operation() };
  const created = await (await f.request('tags', body)).json(), tag = created.tags.find(tag => tag.name === 'Counter-Strike 2');
  assert.ok(tag.id.startsWith('tag-')); assert.deepEqual(tag.aliases, ['CS2']);
  assert.deepEqual(await (await f.request('tags', body)).json(), created);
  assert.equal(f.store.calls.filter(([, key]) => key === 'tags.json').length, 1);
  assert.equal((await f.request('tags', { ...body, tag: { name: 'Different', aliases: [] } })).status, 409);
  const published = await (await f.edit({ tagIds: [tag.id], tags: ['CS2'], publish: true })).json();
  assert.deepEqual(published.tags, ['Counter-Strike 2']); assert.deepEqual(published.tagIds, [tag.id]);
  const raw = clone(f.store.data.get('video120/metadata.json')), revision = published.revision;
  const renamed = await (await f.request('tags', { revision: created.revision, tag: { id: tag.id, name: 'CS Two', aliases: ['CS2'] }, operation_id: operation() })).json();
  assert.deepEqual((await f.read()).tags, ['CS Two']); assert.deepEqual(f.store.data.get('video120/metadata.json'), raw);
  assert.equal((await f.read()).revision, revision, 'global tag edits do not stale a video form');
  assert.deepEqual(renamed.tags.find(item => item.id === tag.id).aliases, ['CS2', 'Counter-Strike 2']);
  assert.equal(f.store.data.get('tags.json').version, 1); assert.ok(f.store.versions.size >= 3);
});

test('tag list stale edits and alias collisions preserve the registry; merges redirect previous assignments', async () => {
  const f = fixture(), initial = await (await f.request('tags')).json();
  const first = await (await f.request('tags', { revision: initial.revision, tag: { name: 'Counter-Strike 2', aliases: ['CS2'] }, operation_id: operation() })).json();
  const game = first.tags.find(tag => tag.name === 'Counter-Strike 2'), source = first.tags.find(tag => tag.name === '120');
  assert.equal((await f.request('tags', { revision: initial.revision, tag: { name: 'Other', aliases: [] }, operation_id: operation() })).status, 409);
  assert.equal((await f.request('tags', { revision: first.revision, tag: { name: 'Different', aliases: ['cs2'] }, operation_id: operation() })).status, 400);
  assert.equal((await f.request('tags', { revision: first.revision, tag: { name: 'Different', aliases: 'CS2' }, operation_id: operation() })).status, 400);
  assert.equal(f.store.calls.length, 1);
  const merged = await (await f.request('tags', { revision: first.revision, merge: { source: source.id, target: game.id }, operation_id: operation() })).json();
  assert.equal(merged.redirects[source.id], game.id);
  assert.deepEqual((await f.read()).tagIds, [game.id]); assert.deepEqual((await f.read()).tags, ['Counter-Strike 2']);
  assert.equal(merged.tags.some(tag => tag.id === source.id), false);
});

test('tag journal survives storage failure and resumes the same operation after a durable object restart', async () => {
  const f = fixture(), initial = await (await f.request('tags')).json();
  const body = { revision: initial.revision, tag: { name: 'Funny', aliases: [] }, operation_id: operation() };
  f.store.fail = 'tags.json'; assert.equal((await f.request('tags', body)).status, 503);
  assert.equal(f.store.data.has('tags.json'), false); assert.equal((await f.storage.get('journal')).action, 'tags');
  const response = await f.request('tags', body, owner, f.create()); assert.equal(response.status, 200);
  assert.ok((await response.json()).tags.some(tag => tag.name === 'Funny'));
  assert.equal(await f.storage.get('journal'), undefined);
});

test('missing tag registry supports legacy edits, while invalid or unavailable registries block saving without losing tags', async () => {
  const f = fixture();
  const saved = await (await f.edit({ tags: ['Brand-new tag'], publish: true })).json();
  assert.deepEqual(saved.tags, ['Brand-new tag']); assert.deepEqual(saved.tagIds, [legacyTagId('Brand-new tag')]);
  const revision = saved.revision, previous = clone(f.store.data.get('video120/metadata.json'));
  f.store.data.set('tags.json', { version: 7, tags: [] });
  assert.equal((await f.request('videos/video120', { revision, title: 'Keep the draft', operation_id: operation() })).status, 502);
  assert.deepEqual(f.store.data.get('video120/metadata.json'), previous);
  const read = f.store.readJson.bind(f.store);
  f.store.readJson = key => key === 'tags.json' ? Promise.reject(new Error('offline')) : read(key);
  assert.equal((await f.request('videos/video120', { revision, title: 'Keep the draft', operation_id: operation() })).status, 503);
  assert.deepEqual(f.store.data.get('video120/metadata.json'), previous);
});

test('unknown tag IDs and unauthorized registry operations fail before writes', async () => {
  const f = fixture(), tags = await (await f.request('tags')).json();
  assert.equal((await f.edit({ tagIds: ['unknown'], tags: [] })).status, 400);
  assert.equal((await f.edit({ tagIds: ['bad\n'], tags: [] })).status, 400);
  assert.equal((await f.request('tags', { revision: tags.revision, tag: { name: 'Funny', aliases: [] }, operation_id: operation() }, null)).status, 403);
  assert.equal(f.store.calls.length, 0);
});

test('metadata string-tag removal is authoritative over stale indexed canonical tag IDs', async () => {
  const f = fixture(meta({ tags: [] }));
  f.store.data.set('index.json', [{ ...meta(), tagIds: ['old'] }]);
  f.store.data.set('tags.json', { version: 1, tags: [{ id: 'old', name: '120', aliases: [] }], redirects: {} });
  const view = await f.read(); assert.deepEqual(view.tags, []); assert.deepEqual(view.tagIds, []);
});

test('merge preserves redirects for opaque IDs matching Object prototype property names', async () => {
  const f = fixture(meta({ tagIds: ['__proto__'], tags: ['First'] }));
  f.store.data.set('tags.json', { version: 1, tags: [{ id: '__proto__', name: 'First', aliases: [] }, { id: 'constructor', name: 'Second', aliases: [] }], redirects: {} });
  const current = await (await f.request('tags')).json();
  const result = await f.request('tags', { revision: current.revision, merge: { source: '__proto__', target: 'constructor' }, operation_id: operation() });
  assert.equal(result.status, 200); const merged = await result.json();
  assert.equal(Object.hasOwn(merged.redirects, '__proto__'), true); assert.equal(merged.redirects.__proto__, 'constructor');
  assert.deepEqual((await f.read()).tagIds, ['constructor']); assert.deepEqual((await f.read()).tags, ['Second']);
});

test('first shared save can rename an unindexed legacy tag through its original-name alias', async () => {
  for (const visibility of ['private', 'unlisted']) {
    const f = fixture(meta({ visibility, tags: ['Original'] }));
    const identity = legacyTagId('Original'), before = await (await f.request('tags')).json();
    assert.equal(before.tags.some(tag => tag.id === identity), false);
    const response = await f.request('tags', { revision: before.revision, tag: { id: identity, name: 'Current name', aliases: ['Original'] }, operation_id: operation() });
    assert.equal(response.status, 200);
    assert.deepEqual((await f.read()).tags, ['Current name']); assert.deepEqual((await f.read()).tagIds, [identity]);
    const latest = await response.json();
    assert.equal((await f.request('tags', { revision: latest.revision, tag: { id: 'unknown-canonical', name: 'Other', aliases: ['Original'] }, operation_id: operation() })).status, 400);
    assert.deepEqual(f.store.data.get('video120/metadata.json').tags, ['Original']);
  }
});

test('owner reads preserve technical fields and require review for unsafe visibility', async () => {
  const f = fixture(meta({ id: 'historical-id', visibility: 'garbage' }));
  const detail = await f.read();
  assert.equal(detail.id, 'video120'); assert.equal(detail.visibility, 'unknown'); assert.equal(detail.visibility_review_required, true); assert.equal(detail.frameRate, 120);
  assert.equal(detail.metadata.colorTransfer, 'smpte2084'); assert.equal(detail.has_remote, true); assert.equal(detail.can_preview, true);
  assert.equal((await f.request('videos/video120', undefined, null)).status, 403);
  assert.equal((await f.request('videos/video120?remote=banana')).status, 400);
  assert.equal((await f.request('videos/video120?remote=true&check_online=true')).status, 200);
  const list = await (await f.request('videos?cursor=video120/')).json();
  assert.equal(list.videos[0].visibility, 'unknown'); assert.equal(list.videos[0].visibility_review_required, true); assert.equal(f.store.cursor, 'video120/');
});

test('legacy visibility remains unknown when the public CDN uses its own reviewed unlisted mapping', async () => {
  const f = fixture(legacyMetadata()), publicRead = anonymousMetadata(f.store, { video120: 'unlisted' });
  const response = await publicRead();
  assert.equal(response.status, 200); assert.equal((await response.json()).visibility, 'unlisted');
  const detail = await f.read();
  assert.equal(detail.visibility, 'unknown'); assert.equal(detail.published_metadata.visibility, 'unknown');
  assert.equal(detail.visibility_review_required, true); assert.equal(detail.pending, false);
  assert.equal(f.store.calls.length, 0); assert.equal(Object.hasOwn(f.store.data.get('video120/metadata.json'), 'visibility'), false);

  for (const metadata of [legacyMetadata({ unlisted: true }), meta({ visibility: null }), meta({ visibility: false }), meta({ visibility: [] })]) {
    const other = fixture(metadata, { video120: 'public' });
    other.store.data.set('index.json', [meta({ visibility: 'public' })]);
    assert.equal((await other.read()).visibility, 'unknown', 'Neither a legacy flag, a separate map nor a catalogue entry proves stored visibility');
    assert.equal((await other.read()).visibility_review_required, true);
  }
});

test('a stale public catalogue cannot release unknown legacy metadata through title-only publication', async () => {
  const f = fixture(legacyMetadata(), { video120: 'public' });
  f.store.data.set('index.json', [meta({ title: 'Stale public catalogue' })]);
  const publicRead = anonymousMetadata(f.store, {});
  assert.equal((await publicRead()).status, 404);
  const draft = await (await f.edit({ title: 'My title draft', publish: false })).json();
  assert.equal(draft.title, 'My title draft'); assert.equal(draft.pending, true); assert.equal(draft.visibility_review_required, true);
  const result = await f.edit({ title: 'Title-only publish', publish: true });
  assert.equal(result.status, 409); assert.match((await result.json()).detail, /explicitly choose.*visibility/);
  assert.equal((await f.read()).title, 'My title draft');
  assert.equal(f.store.calls.length, 0); assert.equal((await publicRead()).status, 404);
  assert.equal(Object.hasOwn(f.store.data.get('video120/metadata.json'), 'visibility'), false);
});

test('valid stored visibility is authoritative and an explicit private video stays private', async () => {
  for (const visibility of ['public', 'unlisted', 'private']) {
    const f = fixture(meta({ visibility }), { video120: visibility === 'private' ? 'public' : 'private' });
    f.store.data.set('index.json', [meta({ visibility: 'public' })]);
    const detail = await f.read();
    assert.equal(detail.visibility, visibility); assert.equal(detail.published_metadata.visibility, visibility);
    assert.equal(detail.visibility_review_required, false); assert.equal(detail.pending, false);
  }
  const f = fixture(meta({ visibility: 'private' }));
  assert.equal((await f.edit({ title: 'Still private', publish: true })).status, 200);
  assert.equal(f.store.data.get('video120/metadata.json').visibility, 'private');
  assert.equal((await f.read()).visibility_review_required, false);
});

test('reviewed draft visibility persists across resets and stale revisions still conflict', async () => {
  const f = fixture(legacyMetadata()), before = await f.read();
  const saved = await (await f.edit({ title: 'Reviewed title', visibility: 'unlisted', publish: false })).json();
  assert.equal(saved.visibility, 'unlisted'); assert.equal(saved.visibility_review_required, false); assert.equal(saved.pending, true);
  assert.equal(saved.published_metadata.visibility, 'unknown'); assert.equal(f.store.calls.length, 0);
  assert.equal((await f.request('videos/video120', { revision: before.revision, title: 'Stale', visibility: 'public', publish: true, operation_id: operation() })).status, 409);
  const result = await f.request('videos/video120', { revision: saved.revision, publish: true, operation_id: operation() }, owner, f.create());
  assert.equal(result.status, 200);
  const published = await result.json();
  assert.equal(published.pending, false); assert.equal(published.visibility, 'unlisted'); assert.equal(published.visibility_review_required, false);
  assert.equal(f.store.data.get('video120/metadata.json').visibility, 'unlisted');
  assert.equal(f.store.data.get('video120/metadata.json').colorTransfer, 'smpte2084');

  const other = fixture(legacyMetadata());
  await other.edit({ visibility: 'private', publish: false });
  other.store.data.set('video120/metadata.json', legacyMetadata({ title: 'Changed outside the editor' }));
  const conflict = await other.edit({ publish: true });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).current.remoteChanged, true);
  assert.equal(other.store.calls.length, 0);
});

test('pre-fix inferred drafts and unfinished publications need a fresh explicit visibility review', async () => {
  const f = fixture(legacyMetadata());
  const origin = await f.service.origin('video120');
  const draft = { fields: { title: 'Old inferred draft', visibility: 'public' }, base: origin.revision, thumbnails: [], version: 1 };
  await f.storage.put('draft:video120', draft);
  assert.equal((await f.read()).visibility, 'unknown'); assert.equal((await f.read()).visibility_review_required, true);
  assert.equal((await f.edit({ publish: true })).status, 409); assert.equal(f.store.calls.length, 0);
  const operationId = operation();
  await f.storage.put('journal', { id: operationId, hash: 'old-publish-hash', videoId: 'video120', action: 'publish', draft,
    metadata: { ...legacyMetadata(), ...draft.fields }, images: [], staged: [],
    baseMetadataHash: await digest(stableJSON(origin.raw)), baseEntryHash: await digest(stableJSON(origin.entry)), desiredEntryHash: 'unused' });
  await f.create().recover();
  assert.equal((await f.storage.get(`operation:${operationId}`)).status, 409); assert.equal(await f.storage.get('journal'), undefined);
  assert.equal((await f.read()).title, 'Old inferred draft'); assert.equal((await f.read()).visibility, 'unknown');
  assert.equal(f.store.calls.length, 0);
  const reviewed = await (await f.edit({ visibility: 'private', publish: true })).json();
  assert.equal(reviewed.visibility, 'private'); assert.equal(reviewed.pending, false); assert.equal(reviewed.visibility_review_required, false);
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
  assert.equal((await f.request('uploads/reserve', reserve, owner)).status, 403, 'A cached service response remains service-only');
  assert.equal((await f.request('uploads/reserve', { ...reserve, operation_id: operation() }, machine)).status, 409);
  const finish = { lease: held.lease, metadata: meta({ id: 'new120' }), entry: {}, variants: variants(), media_complete: true, operation_id: operation() };
  assert.equal((await f.request('uploads/new120/finalize', { ...finish, metadata: meta({ id: 'new120', frameRate: 60 }) }, machine)).status, 400);
  const { visibility, ...missingVisibility } = finish.metadata;
  assert.equal((await f.request('uploads/new120/finalize', { ...finish, metadata: missingVisibility, entry: { visibility: 'public' } }, machine)).status, 400);
  assert.equal(f.store.calls.length, 0);
  const result = await f.request('uploads/new120/finalize', finish, machine); assert.equal(result.status, 200);
  const calls = f.store.calls.length;
  assert.equal((await f.request('uploads/new120/finalize', finish, machine, f.create())).status, 200);
  assert.equal(f.store.calls.length, calls); assert.equal(f.store.data.get('new120/metadata.json').frameRate, 120);
  assert.equal(f.store.calls.filter(([kind]) => kind === 'verify').length, 1);
});

test('reservation IDs and operation IDs reject coercion and trailing newlines', async () => {
  const f = fixture(null);
  for (const id of ['new120\n', 'new120\r', 123, ['new120'], {}, null, '', 'a'.repeat(129)]) {
    assert.equal((await f.request('uploads/reserve', { id, operation_id: operation() }, machine)).status, 400);
  }
  for (const operation_id of [operation() + '\n', operation() + '\r', 123, [operation()]]) {
    assert.equal((await f.request('uploads/reserve', { id: 'new120', operation_id }, machine)).status, 400);
  }
  assert.equal(f.storage.data.size, 0); assert.equal(f.store.calls.length, 0);
});

const mediaFile = (extra = {}) => ({ path: 'AV1/chunk_0_1.fmp4', size: 1024, sha256: 'a'.repeat(64), md5: Buffer.alloc(16).toString('base64'), content_type: 'video/mp4', ...extra });
async function reservedFixture(uploadSigner) {
  const f = fixture(null, {}, uploadSigner);
  const reserve = { id: 'new120', operation_id: operation() };
  const held = await (await f.request('uploads/reserve', reserve, machine)).json();
  return { ...f, reserve, grants: { lease: held.lease, reservation_operation_id: reserve.operation_id, operation_id: operation(), files: [mediaFile()] } };
}

test('media grants bind a fresh unpublished reservation, fixed assets and idempotent service operation', async () => {
  const signed = [];
  const signer = async value => {
    signed.push(clone(value));
    return { expires_at: '2023-11-14T22:18:20.000Z', grants: value.files.map(file => ({ path: file.path, url: `https://s3.eu-central-003.backblazeb2.com/ProjectAida/${value.videoId}/${file.path}?fake-signature=${signed.length}`, headers: { 'Content-Type': file.content_type, 'X-Amz-Content-Sha256': file.sha256, 'Content-MD5': file.md5, 'Content-Length': String(file.size) } })) };
  };
  const f = await reservedFixture(signer), path = 'videos/new120/upload-grants';
  assert.equal((await f.request(path, f.grants, owner)).status, 403); assert.equal(signed.length, 0);
  assert.equal((await f.storage.get('reservation:new120')).media_uploads, 'signed-put');
  f.store.data.set('new120/AV1/init_0.mp4', new Uint8Array([1,2,3]));
  const response = await f.request(path, f.grants, machine);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(signed, [{ videoId: 'new120', files: f.grants.files, expiresIn: 300 }]);
  assert.equal(result.grants[0].headers['X-Amz-Content-Sha256'], f.grants.files[0].sha256);
  assert.equal(result.grants[0].headers['Content-MD5'], f.grants.files[0].md5, 'B2 enforces this signed payload checksum');
  assert.equal(f.store.calls.length, 0, 'Grant requests write no B2 metadata, catalogue, thumbnails or media');
  assert.deepEqual(await (await f.request(path, f.grants, machine, f.create())).json(), result);
  assert.equal(signed.length, 1, 'Lost-response retry returns the same signed request');
  assert.equal((await f.request(path, f.grants, owner)).status, 403, 'Replay cannot bypass service authorization');
  assert.equal((await f.request(path, { ...f.grants, files: [mediaFile({ size: 2 })] }, machine)).status, 409);
  assert.equal(signed.length, 1);
  // An expired replay carries the original expiry; clients must use a new
  // operation_id to obtain fresh links rather than altering an old request.
  assert.equal((await (await f.request(path, f.grants, machine)).json()).expires_at, result.expires_at);
  assert.equal((await f.request(path, { ...f.grants, operation_id: operation() }, machine)).status, 200);
  assert.equal(signed.length, 2);

  f.store.data.set('new120/metadata.json', meta({ id: 'new120' }));
  assert.equal((await f.request(path, f.grants, machine)).status, 409, 'Publishing the ID invalidates grant replay too');
  assert.equal((await f.request(path, { ...f.grants, operation_id: operation() }, machine)).status, 409);
  assert.equal(signed.length, 2);
});

test('media grants reject stale reservations and fail closed without a signer', async () => {
  let calls = 0;
  const f = await reservedFixture(async () => { calls++; return { grants: [] }; });
  const path = 'videos/new120/upload-grants';
  for (const values of [{ lease: 'wrong' }, { reservation_operation_id: operation() }]) {
    assert.equal((await f.request(path, { ...f.grants, ...values, operation_id: operation() }, machine)).status, 409);
  }
  const reservation = await f.storage.get('reservation:new120');
  await f.storage.put('reservation:new120', { ...reservation, finalized: true });
  assert.equal((await f.request(path, f.grants, machine)).status, 409);
  const { media_uploads, ...oldReservation } = reservation;
  await f.storage.put('reservation:new120', oldReservation);
  assert.equal((await f.request(path, f.grants, machine)).status, 409, 'Pre-cutover reservations cannot mint grants');
  await f.storage.put('reservation:new120', reservation);
  f.store.data.set('index.json', [meta({ id: 'new120' })]);
  assert.equal((await f.request(path, f.grants, machine)).status, 409, 'A catalogue-only existing ID is not fresh');
  assert.equal(calls, 0);
  const unconfigured = await reservedFixture(undefined);
  assert.equal((await unconfigured.request(path, unconfigured.grants, machine)).status, 503);
});

test('media grants enforce filename, batch, content type, hash and asset size limits before signing', async () => {
  let calls = 0;
  const f = await reservedFixture(async () => { calls++; return { grants: [] }; });
  const bad = [
    [], Array.from({ length: 65 }, (_, index) => mediaFile({ path: `AV1/chunk_0_${index}.fmp4` })), [mediaFile(), mediaFile()],
    ...['index.json', 'metadata.json', 'thumbnail_sdr.webp', '../AV1/manifest.mpd', 'AV1/../../index.json', 'AV1/manifest.mpd?versionId=x', 'AV1/%2e%2e/init_0.mp4', 'AV1/manifest.mpd\n'].map(path => [mediaFile({ path })]),
    [mediaFile({ size: 0 })], [mediaFile({ size: -1 })], [mediaFile({ size: 1.5 })], [mediaFile({ size: 512 * 1024 * 1024 + 1 })],
    [mediaFile({ sha256: 'A'.repeat(64) })], [mediaFile({ sha256: 'a'.repeat(64) + '\n' })], [mediaFile({ sha256: 'a'.repeat(63) })],
    [mediaFile({ md5: undefined })], [mediaFile({ md5: '' })], [mediaFile({ md5: 'A'.repeat(21) + 'B==' })], [mediaFile({ md5: Buffer.alloc(15).toString('base64') })], [mediaFile({ md5: Buffer.alloc(16).toString('base64') + '\n' })],
    [mediaFile({ content_type: 'application/octet-stream' })], [mediaFile({ path: 'AV1/manifest.mpd', content_type: 'application/dash+xml', size: 512 * 1024 + 1 })],
    [mediaFile({ path: 'HEVC/media_0.m3u8', content_type: 'application/vnd.apple.mpegurl', size: 512 * 1024 + 1 })],
    [mediaFile({ path: 'HEVC/init_0.mp4', size: 32 * 1024 * 1024 + 1 })], [mediaFile({ unsupported: true })],
  ];
  for (const files of bad) assert.equal((await f.request('videos/new120/upload-grants', { ...f.grants, operation_id: operation(), files }, machine)).status, 400, JSON.stringify(files).slice(0, 120));
  assert.equal(calls, 0); assert.equal(f.store.calls.length, 0);
  const allowed = [mediaFile({ size: 512 * 1024 * 1024 }), mediaFile({ path: 'AV1/manifest.mpd', size: 512 * 1024, content_type: 'application/dash+xml' }), mediaFile({ path: 'HEVC/master.m3u8', size: 512 * 1024, content_type: 'application/vnd.apple.mpegurl' }), mediaFile({ path: 'HEVC/init_0.mp4', size: 32 * 1024 * 1024 })];
  assert.equal((await f.request('videos/new120/upload-grants', { ...f.grants, files: allowed }, machine)).status, 200);
  assert.equal(calls, 1);
});

test('oversized metadata/catalog and unsupported edits fail before B2 mutations', async () => {
  const f = fixture(meta({ historical: 'x'.repeat(128000) }));
  assert.equal((await f.edit({ title: 'Too big', publish: true })).status, 413); assert.equal(f.store.calls.length, 0);
  const g = fixture(); g.store.data.set('index.json', [{ id: 'huge', title: 'x'.repeat(1000000) }]);
  assert.equal((await g.edit({ variants: variants(), publish: true })).status, 413); assert.equal(g.store.calls.length, 0);
  const h = fixture(); assert.equal((await h.edit({ frameRate: 60, publish: true })).status, 400); assert.equal(h.store.calls.length, 0);
});
