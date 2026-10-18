import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createUploadSigner } from '../edge/admin-upload.mjs';

// Fixed fake credentials only. This suite must never call an external service.
const env = { B2_KEY_ID: '001122334455', B2_SECRET_KEY: 'audit-fake-secret-key-never-real' };
const instant = 1_700_000_000_000;
const payload = Buffer.from('synthetic 120 fps media bytes\n');
const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('Real network is forbidden in signer tests.'); });
after(() => { assert.equal(fetchMock.mock.callCount(), 0); mock.restoreAll(); });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const md5 = bytes => createHash('md5').update(bytes).digest('base64');
const file = (extra = {}) => ({ path: 'AV1/chunk_0_1.fmp4', size: payload.length, sha256: sha(payload), md5: md5(payload), content_type: 'video/mp4', ...extra });
const makeSigner = (configuration = env) => createUploadSigner(configuration, { now: () => instant });
const escape = value => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

// Independently generated using botocore 1.43.114 S3SigV4QueryAuth, explicit
// Credentials, and a frozen clock. Only the final canonical payload line is
// adapted to Backblaze's live-confirmed UNSIGNED-PAYLOAD behavior. Botocore
// itself computes the headers, query, credential scope, and final HMAC. Both
// standard and provider-adapted generator/results are preserved in
// logs/security-audit-20261018/storage-offline-20261018-064500/.
const botocoreURL = 'https://s3.eu-central-003.backblazeb2.com/ProjectAida/fresh120/AV1/chunk_0_1.fmp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=001122334455%2F20231114%2Feu-central-003%2Fs3%2Faws4_request&X-Amz-Date=20231114T221320Z&X-Amz-Expires=300&X-Amz-SignedHeaders=content-length%3Bcontent-md5%3Bcontent-type%3Bhost%3Bx-amz-content-sha256&X-Amz-Signature=f72fd261d6652bca9d7b9805829030af79f19608645a4cccd7d20097e63434b9';

// Independent Node-crypto verifier models the checks relevant to these grants.
// Backblaze checks Content-MD5 against bytes, while its signed SHA256 header is
// authenticated but is not itself validated against the uploaded payload.
function verifyPut(grant, body, { headers: overrides = {}, method = 'PUT', url: changedURL } = {}) {
  const url = new URL(changedURL || grant.url), headers = new Headers({ ...grant.headers, ...overrides });
  const signed = url.searchParams.get('X-Amz-SignedHeaders').split(';');
  const query = [...url.searchParams].filter(([key]) => key !== 'X-Amz-Signature').map(([key, value]) => [escape(key), escape(value)]).sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0).map(pair => pair.join('=')).join('&');
  const canonicalHeaders = signed.map(name => `${name}:${String(name === 'host' ? url.host : headers.get(name) ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonical = [method, url.pathname, query, canonicalHeaders, signed.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const [, day, region, service, terminal] = url.searchParams.get('X-Amz-Credential').split('/');
  const key = hmac(hmac(hmac(hmac(`AWS4${env.B2_SECRET_KEY}`, day), region), service), terminal);
  const expected = hmac(key, `AWS4-HMAC-SHA256\n${url.searchParams.get('X-Amz-Date')}\n${day}/${region}/${service}/${terminal}\n${sha(canonical)}`).toString('hex');
  const received = url.searchParams.get('X-Amz-Signature');
  const signatureValid = /^[a-f0-9]{64}$/.test(received || '') && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
  const md5Valid = headers.get('Content-MD5') === md5(body), lengthValid = headers.get('Content-Length') === String(body.length);
  return { signatureValid, md5Valid, lengthValid, accepted: signatureValid && md5Valid && lengthValid };
}

test('PUT grant matches the independent botocore vector with Backblaze payload marker', async () => {
  const result = await makeSigner()({ videoId: 'fresh120', files: [file()], expiresIn: 300 });
  assert.equal(result.expires_at, '2023-11-14T22:18:20.000Z');
  assert.equal(result.grants.length, 1);
  assert.equal(result.grants[0].url, botocoreURL);
  assert.deepEqual(result.grants[0].headers, { 'Content-Length': '30', 'Content-MD5': 'yv2FPmxZb8r/0XWBfJKkmQ==', 'Content-Type': 'video/mp4', 'X-Amz-Content-Sha256': '1360703919d0cd9d149a75fdc7581aad74a030baa3d28885831354c0838465c4' });
  assert.deepEqual(verifyPut(result.grants[0], payload), { signatureValid: true, md5Valid: true, lengthValid: true, accepted: true });
  assert.equal(JSON.stringify(result).includes(env.B2_SECRET_KEY), false);
});

test('method, object, type, size and both checksum headers are authenticated; MD5 binds the body', async () => {
  const grant = (await makeSigner()({ videoId: 'fresh120', files: [file()] })).grants[0];
  const changed = Buffer.from(payload); changed[0] ^= 1;
  assert.deepEqual(verifyPut(grant, changed), { signatureValid: true, md5Valid: false, lengthValid: true, accepted: false }, 'An unchanged SHA256 header cannot replace the enforced Content-MD5 check');
  assert.equal(verifyPut(grant, payload, { method: 'GET' }).signatureValid, false);
  for (const headers of [{ 'Content-Type': 'image/jpeg' }, { 'Content-Length': '31' }, { 'Content-MD5': md5(changed) }, { 'X-Amz-Content-Sha256': sha(changed) }]) assert.equal(verifyPut(grant, payload, { headers }).signatureValid, false);
  for (const change of [url => { url.pathname = url.pathname.replace('fresh120', 'existing120'); }, url => { url.pathname = url.pathname.replace('chunk_0_1.fmp4', 'metadata.json'); }, url => { url.hostname = 'evil.invalid'; }, url => { url.searchParams.set('X-Amz-Expires', '600'); }]) {
    const url = new URL(grant.url); change(url);
    assert.equal(verifyPut(grant, payload, { url: url.href }).signatureValid, false);
  }
});

test('all supported rendition assets stay in the fixed bucket with exact MIME and five-minute expiry', async () => {
  const cases = [['AV1/manifest.mpd', 'application/dash+xml'], ['HEVC/master.m3u8', 'application/vnd.apple.mpegurl'], ['AV1/media_0.m3u8', 'application/vnd.apple.mpegurl'], ['HEVC/init_0.mp4', 'video/mp4'], ['AV1/chunk_12_345.fmp4', 'video/mp4']];
  const result = await makeSigner()({ videoId: 'fresh120', files: cases.map(([path, content_type]) => file({ path, content_type })) });
  assert.equal(Date.parse(result.expires_at) - instant, 300_000);
  result.grants.forEach((grant, index) => {
    const url = new URL(grant.url);
    assert.equal(url.origin, 'https://s3.eu-central-003.backblazeb2.com'); assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.hash, '');
    assert.equal(url.pathname, `/ProjectAida/fresh120/${cases[index][0]}`); assert.equal(grant.path, cases[index][0]);
    assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
    assert.equal(url.searchParams.get('X-Amz-Credential'), `${env.B2_KEY_ID}/20231114/eu-central-003/s3/aws4_request`);
    assert.deepEqual(Object.keys(grant.headers).sort(), ['Content-Length', 'Content-MD5', 'Content-Type', 'X-Amz-Content-Sha256']);
    assert.equal(grant.headers['Content-Type'], cases[index][1]); assert.equal(verifyPut(grant, payload).accepted, true);
  });
});

test('signer rejects paths and IDs that could broaden an object grant', async () => {
  const signer = makeSigner();
  for (const videoId of ['', '../existing120', 'fresh120/other', 'fresh120?x', 'fresh120\n', 'fresh120\r', 'a'.repeat(129), 123, ['fresh120']]) await assert.rejects(() => signer({ videoId, files: [file()] }), `ID ${JSON.stringify(videoId)}`);
  for (const path of ['index.json', 'metadata.json', 'thumbnail_sdr.webp', '.aida-editor/drafts/fresh120/image', '../AV1/chunk_0_1.fmp4', 'AV1/../../index.json', 'AV1/manifest.mpd?x', 'AV1/%2e%2e/init_0.mp4', 'AV1/manifest.mpd\n', 'av1/manifest.mpd', '//evil.invalid/object']) await assert.rejects(() => signer({ videoId: 'fresh120', files: [file({ path })] }), path);
});

test('signer fails closed on malformed checksums, bounds, duplicates, credentials and expiry', async () => {
  const signer = makeSigner();
  const invalid = [file({ size: 0 }), file({ size: 1.5 }), file({ size: 512 * 1024 * 1024 + 1 }), file({ sha256: 'A'.repeat(64) }), file({ sha256: sha(payload) + '\n' }), file({ md5: undefined }), file({ md5: 'A'.repeat(21) + 'B==' }), file({ md5: md5(payload) + '\n' }), file({ content_type: 'application/octet-stream' }), file({ path: 'AV1/manifest.mpd', content_type: 'application/dash+xml', size: 512 * 1024 + 1 }), file({ path: 'HEVC/init_0.mp4', size: 32 * 1024 * 1024 + 1 })];
  for (const value of invalid) await assert.rejects(() => signer({ videoId: 'fresh120', files: [value] }), JSON.stringify(value));
  for (const files of [[], Array.from({ length: 65 }, (_, index) => file({ path: `AV1/chunk_0_${index}.fmp4` })), [file(), file()]]) await assert.rejects(() => signer({ videoId: 'fresh120', files }));
  for (const expiresIn of [0, 1, 301, '300', null]) await assert.rejects(() => signer({ videoId: 'fresh120', files: [file()], expiresIn }));
  for (const configuration of [{ ...env, B2_KEY_ID: 'fake\n' }, { ...env, B2_SECRET_KEY: '' }, { B2_KEY_ID: env.B2_KEY_ID }]) await assert.rejects(() => makeSigner(configuration)({ videoId: 'fresh120', files: [file()] }));
});
