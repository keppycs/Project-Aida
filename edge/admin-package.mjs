/** Strict, bounded parser for the static FFmpeg DASH + fMP4 HLS package we publish. */
const DASH = "urn:mpeg:dash:schema:mpd:2011";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const XSI = "http://www.w3.org/2001/XMLSchema-instance";
export const PACKAGE_LIMITS = Object.freeze({ representations: 16, files: 20_000, manifestBytes: 512 * 1024, inventoryPages: 4, inventoryPageSize: 5_000, inventoryBytes: 4_000_000, textBytes: 4_000_000, requests: 24 });
export class PackageError extends Error {}
const fail = message => { throw new PackageError(message); };
const name = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/;
function entities(value) {
  if (/<|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail("Invalid XML characters.");
  return value.replace(/&([^;]*);?/g, (whole, entity) => {
    const values = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (whole.endsWith(";") && Object.hasOwn(values, entity)) return values[entity];
    if (whole.endsWith(";") && /^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) {
      const point = entity[1] === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (point === 9 || point === 10 || point === 13 || point >= 32 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) && point !== 0xfffe && point !== 0xffff) return String.fromCodePoint(point);
    }
    fail("XML entities are invalid or unsupported.");
  });
}

/** No DOMParser dependency, DTD/entity expansion, recovery parsing or URL resolution. */
function xml(text) {
  if (typeof text !== "string" || text.length > PACKAGE_LIMITS.manifestBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text)) fail("The DASH manifest is invalid or too large.");
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0, root, nodes = 0;
  const stack = [];
  while (at < text.length) {
    if (text.startsWith("<!--", at)) {
      const end = text.indexOf("-->", at + 4);
      if (end < 0 || text.slice(at + 4, end).includes("--")) fail("Malformed XML comment.");
      at = end + 3; continue;
    }
    if (text.startsWith("<?xml", at)) {
      if (root || stack.length || text.slice(0, at).trim()) fail("Misplaced XML declaration.");
      const end = text.indexOf("?>", at);
      if (end < 0 || !/^<\?xml[ \t\r\n]+version=(?:"1\.0"|'1\.0')(?:[ \t\r\n]+encoding=(?:"(?:utf-8|UTF-8)"|'(?:utf-8|UTF-8)'))?(?:[ \t\r\n]+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>$/.test(text.slice(at, end + 2))) fail("Unsupported XML declaration.");
      at = end + 2; continue;
    }
    if (text[at] !== "<") {
      const end = text.indexOf("<", at), stop = end < 0 ? text.length : end;
      const raw = text.slice(at, stop);
      if (!stack.length && !/^[ \t\r\n]*$/.test(raw)) fail("Unexpected content outside the XML root.");
      const value = entities(raw);
      if (!/^[ \t\r\n]*$/.test(value) && !["Title", "Source", "Copyright"].includes(stack.at(-1)?.local)) fail("Unexpected DASH text content.");
      at = stop; continue;
    }
    if (text.startsWith("</", at)) {
      const match = /^<\/([A-Za-z_][A-Za-z0-9_.:-]*)[ \t\r\n]*>/.exec(text.slice(at));
      if (!match || stack.at(-1)?.name !== match[1]) fail("Mismatched XML element.");
      stack.pop(); at += match[0].length; continue;
    }
    if (text.startsWith("<!", at) || text.startsWith("<?", at)) fail("DTD, processing instructions and external XML are unsupported.");
    at++;
    const tag = name.exec(text.slice(at));
    if (!tag) fail("Invalid XML element.");
    at += tag[0].length;
    const attrs = Object.create(null), ns = { ...(stack.at(-1)?.ns || {}), xml: "http://www.w3.org/XML/1998/namespace", xmlns: XMLNS };
    let closed = false;
    while (at < text.length) {
      const whitespace = /^[ \t\r\n]*/.exec(text.slice(at))[0]; at += whitespace.length;
      if (text.startsWith("/>", at)) { closed = true; at += 2; break; }
      if (text[at] === ">") { at++; break; }
      if (!whitespace || Object.keys(attrs).length >= 48) fail("Invalid XML attributes.");
      const attribute = name.exec(text.slice(at));
      if (!attribute || Object.hasOwn(attrs, attribute[0])) fail("Duplicate or invalid XML attribute.");
      at += attribute[0].length;
      const equal = /^[ \t\r\n]*=[ \t\r\n]*(["'])/.exec(text.slice(at));
      if (!equal) fail("XML attributes must be quoted.");
      at += equal[0].length;
      const end = text.indexOf(equal[1], at);
      if (end < 0 || end - at > 2048) fail("Invalid XML attribute value.");
      attrs[attribute[0]] = entities(text.slice(at, end)); at = end + 1;
    }
    if (at > text.length || ![">"].includes(text[at - 1])) fail("Unterminated XML element.");
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "xmlns") ns[""] = value;
      else if (key.startsWith("xmlns:")) {
        const prefix = key.slice(6);
        if (prefix === "xmlns" || prefix === "xml" || value === XMLNS) fail("Invalid namespace declaration.");
        ns[prefix] = value;
      }
    }
    const parts = tag[0].split(":"), prefix = parts.length === 2 ? parts[0] : "";
    const uri = ns[prefix];
    if (uri !== DASH) fail("The manifest must use the DASH XML namespace.");
    const expanded = new Set();
    for (const key of Object.keys(attrs)) {
      if (key === "xmlns" || key.startsWith("xmlns:")) continue;
      let resolved = `|${key}`;
      if (key.includes(":")) {
        const [p, local] = key.split(":");
        if (!(ns[p] === XSI && local === "schemaLocation")) fail("External or unsupported XML attributes.");
        resolved = `${ns[p]}|${local}`;
      }
      if (expanded.has(resolved)) fail("Duplicate XML attribute namespace.");
      expanded.add(resolved);
    }
    const node = { name: tag[0], local: parts.at(-1), attrs, ns, children: [] };
    if (++nodes > 4096 || stack.length > 12) fail("The DASH manifest is too complex.");
    if (stack.length) stack.at(-1).children.push(node);
    else { if (root) fail("Multiple XML roots."); root = node; }
    if (!closed) stack.push(node);
  }
  if (!root || stack.length || root.local !== "MPD") fail("Incomplete DASH XML.");
  return root;
}
function children(node, local) { return node.children.filter(child => child.local === local); }
function integer(value, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) fail("Invalid package number.");
  return Number(value);
}
function duration(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value || "");
  const seconds = match && (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0));
  if (!Number.isFinite(seconds) || seconds <= 0) fail("A finite static video duration is required.");
  return seconds;
}
function fps120(value) {
  const match = typeof value === "string" && value.length <= 64 && /^(\d+)(?:\/(\d+)|\.(\d+))?$/.exec(value);
  if (!match) fail("Every video rendition must declare 120 fps.");
  const numerator = BigInt(match[1] + (match[3] || "")), denominator = match[2] ? BigInt(match[2]) : 10n ** BigInt(match[3]?.length || 0);
  if (denominator <= 0n || numerator !== 120n * denominator) fail("Every video rendition must declare 120 fps.");
}
function decimal(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0) fail("Invalid playlist duration or bandwidth.");
  return Number(value);
}

export function parseDash(text, codec, metadata) {
  const root = xml(text);
  const allowed = { MPD: ["ProgramInformation", "ServiceDescription", "Period"], ProgramInformation: ["Title", "Source", "Copyright"], Title: [], Source: [], Copyright: [], ServiceDescription: [], Period: ["AdaptationSet"], AdaptationSet: ["Representation", "SegmentTemplate"], Representation: ["SegmentTemplate", "AudioChannelConfiguration"], SegmentTemplate: [], AudioChannelConfiguration: [] };
  const walk = node => {
    if (!Object.hasOwn(allowed, node.local) || node.children.some(child => !allowed[node.local].includes(child.local))) fail("Unsupported DASH structure or URL reference.");
    if (node.local === "SegmentTemplate" && Object.keys(node.attrs).some(key => !["timescale", "duration", "startNumber", "initialization", "media", "presentationTimeOffset"].includes(key))) fail("Unsupported DASH segment reference attributes.");
    for (const child of node.children) walk(child);
  };
  walk(root);
  if (root.attrs.type !== "static" || children(root, "Period").length !== 1) fail("Only complete single-period VOD packages are supported.");
  const seconds = duration(root.attrs.mediaPresentationDuration);
  if (!Number.isFinite(metadata.duration) || Math.abs(seconds - metadata.duration) > .25) fail("DASH duration does not match the completed encode.");
  const period = children(root, "Period")[0];
  if (period.attrs.start && period.attrs.start !== "PT0.0S" && period.attrs.start !== "PT0S") fail("Unsupported DASH period start.");
  if (period.attrs.duration && Math.abs(duration(period.attrs.duration) - seconds) > .001) fail("Conflicting DASH durations.");
  const representations = [], ids = new Set(), adaptationIds = new Set();
  for (const adaptation of children(period, "AdaptationSet")) {
    if (adaptation.attrs.id !== undefined) {
      if (adaptationIds.has(adaptation.attrs.id)) fail("Duplicate DASH adaptation ID.");
      adaptationIds.add(adaptation.attrs.id);
    }
    const type = adaptation.attrs.contentType;
    if (!["video", "audio"].includes(type) || !children(adaptation, "Representation").length) fail("Every DASH adaptation needs declared representations.");
    for (const representation of children(adaptation, "Representation")) {
      const a = { ...adaptation.attrs, ...representation.attrs }, repId = representation.attrs.id;
      integer(repId, 0, 9999);
      if (ids.has(repId) || representations.length >= 8) fail("Duplicate or excessive DASH representations.");
      ids.add(repId);
      if (a.mimeType !== `${type}/mp4` || !a.codecs || (type === "video" ? !(codec === "AV1" ? /^av01\./ : /^(?:hvc1|hev1)\./).test(a.codecs) : !/^mp4a\./.test(a.codecs))) fail("The declared codec does not match the package.");
      const width = type === "video" ? integer(a.width, 1, 16384) : null, height = type === "video" ? integer(a.height, 1, 16384) : null;
      if (type === "video") fps120(a.frameRate);
      if (children(adaptation, "SegmentTemplate").length > 1 || children(representation, "SegmentTemplate").length > 1) fail("Ambiguous DASH segment templates.");
      const template = { ...children(adaptation, "SegmentTemplate")[0]?.attrs, ...children(representation, "SegmentTemplate")[0]?.attrs };
      const timescale = integer(template.timescale || "1"), ticks = integer(template.duration), start = integer(template.startNumber || "1", 0);
      if (template.presentationTimeOffset && template.presentationTimeOffset !== "0") fail("Unsupported segment time offset.");
      if (template.initialization !== "init_$RepresentationID$.mp4" || !/^chunk_\$RepresentationID\$_\$Number(?:%0[1-9]d)?\$\.fmp4$/.test(template.media || "")) fail("DASH references must use local package filenames.");
      const segmentSeconds = ticks / timescale, minimumSegments = Math.ceil(seconds / segmentSeconds - 1e-9), maximumSegments = Math.ceil((seconds + .25) / segmentSeconds - 1e-9);
      if (!Number.isSafeInteger(maximumSegments) || maximumSegments > PACKAGE_LIMITS.files || minimumSegments < 1) fail("The package has too many segments.");
      const padding = /%0([1-9])d/.exec(template.media)?.[1] || 0;
      representations.push({ id: repId, type, width, height, codec: a.codecs, initialization: `init_${repId}.mp4`, playlist: `media_${repId}.m3u8`, seconds, segmentSeconds, start, minimumSegments, maximumSegments,
        segmentName: number => `chunk_${repId}_${String(number).padStart(Number(padding), "0")}.fmp4` });
    }
  }
  if (!representations.some(rep => rep.type === "video") || period.children.some(node => node.local !== "AdaptationSet")) fail("No complete DASH video adaptation was found.");
  // Known FFmpeg package structure only: never silently ignore additional
  // nested representations or URL-bearing extensions outside these positions.
  const counted = node => (node.local === "Representation" ? 1 : 0) + node.children.reduce((sum, child) => sum + counted(child), 0);
  if (counted(root) !== representations.length) fail("Unexpected nested DASH representations.");
  return representations;
}

function lines(text) {
  if (typeof text !== "string" || text.length > PACKAGE_LIMITS.manifestBytes || text.includes("\0")) fail("The HLS playlist is invalid or too large.");
  const result = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (result.some(line => line.includes("\r"))) fail("Invalid HLS line endings.");
  if (result.shift() !== "#EXTM3U" || result.length > 50_000) fail("A complete HLS playlist is required.");
  return result;
}
function attributes(text) {
  const result = Object.create(null);
  while (text) {
    const match = /^([A-Z0-9-]+)=(?:"([^"\r\n]*)"|([^,\r\n]+))(?:,|$)/.exec(text);
    if (!match || Object.hasOwn(result, match[1])) fail("Invalid or duplicate HLS attributes.");
    result[match[1]] = match[2] ?? match[3]; text = text.slice(match[0].length);
  }
  return result;
}
export function parseMaster(text, representations) {
  const available = new Map(representations.map(rep => [rep.playlist, rep])), seen = new Set(), groups = new Map(), videoGroups = [];
  let pending = null, version = false;
  for (const line of lines(text)) {
    if (pending) {
      const rep = available.get(line);
      if (!rep || rep.type !== "video" || seen.has(line)) fail("HLS video playlists must match every DASH rendition.");
      const match = /^(\d+)x(\d+)$/.exec(pending.RESOLUTION || "");
      if (!match || Number(match[1]) !== rep.width || Number(match[2]) !== rep.height || !pending.CODECS?.split(",").includes(rep.codec)) fail("HLS video metadata does not match DASH.");
      fps120(pending["FRAME-RATE"]); decimal(pending.BANDWIDTH);
      videoGroups.push({ group: pending.AUDIO, codecs: pending.CODECS.split(","), videoCodec: rep.codec });
      seen.add(line); pending = null; continue;
    }
    if (line.startsWith("#EXT-X-STREAM-INF:")) pending = attributes(line.slice(18));
    else if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = attributes(line.slice(13)), rep = available.get(a.URI);
      if (a.TYPE !== "AUDIO" || !a["GROUP-ID"] || !rep || rep.type !== "audio" || seen.has(a.URI)) fail("HLS audio playlists must match DASH.");
      seen.add(a.URI); groups.set(a["GROUP-ID"], new Set([...(groups.get(a["GROUP-ID"]) || []), rep.codec]));
    } else if (/^#EXT-X-VERSION:[1-9][0-9]?$/.test(line)) { if (version) fail("Duplicate HLS version tag."); version = true; }
    else if (line === "#EXT-X-INDEPENDENT-SEGMENTS") continue;
    else fail("Unsupported HLS master tag or external playlist reference.");
  }
  if (pending || !version || seen.size !== available.size || new Set(videoGroups.map(item => item.group).filter(Boolean)).size !== groups.size || videoGroups.some(({ group, codecs, videoCodec }) => {
    const audio = group ? groups.get(group) : null;
    const expected = new Set([videoCodec, ...(audio || [])]);
    return (group && !audio) || (groups.size && !group) || codecs.length !== expected.size || codecs.some(codec => !expected.has(codec));
  })) fail("The HLS master is incomplete.");
  return [...seen];
}
export function parseMedia(text, representation) {
  const content = lines(text), segments = [], single = new Set();
  let pending = null, total = 0, ended = false, initialization, target;
  for (const line of content) {
    if (ended) fail("Unexpected content after HLS end marker.");
    if (line.startsWith("#EXTINF:")) { if (pending !== null || !/^#EXTINF:\d+(?:\.\d+)?,[^\r\n]*$/.test(line)) fail("Missing or malformed HLS segment duration."); pending = decimal(line.slice(8).split(",")[0]); }
    else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) { if (pending === null || !Number.isFinite(Date.parse(line.slice(25)))) fail("Invalid HLS segment timestamp."); }
    else if (line === "#EXT-X-ENDLIST") { if (pending !== null) fail("Missing final HLS segment."); ended = true; }
    else if (!line.startsWith("#")) {
      if (pending === null || segments.length >= representation.maximumSegments || line !== representation.segmentName(representation.start + segments.length)) fail("HLS segments are missing, reordered or outside the package.");
      if (pending > representation.segmentSeconds + .25) fail("HLS segment duration conflicts with DASH.");
      segments.push(line); total += pending; pending = null;
    } else {
      if (pending !== null || segments.length) fail("HLS headers must precede media segments.");
      const tag = line.split(":")[0];
      if (single.has(tag)) fail("Duplicate HLS media tag."); single.add(tag);
      if (tag === "#EXT-X-MAP") { const a = attributes(line.slice(11)); if (Object.keys(a).length !== 1 || a.URI !== representation.initialization) fail("HLS initialization must match DASH."); initialization = a.URI; }
      else if (tag === "#EXT-X-MEDIA-SEQUENCE") { if (integer(line.slice(22), 0) !== representation.start) fail("HLS sequence does not match DASH."); }
      else if (tag === "#EXT-X-TARGETDURATION") target = integer(line.slice(22));
      else if (tag === "#EXT-X-VERSION") integer(line.slice(15), 1, 99);
      else if (line !== "#EXT-X-PLAYLIST-TYPE:VOD" && line !== "#EXT-X-INDEPENDENT-SEGMENTS") fail("Unsupported HLS media tag or external URI.");
    }
  }
  if (!ended || !initialization || !target || !single.has("#EXT-X-MEDIA-SEQUENCE") || segments.length < representation.minimumSegments || Math.abs(total - representation.seconds) > .25 || target < Math.round(representation.segmentSeconds)) fail("The HLS rendition is incomplete.");
  return [initialization, ...segments];
}
