"""Project Aida — FastAPI local admin interface."""

from __future__ import annotations

from collections import deque
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
import asyncio
import json
import logging
import math
import queue
import secrets
import threading
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from pydantic import BaseModel

from config import (
    VIDEO_EXTENSIONS,
    UPLOAD_TO_B2,
    GENERATE_THUMBNAILS,
    DELETE_TRANSCODES_AFTER_UPLOAD,
    FAST_TRANSCODE,
    VISIBILITY,
    VALID_VISIBILITIES,
    b2_configured,
    get_b2_config,
    save_b2_credentials,
)
from dedupe_bucket import DedupeResult, run_dedupe
from main import probe_source, run_pipeline
from sync_catalog import SyncResult, format_sync_summary, run_sync
from admin_editor import editor_html, install_editor, install_local_boundary, safe_file
from video_library import VIDEO_ID

ROOT = Path(__file__).parent.parent
ADMIN_DIR = ROOT / "admin"

_shutdown = asyncio.Event()


@asynccontextmanager
async def lifespan(app: FastAPI):
    _shutdown.clear()
    yield
    _shutdown.set()


app = FastAPI(title="Project Aida Admin", lifespan=lifespan)
_event_queue: queue.Queue[dict[str, Any]] = queue.Queue()
_job_lock = threading.Lock()
_encode_running = False
_maint_running = False
_last_dedupe_scan: DedupeResult | None = None
_last_sync_result: SyncResult | None = None

install_local_boundary(app)
install_editor(app, ROOT)
app.state.editor_busy = lambda: _encode_running or _maint_running

STAGES = ("Thumbnails", "AV1", "HEVC", "Upload")


def _normalize_path(raw: str) -> str:
    return raw.strip().strip('"').strip("'")


def _pick_file() -> str:
    """Open a native file dialog (Windows)."""
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    exts = " ".join(f"*{e}" for e in VIDEO_EXTENSIONS)
    path = filedialog.askopenfilename(
        title="Select source video",
        filetypes=[("Video files", exts), ("All files", "*.*")],
    )
    root.destroy()
    return path or ""


# ── Models ────────────────────────────────────────────────────────────────────


class CredentialsIn(BaseModel):
    key_id: str
    app_key: str
    bucket: str
    endpoint: str


class ProbeIn(BaseModel):
    path: str


class PipelineIn(BaseModel):
    path: str
    title: str = ""
    video_id: str = ""
    description: str = ""
    tags: str = ""
    visibility: str = VISIBILITY
    upload_to_b2: bool = UPLOAD_TO_B2
    gen_thumbnails: bool = GENERATE_THUMBNAILS
    delete_after_upload: bool = DELETE_TRANSCODES_AFTER_UPLOAD
    fast_transcode: bool = FAST_TRANSCODE
    thumbnail_frame: int | None = None


class DedupeScanIn(BaseModel):
    prefix: str = ""


class DedupeApplyIn(BaseModel):
    prefix: str = ""


class BrowseOut(BaseModel):
    path: str


class CredentialsOut(BaseModel):
    key_id: str
    app_key: str
    bucket: str
    endpoint: str
    configured: bool


class DefaultsOut(BaseModel):
    upload_to_b2: bool
    gen_thumbnails: bool
    delete_after_upload: bool
    fast_transcode: bool
    visibility: str
    visibilities: list[str]


# ── Event bus ─────────────────────────────────────────────────────────────────


def emit(event: dict[str, Any]) -> None:
    _event_queue.put(event)


class _LogBridge(logging.Handler):
    def __init__(self, channel: str):
        super().__init__()
        self._channel = channel

    def emit(self, record: logging.LogRecord) -> None:
        try:
            emit({
                "type": "log",
                "channel": self._channel,
                "message": self.format(record),
            })
        except Exception:
            pass


def _format_dedupe_summary(result: DedupeResult) -> str:
    if result.error and not result.has_duplicates:
        return result.error

    if not result.has_duplicates:
        return "No duplicate versions found."

    reclaimed_mib = result.bytes_reclaimed / (1024 * 1024)
    if result.applied:
        return (
            f"Deleted {result.deleted_count} old version(s) across "
            f"{result.keys_with_duplicates} key(s)."
        )

    return (
        f"{result.keys_with_duplicates} key(s) with duplicates — "
        f"{result.versions_to_delete} old version(s), "
        f"~{reclaimed_mib:.1f} MiB reclaimable."
    )


def _dedupe_to_event(result: DedupeResult) -> dict[str, Any]:
    data = asdict(result)
    data["summary"] = _format_dedupe_summary(result)
    return data


def _sync_to_event(result: SyncResult) -> dict[str, Any]:
    data = asdict(result)
    data["summary"] = format_sync_summary(result)
    return data


def _attach_logger(name: str, channel: str) -> logging.Logger:
    handler = _LogBridge(channel)
    handler.setFormatter(logging.Formatter(
        "%(asctime)s  %(levelname)-8s  %(message)s", "%Y-%m-%d %H:%M:%S",
    ))
    log = logging.getLogger(name)
    log.handlers.clear()
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    log.propagate = False
    return log


# ── Background jobs ───────────────────────────────────────────────────────────


def _run_encode_job(body: PipelineIn) -> None:
    global _encode_running

    video_file = Path(_normalize_path(body.path))
    if not video_file.is_file():
        emit({"type": "encode_done", "ok": False, "message": "File not found."})
        return

    if body.visibility not in VALID_VISIBILITIES:
        emit({
            "type": "encode_done",
            "ok": False,
            "message": f"Invalid visibility: {body.visibility!r}",
        })
        return

    emit({"type": "encode_start"})
    for stage in STAGES:
        emit({"type": "progress", "channel": "encode", "stage": stage, "current": 0, "total": 1})

    handler = _LogBridge("encode")
    handler.setFormatter(logging.Formatter(
        "%(asctime)s  %(levelname)-8s  %(message)s", "%Y-%m-%d %H:%M:%S",
    ))

    def on_progress(stage: str, current: int, total: int) -> None:
        emit({
            "type": "progress",
            "channel": "encode",
            "stage": stage,
            "current": current,
            "total": total,
        })

    try:
        run_pipeline(
            video_file=video_file,
            title=body.title.strip(),
            video_id=body.video_id.strip() or None,
            description=body.description.strip(),
            tags=body.tags.strip(),
            visibility=body.visibility,
            upload_to_b2=body.upload_to_b2,
            gen_thumbnails=body.gen_thumbnails,
            delete_after_upload=body.delete_after_upload,
            fast_transcode=body.fast_transcode,
            thumbnail_frame=body.thumbnail_frame,
            on_progress=on_progress,
            extra_log_handler=handler,
        )
        emit({"type": "encode_done", "ok": True, "message": "Video ready to edit.",
              "video_id": body.video_id, "editor_url": f"/?video={body.video_id}"})
    except Exception as exc:
        emit({"type": "encode_done", "ok": False, "message": f"Pipeline failed: {exc}"})
    finally:
        with _job_lock:
            _encode_running = False


def _run_dedupe_job(*, apply: bool, prefix: str, plans: list[dict] | None) -> None:
    global _maint_running, _last_dedupe_scan

    emit({"type": "maint_start", "job": "dedupe", "apply": apply})

    log = _attach_logger("dedupe_bucket", "maint")

    def on_progress(phase: str, current: int, total: int) -> None:
        emit({
            "type": "progress",
            "channel": "maint",
            "phase": phase,
            "current": current,
            "total": total,
        })

    try:
        result = run_dedupe(
            prefix=prefix,
            apply=apply,
            plans=plans,
            on_progress=on_progress,
            log=log,
        )
        _last_dedupe_scan = result
        payload = _dedupe_to_event(result)
        emit({"type": "dedupe_result", **payload})
        emit({
            "type": "maint_done",
            "ok": result.ok,
            "message": payload["summary"],
        })
    except Exception as exc:
        emit({"type": "maint_done", "ok": False, "message": str(exc)})
    finally:
        with _job_lock:
            _maint_running = False


def _run_sync_job(*, apply: bool, upload: bool) -> None:
    global _maint_running, _last_sync_result

    emit({"type": "maint_start", "job": "sync", "apply": apply, "upload": upload})

    log = _attach_logger("sync_catalog", "maint")

    try:
        result = run_sync(apply=apply, upload=upload, log=log)
        _last_sync_result = result
        payload = _sync_to_event(result)
        emit({"type": "sync_result", **payload})
        emit({
            "type": "maint_done",
            "ok": result.ok,
            "message": payload["summary"],
        })
    except Exception as exc:
        emit({"type": "maint_done", "ok": False, "message": str(exc)})
    finally:
        with _job_lock:
            _maint_running = False


def _start_thread(target, *args, **kwargs) -> None:
    thread = threading.Thread(target=target, args=args, kwargs=kwargs, daemon=True)
    thread.start()


# ── Routes ────────────────────────────────────────────────────────────────────


@app.get("/")
def index() -> HTMLResponse:
    return editor_html(app, ADMIN_DIR)


@app.get("/api/defaults", response_model=DefaultsOut)
def get_defaults() -> DefaultsOut:
    return DefaultsOut(
        upload_to_b2=UPLOAD_TO_B2,
        gen_thumbnails=GENERATE_THUMBNAILS,
        delete_after_upload=DELETE_TRANSCODES_AFTER_UPLOAD,
        fast_transcode=FAST_TRANSCODE,
        visibility=VISIBILITY,
        visibilities=list(VALID_VISIBILITIES),
    )


@app.get("/api/status")
def get_status() -> dict[str, Any]:
    return {
        "encode_running": _encode_running,
        "maint_running": _maint_running,
        "b2_configured": b2_configured(),
    }


@app.get("/api/credentials", response_model=CredentialsOut)
def get_credentials() -> CredentialsOut:
    creds = get_b2_config()
    return CredentialsOut(
        key_id=creds.get("B2_KEY_ID", ""),
        app_key="",
        bucket=creds.get("B2_BUCKET", ""),
        endpoint=creds.get("B2_ENDPOINT", ""),
        configured=b2_configured(),
    )


@app.post("/api/credentials")
def post_credentials(body: CredentialsIn) -> dict[str, str]:
    app_key = body.app_key.strip()
    if not app_key:
        previous = get_b2_config()
        if previous.get("B2_KEY_ID") != body.key_id.strip() or not previous.get("B2_APP_KEY"):
            raise HTTPException(status_code=400, detail="Enter the application key for this key ID.")
        app_key = previous["B2_APP_KEY"]
    try:
        save_b2_credentials(
            body.key_id.strip(),
            app_key,
            body.bucket.strip(),
            body.endpoint.strip(),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"message": "Credentials saved to keyring."}


@app.post("/api/browse", response_model=BrowseOut)
def post_browse() -> BrowseOut:
    try:
        return BrowseOut(path=_pick_file())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/probe")
def post_probe(body: ProbeIn) -> dict[str, Any]:
    path = Path(_normalize_path(body.path))
    if not path.is_file():
        raise HTTPException(status_code=400, detail="File not found.")
    try:
        return probe_source(path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/pipeline")
def post_pipeline(body: PipelineIn) -> dict[str, str]:
    global _encode_running

    if not body.path.strip():
        raise HTTPException(status_code=400, detail="Select a video file first.")

    normalized = _normalize_path(body.path)
    if not Path(normalized).is_file():
        raise HTTPException(status_code=400, detail="File not found.")

    if body.thumbnail_frame is not None and body.thumbnail_frame < 1:
        raise HTTPException(status_code=400, detail="Thumbnail frame must be at least 1.")

    video_id = body.video_id.strip() or secrets.token_urlsafe(9)
    if not VIDEO_ID.fullmatch(video_id):
        raise HTTPException(status_code=400, detail="Use letters, numbers, hyphens or underscores for the video ID.")
    # Existing videos belong in the editor; rerunning an encode must not replace
    # their saved details or ignored local media behind the user's back.
    destination = app.state.video_library._path(video_id, "metadata.json").parent
    if destination.exists():
        raise HTTPException(status_code=409, detail="That video ID already exists. Open it in Videos to edit it.")
    if body.visibility not in VALID_VISIBILITIES:
        raise HTTPException(status_code=400, detail="Choose public, unlisted or private visibility.")
    try:
        info = probe_source(Path(normalized))
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read the source video.") from None
    fps = float(info.get("fps") or 0)
    if not math.isfinite(fps) or fps != 120:
        raise HTTPException(status_code=400, detail="Aida requires a real 120 fps source. Choose a 120 fps video.")

    body = body.model_copy(update={"path": normalized, "video_id": video_id})

    with _job_lock:
        if _encode_running or _maint_running or app.state.editor_saving:
            raise HTTPException(status_code=409, detail="Wait for the current job to finish.")
        _encode_running = True

    _start_thread(_run_encode_job, body)
    return {"message": "Pipeline started.", "video_id": video_id}


@app.post("/api/dedupe/scan")
def post_dedupe_scan(body: DedupeScanIn) -> dict[str, str]:
    global _maint_running

    if not b2_configured():
        raise HTTPException(status_code=400, detail="Configure B2 credentials first.")

    with _job_lock:
        if _maint_running or _encode_running or app.state.editor_saving:
            raise HTTPException(status_code=409, detail="Maintenance job is already running.")
        _maint_running = True

    _start_thread(_run_dedupe_job, apply=False, prefix=body.prefix, plans=None)
    return {"message": "Bucket scan started."}


@app.post("/api/dedupe/apply")
def post_dedupe_apply(body: DedupeApplyIn) -> dict[str, str]:
    global _maint_running

    cached = _last_dedupe_scan
    if not cached or not cached.has_duplicates:
        raise HTTPException(status_code=400, detail="Scan the bucket first.")

    if body.prefix.strip() != cached.prefix:
        raise HTTPException(status_code=400, detail="Prefix changed — scan again before deleting.")

    with _job_lock:
        if _maint_running or _encode_running or app.state.editor_saving:
            raise HTTPException(status_code=409, detail="Maintenance job is already running.")
        _maint_running = True

    _start_thread(
        _run_dedupe_job,
        apply=True,
        prefix=body.prefix,
        plans=cached.plans,
    )
    return {"message": "Deletion started."}


@app.get("/api/dedupe/last")
def get_last_dedupe() -> dict[str, Any] | None:
    if _last_dedupe_scan is None:
        return None
    return _dedupe_to_event(_last_dedupe_scan)


@app.post("/api/sync/preview")
def post_sync_preview() -> dict[str, str]:
    global _maint_running

    with _job_lock:
        if _maint_running or _encode_running or app.state.editor_saving:
            raise HTTPException(status_code=409, detail="Maintenance job is already running.")
        _maint_running = True

    _start_thread(_run_sync_job, apply=False, upload=False)
    return {"message": "Catalog preview started."}


@app.post("/api/sync/apply")
def post_sync_apply() -> dict[str, str]:
    global _maint_running

    with _job_lock:
        if _maint_running or _encode_running or app.state.editor_saving:
            raise HTTPException(status_code=409, detail="Maintenance job is already running.")
        _maint_running = True

    _start_thread(_run_sync_job, apply=True, upload=False)
    return {"message": "Catalog sync started."}


@app.post("/api/sync/upload")
def post_sync_upload() -> dict[str, str]:
    raise HTTPException(status_code=410, detail="Open Videos and review each video's changes before uploading.")


@app.get("/api/sync/last")
def get_last_sync() -> dict[str, Any] | None:
    if _last_sync_result is None:
        return None
    return _sync_to_event(_last_sync_result)


@app.get("/api/events")
async def events(request: Request) -> StreamingResponse:
    async def stream():
        pending: deque[dict[str, Any]] = deque()
        while not _shutdown.is_set():
            if await request.is_disconnected():
                return

            try:
                while True:
                    pending.append(_event_queue.get_nowait())
            except queue.Empty:
                pass

            while pending:
                yield f"data: {json.dumps(pending.popleft())}\n\n"

            try:
                await asyncio.wait_for(_shutdown.wait(), timeout=0.1)
            except asyncio.TimeoutError:
                pass

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.api_route("/static/{asset}", methods=["GET", "HEAD"])
def admin_static(asset: str) -> FileResponse:
    if asset not in ("admin.css", "admin.js", "editor.js"):
        raise HTTPException(status_code=404, detail="File not found.")
    return FileResponse(safe_file(ADMIN_DIR, asset), media_type="text/css" if asset.endswith(".css") else "text/javascript")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "admin_app:app",
        host="127.0.0.1",
        port=8765,
        reload=True,
        reload_dirs=[str(ROOT / "src"), str(ADMIN_DIR)],
        app_dir=str(Path(__file__).parent),
        timeout_graceful_shutdown=3,
    )
