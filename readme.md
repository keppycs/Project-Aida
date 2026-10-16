# 🎬 Project Aida

#### My personal, semi-automated video transcoding + streaming pipeline with a lightweight web frontend.

Built with **Python 3.12**, **FFmpeg 8.1 Hoare**, and **Shaka Player 5.0.7**, Project Aida turns master videos into efficient, adaptive streaming formats and serves them on **[keppy.dev](https://keppy.dev "😳")** where I exclusively upload my 120 fps videos!

---

## 🎯 Core requirement: 120 fps

**120 fps is the point of Project Aida. Anything below 120 fps is not an acceptable video rendition or fallback.** This applies to VOD, future live streams, every resolution and bitrate tier, and both HDR and SDR versions.

- Resolution and bitrate may decrease to fit bandwidth or processing capacity; the 120 fps target stays fixed.
- 4K and HDR are desirable additions. They are secondary to preserving 120 fps.
- HDR-to-SDR tone-mapped versions must also remain at 120 fps.
- Codec, protocol, browser, or device limitations do not justify introducing 30 or 60 fps compatibility versions. Report a limitation when a client cannot sustain 120 fps.
- Preserve genuine source motion at 120 fps; duplicating lower-frame-rate frames or changing metadata does not satisfy this requirement.

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
  - All at 120 fps of course :smirk:
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

Project documentation lives in `docs/`. The three design references were copied from Evoke and retain their original product-specific wording. Aida's scope notes and [AGENTS.md](AGENTS.md) take precedence: the site and player keep their loud yellow accent (`#e8ff47`), not Evoke's mint palette.

- [Design language](docs/DESIGN_LANGUAGE.md)
- [UI design](docs/UI_DESIGN.md)
- [Behavior](docs/BEHAVIOR.md)

Project Aida's 120 fps requirement remains defined in [AGENTS.md](AGENTS.md).

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

The videos page and watch page share neutral surfaces, system fonts and native scrollbars with reserved gutters. Search filters the collection without removing the featured content above the search field, and the query stays in the URL. Local previews load the optional mobile debug console only with `&debug=1`.

Run `node tests/site-ux.browser.mjs` for shared UI changes. It checks real classic/overlay scrollbar modes, loading/search/empty/error states, short and long pages, player Settings overflow, enlarged text, touch targets and native scrolling. `AIDA_PLAYWRIGHT_MODULE`, `AIDA_BROWSER_EXECUTABLE` and `AIDA_REVIEW_DIR` can select the test runtime, browser and artifact directory. Keep `tests/player-focus.browser.mjs` and the player motion tests alongside this check.

### GitHub Pages

The static site is published from `web/` by [the Pages workflow](.github/workflows/pages.yml). The artifact contains the contents of `web/` at its root, preserving public URLs such as `/watch.html`, `/css/` and `/js/`. Local encodes in `web/local/` and saved pages in `web/youtube reference/` are excluded from the artifact. `docs/` is project documentation and is not part of the website artifact.

**Before publishing this directory reorganization**, change the repository's **Settings → Pages → Build and deployment → Source** to **GitHub Actions**. Branch publishing only supports the repository root or `/docs`; leaving it pointed at `/docs` would publish the design documents instead of the website. Then push to `main` or run **Deploy website to Pages** manually. Keep the existing `keppy.dev` custom domain in Pages settings. See [GitHub's custom-workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

### Shared-link thumbnails and embeds

`edge/share-worker.mjs` adds video-specific Open Graph and Twitter card metadata to the **initial HTML** of `/watch?v=VIDEO_ID` and `/watch.html?v=VIDEO_ID`. Chat crawlers can read the title, description and thumbnail without running the frontend's JavaScript. Existing watch links keep working.

GitHub Pages cannot generate different HTML for different `?v=` values. This feature therefore needs a **Cloudflare Worker Route in front of the existing site**, rather than just adding JavaScript meta tags. The website and video storage can stay where they are. Only the watch, embed, oEmbed and preview-image paths use the Worker; the CDN is unaffected. See [Cloudflare's route documentation](https://developers.cloudflare.com/workers/configuration/routing/routes/) and the [Open Graph specification](https://ogp.me/).

The Worker reads each video's `metadata.json` from the existing CDN. Public and unlisted videos get previews; private, missing and invalid metadata never supply a video's title, description or image. It revalidates metadata and sends `Cache-Control: no-store`. Receiving apps can still retain their own previously cached cards. These preview checks do not add authentication to the public storage bucket.

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

New encodes put descriptions in per-video metadata. For older videos, `py src/sync_catalog.py` previews description and catalogue changes. After reviewing the dry run, `py src/sync_catalog.py --apply --upload` applies and uploads those changes together, keeping previous local metadata in `.agent-trash/`. For local changes only, use `--apply`. The uploader sends only metadata changed during that run, so a separate upload run after a local-only apply will not republish those files. Videos whose metadata has no description get a short default description until synced.

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
