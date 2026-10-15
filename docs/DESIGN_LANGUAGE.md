# Evoke v6 design language

Evoke is a **quiet creative tool inside a familiar LLM-app shell**. The sidebar makes ongoing work easy to find; the selected Roleplay, Story, Generate, or Iterate workspace receives the screen and behaves like a purpose-built tool. Chrome supports the work without competing with it.

This document defines the reusable visual and interaction grammar. `BEHAVIOR.md` owns feature behavior; `UI_DESIGN.md` owns mobile composition and motion contracts.

## 1. Character

1. **Work first.** Prose or generated imagery receives the strongest contrast and most space.
2. **Calm, not inert.** Motion explains origin, containment, and change without delaying input.
3. **Compact, not cramped.** Remove redundant containers and labels before reducing legibility or touch targets.
4. **Familiar shell, specific interiors.** Sidebar navigation may resemble an LLM application; each workspace keeps its own content format, including Iterate's image conversation.
5. **One visual grammar.** Buttons, fields, menus, progress, statuses, spacing, and focus behave consistently across all session types.
6. **State is explicit when it matters.** Routine successful autosaves are silent; Generating, Waiting, Disconnected, Off, Unavailable, Failed, and Needs attention differ in copy and presentation.
7. **User intent remains authoritative.** Styling and animation never rewrite text, move the caret unexpectedly, conceal failure, or hide a valid action.

### Anti-goals

- A generic dashboard of cards surrounding the actual work.
- Assistant/user message bubbles around Roleplay, Story, or Generate. Iterate alone uses an image-focused conversation.
- A gaming HUD, neon control panel, or permanent wall of provider diagnostics.
- Glass, gradients, particles, or canvas effects covering routine controls.
- Dense control walls that overwhelm a phone screen.
- Unstyled controls that clash with adjacent surfaces, or JavaScript imitations that discard reliable platform semantics.
- Press/focus movement, layout shifts, or animated geometry under a touch target.
- Different visual systems for the four session types.

## 2. Reference form factors

Evoke is phone-only. Design, inspect, and approve only the phone interface at:

| Checkpoint | Purpose                                 |
| ---------- | --------------------------------------- |
| 360 × 800  | Compact supported phone                 |
| 424 × 924  | Primary automated phone reference       |
| 430 × 932  | Large-phone composition                 |
| 844 × 390  | Phone landscape and keyboard-safe width |

Every action must work with touch and coarse-pointer targets. The sidebar, Lore, Story Tools, Settings, and inspectors remain drawers, sheets, or overlays throughout phone portrait, landscape, and keyboard states.

## 3. Foundations

### Spacing

Use a four-pixel scale. Prefer 4, 8, 12, 16, 20, 24, and 32 px. Establish hierarchy with typography, alignment, hairlines, and surface contrast before adding empty space.

### Shape

- Compact controls: 10–12 px radius.
- Menus and mobile sheets: 16–20 px radius where their outer edge is visible.
- Status pills: fully rounded only for short categorical metadata.
- Nested surfaces have less radius and contrast than their parent.
- The editor/manuscript is not placed inside a decorative card.

### Type

- Story and Roleplay prose use a readable system stack with a bounded measure; decorative display faces are not part of the chrome.
- Controls and metadata use the same highly legible system sans stack.
- Page/session titles stay short and never compete with the manuscript.
- Labels are short, sentence case, and sit next to the value they explain.
- Prefer one short label over an explanatory paragraph. Kickers and helper essays are not default chrome.
- Technical identifiers appear only as secondary repair/debug information.

### Color and elevation

- Dark is the design-first neutral palette. Light is a separately tuned neutral palette, not an automatic inversion; it preserves the same hierarchy with stronger ink, lighter hairlines, restrained elevation, and a darker mint accent.
- The user may follow the operating-system theme or explicitly choose Dark or Light in Settings. Browser chrome stays purple during the purple opening, then follows the resolved page theme when the populated page reveals.
- Accent communicates focus and primary intent without theatrical gradients.
- Type icons may distinguish Roleplay, Story, Generate, and Iterate, but type is also written or accessible by name.
- Success, warning, and danger colors always have text or icon meaning.
- Prefer hairlines and small surface shifts to deep shadows.
- Avoid purple/lilac/peach atmospheric treatments and ambient orbs in routine chrome.
- The launch-only surface uses Evoke purple (#171426), without a visible label or icon tile. Android holds the transparent symbol on its native purple splash until readiness, then fades both together over 120 ms. The PWA webpage uses a plain cover and a 220 ms reveal, with no second logo or icon entrance after Chrome’s manifest-generated splash; neither path holds back a ready page. Maskable launcher artwork is opaque purple edge-to-edge. See [UI_DESIGN.md](UI_DESIGN.md#5-startup-and-synchronization) and [ANDROID.md](ANDROID.md).
- Overlays create clear containment without turning the background into an opaque curtain. Image overlay buttons use translucent backgrounds and readable foregrounds, with fixed touch-target geometry. Full-size viewers use pinch-to-zoom and a single Fit control instead of zoom-in/out buttons. Fit sits in the top row beside Save (where available) and Close. Small previous/next chevrons sit at the screen edges inside fixed 44px targets. A tap outside the image closes the viewer; image taps and pan/pinch gestures do not. Writing-session image removal uses a trash icon at the top left of the open-image viewer and returns to the Gallery with in-place Undo.

### Product identity

| Attribute          | Evoke expression                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Personality        | Quiet, precise, private, creatively capable                                                           |
| Visual mood        | Neutral working surfaces, bounded reading measure, restrained mint intent                             |
| Type               | Highly legible system sans for chrome; the same readable system stack for prose                       |
| Shape              | 10–12 px compact controls; 16–20 px outer sheets; hairlines before shadows                            |
| Motion             | Calm continuity and containment; never decorative delay                                               |
| Distinctive motifs | Exact-text canvas, quiet Story reader, scoped tools, stable Roleplay dock, compact status signal                  |
| Forbidden habits   | Purple/lilac/peach atmosphere, ambient orbs, routine gradients/glass, chat bubbles, gaming HUD chrome |

### Width

- Compose forms (Generate request, new-session chooser, settings stacks) use a phone-width column sized for controls.
- Result grids and manuscripts may use more horizontal room when the content needs it.
- Do not stretch sparse form rows across the viewport.

## 4. Application frame

The application has two structural regions:

```text
┌─────────────────┬──────────────────────────────────────────┐
│ Session sidebar │ Selected purpose-built workspace         │
│                 │                                          │
│ New session     │ Roleplay editor                          │
│ Search          │ or Story manuscript                      │
│ Session list    │ or Generate workbench                    │
│                 │                                          │
│ Global settings │ Workspace-owned controls and dock        │
└─────────────────┴──────────────────────────────────────────┘
```

The sidebar owns **what work to open**. The selected workspace owns **how to do that work**. Neither duplicates the other's controls.

### Sidebar

- New session is the primary sidebar action.
- Search/filter remains available without displacing recent sessions.
- Session rows contain type, title, and only meaningful current status.
- A row has a stable height and pointer target; status updates never resize it.
- The active row is unmistakable without relying only on color.
- Rename/archive/remove actions live in a row menu, not as permanently visible icon clutter.
- One stable Settings destination remains near the sidebar edge/bottom. Defaults, Text, Speech, Images, and Appearance edit the same installation-wide settings on every paired device. New chats copy the current settings; their existing copies are not changed by later main settings edits.
- The sidebar is always a modal drawer; it never collapses into an icon rail.

### Mobile sidebar

The sidebar becomes a full-height drawer/sheet above the current workspace. Opening it does not unmount, reset, or scroll the workspace. Selecting a session closes it and restores focus meaningfully in the destination.

### Workspace header

Every session header identifies the current title and type and provides the phone session-drawer trigger. Story uses a quiet Stories/title/Tools row; Tools owns its session settings and supporting actions. Other sessions expose their settings/status directly without turning the header into an action toolbar.

Long-running Stop/Cancel remains reachable in the workspace even when the sidebar is closed. Rare, destructive, or configuration actions belong in menus/sheets.

## 5. Workspace grammar

### Roleplay

Roleplay uses three zones:

| Zone   | Owns                                                                          | Never owns                                       |
| ------ | ----------------------------------------------------------------------------- | ------------------------------------------------ |
| Header | Session identity, Lore, session settings, and routes to scoped media           | Text mutation controls                           |
| Canvas | The exact prose and its non-destructive contextual marks                       | Setup dashboards or unrelated status cards       |
| Dock   | Undo, Redo, Delete paragraph, options, and one primary Continue/Stop/Resume verb | Rare configuration and session lifecycle actions |

The Roleplay phone dock is one compact row. Its primary action morphs with state while Undo, Redo, Delete, and the options trigger retain fixed 44px targets. Read/Image actions and presentation settings live in the options sheet rather than forcing a second toolbar row.

### Story

Story opens as a continuous reader: a compact Stories/title/Tools header followed by exact chapter headings and prose. The manuscript has no decorative card, permanent action dock, paragraph-selection labels, chapter statistics, versions, or routine save/progress strip. Reading and scrolling do not enter edit mode or change the generation target.

Tools opens a bounded phone sheet with the current writing chapter and one primary generation action, then routes to Chapters, Edit & rewrite, Story setup, Images, and Settings & export. These focused surfaces share the existing theme tokens and control grammar. Setup's optional style, canon, and generation values use disclosures; editing makes its chapter and passage scope explicit. History, removal, reading, contextual images, export, and recovery remain reachable in the surface that owns them. The device-owned path prepares chapter structure locally without AI review or previewed rewrite. Fuller reviewed planning, rewrite previews, continuity decisions, and chapter versions appear only when supported by the active storage path.

The active Stop action remains reachable from the reader and relevant tool surfaces. Idle tools do not leave a toolbar behind. Opening, switching, or dismissing a tool preserves the mounted manuscript, reading position, structural selection, and exact creative drafts. Drafts persist as they change, including the interval before asynchronous saves commit; save failure retains the live input and a direct recovery action.

Stories opens the application session drawer, not a second project library. Each Story session still owns one project. Tool headers and actions keep fixed 44px targets, bodies scroll natively within the visual viewport, and keyboard/safe-area changes cannot hide the return or Stop control. Dark remains the reference appearance; System and Light use the same hierarchy through the shared semantic tokens.

### Generate

Generate uses the same header grammar but a workbench canvas:

- visual request and essential run controls in a sticky left compose rail (about 19–24rem);
- a results column that is always present: dashed empty state until a run, then the gallery;
- compact numbered steppers, unlabeled prompt, Generate batch, and toggle chips in the compose rail;
- variant cards with the prepared prompt and images filling the card, not a dashboard of nested result chrome;
- stack compose above results only on portrait/narrow viewports;
- meaningful staged progress near the work it affects;
- active image placeholders use a fixed dot grid with flowing noise-driven size and brightness, soft peak glow, and a stationary phase label; reduced motion shows a static field;
- result grid/gallery as the dominant content after generation begins;
- rerun/inspect/retain actions attached to the relevant run/result, not scattered globally.

### Iterate

Iterate uses an image conversation with a quiet starting-revision strip and a persistent bottom composer. Apply the shared dark/light palette, typography, control feedback, and 44px targets. Keep the primary Generate/Stop rectangle fixed through busy and cancellation states. Revision images reserve their aspect ratio; progress updates retain the existing controls and images. The timeline scrolls independently, including above an overlaid phone keyboard. Details uses the shared sheet grammar; image viewing uses the shared viewer motion and tools.

## 6. Controls

### Buttons

- One visually primary action per local decision area.
- Destructive actions are never styled like routine primary actions.
- Busy controls keep stable geometry and update label/state in place.
- Unavailable controls remain visible when the operation is conceptually valid; nearby copy explains why and how to recover.
- Icon-only buttons require accessible names and at least 44 × 44 CSS px coarse-pointer targets.

### Semantic control rendering

- Start with semantic HTML so keyboard, form, validation, and assistive-technology behavior remain dependable, but never ship an unstyled browser or operating-system control surface. Every visible field, choice, toggle, disclosure, and action receives an explicit Evoke presentation.
- When a native control exposes user-visible chrome that cannot be styled completely and consistently—such as an expanded `<select>` menu—use the shared custom-rendered control. Keep a semantic or form-compatible value source beneath it where useful; the browser's default surface must not leak through.
- Visible controls share Evoke's radius, spacing, typography, color, focus, invalid, busy, and disabled grammar. Focus treatment uses reserved geometry and one deliberate visual signal, never stacked browser and application rings.
- Shared custom implementations must cover keyboard, touch, focus return, disabled options, grouping, form submission, and overlay races before use.
- Scrollable surfaces are the exception: preserve ordinary native scrolling with stable geometry and restrained custom scrollbar styling where supported. A scrollbar appearing or disappearing must not move, resize, or rewrap neighboring controls.

### Fields

- Labels remain visible; placeholders provide examples, not identity.
- Validation appears beside the field and preserves the user's input.
- All four chat settings sheets edit independent copied values. No inheritance badges or profile gates appear. Model pickers remain editable; image-only chats label the picker Resolver model. The routing hint distinguishes selected-model Resolver and Roleplay/Story prose paths from server Gemma4 Generate Monolithic/Hybrid/Essential preparation.
- The sidebar Settings page edits Global defaults for future chats. Top-right settings edit only the current chat.
- Advanced technical values do not crowd the first-use path.

### Choice lists

- Every visible choice list uses the shared custom select/listbox so the trigger and expanded options follow the same Evoke grammar in every browser and operating system.
- Preserve form values, labels, groups, disabled choices, keyboard navigation, typeahead, touch selection, Escape/outside dismissal, and focus return in the shared implementation.
- Extend that shared component for search or rich rows rather than introducing a second one-off choice control.
- Number fields hide native spinner chrome. Compact numeric steppers may wrap a number field when stepping is the primary interaction.
- Hide native checkbox/radio chrome when a chip, toggle, or labeled control is the visible grammar.

### Boolean toggles

- Selected colour comes only from the actual checked, selected, pressed, or expanded state. Hover on an off toggle uses neutral feedback and cannot copy its selected appearance. Every application `:hover` rule belongs inside `@media (hover: hover) and (pointer: fine)` so touch browsers cannot latch hover styling after a tap.
- Non-editable controls use `:focus-visible` for keyboard focus, including the visible parent of a hidden checkbox. Focus must not imply selection. Dropdown triggers return to their closed appearance after touch selection while retaining semantic focus; never blur controls to hide focus feedback. Broad `:focus` styling is reserved for editable fields.
- Boolean settings and compose toggles may use shared **toggle chips**: visually hidden native input, chip surface, mint accent when on.
- A clearly labeled native checkbox is appropriate for ordinary independent options; use chips when the compact state treatment materially improves the composition.
- A single on/off choice may use a binary Off/On chip pair (Generate enhance pattern) when the label already names the setting.

### Disclosures and inline panels

- Expandable settings groups use semantic `<details>` and `<summary>` so keyboard and open-state behavior work without JavaScript.
- Summary rows match adjacent field triggers: 44px touch target, hairline border, muted label typography, chevron that rotates with state.
- Editor options may use an explicitly controlled popover when it must stay clear of the writing canvas. Roleplay uses Generation, Reading, Writing, and Style tabs with compact field rows. Content grows above a stationary tab/action bar; short pages shrink to fit. Hidden pages remain mounted to retain inputs. Tab changes animate content opacity and container height, handle interrupted transitions, and respect reduced motion; verify intermediate frames as well as settled layouts. Preserve rendering through the exit animation and make dismissed content inert immediately.
- Motion is optional progressive enhancement and must not be required for correct visibility, focus, or state.
- Disclosure bodies keep stable horizontal geometry; opening or closing them must not move neighboring labels sideways.

### Settings field grids

- Shared settings field grids place one label+control pair per full-width phone row. Never splice dynamic children into the parent grid via `display: contents` or unwrapped fragments.
- Model pickers, parameter groups, hints, and reasoning controls span the full grid width in dedicated blocks. Parameter inputs use an inner two-column subgrid.
- Story, Generate, and Iterate field inherited/overridden/cleared badges sit in a reserved label slot with fixed width. Inherited state hides the badge visually but keeps its geometry so labels and controls do not reflow when state changes. Roleplay fields omit these badges entirely and retain stable labels through autosave.
- Session settings show field-level state only; section cards do not duplicate aggregate section badges above the same fields.
- Binary toggles and chip rows inside a field grid span the full row width.
- Scrollable settings stacks are top-packed (`align-content: start`) and retain stable width when overflow exists. Closed disclosures cannot stretch grid rows.

### Menus, sheets, and dialogs

- Menus answer one bounded question and return focus to their opener.
- Mobile uses centered or bottom sheets sized for the virtual keyboard and safe areas.
- Escape, Done, and outside action close non-blocking overlays.
- A modal is reserved for a choice that truly blocks safe progress.
- Modal focus enters the surface, remains contained while open, and returns to the invoking control after close. Background regions are inert for the full open and exit lifecycle.
- Confirmation language names what will be retained, replaced, archived, or removed.

### Toasts

- Toasts report transient failures or conflicts; ordinary successful saves, reconnection, and application updates do not create one.
- Every timed toast includes a depleting duration bar, a 44px dismiss control, and horizontal touch-swipe dismissal.
- Tapping the toast body pauses its remaining timer and duration bar until explicit dismissal. Releasing the pointer, moving away, or tapping again does not restart the timer. Body taps never dismiss the toast or activate controls underneath; the close control and horizontal swipe remain available while paused.
- Toasts float in a centered lane below the session header, clear of header controls and permanent bottom action docks, and never reserve workspace layout height. Pointer/focus interaction pauses the timer so the message does not disappear during dismissal or inspection.

## 7. Stable interaction geometry

### Rule

**Pressable and focusable UI must not move.**

- Press/focus cannot change position, dimensions, spacing, transform, layout flow, or touch-target geometry.
- Do not add press/focus translation, scale, rotation, margin, padding, border width, or positional offset.
- Reserve borders in the resting state and change only color/opacity.
- Prefer text color, background, border color, underline, opacity, or shadow feedback.
- Keyboard focus may be prominent but must not change layout.

Verification compares `x`, `y`, `width`, and `height` before and during press/focus and checks neighboring content for movement.

## 8. Status and progress

Status copy describes the user's reality, not internal implementation:

- Routine creative autosave success is silent; failure copy names the mutation that was not saved.
- **Generating** with the meaningful current phase.
- **Waiting for image service** rather than generic Queued when resource arbitration is the cause.
- **Disconnected — editing paused** when authoritative writes are unavailable.
- **Needs attention** when the session has a recoverable decision/failure.
- **Off** as neutral configuration, never styled as failure.

Progress preserves completed units. It never rewinds visually because a later phase failed. Sidebar status remains compact; the workspace contains detail only when it enables a decision or recovery action. Roleplay has no separate continuation strip: Continue/Stop, accepted prose, and the compact header state provide sufficient visible feedback, with a hidden live announcement for assistive technology.

## 9. Motion

- Motion communicates continuity, origin, insertion, replacement, or containment.
- Image viewers expand from the tapped thumbnail and return to the current image's thumbnail over 320 ms with `cubic-bezier(0.38, 0.12, 0.17, 1)`. The backdrop fades independently while the image stays opaque; image proportions, surrounding layout, scroll position, and toolbar geometry remain stable. Interrupted entry closes from its current painted position. Keep the final thumbnail pose until the overlay is hidden, then reveal the source in the same frame. Animate corner rounding alongside the image's position and size from the first movement, reaching the thumbnail radius as it lands. A zoomed or panned image returns directly from its current displayed bounds without jumping back to Fit or changing size at the handoff. On normal close and Trash, keep date/time hidden during travel, then reveal it with a 180 ms fade and a subtle 3px rise; reduced motion omits this reveal motion. Missing or offscreen thumbnails use a fade; reduced motion omits image travel.
- Input immediately settles or interrupts nonessential motion.
- Animate primarily transform and opacity; continuously measured streaming geometry is updated directly when easing would lag behind content.
- Micro feedback uses 120–180 ms; ordinary surface changes use 180–320 ms. Entrances decelerate and exits accelerate. Structural width/height changes may animate when they materially explain a pane relationship.
- Toggle, select, button, and field feedback must transition between states while keeping their hit areas fixed. Preserve live control and image nodes during background updates so autosave cannot interrupt feedback, dismiss a dropdown, reset focus, or replay image entrances. Disclosures must reverse immediately from their current position when toggled again; collapsed contents are inert throughout the exit.
- Routine navigation is brief and restrained. Long theatrical transitions are forbidden.
- Reduced motion removes decorative travel and reveal pacing, retains a brief opacity cue when useful, and never changes final state, ordering, focus, or recoverability. Do not blanket-disable every animation and transition.
- No animation may steal focus, caret, selection, or manual scroll ownership.

## 10. Accessibility

- Use semantic controls and landmarks before visual enhancement.
- Every action is keyboard-operable with visible focus.
- Screen-reader names include the session type where visual icons would otherwise carry it.
- State is never conveyed only by color, animation, or location.
- Text contrast and OS-level text scaling remain valid without requiring page magnification. The fixed-scale app shell does not respond to pinch or double-tap zoom.
- Lists, workflows, models, voices, and sessions are searchable and keyboard navigable.
- Safe areas, virtual keyboards, IME composition, touch selection, and coarse-pointer targets are first-class behavior.

## 11. Effects

Canvas/WebGL effects are optional progressive enhancement. They may add restrained ambient identity, transition texture, or result delight. They cannot:

- participate in layout or hit testing;
- obscure prose or controls;
- become required feedback;
- consume attention during long writing;
- degrade typing, scrolling, keyboard latency, or battery/thermal behavior.

The normal interface remains complete when every effect layer is disabled.

### Writing-session image gallery

Roleplay's fixed 44px Images icon and Story's Images entry in Tools open the shared full-screen gallery with a session return control. The Story reader does not add a permanent gallery icon. Use newest-first masonry placement: scale each image to the column width, preserve its aspect ratio, and place the next image in the shortest column. Heights vary freely. A compact Columns stepper in the Gallery header selects 1–6 columns (default 3), saved on this device across Roleplay/Story galleries and reloads; keep the content centered within 1120px. Images have no footer or removal button. A subtle compact date and local time watermark sits inside the image at the bottom left, wrapping between date and time on narrow cards; its full timestamp remains in the accessible label/title. Open the image to use the top-left trash icon; the 44px control shares the viewer toolbar styling. Gallery cards do not display source paragraphs or successful-run status chrome. Trash returns the image to its exact thumbnail slot over 220 ms while it turns grayscale and dims. The date and centered Removed/Undo controls appear only after the image lands. Date/time uses the shared fade-and-rise reveal and remains readable independently of image dimming; Removed/Undo fades in over 180 ms. Undo restores color and opacity over 180 ms using the same mounted thumbnail. Persistence runs alongside the animation; failures restore the prior state. Removed cards keep their slot for the current visit. Reserve a notice row so removal feedback cannot move the grid; a Removed view retains recoverability on later visits. Only image assets belong in the gallery grid. Failed, cancelled, and pending attempts never create cards or Retry controls. A compact Stop control in the gallery header remains available during active generation. Tapping a completed card opens the full-size image viewer.
