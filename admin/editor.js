/* Local editing never publishes until the Upload/Publish button is pressed. */
(() => {
  "use strict";
  const find = (selector) => document.querySelector(selector);
  const all = (selector) => [...document.querySelectorAll(selector)];
  const studio = { videos: [], rows: new Map(), selected: null, detail: null, baseline: "", dirty: false, busy: false, pendingAction: null, listRequest: 0, detailRequest: 0, listAbort: null, detailAbort: null, lastListRemote: false, conflictMode: null };
  const visibilityText = { private: "Private", unlisted: "Unlisted", public: "Public" };
  const editable = ["#edit-title", "#edit-description", "#edit-tags", 'input[name="edit-visibility"]'];

  function status(selector, message, error = false) {
    const target = find(selector);
    target.textContent = message;
    target.classList.toggle("error", error);
    target.classList.toggle("ok", !error && Boolean(message));
  }

  async function request(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...options.headers };
    if (options.method && !["GET", "HEAD"].includes(options.method.toUpperCase())) headers["X-Aida-Session"] = find('meta[name="aida-session"]')?.content || "";
    const response = await fetch(path, { ...options, headers, credentials: "same-origin", cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(typeof data.detail === "string" ? data.detail : data.message || "Couldn't complete that. Try again.");
      error.status = response.status;
      error.current = data.current;
      throw error;
    }
    return data;
  }

  function fields() {
    return { title: find("#edit-title").value, description: find("#edit-description").value, tags: find("#edit-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean), visibility: find('input[name="edit-visibility"]:checked')?.value || "private" };
  }

  function fromDetail(detail) {
    return { title: String(detail.title || ""), description: String(detail.description || ""), tags: Array.isArray(detail.tags) ? detail.tags.map(String) : String(detail.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean), visibility: Object.hasOwn(visibilityText, detail.visibility) ? detail.visibility : "private" };
  }

  function thumbnailURL(raw) {
    if (!raw || typeof raw !== "string") return "";
    try {
      const url = new URL(raw, location.href);
      if (url.username || url.password) return "";
      if (url.origin === location.origin && url.pathname.startsWith("/api/video-media/")) return url.href;
      if (url.origin === "https://cdn.keppy.dev" && url.pathname.startsWith("/file/ProjectAida/")) return url.href;
    } catch { /* An invalid image is shown as an empty thumbnail. */ }
    return "";
  }

  function previewURL(raw) {
    try {
      const url = new URL(raw, location.href);
      return url.origin === location.origin && url.pathname === "/preview/watch.html" && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }

  function updateCard() {
    const draft = fields();
    find("#editor-card-title").textContent = draft.title || "Untitled video";
    const frameRate = studio.detail?.frameRate;
    const frameRateLabel = typeof frameRate === "number" && Number.isFinite(frameRate) && frameRate === 120 ? `${frameRate} fps` : "120 fps required";
    find("#editor-card-visibility").textContent = `${visibilityText[draft.visibility]} · ${frameRateLabel}`;
    find("#visibility-help").textContent = draft.visibility === "private" ? "Only you can preview a private video here." : draft.visibility === "unlisted" ? "Anyone with the link can watch. It won't appear in the video list." : "Everyone can watch. It appears in the video list after publishing.";
    find("#editor-publish").textContent = draft.visibility === "public" ? "Publish changes" : "Upload changes";
  }

  function updateState(message) {
    studio.dirty = Boolean(studio.detail) && JSON.stringify(fields()) !== studio.baseline;
    updateCard();
    if (message) status("#editor-save-state", message);
    else if (studio.dirty) status("#editor-save-state", "Unsaved changes");
    else status("#editor-save-state", studio.detail?.pending ? "Saved on this PC · not uploaded" : studio.detail?.has_remote ? "Saved · website is up to date" : "Saved on this PC");
    find("#editor-save").disabled = !studio.detail || studio.busy || !studio.dirty;
    find("#editor-publish").disabled = !studio.detail || studio.busy || Boolean(studio.detail.remoteChanged);
    find("#edit-thumbnail-file").disabled = studio.busy || !studio.detail;
    find("#edit-frame-apply").disabled = studio.busy || !studio.detail;
    find("#conflict-reload").disabled = studio.busy;
    find("#editor-form").setAttribute("aria-busy", String(studio.busy));
  }

  function updateThumbnail(detail) {
    const image = find("#editor-thumb-preview");
    const url = thumbnailURL(detail.thumbnail_url);
    image.hidden = !url;
    find("#editor-thumb-placeholder").hidden = Boolean(url);
    if (url && image.src !== url) image.src = url;
    if (!url) image.removeAttribute("src");
  }

  function showConflict(mode) {
    studio.conflictMode = mode;
    const notice = find("#conflict-notice");
    notice.classList.toggle("hidden", !mode);
    if (!mode) return;
    const paragraphs = notice.querySelectorAll("p");
    const remote = mode === "remote";
    paragraphs[0].textContent = remote ? "This video changed online. Your edits are still here." : "This video changed since you opened it. Your edits are still here.";
    paragraphs[1].textContent = remote ? "Using the online version replaces your local edits. A backup is kept." : "Review the saved version before trying again. Loading it replaces your unsaved edits.";
    find("#conflict-reload").textContent = remote ? "Use online version" : "Review saved version";
  }

  function showDetail(detail, { preserveFields = false } = {}) {
    studio.detail = detail;
    studio.selected = detail.id;
    if (!preserveFields) {
      const values = fromDetail(detail);
      find("#edit-title").value = values.title;
      find("#edit-description").value = values.description;
      find("#edit-tags").value = values.tags.join(", ");
      all('input[name="edit-visibility"]').forEach((radio) => { radio.checked = radio.value === values.visibility; });
      studio.baseline = JSON.stringify(values);
    }
    find("#editor-empty").classList.add("hidden");
    find("#video-editor").classList.remove("hidden");
    find("#editor-heading").textContent = "Edit video";
    find("#editor-location").textContent = detail.has_remote ? detail.pending ? "Local changes waiting to upload" : "On your website" : "On this PC";
    showConflict(detail.remoteChanged ? "remote" : null);
    const live = find("#editor-live-link");
    live.href = `https://keppy.dev/watch?v=${encodeURIComponent(detail.id)}`;
    live.classList.toggle("hidden", !detail.has_remote || detail.visibility === "private");
    let url = detail.can_preview ? previewURL(detail.preview_url) : "";
    if (url) { const fresh = new URL(url); fresh.searchParams.set("studio_revision", detail.revision); url = fresh.href; }
    const player = find("#editor-player");
    const previewLink = find("#editor-preview-link");
    previewLink.classList.toggle("hidden", !url);
    if (url) previewLink.href = url;
    else previewLink.removeAttribute("href");
    const wasID = player.dataset.videoId;
    find("#editor-player-wrap").classList.toggle("hidden", !url);
    find("#editor-no-player").classList.toggle("hidden", Boolean(url));
    if (url && (wasID !== detail.id || player.getAttribute("src") !== url)) {
      player.src = url;
      player.dataset.videoId = detail.id;
    } else if (!url) {
      player.removeAttribute("src");
      delete player.dataset.videoId;
    }
    updateThumbnail(detail);
    updateState();
    renderLibrary();
  }

  function rowFor(video) {
    let row = studio.rows.get(video.id);
    if (!row) {
      row = document.createElement("button");
      row.type = "button";
      row.className = "video-row";
      row.dataset.id = video.id;
      const thumb = document.createElement("span");
      thumb.className = "video-row-thumb";
      thumb.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      copy.className = "video-row-copy";
      const title = document.createElement("span");
      title.className = "video-row-title";
      const meta = document.createElement("span");
      meta.className = "video-row-meta";
      copy.append(title, meta);
      row.append(thumb, copy);
      row.addEventListener("click", () => { if (studio.selected !== row.dataset.id) withDraftGuard(() => selectVideo(row.dataset.id)); });
      studio.rows.set(video.id, row);
    }
    row.setAttribute("aria-pressed", String(video.id === studio.selected));
    row.querySelector(".video-row-title").textContent = video.title || "Untitled video";
    const place = video.pending ? "Not uploaded" : video.has_remote ? "Online" : "On this PC";
    row.querySelector(".video-row-meta").textContent = `${visibilityText[video.visibility] || "Private"} · ${place}`;
    const thumb = row.querySelector(".video-row-thumb");
    const url = thumbnailURL(video.thumbnail_url);
    let image = thumb.querySelector("img");
    if (url) {
      if (!image) { image = document.createElement("img"); image.alt = ""; image.loading = "lazy"; thumb.replaceChildren(image); }
      if (image.src !== url) image.src = url;
    } else if (image || thumb.textContent !== "a") thumb.textContent = "a";
    return row;
  }

  function renderLibrary() {
    const list = find("#video-list");
    const term = find("#library-search").value.toLocaleLowerCase().trim();
    const filtered = studio.videos.filter((video) => `${video.title || ""} ${Array.isArray(video.tags) ? video.tags.join(" ") : video.tags || ""}`.toLocaleLowerCase().includes(term));
    const wanted = new Set(filtered.map((video) => video.id));
    [...list.children].forEach((row) => { if (!wanted.has(row.dataset.id)) row.remove(); });
    filtered.forEach((video, index) => {
      const row = rowFor(video);
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    });
    find("#library-count").textContent = `${filtered.length} ${filtered.length === 1 ? "video" : "videos"}`;
    if (!studio.listAbort) status("#library-status", filtered.length ? "" : term ? "No matching videos." : "No videos yet. Start a new upload, or refresh online.");
  }

  async function loadLibrary(remote = false) {
    studio.lastListRemote = remote;
    const generation = ++studio.listRequest;
    studio.listAbort?.abort();
    const controller = new AbortController();
    studio.listAbort = controller;
    find("#library-refresh").disabled = true;
    find("#library-retry").classList.add("hidden");
    status("#library-status", remote ? "Checking your website…" : "Loading videos…");
    try {
      const data = await request(`/api/videos?remote=${remote}`, { signal: controller.signal });
      if (generation !== studio.listRequest) return;
      const videos = Array.isArray(data) ? data : data.videos;
      if (!Array.isArray(videos)) throw new Error("Couldn't read the video library.");
      studio.videos = videos.filter((video) => video && typeof video.id === "string");
      studio.listAbort = null;
      renderLibrary();
    } catch (error) {
      if (generation !== studio.listRequest || error.name === "AbortError") return;
      status("#library-status", error.message, true);
      find("#library-retry").classList.remove("hidden");
    } finally {
      if (generation === studio.listRequest) { studio.listAbort = null; find("#library-refresh").disabled = false; }
    }
  }

  function withDraftGuard(action) {
    if (studio.busy) { status("#editor-save-state", "Finishing your save…"); return; }
    if (!studio.dirty) { action(); return; }
    studio.pendingAction = action;
    find("#draft-prompt").classList.remove("hidden");
  }

  async function openVideos(id = null) {
    if (typeof setTab === "function") setTab("videos");
    await loadLibrary(false);
    if (id && id !== studio.selected) withDraftGuard(() => selectVideo(id));
  }

  async function selectVideo(id) {
    if (studio.selected === id && studio.detail) return;
    const generation = ++studio.detailRequest;
    studio.detailAbort?.abort();
    const controller = new AbortController();
    studio.detailAbort = controller;
    const summary = studio.videos.find((video) => video.id === id);
    status("#library-status", "Opening video…");
    try {
      const detail = await request(`/api/videos/${encodeURIComponent(id)}?remote=${Boolean(summary?.has_remote)}`, { signal: controller.signal });
      if (generation !== studio.detailRequest) return;
      if (!detail || detail.id !== id || !detail.revision) throw new Error("Couldn't open this video. Refresh the library and try again.");
      showDetail(detail);
      const url = new URL(location.href);
      url.pathname = "/edit";
      url.searchParams.set("v", detail.id);
      url.searchParams.delete("video");
      if (url.href !== location.href) history.replaceState(history.state, "", url);
      find("#draft-prompt").classList.add("hidden");
      status("#thumbnail-status", "");
      status("#library-status", "");
    } catch (error) {
      if (generation !== studio.detailRequest || error.name === "AbortError") return;
      status("#library-status", error.message, true);
    } finally { if (generation === studio.detailRequest) studio.detailAbort = null; }
  }

  function replaceSummary(detail) {
    const index = studio.videos.findIndex((video) => video.id === detail.id);
    if (index >= 0) studio.videos[index] = detail;
    else studio.videos.unshift(detail);
  }

  function mutationError(error, selector = "#editor-save-state") {
    const current = error.current;
    if (current && current.id === studio.selected && typeof current.revision === "string" && current.revision) {
      // A failed upload may already have saved a newer local revision. Keep
      // both the typed draft and its original baseline while adopting that
      // server state, so retry never uses an obsolete revision.
      replaceSummary(current);
      showDetail(current, { preserveFields: true });
    }
    status(selector, error.message, true);
    if (error.status === 409) showConflict(studio.detail?.remoteChanged ? "remote" : "local");
  }

  async function saveVideo(publish) {
    if (!studio.detail || studio.busy) return;
    const draft = fields();
    if (!draft.title.trim()) { status("#editor-save-state", "Give the video a title first.", true); return; }
    const id = studio.detail.id;
    const before = JSON.stringify(draft);
    studio.busy = true;
    updateState(publish ? "Uploading changes…" : "Saving on this PC…");
    try {
      const detail = await request(`/api/videos/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ ...draft, revision: studio.detail.revision, publish }) });
      if (studio.selected !== id) return;
      replaceSummary(detail);
      const changedWhileSaving = JSON.stringify(fields()) !== before;
      studio.baseline = JSON.stringify(fromDetail(detail));
      showDetail(detail, { preserveFields: changedWhileSaving });
      updateState(changedWhileSaving ? "Saved. Your newest edits still need saving." : publish ? draft.visibility === "public" ? "Published · website updated" : "Uploaded · website updated" : "Saved on this PC · website unchanged");
    } catch (error) { if (studio.selected === id) mutationError(error); }
    finally { studio.busy = false; refreshButtons(); }
  }

  function refreshButtons() {
    find("#editor-save").disabled = !studio.detail || studio.busy || !studio.dirty;
    find("#editor-publish").disabled = !studio.detail || studio.busy || Boolean(studio.detail.remoteChanged);
    find("#edit-thumbnail-file").disabled = studio.busy || !studio.detail;
    find("#edit-frame-apply").disabled = studio.busy || !studio.detail;
    find("#conflict-reload").disabled = studio.busy;
    find("#editor-form").setAttribute("aria-busy", String(studio.busy));
  }

  async function saveThumbnail(payload) {
    if (!studio.detail || studio.busy) return;
    const id = studio.detail.id;
    studio.busy = true;
    refreshButtons();
    status("#thumbnail-status", "Preparing thumbnail…");
    try {
      const detail = await request(`/api/videos/${encodeURIComponent(id)}/thumbnail`, { method: "POST", body: JSON.stringify({ ...payload, revision: studio.detail.revision, publish: false }) });
      if (studio.selected !== id) return;
      replaceSummary(detail);
      showDetail(detail, { preserveFields: true });
      status("#thumbnail-status", "Thumbnail saved on this PC. Upload changes to update the website.");
    } catch (error) { if (studio.selected === id) mutationError(error, "#thumbnail-status"); }
    finally { studio.busy = false; refreshButtons(); }
  }

  async function chooseThumbnail(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const videoID = studio.selected;
    try {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Choose a JPG, PNG, or WebP image.");
      if (file.size > 12 * 1024 * 1024) throw new Error("Choose an image smaller than 12 MB.");
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("Couldn't read that image.")); reader.readAsDataURL(file); });
      if (studio.selected === videoID) await saveThumbnail({ image_base64: String(data).split(",")[1], content_type: file.type, filename: file.name });
    } catch (error) { status("#thumbnail-status", error.message, true); }
    finally { event.target.value = ""; }
  }

  async function useFrame() {
    const source = find("#edit-frame-source").value.trim().replace(/^["']|["']$/g, "");
    const rawFrame = find("#edit-frame-number").value;
    const frame = Number(rawFrame);
    if (!source) { status("#thumbnail-status", "Choose a source video first.", true); return; }
    if (!/^\d+$/.test(rawFrame) || !Number.isSafeInteger(frame) || frame < 1) { status("#thumbnail-status", "Use a whole frame number, starting at 1.", true); return; }
    await saveThumbnail({ source_path: source, frame });
  }

  async function reloadLatest() {
    if (!studio.detail || studio.busy) return;
    const remote = studio.conflictMode === "remote";
    withDraftGuard(async () => {
      studio.busy = true;
      refreshButtons();
      status("#editor-save-state", remote ? "Loading the latest online version…" : "Loading the saved version…");
      try {
        const path = `/api/videos/${encodeURIComponent(studio.detail.id)}`;
        const latest = await request(`${path}?remote=false`);
        const detail = remote ? await request(`${path}/reload`, { method: "POST", body: JSON.stringify({ revision: latest.revision }) }) : latest;
        replaceSummary(detail);
        showDetail(detail);
        status("#editor-save-state", remote ? "Latest online version loaded" : "Saved version loaded");
      } catch (error) { mutationError(error); }
      finally { studio.busy = false; refreshButtons(); }
    });
  }

  function installScrollbar(scrollport, page = false) {
    const host = page ? document.body : document.createElement("div");
    if (!page) { host.className = "scroll-host"; scrollport.before(host); host.append(scrollport); }
    const thumb = document.createElement("div");
    thumb.className = page ? "scroll-thumb page-scroll-thumb" : "scroll-thumb";
    thumb.tabIndex = 0;
    thumb.setAttribute("role", "scrollbar");
    thumb.setAttribute("aria-label", page ? "Page scroll" : scrollport.getAttribute("aria-label") || "Scroll content");
    thumb.setAttribute("aria-orientation", "vertical");
    if (!scrollport.id) scrollport.id = `studio-scroll-${document.querySelectorAll(".scroll-thumb").length}`;
    thumb.setAttribute("aria-controls", scrollport.id);
    thumb.hidden = true;
    host.append(thumb);
    let metrics = { height: 0, travel: 0, range: 0 }, drag = null, queued = false;
    const readTop = () => page ? window.scrollY : scrollport.scrollTop;
    const writeTop = (value) => page ? window.scrollTo(window.scrollX, value) : (scrollport.scrollTop = value);
    const paint = () => {
      queued = false;
      const height = page ? window.innerHeight : scrollport.clientHeight;
      const range = Math.max(0, scrollport.scrollHeight - height);
      const size = Math.min(height, Math.max(44, height * height / Math.max(1, scrollport.scrollHeight)));
      metrics = { height, travel: Math.max(0, height - size), range };
      thumb.hidden = range < 1 || height < 1;
      if (thumb.hidden) return;
      thumb.style.height = `${size}px`;
      thumb.style.transform = `translateY(${metrics.travel * Math.min(range, Math.max(0, readTop())) / range}px)`;
      thumb.setAttribute("aria-valuemin", "0");
      thumb.setAttribute("aria-valuemax", String(Math.round(range)));
      thumb.setAttribute("aria-valuenow", String(Math.round(readTop())));
    };
    const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
    (page ? window : scrollport).addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    new ResizeObserver(schedule).observe(scrollport);
    new MutationObserver(schedule).observe(page ? document.querySelector("main") : scrollport, { childList: true, subtree: true, characterData: true });
    if (scrollport.matches("textarea")) scrollport.addEventListener("input", schedule);
    thumb.addEventListener("pointerdown", (event) => { if (event.button !== 0 || !metrics.travel) return; event.preventDefault(); event.stopPropagation(); drag = { y: event.clientY, top: readTop(), range: metrics.range, travel: metrics.travel }; thumb.setPointerCapture(event.pointerId); thumb.classList.add("dragging"); });
    thumb.addEventListener("pointermove", (event) => { if (!drag) return; event.preventDefault(); event.stopPropagation(); writeTop(drag.top + (event.clientY - drag.y) * drag.range / drag.travel); });
    const stop = (event) => { if (!drag) return; event.stopPropagation(); drag = null; thumb.classList.remove("dragging"); if (thumb.hasPointerCapture(event.pointerId)) thumb.releasePointerCapture(event.pointerId); };
    thumb.addEventListener("pointerup", stop);
    thumb.addEventListener("pointercancel", stop);
    thumb.addEventListener("lostpointercapture", stop);
    thumb.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); });
    thumb.addEventListener("keydown", (event) => { const positions = { ArrowDown: readTop() + 40, ArrowUp: readTop() - 40, PageDown: readTop() + metrics.height * .8, PageUp: readTop() - metrics.height * .8, Home: 0, End: metrics.range }; if (!Object.hasOwn(positions, event.key)) return; event.preventDefault(); writeTop(positions[event.key]); });
    schedule();
  }

  function bind() {
    find("#library-search").addEventListener("input", renderLibrary);
    find("#library-refresh").addEventListener("click", () => loadLibrary(true));
    find("#library-retry").addEventListener("click", () => loadLibrary(studio.lastListRemote));
    find("#library-new").addEventListener("click", () => { if (typeof setTab === "function") setTab("encode"); });
    editable.forEach((selector) => all(selector).forEach((field) => field.addEventListener("input", () => {
      if (studio.detailAbort) { ++studio.detailRequest; studio.detailAbort.abort(); studio.detailAbort = null; status("#library-status", "Opening cancelled. Your edits are still here."); }
      updateState();
    })));
    find("#editor-form").addEventListener("submit", (event) => { event.preventDefault(); saveVideo(false); });
    find("#editor-publish").addEventListener("click", () => saveVideo(true));
    find("#draft-keep").addEventListener("click", () => { studio.pendingAction = null; find("#draft-prompt").classList.add("hidden"); });
    find("#draft-discard").addEventListener("click", () => { const action = studio.pendingAction; studio.pendingAction = null; find("#draft-prompt").classList.add("hidden"); if (studio.detail) { const values = JSON.parse(studio.baseline); find("#edit-title").value = values.title; find("#edit-description").value = values.description; find("#edit-tags").value = values.tags.join(", "); all('input[name="edit-visibility"]').forEach((radio) => { radio.checked = radio.value === values.visibility; }); updateState(); } action?.(); });
    find("#conflict-reload").addEventListener("click", reloadLatest);
    find("#edit-thumbnail-file").addEventListener("change", chooseThumbnail);
    find("#editor-thumb-preview").addEventListener("error", () => { find("#editor-thumb-preview").hidden = true; find("#editor-thumb-placeholder").hidden = false; });
    find("#thumbnail-frame-toggle").addEventListener("click", () => { const button = find("#thumbnail-frame-toggle"); const open = button.getAttribute("aria-expanded") !== "true"; button.setAttribute("aria-expanded", String(open)); find("#thumbnail-frame-fields").classList.toggle("hidden", !open); if (open && !find("#edit-frame-source").value) find("#edit-frame-source").value = find("#source-path").value; });
    find("#edit-frame-browse").addEventListener("click", async () => { try { const result = await request("/api/browse", { method: "POST", body: "{}" }); if (result.path) find("#edit-frame-source").value = result.path; } catch (error) { status("#thumbnail-status", error.message, true); } });
    find("#edit-frame-apply").addEventListener("click", useFrame);
    window.addEventListener("beforeunload", (event) => { if (!studio.dirty && !studio.busy) return; event.preventDefault(); event.returnValue = ""; });
    window.addEventListener("aida:encode-done", (event) => { if (event.detail.ok) openVideos(event.detail.video_id || null); });
    window.addEventListener("aida:open-videos", () => openVideos());
    all("textarea, .log, .overlay-scroll").forEach((scrollport) => installScrollbar(scrollport));
    installScrollbar(document.documentElement, true);
  }

  bind();
  loadLibrary(false).then(() => { const params = new URLSearchParams(location.search); const id = params.get("v") || params.get("video"); if (id && studio.videos.some((video) => video.id === id)) { if (typeof setTab === "function") setTab("videos"); selectVideo(id); } });
})();
