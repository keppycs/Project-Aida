import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTag, legacyTagId, normalizeRegistry, registryFromVideos, resolveVideoTags, hydrateVideoTags } from '../web/js/tags.js';

const registry = { version: 1, tags: [{ id: 'cs2', name: 'Counter-Strike 2', aliases: ['CS2', 'Counterstrike 2'] },
  { id: 'cpp', name: 'C++', aliases: [] }, { id: 'private-game', name: 'Private Game', aliases: ['Secret alias'] }], redirects: { 'old-cs2': 'cs2' } };

test('tag normalization handles punctuation variations without removing meaningful punctuation or sequel numbers', () => {
  assert.equal(normalizeTag('  Counter—Strike_2 '), 'counter strike 2');
  assert.equal(normalizeTag('C++'), 'c++'); assert.notEqual(normalizeTag('C++'), normalizeTag('C'));
  assert.equal(normalizeTag('F.E.A.R.'), 'fear'); assert.equal(normalizeTag("Clancy’s"), 'clancys');
  assert.equal(normalizeTag('Counter: Strike / 2!?'), 'counter strike 2');
  assert.equal(normalizeTag('C#'), 'c#');
  assert.notEqual(normalizeTag('Counter-Strike 2'), normalizeTag('Counter-Strike'));
  assert.equal(legacyTagId('Counter-Strike 2'), legacyTagId('counter strike 2'));
  assert.equal(legacyTagId('hello'), 'legacy-a430d84680aabd0b');
});

test('legacy tags resolve aliases while canonical ids survive renaming and merging', () => {
  assert.deepEqual(resolveVideoTags({ tags: ['CS2', 'counter strike 2'] }, registry).map(tag => tag.id), ['cs2']);
  assert.deepEqual(resolveVideoTags({ tags: ['stale name'], tagIds: ['old-cs2'] }, registry).map(tag => tag.name), ['Counter-Strike 2']);
  assert.deepEqual(resolveVideoTags({ tags: ['CS2'], tagIds: [] }, registry), []);
});

test('renamed and merged legacy assignments survive reuse of their old name or alias', () => {
  const identity = legacyTagId('Original');
  for (const merged of [false, true]) for (const alias of [false, true]) {
    const destination = merged ? 'canonical' : identity;
    const reused = { id: 'new-distinct-tag', name: alias ? 'Other tag' : 'Original', aliases: alias ? ['Original'] : [] };
    const current = { version: 1, tags: [{ id: destination, name: 'Current name', aliases: [] }, reused],
      redirects: merged ? { [identity]: 'middle', middle: destination } : {} };
    const video = hydrateVideoTags({ tags: ['Original'] }, current);
    assert.deepEqual(video.tagIds, [destination], `The ${merged ? 'merged' : 'renamed'} identity must precede a reused ${alias ? 'alias' : 'name'}`);
    assert.deepEqual(video.tags, ['Current name']);
    assert.deepEqual(hydrateVideoTags({ tags: ['Original'], tagIds: [reused.id] }, current).tagIds, [reused.id]);
  }
});

test('public hydration includes only definitions assigned to the authorized video', () => {
  const video = hydrateVideoTags({ id: 'visible', tagIds: ['cs2'], tags: ['stale'] }, registry);
  assert.deepEqual(video.tags, ['Counter-Strike 2']); assert.deepEqual(video.tagDefinitions, [registry.tags[0]]);
  assert.equal(JSON.stringify(video).includes('Secret alias'), false);
  const legacy = hydrateVideoTags({ tags: ['Funny'] });
  assert.deepEqual(legacy.tagIds, [legacyTagId('Funny')]);
});

test('registry validates ambiguous aliases, malformed ids, controls and redirect cycles', () => {
  for (const value of [
    { ...registry, tags: [...registry.tags, { id: 'other', name: 'cs2', aliases: [] }] },
    { ...registry, tags: [{ id: '../bad', name: 'Bad', aliases: [] }] },
    { ...registry, tags: [{ id: 'bad', name: 'Bad\nname', aliases: [] }] },
    { ...registry, redirects: { a: 'b', b: 'a' } },
    { ...registry, redirects: { a: 'missing' } },
  ]) assert.throws(() => normalizeRegistry(value));
});

test('legacy registry suggestions deduplicate normalized strings and retain scoped aliases', () => {
  const known = registryFromVideos([{ tags: ['Counter Strike 2', 'Funny', 'funny'] }, { tagDefinitions: [registry.tags[1]], tagIds: ['cpp'] }], registry);
  assert.equal(known.tags.length, 4);
  assert.deepEqual(known.tags.at(-1), { id: legacyTagId('Funny'), name: 'Funny', aliases: [] });
});

test('legacy malformed labels are skipped and reserved object names remain valid opaque IDs', () => {
  assert.deepEqual(hydrateVideoTags({ tags: ['Bad\nname', 'Bad\0name', 'Fine'] }).tags, ['Fine']);
  const reserved = { version: 1, tags: [{ id: '__proto__', name: 'First', aliases: [] }, { id: 'constructor', name: 'Second', aliases: [] }, { id: 'toString', name: 'Third', aliases: [] }], redirects: {} };
  assert.deepEqual(resolveVideoTags({ tagIds: ['__proto__', 'constructor', 'toString'] }, reserved).map(tag => tag.id), ['__proto__', 'constructor', 'toString']);
  const redirected = { ...reserved, tags: reserved.tags.slice(1), redirects: JSON.parse('{"__proto__":"constructor","earlier":"__proto__"}') };
  assert.deepEqual(resolveVideoTags({ tagIds: ['earlier', '__proto__'] }, redirected).map(tag => tag.id), ['constructor']);
  const mergedLegacy = { version: 1, tags: [{ id: 'canonical', name: 'Current name', aliases: [] }], redirects: { [legacyTagId('Original')]: 'middle', middle: 'canonical' } };
  assert.deepEqual(hydrateVideoTags({ tags: ['Original'] }, mergedLegacy).tagIds, ['canonical'], 'legacy assignments survive nested merges even after the old name alias is removed');
  const renamedLegacy = { version: 1, tags: [{ id: legacyTagId('Original'), name: 'Current name', aliases: [] }], redirects: {} };
  assert.deepEqual(hydrateVideoTags({ tags: ['Original'] }, renamedLegacy).tags, ['Current name'], 'renamed legacy identities remain assigned after their old alias is removed');
});
