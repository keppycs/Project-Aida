# 🎬 Project Aida

#### My personal, semi-automated video transcoding + streaming pipeline with a lightweight web frontend.

Built with **Python 3.12**, **FFmpeg 8.1 Hoare**, and **Shaka Player 5.0.7**, Project Aida turns master videos into efficient, adaptive streaming formats and serves them on **[keppy.dev](https://keppy.dev "😳")** for my 120 fps uploads!

---

## 🎯 Preferred target: 120 fps

**120 fps is my preference for Project Aida.** Resolution, bitrate, HDR and compatibility choices can adapt to the source, bandwidth and playback device, including lower-frame-rate fallbacks where appropriate.

Lower-frame-rate videos are on my YouTube channel at `https://www.youtube.com/watch?v=VIDEO_ID`, using the same video ID as Aida's `/watch?v=VIDEO_ID` links.

Preserve genuine source motion and label frame rates accurately. Duplicating frames or changing metadata does not turn a lower-frame-rate source into genuine 120 fps video. This preference does not imply that every source rate or fallback is already supported by the current pipeline.

---

## ✨ Overview

Project Aida handles the full video workflow:

- 🎞️ **Transcoding**
  - High-quality AV1 and HEVC pipelines
- 📦 **Packaging**
  - DASH and HLS manifests
- ☁️ **Distribution**
  - Optional upload to cloud storage (e.g., B2)
- 🌐 **Playback**
  - Stream directly via [keppy.dev](https://keppy.dev "😳")

---

## 🧠 Pipeline Architecture

- **Input Video**
  - Supports both SDR and HDR
- **FFmpeg Wizardry**
  - Ladder: 2160p, 1440p, 1080p, 720p, 540p, 360p. (fuck 480p✌️)
  - Tuned for my preferred 120 fps uploads :smirk:
  - Manifest patching for broader and more robust compatibility
- **Upload / Hosting (optional)**
  - Backblaze B2 for storage
  - Cloudflare CDN for distribution
  - Free egress fees thanks to their Bandwidth Alliance :D
- **Web Player**
  - Shaka Player + clean UI and good UX¹

---

## 🎥 Transcoding System

The Python backend manages the full encoding flow:

- **Codec Handling**
  - AV1 / HEVC
  - HDR-aware (metadata properly handled²)
- **Segmentation**
  - Fixed-duration segments for streaming
- **Smart Detection**
  - Skips already encoded media
  - Reads source metadata via probing
- **Parallelization-Ready**
  - CUDA-accelerated decoding and encoding
  - Scaling is done on CPU using zscale³

**Core Modules** (under `src/`):

- `main.py` → Entry point
- `config.py` → Configuration settings
- `manifest.py` → Manifest patching
- `thumbnail.py` → Thumbnail generation (SDR and HDR)
- `transcode.py` → FFmpeg command builder
- `upload.py` → Uploading to storage bucket

---

## Project documentation

Project documentation lives in `docs/`. Aida's design rules cover its loud yellow accent (`#e8ff47`), controls, keyboard focus, scrolling and player interactions.

- [Aida design and interaction rules](docs/AIDA_DESIGN.md)
- [Credential safety, secret scanning and publication](docs/SECURITY.md)
- [Owner editor, login and deployment](docs/OWNER_EDITOR.md)

Contributor guidance and the 120 fps preference are defined in [AGENTS.md](AGENTS.md).

## 🌍 Web Frontend

Located in `/web`, the frontend is minimal and fast:

- 🧭 **Home Page**
  - Hero section to showcase the latest video
  - Grid of other videos in chronological order from new → old
- 📺 **Watch Page**
  - 120 fps DASH or HLS playback on compatible modern browsers
  - Adaptive bitrate streaming for auto quality
  - Toggles for DASH/HLS and AV1/HEVC as fallback⁴
- 🎨 **Styling**
  - Vanilla CSS with a clean, modern look⁵

**Local CMAF playback (not in git):** Encode output goes under `web/local/{video_id}/` (ignored by `.gitignore`). Serve `web/` as the document root, for example with `py -B -m http.server 8000 --directory web`, and open **`watch.html`** over HTTP. Video links on `keppy.dev` and `www.keppy.dev` use **`/watch?v=…`**, served by the existing Cloudflare route. Local and preview hosts use **`watch.html?v=…`** so file-based development servers keep working.

On the **production** host (`keppy.dev` / `www.keppy.dev` in `web/js/site-env.js`), playback always uses the **CDN**; `?local=` is ignored.

On **any other host** (localhost, LAN, preview), add **`&local=1`** to the watch URL (e.g. `watch.html?v=0&local=1`) to load **`./local/{id}`** CMAF instead of the CDN. A **LOCAL** badge appears when that folder is used. Favicons: **flushed** on the live site, **bug** off-live (`site-env.js`).

**Smooth Pause:** The player Settings menu has an optional, saved Smooth Pause switch, off by default. When enabled, play/pause eases playback speed and audio over 140 ms while retaining the selected speed, volume and mute settings. Scrubbing and comma/period frame stepping stay immediate. This changes transport presentation, not the source's frame rate or video renditions.

Player interaction checks live in `tests/player-*.browser.mjs`. Settings motion has a traced layout budget and native touch interruption checks in `tests/player-settings-performance.browser.mjs`; Smooth Pause has unit and browser checks. Use the local preview and review the UI before publishing.

The videos page and watch page share neutral surfaces, system fonts and native scrolling. Searching hides the featured video, and the query stays in the URL. **Back to videos** restores that query and the collection position within the same tab, yielding to newer input or scrolling. Local previews load the optional mobile debug console only with `&debug=1`.

Run `node tests/site-ux.browser.mjs` for shared UI changes. It checks real classic/overlay scrollbar modes, loading/search/empty/error states, short and long pages, player Settings overflow, enlarged text, touch targets and native scrolling. `AIDA_PLAYWRIGHT_MODULE`, `AIDA_BROWSER_EXECUTABLE` and `AIDA_REVIEW_DIR` can select the test runtime, browser and artifact directory. Keep `tests/player-focus.browser.mjs` and the player motion tests alongside this check.

### Local Studio

Install `requirements.txt`, run `launch.bat`, and open `http://127.0.0.1:8765`.
Video editor links use `http://127.0.0.1:8765/edit?v=ID`.
Studio uses Aida's yellow/dark design. **New upload** selects a source, creates
120 fps renditions and thumbnails, and can upload privately.

Returning to Studio or reconnecting restores the running job's real progress.
Each tab receives its own event feed. The local server retains current job state
and the latest 200 log messages per job in memory until a new job or server
restart; this is not persistent job history. New log output follows the bottom
only while you are already there, preserving manual reading and text selection.
During a disconnected status feed, job starts wait for reconnection while
unrelated browsing remains available.

**Videos** edits existing titles, descriptions, tags, visibility and thumbnails.
Choose an image or open the visual frame picker to scrub the existing video,
step through its 120 fps frames and preview the thumbnail before saving it.
An uploaded video uses the authenticated local preview; choosing its original
source file again is unnecessary. The picker saves an SDR still from the
decoded video without changing the video renditions.

Opening a video checks the central publisher when configured, including older
uploads without a saved editor state. A failed online check leaves local drafts
available.
**Save locally** keeps a draft on this PC; **Save to website** updates an
existing upload's details and changed thumbnail without resending its video.
A new local video still needs its first upload. **Refresh online** includes
private and unlisted uploads, and local previews keep storage credentials out
of the player. The owner editor and its deployment procedure are described in
[Owner editor](docs/OWNER_EDITOR.md), including deployment and live validation.

With central mode configured, the PC uses a 30-day Cloudflare Access service
token and needs no reusable B2 key. New uploads obtain five-minute grants for
exact media assets, bound to path, size, type, Content-MD5 and a SHA-256 header;
Access credentials stay with the publisher API. The gateway checks the bounded
DASH/HLS package, every declared video rendition's 120 fps rate and referenced
asset completeness before finalizing metadata, thumbnails and the catalogue.
This is package validation, not decoded-frame validation. Cloud refreshes and
revision checks detect stale forms; failed uploads keep a retryable draft. The
central writer serializes supported publishers, while older direct B2 writers
must be stopped or upgraded. Central mode rejects direct bulk publication.

Missing or invalid legacy visibility appears as **Visibility needs review**,
with no option preselected; publishing requires an explicit choice. New uploads
still default explicitly to Private. Watch pages now pin the published Shaka
5.0.7 script with SHA-384 integrity, and authenticated editor/preview pages use
restricted script and connection policies. See the owner-editor guide for the
remaining deployment and verification steps.

Changed local files are kept in `.agent-trash/` with restore instructions;
uploads preserve previous B2 versions. The optional archive-after-upload moves
local transcodes to that recoverable trash after upload verification. It does
not permanently reclaim their disk space. Uploads include only packaged video
assets, and publish metadata after media succeeds. Editor state is never sent
to B2. Studio stays bound to localhost, checks loopback hosts/origins and uses
a per-process session token for writes. Do not expose its port to the Internet.

Checks: `python -B -m unittest discover -s tests -p 'test_*.py'` and
`node tests/admin-studio.browser.mjs`. Browser checks use synthetic videos and
fake storage; they do not run FFmpeg or write to the real bucket.

### GitHub Pages

The static site is published from `web/` by [the Pages workflow](.github/workflows/pages.yml), after the secret scan succeeds. [Public asset staging](scripts/stage-public-site.mjs) copies only reviewed website files to the artifact root, preserving URLs such as `/watch.html`, `/css/` and `/js/`. Unexpected files and linked paths block staging. Local encodes in `web/local/`, saved pages in `web/youtube reference/` and project documentation in `docs/` are excluded.

**Before publishing this directory reorganization**, change the repository's **Settings → Pages → Build and deployment → Source** to **GitHub Actions**. Branch publishing only supports the repository root or `/docs`; leaving it pointed at `/docs` would publish the design documents instead of the website. Then push to `main` or run **Deploy website to Pages** manually. Keep the existing `keppy.dev` custom domain in Pages settings. See [GitHub's custom-workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

### Shared-link thumbnails and embeds

`edge/share-worker.mjs` adds video-specific Open Graph and Twitter card metadata to the **initial HTML** of `/watch?v=VIDEO_ID` and `/watch.html?v=VIDEO_ID`. Chat crawlers can read the title, thumbnail and a playback summary such as **`2160p120 • 10:02`** without running the frontend's JavaScript. The summary uses the highest published DASH video rendition across the declared AV1/HEVC codecs, that rendition's frame rate and the video's duration, floored to whole seconds like the player. It never treats source height as an encoded tier or inserts a generic tagline. If rendition or duration information is unavailable, description metadata is omitted. Visible video descriptions on the watch page remain unchanged. Existing watch links keep working.

GitHub Pages cannot generate different HTML for different `?v=` values. This feature therefore needs a **Cloudflare Worker Route in front of the existing site**, rather than just adding JavaScript meta tags. The website and video storage can stay where they are. Only the watch, embed, oEmbed and preview-image paths use the Worker; the CDN is unaffected. See [Cloudflare's route documentation](https://developers.cloudflare.com/workers/configuration/routing/routes/) and the [Open Graph specification](https://ogp.me/).

The Worker reads each video's `metadata.json` from the existing CDN. Public and unlisted videos get previews; private, missing and invalid metadata never supply a video's title, playback summary or image. Watch/embed summary lookups read only the declared codecs' bounded DASH manifests, alongside thumbnail discovery; image and oEmbed requests do not fetch manifests. It revalidates metadata and sends `Cache-Control: no-store`. Receiving apps can still retain their own previously cached cards. These preview checks alone do not protect direct media URLs; the separate CDN Worker below enforces video visibility against the private B2 origin.

New thumbnail runs also create **`thumbnail_share.jpg`**, an SDR still bounded by 1280×720 with its aspect ratio preserved. Uploads now set the correct image MIME types. The Worker prefers this JPEG, then tries existing SDR WebP thumbnails for older uploads. It serves the chosen image through `/preview-image?v=VIDEO_ID` with the correct MIME type, including when an older B2 object was uploaded as `application/octet-stream`. This image route also checks visibility. If all thumbnails are missing, the card still has text. Existing AVIF/WebP website thumbnails keep their current behavior.

Animated GIF/AVIF previews depend on the receiving app, so the social card uses a static JPEG. Browser support for animated image formats does not guarantee that a chat app animates link previews. The embed uses the **existing player and video streams**; this feature creates no video rendition or reduced-frame-rate fallback.

**Activate on Cloudflare:**

1. Keep the static site on GitHub Pages using the `web/` workflow above and deploy the Worker below. It supports both the original player-only watch page and the newer videos page layout. Run the updated local pipeline for future uploads. No push, upload or deployment happens when running the tests below.
2. In Cloudflare DNS, verify that the website's `keppy.dev` and `www` records are **Proxied** (orange cloud). This is separate from the `cdn.keppy.dev` record. Keep the existing GitHub Pages origin.
3. Create a JavaScript Worker named `aida-share-previews` and paste `edge/share-worker.mjs` into its editor. It has no npm dependencies or secrets. Deploy it, disable its public `workers.dev` URL, and add these Routes under **Settings → Domains & Routes** for the `keppy.dev` zone:
   - `keppy.dev/watch*`, `keppy.dev/embed*`, `keppy.dev/oembed*`, `keppy.dev/preview-image*`
   - `www.keppy.dev/watch*`, `www.keppy.dev/embed*`, `www.keppy.dev/oembed*`, `www.keppy.dev/preview-image*`
4. Alternatively, if you already use Wrangler, run `npx wrangler deploy --config edge/wrangler.toml` from the repository root to update the Worker code. The eight production routes are managed in the dashboard, with **Fail open (proceed)** selected deliberately for each. `routes` is omitted from the Wrangler config to preserve that dashboard configuration; add the routes above manually for a new deployment and verify the failure mode after recreating any route. Do not create a Worker Custom Domain over the site; this implementation uses Routes over its existing origin. See [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#types-of-routes).
5. Open a watch URL and inspect **View source**: `og:title` and `og:image` should already contain that video's values. Open the image URL directly to verify it is public. Then share the watch URL in a fresh message. A previously shared card may remain cached by the receiving app.

Deployment verified on **2026-10-15**: `aida-share-previews` is active on all eight routes above. The four existing GitHub Pages A records for the apex domain are now proxied; their IP addresses are unchanged. The `www` record was already proxied. Both the temporary `workers.dev` address and preview URLs are disabled. Routes use **Fail open (proceed)** so Worker errors or request limits fall through to the existing origin; watch playback remains available, while the new embed/image endpoints may return the origin's 404 until the Worker recovers. Live watch pages, images and embeds were checked, including requests using WhatsApp, Facebook and Twitter crawler headers. This checks the server responses; previously cached chat cards may still need refreshing.

**Existing videos:**

```powershell
# Create missing JPEGs from already-generated local SDR WebP stills; no video encode or upload.
py src/share_thumbnail.py web/local/VIDEO_ID
# Or process the local video directories:
py src/share_thumbnail.py --all
```

Upload the newly generated `thumbnail_share.jpg` to the corresponding video directory in B2 with `Content-Type: image/jpeg`; video segments do not need uploading again. Existing JPEGs are skipped. To regenerate one, add `--replace`: the previous JPEG is moved into `.agent-trash/` with a restoration manifest after conversion succeeds.

New encodes put descriptions in per-video metadata for the website. For older videos, `py src/sync_catalog.py` previews description and catalogue changes. After reviewing the dry run, `py src/sync_catalog.py --apply --upload` applies and uploads those changes together, keeping previous local metadata in `.agent-trash/`. For local changes only, use `--apply`. The uploader sends only metadata changed during that run, so a separate upload run after a local-only apply will not republish those files. Share previews use the playback summary instead of this written description.

The direct bulk upload commands above apply to legacy mode. In central mode,
save changes locally and publish reviewed videos through **Videos**; bulk
publication is rejected.

**Player embeds:** once the Worker is active, `/embed?v=VIDEO_ID` presents just the existing player without autoplay. For example:

```html
<iframe src="https://keppy.dev/embed?v=VIDEO_ID"
  title="Aida video" width="1280" height="720" style="border:0;max-width:100%"
  allow="fullscreen; picture-in-picture; encrypted-media" allowfullscreen></iframe>
```

Watch pages advertise a JSON [oEmbed](https://oembed.com/) endpoint at `/oembed?url=ENCODED_WATCH_URL&format=json`, including optional `maxwidth` / `maxheight` constraints. It returns iframe markup for public/unlisted videos and rejects other hosts or private videos. oEmbed consumers discover the player from the watch page; whether a messaging platform actually plays it inline is that platform's decision. There is no direct MP4 or alternative frame-rate encode added for social players.

**Local checks** (Node.js and Python built-in modules only):

```powershell
node --test tests/share-worker.test.mjs
py -B -m unittest discover -s tests -p 'test_share_*.py'
```

These checks use fixture metadata, fake HTTP responses and mocked FFmpeg. They do not contact Cloudflare/B2, generate real thumbnails, or verify a live chat app's cached card. Test the deployed URL separately after activation.

---

## ⚙️ Configuration

- Central config in `src/config.py`
- Local overrides via `src/config_local.py`
- Tunable parameters:
  - Uploading to bucket
  - Delete local transcodes after upload
  - Use fast encoding settings for testing
  - Generate thumbnails
  - Like, every nvenc option ever :sob:⁶

---

## 📦 Tech Stack

- **Python 3.12**
- **FFmpeg 8.1** (DASH + HLS packaging via the built-in muxer)
- **Shaka Player 5.0.7** (browser playback)
- Vanilla JS frontend

---

### Private storage and CDN visibility

`edge/cdn-worker.mjs` replaces the original unconditional B2 proxy on `cdn.keppy.dev`. It serves only the ProjectAida public catalogue and the pipeline's known metadata, thumbnail, DASH, HLS, init and segment filenames. Every video request, including HEAD and byte ranges, checks fresh origin metadata before returning any file. Public and unlisted videos remain playable; private, unknown and malformed visibility is denied. Private owner previews and editing belong to the separate authenticated owner Worker; see its [deployment guide](docs/OWNER_EDITOR.md). Local previews retain their existing private-video opt-in.

The B2 bucket stays **private**, with encryption enabled. The CDN needs a dedicated classic single-bucket application key restricted to ProjectAida with **readFiles** only, stored as encrypted `B2_KEY_ID` and `B2_SECRET_KEY` Worker secrets. Keep upload/maintenance credentials separate and remove bucket-administration capabilities they do not need. Do not expose the local transcoding admin.

Older uploads without visibility require an explicitly reviewed `LEGACY_VISIBILITY` Worker variable: a JSON object mapping their existing folder IDs to `public` or `unlisted`. Keep the actual deployment mapping out of Git. An explicit metadata visibility always takes precedence, so changing a reviewed legacy video to private denies it immediately on subsequent network requests. Unknown legacy uploads are denied; this avoids interpreting a missing field as public.

The CDN rebuilds catalogue titles/descriptions from current public metadata and omits private/unlisted entries even if the stored index is stale. Index-only tags and HDR thumbnail flags are preserved for authorized public entries. Each catalogue page checks up to 40 candidate videos, with four concurrent checks to fit the free Workers request budget. The site follows the response's exposed `Link: ...; rel="next"` header through `index.json?page=N`, including empty filtered pages. There is no overall 40-video limit; the origin index remains bounded to 1 MB.

All browser and outer CDN responses use `no-store`; the watch loader also bypasses old browser metadata caches. Internally, the Worker caches full init/segment responses up to 32 MiB for five minutes, checking fresh origin visibility before every cache lookup, including HEAD and byte ranges. Cache keys include current metadata content and its origin revision headers, so metadata changes invalidate cached media. Replacing a segment without changing metadata can leave that segment stale for up to five minutes. Metadata, catalogues, manifests and images are never cached internally. Media streams unchanged, preserving 120 fps, HEAD and byte ranges; no renditions are added or altered. Previously downloaded copies and responses already stored under the old one-year policy cannot be revoked.

Build a fresh self-contained CDN module with `node scripts/build-cdn-worker.mjs logs/cdn-worker-review.mjs` (choose a new output path for each build), then deploy that reviewed output to the existing CDN Worker, preserving its `cdn.keppy.dev` Custom Domain and keeping Workers Caching and preview URLs disabled. Disable the alternate `workers.dev` URL after verifying the custom domain. The visibility gate is part of the Worker itself, so every remaining entry point gets the same checks. Retain the previous deployed version as a rollback checkpoint; keep the previous key until the replacement passes live checks. Revoke an old key only after confirming no uploader or other service still uses it.

Connection hardening uses Full (strict), minimum TLS 1.2, and Always Use HTTPS. GitHub Pages currently presents a valid certificate for `keppy.dev` but not `www.keppy.dev`, so a Cloudflare redirect for `(http.host eq "www.keppy.dev")` must send requests to `concat("https://keppy.dev", http.request.uri.path)` with the query string preserved before strict origin verification is enabled. This preserves existing watch links.

Run `node --test tests/cdn-worker.test.mjs tests/loader.test.mjs tests/catalog.test.mjs tests/share-worker.test.mjs` before release. After deployment, verify public and unlisted 120 fps playback, cold/concurrent metadata requests, range/HEAD responses, private denials for every asset family, unsupported query/API/other-bucket denials, catalogue pagination and fresh fields, and the direct B2 origin's anonymous denial. Internal caching needs a deployed Custom Domain; dashboard previews do not exercise it. A successful mock test is not a live deployment check. Publishing the changed watch loader and catalogue client also requires deploying the updated `web/` artifact.

## 💡 Not a usage tutorial

From the repo root, run: `py src/main.py -i "path to video" -id "video id" -desc "description" -tags "i,like,soft,cookies"` → get fully streamable output, which looks like:

- web/local/{video_id}/
  - 📂 AV1 and 📂 HEVC — each folder has the same layout:
    - Segments `chunk_<rep>_<n>.fmp4`, init segments `init_<rep>.mp4`
    - `manifest.mpd`, `master.m3u8`, `media_<rep>.m3u8` (one media playlist per ladder rung)
  - 📄 metadata.json
  - 🌐 thumbnail_hdr.avif
  - 🌐 thumbnail_hdr_720p.avif
  - 🌐 thumbnail_sdr.webp
  - 🌐 thumbnail_sdr_720p.webp

---

## 🧪 Status

Actively⁷ working on it! Built for experimentation, optimization, and real-world usage.

---

## Additional notes

###### This readme was originally written by ChatGPT, and perfected⁸ by me :innocent:

- ¹ Hopefully :grin:
- ² Should be robust :shrug:
- ³ Nvidia's scaling looks ass man :sob:
- ⁴ This is for the nerds, really xd
- ⁵ In my oh so humble opinion :innocent:
- ⁶ This is mostly⁹ a lie.
- ⁷ Whenever I feel like it
- ⁸ Perfect in my eyes ;-;
- ⁹ I meant partially
