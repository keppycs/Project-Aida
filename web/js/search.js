/** Local-only catalogue search. Queries are never sent to an analytics service. */
import { normalizeTag, registryFromVideos, resolveVideoTags } from "./tags.js?v=master-tags-v1";

/** Keep token positions so a clicked filter can be removed without rewriting the query. */
export function parseSearch(query = "") {
  const source = String(query);
  const tokens = [];
  let at = 0;
  while (at < source.length) {
    while (/\s/u.test(source[at] || "") && at < source.length) at++;
    if (at >= source.length) break;
    const start = at;
    const excluded = source[at] === "-";
    if (excluded) at++;
    let kind = "text";
    if (source.slice(at, at + 4).toLowerCase() === "tag:") { kind = "tag"; at += 4; }
    let value = "", quote = false;
    while (at < source.length) {
      const char = source[at];
      if (char === "\\" && ["\\", '"'].includes(source[at + 1])) { value += source[at + 1]; at += 2; continue; }
      if (char === '"') { quote = !quote; at++; continue; }
      if (!quote && /\s/u.test(char)) break;
      value += char;
      at++;
    }
    if (value.trim()) tokens.push({ kind, value, excluded, start, end: at, raw: source.slice(start, at) });
  }
  return tokens;
}

function contains(value, term) { return normalizeTag(value).includes(term); }

export function createSearchIndex(videos, registry) {
  const tags = registryFromVideos(videos, registry);
  const entries = videos.map(video => {
    const attached = resolveVideoTags(video, tags);
    return { video, attached, text: [video.title, video.description, ...attached.flatMap(tag => [tag.name, ...tag.aliases])] };
  });
  return { registry: tags, entries };
}

export function searchVideos(index, query) {
  const tokens = parseSearch(query).map(token => ({ ...token, normalized: normalizeTag(token.value) })).filter(token => token.normalized);
  return index.entries.filter(entry => tokens.every(token => {
    const match = token.kind === "tag"
      ? entry.attached.some(tag => [tag.name, ...tag.aliases].some(name => normalizeTag(name) === token.normalized))
      : entry.text.some(text => contains(text, token.normalized));
    return token.excluded ? !match : match;
  })).map(entry => entry.video);
}

export function tagQuery(name, excluded = false) {
  const escaped = String(name).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${excluded ? "-" : ""}tag:${/[\s"\\]/u.test(escaped) ? `"${escaped}"` : escaped}`;
}

export function removeSearchToken(query, token) {
  return `${query.slice(0, token.start).trimEnd()} ${query.slice(token.end).trimStart()}`.trim();
}

/** Frequency means videos tagged by the owner, never viewer search history. */
export function suggestTags(index, text = "", limit = 8) {
  const term = normalizeTag(text);
  const counts = new Map();
  for (const entry of index.entries) for (const tag of entry.attached) counts.set(tag.id, (counts.get(tag.id) || 0) + 1);
  return index.registry.tags.filter(tag => counts.has(tag.id) && (!term || [tag.name, ...tag.aliases].some(name => contains(name, term))))
    .sort((a, b) => (normalizeTag(b.name) === term) - (normalizeTag(a.name) === term) || counts.get(b.id) - counts.get(a.id) || a.name.localeCompare(b.name))
    .slice(0, limit).map(tag => ({ ...tag, count: counts.get(tag.id) }));
}
