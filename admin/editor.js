/* Draft saves never publish until the website save button is pressed. */
(() => {
  "use strict";
  const find = (selector) => document.querySelector(selector);
  const all = (selector) => [...document.querySelectorAll(selector)];
  const liveEditor = find('meta[name="aida-editor-mode"]')?.content === "live";
  const apiRoot = liveEditor && find('meta[name="aida-api-root"]')?.content === "/edit/api" ? "/edit/api" : "/api";
  const previewPath = liveEditor ? "/edit/preview/watch.html" : "/preview/watch.html";
  const liveActions = new Map();
  let authenticationExpired = false;
  const studio = { videos: [], rows: new Map(), selected: null, detail: null, baseline: "", dirty: false, busy: false, pendingAction: null, listRequest: 0, detailRequest: 0, listAbort: null, detailAbort: null, onlineAbort: null, lastListRemote: false, conflictMode: null };
  const visibilityText = { private: "Private", unlisted: "Unlisted", public: "Public" };
  const visibilityLabel = (detail) => detail.visibility_review_required !== true && Object.hasOwn(visibilityText, detail.visibility) ? visibilityText[detail.visibility] : "Visibility needs review";
  const editable = ["#edit-title", "#edit-description", "#edit-tags", 'input[name="edit-visibility"]'];
  const picker = { open: false, epoch: 0, operation: 0, id: null, video: null, document: null, source: "", controller: null, observer: null, callback: null, timeout: null, seekRequest: null, paints: [], ready: false, waiting: false, presented: null, exact: false, target: 0, candidate: null };

  function status(selector, message, error = false) {
    const target = find(selector);
    target.textContent = message;
    target.classList.toggle("error", error);
    target.classList.toggle("ok", !error && Boolean(message));
  }

  async function request(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...options.headers };
    if (options.method && !["GET", "HEAD"].includes(options.method.toUpperCase())) {
      if (liveEditor) headers["X-Aida-Editor"] = "1";
      else headers["X-Aida-Session"] = find('meta[name="aida-session"]')?.content || "";
    }
    const url = path.startsWith("/api/") ? `${apiRoot}${path.slice(4)}` : path;
    const response = await fetch(url, { ...options, headers, credentials: "same-origin", cache: "no-store", ...(liveEditor ? { redirect: "manual" } : {}) });
    const isJSON = response.headers.get("Content-Type")?.toLowerCase().includes("application/json");
    if (liveEditor && (response.type === "opaqueredirect" || response.status === 401 || response.status === 403 || !isJSON)) {
      showAuthenticationRequired();
      const error = new Error("Sign in again. Your edits are still here.");
      error.status = 401;
      throw error;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(typeof data.detail === "string" ? data.detail : data.message || "Couldn't complete that. Try again.");
      error.status = response.status;
      error.current = data.current;
      error.operation_id = data.operation_id;
      throw error;
    }
    return data;
  }

  function showAuthenticationRequired() {
    authenticationExpired = true;
    closeFramePicker();
    const notice = find("#auth-notice");
    if (notice) {
      const url = new URL("/edit", location.origin);
      if (studio.selected) url.searchParams.set("v", studio.selected);
      find("#auth-sign-in").href = url.href;
      notice.classList.remove("hidden");
    }
    refreshButtons();
  }

  async function checkSession({ recovery = false } = {}) {
    const retry = find("#auth-retry");
    if (retry) retry.disabled = true;
    try {
      const session = await request("/api/session");
      if (session.authenticated !== true) { showAuthenticationRequired(); return false; }
      authenticationExpired = false;
      find("#auth-notice")?.classList.add("hidden");
      refreshButtons();
      if (recovery) {
        // Refresh reads only. A failed save must always be retried by its button.
        await loadLibrary(false);
        if (authenticationExpired) return false;
        if (studio.detail) {
          if (!hasAccessiblePreview() && find("#editor-player").getAttribute("src")) find("#editor-player").src = find("#editor-player").getAttribute("src");
          updateState("Signed in. Your edits are still here. Save when ready.");
        }
        else selectInitialVideo();
      }
      return true;
    } catch (error) {
      if (error.status !== 401) {
        showAuthenticationRequired();
        status("#auth-status", "Couldn't check your sign-in. Try again.", true);
      }
      return false;
    } finally { if (retry) retry.disabled = false; }
  }

  function liveOperation(kind, payload) {
    if (!liveEditor) return payload;
    const key = `${studio.selected}:${kind}`;
    const signature = JSON.stringify(payload);
    let action = liveActions.get(key);
    if (!action || action.signature !== signature) {
      action = { signature, id: crypto.randomUUID() };
      liveActions.set(key, action);
    }
    return { ...payload, operation_id: action.id };
  }

  function completeLiveOperation(id, kind) { liveActions.delete(`${id}:${kind}`); }

  function fields() {
    return { title: find("#edit-title").value, description: find("#edit-description").value, tags: find("#edit-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean), visibility: find('input[name="edit-visibility"]:checked')?.value || "unknown" };
  }

  function fromDetail(detail) {
    return { title: String(detail.title || ""), description: String(detail.description || ""), tags: Array.isArray(detail.tags) ? detail.tags.map(String) : String(detail.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean), visibility: detail.visibility_review_required !== true && Object.hasOwn(visibilityText, detail.visibility) ? detail.visibility : "unknown" };
  }

  function thumbnailURL(raw) {
    if (!raw || typeof raw !== "string") return "";
    try {
      const url = new URL(raw, location.href);
      if (url.username || url.password) return "";
      if (url.origin === location.origin && url.pathname.startsWith("/api/video-media/")) return url.href;
      if (liveEditor && url.origin === location.origin && url.pathname.startsWith("/edit/preview/local/")) return url.href;
      if (url.origin === "https://cdn.keppy.dev" && url.pathname.startsWith("/file/ProjectAida/")) return url.href;
    } catch { /* An invalid image is shown as an empty thumbnail. */ }
    return "";
  }

  function previewURL(raw) {
    try {
      const url = new URL(raw, location.href);
      return url.origin === location.origin && url.pathname === previewPath && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }

  function hasAccessiblePreview() {
    const frame = find("#editor-player");
    try {
      return Boolean(frame.contentDocument?.getElementById("video") && new URL(frame.contentWindow.location.href).pathname === previewPath);
    } catch { return false; }
  }

  function updateCard() {
    const draft = fields();
    find("#editor-card-title").textContent = draft.title || "Untitled video";
    const frameRate = studio.detail?.frameRate;
    const frameRateLabel = typeof frameRate === "number" && Number.isFinite(frameRate) && frameRate === 120 ? `${frameRate} fps` : "120 fps required";
    find("#editor-card-visibility").textContent = `${visibilityLabel(draft)} · ${frameRateLabel}`;
    find("#visibility-help").textContent = draft.visibility === "unknown" ? "Visibility needs review. Choose Private, Unlisted or Public before saving." : draft.visibility === "private" ? "Only you can preview a private video here." : draft.visibility === "unlisted" ? "Anyone with the link can watch. It won't appear in the video list." : "Everyone can watch. It appears in the video list after publishing.";
    find("#editor-publish").textContent = liveEditor || studio.detail?.has_remote ? "Save to website" : draft.visibility === "public" ? "Publish video" : "Upload video";
    find("#editor-upload-note").textContent = liveEditor ? "Save a draft, then save to your website when ready." : studio.detail?.has_remote ? "Website saves update details and thumbnails. Your video stays in place." : "Saving locally doesn't change the website.";
  }

  function updateState(message) {
    studio.dirty = Boolean(studio.detail) && JSON.stringify(fields()) !== studio.baseline;
    updateCard();
    if (message) status("#editor-save-state", message);
    else if (studio.detail && fields().visibility === "unknown") status("#editor-save-state", "Visibility needs review");
    else if (studio.dirty) status("#editor-save-state", "Unsaved changes");
    else status("#editor-save-state", liveEditor ? studio.detail?.pending ? "Draft saved · website changes pending" : "Saved · website is up to date" : studio.detail?.pending ? studio.detail?.has_remote ? "Saved on this PC · website changes pending" : "Saved on this PC · not uploaded" : studio.detail?.has_remote ? "Saved · website is up to date" : "Saved on this PC");
    refreshButtons();
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
    paragraphs[1].textContent = remote ? liveEditor ? "Using the website version replaces your draft. Review it before saving again." : "Using the online version replaces your local edits. A backup is kept." : "Review the saved version before trying again. Loading it replaces your unsaved edits.";
    find("#conflict-reload").textContent = remote ? "Use online version" : "Review saved version";
  }

  function showDetail(detail, { preserveFields = false, preservePreview = false } = {}) {
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
    find("#editor-location").textContent = liveEditor ? detail.pending ? "Draft changes waiting to save to your website" : "On your website" : detail.has_remote ? detail.pending ? "Changes waiting to save to your website" : "On your website" : "On this PC";
    showConflict(detail.remoteChanged ? "remote" : null);
    const live = find("#editor-live-link");
    live.href = `https://keppy.dev/watch?v=${encodeURIComponent(detail.id)}`;
    live.classList.toggle("hidden", !detail.has_remote || !["public", "unlisted"].includes(fromDetail(detail).visibility));
    let url = detail.can_preview ? previewURL(detail.preview_url) : "";
    if (url) { const fresh = new URL(url); fresh.searchParams.set("studio_revision", detail.revision); url = fresh.href; }
    const player = find("#editor-player");
    const wasID = player.dataset.videoId;
    if (preservePreview && wasID === detail.id) url = previewURL(player.getAttribute("src")) || url;
    const previewLink = find("#editor-preview-link");
    previewLink.classList.toggle("hidden", !url);
    if (url) {
      const pageURL = new URL(url);
      pageURL.searchParams.delete("embed");
      previewLink.href = pageURL.href;
      pageURL.searchParams.set("embed", "1");
      url = pageURL.href;
    }
    else previewLink.removeAttribute("href");
    find("#editor-player-wrap").classList.toggle("hidden", !url);
    find("#editor-no-player").classList.toggle("hidden", Boolean(url));
    if (url && (wasID !== detail.id || (!preservePreview && player.getAttribute("src") !== url) || !player.getAttribute("src"))) {
      closeFramePicker();
      player.src = url;
      player.dataset.videoId = detail.id;
    } else if (!url) {
      closeFramePicker();
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
    const place = liveEditor ? video.pending ? "Draft changes" : "Online" : video.pending ? video.has_remote ? "Changes on this PC" : "On this PC" : video.has_remote ? "Online" : "On this PC";
    row.querySelector(".video-row-meta").textContent = `${visibilityLabel(video)} · ${place}`;
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
    if (!studio.listAbort) status("#library-status", filtered.length ? "" : term ? "No matching videos." : liveEditor ? "No videos yet. Upload a video from Studio on your PC." : "No videos yet. Start a new upload, or refresh online.");
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
    stopOnlineCheck();
    const controller = new AbortController();
    studio.detailAbort = controller;
    closeFramePicker();
    // Library entries contain the same detail as a local GET. Paint that
    // snapshot now; revision checks still protect saves if it became stale.
    const cached = studio.videos.find(video => video.id === id && video.revision);
    if (cached) openDetail(cached);
    else status("#library-status", "Opening video…");
    try {
      const detail = await request(`/api/videos/${encodeURIComponent(id)}?remote=false`, { signal: controller.signal });
      if (generation !== studio.detailRequest) return;
      if (!detail || detail.id !== id || !detail.revision) throw new Error("Couldn't open this video. Refresh the library and try again.");
      replaceSummary(detail);
      openDetail(detail, { preservePreview: Boolean(cached), preserveFields: Boolean(cached) && JSON.stringify(fromDetail(detail)) === studio.baseline });
      // Checking storage is optional background work, never an opening gate.
      void checkOnline(id, generation);
    } catch (error) {
      if (generation !== studio.detailRequest || error.name === "AbortError") return;
      status("#library-status", error.message, true);
    } finally { if (generation === studio.detailRequest) studio.detailAbort = null; }
  }

  function openDetail(detail, options) {
    showDetail(detail, options);
    const url = new URL(location.href);
    url.pathname = "/edit";
    url.searchParams.set("v", detail.id);
    url.searchParams.delete("video");
    if (url.href !== location.href) history.replaceState(history.state, "", url);
    find("#draft-prompt").classList.add("hidden");
    status("#thumbnail-status", "");
    status("#library-status", "");
  }

  function stopOnlineCheck() {
    studio.onlineAbort?.abort();
    studio.onlineAbort = null;
  }

  function stopDetailRead() {
    if (!studio.detailAbort) return;
    ++studio.detailRequest;
    studio.detailAbort.abort();
    studio.detailAbort = null;
  }

  async function checkOnline(id, generation) {
    stopOnlineCheck();
    const controller = new AbortController();
    studio.onlineAbort = controller;
    const revision = studio.detail.revision;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 8000);
    try {
      const detail = await request(`/api/videos/${encodeURIComponent(id)}?check_online=true`, { signal: controller.signal });
      if (controller.signal.aborted || generation !== studio.detailRequest || studio.selected !== id || studio.detail.revision !== revision || studio.busy) return;
      if (!detail || detail.id !== id || !detail.revision) throw new Error("Couldn't check online status. You can keep editing.");
      replaceSummary(detail);
      const sameFields = JSON.stringify(fromDetail(detail)) === studio.baseline;
      if (studio.dirty && !sameFields) {
        // Keep the revision on which the draft was based. A save must still
        // detect these unseen online changes instead of overwriting them.
        status("#library-status", "Online details changed. Your edits are still here.");
        return;
      }
      // A passive status check must not restart playback or the frame picker.
      showDetail(detail, { preserveFields: sameFields || studio.dirty, preservePreview: true });
      status("#library-status", detail.online_check_error || "");
    } catch (error) {
      if (generation !== studio.detailRequest || studio.selected !== id || (controller.signal.aborted && !timedOut)) return;
      status("#library-status", timedOut ? "Online check is taking too long. You can keep editing." : "Couldn't check online status. You can keep editing.");
    } finally {
      clearTimeout(timeout);
      if (studio.onlineAbort === controller) studio.onlineAbort = null;
    }
  }

  function replaceSummary(detail) {
    const index = studio.videos.findIndex((video) => video.id === detail.id);
    if (index >= 0) studio.videos[index] = detail;
    else studio.videos.unshift(detail);
  }

  function mutationError(error, selector = "#editor-save-state") {
    const current = error.current;
    const journalRetry = liveEditor && error.status >= 500 && typeof error.operation_id === "string";
    if (error.status !== 409 && !journalRetry && current && current.id === studio.selected && typeof current.revision === "string" && current.revision) {
      // A failed upload may already have saved a newer local revision. Keep
      // both the typed draft and its original baseline while adopting that
      // server state, so retry never uses an obsolete revision.
      replaceSummary(current);
      showDetail(current, { preserveFields: true });
    }
    status(selector, error.message, true);
    if (error.status === 409) showConflict(current?.remoteChanged || studio.detail?.remoteChanged ? "remote" : "local");
  }

  async function saveVideo(publish) {
    if (!studio.detail || studio.busy || authenticationExpired) return;
    stopDetailRead();
    stopOnlineCheck();
    const draft = fields();
    if (!Object.hasOwn(visibilityText, draft.visibility)) { status("#editor-save-state", "Visibility needs review. Choose Private, Unlisted or Public before saving.", true); return; }
    if (!draft.title.trim()) { status("#editor-save-state", "Give the video a title first.", true); return; }
    const id = studio.detail.id;
    const before = JSON.stringify(draft);
    studio.busy = true;
    const updatingWebsite = liveEditor || Boolean(studio.detail.has_remote);
    updateState(publish ? updatingWebsite ? "Saving to website…" : "Uploading video…" : liveEditor ? "Saving draft…" : "Saving on this PC…");
    try {
      const detail = await request(`/api/videos/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(liveOperation(publish ? "publish" : "save", { ...draft, revision: studio.detail.revision, publish })) });
      if (studio.selected !== id) return;
      completeLiveOperation(id, publish ? "publish" : "save");
      replaceSummary(detail);
      const changedWhileSaving = JSON.stringify(fields()) !== before;
      studio.baseline = JSON.stringify(fromDetail(detail));
      showDetail(detail, { preserveFields: changedWhileSaving });
      updateState(changedWhileSaving ? "Saved. Your newest edits still need saving." : publish ? updatingWebsite ? "Saved to website · website updated" : draft.visibility === "public" ? "Published video · website updated" : "Uploaded video · website updated" : liveEditor ? "Draft saved · website unchanged" : "Saved on this PC · website unchanged");
    } catch (error) { if (studio.selected === id) mutationError(error); }
    finally { studio.busy = false; refreshButtons(); }
  }

  function refreshButtons() {
    const needsVisibility = !Object.hasOwn(visibilityText, fields().visibility);
    find("#editor-save").disabled = !studio.detail || studio.busy || authenticationExpired || !studio.dirty || needsVisibility;
    find("#editor-publish").disabled = !studio.detail || studio.busy || authenticationExpired || needsVisibility || Boolean(studio.detail.remoteChanged) || studio.conflictMode === "remote";
    find("#edit-thumbnail-file").disabled = studio.busy || authenticationExpired || !studio.detail;
    refreshFrameControls();
    find("#conflict-reload").disabled = studio.busy || authenticationExpired;
    find("#editor-form").setAttribute("aria-busy", String(studio.busy));
  }

  async function saveThumbnail(payload) {
    if (!studio.detail || studio.busy || authenticationExpired) return;
    stopDetailRead();
    stopOnlineCheck();
    const id = studio.detail.id;
    studio.busy = true;
    refreshButtons();
    status("#thumbnail-status", "Preparing thumbnail…");
    try {
      const imagePayload = liveEditor ? { variants: await makeLiveThumbnailVariants(payload) } : payload;
      if (studio.selected !== id) return;
      const detail = await request(`/api/videos/${encodeURIComponent(id)}/thumbnail`, { method: "POST", body: JSON.stringify(liveOperation("thumbnail", { ...imagePayload, revision: studio.detail.revision, publish: false })) });
      if (studio.selected !== id) return;
      completeLiveOperation(id, "thumbnail");
      replaceSummary(detail);
      showDetail(detail, { preserveFields: true });
      status("#thumbnail-status", liveEditor ? "Thumbnail saved in your draft. Save to website when ready." : detail.has_remote ? "Thumbnail saved on this PC. Save to website when ready." : "Thumbnail saved on this PC. Upload the video when ready.");
    } catch (error) { if (studio.selected === id) mutationError(error, "#thumbnail-status"); }
    finally { studio.busy = false; refreshButtons(); }
  }

  async function makeLiveThumbnailVariants(payload) {
    const binary = atob(payload.image_base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const blob = new Blob([bytes], { type: payload.content_type });
    const image = await createImageBitmap(blob);
    try {
      const encode = async (type, maxWidth, maxHeight) => {
        const canvas = document.createElement("canvas");
        let scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
        // Keep each saved variant below the owner's draft storage limit.
        for (let sizeAttempt = 0; sizeAttempt < 5; ++sizeAttempt) {
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext("2d", { colorSpace: "srgb", alpha: false });
          if (!context) throw new Error("This browser couldn't prepare the thumbnail.");
          context.fillStyle = "#08090a";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          for (const quality of [type === "image/jpeg" ? .9 : .86, .76, .66, .56, .46]) {
            const encoded = await new Promise(resolve => canvas.toBlob(resolve, type, quality));
            if (!encoded || encoded.type !== type) throw new Error("This browser can't create this thumbnail format. Try a current browser.");
            if (encoded.size > 1900000) continue;
            const data = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result).split(",")[1]);
              reader.onerror = () => reject(new Error("Couldn't prepare this thumbnail."));
              reader.readAsDataURL(encoded);
            });
            return { data, type };
          }
          scale *= .8;
        }
        throw new Error("That image is too large to save. Try a smaller image.");
      };
      return {
        "thumbnail_sdr.webp": await encode("image/webp", 3840, 2160),
        "thumbnail_sdr_720p.webp": await encode("image/webp", 1280, 720),
        "thumbnail_share.jpg": await encode("image/jpeg", 1280, 720)
      };
    } finally { image.close(); }
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

  function pickerIsCurrent(epoch = picker.epoch, operation = picker.operation) {
    if (!picker.open || picker.epoch !== epoch || picker.operation !== operation || picker.id !== studio.selected || document.hidden || find("#panel-videos").hidden) return false;
    const frame = find("#editor-player");
    try {
      return Boolean(picker.video?.isConnected && frame.dataset.videoId === picker.id && frame.contentDocument === picker.document && picker.video.ownerDocument === picker.document && new URL(picker.document.location.href).searchParams.get("v") === picker.id && (!picker.source || picker.video.currentSrc === picker.source));
    } catch { return false; }
  }

  function pickerFPS() { return studio.detail?.frameRate === 120 ? 120 : null; }
  function pickerDuration() { return picker.video && Number.isFinite(picker.video.duration) && picker.video.duration > 0 ? picker.video.duration : 0; }
  function lastFrameIndex() { return Math.max(0, Math.ceil(pickerDuration() * (pickerFPS() || 120)) - 1); }
  function requestedFrameIndex() {
    const fps = pickerFPS() || 120;
    if (picker.waiting) return Math.floor(picker.target * fps + 1e-6);
    return picker.exact ? Math.round(picker.presented * fps) : Math.floor(picker.presented * fps + 1e-6);
  }
  function formatFrameTime(value) {
    const milliseconds = Math.max(0, Math.round(value * 1000));
    return `${Math.floor(milliseconds / 60000)}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, "0")}.${String(milliseconds % 1000).padStart(3, "0")}`;
  }

  function refreshFrameControls() {
    const live = pickerIsCurrent(), duration = pickerDuration(), fps = pickerFPS();
    const seekable = live && duration > 0 && picker.video.readyState >= 1 && !picker.video.error && !studio.busy && !authenticationExpired;
    const ready = seekable && picker.ready && picker.seekRequest === null && !picker.video.seeking && picker.video.readyState >= 2;
    const navigable = seekable && Number.isFinite(picker.presented) && !find("#edit-frame-canvas").hidden;
    const frame = requestedFrameIndex();
    find("#edit-frame-seek").disabled = !seekable;
    find("#edit-frame-number").disabled = !seekable || !fps;
    find("#edit-frame-prev").disabled = !navigable || !fps || frame <= 0;
    find("#edit-frame-next").disabled = !navigable || !fps || frame >= lastFrameIndex();
    find("#edit-frame-apply").disabled = !ready;
    find("#edit-frame-refresh").disabled = studio.busy || authenticationExpired;
    find("#thumbnail-frame-fields").setAttribute("aria-busy", String(picker.waiting));
    if (duration) {
      find("#edit-frame-seek").max = String(fps ? lastFrameIndex() / fps : Math.max(0, duration - .001));
      find("#edit-frame-seek").step = fps ? String(1 / fps) : ".001";
      if (fps) find("#edit-frame-number").max = String(Math.max(1, Math.ceil(duration * fps)));
    }
  }

  function cancelFrameWork() {
    ++picker.operation;
    if (picker.seekRequest !== null) cancelAnimationFrame(picker.seekRequest);
    picker.seekRequest = null;
    if (picker.callback !== null && picker.video?.cancelVideoFrameCallback) picker.video.cancelVideoFrameCallback(picker.callback);
    picker.callback = null;
    clearTimeout(picker.timeout);
    picker.timeout = null;
    picker.paints.forEach(cancelAnimationFrame);
    picker.paints = [];
    picker.ready = false;
    picker.waiting = false;
    picker.candidate = null;
  }

  function closeFramePicker({ restoreFocus = false } = {}) {
    cancelFrameWork();
    ++picker.epoch;
    picker.controller?.abort();
    picker.controller = null;
    picker.observer?.disconnect();
    picker.observer = null;
    picker.open = false;
    picker.id = null;
    picker.video = null;
    picker.document = null;
    picker.source = "";
    picker.presented = null;
    const canvas = find("#edit-frame-canvas");
    canvas.hidden = true;
    canvas.getContext("2d", { colorSpace: "srgb" })?.clearRect(0, 0, canvas.width, canvas.height);
    delete canvas.dataset.frameTime;
    delete canvas.dataset.frameExact;
    find("#thumbnail-frame-fields").classList.add("hidden");
    find("#thumbnail-frame-toggle").setAttribute("aria-expanded", "false");
    refreshFrameControls();
    if (restoreFocus) find("#thumbnail-frame-toggle").focus({ preventScroll: true });
  }

  function frameUnavailable(message) {
    cancelFrameWork();
    const canvas = find("#edit-frame-canvas");
    canvas.hidden = true;
    delete canvas.dataset.frameTime;
    delete canvas.dataset.frameExact;
    const placeholder = find("#edit-frame-placeholder");
    placeholder.textContent = message;
    placeholder.hidden = false;
    status("#edit-frame-status", message, true);
    refreshFrameControls();
  }

  function paintDecodedFrame(time, exact, epoch, operation) {
    if (!pickerIsCurrent(epoch, operation) || picker.seekRequest !== null || picker.video.seeking || picker.video.readyState < 2 || !picker.video.videoWidth || !picker.video.videoHeight || !Number.isFinite(time)) return;
    const canvas = find("#edit-frame-canvas");
    const scale = Math.min(1, 1920 / picker.video.videoWidth, 1080 / picker.video.videoHeight);
    try {
      const width = Math.max(1, Math.round(picker.video.videoWidth * scale));
      const height = Math.max(1, Math.round(picker.video.videoHeight * scale));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const context = canvas.getContext("2d", { colorSpace: "srgb", alpha: false });
      if (!context) throw new Error("Canvas unavailable");
      context.drawImage(picker.video, 0, 0, canvas.width, canvas.height);
      // Verify that this frame can actually be exported before enabling Use.
      context.getImageData(0, 0, 1, 1);
    } catch {
      frameUnavailable("This video frame couldn't be copied. Refresh online and try again, or choose an image.");
      return;
    }
    clearTimeout(picker.timeout);
    picker.timeout = null;
    picker.ready = true;
    picker.waiting = false;
    picker.presented = time;
    picker.exact = exact;
    canvas.hidden = false;
    canvas.dataset.frameTime = String(time);
    canvas.dataset.frameExact = String(exact);
    find("#edit-frame-placeholder").hidden = true;
    find("#edit-frame-time").textContent = formatFrameTime(time);
    if (!picker.scrubbing) find("#edit-frame-seek").value = String(time);
    const fps = pickerFPS();
    find("#edit-frame-number").value = fps ? String(Math.max(1, (exact ? Math.round(time * fps) : Math.floor(time * fps + 1e-6)) + 1)) : "";
    find("#edit-frame-number-label").textContent = fps ? exact ? "Frame number" : "Approximate frame" : "Frame number · requires 120 fps";
    status("#edit-frame-status", exact ? "This is the frame your thumbnail will use. SDR preview." : "Decoded frame preview. Frame number is approximate in this browser. SDR preview.");
    refreshFrameControls();
  }

  function fallbackDecodedFrame(epoch, operation) {
    picker.paints.push(requestAnimationFrame(() => {
      picker.paints.push(requestAnimationFrame(() => {
        if (pickerIsCurrent(epoch, operation) && !picker.ready) paintDecodedFrame(picker.video.currentTime, false, epoch, operation);
      }));
    }));
  }

  function presentedTimeMatchesTarget(time) {
    if (!Number.isFinite(time)) return false;
    const fps = pickerFPS();
    return fps ? Math.round(time * fps) === Math.floor(picker.target * fps + 1e-6) : Math.abs(time - picker.target) <= .001;
  }

  function requestPresentedFrame(epoch, operation) {
    const video = picker.video;
    if (!pickerIsCurrent(epoch, operation) || typeof video.requestVideoFrameCallback !== "function") return;
    picker.callback = video.requestVideoFrameCallback((_now, metadata) => {
      picker.callback = null;
      if (!pickerIsCurrent(epoch, operation)) return;
      // A callback queued before a seek can still carry the previous frame.
      // Its PTS must match this seek before it can label a canvas snapshot.
      if (picker.seekRequest !== null || !presentedTimeMatchesTarget(metadata.mediaTime)) { requestPresentedFrame(epoch, operation); return; }
      picker.candidate = metadata.mediaTime;
      if (!video.seeking) paintDecodedFrame(metadata.mediaTime, true, epoch, operation);
    });
  }

  function waitForDecodedFrame(target) {
    cancelFrameWork();
    picker.waiting = true;
    picker.target = target;
    const epoch = picker.epoch, operation = picker.operation, video = picker.video;
    if (!Number.isFinite(picker.presented) || find("#edit-frame-canvas").hidden) {
      const placeholder = find("#edit-frame-placeholder");
      placeholder.textContent = "Loading frame…";
      placeholder.hidden = false;
      status("#edit-frame-status", "Loading frame…");
    }
    requestPresentedFrame(epoch, operation);
    picker.timeout = setTimeout(() => {
      if (!pickerIsCurrent(epoch, operation)) return;
      if (!video.seeking && video.readyState >= 2) fallbackDecodedFrame(epoch, operation);
      else frameUnavailable("The video is still loading. Refresh online and try again.");
    }, 8000);
    refreshFrameControls();
  }

  function seekFrame(time) {
    if (!pickerIsCurrent() || studio.busy || !Number.isFinite(time) || !pickerDuration()) return;
    const fps = pickerFPS();
    const index = fps ? Math.min(lastFrameIndex(), Math.max(0, Math.round(time * fps))) : null;
    // Seek within the selected frame's presentation interval, rather than
    // accidentally landing on the previous interval at a rounded boundary.
    let target = fps ? (index + .25) / fps : Math.min(pickerDuration() - .001, Math.max(0, time));
    target = Math.min(pickerDuration() - .00001, target);
    if (Math.abs(target - picker.video.currentTime) < .00001) target = Math.max(0, target - .0001);
    picker.video.pause();
    waitForDecodedFrame(target);
    const epoch = picker.epoch, operation = picker.operation;
    picker.seekRequest = requestAnimationFrame(() => {
      if (!pickerIsCurrent(epoch, operation)) return;
      picker.seekRequest = null;
      try { picker.video.currentTime = target; }
      catch { frameUnavailable("This part of the video isn't ready. Try another position or refresh online."); }
    });
  }

  function stepFrame(direction) {
    const fps = pickerFPS();
    if (pickerIsCurrent() && fps && Number.isFinite(picker.presented)) seekFrame((requestedFrameIndex() + direction) / fps);
  }

  function attachFrameVideo() {
    if (!picker.open || picker.id !== studio.selected) return;
    const frame = find("#editor-player");
    let doc, video;
    try { doc = frame.contentDocument; video = doc?.getElementById("video"); }
    catch { frameUnavailable("Refresh online to load this video's preview, then choose a frame."); return; }
    if (!video || video.tagName !== "VIDEO") {
      status("#edit-frame-status", "Waiting for the video preview. Refresh online if it doesn't load.");
      return;
    }
    picker.controller?.abort();
    picker.controller = new AbortController();
    picker.observer?.disconnect();
    picker.document = doc;
    picker.video = video;
    picker.source = video.currentSrc;
    const epoch = picker.epoch, options = { signal: picker.controller.signal };
    picker.observer = new MutationObserver(() => {
      if (picker.open && picker.epoch === epoch && doc.getElementById("video") !== video) frameUnavailable("The video preview changed. Close this picker and choose a frame again.");
    });
    picker.observer.observe(video.parentElement, { childList: true });
    const ready = () => {
      if (!picker.open || picker.epoch !== epoch || picker.id !== studio.selected) return;
      picker.source = video.currentSrc;
      refreshFrameControls();
      if (video.error) { frameUnavailable("The video couldn't load. Refresh online and try again."); return; }
      if (video.readyState >= 2 && !video.seeking && !picker.waiting && !picker.ready) seekFrame(video.currentTime);
    };
    video.addEventListener("loadedmetadata", ready, options);
    video.addEventListener("loadeddata", ready, options);
    video.addEventListener("canplay", ready, options);
    video.addEventListener("durationchange", refreshFrameControls, options);
    video.addEventListener("play", () => { if (pickerIsCurrent(epoch)) video.pause(); }, options);
    video.addEventListener("seeking", () => {
      if (!pickerIsCurrent(epoch)) return;
      video.pause();
      if (picker.seekRequest !== null) return;
      if (!picker.waiting || Math.abs(picker.target - video.currentTime) > .0001) waitForDecodedFrame(video.currentTime);
    }, options);
    video.addEventListener("seeked", () => {
      if (!pickerIsCurrent(epoch)) return;
      if (picker.candidate !== null && presentedTimeMatchesTarget(picker.candidate)) paintDecodedFrame(picker.candidate, true, epoch, picker.operation);
      else if (typeof video.requestVideoFrameCallback !== "function") fallbackDecodedFrame(epoch, picker.operation);
    }, options);
    for (const name of ["emptied", "loadstart"]) video.addEventListener(name, () => {
      if (picker.epoch !== epoch) return;
      cancelFrameWork();
      picker.source = video.currentSrc;
      find("#edit-frame-canvas").hidden = true;
      find("#edit-frame-placeholder").hidden = false;
      find("#edit-frame-placeholder").textContent = "Loading video…";
      status("#edit-frame-status", "Loading video…");
      refreshFrameControls();
    }, options);
    video.addEventListener("error", () => { if (picker.epoch === epoch) frameUnavailable("The video couldn't load. Refresh online and try again."); }, options);
    video.pause();
    ready();
  }

  function openFramePicker() {
    closeFramePicker();
    if (!studio.detail || authenticationExpired) return;
    picker.open = true;
    picker.id = studio.selected;
    picker.scrubbing = false;
    find("#thumbnail-frame-fields").classList.remove("hidden");
    find("#thumbnail-frame-toggle").setAttribute("aria-expanded", "true");
    find("#edit-frame-placeholder").textContent = "Loading video…";
    find("#edit-frame-placeholder").hidden = false;
    find("#edit-frame-time").textContent = "0:00.000";
    find("#edit-frame-number").value = "";
    status("#edit-frame-status", "Loading this video's frames…");
    if (!studio.detail.can_preview) { frameUnavailable("Refresh online to load this video's preview, then choose a frame."); return; }
    const epoch = picker.epoch;
    picker.timeout = setTimeout(() => {
      if (picker.open && picker.epoch === epoch && picker.id === studio.selected && !picker.ready) frameUnavailable("The video preview hasn't loaded. Refresh online and try again.");
    }, 8000);
    attachFrameVideo();
    refreshFrameControls();
  }

  function seekFrameNumber() {
    const raw = find("#edit-frame-number").value;
    const frame = Number(raw), max = Math.ceil(pickerDuration() * 120);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(frame) || frame < 1 || frame > max || !pickerFPS()) { status("#edit-frame-status", "Choose a frame number within this video.", true); return; }
    if (picker.ready && picker.exact && frame === Math.round(picker.presented * 120) + 1) return;
    if (picker.waiting && frame === Math.floor(picker.target * 120 + 1e-6) + 1) return;
    seekFrame((frame - 1) / 120);
  }

  async function useFrame() {
    if (!pickerIsCurrent() || !picker.ready || picker.video.seeking || studio.busy) return;
    const epoch = picker.epoch, operation = picker.operation, id = picker.id, presented = picker.presented;
    const canvas = find("#edit-frame-canvas");
    try {
      const blob = await new Promise(resolveBlob => canvas.toBlob(resolveBlob, "image/jpeg", .9));
      if (!blob) throw new Error("Couldn't prepare this frame. Try another frame.");
      const base64 = await new Promise((resolveData, reject) => { const reader = new FileReader(); reader.onload = () => resolveData(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("Couldn't prepare this frame.")); reader.readAsDataURL(blob); });
      if (!pickerIsCurrent(epoch, operation) || !picker.ready || picker.presented !== presented || picker.video.seeking || id !== studio.selected) return;
      const stamp = Math.round(presented * 1000);
      await saveThumbnail({ image_base64: base64, content_type: "image/jpeg", filename: `frame-${id}-${stamp}.jpg` });
    } catch (error) { if (pickerIsCurrent(epoch, operation)) status("#edit-frame-status", error.message, true); }
  }

  function refreshFrameVideo() {
    if (!studio.detail || studio.busy) return;
    withDraftGuard(refreshSelectedFrameVideo);
  }

  async function refreshSelectedFrameVideo() {
    const id = studio.selected;
    const generation = ++studio.detailRequest;
    studio.detailAbort?.abort();
    stopOnlineCheck();
    const controller = new AbortController();
    studio.detailAbort = controller;
    closeFramePicker();
    status("#thumbnail-status", "Refreshing this video…");
    try {
      const detail = await request(`/api/videos/${encodeURIComponent(id)}?remote=true`, { signal: controller.signal });
      if (studio.selected !== id || generation !== studio.detailRequest) return;
      replaceSummary(detail);
      showDetail(detail);
      openFramePicker();
      status("#thumbnail-status", "");
    } catch (error) {
      if (studio.selected !== id) return;
      if (error.name === "AbortError") status("#thumbnail-status", "Refresh cancelled. Your edits are still here.");
      else if (generation === studio.detailRequest) status("#thumbnail-status", error.message, true);
    } finally { if (generation === studio.detailRequest) studio.detailAbort = null; }
  }

  async function reloadLatest() {
    if (!studio.detail || studio.busy) return;
    const remote = studio.conflictMode === "remote";
    withDraftGuard(async () => {
      stopDetailRead();
      stopOnlineCheck();
      studio.busy = true;
      refreshButtons();
      status("#editor-save-state", remote ? "Loading the latest online version…" : "Loading the saved version…");
      try {
        const path = `/api/videos/${encodeURIComponent(studio.detail.id)}`;
        const latest = await request(`${path}?remote=false`);
        const detail = remote ? await request(`${path}/reload`, { method: "POST", body: JSON.stringify(liveOperation("reload", { revision: latest.revision })) }) : latest;
        if (remote) completeLiveOperation(studio.detail.id, "reload");
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
    find("#library-new")?.addEventListener("click", () => { if (typeof setTab === "function") setTab("encode"); });
    find("#auth-retry")?.addEventListener("click", () => checkSession({ recovery: true }));
    editable.forEach((selector) => all(selector).forEach((field) => field.addEventListener("input", () => {
      if (studio.detailAbort) { stopDetailRead(); status("#library-status", ""); }
      updateState();
    })));
    find("#editor-form").addEventListener("submit", (event) => { event.preventDefault(); saveVideo(false); });
    find("#editor-publish").addEventListener("click", () => saveVideo(true));
    find("#draft-keep").addEventListener("click", () => { studio.pendingAction = null; find("#draft-prompt").classList.add("hidden"); });
    find("#draft-discard").addEventListener("click", () => { const action = studio.pendingAction; studio.pendingAction = null; find("#draft-prompt").classList.add("hidden"); if (studio.detail) { const values = JSON.parse(studio.baseline); find("#edit-title").value = values.title; find("#edit-description").value = values.description; find("#edit-tags").value = values.tags.join(", "); all('input[name="edit-visibility"]').forEach((radio) => { radio.checked = radio.value === values.visibility; }); updateState(); } action?.(); });
    find("#conflict-reload").addEventListener("click", reloadLatest);
    find("#edit-thumbnail-file").addEventListener("change", chooseThumbnail);
    find("#editor-thumb-preview").addEventListener("error", () => { find("#editor-thumb-preview").hidden = true; find("#editor-thumb-placeholder").hidden = false; });
    find("#thumbnail-frame-toggle").addEventListener("click", () => { if (picker.open) closeFramePicker({ restoreFocus: true }); else openFramePicker(); });
    find("#edit-frame-close").addEventListener("click", () => closeFramePicker({ restoreFocus: true }));
    find("#edit-frame-seek").addEventListener("input", (event) => seekFrame(Number(event.target.value)));
    find("#edit-frame-seek").addEventListener("pointerdown", () => { picker.scrubbing = true; });
    for (const event of ["pointerup", "pointercancel"]) find("#edit-frame-seek").addEventListener(event, () => { picker.scrubbing = false; if (picker.ready) find("#edit-frame-seek").value = String(picker.presented); });
    find("#edit-frame-number").addEventListener("change", seekFrameNumber);
    find("#edit-frame-number").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); seekFrameNumber(); } });
    find("#edit-frame-prev").addEventListener("click", () => stepFrame(-1));
    find("#edit-frame-next").addEventListener("click", () => stepFrame(1));
    find("#edit-frame-apply").addEventListener("click", useFrame);
    find("#edit-frame-refresh").addEventListener("click", refreshFrameVideo);
    find("#thumbnail-frame-fields").addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeFramePicker({ restoreFocus: true }); } });
    find("#editor-player").addEventListener("load", () => {
      if (liveEditor && find("#editor-player").getAttribute("src") && !hasAccessiblePreview()) void checkSession();
      if (!picker.open) return;
      if (picker.document) closeFramePicker();
      else attachFrameVideo();
    });
    window.addEventListener("aida:tab-change", (event) => { if (event.detail.name !== "videos") closeFramePicker(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) closeFramePicker(); });
    window.addEventListener("beforeunload", (event) => { if (!studio.dirty && !studio.busy) return; event.preventDefault(); event.returnValue = ""; });
    window.addEventListener("aida:encode-done", (event) => { if (event.detail.ok) openVideos(event.detail.video_id || null); });
    window.addEventListener("aida:open-videos", () => openVideos());
    all("textarea, .log, .overlay-scroll").forEach((scrollport) => installScrollbar(scrollport));
    installScrollbar(document.documentElement, true);
  }

  bind();
  function selectInitialVideo() {
    const params = new URLSearchParams(location.search);
    const id = params.get("v") || params.get("video");
    if (id && studio.videos.some((video) => video.id === id)) {
      if (typeof setTab === "function") setTab("videos");
      selectVideo(id);
    }
  }

  async function start() {
    if (liveEditor && !await checkSession()) return;
    await loadLibrary(false);
    selectInitialVideo();
  }
  void start();
})();
