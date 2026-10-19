import assert from "node:assert/strict";
import test from "node:test";
import { createSearchIndex, parseSearch, removeSearchToken, searchVideos, suggestTags, tagQuery } from "../web/js/search.js";
import { browseQuery, videosUrl, withBrowseQuery } from "../web/js/browse-context.js";

const cs2 = { id: "game-cs2", name: "Counter-Strike 2", aliases: ["CS2", "Counterstrike 2"] };
const lethal = { id: "game-lethal", name: "Lethal Company", aliases: ["LC"] };
const registry = { version: 1, tags: [cs2, lethal], redirects: {} };
const videos = [
  { id: "clutch", title: "Last round clutch", description: "A close finish", tagIds: [cs2.id], tagDefinitions: [cs2] },
  { id: "spoiler", title: "Spoilers from the match", description: "Another clutch", tagIds: [cs2.id], tagDefinitions: [cs2] },
  { id: "nuts", title: "Nuts of steel", description: "Funny moments in the factory", tagIds: [lethal.id], tagDefinitions: [lethal] },
  { id: "words", title: "Discussing CS2", description: "No game tag here", tags: [] },
];
const index = createSearchIndex(videos, registry);
const ids = query => searchVideos(index, query).map(video => video.id);

test("game names and aliases find existing assignments without separate keyword tags", () => {
  assert.deepEqual(ids("Counter Strike"), ["clutch", "spoiler"]);
  assert.deepEqual(ids("counterstrike 2"), ["clutch", "spoiler"]);
  assert.deepEqual(ids("CS2"), ["clutch", "spoiler", "words"]);
  assert.deepEqual(ids("tag:cs2"), ["clutch", "spoiler"]);
  assert.deepEqual(ids('tag:"Counter-Strike 2"'), ["clutch", "spoiler"]);
  assert.deepEqual(ids("tag:Counter"), []);
});

test("terms combine across fields, phrases stay together, and exclusions win", () => {
  assert.deepEqual(ids("cs2 finish"), ["clutch"]);
  assert.deepEqual(ids("cs2 -spoilers"), ["clutch", "words"]);
  assert.deepEqual(ids("-tag:cs2"), ["nuts", "words"]);
  assert.deepEqual(ids("cs2 -tag:cs2"), ["words"]);
  assert.deepEqual(ids('"funny moments"'), ["nuts"]);
  assert.deepEqual(ids('"moments funny"'), []);
  assert.deepEqual(ids("tag:lc steel"), ["nuts"]);
  assert.deepEqual(ids("-tag:unknown"), videos.map(video => video.id));
});

test("hyphenated names, incomplete quotes, escaping, and unknown prefixes are predictable", () => {
  assert.equal(parseSearch("Counter-Strike")[0].excluded, false);
  assert.deepEqual(parseSearch('-tag:"Lethal Company"').map(({ kind, value, excluded }) => ({ kind, value, excluded })), [{ kind: "tag", value: "Lethal Company", excluded: true }]);
  assert.equal(parseSearch('tag:"Lethal Company')[0].value, "Lethal Company");
  assert.equal(parseSearch('"a \\"quote\\""')[0].value, 'a "quote"');
  assert.equal(parseSearch("unknown:value")[0].value, "unknown:value");
  assert.deepEqual(ids("unknown:value"), []);
  assert.deepEqual(ids("-..."), videos.map(video => video.id));
  assert.deepEqual(ids("."), videos.map(video => video.id));
  assert.equal(tagQuery('A "quoted" game'), 'tag:"A \\"quoted\\" game"');
  const query = 'clutch -tag:"Counter-Strike 2" funny';
  assert.equal(removeSearchToken(query, parseSearch(query)[1]), "clutch funny");
});

test("tag suggestions use catalogue frequency and recognise aliases", () => {
  const suggestions = suggestTags(index);
  assert.deepEqual(suggestions.map(tag => [tag.name, tag.count]), [["Counter-Strike 2", 2], ["Lethal Company", 1]]);
  assert.deepEqual(suggestTags(index, "lc").map(tag => tag.name), ["Lethal Company"]);
});

test("return links carry only a query and preserve local playback flags", () => {
  assert.equal(videosUrl(), "./");
  assert.equal(videosUrl("  "), "./");
  const watch = withBrowseQuery("watch.html?v=clip&local=1", 'nuts -tag:"CS2"');
  const params = new URLSearchParams(watch.split("?")[1]);
  assert.equal(params.get("local"), "1");
  assert.equal(params.get("v"), "clip");
  assert.equal(browseQuery(`?${params}`), 'nuts -tag:"CS2"');
  assert.equal(videosUrl(browseQuery(`?${params}`)), './?q=nuts%20-tag%3A%22CS2%22');
  assert.equal(videosUrl("https://evil.example"), "./?q=https%3A%2F%2Fevil.example");
});
