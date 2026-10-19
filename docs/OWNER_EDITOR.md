# Owner editor

The owner edits at `https://keppy.dev/edit?v=ID`. Uploading and genuine 120 fps
transcoding stay in local Studio. The live editor can save a private draft,
publish text/visibility changes, and choose an SDR thumbnail from an image or
an existing video frame. A draft does not change the public video.

When applying these changes, deploy both the Worker and static website, then
validate the live system. Local checks alone do not establish a completed rollout.

## Master tags and search

The tag picker searches existing master names and aliases. Pick a suggestion,
create a tag, or remove a selected tag. Common suggestions are ranked by the
number of videos using each tag; Aida does not collect viewer searches for this.

Each master tag has a stable ID, one display name and optional aliases. For
example, a `Counter-Strike 2` tag can have `CS2` as an alias. Edit the shared tag
definition once to update how all assigned videos are found. Renaming retains
the old name as an alias. Merging keeps old IDs pointing to the selected
destination; it does not combine different games automatically. Names and
aliases cannot belong to two different master tags. Older string tags remain
available without rewriting video files just to open the editor.

Shared tag saves are separate from video draft saves. With the central writer,
saving a master definition updates that shared registry immediately. Without
the central writer, local definitions reach the website during an explicit
video publication. Offline reads use the local cache; an unreachable central
writer never gets replaced by that cached copy. Stale tag edits require review.

The private bucket's `tags.json` is not a public endpoint. The CDN includes only
the definitions attached to each authorized video or public catalogue entry.
Deploy the updated owner editor, CDN Worker and website together for the full
feature. Building or testing these files does not publish them.

Public search combines words across titles, descriptions and tags. Quotes match
a phrase, `-word` excludes a matching term, and `tag:CS2` / `-tag:CS2` include or
exclude an exact master tag through its name or alias. Multiword tag values can
be quoted, such as `-tag:"Lethal Company"`. Case and common punctuation are
normalized; numbers, `+` and `#` remain meaningful. Date, frame-rate and HDR
operators are not implemented. A search hides the latest-video hero, and video
links preserve its query for **Back to videos**. Using that link or browser Back within the same tab
also restores the collection position after results load, unless you have
already interacted with the page. This uses one temporary tab-local handoff;
it does not collect search history. Direct video links without a query return
to the full collection.

Check the shared rules and synthetic UI flows with:

```text
node --test tests/tags.test.mjs tests/search.test.mjs
node tests/search.browser.mjs
node tests/admin-studio.browser.mjs --tag-system-only
```

## Authentication

Protect `/edit` and all its child paths with one Cloudflare Access application.
Use an **Allow** policy containing the exact owner's email and email-code login.
Selecting the OTP login method alone is not an email allowlist. Use a separate
**Service Auth** policy for the local uploader's service token, issued with a
30-day expiry. Renew it before it expires.

The Worker independently verifies the Access JWT signature, issuer, audience,
expiry, and owner email. The service identity can use `/edit/api/` only; it cannot
open the editor or `/edit/preview/` browser pages. Local Studio streams private
preview assets through the authenticated `/edit/api/media/ID/ASSET` alias, with
fixed asset names and byte ranges, so those reads also need no B2 key on the PC.
Browser writes require the site's exact Origin, JSON, and `X-Aida-Editor: 1`.

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
In central mode the PC needs only the `AIDA_ADMIN_URL` and Access service-token
settings below, with no reusable B2 key. Storage signing credentials stay in the
Worker's encrypted secrets. Access service headers go only to the publisher API;
they are never forwarded to B2.
Studio Settings shows **Connected through secure uploader** in this mode. The
raw B2 credential form and legacy bucket-maintenance controls stay hidden;
their credential-save and deduplication APIs reject central-mode requests.
Incomplete central configuration fails closed without falling back to keyring.

Missing or invalid stored visibility is `unknown`, with
`visibility_review_required: true`. The editor shows **Visibility needs review**,
selects no visibility option, and requires an explicit Private, Unlisted or Public
choice before saving to the website. A legacy CDN mapping, index membership or
old `unlisted` flag does not count as that choice. Existing explicit visibility
values keep their meaning; new uploads continue to start explicitly private.

Public and private watch pages pin the published Shaka Player 5.0.7
`shaka-player.compiled.js` file with SHA-384 Subresource Integrity and anonymous
CORS. The generated CDN `.min.js` alias is unsuitable for an immutable integrity
pin. The authenticated editor/preview CSP permits same-origin scripts plus that
exact vendor URL and same-origin connections, while retaining the embedded
preview's styles and blob media.

## Build and check

Run from the repository root with Node:

```text
node scripts/build-admin-assets.mjs
node --test tests/admin-auth.test.mjs tests/admin-assets.test.mjs tests/admin-b2.test.mjs tests/admin-package.test.mjs tests/admin-library.test.mjs tests/admin-upload.test.mjs tests/admin-worker.test.mjs
node tests/admin-security.browser.mjs
node tests/player-focus.browser.mjs
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

1. Pause older Studio/uploader processes. Back up project settings privately
   before changing them. Plan removal and rotation of the PC's old reusable B2
   credentials once the central path passes live checks.
2. Create the email allowlist, dedicated machine credential, and bucket-scoped
   B2 key held only by the Worker. Deploy the new Worker with its SQLite binding
   and encrypted secrets.
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
5. Configure every other local/CLI publisher before resuming it. New uploads
   reserve a fresh ID centrally, then request five-minute PUT grants for exact
   approved media assets. Each grant signs the object path, content length,
   content type, Content-MD5 and SHA-256 header. The PC verifies the file's size
   and both digests before streaming it to the exact B2 S3 endpoint. B2 enforces
   Content-MD5; the signed SHA-256 header is not an independent B2 body check.
   Expired grants are renewed through the publisher. Metadata, thumbnails and
   the public index are finalized only through the shared writer.

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

Finalization verifies the declared AV1/HEVC package before publishing metadata:
every DASH video rendition and HLS video variant must declare 120 fps, local
references and durations must agree, and every referenced init/media segment
must exist with a positive size. Unsupported or external references and
incomplete packages fail closed. Verification is bounded to 16 representations,
20,000 referenced files, 512 KiB per manifest/playlist, 4 MB total text, four
inventory pages and 24 storage requests. Packages exceeding those bounds need
review rather than partial acceptance.

These checks parse manifests and inventory; they do not decode every frame.
Genuine source motion and encoded-frame validation remain the local pipeline's
responsibility. Every rendition still requires 120 fps. Choosing an SDR still
changes only thumbnail selection; video HDR and 120 fps sources remain intact.
