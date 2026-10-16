# Evoke v6 UI design

> **Project Aida scope:** This is an imported Evoke reference. Aida's site and player keep their loud yellow accent (`#e8ff47`); Evoke's mint palette and product-specific branding do not apply. Follow [AGENTS.md](../AGENTS.md) for Aida's requirements.

The [Videos character collection](CHARACTERS.md) is a sidebar destination with thumbnail
cards and a name/description editor. Text is pasted directly into Description.
The embedded shared Gallery has masonry images, 1–3 columns, reference selection,
and recoverable removal. Its viewer provides **Set as thumbnail**, **Qwen Edit**,
and **Image details** alongside shared image controls. **Use reference** in Gallery
controls reference eligibility for both character creation and Cast; counts in Videos
match checked images. Images are stored automatically, without a Save reference
button. Cast exposes character enablement and preferred appearance, without an
image-reference disclosure or counter. Create
images and Qwen Edit use sheets for candidate count and appearance group; the
main page has no Direction, aliases/text references, or text-import section.
**Check consistency** sits in the top-right workspace navigation. Its report has
plain findings and a generation warning, without repair/dismiss buttons. Cast
enables cards per chat. Controls use theme tokens, 44px targets, and stable layout.

The character list places a shared **Sort** button beside **New character** with
A → Z, Z → A, Newest first, Oldest first, and Last edited. Changing it reorders
existing tiles while the header controls retain their positions and focus.

Roleplay Editor options → Generation includes **Cast images** with **Qwen only**
(default), **Krea + Qwen**, and **None**. None keeps Cast for writing and supplies
enabled bios to regular image prompt preparation, including Hybrid and Essential, without
reference images or the Cast scene planner. It autosaves per chat alongside the
media controls. The image labels describe renderer stages: Meromero vision → Qwen
Image, or Meromero vision → Krea → Qwen Image. None keeps selected-writing-model
text preparation and the regular renderer; the choices and their geometry are unchanged.
Auto image and Auto video use the same 36×22 switch track as the other Roleplay
toggles, inside 44px labeled rows. Auto video is disabled while Auto image is off.

The menu uses Generation, Reading, Writing, and Style tabs, with Generation selected on
mount. Compact two-column image choices and switches replace wide single rows.
Image and Video have separate headings. Aspect ratio and Image MP edit the same saved chat values used by Krea and Qwen. Video numbers share one row; direction retains its full width. Content grows
upward above the tab bar, keeping tabs and the bottom paragraph actions stationary
while short pages shrink to fit. Panels remain mounted to preserve draft inputs;
only the selected panel is exposed to keyboard and assistive navigation. Arrow
keys and Home/End select tabs. Tab changes fade the outgoing content, animate the container height and fade/slide the incoming content. Rapid changes cancel stale transitions; reduced motion switches immediately. Very short viewports scroll the settings region.

## 1. Design outcome

Evoke must feel like RP's precise creative tool expanded into a unified application. The LLM-style sidebar makes sessions familiar and revisitable; the main surface retains the complete Roleplay, Story, Generate, or Iterate interaction model.

The shell is a session navigator. Iterate uses a conversation suited to image refinement; writing and Generate retain their own workspaces. It is a calm session navigator wrapped around four purpose-built tools.

### Visible control contract

Evoke begins with semantic HTML and retains dependable form, validation, keyboard-input, and assistive-technology behavior, but no browser or operating-system control surface is allowed to appear unstyled. Every visible native element receives an explicit Evoke treatment; controls with unstyleable open chrome, especially choice lists, use a shared custom-rendered component backed by a form-compatible value source.

Focus uses one deliberate, geometry-stable signal. Browser outlines and application focus borders must never stack into a double ring.

Scrollable surfaces preserve native wheel, touch, keyboard, and scrollbar behavior. Scrollbar styling stays restrained and its presence never moves, resizes, or rewraps neighboring content.

Dark and light use the same interaction hierarchy but independent surface, ink, line, accent, danger, and elevation tokens. Settings exposes System, Dark, and Light; theme selection updates the current page and browser theme color immediately without remounting the workspace.

## 2. Information architecture

### Primary destinations

The sidebar contains:

1. New session.
2. Search and optional type filtering.
3. Recent/pinned Roleplay, Story, Generate, and Iterate sessions in one coherent list.
4. Archived sessions when explicitly opened.
5. One Settings destination for shared defaults, services, appearance, and device appearance.

Automatic chat titles show a 60-character opening preview of the writing or image request, using single-line whitespace and an ellipsis when longer. Blank chats retain their type label, and manually renamed chats keep their chosen title. Each row reserves two title lines and a separate 44px menu target; long text, including unbroken strings, clamps within that title area. Quiet type metadata sits below, with live status shown only when meaningful. Active rows have a subtle accent edge. Hover, focus, and opening the row menu never move neighboring rows.

The normal sidebar preserves the current creative Videos collection. Main Settings is the same shared configuration on every connected device. New chats copy its current values at creation. There is no Admin PIN, profile switch, or browser-wide settings fork in the interface.

Videos, workflow editors, galleries, and other supporting surfaces open from the session or settings context that owns them. They do not become competing top-level “apps” unless a confirmed workflow cannot be reached coherently otherwise.

### Session route

Every session has a stable direct route independent of title and sidebar order. Refresh restores that session from authoritative state. If it no longer exists, Evoke presents a clear recovery destination instead of silently opening another session.

The `/` route resolves to the current device's most recently used session. With no sessions, `/` presents onboarding with the four session-type choices in the main surface. The Evoke wordmark uses the same root behavior, so it never points to a 404 or an unrelated settings destination.

### New session

New session displays four cards: Roleplay, Story, Generate, and Iterate. Each has a mode description, Create button, and Input preset dropdown containing Blank and the mode's saved inputs. Every dropdown starts on Blank each time Create opens. Create combines it with current Global defaults and opens the workspace immediately, without another setup step or implicit settings copy from a recent session.

## 3. Mobile-only shell

- The phone workspace owns the full visual viewport in portrait and landscape.
- The session list is always a full-height modal drawer opened from the session header; there is no persistent rail or collapse control.
- The current workspace stays mounted behind the drawer so editor selection, scroll, virtual-keyboard state, and generation presentation are preserved.
- Lore, Story Tools and its focused pages, Settings, result details, and recovery surfaces are always phone sheets or full-screen overlays.
- Roleplay's dock and every tool surface's return/action controls remain above safe areas and the on-screen keyboard. Story has no permanent idle dock.
- Generate always places its request controls before results in one scrolling column.
- Drawers and context sheets trap focus while modal, close with Escape/scrim/explicit close, and return focus to their opener.
- Browser/device Back dismisses the foremost viewer, gallery, session-settings sheet, or drawer while retaining the chat and its reading position. The current chat is the navigation root: main Settings returns there, and further Back stays there instead of exposing earlier sessions or unrelated pages.
- Wider untested viewports keep this mobile composition; they do not unlock additional product behavior.

## 4. Session list behavior

- Rows are virtualizable/searchable for large Videos collections without losing keyboard semantics.
- Title is primary; type and status are secondary.
- The selected row remains stable while status text changes.
- Generating sessions update live without flashing or reordering under the pointer.
- Recency order changes only after an intentional open or meaningful committed activity, not every progress event.
- Context menus expose Rename, Duplicate chat, Archive/Restore, and recoverable Remove. Duplicate chat adds an active copy titled with a `(copy)` suffix after its content and media are durably saved. The original stays open so unfinished prompt-preset drafts remain available. Its busy state keeps the same menu geometry; a failed copy permits retry.
- An active run is not cancelled by archive, navigation, drawer opening, or another session opening. Unsafe removal remains visible but disabled with Stop as the recovery action.

## 5. Startup and synchronization

Evoke opens without authentication on every configured device. Global Settings is shared installation-wide; each device keeps its own Videos collection of chats. Host/Origin and HTTPS checks remain. See [SETTINGS.md](SETTINGS.md).

The opening uses Evoke purple (#171426), without an icon tile or visible text. On Android, the native SplashScreen holds the transparent Evoke symbol on purple and follows the system launcher entry transition. Keep the native splash until the destination content, header controls, saved reading position and visible images are ready and WebView confirms its populated frame. Fade the native logo and purple surface away together over 120 ms, respecting system animation settings. Suppress the HTML splash and underlying page fade inside the APK so no second icon or partial page appears. Android/OnePlus controls icon-to-window expansion; physical-phone verification is required.

The PWA webpage uses the same plain purple with no logo in initial HTML or the runtime fallback, followed by a 220 ms populated-page reveal (100 ms under reduced motion). Its manifest uses a transparent regular symbol and an edge-to-edge purple maskable icon. Chrome still controls the separate WebAPK launch stage and its manifest-generated icon. The webpage must not add another logo underneath it. Neither platform adds a minimum loading delay or waits for an entrance animation to finish before revealing ready content. Errors remain visible and actionable. See [ANDROID.md](ANDROID.md).

Startup never focuses an editable control. Backgrounding dismisses editable focus while keeping exact text, caret/selection, and reading position; the user taps a field to reopen the keyboard. Resuming a preserved page keeps that page and does not replay the opening transition. Cached/default session lists never render and then visibly correct themselves.

Live remote changes update the smallest affected surface. They do not remount the current workspace, steal focus, move the caret, reset scroll, reorder the sidebar under interaction, or reopen closed panels.

## 6. Writing surface composition

Roleplay's editor owns the flexible middle of the viewport between the session header and action dock. Story's continuous reader owns the remaining viewport below its compact header; editing and other actions open in focused tool surfaces. Both preserve native prose scrolling without chaining overscroll into the page.

The Roleplay phone header is a compact identity row with the drawer, title, Lore, and session settings. It carries no decorative vertical padding. The prose canvas begins directly with the editor—there is no persistent `Prose / Empty` metadata strip and no continuation status/progress strip during or after generation. Continue morphs to Stop, accepted prose is the progress, and concise state remains in the session header; equivalent run-state copy remains available as a screen-reader announcement. The bottom dock remains a single row. Read/Image and presentation controls open from the animated options trigger in a compact aligned sheet. Generation, Reading, Writing, and Style tabs group the settings. Review drafts stays available above the active page. The tab bar sits above Read paragraph on the left and Create image on the right nearest the trigger. Content grows upward so tab targets and actions stay fixed; hidden pages retain their inputs. Compact rows and a bounded scrolling settings area keep all controls reachable on phones, including the video controls. Its entrance uses the full ordinary-surface motion interval so containment is clearly visible without becoming theatrical. The panel stays rendered through its exit, becomes inert immediately on dismissal, and reverses smoothly when retoggled. Create image and Read paragraph capture the selected paragraph, close the menu, and return focus to the dots trigger without focusing prose, moving the selection, or changing reading position. Later action completion never restores editor focus. While that sheet is open, the first prose tap dismisses it without focusing the editor or opening the keyboard; the next prose tap edits normally. Opening Lore focuses its close control, never its textarea, so the software keyboard appears only after an explicit tap in the Lore field.

The Roleplay options sheet includes an Image prompt selector in its Generation tab: Essential, Monolithic, Hybrid, and Resolved. Its half-width grid cell keeps labels and neighbors stable when the selection changes. Existing writing/reading preferences autosave with chat settings and belong to saved/copied Settings presets, including all visible reading-appearance controls. Applying settings refreshes the mounted controls; open-panel and reading-position state remain local.

Writing presentation preserves exact plain text. Dialogue/direction/chapter decoration exists only in the mirror/presentation layer. It never becomes stored rich-text markup. In Roleplay, the native textarea owns the caret, selection handles, editing, and accessibility while the mirror remains visible, including during focus and IME composition. Dialogue is blue in both light and dark themes. Decoration must not change font metrics or wrapping relative to the textarea. Word-reveal animation excludes all spaces and line/paragraph separators so paragraph geometry does not change when streaming settles. Visual-viewport resize and pan events refresh the mirror, selected paragraph, and stripe even when the textarea does not emit a resize or scroll event.

### Bottom geometry

The prose editor and its scrollport consume the full writing surface. The final scrollable content includes exactly one line of invisible tail padding below the text; it is not caret-selectable and never renders as a separate control, rectangle, or row. At rest and during generation, the last/newest revealed line occupies the line immediately above it. Only while the padding is visible at the document tail, tapping it places the prose caret immediately after the last visible non-whitespace character, never inside the padding; scrolling earlier prose moves it out of the viewport with the text. The scroll thumb overlays the prose instead of consuming horizontal layout width, so it cannot alter wrapping or separate the caret from the decorated text. Tail padding remains one line throughout generation and completion, so there is no final two-line drop. Continue keeps an owned tail stationary until visible generated prose actually extends it; incoming text never pulls the viewport backward before streaming down.

### Selection and contextual actions

When Roleplay has more than 64 CSS pixels of scroll travel (`scrollHeight - clientHeight`), the active paragraph follows reading position: the reading point stays at the viewport center through the main scroll range. Within half a viewport of either end, smoothstep easing biases it toward the top or bottom edge so the first and last paragraphs remain selectable. Each edge range is capped at half the total scroll travel so short ranges do not overlap. Select the prose paragraph containing that point, or the nearest prose across blank/direction gaps. At 64 pixels or less, caret selection remains authoritative. Reading selection never moves the native caret or text selection. While generation owns tail follow, it selects the last revealed prose paragraph. Direction lines are never selectable prose. Story keeps its structural selection model.

The overlay scroll thumb is draggable with pointer or touch input. Dragging relinquishes automatic tail follow without focusing the editor or changing text wrapping. Releasing a thumb or touch scroll at the revealed tail re-arms following; releasing above it does not. Wheel intent releases follow before the next reveal frame, so a delayed native scroll event cannot be mistaken for the app's own scroll. Roleplay restores saved prose/Lore caret and selection offsets with scroll position on reload or navigation when the text still matches; restoration never opens the keyboard by focusing a field.

During Undo/Redo/Delete tail following, the thumb's bottom edge stays anchored and its size follows the existing continuous scroll motion. This is presentation only: grabbing the thumb cancels history motion before computing the grab offset, and dragging always maps to the native scroll range.

A restrained accent stripe may identify the selected paragraph. During generation it grows only with revealed text, never shrinks, and fades inside its current extent at the moving edge. During Delete, Undo, and Redo, one viewport-space transition moves and resizes the stripe from its current visible bounds to the selected paragraph’s settled text bounds. It preserves velocity through repeated presses and reversals, including keyboard history, and uses the same response before and after prose starts overflowing. The target excludes temporary word-animation transforms and line boxes. Scrolling cannot add a second motion to the stripe. With no selectable prose left, the line contracts and fades. All three actions share the passage's movement and duration. Undo and Redo fade the affected passage together with matching durations and reversed easing. Delete adds a fast last-to-first word-opacity sweep within that same passage motion; it never accelerates the paragraph or adds a second exit stage. Repeated tail actions preserve unfinished animations; changing direction starts text from its current visible opacity and position. The stripe never blinks between command states or changes height merely because word-animation wrappers appear or disappear. When the reader is already at the prose tail, scrolling begins alongside the passage motion and preserves momentum as each immediately applied history action changes the destination. History never drags a reader who is inspecting earlier prose.

“Lock actions away from the end” disables Delete, Undo, and Redo together while reading earlier text, with the same explanation on all three buttons. Keyboard and native history commands respect the same lock. Returning to the tail or turning the setting off restores valid actions. Automatic history scrolling keeps consecutive actions available; Continue is unaffected.

Every history motion suppresses the empty-editor example placeholder until the transition settles. Deleting the final remaining paragraph reveals the placeholder only after the final outgoing word is no longer painted; restoring prose hides it before incoming text begins, so it never overlaps moving prose.

### Story reader and tools

The default Story screen is the manuscript: exact chapter headings and prose below a single Stories/title/Tools row. Long titles truncate within their reserved header slot. There is no persistent metadata row, action dock, generation progress footer, version disclosure, or paragraph-selection chrome in the reader. A prose tap does not open editing or retarget generation. Stories opens the existing application session drawer, retaining the mounted Story and reading position; it never opens a nested Videos collection for the project.

Tools is a temporary sheet over the reader. It identifies the current writing chapter and offers the one current Generate/Continue, Stop, Resume, or Retry action. Chapters, Edit & rewrite, Story setup, Images, and Settings & export lead to focused pages with explicit Back/Done controls. Chapters separates the reading destination from the writing target. The edit page makes chapter and paragraph scope explicit and contains the available history, rewrite, speech, image, and recoverable removal actions. Optional setup values use styled semantic disclosures; advanced settings stay out of the first-use idea field.

Tool pages use one bounded scrolling body and stable header/action geometry. Every action has a 44px target; shared custom choice controls, visible labels, system typography, and semantic theme tokens apply. Dark is the reference appearance, with System/Light retained. Safe-area padding and the visual-keyboard inset keep return, editing, and active Stop controls reachable at 424×924, 360×800, and phone landscape sizes. Short landscape/keyboard views scroll the tool body rather than clipping actions.

The reader stays mounted behind tools. Returning restores its reading position without focusing prose or opening the keyboard. Tools contains focus, makes the background inert through exit, closes through Escape, device Back, scrim, or Done where safe, and returns focus to its opener. Navigating between tool pages keeps exact creative input and scope. Setup, rewrite/image instructions, unfinished forms, and manual edits retain recovery copies as they change; close/reopen, navigation, immediate reload, job completion/failure/cancellation, and save errors cannot silently clear them. Save failures remain actionable and ordinary dismissal cannot destroy the only input copy.

While generation is active, Stop remains directly reachable from the reader and relevant tool pages with stable geometry. Generation does not force a reader inspecting earlier text to the tail. Routine autosave success stays silent. Explicit failure, unavailable-operation reasons, and recovery remain available without crowding the default prose surface. Existing operations remain reachable. Device-owned Story prepares chapter structure locally and has no AI map review or previewed rewrite; fuller review, rewrite, continuity, and version surfaces appear only where the active storage path supports them. Local setup rejects chapter-count decreases, and regeneration retains recoverable chapter history.

## 7. Streaming and motion contract

The reveal, tail-follow, and interruption details in this section describe Roleplay. Story retains its structural generation and active-edit guards from `BEHAVIOR.md` while applying the reader/tools composition above.

### Live generation and reading speed

Receive and validate provider chunks immediately. Text reveal speed in the dots menu caps only visual presentation: 5 words/s by default, every integer from 1 through 25 words/s, or Live. Slower incoming words appear immediately; faster output queues without accelerating the cap to catch up. An unaccepted tail can be withdrawn and retried; completed valid paragraphs stay in place.

Settled prose keeps its existing presentation nodes while the live tail grows. Words may receive an immediate entrance cue, but whitespace and paragraph separators must retain their final layout. Visual pacing never delays backend delivery, validation, or durable acknowledgement. Queued text is absent from both the visible mirror and textarea layout.

### Reveal

- Provider arrival is unpaced; the selected word cap controls reveal, and viewport easing follows visible layout growth.
- The view follows the currently visible end while it owns bottom-follow.
- A generation with no revealed word holds its current position.
- Text reveal speed also controls the initial scroll easing. Once visible wraps are measured, easing spans their cadence rather than ending after a fixed short duration: slow lines move gently into one another, and fast lines blend continuously. Changing the rate preserves position and velocity, with enough deceleration to avoid overshooting the tail. Fractional motion carries across frames. There is no fixed scrolling speed, speed ceiling, or extra delay before revealing a word.
- Blank paragraph separation is discounted at once; nothing is written into the blank line.
- Reduced motion suppresses decorative movement but preserves the reading cap. Hidden tabs suspend capped reveal; returning releases at most the next word, not a catch-up burst.

### Scroll ownership

Scrolling away immediately disables generation follow. Completion never snaps the reader back. Follow is armed whenever the reader is at the actual bottom or returns there; proximity within the wider tail-action band is insufficient. Every extent calculation uses visible text.

The prose scroll path is compositor-only: scrolling translates the mirror and paragraph stripe and updates ownership state, but does not rebuild text or read layout geometry on each scroll event. Stripe geometry is measured only when content, selection, or settled history geometry changes.

### Stop and interruption

Continue remains busy while generation or visual reveal is active; scroll easing alone does not delay action availability. Stop cancels active generation and pauses reveal at the current visible prefix, without discarding or dumping already received prose. Resume reveals the retained queue without generating more while prose and Lore remain unchanged. Any actual prose or Lore edit removes unseen output from the current branch, stops active generation, preserves the exact visible edited prose and Lore, and returns the action to Continue after cancellation settles. The old paused version and queue remain recoverable through Undo; late output and checkpoints cannot append them to the edited version. Continue waits for durable save before using fresh context. After generation is safely stopped, paused reveal allows valid Undo, Redo, and Delete actions. Returning with Undo/Redo, edit/Undo, or Delete/Undo restores the same original paused prefix and received queue with Resume available. Delete targets the visible final block. Buttons ease enabled/disabled opacity and colors over 150 ms with no geometric movement, while authoritative availability is not delayed by history or follow animation. Repeated history commands retarget active motion immediately. Manual editing or scrolling interrupts decorative history motion.

## 8. Caret, focus, and editing

- The caret belongs to the reader.
- Repainting a mirror/editor carries caret and selection across exact text offsets.
- A model operation does not park or restore the caret after the user has placed it.
- During continuation, the first actual prose or Lore edit pauses reveal, removes unseen received words from the current branch, and requests a scoped Stop before saving. The exact visible edited prose and Lore remain authoritative, whether the edit touches earlier prose, the generated tail, or crosses their boundary. Undo can recover the old paused state; cancellation cannot append its stale continuation.
- IME composition is never split into intermediate server mutations.
- Roleplay saves genuinely conflicting authored text as a separate session and opens it for continued writing. A short “Your draft was saved separately” notice offers Review; Review drafts remains in editor options. The optional Compare drafts sheet says “Both sessions are saved,” shows readable text with changed paragraphs shaded, and keeps Lore collapsed. Phones show fixed Your draft/Original tabs; available wider space can show both inside the sheet. Keep writing closes review; Open original navigates to the other saved session. Neither action overwrites or removes writing. There is no blocking copy-to-clipboard rescue step. Story retains its explicit conflict/recovery surface.

## 9. Generate workspace composition

Batch prompts, Reasoning, and disclosure chips clear their selected colour immediately when switched off or closed, even while the pointer remains over them. Touch must not leave hover feedback behind. These rules also apply to Settings chips and shared controls; keyboard focus remains a separate visible indicator.

The compose controls start with **Variants | Images per variant**, followed by **Aspect ratio | Megapixels**, then a full-width **Reasoning** toggle above the prompt. Count labels remain plural when the value is one. Megapixels accepts any decimal value from 0.1 to 16; minus/plus buttons adjust the current value by 0.25 without snapping typed values to a quarter-step grid. The footer's **Batch prompts** toggle prepares all variants in one LLM request using the selected preparation path; it does not disable prompt preparation. Bypass skips preparation regardless of this toggle. Control labels and neighbors keep their positions as values and toggle states change.

The System prompts disclosure lists each packaged `comfyui/{package}/prompts/monolithic.txt` as a reference and includes saved local copies. A selected reference shows its source path and disables Delete. Name and prompt text remain editable; Save creates a local copy and selects it. Saving a local copy updates that copy. The action labels and their rectangles stay fixed through selection and saving. Clearing the System prompt selection removes that preset layer; it does not change the separately selected prompt path.

Global **Defaults → Generate** places **Monolithic prompt service** before **Image**, with a Gemma4 server selector restricted to supported Gemma aliases, collapsed model parameters, and reasoning. The service selector applies to Generate Monolithic/Hybrid/Essential and legacy unstructured preparation; the chat's Resolver model picker applies to Resolver; the workflow chooses the image model and connection. Both use the existing full-width field and disclosure controls, with stable geometry during autosave.

Generate settings and Global Defaults → Generate expose a full-width **Prompt path** dropdown above Workflow: Bypass first, followed by Essential, Monolithic, Hybrid, and Resolver. Its fixed helper explains raw input, prompt refinement, connected Hybrid paragraphs, Essential's necessary scene information, and detailed scene resolution; autosave and path changes keep neighboring controls stable.

The Generate canvas is one scrolling phone column: compact compose controls first (steppers, prompt, Generate batch, toggle chips), followed by the results region. Before the first run, the results region shows a dashed empty state that points back to the request controls. After generation begins, variant cards with optimization output and imagery appear below. Only optimization output appears between Variant X and the image; raw input is never copied into that area, which remains empty before optimization and for Bypass runs. The request remains directly revisable by scrolling upward.

- Variant/result geometry is reserved before images load where dimensions are known.
- Active Generate image placeholders use a stationary dot matrix: flowing 2D Perlin noise changes dot size and brightness, with a soft glow at the strongest peaks. The readable phase label and card geometry stay fixed. Reduced motion holds a static field; offscreen cards and hidden tabs pause animation. Completed, failed, and cancelled outputs stop the effect.
- Completed images appear incrementally without reordering.
- Failed/missing outputs retain their grid position and recovery action.
- Generate, Iterate, and writing-session full-size viewers share pinch, pan, and Fit behavior. Where multiple images are available, small next/previous chevrons sit at the screen edges with 44px touch targets. Tapping outside the actual image dismisses the viewer; image taps and pan/pinch gestures keep it open. Viewers support two-finger pinch-to-zoom, one-finger/pointer pan, and trackpad pinch. A single Fit control resets scale and position; there are no zoom-in/out buttons. Keyboard +/− and 0 remain available. Overlay controls use translucent backgrounds, readable labels, and fixed 44px touch targets.
- Switching sessions preserves current zoom/result selection where defined as restorable presentation state.
- Tapping an image expands it from its thumbnail into the full-size viewer; closing returns it to the currently viewed image's thumbnail with the same 320 ms easing. Cropped thumbnails reveal their full image without stretching. The backdrop fades independently, controls and neighboring cards stay fixed, and early dismissal reverses from the visible position. The final small pose stays in place until the overlay is hidden, with the source restored in the same frame. Corner rounding starts with the image's movement and changes with its position and size until landing. Closing a zoomed or panned image starts at its current displayed bounds without a Fit reset or size jump. Date/time stays hidden through normal close and Trash, then fades in with a subtle 3px rise over 180 ms; reduced motion skips the reveal movement. Missing/offscreen origins fade instead; reduced motion skips travel.

## 10. Settings surfaces

The sidebar Settings destination is the one Global edit page: Defaults, Text, Speech, Images, device Appearance, Backup, and Android app. Android app provides a full-width Install button in the PWA or Update in supported APKs, plus Check again. Native Current app and Current interface are distinct; separate interface/APK statuses and progress reserve their space so checks, downloads, staging and retries do not move controls. A staged interface message tells the user that it applies on a later launch and work can continue. Update Android app downloads inside supported apps, then Android supplies permission and installation confirmation; old APKs retain browser fallback. Common and type-specific defaults autosave. Story opens its own settings from Tools → Settings & export; the other chat types use their top-right settings button. Each settings sheet has a clear “saved for this chat” subtitle.

Roleplay and Story show an editable writing-model picker. Generate and Iterate show an editable Resolver model picker with a hint explaining local GPU handoff and the separate Monolithic service. Parameters are editable in every chat. Roleplay omits the reasoning control and always runs with reasoning off; other types retain the control. Regular workflow Resolver uses the selected chat model, including regular images requested from writing chats and existing chats. Regular Roleplay/Story Monolithic/Hybrid/Essential uses the selected writing model; Generate Monolithic/Hybrid/Essential and legacy unstructured preparation use server Gemma4. Ordinary Generate Bypass skips refinement. New Cast scene/check and video prompt preparation use fixed Meromero with reasoning Off; image-method labels still name renderers. Roleplay and Story include speech; Generate and Iterate show their image settings. Connections exposes copied URLs, keys and model IDs. Renderer definitions are read-only and loaded from the authoritative workflow files.

Each chat sheet begins with Input preset and Settings preset dropdowns. Each section reserves a Modified label slot and a fixed row of Revert, Save as…, and Update preset actions. Below them, Use as [mode] defaults explicitly publishes that mode's settings. Settings preset selection applies only to the current chat. Global Settings begins with a Settings configuration dropdown and Revert, Save as…, Update preset, and Rename actions. Name entry uses a focused, keyboard-accessible modal. Dropdowns use the shared custom select and truncate long selected names without moving neighboring controls.

No profile, Admin/Local switch, PIN, login, or inheritance controls appear. New chats receive independent copies. The Global editor identifies text/speech settings saved specifically for a mode and can restore Shared defaults for those fields. See [SETTINGS.md](SETTINGS.md).

Controls use the shared field grid and custom selects. Parameters remain inside a full-width disclosure; reasoning occupies a full-width block in Story, Generate, and Iterate. Labels, card widths, and surrounding controls remain stable during autosave. The sheet opens at the start of its scroll region, covers the header, and fills the phone width. Closed disclosures are inert. Save errors preserve the draft and identify the failed operation.

## 11. States and recovery

Every workspace provides coherent success, saving, loading, empty, generating, waiting, stopped, disconnected, unavailable-resource, partial-result, retryable-failure, terminal-failure, and conflict states.

Routine saved state is intentionally invisible. Failure/conflict toasts float in a centered lane below the session header, away from permanent action docks and header controls, with a depleting duration indicator and dismissal by close control or horizontal swipe. Reconnection and application updates complete silently.

Errors state:

1. what failed;
2. what was preserved;
3. whether work may still be running externally;
4. the direct recovery action.

Provider/image/speech failure never disables unrelated writing or session navigation.

## 12. Accessibility and performance

Semantic controls, focus visibility, screen-reader labels, contrast, system text scaling, keyboard navigation, touch targets, IME, reduced motion, safe areas, and virtual keyboards are acceptance requirements. The mobile app shell stays at a fixed page scale: native pinch and double-tap page magnification are disabled, while purpose-built image zoom/pan remains available inside the viewer.

Typing, caret movement, scrolling, sidebar navigation, and Stop should feel immediate at the device's active refresh cadence, including 120 Hz. Effects and expensive measurement yield to input and are disabled/degraded before core interaction quality is compromised. Streaming and tail follow must preserve that same frame budget with long prose and a fast provider stream; slowing an animation is not an acceptable substitute for removing repeated layout and DOM work. Roleplay uses browser-owned scroll progress for visible glyph movement where available and keeps paragraph parsing and unchanged control updates out of repeated scroll handling.

### Session gallery

During prompt preparation and rendering, Roleplay's Images button and Story's Images entry in Tools show a spinner within the same fixed target. Reduced motion uses a static indicator. Error notifications remain visible and dismissible above the gallery.

Images in Roleplay/Story opens a full-screen, image-first gallery with an explicit return to that same session. Scale images to the column width at their natural aspect ratio and place each successive image in the shortest column, preserving newest-first DOM/viewer order. A compact Columns stepper in the Gallery header selects 1–6 columns (default 3) and saves the preference on this device across sessions and reloads. Place the compact date and local time inside the image at the bottom left as a subtle watermark, wrapping between them on narrow cards; preserve the full timestamp in the accessible label/title. Thumbnails have no footer or remove button. The open-image viewer has a 44px trash icon at its top left, aligned with the existing top-row controls, and removal returns the image to its Gallery slot over 220 ms while it turns grayscale and dims. Reveal the thumbnail date/time with the shared fade and rise after it lands, independently of image dimming; fade Removed/Undo in over 180 ms. Undo restores the same thumbnail's color and opacity over 180 ms. Start persistence alongside the visual response, restoring the prior state on failure. Keep a removed card in its original slot with Undo while the gallery remains open; returning later offers Removed to restore it. Gallery updates preserve scroll, focused controls, and neighboring card geometry. Only image assets produce gallery cards. Failed and cancelled attempts leave no gallery entries or Retry controls; the user starts again with Create image. Starting generation keeps the writing view open. Active work can be stopped from the gallery header.

## Iterate surface

New session displays Iterate fourth, after Generate, with the description “Refine images through conversation.” The image conversation has user instructions, one result per revision, a persistent bottom composer, and a fixed-width Generate/Stop control. A compact strip names the starting revision; the session header opens image settings. Shared theme tokens support dark and light appearance. Revision actions have 44px targets, with a pressed Starting point state, Try another, Details, and Retry when applicable. A stable revision heading reports waiting, resolving, rendering, stopping, or recovery state. Details contains warnings, Changes, Scene JSON, original resolver output, Image prompt, and Generation settings disclosures.

Full-size viewing shares image entry/return motion, Save, previous/next images, pinch/pan, Fit, and keyboard controls. Closing a sheet returns focus without scrolling the conversation. At 424×924, 360×800, and 844×390, the page does not scroll; only the timeline and sheet bodies do. A visual-keyboard inset keeps the composer visible when a phone keyboard overlays the page. Progress, completion, source selection, and press/focus feedback preserve control geometry. Reload restores the draft, source, timeline position, and composer selection without opening the keyboard.


## Automatic images and video (2026-09-21)

The Images group adds Auto image on Continue, dependent Auto video, Continue + image once, and three video number fields. The menu scrolls within its bounded settings area when needed. Viewers expose Generate video and a Direction disclosure containing an optional text field; Roleplay’s Images menu also saves an automatic-video direction. Text entry does not trigger image navigation or zoom shortcuts. Phone toolbars wrap into two fixed rows, and direction panels scroll within the viewport. Video items use native playback controls. See [VIDEO_GENERATION.md](VIDEO_GENERATION.md) for the current contract and verification.

## Import & export

Settings includes a Backup jump link and a phone-width Import & export section. Export defaults to password encryption, with password/confirmation fields and no autofocus. Turning it off explicitly displays plaintext/credential exposure. Import chooses a file, requests a password only when necessary, then shows date/counts and existing-match behavior before its action. Busy controls stay in place; status uses a reserved region. Success offers Open imported Videos. Existing text fields are not replaced while reporting progress/errors. See [BACKUPS.md](BACKUPS.md).

### File-backed renderer selection

Workflow dropdowns show the current renderer JSON files in the package's `workflow/` directory, excluding `*_config.json`. Normal `krea2.json` is selected after migration; `krea2_bj.json` is available only through an explicit selection. There are no import, workflow-version or editable copied-JSON controls. Prompt path is independent from Workflow: missing or legacy `workflow_default` selections appear as Essential. Dropdown labels, badges, triggers and neighbors remain fixed while selection and autosave state change.
