# Project Aida instructions

## Aida design and interaction rules

Read [Aida design and interaction rules](docs/AIDA_DESIGN.md) before changing the site, player or Studio UI. It defines Aida's yellow accent (`#e8ff47`), visible focus without rings, transparent tap highlights, 44px touch targets, native scrolling, Settings motion, Smooth Pause and required verification.

Keep the browser checks and screenshot/demo approval requirements in that document when changing player UI.

## Credential and publication safety

Follow [Aida security guidance](docs/SECURITY.md). Run `node scripts/scan-secrets.mjs --staged` before committing and `--history` when reviewing repository exposure. Never commit local credentials, logs, recovery trash, saved reference pages or personal editor state. Keep secret reports redacted and stage the public site only through `scripts/stage-public-site.mjs`.

## Video preference: 120 fps

120 fps is the owner's preferred target for Aida. Lower frame rates and compatibility fallbacks are valid options when appropriate; describe source rates and client limitations accurately.

- Prefer preserving source motion, with resolution, bitrate, 4K and HDR choices guided by bandwidth, processing capacity and playback compatibility.
- Never duplicate lower-frame-rate frames or relabel metadata to claim genuine 120 fps motion.
- Lower-frame-rate videos are also available on the owner's YouTube channel. YouTube links use `https://www.youtube.com/watch?v=VIDEO_ID`, with the same video ID used by Aida's `/watch?v=VIDEO_ID` links.
- Distinguish product preferences from current pipeline capabilities and validation. Documentation changes alone do not add support for another source rate or rendition.
