# 🎬 Project Aida

#### A modern, automated video transcoding + streaming pipeline with a lightweight web frontend.

Built with **Python 3.12**, **FFmpeg 8.1 Hoare**, and **Shaka Player 5.0.7**, Project Aida turns master videos into efficient, adaptive streaming formats and serves them on **[keppy.dev](https://keppy.dev "😳")** where I exclusively upload my 120 fps videos!

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
  - Cuda accelerated decoding and encoding
  - Scaling is done on CPU using zscale³

**Core Modules:**

- `main.py` → Entry point
- `config.py` → Configuration settings
- `manifest.py` → Manifest patching
- `thumbnail.py` → Thumbnail generation (SDR and HDR)
- `transcode.py` → FFmpeg command builder
- `upload.py` → Uploading to storage bucket

---

## 🌍 Web Frontend

Located in `/docs`, the frontend is minimal and fast:

- 🧭 **Home Page**
  - Hero section to showcase the latest video
  - Grid of other videos in chronological order from new → old
- 📺 **Watch Page**
  - DASH or HLS playback on all modern browsers
  - Adaptive bitrate streaming for auto quality
  - Toggles for DASH/HLS and AV1/HEVC as fallback⁴
- 🎨 **Styling**
  - Vanilla CSS with a clean, modern look⁵

Hosted through GitHub Pages.

---

## ⚙️ Configuration

- Central config in `config.py`
- Local overrides via `config_local.py`
- Tunable parameters:
  - Uploading to bucket
  - Delete local transcodes after upload
  - Use fast encoding settings for testing
  - Generate thumbnails
  - Like, every nvenc option ever :sob:⁶

---

## 📦 Tech Stack

- **Python 3.12**
- **FFmpeg 8.1**
- **Shaka Packager 5.0.7**
- Vanilla JS frontend

---

## 💡 Not a usage tutorial

Run: `py main.py -i "path to video" -id "video id" -desc "description" -tags "i,like,soft,cookies"` → get fully streamable output, which looks like:

- docs/debug/video id/
  - 📂 AV1
    - chunks_i_j.fmp4
    - init_i.mp4
    - manifest.mpd
    - master.m3u8
    - media_i.m3u8
  - 📂 H265
    - chunks_i_j.fmp4
    - init_i.mp4
    - manifest.mpd
    - master.m3u8
    - media_i.m3u8
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

¹ Hopefully :grin:
² Should be robust :shrug:
³ Nvidia's scaling looks ass man :sob:
⁴ This is for the nerds, really xd
⁵ In my oh so humble opinion :innocent:
⁶ This is mostly⁸ a lie.
⁷ Whenever I feel like it
⁸ I meant partially
