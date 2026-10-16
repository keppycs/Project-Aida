# Project Aida instructions

## Aida color identity

- Keep Aida's loud yellow accent: `#e8ff47`, with `#b8cc2a` for the dim variant and `#f0ff85` for hover, across the site and player.
- Neutral surfaces do not require a muted accent.

## Non-negotiable video requirement: 120 fps

120 fps is the central purpose of this project. Apply this requirement to implementation, documentation, recommendations, and performance tradeoffs.

- Every video rendition must meet the 120 fps target: VOD, future live streams, all resolution and bitrate tiers, HDR versions, SDR versions, and compatibility fallbacks.
- Resolution and bitrate may change to fit bandwidth or processing capacity. Do not reduce the frame rate below 120 fps.
- 4K and HDR are desirable additions, secondary to preserving 120 fps. An HDR-to-SDR tone-mapped rendition must still be 120 fps.
- Do not propose or add 30 or 60 fps fallbacks to work around codec, protocol, browser, device, or hardware limitations. State the limitation and seek a solution that preserves 120 fps.
- Do not silently lower the frame rate, duplicate lower-frame-rate frames, or relabel metadata to claim that the 120 fps requirement is satisfied.

These are product requirements, not a claim that the current pipeline already validates every input or output against them.

## No interaction outlines or focus rings

- Never use an outline, focus ring, perimeter glow, or border-like interaction highlight on any UI element, including buttons, links, fields, sliders, menus, and players. This includes native browser outlines and CSS outlines, ring-shaped shadows, and pseudo-element imitations for pointer, keyboard, programmatic, or restored focus.
- Keep keyboard focus clearly visible with geometry-stable changes to a control's background/fill, text, or icon. Preserve keyboard navigation, focusability, and shortcuts; do not blur elements or hide all focus feedback.
- Generic accessibility guidance does not authorize an outline or ring exception. Check shared focus styles and native defaults so they cannot reintroduce the rejected treatment. Intentional static borders and icon artwork are not focus indicators and must not be repurposed as a ring workaround.
- The player container may receive focus for shortcuts, but must not highlight the whole video. Apply non-outline feedback to the actual controls.
- Before presenting player changes for review, run `tests/player-focus.browser.mjs` and inspect focused desktop and mobile states. Include pointer activation, keyboard shortcuts, menu dismissal, and fullscreen return. Preserve these checks when changing focus behavior or shared focus styles.
- Show a screenshot or local demo and obtain the user's approval of player UI changes before committing or publishing them.

## Player animation performance

- Settings page motion must not animate layout properties such as height, width, top, or padding every frame. Measure the endpoints once, then use clipped transforms and opacity without scaling live text or controls.
- Suspend hidden timeline DOM updates while Settings is open; keep video playback and its 120 fps source requirement intact.
- A control pressed during motion must stay under the pointer until release. Interrupted navigation, cancelled gestures, closing and reopening must preserve the current painted pose and correct focus.
- Run `tests/player-settings-performance.browser.mjs` when changing Settings motion. Preserve its traced layout-work budget, intermediate-frame checks and native touch interruption checks; a final screenshot or a fast desktop alone is not performance verification. Do not label emulation results as measured physical-phone FPS.
- Desktop Settings never dims the video. Mobile Settings uses a darker modal backdrop and a full-width sheet attached to the viewport bottom, with safe-area padding inside the surface. Preserve the sheet's native scrolling and verify drag dismissal, cancellation, interrupted motion and focus return with `tests/player-sheet.browser.mjs`.
- Smooth Pause's temporary speed/audio envelope must never overwrite the selected playback speed, volume, mute or saved preferences. Scrubbing, frame stepping, source changes and lifecycle cancellation must settle it immediately and prevent stale work from restarting playback.

## Website interaction stability

- Preserve native page, wheel, touch and keyboard scrolling. Reserve scrollbar space on the root and each actual scrollable surface before overflow changes; use a native always-scroll fallback where stable gutters are unsupported. Do not hide scrollbars, replace them with JavaScript, or reserve gutters on clipped video/image wrappers.
- Shared site controls use neutral surfaces, system fonts, 44px touch targets, relative text sizes, fine-pointer-only hover effects and scoped reduced motion. A global near-zero animation override is not an acceptable reduced-motion implementation.
- Search, clearing, loading, retry completion and overlays must not change horizontal control geometry or reclaim focus/scroll after the user moves it elsewhere.
- Run `tests/site-ux.browser.mjs` after changing shared layout, scroll containers or library interactions. It must verify actual classic and overlay native scrollbar behavior, overflow transitions, desktop/mobile widths, enlarged text and interactive recovery states. Retain the separate player focus and Settings performance checks above.
