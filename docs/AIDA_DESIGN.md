# Aida design and interaction rules

These rules apply to Aida's website, standalone video player and Studio. The video and its controls are the main content; supporting UI stays readable, responsive and stable.

## Color and typography

- Keep Aida's loud yellow accent: `#e8ff47`, with `#b8cc2a` for the dim variant and `#f0ff85` for hover, across the site and player. Neutral surfaces do not require a muted accent.
- Use neutral surfaces, system fonts and relative text sizes. Preserve readability and control access with enlarged text on desktop and mobile.
- Use semantic controls, clear accessible names and visible state feedback. Do not convey state only through color.
- Interactive targets must be at least 44px. Visible icons can be smaller inside a stable target.
- Put hover effects inside `@media (hover: hover) and (pointer: fine)` so touch browsers cannot latch hover styling.

## Keyboard focus and touch feedback

- Never use an outline, focus ring, perimeter glow, or border-like interaction highlight on any UI element, including buttons, links, fields, sliders, menus, and players. This includes native browser outlines and CSS outlines, ring-shaped shadows, and pseudo-element imitations for pointer, keyboard, programmatic, or restored focus.
- Never show the browser's native touch/tap highlight flash, blue or otherwise. Set `-webkit-tap-highlight-color: transparent` across the shared web surface and standalone player tree, including custom controls, inputs, media, overlays and nested icon/text hit targets; a button/link-only reset is insufficient. Preserve intentional control feedback, native scrolling, text selection and touch gestures. Do not use blur, removed focusability or cancelled input as a workaround.
- Keep keyboard focus clearly visible with geometry-stable changes to a control's background/fill, text, or icon. Preserve keyboard navigation, focusability, and shortcuts; do not blur elements or hide all focus feedback.
- Generic accessibility guidance does not authorize an outline or ring exception. Check shared focus styles and native defaults so they cannot reintroduce the rejected treatment. Intentional static borders and icon artwork are not focus indicators and must not be repurposed as a ring workaround.
- The player container may receive focus for shortcuts, but must not highlight the whole video. Apply non-outline feedback to the actual controls.

## Native scrolling and stable controls

- Preserve native page/container scrolling, wheel, touch momentum, keyboard navigation, focus scrolling and `scrollIntoView`.
- Scrollbar chrome must be a zero-space, thumb-only overlay on the actual scroll container. Hide space-consuming native scrollbar chrome and use a custom overlay thumb where needed; dragging it maps directly to that container's native scroll range. Never simulate content scrolling or reserve a gutter, compensation padding, empty matching lane, track or background strip.
- Rows and their hover/focus fills retain the full intended width, with equal existing side spacing; overflow, thumb visibility and scroll locking must not change content or control geometry. Hide the thumb when there is no scroll travel, preserve accessible scroll access, and prevent thumb drags from activating adjacent controls or sheet dismissal.
- Press and focus feedback must not change a control's position, dimensions or touch target. Keep labels and adjacent controls stationary.
- Search, clearing, loading, retry completion and overlays must not change horizontal control geometry or reclaim focus/scroll after the user moves it elsewhere.
- Loading, empty and error states keep recovery actions reachable. Failed edits retain the user's input and provide a clear retry path.

## Player Settings and motion

- Settings page motion must not animate layout properties such as height, width, top, or padding every frame. Measure the endpoints once, then use clipped transforms and opacity without scaling live text or controls.
- Suspend hidden timeline DOM updates while Settings is open; keep video playback and the source's frame rate intact.
- A control pressed during motion must stay under the pointer until release. Interrupted navigation, cancelled gestures, closing and reopening must preserve the current painted pose and correct focus.
- Desktop Settings never dims the video. Mobile Settings uses a darker modal backdrop and a full-width sheet attached to the viewport bottom, with safe-area padding inside the surface. Preserve the sheet's native scrolling, drag dismissal, cancellation, interrupted motion and focus return.
- Keep the existing center play/pause icon painted when Settings opens, with the correct intended playback glyph. The mobile modal backdrop still owns input and focus; do not raise background transport controls above the sheet or make them actionable through it. Preserve desktop's existing brief feedback cue after playback starts.
- A deliberate downward touch swipe on the fullscreen picture exits fullscreen without changing playback or seeking. Exclude Settings, backdrop, sliders and utility buttons; preserve cancellation, multi-touch, other gesture directions, native page scrolling outside fullscreen and the existing fullscreen button/keyboard paths.
- Quality exposes codec and protocol choices in compact labeled rows above Resolution, without an Advanced playback heading or disclosure/dropdown. The phone Quality sheet fits its content and uses native scrolling within the visual viewport. Preserve 44px touch targets and avoid empty space from a forced minimum sheet height.
- A fresh Settings gesture must reopen a swipe-dismissed sheet during its exit without waiting for the animation; the dismissal gesture must never activate the underlying video or seek bar.
- Respect reduced motion within each component while preserving correct visibility, state, focus and interruption behavior. A global near-zero animation override is not an acceptable reduced-motion implementation.

## Studio tag menus

- The **Manage tags**, thumbnail frame picker and public **Tags & search tips** disclosures animate their full sections and following content on opening and closing. Measure flow endpoints once and use clipped transforms and opacity; keep the trigger stationary, preserve drafts on reversal and hold pressed controls in place until release. Cleanup confirmation fades in and out while retaining native dialog modality through its exit.
- Both shared-tag selectors animate opening and closing with clipped translation and opacity, without scaling text or animating layout sizes. Their triggers and surrounding fields stay stationary.
- Place the shared-tag editor directly beneath **Manage tags**, ahead of suggestions, so opening it reveals content beside the trigger on phones.
- Reversing a transition continues from its current painted pose. A closing menu stops accepting input immediately, remains painted through its exit and never takes focus back after the user moves elsewhere.
- Reduced motion uses a short fade without travel or clipping. Keep native scrolling, keyboard selection, visible focus and viewport fitting intact.

## Smooth Pause

- Smooth Pause is an optional, saved player setting, off by default. When enabled, play/pause eases playback speed and audio over 140 ms while retaining the selected speed, volume and mute settings.
- Its temporary speed/audio envelope must never overwrite the selected playback speed, volume, mute or saved preferences.
- Scrubbing, frame stepping, source changes and lifecycle cancellation must settle it immediately and prevent stale work from restarting playback.
- Smooth Pause changes transport presentation; it does not change the source's frame rate or video renditions.

## Verification and review

Run the relevant checks from the repository root with `node tests/<name>.browser.mjs`:

| Change | Required check and inspection |
| --- | --- |
| Player interaction or focus | `tests/player-focus.browser.mjs`: inspect focused desktop and mobile states, pointer activation, held native touch, keyboard shortcuts, menu dismissal and fullscreen return. Preserve transparent tap-highlight checks across the videos page, player and dynamic Settings content, plus visible non-outline keyboard focus checks when changing interaction styles. |
| Settings motion | `tests/player-settings-performance.browser.mjs`: preserve the traced layout-work budget, intermediate-frame checks and native touch interruption checks. A final screenshot or a fast desktop alone is not performance verification. Do not label emulation results as measured physical-phone FPS. |
| Mobile Settings sheet | `tests/player-sheet.browser.mjs`: verify native scrolling, drag dismissal, cancellation, interrupted motion and focus return. |
| Fullscreen gestures | `tests/player-fullscreen-gesture.browser.mjs`: verify the downward swipe in real fullscreen and preserve the excluded controls and cancellation paths. |
| Shared layout, scroll containers or videos page interactions | `tests/site-ux.browser.mjs`: verify zero-space thumb overlays in classic-scrollbar and overlay-scrollbar browser modes, native wheel/touch/keyboard scrolling, thumb dragging, overflow transitions, desktop/mobile widths, enlarged text and interactive recovery states. Keep the separate player focus and Settings performance checks. |
| Studio tag menus and inline disclosures | `tests/tag-menu-motion.browser.mjs` and `tests/disclosure-motion.browser.mjs`: sample intermediate opening/closing frames, reversals, held mouse/touch targets, focus, reduced motion and bounded layout work. Inspect their opening/closing filmstrips. Run `tests/admin-studio.browser.mjs --tag-system-only` for tag editing, native scrolling and enlarged-text regressions. |
| Smooth Pause | `node --test tests/smooth-pause.test.mjs` and `tests/player-smooth-pause.browser.mjs`: verify saved preferences, immediate scrubbing and stepping, cancellation and stale-work prevention. |

Before presenting player changes for review, run the player focus check and inspect desktop and mobile states. Show a screenshot or local demo and obtain the user's approval of player UI changes before committing or publishing them.
