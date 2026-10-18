# Project Aida instructions

## Aida design and interaction rules

Read [Aida design and interaction rules](docs/AIDA_DESIGN.md) before changing the site, player or Studio UI. It defines Aida's yellow accent (`#e8ff47`), visible focus without rings, transparent tap highlights, 44px touch targets, native scrolling, Settings motion, Smooth Pause and required verification.

Keep the browser checks and screenshot/demo approval requirements in that document when changing player UI.

## Credential and publication safety

Follow [Aida security guidance](docs/SECURITY.md). Write documentation solely about Aida's own behavior and rules; do not import descriptions or specifications from other private projects. Review prose for private information as well as credentials, since a secret scanner cannot reliably recognize private project descriptions.

Before committing, stage only explicit intended file paths, review the complete staged diff and run `node scripts/scan-secrets.mjs --staged`. Review commit messages and tag annotations for private information too; the staged check cannot inspect a future commit message. Never commit local credentials, logs, recovery trash, saved reference pages or personal editor state.

Before any authorized push, ensure `.githooks` is the active hooks directory and allow the mandatory pre-push guard to check the outgoing commits, commit messages and tag annotations before transmission. Never bypass findings with `--no-verify`, hook or configuration overrides, baselines or suppressions. Resolve the finding before retrying. Keep recovery refs local and never use `--mirror` or `--all` pushes to publish them. A passing scan does not authorize a push or publication; those actions still require the user's explicit request.

Use `--history` for a forensic audit of all local refs and reflogs; it may report retained recovery material. CI uses `--published` to check the fetched `HEAD` ancestry. Keep secret reports redacted, never place credentials in logs or screenshots, and build public website artifacts only through `scripts/stage-public-site.mjs`. Ignored files are private local material and must not enter repository-directory archives or uploads; an authorized Git archive must contain only reviewed, approved tracked files.

## Video preference: 120 fps

120 fps is the owner's preferred target for Aida. Lower frame rates and compatibility fallbacks are valid options when appropriate; describe source rates and client limitations accurately.

- Prefer preserving source motion, with resolution, bitrate, 4K and HDR choices guided by bandwidth, processing capacity and playback compatibility.
- Never duplicate lower-frame-rate frames or relabel metadata to claim genuine 120 fps motion.
- Lower-frame-rate videos are also available on the owner's YouTube channel. YouTube links use `https://www.youtube.com/watch?v=VIDEO_ID`, with the same video ID used by Aida's `/watch?v=VIDEO_ID` links.
- Distinguish product preferences from current pipeline capabilities and validation. Documentation changes alone do not add support for another source rate or rendition.
