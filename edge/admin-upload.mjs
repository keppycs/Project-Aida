/** Exact-object, five-minute S3 PUT grants. Never expose the storage secret. */
const HOST = "s3.eu-central-003.backblazeb2.com";
const REGION = "eu-central-003";
const BUCKET = "ProjectAida";
const MEDIA = /^(?:AV1|HEVC)\/(?:manifest\.mpd|master\.m3u8|media_[0-9]+\.m3u8|init_[0-9]+\.mp4|chunk_[0-9]+_[0-9]+\.fmp4)$/;
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
const escape = value => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
async function hash(value) { return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value))); }
async function hmac(key, value) {
  const imported = await crypto.subtle.importKey("raw", typeof key === "string" ? encoder.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, encoder.encode(value));
}

export function createUploadSigner(env, { now = Date.now } = {}) {
  return async ({ videoId, files, expiresIn = 300 }) => {
    if (typeof videoId !== "string" || videoId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(videoId) || /\s/.test(videoId) || !Array.isArray(files) || !files.length || files.length > 64 || expiresIn !== 300 ||
        typeof env.B2_KEY_ID !== "string" || !/^[A-Za-z0-9]+$/.test(env.B2_KEY_ID) || /\s/.test(env.B2_KEY_ID) || typeof env.B2_SECRET_KEY !== "string" || !env.B2_SECRET_KEY) throw new Error("Invalid upload signing request.");
    const time = now(), date = new Date(time).toISOString().replace(/[:-]|\.\d{3}/g, ""), day = date.slice(0, 8);
    const scope = `${day}/${REGION}/s3/aws4_request`;
    const signingKey = await hmac(await hmac(await hmac(await hmac(`AWS4${env.B2_SECRET_KEY}`, day), REGION), "s3"), "aws4_request");
    const expires_at = new Date(time + expiresIn * 1000).toISOString();
    const grants = [];
    const seen = new Set();
    for (const file of files) {
      const type = file.path?.endsWith(".mpd") ? "application/dash+xml" : file.path?.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4";
      const limit = /\.(mpd|m3u8)$/.test(file.path || "") ? 512 * 1024 : /\/init_[0-9]+\.mp4$/.test(file.path || "") ? 32 * 1024 * 1024 : 512 * 1024 * 1024;
      if (typeof file.path !== "string" || /\s/.test(file.path) || !MEDIA.test(file.path) || seen.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > limit ||
          typeof file.sha256 !== "string" || file.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.md5 !== "string" || file.md5.length !== 24 || !/^[A-Za-z0-9+/]{22}==$/.test(file.md5) || btoa(atob(file.md5)) !== file.md5 || file.content_type !== type) throw new Error("Invalid upload asset.");
      seen.add(file.path);
      const path = `/${BUCKET}/${videoId}/${file.path}`.split("/").map(escape).join("/");
      const headers = { "Content-Length": String(file.size), "Content-MD5": file.md5, "Content-Type": type, "X-Amz-Content-Sha256": file.sha256 };
      const signedHeaders = "content-length;content-md5;content-type;host;x-amz-content-sha256";
      const query = Object.entries({ "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": `${env.B2_KEY_ID}/${scope}`, "X-Amz-Date": date,
        "X-Amz-Expires": String(expiresIn), "X-Amz-SignedHeaders": signedHeaders }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${escape(key)}=${escape(value)}`).join("&");
      const canonicalHeaders = `content-length:${file.size}\ncontent-md5:${file.md5}\ncontent-type:${type}\nhost:${HOST}\nx-amz-content-sha256:${file.sha256}\n`;
      // Query authentication uses this S3 marker. Backblaze enforces Content-MD5;
      // its S3 endpoint does not validate the signed SHA256 header itself.
      const canonical = ["PUT", path, query, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
      const signature = hex(await hmac(signingKey, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${await hash(canonical)}`));
      grants.push({ path: file.path, url: `https://${HOST}${path}?${query}&X-Amz-Signature=${signature}`, headers });
    }
    return { expires_at, grants };
  };
}
