import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { authorizeRequest, clearPublicKeyCache } from "../edge/admin-auth.mjs";

const now = 1_790_000_000_000;
const seconds = now / 1000;
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const publicKey = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
const env = { SITE_ORIGIN: "https://keppy.dev", ACCESS_TEAM_DOMAIN: "aida-test.cloudflareaccess.com", ACCESS_AUD: "owner-application", OWNER_EMAIL: "owner@example.invalid", ACCESS_SERVICE_CLIENT_ID: "writer-client.access" };
const base = { iss: "https://aida-test.cloudflareaccess.com", aud: [env.ACCESS_AUD], type: "app", sub: "owner-subject", email: env.OWNER_EMAIL, exp: seconds + 60, nbf: seconds - 1, iat: seconds - 30 };
const encode = object => Buffer.from(JSON.stringify(object)).toString("base64url");
async function token(claims = {}, header = {}) {
  const content = `${encode({ alg: "RS256", kid: "test-key", ...header })}.${encode({ ...base, ...claims })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(content));
  return `${content}.${Buffer.from(signature).toString("base64url")}`;
}
function request(jwt, { method = "GET", path = "/edit/api/session", origin = "https://keppy.dev", headers = {} } = {}) {
  const fields = { "Cf-Access-Jwt-Assertion": jwt, ...headers };
  if (method === "POST") Object.assign(fields, { "Content-Type": "application/json", "X-Aida-Editor": "1", ...origin === null ? {} : { Origin: origin }, ...headers });
  return new Request(`https://keppy.dev${path}`, { method, headers: fields, ...method === "POST" ? { body: "{}" } : {} });
}
const fetcher = async url => {
  assert.equal(url, "https://aida-test.cloudflareaccess.com/cdn-cgi/access/certs");
  return Response.json({ keys: [publicKey] });
};
async function rejected(jwt, status, options = {}, settings = env) {
  await assert.rejects(authorizeRequest(request(jwt, options), settings, { now, fetcher }), error => error.status === status);
}
beforeEach(clearPublicKeyCache);

test("only the signed approved owner reaches the editor and JSON writes", async () => {
  const jwt = await token();
  assert.deepEqual(await authorizeRequest(request(jwt), env, { now, fetcher }), { kind: "owner", email: env.OWNER_EMAIL, sub: "owner-subject" });
  assert.equal((await authorizeRequest(request(jwt, { method: "POST" }), env, { now, fetcher })).kind, "owner");
  await rejected(await token({ email: "another@example.invalid" }), 403);
});

test("missing setup and alternate worker addresses fail closed", async () => {
  const jwt = await token();
  for (const name of ["SITE_ORIGIN", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OWNER_EMAIL"]) await rejected(jwt, 503, {}, { ...env, [name]: "" });
  await rejected(jwt, 503, {}, { ...env, ACCESS_TEAM_DOMAIN: "attacker.invalid/certs" });
  await assert.rejects(authorizeRequest(new Request("https://aida.workers.dev/edit", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), env, { now, fetcher }), error => error.status === 403);
});

test("unsigned claims, forged signatures and attacker key URLs are rejected", async () => {
  await rejected("", 401);
  await rejected(await token({}, { alg: "none" }), 401);
  await rejected(await token({}, { jku: "https://attacker.invalid/keys" }), 401);
  await rejected(await token({}, { crit: ["b64"] }), 401);
  const jwt = await token();
  const parts = jwt.split(".");
  parts[1] = encode({ ...base, exp: seconds + 1000 });
  await rejected(parts.join("."), 401);
  await rejected(`${parts[0]}.${parts[1]}.not-a-signature`, 401);
});

test("issuer, audience, app type and token times are mandatory", async () => {
  for (const claims of [{ iss: "https://attacker.invalid" }, { aud: ["other-app"] }, { type: "global" }, { exp: seconds }, { exp: "later" }, { nbf: seconds + 1 }, { iat: seconds + 31 }, { sub: "" }]) {
    await rejected(await token(claims), claims.sub === "" ? 403 : 401);
  }
});

test("browser writes require same-origin JSON and a custom header", async () => {
  const jwt = await token();
  await rejected(jwt, 403, { method: "POST", origin: null });
  await rejected(jwt, 403, { method: "POST", origin: "https://attacker.invalid" });
  await rejected(jwt, 403, { method: "POST", headers: { "Content-Type": "text/plain" } });
  await rejected(jwt, 403, { method: "POST", headers: { "X-Aida-Editor": "", "Sec-Fetch-Site": "same-origin" } });
  await rejected(jwt, 403, { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } });
  await rejected(jwt, 405, { method: "OPTIONS" });
});

test("the separately signed machine identity is restricted to API requests", async () => {
  const jwt = await token({ email: undefined, sub: undefined, common_name: env.ACCESS_SERVICE_CLIENT_ID });
  assert.equal((await authorizeRequest(request(jwt, { method: "POST", origin: null }), env, { now, fetcher })).kind, "service");
  await rejected(jwt, 403, { path: "/edit" });
  await rejected(jwt, 403, { path: "/edit/preview/local/video/metadata.json" });
  await rejected(jwt, 403, { method: "POST" });
  await rejected(await token({ email: undefined, common_name: "other-client.access" }), 403);
  await rejected(await token({ common_name: env.ACCESS_SERVICE_CLIENT_ID }), 403);
});

test("JWKS reads are bounded, cached and fail closed on an outage", async () => {
  let calls = 0;
  const fetchKeys = async url => { calls++; return fetcher(url); };
  const jwt = await token();
  await authorizeRequest(request(jwt), env, { now, fetcher: fetchKeys });
  await authorizeRequest(request(jwt), env, { now, fetcher: fetchKeys });
  assert.equal(calls, 1);
  clearPublicKeyCache();
  await assert.rejects(authorizeRequest(request(jwt), env, { now, fetcher: async () => new Response("x".repeat(128001)) }), error => error.status === 503);
  await assert.rejects(authorizeRequest(request(jwt), env, { now, fetcher: async () => { throw new Error("private upstream information"); } }), error => error.status === 503 && !error.message.includes("private"));
});

test("key rotation is fetched from the fixed issuer without trusting token URLs", async () => {
  let calls = 0;
  const rotate = async () => { calls++; return Response.json({ keys: [{ ...publicKey, kid: calls === 1 ? "test-key" : "rotated-key" }] }); };
  await authorizeRequest(request(await token()), env, { now, fetcher: rotate });
  await authorizeRequest(request(await token({}, { kid: "rotated-key" })), env, { now: now + 31_000, fetcher: rotate });
  assert.equal(calls, 2);
});

test("signing-key requests use Workers-compatible redirect handling and never follow redirects", async () => {
  const jwt = await token();
  const workerFetch = async (url, init) => {
    if (init.redirect === "error") throw new TypeError("Workers does not implement redirect error mode");
    assert.equal(init.redirect, "manual");
    return fetcher(url);
  };
  assert.equal((await authorizeRequest(request(jwt), env, { now, fetcher: workerFetch })).kind, "owner");
  clearPublicKeyCache();
  let calls = 0;
  await assert.rejects(authorizeRequest(request(jwt), env, { now, fetcher: async (url, init) => {
    calls++;
    assert.equal(url, "https://aida-test.cloudflareaccess.com/cdn-cgi/access/certs");
    assert.equal(init.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://attacker.invalid/keys" } });
  } }), error => error.status === 503);
  assert.equal(calls, 1);
});
