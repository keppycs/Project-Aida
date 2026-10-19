const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  encodeRunning: false,
  maintRunning: false,
  lastDedupe: null,
  lastSync: null,
  probeTimer: null,
  probeRequest: null,
  cloudMode: "unknown",
  eventsReady: false,
};

const TAB_KEY = "aida-admin-tab";
const SOURCE_PATH_KEY = "aida-admin-source-path";
const confirmDialog = window.AidaUI.createDialog($("#confirm-dialog"));

const encodeBars = {};
$$("#encode-progress .progress-row").forEach((row) => {
  encodeBars[row.dataset.stage] = row.querySelector("progress");
});

function setTab(name) {
  const valid = [...$$(".tab")].some((tab) => !tab.hidden && tab.dataset.tab === name);
  if (!valid) return;

  $$(".tab").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  $$(".panel").forEach((panel) => {
    const active = panel.id === `panel-${name}`;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });

  localStorage.setItem(TAB_KEY, name);
  window.dispatchEvent(new CustomEvent("aida:tab-change", { detail: { name } }));
}

function normalizePath(raw) {
  return raw.trim().replace(/^["']|["']$/g, "");
}

function titleFromPath(path) {
  const name = path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function maybeFillTitle(path) {
  const title = $("#title");
  if (title.value.trim()) return;
  const derived = titleFromPath(path);
  if (derived) title.value = derived;
}

function saveSourcePath() {
  const path = normalizePath($("#source-path").value);
  if (path) localStorage.setItem(SOURCE_PATH_KEY, path);
  else localStorage.removeItem(SOURCE_PATH_KEY);
}

function restoreSourcePath() {
  const saved = localStorage.getItem(SOURCE_PATH_KEY);
  if (!saved) return;
  $("#source-path").value = saved;
  maybeFillTitle(saved);
  probeSource();
}

function syncThumbFrameField() {
  const enabled = $("#opt-thumbnails").checked && !state.encodeRunning;
  $("#thumb-frame").disabled = !enabled;
  $("#thumb-frame-wrap").classList.toggle("disabled", !enabled);
}

function setEncodeBusy(busy) {
  state.encodeRunning = busy;
  $("#start-pipeline").disabled = busy || !state.eventsReady;
  $("#source-path").disabled = busy;
  $("#browse-source").disabled = busy;
  $("#title").disabled = busy;
  $("#video-id").disabled = busy;
  $("#description").disabled = busy;
  $("#tags").disabled = busy;
  $("#visibility").disabled = busy;
  $$('#upload-visibility input[type="radio"]').forEach(input => { input.disabled = busy; });
  $("#opt-thumbnails").disabled = busy;
  $("#opt-upload").disabled = busy;
  $("#opt-delete").disabled = busy;
  $("#opt-fast").disabled = busy;
  syncThumbFrameField();
}

function setMaintBusy(busy) {
  state.maintRunning = busy;
  $("#scan-bucket").disabled = busy || !state.eventsReady;
  $("#apply-dedupe").disabled = busy || !state.eventsReady || !canApplyDedupe();
  $("#dedupe-prefix").disabled = busy;
  $("#sync-preview").disabled = busy || !state.eventsReady;
  $("#sync-apply").disabled = busy || !state.eventsReady;
}

function canApplyDedupe() {
  const result = state.lastDedupe;
  if (!result || !result.has_duplicates || result.applied) return false;
  return $("#dedupe-prefix").value.trim() === (result.prefix || "");
}

function appendLog(target, message) {
  const el = $(target);
  const following = el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
  const selection = getSelection();
  const reading = selection && !selection.isCollapsed && el.contains(selection.anchorNode);
  el.append(document.createTextNode(`${message}\n`));
  if (following && !reading) el.scrollTop = el.scrollHeight;
}

function restoreLog(target, text) {
  const el = $(target), existing = el.textContent;
  if (existing === text) return;
  const following = el.scrollHeight - el.clientHeight - el.scrollTop <= 2, top = el.scrollTop;
  const selection = getSelection();
  const reading = selection && !selection.isCollapsed && el.contains(selection.anchorNode);
  if (text.startsWith(existing)) el.append(document.createTextNode(text.slice(existing.length)));
  else el.textContent = text;
  if (following && !reading) el.scrollTop = el.scrollHeight;
  else el.scrollTop = top;
}

function resetEncodeProgress() {
  Object.values(encodeBars).forEach((bar) => {
    bar.removeAttribute("value");
    bar.value = 0;
  });
}

function showEncodePanels() {
  $("#encode-progress").classList.remove("hidden");
  $("#encode-log").classList.remove("hidden");
}

function showMaintPanels() {
  $("#maint-progress").classList.remove("hidden");
  $("#maint-log").classList.remove("hidden");
}

function setStatus(el, text, ok = null) {
  const node = $(el);
  node.textContent = text;
  node.classList.remove("ok", "error");
  if (ok === true) node.classList.add("ok");
  if (ok === false) node.classList.add("error");
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (options.method && !["GET", "HEAD"].includes(options.method.toUpperCase())) {
    headers["X-Aida-Session"] = document.querySelector('meta[name="aida-session"]')?.content || "";
  }
  const res = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || data.message || res.statusText);
  }
  return data;
}

function formatProbe(info) {
  const hdr = info.is_hdr ? "HDR" : "SDR";
  return (
    `${info.width}×${info.height} · ${info.fps.toFixed(1)} fps · ` +
    `${hdr} · ${info.source_codec.toUpperCase()} · ${info.duration.toFixed(1)}s`
  );
}

async function loadDefaults() {
  const defaults = await api("/api/defaults");
  $("#opt-thumbnails").checked = defaults.gen_thumbnails;
  $("#opt-upload").checked = defaults.upload_to_b2;
  $("#opt-delete").checked = defaults.delete_after_upload;
  $("#opt-fast").checked = defaults.fast_transcode;
  syncThumbFrameField();

  const choices = $("#upload-visibility-options");
  choices.replaceChildren();
  defaults.visibilities.forEach((value) => {
    const label = document.createElement("label"), input = document.createElement("input"), text = document.createElement("span");
    input.type = "radio"; input.name = "upload-visibility"; input.value = value;
    input.checked = value === "private";
    input.disabled = state.encodeRunning;
    text.textContent = value.charAt(0).toUpperCase() + value.slice(1);
    input.addEventListener("change", () => { if (input.checked) $("#visibility").value = value; });
    label.append(input, text); choices.append(label);
  });
}

async function loadCredentials() {
  try {
    const creds = await api("/api/credentials");
    state.cloudMode = creds.cloud_mode === "central" ? "central" : "legacy";
    const legacy = state.cloudMode === "legacy";
    $("#legacy-credentials").hidden = !legacy;
    $("#cloud-connection").hidden = legacy;
    $("#tab-maint").hidden = !legacy;
    if (localStorage.getItem(TAB_KEY) === "maint") setTab(legacy ? "maint" : "videos");
    if (!legacy) {
      setStatus("#cloud-connection-status", "Connected through secure uploader", true);
      return;
    }
    $("#cr-key").value = creds.key_id;
    $("#cr-secret").value = creds.app_key;
    $("#cr-secret").placeholder = creds.configured ? "Saved — leave blank to keep" : "Application key";
    $("#cr-bucket").value = creds.bucket;
    $("#cr-endpoint").value = creds.endpoint;
    setStatus(
      "#creds-status",
      creds.configured
        ? "All four credentials are configured."
        : "Missing credentials — fill in all fields and save.",
    );
  } catch (err) {
    state.cloudMode = "unavailable";
    $("#legacy-credentials").hidden = true;
    $("#tab-maint").hidden = true;
    $("#cloud-connection").hidden = false;
    setStatus("#cloud-connection-status", err.message, false);
  }
}

async function probeSource() {
  state.probeRequest?.abort();
  const request = new AbortController();
  state.probeRequest = request;
  const path = normalizePath($("#source-path").value);
  if (!path) {
    $("#source-info").textContent = "";
    saveSourcePath();
    return;
  }
  try {
    const info = await api("/api/probe", {
      method: "POST",
      body: JSON.stringify({ path }),
      signal: request.signal,
    });
    if (request.signal.aborted || path !== normalizePath($("#source-path").value)) return;
    $("#source-info").textContent = formatProbe(info);
    maybeFillTitle(path);
    saveSourcePath();
  } catch (err) {
    if (request.signal.aborted || path !== normalizePath($("#source-path").value)) return;
    $("#source-info").textContent = `Probe error: ${err.message}`;
  }
}

async function browseSource() {
  try {
    const res = await api("/api/browse", { method: "POST", body: "{}" });
    if (!res.path) return;
    $("#source-path").value = res.path;
    await probeSource();
  } catch (err) {
    $("#source-info").textContent = `Browse error: ${err.message}`;
  }
}

function handleProgress(event) {
  if (event.channel === "encode") {
    const bar = encodeBars[event.stage];
    if (bar && event.total > 0) {
      bar.value = event.current / event.total;
    }
    return;
  }

  if (event.channel === "maint") {
    const bar = $("#maint-bar");
    const status = $("#maint-status");
    if (event.phase === "scan") {
      if (event.total <= 0) {
        bar.removeAttribute("value");
        status.textContent = `Scanning bucket… ${event.current.toLocaleString()} version entries listed`;
      } else {
        bar.value = 1;
        status.textContent = `Scan complete — ${event.current.toLocaleString()} version entries listed`;
      }
    } else if (event.phase === "delete" && event.total > 0) {
      bar.value = event.current / event.total;
      status.textContent = `Deleting old versions… ${event.current.toLocaleString()}/${event.total.toLocaleString()}`;
    }
  }
}

function handleDedupeResult(result) {
  state.lastDedupe = result;
  $("#dedupe-summary").textContent = result.summary || "";
  setMaintBusy(state.maintRunning);

  if (result.error) {
    $("#maint-status").textContent = result.error;
    return;
  }
  if (result.has_duplicates && !result.applied) {
    $("#maint-status").textContent =
      `Scan complete — ${result.keys_with_duplicates.toLocaleString()} duplicate key(s) ready to delete`;
    $("#maint-bar").value = 1;
  } else if (!result.has_duplicates) {
    $("#maint-status").textContent = "Bucket is clean — no duplicates found";
    $("#maint-bar").value = 1;
  }
}

function handleSyncResult(result) {
  state.lastSync = result;
  $("#sync-summary").textContent = result.summary || "";
  setMaintBusy(state.maintRunning);

  if (result.error) {
    $("#maint-status").textContent = result.error;
    return;
  }

  if (!result.apply) {
    $("#maint-status").textContent = result.has_changes
      ? `Preview complete — ${result.changed_count.toLocaleString()} file(s) would change`
      : "Preview complete — everything already in sync";
    $("#maint-bar").value = 1;
    return;
  }

  if (result.upload) {
    $("#maint-status").textContent = result.has_changes
      ? `Synced ${result.changed_count.toLocaleString()} file(s) and uploaded to B2`
      : "Catalog in sync — index uploaded to B2";
  } else {
    $("#maint-status").textContent = result.has_changes
      ? `Synced ${result.changed_count.toLocaleString()} metadata file(s) locally`
      : "Local metadata already in sync";
  }
  $("#maint-bar").value = 1;
}

function applyJobEvent(event, replay = false) {
    if (event.type === "log" && !replay) {
      if (event.channel === "encode") appendLog("#encode-log-body", event.message);
      if (event.channel === "maint") appendLog("#maint-log-body", event.message);
    }

    if (event.type === "progress") handleProgress(event);

    if (event.type === "encode_start") {
      resetEncodeProgress();
      if (!replay) $("#encode-log-body").textContent = "";
      showEncodePanels();
      setEncodeBusy(true);
      setStatus("#encode-status", "Running pipeline…");
    }

    if (event.type === "encode_done") {
      setEncodeBusy(false);
      setStatus("#encode-status", event.message, event.ok);
      if (!replay) window.dispatchEvent(new CustomEvent("aida:encode-done", { detail: event }));
    }

    if (event.type === "maint_start") {
      showMaintPanels();
      if (event.apply && !replay) {
        $("#maint-log-body").textContent = "";
      }
      setMaintBusy(true);
      $("#maint-bar").removeAttribute("value");
      if (event.job === "sync") {
        if (event.upload) {
          $("#maint-status").textContent = "Syncing catalog and uploading to B2…";
        } else if (event.apply) {
          $("#maint-status").textContent = "Syncing catalog locally…";
        } else {
          $("#maint-status").textContent = "Previewing catalog sync…";
        }
      } else {
        $("#maint-status").textContent = event.apply ? "Deleting old versions…" : "Scanning bucket…";
      }
    }

    if (event.type === "dedupe_result") handleDedupeResult(event);
    if (event.type === "sync_result") handleSyncResult(event);

    if (event.type === "maint_done") {
      setMaintBusy(false);
      if (event.message) $("#dedupe-summary").textContent = event.message;
      if (event.ok === false) $("#maint-status").textContent = event.message;
    }
}

function waitingForJobStatus(message) {
  state.eventsReady = false;
  $("#start-pipeline").disabled = true;
  for (const selector of ["#scan-bucket", "#apply-dedupe", "#sync-preview", "#sync-apply"]) $(selector).disabled = true;
  setStatus("#encode-status", message);
  $("#maint-status").textContent = message;
}

function connectEvents() {
  const source = new EventSource("/api/events");
  source.onmessage = msg => {
    let event;
    try { event = JSON.parse(msg.data); }
    catch { waitingForJobStatus("Studio sent unreadable status. Reconnecting…"); source.close(); setTimeout(connectEvents, 2000); return; }
    if (event.type === "job_snapshot" && Array.isArray(event.events)) {
      state.eventsReady = true;
      setEncodeBusy(false); setMaintBusy(false);
      setStatus("#encode-status", ""); $("#maint-status").textContent = "";
      for (const saved of event.events) applyJobEvent(saved, true);
      for (const channel of ["encode", "maint"]) {
        if (event.events.some(saved => saved.type === `${channel}_start`)) {
          restoreLog(`#${channel}-log-body`, event.events.filter(saved => saved.type === "log" && saved.channel === channel).map(saved => `${saved.message}\n`).join(""));
        }
      }
    } else applyJobEvent(event);
  };
  source.onerror = () => {
    waitingForJobStatus("Connection interrupted. Reconnecting… Last known progress is kept.");
  };
}

function parseThumbnailFrame() {
  if (!$("#opt-thumbnails").checked) return null;
  const raw = $("#thumb-frame").value.trim();
  if (!raw) return null;
  const frame = Number.parseInt(raw, 10);
  if (!Number.isFinite(frame) || frame < 1) {
    throw new Error("Thumbnail frame must be a whole number of at least 1.");
  }
  return frame;
}

async function startPipeline() {
  const path = normalizePath($("#source-path").value);
  if (!path) {
    setStatus("#encode-status", "Select a video file first.", false);
    return;
  }

  let thumbnailFrame = null;
  try {
    thumbnailFrame = parseThumbnailFrame();
  } catch (err) {
    setStatus("#encode-status", err.message, false);
    return;
  }

  try {
    await api("/api/pipeline", {
      method: "POST",
      body: JSON.stringify({
        path,
        title: $("#title").value,
        video_id: $("#video-id").value,
        description: $("#description").value,
        tags: $("#tags").value,
        visibility: $("#visibility").value,
        upload_to_b2: $("#opt-upload").checked,
        gen_thumbnails: $("#opt-thumbnails").checked,
        delete_after_upload: $("#opt-delete").checked,
        fast_transcode: $("#opt-fast").checked,
        thumbnail_frame: thumbnailFrame,
      }),
    });
  } catch (err) {
    setStatus("#encode-status", err.message, false);
  }
}

async function scanBucket() {
  if (state.cloudMode !== "legacy") return;
  try {
    await api("/api/dedupe/scan", {
      method: "POST",
      body: JSON.stringify({ prefix: $("#dedupe-prefix").value }),
    });
  } catch (err) {
    $("#dedupe-summary").textContent = err.message;
  }
}

function openConfirmDialog() {
  if (state.cloudMode !== "legacy") return;
  const result = state.lastDedupe;
  if (!result || !result.has_duplicates) {
    $("#dedupe-summary").textContent = "Scan the bucket first.";
    return;
  }

  const reclaimedMib = result.bytes_reclaimed / (1024 * 1024);
  $("#confirm-text").textContent =
    `This will permanently delete ${result.versions_to_delete} old version(s) ` +
    `across ${result.keys_with_duplicates} key(s), reclaiming about ` +
    `${reclaimedMib.toFixed(1)} MiB. The newest version of each file is kept.`;
  confirmDialog.open();
}

async function applyDedupe() {
  if (state.cloudMode !== "legacy") return;
  try {
    await api("/api/dedupe/apply", {
      method: "POST",
      body: JSON.stringify({ prefix: $("#dedupe-prefix").value }),
    });
  } catch (err) {
    $("#dedupe-summary").textContent = err.message;
  }
}

async function syncCatalog(mode) {
  const paths = {
    preview: "/api/sync/preview",
    apply: "/api/sync/apply",
    upload: "/api/sync/upload",
  };
  try {
    await api(paths[mode], { method: "POST", body: "{}" });
  } catch (err) {
    $("#sync-summary").textContent = err.message;
  }
}

async function saveCredentials() {
  if (state.cloudMode !== "legacy") return;
  try {
    const res = await api("/api/credentials", {
      method: "POST",
      body: JSON.stringify({
        key_id: $("#cr-key").value,
        app_key: $("#cr-secret").value,
        bucket: $("#cr-bucket").value,
        endpoint: $("#cr-endpoint").value,
      }),
    });
    setStatus("#creds-status", res.message, true);
  } catch (err) {
    setStatus("#creds-status", err.message, false);
  }
}

function bindUi() {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setTab(tab.dataset.tab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...$$(".tab")].filter(tab => !tab.hidden);
      const index = tabs.indexOf(tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      setTab(tabs[next].dataset.tab);
      tabs[next].focus();
    });
  });

  $("#opt-thumbnails").addEventListener("change", syncThumbFrameField);

  $("#source-path").addEventListener("input", () => {
    state.probeRequest?.abort();
    $("#source-info").textContent = $("#source-path").value.trim() ? "Reading source…" : "";
    clearTimeout(state.probeTimer);
    state.probeTimer = setTimeout(probeSource, 400);
  });

  $("#browse-source").addEventListener("click", browseSource);

  $("#dedupe-prefix").addEventListener("input", () => {
    $("#apply-dedupe").disabled = state.maintRunning || !state.eventsReady || !canApplyDedupe();
  });

  $("#start-pipeline").addEventListener("click", startPipeline);
  $("#scan-bucket").addEventListener("click", scanBucket);
  $("#apply-dedupe").addEventListener("click", openConfirmDialog);
  $("#confirm-delete").addEventListener("click", applyDedupe);
  $("#sync-preview").addEventListener("click", () => syncCatalog("preview"));
  $("#sync-apply").addEventListener("click", () => syncCatalog("apply"));
  $("#sync-upload").addEventListener("click", () => window.dispatchEvent(new CustomEvent("aida:open-videos")));
  $("#save-creds").addEventListener("click", saveCredentials);

  $("#toggle-secret").addEventListener("click", () => {
    const input = $("#cr-secret");
    const btn = $("#toggle-secret");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.textContent = show ? "Hide" : "Show";
    btn.title = show ? "Hide" : "Show";
    btn.setAttribute("aria-label", show ? "Hide application key" : "Show application key");
  });
}

async function init() {
  waitingForJobStatus("Connecting to Studio…");
  bindUi();
  restoreSourcePath();
  await Promise.all([loadDefaults(), loadCredentials()]);

  if (state.cloudMode === "legacy") try {
    const last = await api("/api/dedupe/last");
    if (last) handleDedupeResult(last);
  } catch {
    // no prior scan
  }

  if (state.cloudMode === "legacy") try {
    const lastSync = await api("/api/sync/last");
    if (lastSync) handleSyncResult(lastSync);
  } catch {
    // no prior sync
  }

  connectEvents();
}

init();
