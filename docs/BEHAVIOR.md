# Evoke v6 behavior specification

Settings → Android app provides Install in the PWA and Update in supported APKs. The native page shows Current app and Current interface with separate update statuses and progress. Compatible signed interface bundles download in the background after a healthy boot and wait for the next cold process launch; checking, downloading and staging never reload active writing or generation. Signature, size/digest and native/bridge/storage compatibility checks precede staging, and failed readiness trials restore a healthy cached or included interface. An explicit Update Android app tap downloads and verifies a fixed-origin APK inside the app, including package/version and installed-signer checks, before Android's permission and installation confirmation. Older APKs keep the phone-browser fallback. Neither release checks nor interface downloads change Current app. Unavailable releases and failed downloads show retryable status. PWA and APK libraries stay separate; same-origin interface updates and in-place signed APK updates preserve the encrypted library. See [ANDROID.md](ANDROID.md).

Cast image requests honor the selected Hybrid, Monolithic, Essential, or Resolver prompt enhancement in the same Meromero vision call that selects references. They retain selected file-backed instructions, compatible presets, direction, visual defaults, and current scene context; Generate Bypass explicitly skips enhancement. Cast imposes no output-token cap or 32,000-character prepared-prompt limit. Provider context limits still apply.

The fixed model `meromero` prepares Cast scene images with reasoning **Off**, for both Qwen-only and Krea + Qwen. Consistency checks and video prompt preparation also use Meromero from copied text connections with reasoning Off (`reasoning_effort: none`). Previously frozen Qwen3.8 jobs retain their copied model and prompts for retry; legacy Gemma compatibility remains. Missing Meromero fails explicitly. Exact scene details and instructions can still be missed. The image-method labels retain their renderer meaning: Meromero vision → Qwen Image, or Meromero vision → Krea → Qwen Image.

Qwen image rendering uses 15 steps. Reference edits and the Qwen stage of Krea + Qwen use image 1's dimensions, with Qwen's native 32-pixel rounding and no 1 MP resize. Qwen-only Cast scenes use the selected aspect ratio and MP independently of reference dimensions. Krea keeps its existing sizing; vision-planning previews remain smaller.

Reusable characters follow [CHARACTERS.md](CHARACTERS.md): a browser-local library,
explicit per-chat cast and look selection, Qwen reference generation/refinement,
and an optional report-only consistency check. A matching name never enables a
library character automatically. Enabled descriptions inform writing; selected
references inform character-aware images. Cards use the shared Gallery; a chosen
thumbnail persists, with available references/candidates as a fallback. Qwen Edit
uses the viewed image and description, preserving originals and reference
selection. Gallery's **Use reference** checkboxes determine library reference counts
and the Cast reference inputs across appearance groups. Cast has no separate
reference selector or counter; legacy per-chat subsets no longer filter images. All images persist
automatically, including unchecked candidates, without a separate Save reference
action. Description accepts pasted text. Existing chat modes remain unchanged.

The character library sorts by A → Z, Z → A, Newest first, Oldest first, or Last
edited. Its device-local choice persists through navigation and reload; sorting
does not modify cards. Legacy creation order uses the earliest recorded edit date.

Roleplay's **Cast images** preference defaults to **Qwen only**. **None** keeps
Cast enabled for writing. Roleplay and Story include enabled bios in regular
image prompt preparation, including Hybrid and Essential, without reference images or the
Cast scene planner. Names, aliases and preferred appearances accompany the bios,
frozen with Lore for the image job; disabled cards contribute no context. The
regular prompt uses the selected writing model before the chosen regular image workflow.
**Krea + Qwen**
first creates the scene, then supplies it as Qwen image 1 with up to nine character
references. Both stages share one resolved scene; only the final edit feeds
automatic video. See [CHARACTERS.md](CHARACTERS.md) for limits and failure behavior.

User-authored creative input must be treated as persistent data, including unfinished
dialog fields. Closing, navigation, reloading, rerendering, and job completion or
failure must not silently discard it. Qwen Edit and the other character image sheets
autosave drafts per image/purpose and retain them after submission. Future changes
must preserve this contract and cover persistence regressions; clearing requires
explicit user intent and a recoverable path.

The word **must** identifies confirmed product behavior. Unsettled behavior is referenced to [DECISIONS_REQUIRED.md](DECISIONS_REQUIRED.md) and is not resolved here.

## 1. Shared application behavior

- Chat creative state, history, media, and settings copies live on the device. Global Settings is installation-wide.
- Ordinary edits autosave without a persistent success bar. Successful saves are visually silent; save failures, conflicts, and disconnection use distinct temporary toasts with a visible remaining-time bar and touch-swipe dismissal.
- Completed work remains usable after Stop, refresh, navigation, service loss, or later failure.
- A model operation cannot steal the caret, selection, focus, or manual scroll position.
- Unavailable actions remain visible whenever the operation is conceptually valid and include a plain-language reason and recovery path.
- Undo, replacement, regeneration, restoration, archive, and removal preserve an appropriate recovery path.
- Motion is subordinate to input. Reduced motion changes presentation, never meaning or final state.

### Authoritative boot and synchronization

- A normal load obtains the current sidebar, active session, session content/settings and device presentation state from browser storage before rendering stateful UI.
- Evoke never first paints cached/default creative state and visibly corrects it afterward.
- A fresh page paints a stable generic Evoke surface immediately. The complete destination fades in once its content, controls, saved reading position, and visible media are ready. Partial shells and intermediate loading stages remain covered; no artificial minimum loading delay is added. The webpage cover has no logo, so it does not repeat Chrome’s PWA launch icon.
- Opening never focuses an editable field or deliberately opens the keyboard. Backgrounding clears editable focus without clearing text or selection, and a preserved page resumes without replaying its opening animation.
- Repeat launches use locally saved configuration and read the current last-used chat directly from the device store (APK encrypted native vault; PWA IndexedDB). Server refresh runs in the background without remounting the editor. A first launch without saved configuration retries automatically when disconnected.
- Android uses a bundled interface and a purple native opening with the transparent symbol. The whole splash fades over 120 ms when the populated page and WebView frame are ready. A preserved activity resumes without reloading; process loss restores current local state. Chrome and APK storage are separate; Settings → Backup transfers the library explicitly, with password encryption on by default and additive import preview. See [BACKUPS.md](BACKUPS.md).
- Returning to a suspended PWA keeps the existing editor, draft queue, selection, and reading position. Updates download quietly and apply on a later full launch; update discovery never forces the current page to reload.
- Connected clients receive committed changes live. When continuity is uncertain, the client reacquires current authoritative state instead of guessing.
- Backend loss pauses provider execution; chat content and settings remain editable on the device.

- The normal app retains each existing creative library. There is no Admin PIN or profile switch in the interface; devices can use the same main Settings.
- On every boot, main Settings comes from current shared configuration. Every new chat fetches and saves an independent copy of the settings at creation. Existing chats retain their own values and copied resources, including former browser-specific configuration.

### Browser-backed app

Main settings edits apply globally to the installation and become defaults for subsequent chats. They do not rewrite existing chats. Chat settings edit that chat only. No authentication or CSRF token is required; Host/Origin and HTTPS checks remain.

- Local creative records, retained assets, and copied configuration persist in this installation's device store (APK encrypted native vault; PWA IndexedDB).
- The backend receives local creative payloads only for the requested service operation, keeps them in process memory under a opaque lease retained while it holds jobs, and never writes them to Evoke's SQLite or asset store.
- Reload/navigation may reconnect to an in-memory lease while the backend remains alive. An actual backend restart loses uncollected memory results; browser storage loss and another device cannot recover the local library. Closing the app does not stop an accepted Generate/Iterate batch or Roleplay/Story image, including while its prompt is being prepared. Job-bearing leases do not expire while the browser is away; empty leases expire after 30 minutes.
- Local ComfyUI runs use verified WebSocket-only image output. Workflows containing SaveImage, PreviewImage, unknown output nodes, or any unverifiable disk-writing path fail before queueing. No fallback exists.
- After terminal handling Evoke removes that prompt's ComfyUI history entry. A provider or custom node outside Evoke's verified contract may retain its own data; Evoke never labels such a workflow Local-compatible.

## 2. Session shell

### Creation and opening

- New session offers Roleplay, Story, Generate, and Iterate cards, each with an Input preset dropdown and Create action. All four input dropdowns start on Blank each time the chooser opens.
- Creation combines the selected input save with current applicable Global defaults, assigns a stable ID and untouched automatic title, and opens the new session without copying prior-session settings or generated results.
- Selecting a sidebar item mounts the complete interface for that type at its last appropriate state.
- Opening `/` restores the device's most recently used session. If no session exists, `/` remains on onboarding and offers Roleplay, Story, Generate, and Iterate creation directly.
- Opening another session never stops, pauses, or supersedes active generation.
- Refresh and direct links return to the same session when it still exists.
- Every opened session becomes the navigation root. Browser/device Back closes the foremost surface first (image viewer → gallery → session; session settings → session), returns from main Settings to that session, and stays at the session once reached. Opening another session replaces that root; Back never resurrects an earlier chat or unrelated page. Settings dismissal saves pending edits through its normal close path and stays open if saving fails.

### List and lifecycle

- The sidebar lists mixed session types with explicit type, title, and meaningful durable status.
- Automatic titles preview the first 60 characters of Roleplay prose (Lore when empty), Story prose (idea when empty), Generate request, or Iterate's first request. Whitespace collapses to spaces and longer previews end in an ellipsis. Existing chats derive the same preview; manual renames remain authoritative.
- Search matches user-visible titles and useful type/status metadata; it does not expose hidden generated prompt content by surprise.
- Session status can update live without moving the active pointer target or reordering the list under interaction.
- Rename changes only the title. A user-edited title is never replaced by a later suggestion.
- Duplicate chat saves pending writing and request edits, then adds an independent active copy named with a `(copy)` suffix. Writing, history, settings, saved presets, cast, and saved media are retained with fresh chat/media identities. The original stays mounted; unfinished prompt-preset drafts remain there and are not applied to the copy. Running generation is copied as a saved snapshot without transferring jobs or starting new work; the source is unchanged. Storage failures leave no partial copy and retain the source and its inputs for retry.
- Archive hides the session from the ordinary recent list without deleting content or cancelling work.
- Removal is recoverable. Unsafe removal while work is active remains visible but disabled with Stop/Cancel as the direct recovery action.
- Restoring a session preserves its stable identity, copied settings, content, history, outputs, and recoverable operation state.

### Per-device presentation

- The active session, sidebar state, and every named scroll surface remember their latest manual state per device.
- Navigating away/back, refreshing, reconnecting, or remounting from an authoritative snapshot restores scroll only after real content mounts.
- Restoration clamps when content is shorter and never overrides a newer manual scroll.
- Navigation, caret, scroll, and open-panel state never change creative content or effective session settings. Roleplay menu preferences are saved chat settings, including reading appearance, and travel with Settings presets.

## 3. Settings behavior

### Global defaults

- **Settings → Defaults** is a creation-default editor, not a creative profile.
- Defaults are versioned by session type and may include common creative settings.
- Global-default field edits autosave without a manual Save action and affect sessions created afterward only.
- Global defaults never own prose, manuscripts, Generate runs, galleries, or generation history.

### Chat settings copies

- Every new chat copies relevant Global values and provider connections/capabilities plus renderer/prompt selections. Current renderer/prompt files remain authoritative for new submissions.
- Chat settings edit that chat only; Story opens them through Tools, while other types retain their top-right entry. All relevant selections remain editable.
- Ordinary Global setting/provider changes never rewrite existing chat copies; renderer/prompt file edits apply to new submissions using those files.
- Model A remains selected during migration when available, even if the new Global default is Model B. Unavailable choices use the relevant current Global fallback once.
- A running job retains its frozen settings; settings edits apply to later work.
- Image direction, sampling values, URLs and keys come from the chat copy; renderer graphs and bundled prompt instructions come from the current selected files. Roleplay always disables reasoning; other chat types use the copied reasoning value.
- Input preset and Settings preset are independent controls at the top of every chat's settings. Each supports Save as, Update, Modified, and Revert to the last loaded or saved copy. Loading one section preserves the other.
- Settings preset selection changes only this session. Use as [mode] defaults explicitly publishes settings for future sessions of that mode; other mode defaults remain unchanged.
- Global Settings offers named configurations covering Shared and all four modes. Selecting one there atomically changes Global defaults. Input saves remain device-local. See [SETTINGS.md](SETTINGS.md) for save scope and Revert behavior.
- There are no authentication or profile gates, inheritance toggles, or implicit most-recent-session settings copies.

Roleplay's three-dot menu autosaves every choice into the chat settings copy: continuation size, tail-action lock, Text reveal speed, motion, Auto read, reading appearance, and Image prompt (Essential, Monolithic, Hybrid, or Resolved). Saved/copied Settings presets include these choices; applying one updates the open editor. Each contextual image freezes its selected mode.

### Services

Global Text, Speech, and Images sections manage creation defaults. The chat's Connections disclosure edits copied URLs, keys and model inventory. Renderer JSON is read-only with its source path; imports and workflow-version controls are retired. Provider rejection is reported with its cause. Refer to [SETTINGS.md](SETTINGS.md).

## 4. Roleplay sessions

### Text and directions

Roleplay is one uninterrupted exact-text editor. Lore is separate context and is never inserted into prose.

A line whose first non-space character is `>` is a direction. Consecutive direction lines form one block. Direction lines are excluded from prose context, paragraph media actions, speech, styling spillover, and paragraph counts. Only a trailing block is active; once prose appears beneath it, it remains visible but becomes inert.

Straight and curly double quotes delimit dialogue for continuation behavior. Quote state is paragraph-local. Apostrophes, single quotes, and asterisks are ordinary text.

Syntax styling follows the same delimiter set as continuation logic. A closing-quote scan stops at a blank line and at every `>` line, so an abandoned quote cannot paint later prose or directions as dialogue. A lone letter before a period is treated as an initial only where a name can begin (`Mr. J. R. Smith`), not after an ordinary lowercase word (`plan B.`).

### Continue normalization and placement

Formatting normalization occurs once when Continue is pressed, never while typing. It may add necessary paragraph separation, keep consecutive directions together, recognize an intentional new unit after a complete sentence, and trim terminal whitespace needed to place output. It preserves words, punctuation, mid-sentence line breaks, and wider scene breaks. The normalization is undoable.

Separation around a direction block is unconditional except between consecutive direction lines, which stay together. Prose-under-prose normalization is conservative on both sides: the text above must finish a sentence and the line below must begin like a new unit (a capital or opening double quote). A manual mid-sentence line break remains exact. Normalization is additive—an existing wider gap remains a scene break—and removes only trailing whitespace at the very end so insertion has a known offset.

Continue selects the first matching placement:

| Priority | Condition                                                             | Result                                                                         |
| -------: | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
|        1 | A trailing direction block exists                                     | Start a new prose paragraph after it; leave text above byte-for-byte untouched |
|        2 | No prose exists                                                       | Generate the first prose paragraph                                             |
|        3 | Final prose paragraph has an open double quote or incomplete sentence | Continue inline                                                                |
|        4 | Complete prose ends with an explicit line break                       | Start a new paragraph                                                          |
|        5 | Complete user-authored tail is below its sentence target              | Extend inline to the remaining confirmed sentence budget                       |
|        6 | Otherwise, including a complete model-authored tail                   | Start a new paragraph                                                          |

Paragraphs per Continue ranges from 1–8. Sentences per paragraph ranges from 1–12 and caps inline extension at a follower-confirmed sentence boundary. It never authorizes rewriting an existing sentence.

The paragraph setting counts accepted paragraphs, not provider attempts. Completing an existing unfinished paragraph consumes the first slot. With a setting of three, that completion is followed by two new paragraphs. If two paragraphs pass and the third fails, retain the two and retry only the remaining one using the retained story as context. Retry never resets the quota or adds extra accepted paragraphs; Stop can end before the quota is filled.

An edit that changes the final prose paragraph marks it user-authored, except a pure end truncation preserves the recorded author. Lore, direction-only changes, and earlier-paragraph edits do not claim the tail. Undo/Redo restore tail authorship stamped with the restored text. Any accepted generated chunk immediately marks the tail model-authored.

### Seam acceptance

Evoke may normalize joining whitespace, remove clearly duplicated seam punctuation, remove substantial replay anchored at word boundaries on both sides, and capitalize a genuinely new sentence.

Evoke never:

- completes or heals a partial word;
- removes text because of a single-character/partial-word overlap;
- runs a second differently tuned replay detector;
- repairs prose above a trailing direction block;
- treats single quotes as paired dialogue.

Seam repair is one ordered pass, not an iterative fixpoint loop. Quote reasoning considers the final paragraph only. Inline output stops only at a confirmed sentence boundary. Live unfinished sentences and open quotes are normal prefixes, not failures. At a paragraph boundary or response end, acceptance requires a completed sentence and closed double quotes. A malformed paragraph is withdrawn and retried from the last accepted paragraph; previously valid paragraphs and authored prose remain intact regardless of which provider request produced them. No synthetic quote closure is added. These structural checks do not guarantee narrative quality.

The model is never shown text it must not touch. When the final prose paragraph is unfinished beneath the direction hard gate, prompt construction cuts the story view at the last completed sentence while the visible buffer retains the unfinished fragment byte-for-byte. Current Lore, the active direction, recent verbatim prose, and only revision-valid older summaries/facts form continuation context; stale derivations never override later edits.

### Streaming reveal

- Continue becomes Stop while generation or visual reveal is active, not merely until provider bytes stop arriving. Scroll easing alone does not keep actions busy. Stop pauses the visual queue and cancels active generation; Resume reveals already received text without making another model request only while prose and Lore remain unchanged.
- Provider prose arrives and validates live without a full-response wait. The dots menu offers Text reveal speed: 5 words/s by default, selectable every integer from 1 through 25 words/s or Live. This saved chat preference caps only presentation. Slower words and the rest of an already visible word appear as received; fast output queues without changing backend speed, validation, paragraph quotas, or durable acknowledgements.
- Completed valid paragraphs checkpoint incrementally; the current unaccepted tail is provisional and may be replaced during a retry.
- Viewport movement alone is smoothed. Text reveal speed also seeds its easing; measured visible line intervals then set the response. Slow reveal uses longer, overlapping movement rather than short isolated line jumps; fast reveal blends successive targets. Rate changes preserve position and velocity without overshooting the visible tail. There is no fixed scrolling-rate ceiling or additional word delay.
- Stable mirror nodes and whitespace outside animation spans preserve paragraph wrapping during and after streaming.
- The prose editor fills the writing surface and ends its scrolling content with exactly one invisible tail-padding line. Generation writes on the line above it, so completion causes no hand-back jump.
- The tail padding is not caret-selectable and is not a separate control or row. Only while that padding is visible at the document tail, tapping it focuses prose and collapses the caret immediately after the last visible non-whitespace character; scrolling earlier prose moves the padding out of the viewport with the text.
- The prose scroll thumb overlays the writing surface without reserving layout width, so scrollbar visibility never changes text wrapping or caret alignment. Pointer/touch dragging scrolls the prose without focusing it and immediately relinquishes automatic follow.
- A generation with no revealed words holds its position.
- Hidden tabs suspend capped reveal without accumulating a catch-up burst. Reduced motion disables decorative movement, not the chosen reading cap. Live removes the cap explicitly.
- The selected-paragraph stripe measures only revealed layout. Its extent advances with the newest revealed line, never shrinks on a shorter transient measurement, and keeps its soft moving-edge fade inside the measured extent rather than hanging below it.

### Scroll, caret, and interruption

- With more than 64 CSS pixels of prose scroll travel, the selected paragraph contains the reading area's center (or is the nearest prose across a gap). Within half a viewport of either scroll end, the reading point smoothly biases toward that edge so the first and last paragraphs remain reachable; each edge range is capped at half the total scroll travel; at 64 pixels or less it follows the caret. Scroll selection drives the stripe and contextual Read/Image actions without moving the native caret or selecting direction lines. Owned generation follow selects the last revealed prose paragraph.
- Reload/navigation restores exact prose/Lore selection offsets and direction alongside scroll position only when a saved text fingerprint matches. Restoration does not focus a field; stale or malformed selections are ignored.
- The native textarea owns editing, caret, selection handles, and accessibility; the exact-text mirror paints prose and blue dialogue both while focused and blurred. Decoration uses the textarea's font metrics and wrapping, and in-progress IME input refreshes the mirror without committing unfinished composition. Keyboard/visual-viewport resize and pan events refresh mirror translation, paragraph selection, and stripe geometry without requiring another interaction.
- Manual scrolling immediately disables auto-follow. Completion never snaps the reader back.
- Follow re-arms only when the reader deliberately returns to the revealed end.
- Story extent, tail visibility, selection stripe, and follow calculations use currently visible text. Following starts whenever the reader is at the actual bottom, including before Continue; a broader tail-action proximity band must not take scroll ownership.
- Every mirror repaint preserves a real caret/selection by exact offsets. Selection residue on the mirror root is not treated as a caret at offset zero.
- Once the reader places a caret during generation, automated caret parking/restoration and tail placement stand down.
- Any actual prose or Lore edit during continuation stops live delivery and requests a scoped Stop. Input, paste, deletion, IME, autocorrect, and drop all use the same path.
- The intended edit remains authoritative while Stop settles. It is saved against the stopped document revision as the exact visible edited prose and Lore, without unseen output accepted before or after Stop, and becomes the exact source for the next Continue. Late provider output cannot overwrite it or append old context.
- Undo/Redo/Delete remain unavailable while generation or visual reveal is active. Once generation is safely stopped and reveal is paused, valid history actions are enabled without waiting for decorative history or scroll motion; availability colors and opacity ease over 150 ms. Selection and caret movement remain available throughout visible prose.
- In browser-stored Roleplay, a completed result already saved to history is not an active continuation merely because its temporary job awaits cleanup. Paused/completed Undo and Delete must succeed without an active-continuation error. Late cleanup must preserve the latest history, visible edits, and any newer run rather than restoring a captured document.
- Explicit Stop preserves the received live prefix, even mid-sentence or mid-quote, as an undoable model edit and prevents later output from joining. It freezes the visible prefix without dumping the queued suffix; Resume reveals that retained suffix at the selected speed while prose and Lore remain unchanged. Any actual prose or Lore edit removes the unseen suffix from the current branch and restores Continue; Undo retains access to the original paused state and queue. With no usable generated prefix, Stop restores the exact pre-request text/history/provenance. An explicit interruption is not a falsely completed paragraph.
- Undo/Redo and Delete/Undo restore the paused visible prefix and its retained queue when returning to that exact history state. It returns paused with Resume, never auto-resumes or regenerates received text. Paused Delete removes the visible final block and temporarily removes the unseen suffix in one undoable edit, rather than targeting an unseen paragraph. Bookmarks follow history position and exact text/context, not provider batch boundaries.
- Undo/Redo/Delete/replace motion yields immediately to pointer, keyboard, or IME input.
- The native editor and mirror contain the same visible prefix; queued text participates in neither wrapping nor scroll/stripe geometry. Any actual prose or Lore edit pauses reveal, requests Stop if generation is active, and preserves only the exact visible edited prose and Lore in the current branch. Cancellation responses and late checkpoints must not append unseen old output to that edit. Continue waits for the edit to save durably before freezing fresh context. Replacement-class motion (Undo, Redo, Delete, restore) may be settled and then reposition the caret from the user's original coordinates because it displays a different historical version.

### History, speech, and contextual images


- Text, Lore, history cursor, tail authorship, effective configuration provenance, image anchors, and accepted generation state survive reload inside the Roleplay session.
- Delete paragraph removes the final blank-line-delimited block, including a trailing direction block.
- When “Lock actions away from the end” is enabled, scrolling away locks Delete, Undo, and Redo, including keyboard and native history commands. Returning to the tail or disabling the setting restores otherwise valid actions. Automatic history tail following keeps consecutive actions available; Continue is unaffected by this setting.
- Read paragraph speaks only the selected prose paragraph. Read paragraph and Create image close editor options and return focus to the dots trigger without opening the software keyboard, moving the native selection, or changing reading position. Their asynchronous completion does not reclaim focus.
- Auto TTS speaks complete paragraph(s) affected by a successful continuation after reveal settles. Stopped, failed, or superseded generation does not trigger it.
- Starting another read/preview stops prior audio. Audio is transient and has no gallery.
- Contextual Generate image uses the selected prose paragraph or final selectable paragraph, prior whole-paragraph context, Lore, image direction, and frozen effective session settings. Direction lines never enter the scene.
- Local Roleplay captures the visible prose when Create image is pressed. Its lookback contains at most 20 complete preceding prose paragraphs and 12,000 characters including separators, ordered nearest first. It stops at the budget without truncating a paragraph or skipping recent facts to include older ones. Later prose and direction lines are excluded. The selected moment takes precedence over earlier continuity, and recent evidence takes precedence over older evidence.
- Results remain owned by and anchored to the Roleplay session without reflowing prose or stealing focus.

## 5. Story sessions

### Reading and tools

Story opens as a continuous reader with a compact Stories/title/Tools header. Chapter headings and exact prose own the screen; editing, setup, chapter navigation, images, settings, export, and history live in focused tool surfaces instead of a permanent dock. Stories opens the existing application session drawer. Each Story session owns exactly one project; there is no nested project library.

Reading position and generation target are independent. Scrolling, opening a chapter to read, and opening tools do not retarget generation. Tools names the current writing chapter; changing that target requires explicit intent. Passage actions name their chapter/paragraph scope. Stop remains reachable while generation is active, including after dismissing Tools. Returning to reading preserves the mounted manuscript, exact text, and reading position without focusing an editor.

Every user-authored setup value, manual edit, instruction, and unfinished form is persistent data. Keep exact drafts as they change and preserve a recovery copy before asynchronous saves commit. Closing or switching tools, navigating, immediately reloading, and starting/completing/failing/cancelling a job cannot clear them. Submitted instructions remain available. Invalid values or storage failures retain the input with an actionable explanation; do not claim a save before durable acknowledgement or allow ordinary dismissal to destroy the only copy.

The contracts below retain the fuller Story workflow. The device-owned path prepares chapter structure locally and does not offer AI plan review or previewed rewrites. It rejects chapter-count decreases rather than removing persistent chapter fields, and regeneration retains recoverable chapter history. Planning review, rewrite previews, continuity analysis, and restorable versions are offered only where the active storage path supports them. The quiet UI must keep every supported operation reachable without advertising unsupported future actions. `README.md` and `PROGRESS.md` remain the account of implemented capability; these active specifications define direction until implementation catches up.

### Setup

A new Story session opens a focused blank setup. Story idea is the first creative field; optional style/canon and generation values use disclosures. It owns exactly one Story project; creating another project means creating another Story session from the application sidebar.

Defaults are three chapters of approximately 300 words. Setup provides:

- required Story idea;
- exact chapter count from 1–100;
- approximate words per chapter from 100–50,000 as an enforced cumulative target;
- optional style direction;
- Natural, Short, Standard, Long, or custom 10–1,000-word paragraph target;
- dialogue density from None through Dominant;
- canon fields for POV, Tense, Genre, Tone, Audience, and Ending, initially Infer, plus custom fields;
- optional pause to review the chapter map.

Canon constrains content. Style direction constrains presentation. Editing setup does not restart written prose. Generate Story begins planning/generation.

### Planning and generation

The default path creates a permissive chapter map and begins prose without waiting for model review. The reviewed path creates chapter intentions and a narrative-state timeline, treats compatible tensions as assumptions, reports only genuine mutually exclusive conflicts, and waits for explicit acceptance. Invalid planning changes no prose or accepted map.

Generation advances in completed durable units. A chapter receives authorized changes, prior state, bounded earlier digests, accepted continuity decisions, recent prose, remaining budget, and minimal future restrictions. Detailed future chapters and hidden future state are withheld.

Stop discards only the incomplete request and retains completed units. Resume continues saved progress. Retry repeats only failed/uncommitted work. Switching sessions, refreshing, closing a client, or losing WebSocket does not pause Story generation.

Each completed chapter receives a revision-qualified bounded digest before the next begins. Cumulative word targets settle at a sentence boundary with only a bounded overrun; the browser never relies on the model to declare completion correctly.

### Manuscript and editing

All chapters appear as one continuous manuscript. The reader shows exact chapter titles and prose without permanent editing controls; title/prose edits live in the explicitly scoped edit surface. A one-chapter Story adds no synthetic heading. Paragraph/chapter actions target their explicit structural selection, never an inferred generation target based on reading position.

Story editing is unavailable while generation is active, with Stop as the direct recovery action. A direct edit or accepted rewrite is authoritative and undoable, preserves a restorable prior version for replaced text, refreshes affected digests, and assesses downstream impact only when later chapters exist. Analysis never approves or rejects the edit.

If later content is affected, the user chooses:

- **Revise future chapters:** preserve old versions and regenerate affected downstream material.
- **Keep my edit:** make it canon while retaining later prose; pause at a named conflict if future generation becomes impossible.
- **Undo edit:** restore the grouped pre-edit state.

Whole-story regeneration requires confirmation and a recoverable copy before replacement. The fuller server path versions every non-empty chapter; the device-owned path retains recoverable chapter history. It resets generated prose and the generation state supported by that path while preserving session identity, setup/canon, and session images. Regeneration must not erase the history needed to restore replaced prose.

Rewrite is paragraph-scoped and may accept optional direction. Original and candidate coexist until Accept; Keep Original writes nothing. Restore is itself an authoritative edit and can trigger downstream review.

Read chapter speaks only the structurally selected chapter. Story never speaks automatically. Contextual image actions remain owned/anchored by this Story session. Markdown export contains the session title and exact ordered non-empty chapter titles/prose only.

## 6. Generate sessions

System prompts offers bundled `comfyui/{package}/prompts/monolithic.txt` references. Renaming or editing a reference and saving creates a browser-local preset; it never renames, edits, or deletes the source file. Local copies remain independently editable after reload. Compatible custom System text overrides the separately chosen prompt path without changing its output contract. Missing or legacy `workflow_default` normalizes to Essential; explicit supported choices remain selected.

### Workbench state

A Generate session persistently owns its visual request, effective session configuration, selected workflow reference, run history, progress, result grouping, retained outputs, and restorable presentation state.

The first run does not destroy the editable request. Seed-another and new-composition runs remain inside the same session. A genuinely separate visual idea is created as another Generate session.

### Frozen run input

A run freezes the current request/structured intent, effective session settings, selected current renderer file and frozen graph/config, model/provider settings, dimensions, counts, and applicable prompt layers. Later edits affect later runs only.

Each refined variant is a complete prompt interpretation. Generate Bypass uses the same unchanged request for every variant, without a prompt-service call. Every requested image has stable run/variant/position identity and a fresh seed where supported. Missing or failed positions remain explicit; Evoke never pads a grid with duplicates.

### Prompt and workflow behavior

Prose, regular workflow Resolver image preparation, and regular Roleplay/Story Monolithic/Hybrid/Essential preparation use the model, endpoint, reasoning, and sampling values selected in the chat copy. Roleplay always disables reasoning. This includes Generate's explicit Resolver, ordinary Iterate initial scenes and revisions, and regular Resolver, Monolithic, Hybrid, and Essential Roleplay/Story images. New Cast scene/check and video prompt preparation are dedicated fixed `meromero` vision routes on copied text connections with reasoning Off. Previously frozen Qwen3.8 jobs retain their copied model and prompts for retry; legacy Gemma compatibility remains. Cast image methods retain Qwen Image or Krea → Qwen Image rendering; None retains selected-writing-model text preparation and the regular renderer. Missing Meromero fails explicitly. Selected local models use the normal GPU handoff: release ComfyUI memory before text inference, then unload local text before rendering. Generate Monolithic/Hybrid/Essential and legacy unstructured image preparation use the live server Gemma4 service. Ordinary Generate Bypass skips the LLM. The selected renderer file supplies the graph; rendering uses the configured image connection. An unavailable selected model or required server service fails explicitly without substituting another model.

### Progress, results, rerun, and cancellation

Progress distinguishes prompt preparation, resource waiting, queueing, rendering, retrieval, cancellation, partial completion, completion, and failure.

Completed prompts/images appear incrementally and survive later failure. Beneath Variant X, only the optimization output appears above the image; the raw input is never a fallback. The area stays empty until output exists and for Bypass runs. Image bytes are immutable. **Seed another** on a regular workflow image run copies its frozen prepared prompts, settings and composition contract, resolving the current canonical renderer file for the new attempt while assigning fresh seeds and result identities. Cast seed changes and retries rerun its single vision preparation from frozen submitted inputs and instructions. **New composition** freezes and recompiles the currently edited request and prompt layers. Neither operation overwrites prior bytes. Result order and run grouping remain stable across reload.

Cancel stops downstream Evoke work, preserves completed results, and targets only known provider work for the current run. If provider execution may continue, Evoke says so and rejects/quarantines late provisional output.

Removal is recoverable. Full-size viewers in Generate, Iterate, and writing-session galleries support two-finger pinch-to-zoom around the gesture midpoint, one-finger or pointer panning, trackpad pinch, and a single Fit action that resets scale and position. Zoom-in/out buttons are omitted; keyboard +/− and 0 remain available. Ordinary wheel/trackpad scrolling pans a magnified image. Overlay buttons use translucent backgrounds and stable touch targets.

## 7. Services, resilience, and access

Text, image, speech, embedding, and optional vision services are independently configurable machine resources. Off is neutral. Each endpoint reports Checking, Connected, Degraded/Unavailable, or Off without hiding healthy services.

When text and image services share a constrained host, Evoke queues family transitions and does not interrupt in-progress creative work merely to swap models. It drains active work, unloads the prior local family, waits for memory to settle, and then starts the next family. Services on independent hosts may run concurrently and are not lifecycle-managed as if they shared VRAM.

Roleplay and Story ordinary/Cast images and manual/automatic videos return to the chat-selected writing model in the background after the final accepted media-chain stage, including success, failure, cancellation, and prompt-preparation failure. Jobs freeze the selected writing model and copied connection separately from image/video prompt preparation. Resubmission and supported retries keep that target. Image → Auto video waits for video to end before requesting writing return; batches wait for the final image position. Saved media is available immediately, independently of warmup and browser acknowledgement.

The backend waits for active GPU leases to drain, releases the actual ComfyUI endpoints used by the chain, and warms a shared lifecycle-managed writing host with one reasoning-off token. New work can supersede optional warmup; queued media takes priority. Warmup failure cannot remove saved media or change the generation outcome. Independent writing hosts and unmanaged Gemma services receive no readiness call; legacy accepted requests without a writing target cannot reconstruct it. Generate and Iterate retain their existing behavior, including video renderer release without a writing return. If new image work cancels pending renderer cleanup, the next image lease performs the release before rendering.

Evoke opens without authentication on every configured device. Global Settings is shared installation-wide; each device keeps its own chat library. Host/Origin and HTTPS checks remain. See [SETTINGS.md](SETTINGS.md).

The installed PWA opens from its cached shell and saved configuration while reading current creative state from IndexedDB. Local edits remain available without the backend; provider operations and Global saves require connectivity. Configuration refresh never replaces mounted writing. Conflicting newer content never silently overwrites dirty local work, and local edits never silently win.

Roleplay handles ordinary Continue/reload and the editor's own save broadcasts without asking the user to resolve versions. Genuinely incompatible authored writing is automatically saved as a separate session, retaining the source settings and leaving the source untouched. The recovered session opens only after saving succeeds. A brief notice and persistent Review drafts menu action provide optional comparison; either session can be opened without discarding the other. Failed recovery retains the exact local draft and offers Retry; repeated attempts reuse one recovery identity. Browser-owned writing stays in browser storage.

Provider, validation, queue, image, speech, continuity, persistence, and synchronization failures remain isolated from unrelated sessions and completed results. Every error explains what was preserved and provides a direct recovery action.

Local Roleplay Create image uses the workflow settings committed in that session, including changes saved while its editor is open. Current execution validates the frozen graph; stale import-time compatibility annotations cannot reject a currently supported graph. Browser-owned image anchors, results, and recoverable removal stay with the Local session. Named reading positions are captured during scrolling and when the app becomes hidden; reopening restores them after the actual session content mounts.

Session Images opens a media gallery in newest-first order; video behavior is defined in VIDEO_GENERATION.md. Pending, failed, and cancelled attempts do not appear as cards. Failures are reported once, and Create image or Generate video in the source image viewer starts a fresh attempt. Gallery has no job-status rows or Retry controls; its fixed header Stop control remains available for active work. Images scale to the column width without cropping, keep their natural height, and fill the shortest column next. The compact Gallery header Columns control selects 1–6 columns (default 3), saved on this device across Roleplay/Story sessions and reloads. The compact date appears as a bottom-left watermark inside the picture, with its full timestamp in the accessible label/title. Thumbnails have no footer or remove button. The open-image viewer offers a top-left trash icon; removing returns to the Gallery, and repeated taps cannot submit duplicate removals. Remove dims the same card and exposes Undo without shifting neighbors; leaving clears these held slots, while Removed retains access to recoverable results. Returning from the gallery preserves the writing session, its caret, and its reading position.

The fixed-size Images button shows a progress indicator while an image is being prepared or rendered, including on the phone layout. Local session summaries remain busy until that work ends. Notifications remain visible and dismissible above the gallery.

## Iterate behavior

Iterate preserves unsaved instructions after a save or generation failure. Stop remains available independently of draft saving. A failed Try another retains the chosen starting revision. Missing saved sources fall back to the latest available scene, and older workspace projections do not overwrite newer state. Device presentation restores timeline position and composer selection without focusing the input; Retry and Try another keep the current presentation version. Full-size images offer Save and navigation between revision images alongside shared zoom and Fit controls.

Iterate starts with one resolver-backed text-to-image generation. Follow-ups use the selected revision's full resolved JSON as their source, apply usable field edits while reporting invalid edits, and preserve unedited scene facts. Scene-quality validation warns and continues rendering from available output; it never discards the complete response or prevents later follow-ups. Explicit exclusions persist as resolver memory. Revisions retain instructions, scene evidence, prompt, settings, seed, ancestry, image, and failure state. Continue from here selects a source; Try another skips the LLM and chooses a fresh seed. Retry resumes the frozen failed revision. See [ITERATE.md](ITERATE.md).


## Automatic images and video (2026-09-21)

Roleplay can generate one image after Continue, or run Continue + image once with the toggle off. Auto video depends on Auto image; viewers also offer Generate video with an optional direction. Manual Roleplay video uses current edited prose and Lore captured when Generate video is pressed; Meromero plays out its actions and supplied dialogue from the existing image's starting frame, with explicit video direction taking priority. Only manual Roleplay video marks source prose as current clip intent; Story manual video and automatic image → video chains retain the image's frozen story context and next-beat interpretation. Each accepted video attempt keeps its submitted inputs and prompts for recovery. Videos are separate Gallery assets. Failed and cancelled videos preserve their source image and leave no permanent Gallery status or Retry control. See [VIDEO_GENERATION.md](VIDEO_GENERATION.md) for the current contract and verification.
