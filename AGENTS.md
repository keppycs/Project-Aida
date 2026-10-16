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

## No interaction outlines, focus rings or native tap highlights

- Never use an outline, focus ring, perimeter glow, or border-like interaction highlight on any UI element, including buttons, links, fields, sliders, menus, and players. This includes native browser outlines and CSS outlines, ring-shaped shadows, and pseudo-element imitations for pointer, keyboard, programmatic, or restored focus.
- Never show the browser's native touch/tap highlight flash, blue or otherwise. Set `-webkit-tap-highlight-color: transparent` across the shared web surface and standalone player tree, including custom controls, inputs, media, overlays and nested icon/text hit targets; a button/link-only reset is insufficient. Preserve intentional control feedback, native scrolling, text selection and touch gestures. Do not use blur, removed focusability or cancelled input as a workaround.
- Keep keyboard focus clearly visible with geometry-stable changes to a control's background/fill, text, or icon. Preserve keyboard navigation, focusability, and shortcuts; do not blur elements or hide all focus feedback.
- Generic accessibility guidance does not authorize an outline or ring exception. Check shared focus styles and native defaults so they cannot reintroduce the rejected treatment. Intentional static borders and icon artwork are not focus indicators and must not be repurposed as a ring workaround.
- The player container may receive focus for shortcuts, but must not highlight the whole video. Apply non-outline feedback to the actual controls.
- Before presenting player changes for review, run `tests/player-focus.browser.mjs` and inspect focused desktop and mobile states. Include pointer activation, held native touch, keyboard shortcuts, menu dismissal, and fullscreen return. Preserve transparent tap-highlight checks across the videos page, player and dynamic Settings content alongside visible non-outline keyboard focus checks when changing interaction styles.
- Show a screenshot or local demo and obtain the user's approval of player UI changes before committing or publishing them.

## Player animation performance

- Settings page motion must not animate layout properties such as height, width, top, or padding every frame. Measure the endpoints once, then use clipped transforms and opacity without scaling live text or controls.
- Suspend hidden timeline DOM updates while Settings is open; keep video playback and its 120 fps source requirement intact.
- A control pressed during motion must stay under the pointer until release. Interrupted navigation, cancelled gestures, closing and reopening must preserve the current painted pose and correct focus.
- Run `tests/player-settings-performance.browser.mjs` when changing Settings motion. Preserve its traced layout-work budget, intermediate-frame checks and native touch interruption checks; a final screenshot or a fast desktop alone is not performance verification. Do not label emulation results as measured physical-phone FPS.
- Desktop Settings never dims the video. Mobile Settings uses a darker modal backdrop and a full-width sheet attached to the viewport bottom, with safe-area padding inside the surface. Preserve the sheet's native scrolling and verify drag dismissal, cancellation, interrupted motion and focus return with `tests/player-sheet.browser.mjs`.
- Keep the existing center play/pause icon painted when Settings opens, with the correct intended playback glyph. The mobile modal backdrop still owns input and focus; do not raise background transport controls above the sheet or make them actionable through it. Preserve desktop's existing brief feedback cue after playback starts.
- A deliberate downward touch swipe on the fullscreen picture exits fullscreen without changing playback or seeking. Exclude Settings, backdrop, sliders and utility buttons; preserve cancellation, multi-touch, other gesture directions, native page scrolling outside fullscreen and the existing fullscreen button/keyboard paths. Verify real fullscreen with `tests/player-fullscreen-gesture.browser.mjs`.
- Quality exposes codec and protocol choices in compact labeled rows above Resolution, without an Advanced playback heading or disclosure/dropdown. The phone Quality sheet fits its content and uses native scrolling within the visual viewport. Preserve 44px touch targets and avoid empty space from a forced minimum sheet height. A fresh Settings gesture must reopen a swipe-dismissed sheet during its exit without waiting for the animation; the dismissal gesture must never activate the underlying video or seek bar.
- Smooth Pause's temporary speed/audio envelope must never overwrite the selected playback speed, volume, mute or saved preferences. Scrubbing, frame stepping, source changes and lifecycle cancellation must settle it immediately and prevent stale work from restarting playback.

## Website interaction stability

- Preserve native page/container scrolling, wheel, touch momentum, keyboard navigation, focus scrolling and `scrollIntoView`. Scrollbar chrome must be a zero-space, thumb-only overlay on the actual scroll container. Hide space-consuming native scrollbar chrome and use a custom overlay thumb where needed; dragging it maps directly to that container's native scroll range. Never simulate content scrolling or reserve a gutter, compensation padding, empty matching lane, track or background strip. Rows and their hover/focus fills retain the full intended width, with equal existing side spacing; overflow, thumb visibility and scroll locking must not change content or control geometry. Hide the thumb when there is no scroll travel, preserve accessible scroll access, and prevent thumb drags from activating adjacent controls or sheet dismissal.
- Shared site controls use neutral surfaces, system fonts, 44px touch targets, relative text sizes, fine-pointer-only hover effects and scoped reduced motion. A global near-zero animation override is not an acceptable reduced-motion implementation.
- Search, clearing, loading, retry completion and overlays must not change horizontal control geometry or reclaim focus/scroll after the user moves it elsewhere.
- Run `tests/site-ux.browser.mjs` after changing shared layout, scroll containers or videos page interactions. Verify zero-space thumb overlays in classic-scrollbar and overlay-scrollbar browser modes, native wheel/touch/keyboard scrolling, thumb dragging, overflow transitions, desktop/mobile widths, enlarged text and interactive recovery states. Retain the separate player focus and Settings performance checks above.
