/** Shared, offline tag identities. No network, browser storage or viewer data. */
const TAG_ID = /^[A-Za-z0-9_-]{1,128}$/;
const validId = value => typeof value === "string" && !/\s/.test(value) && TAG_ID.test(value);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function normalizeTag(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[.'\u2018\u2019]/g, "")
    .replace(/[-_\u2010-\u2015:,;!?()\[\]{}\/\\]+/g, " ").replace(/\s+/g, " ").trim();
}

export function legacyTagId(value) {
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(normalizeTag(value))) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  return `legacy-${hash.toString(16).padStart(16, "0")}`;
}

function label(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(value) || !normalizeTag(value)) throw new Error("Use tag names and aliases between 1 and 100 characters.");
  return value.trim();
}

export function normalizeRegistry(input = null) {
  if (input === null || input === undefined) return { version: 1, tags: [], redirects: {} };
  if (!plain(input) || input.version !== 1 || !Array.isArray(input.tags) || input.tags.length > 10000 || !plain(input.redirects ?? {})) throw new Error("The saved tag list is invalid.");
  const used = new Map(), ids = new Set();
  const tags = input.tags.map(tag => {
    if (!plain(tag) || !validId(tag.id) || ids.has(tag.id) || !Array.isArray(tag.aliases ?? []) || (tag.aliases?.length || 0) > 50) throw new Error("The saved tag list is invalid.");
    ids.add(tag.id);
    const name = label(tag.name), own = new Set([normalizeTag(name)]), aliases = [];
    for (const raw of tag.aliases || []) {
      const alias = label(raw), key = normalizeTag(alias);
      if (!own.has(key)) { aliases.push(alias); own.add(key); }
    }
    for (const key of own) {
      if (used.has(key)) throw new Error(`That tag name or alias already belongs to ${used.get(key)}.`);
      used.set(key, name);
    }
    return { id: tag.id, name, aliases };
  });
  const redirects = {};
  if (Object.keys(input.redirects || {}).length > 10000) throw new Error("The saved tag list is invalid.");
  for (const [source, target] of Object.entries(input.redirects || {})) {
    if (!validId(source) || !validId(target) || ids.has(source) || source === target) throw new Error("The saved tag redirects are invalid.");
    Object.defineProperty(redirects, source, { value: target, enumerable: true, writable: true, configurable: true });
  }
  for (const source of Object.keys(redirects)) {
    const visited = new Set([source]); let target = redirects[source];
    while (Object.hasOwn(redirects, target)) {
      if (visited.has(target)) throw new Error("The saved tag redirects contain a cycle.");
      visited.add(target); target = redirects[target];
    }
    if (!ids.has(target)) throw new Error("The saved tag redirect target is missing.");
    redirects[source] = target;
  }
  return { version: 1, tags, redirects };
}

/** Include old string tags without rewriting video files or guessing aliases. */
export function registryFromVideos(videos = [], registry = null) {
  const result = normalizeRegistry(registry), ids = new Set(result.tags.map(tag => tag.id));
  const known = new Set(result.tags.flatMap(tag => [tag.name, ...tag.aliases].map(normalizeTag)));
  for (const video of videos) {
    // Embedded definitions are already scoped by the server to this video.
    for (const raw of Array.isArray(video?.tagDefinitions) ? video.tagDefinitions : []) {
      if (ids.has(raw?.id) || Object.hasOwn(result.redirects, raw?.id)) continue;
      let definition;
      try { definition = normalizeRegistry({ version: 1, tags: [raw], redirects: {} }).tags[0]; } catch { continue; }
      if ([definition.name, ...definition.aliases].some(value => known.has(normalizeTag(value)))) continue;
      result.tags.push(definition); ids.add(definition.id);
      for (const value of [definition.name, ...definition.aliases]) known.add(normalizeTag(value));
    }
    for (const raw of Array.isArray(video?.tags) ? video.tags : []) {
      if (typeof raw !== "string" || !normalizeTag(raw) || raw.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(raw)) continue;
      const name = raw.trim(), key = normalizeTag(name);
      if (known.has(key)) continue;
      const id = legacyTagId(name);
      // Old clients may introduce a string tag before its registry entry is
      // saved. Only its deterministic id can authorize this fallback; stale
      // labels attached to a renamed canonical id never create extra tags.
      if (Array.isArray(video?.tagIds) && !video.tagIds.includes(id)) continue;
      if (ids.has(id) || Object.hasOwn(result.redirects, id)) continue;
      result.tags.push({ id, name, aliases: [] }); ids.add(id); known.add(key);
    }
  }
  return normalizeRegistry(result);
}

export function resolveVideoTags(video, registry = null) {
  const source = registryFromVideos([video], registry), byId = new Map(source.tags.map(tag => [tag.id, tag]));
  const keys = Array.isArray(video?.tagIds) ? video.tagIds : (Array.isArray(video?.tags) ? video.tags : []).map(name => {
    // A renamed or merged legacy assignment keeps its identity even if a
    // different tag later takes its old name or alias.
    const legacy = legacyTagId(name);
    if (Object.hasOwn(source.redirects, legacy)) return source.redirects[legacy];
    if (byId.has(legacy)) return legacy;
    const key = normalizeTag(name);
    const matching = source.tags.find(tag => [tag.name, ...tag.aliases].some(value => normalizeTag(value) === key));
    return matching?.id;
  });
  return [...new Set(keys.map(key => Object.hasOwn(source.redirects, key) ? source.redirects[key] : key))].map(key => byId.get(key)).filter(Boolean);
}

export function hydrateVideoTags(video, registry = null) {
  const definitions = resolveVideoTags(video, registry);
  return { ...video, tags: definitions.map(tag => tag.name), tagIds: definitions.map(tag => tag.id),
    tagDefinitions: definitions.map(tag => ({ ...tag, aliases: [...tag.aliases] })) };
}
