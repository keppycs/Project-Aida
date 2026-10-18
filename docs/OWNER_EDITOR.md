# Owner editor

The owner edits at `https://keppy.dev/edit?v=ID`. Uploading and genuine 120 fps
transcoding stay in local Studio. The live editor can save a private draft,
publish text/visibility changes, and choose an SDR thumbnail from an image or
an existing video frame. A draft does not change the public video.

## Authentication

Protect `/edit` and all its child paths with one Cloudflare Access application.
Use an **Allow** policy containing the exact owner's email and email-code login.
Selecting the OTP login method alone is not an email allowlist. Use a separate
**Service Auth** policy for the local uploader's service token.

The Worker independently verifies the Access JWT signature, issuer, audience,
expiry, and owner email. The service identity can use `/edit/api/` only; it cannot
open the editor or private browser previews. Browser writes also require the
site's exact Origin, JSON, and `X-Aida-Editor: 1`.

Required Worker configuration:

| Name | Value |
| --- | --- |
| `SITE_ORIGIN` | `https://keppy.dev` |
| `ACCESS_TEAM_DOMAIN` | Existing `TEAM.cloudflareaccess.com` hostname |
| `ACCESS_AUD` | This Access application's audience |
| `OWNER_EMAIL` | Exact approved owner email |
| `ACCESS_SERVICE_CLIENT_ID` | Dedicated local Studio service identity |
| `B2_BUCKET_ID` | ProjectAida's bucket ID |
| `B2_KEY_ID`, `B2_SECRET_KEY` | Encrypted secrets for a ProjectAida-only writer key |
| `LIBRARY` | SQLite Durable Object binding, class `AidaLibrary` |

The B2 key needs `readFiles`, `writeFiles`, and `listFiles`, restricted to
ProjectAida with no filename prefix. The implementation does not delete B2
versions. Keep credentials out of source, generated browser assets, and logs.
If reviewed legacy videos have no visibility field, configure the same explicit
`LEGACY_VISIBILITY` mapping as the existing CDN; otherwise the editor defaults
unknown visibility to private.

## Build and check

Run from the repository root with Node:

```text
node scripts/build-admin-assets.mjs
node --test tests/admin-auth.test.mjs tests/admin-assets.test.mjs tests/admin-b2.test.mjs tests/admin-library.test.mjs tests/admin-worker.test.mjs
```

The asset build includes named application code and icons only. It does not
include `.env`, local videos, local metadata, source recordings, or credentials.
`edge/wrangler.admin.toml` describes the separate `aida-owner-editor` Worker and
its `new_sqlite_classes = ["AidaLibrary"]` migration. Use the Worker route
`keppy.dev/edit*`: [route matching includes query strings](https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior),
so an exact `/edit` route would miss `/edit?v=ID`. The Worker accepts only
`/edit` and `/edit/...`; lookalike prefixes such as `/editor` return 404.
The Access application remains `keppy.dev/edit`, protecting that path and its
children. Keep `workers_dev` and preview URLs disabled. Existing public
playback routes stay separate.

## Cutover

1. Pause older Studio/uploader processes. Back up the project `.env` before
   changing it; preserve its existing B2 upload credentials.
2. Create the email allowlist, dedicated machine credential, and bucket-scoped
   B2 key. Deploy the new Worker with its SQLite binding and encrypted secrets.
   Establish Access protection before making the editor routes reachable.
3. Set these in the project's `.env` or the launching process environment:

   ```dotenv
   AIDA_ADMIN_URL=https://keppy.dev/edit/api
   AIDA_ACCESS_CLIENT_ID=<dedicated service client ID>
   AIDA_ACCESS_CLIENT_SECRET=<dedicated service secret>
   ```

   Process values take precedence. Partial configuration fails closed. The
   project file is read directly, independently of B2/keyring loading, so a
   double-clicked launcher uses the same gateway.
4. Restart local Studio. Check authenticated reads, a private draft, a conflicting
   save, and private preview access before changing a public video. Verify that
   anonymous requests cannot read editor assets, APIs, metadata, or media.
5. Configure every other local/CLI publisher before resuming it. New large media
   uploads go directly to B2 only after reserving a fresh ID centrally; metadata,
   thumbnails, and the public index are finalized through the shared writer.

Central mode rejects direct bulk-index and bulk-sync publication. Older binaries
and anyone holding a direct B2 write key can bypass this coordination; stop or
upgrade those writers during cutover.

## Recovery and rollback

One Durable Object serializes mutations and persists operation IDs, drafts, and
publication journals. Retrying the same operation resumes it rather than
starting another publication. Conflicting remote changes retain the owner's
draft for review. Reads and private playback do not wait on its mutation queue.

Keep the Durable Object namespace and its data when rolling back a Worker
version. Keep central configuration enabled: removing it returns a local client
to legacy direct-B2 mode. Pause writers until a compatible gateway is restored.
Local drafts and upload reservations remain in each video's backed-up editor
state; B2 versions and reversible `.agent-trash` backups remain available.

The service checks declared 120 fps manifests on finalization. Actual decoded
frame-rate validation remains the local pipeline's responsibility. Choosing an
SDR still changes only thumbnail selection; video HDR and 120 fps sources remain
intact.
