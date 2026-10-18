/** Owner identity is verified here even when a route's Access policy is misconfigured. */
const cache = new Map();
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const MAX_TOKEN = 16_384;

export class AdminAuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function configuration(env) {
  const team = String(env.ACCESS_TEAM_DOMAIN || "");
  const audience = String(env.ACCESS_AUD || "");
  const owner = String(env.OWNER_EMAIL || "").trim().toLowerCase();
  let origin;
  try {
    const url = new URL(env.SITE_ORIGIN || "");
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    origin = url.origin;
  } catch { throw new AdminAuthError(503, "Owner editing is not configured."); }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(team) ||
      !audience || audience.length > 256 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(owner)) {
    throw new AdminAuthError(503, "Owner editing is not configured.");
  }
  return { issuer: `https://${team}`, audience, owner, origin };
}

function decodePart(part, limit) {
  if (!part || part.length > limit || !/^[A-Za-z0-9_-]+$/.test(part)) throw new Error();
  const bytes = Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0));
  return bytes;
}

async function publicKeys(issuer, fetcher, now, refresh = false) {
  const existing = cache.get(issuer);
  if (existing?.keys && existing.expires > now && (!refresh || existing.loaded + 30_000 > now)) return existing.keys;
  if (existing?.pending) return existing.pending;
  const pending = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      // Workers implements manual/follow only; reject redirects ourselves.
      const response = await fetcher(`${issuer}/cdn-cgi/access/certs`, { signal: controller.signal, redirect: "manual", headers: { Accept: "application/json" } });
      if (!response.ok || Number(response.headers.get("content-length") || 0) > 128_000) { await response.body?.cancel(); throw new Error(); }
      if (!response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 128_000) { await reader.cancel(); throw new Error(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const data = JSON.parse(decoder.decode(bytes));
      if (!Array.isArray(data.keys) || !data.keys.length || data.keys.length > 32) throw new Error();
      const keys = new Map();
      for (const key of data.keys) {
        if (key.kty !== "RSA" || typeof key.kid !== "string" || !key.kid || key.kid.length > 256 ||
            (key.alg && key.alg !== "RS256") || (key.use && key.use !== "sig") || keys.has(key.kid) || key.d) throw new Error();
        const imported = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
        keys.set(key.kid, imported);
      }
      cache.set(issuer, { keys, expires: now + 5 * 60_000, loaded: now });
      return keys;
    } catch { throw new AdminAuthError(503, "Sign-in verification is temporarily unavailable."); }
    finally { clearTimeout(timeout); }
  })();
  cache.set(issuer, { ...existing, pending });
  try { return await pending; }
  catch (error) { if (cache.get(issuer)?.pending === pending) cache.delete(issuer); throw error; }
}

export async function authorizeRequest(request, env, { fetcher = fetch, now = Date.now() } = {}) {
  const config = configuration(env);
  const url = new URL(request.url);
  if (url.origin !== config.origin || !(url.pathname === "/edit" || url.pathname.startsWith("/edit/"))) {
    throw new AdminAuthError(403, "Owner editing is unavailable at this address.");
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || "";
  if (!token || token.length > MAX_TOKEN) throw new AdminAuthError(401, "Sign in to edit your videos.");
  let header, claims, parts;
  try {
    parts = token.split(".");
    if (parts.length !== 3) throw new Error();
    header = JSON.parse(decoder.decode(decodePart(parts[0], 2048)));
    claims = JSON.parse(decoder.decode(decodePart(parts[1], 12_000)));
    if (!header || Array.isArray(header) || header.alg !== "RS256" || typeof header.kid !== "string" ||
        !header.kid || header.kid.length > 256 || header.crit || header.jku || header.jwk ||
        !claims || Array.isArray(claims)) throw new Error();
  } catch { throw new AdminAuthError(401, "Sign in to edit your videos."); }
  let keys = await publicKeys(config.issuer, fetcher, now);
  if (!keys.has(header.kid)) keys = await publicKeys(config.issuer, fetcher, now, true);
  const key = keys.get(header.kid);
  let valid = false;
  try {
    valid = Boolean(key) && await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodePart(parts[2], 1400), encoder.encode(`${parts[0]}.${parts[1]}`));
  } catch { /* Invalid signatures never reach any editor handler. */ }
  const seconds = Math.floor(now / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!valid || claims.iss !== config.issuer || !audiences.includes(config.audience) || claims.type !== "app" ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= seconds ||
      (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds)) ||
      (claims.iat !== undefined && (!Number.isSafeInteger(claims.iat) || claims.iat > seconds + 30))) {
    throw new AdminAuthError(401, "Your sign-in expired. Sign in again to continue.");
  }
  let identity;
  if (typeof claims.email === "string" && claims.email.trim().toLowerCase() === config.owner &&
      typeof claims.sub === "string" && claims.sub && !claims.common_name) {
    identity = { kind: "owner", email: config.owner, sub: claims.sub };
  } else if (env.ACCESS_SERVICE_CLIENT_ID && claims.common_name === env.ACCESS_SERVICE_CLIENT_ID &&
      !claims.email && url.pathname.startsWith("/edit/api/")) {
    identity = { kind: "service", email: null, sub: claims.common_name };
  } else { throw new AdminAuthError(403, "This account cannot edit videos."); }
  const method = request.method.toUpperCase();
  if (!["GET", "HEAD", "POST"].includes(method)) throw new AdminAuthError(405, "Method not allowed.");
  if (method === "POST") {
    const origin = request.headers.get("Origin");
    if ((identity.kind === "owner" && origin !== config.origin) || (identity.kind === "service" && origin !== null) ||
        !/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || "") ||
        (identity.kind === "owner" && request.headers.get("X-Aida-Editor") !== "1") ||
        (identity.kind === "owner" && request.headers.has("Sec-Fetch-Site") && request.headers.get("Sec-Fetch-Site") !== "same-origin")) {
      throw new AdminAuthError(403, "Open the editor directly before saving.");
    }
  }
  return identity;
}

/** Test isolation; contains public keys only, never login cookies or credentials. */
export function clearPublicKeyCache() { cache.clear(); }
