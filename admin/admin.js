const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  encodeRunning: false,
  maintRunning: false,
  lastDedupe: null,
  lastSync: null,
  probeTimer: null,
};

const TAB_KEY = "aida-admin-tab";
const SOURCE_PATH_KEY = "aida-admin-source-path";

const encodeBars = {};
$$("#encode-progress .progress-row").forEach((row) => {
  encodeBars[row.dataset.stage] = row.querySelector("progress");
});

function setTab(name) {
  const valid = [...$$(".tab")].some((tab) => tab.dataset.tab === name);
  if (!valid) return;

  $$(".tab").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  $$(".panel").forEach((panel) => {
    const active = panel.id === `panel-${name}`;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });

  localStorage.setItem(TAB_KEY, name);
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
  $("#start-pipeline").disabled = busy;
  $("#source-path").disabled = busy;
  $("#browse-source").disabled = busy;
  $("#title").disabled = busy;
  $("#video-id").disabled = busy;
  $("#description").disabled = busy;
  $("#tags").disabled = busy;
  $("#visibility").disabled = busy;
  $("#opt-thumbnails").disabled = busy;
  $("#opt-upload").disabled = busy;
  $("#opt-delete").disabled = busy;
  $("#opt-fast").disabled = busy;
  syncThumbFrameField();
}

function setMaintBusy(busy) {
  state.maintRunning = busy;
  $("#scan-bucket").disabled = busy;
  $("#apply-dedupe").disabled = busy || !canApplyDedupe();
  $("#dedupe-prefix").disabled = busy;
  $("#sync-preview").disabled = busy;
  $("#sync-apply").disabled = busy;
  $("#sync-upload").disabled = busy;
}

function canApplyDedupe() {
  const result = state.lastDedupe;
  if (!result || !result.has_duplicates || result.applied) return false;
  return $("#dedupe-prefix").value.trim() === (result.prefix || "");
}

function appendLog(target, message) {
  const el = $(target);
  el.textContent += `${message}\n`;
  el.scrollTop = el.scrollHeight;
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
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
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

  const select = $("#visibility");
  select.replaceChildren();
  defaults.visibilities.forEach((value) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    opt.selected = value === defaults.visibility;
    select.appendChild(opt);
  });
}

async function loadCredentials() {
  try {
    const creds = await api("/api/credentials");
    $("#cr-key").value = creds.key_id;
    $("#cr-secret").value = creds.app_key;
    $("#cr-bucket").value = creds.bucket;
    $("#cr-endpoint").value = creds.endpoint;
    setStatus(
      "#creds-status",
      creds.configured
        ? "All four credentials are configured."
        : "Missing credentials — fill in all fields and save.",
    );
  } catch (err) {
    setStatus("#creds-status", `Failed to load credentials: ${err.message}`, false);
  }
}

async function probeSource() {
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
    });
    $("#source-info").textContent = formatProbe(info);
    maybeFillTitle(path);
    saveSourcePath();
  } catch (err) {
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

function connectEvents() {
  const source = new EventSource("/api/events");

  source.onmessage = (msg) => {
    const event = JSON.parse(msg.data);

    if (event.type === "log") {
      if (event.channel === "encode") appendLog("#encode-log-body", event.message);
      if (event.channel === "maint") appendLog("#maint-log-body", event.message);
    }

    if (event.type === "progress") handleProgress(event);

    if (event.type === "encode_start") {
      resetEncodeProgress();
      $("#encode-log-body").textContent = "";
      showEncodePanels();
      setEncodeBusy(true);
      setStatus("#encode-status", "Running pipeline…");
    }

    if (event.type === "encode_done") {
      setEncodeBusy(false);
      setStatus("#encode-status", event.message, event.ok);
    }

    if (event.type === "maint_start") {
      showMaintPanels();
      if (event.apply) {
        $("#maint-log-body").textContent = "";
      }
      setMaintBusy(true);
      $("#maint-bar").removeAttribute("value");
      $("#maint-bar").value = 0;
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
  };

  source.onerror = () => {
    source.close();
    setTimeout(connectEvents, 2000);
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
  $("#confirm-dialog").showModal();
}

async function applyDedupe() {
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
  });

  $("#opt-thumbnails").addEventListener("change", syncThumbFrameField);

  $("#source-path").addEventListener("input", () => {
    clearTimeout(state.probeTimer);
    state.probeTimer = setTimeout(probeSource, 400);
  });

  $("#browse-source").addEventListener("click", browseSource);

  $("#dedupe-prefix").addEventListener("input", () => {
    $("#apply-dedupe").disabled = state.maintRunning || !canApplyDedupe();
  });

  $("#start-pipeline").addEventListener("click", startPipeline);
  $("#scan-bucket").addEventListener("click", scanBucket);
  $("#apply-dedupe").addEventListener("click", openConfirmDialog);
  $("#confirm-delete").addEventListener("click", applyDedupe);
  $("#sync-preview").addEventListener("click", () => syncCatalog("preview"));
  $("#sync-apply").addEventListener("click", () => syncCatalog("apply"));
  $("#sync-upload").addEventListener("click", () => syncCatalog("upload"));
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
  bindUi();
  restoreSourcePath();
  await Promise.all([loadDefaults(), loadCredentials()]);

  try {
    const last = await api("/api/dedupe/last");
    if (last) handleDedupeResult(last);
  } catch {
    // no prior scan
  }

  try {
    const lastSync = await api("/api/sync/last");
    if (lastSync) handleSyncResult(lastSync);
  } catch {
    // no prior sync
  }

  connectEvents();
}

init();
