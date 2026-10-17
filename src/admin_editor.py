"""Owner-only loopback routes for the local library and existing Aida player."""

from __future__ import annotations

import base64
import binascii
from functools import wraps
from pathlib import Path
import re
import secrets
import subprocess
from threading import RLock
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from config import b2_configured
from video_library import MEDIA, THUMBNAILS, VIDEO_ID, VideoLibrary, VideoLibraryError, VideoNotFoundError, VideoConflictError


MAX_REQUEST_BYTES = 18 * 1024 * 1024
PROJECT_ROOT = Path(__file__).absolute().parent.parent
RANGE = re.compile(r"bytes=(?:[0-9]+-[0-9]*|-[0-9]+)\Z")
MIME = {".mpd": "application/dash+xml", ".m3u8": "application/vnd.apple.mpegurl",
        ".mp4": "video/mp4", ".fmp4": "video/mp4", ".webp": "image/webp",
        ".avif": "image/avif", ".jpg": "image/jpeg", ".json": "application/json",
        ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
        ".svg": "image/svg+xml", ".png": "image/png", ".ttf": "font/ttf", ".woff2": "font/woff2"}


def safe_file(root: Path, relative: str) -> Path:
    """Reject links and traversal before resolving or opening any target."""
    if not relative or "\\" in relative or any(part in ("", ".", "..") for part in relative.split("/")):
        raise HTTPException(404, "File not found.")
    try:
        parent = root.absolute().relative_to(PROJECT_ROOT)
    except ValueError:
        raise HTTPException(404, "File not found.") from None
    path = PROJECT_ROOT
    for part in ("", *parent.parts, *relative.split("/")):
        if part:
            path /= part
        try:
            info = path.lstat()
        except (FileNotFoundError, OSError):
            raise HTTPException(404, "File not found.") from None
        if path.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
            raise HTTPException(404, "Linked files are unavailable.")
    if not path.is_file():
        raise HTTPException(404, "File not found.")
    return path


def _local_host(raw: str) -> bool:
    try:
        parsed = urlsplit("http://" + raw)
        return bool(raw and parsed.hostname in ("localhost", "127.0.0.1", "::1")
                    and parsed.username is None and parsed.password is None
                    and not parsed.path and not parsed.query and not parsed.fragment
                    and (parsed.port is None or 1 <= parsed.port <= 65535))
    except ValueError:
        return False


def install_local_boundary(app) -> None:
    app.state.admin_token = secrets.token_urlsafe(32)

    @app.middleware("http")
    async def local_boundary(request: Request, call_next):
        host = request.headers.get("host", "")
        if not _local_host(host) or request.client is None or request.client.host not in ("127.0.0.1", "::1"):
            return JSONResponse({"detail": "This editor is available on this computer only."}, status_code=403)
        origin = request.headers.get("origin")
        if origin is not None:
            try:
                parsed = urlsplit(origin)
                valid_origin = (parsed.scheme == request.url.scheme and parsed.netloc.lower() == host.lower()
                                and not parsed.path and not parsed.query and not parsed.fragment
                                and parsed.username is None and parsed.password is None)
            except ValueError:
                valid_origin = False
            if not valid_origin:
                return JSONResponse({"detail": "Open the editor directly on this computer."}, status_code=403)
        if request.headers.get("sec-fetch-site", "").lower() == "cross-site":
            return JSONResponse({"detail": "Cross-site access is not allowed."}, status_code=403)
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            token = request.headers.get("x-aida-session", "")
            if not secrets.compare_digest(token, app.state.admin_token):
                return JSONResponse({"detail": "Reload the local editor before saving."}, status_code=403)
            try:
                length = int(request.headers.get("content-length", "0"))
            except ValueError:
                return JSONResponse({"detail": "Invalid request size."}, status_code=400)
            if length < 0 or length > MAX_REQUEST_BYTES:
                return JSONResponse({"detail": "Choose an image smaller than 12 MB."}, status_code=413)
            if len(await request.body()) > MAX_REQUEST_BYTES:
                return JSONResponse({"detail": "Choose an image smaller than 12 MB."}, status_code=413)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Referrer-Policy"] = "same-origin"
        return response


def editor_html(app, admin_dir: Path) -> HTMLResponse:
    source = safe_file(admin_dir, "index.html").read_text(encoding="utf-8")
    source = source.replace("</head>", f'<meta name="aida-session" content="{app.state.admin_token}"></head>', 1)
    return HTMLResponse(source)


class VideoEditIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(max_length=500)
    description: str = Field(default="", max_length=30000)
    tags: list[str] | str = Field(default_factory=list)
    visibility: str
    revision: str = Field(min_length=1, max_length=128)
    publish: bool = False


class RevisionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: str = Field(min_length=1, max_length=128)


class ThumbnailIn(RevisionIn):
    image_base64: str | None = None
    content_type: str = "image/jpeg"
    filename: str = "thumbnail.jpg"
    source_path: str | None = None
    frame: int | None = Field(default=None, ge=1)
    publish: bool = False


def frame_image(source_path: str, frame: int) -> bytes:
    """Extract one still; this never encodes or changes a video rendition."""
    from main import probe_source
    from thumbnail import frame_to_seek
    from config import VIDEO_EXTENSIONS

    source = Path(source_path.strip().strip('"').strip("'"))
    if not source.is_file() or source.suffix.lower() not in VIDEO_EXTENSIONS:
        raise HTTPException(400, "Choose a source video first.")
    try:
        info = probe_source(source)
        seek = frame_to_seek(frame, info["fps"], info["duration"])
    except (OSError, ValueError, RuntimeError):
        raise HTTPException(400, "Could not read that frame. Check the source video and frame number.") from None
    # Tone-map HDR stills, while retaining the video's original 120 fps streams.
    filters = "scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2"
    if info.get("is_hdr"):
        filters = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=tv," + filters
    try:
        result = subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-ss", str(seek), "-i", str(source),
            "-frames:v", "1", "-an", "-vf", filters, "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1",
        ], capture_output=True, timeout=60, check=True)
    except (OSError, subprocess.SubprocessError):
        raise HTTPException(400, "Could not make that thumbnail. Check FFmpeg or choose an image instead.") from None
    if not result.stdout or len(result.stdout) > 12 * 1024 * 1024:
        raise HTTPException(400, "Could not make a usable thumbnail.")
    return result.stdout


def install_editor(app, root: Path, library: VideoLibrary | None = None) -> None:
    app.state.video_library = library or VideoLibrary(root)
    app.state.remote_previews = set()
    app.state.local_preview_fallbacks = set()
    app.state.editor_saving = False
    editor_lock = RLock()
    router = APIRouter()

    def serial(function):
        @wraps(function)
        def serialized(*args, **kwargs):
            with editor_lock:
                app.state.editor_saving = True
                try:
                    return function(*args, **kwargs)
                finally:
                    app.state.editor_saving = False
        return serialized

    def view(data: dict) -> dict:
        video_id = data["id"]
        service = app.state.video_library
        uploaded = bool(data.get("uploaded"))
        if uploaded and data.get("remoteChecked"):
            app.state.remote_previews.add(video_id)
        local_media = False
        for codec in data.get("metadata", {}).get("codecs", []):
            if codec in ("AV1", "HEVC"):
                try:
                    local_media = service.local_asset_path(video_id, f"{codec}/manifest.mpd").is_file()
                except VideoLibraryError:
                    continue
                if local_media:
                    break
        can_preview = local_media or video_id in app.state.remote_previews
        thumbnail = data.get("thumbnail", "thumbnail_sdr.webp")
        return {**data.get("metadata", {}), **data,
                "has_local": bool(data.get("local")), "has_remote": uploaded, "can_preview": can_preview,
                "preview_url": f"/preview/watch.html?v={video_id}&local=1" if can_preview else None,
                "thumbnail_url": f"/api/video-media/{video_id}/{thumbnail}?rev={data.get('revision', '')}"}

    def idle():
        if getattr(app.state, "editor_busy", lambda: False)():
            raise HTTPException(409, "Wait for the current encode or maintenance job to finish.")

    @app.exception_handler(VideoLibraryError)
    async def library_error(request, exc):
        payload = {"detail": str(exc)}
        if request.method == "POST" and request.path_params.get("video_id"):
            try:
                payload["current"] = view(app.state.video_library.get_video(request.path_params["video_id"]))
            except VideoLibraryError:
                pass
        return JSONResponse(payload, status_code=exc.status_code)

    @router.get("/api/videos")
    @serial
    def videos(remote: bool = False, refresh: bool = False):
        service = app.state.video_library
        use_remote = remote or refresh
        if use_remote:
            idle()
        items = service.list_videos(refresh_remote=use_remote)
        if use_remote:
            app.state.local_preview_fallbacks.difference_update(item["id"] for item in items)
        return {"videos": [view(item) for item in items], "remote": use_remote}

    @router.get("/api/videos/{video_id}")
    @serial
    def video(video_id: str, remote: bool = False, check_online: bool = False):
        service = app.state.video_library
        if remote:
            idle()
            result = service.get_video(video_id, remote=True)
            app.state.local_preview_fallbacks.discard(video_id)
            return view(result)
        if check_online:
            if getattr(app.state, "editor_busy", lambda: False)():
                result = service.get_video(video_id)
                app.state.local_preview_fallbacks.add(video_id)
                return {**view(result), "online_check_error": "Online status can be checked after the current job finishes. You can edit the local copy."}
            if not b2_configured():
                result = service.get_video(video_id)
                app.state.local_preview_fallbacks.add(video_id)
                return {**view(result), "online_check_error": "Cloud storage is not configured. You can edit the local copy."}
            try:
                result = service.get_video(video_id, remote=True)
                app.state.local_preview_fallbacks.discard(video_id)
                return view(result)
            except VideoLibraryError:
                result = service.get_video(video_id)
                app.state.local_preview_fallbacks.add(video_id)
                return {**view(result), "online_check_error": "Could not check online status. Your saved local edits are kept."}
        return view(service.get_video(video_id))

    @router.post("/api/videos/{video_id}")
    @serial
    def save(video_id: str, body: VideoEditIn):
        idle()
        service = app.state.video_library
        revision = body.revision
        fields = body.model_dump(include={"title", "description", "tags", "visibility"})
        if isinstance(fields["tags"], str):
            fields["tags"] = [tag.strip() for tag in fields["tags"].split(",") if tag.strip()]
        if body.publish:
            current = service.get_video(video_id)
            if current["revision"] != revision:
                raise VideoConflictError("This video changed since you opened it. Review the current version before saving.")
            if not current.get("remoteChecked"):
                # Keep the form and its original baseline before discovering
                # cloud state. Otherwise an unsaved form could silently adopt
                # newer online metadata and immediately overwrite it.
                service.save_video(video_id, fields, revision, publish=False)
                current = service.get_video(video_id, remote=True)
                if current.get("remoteChanged"):
                    raise VideoConflictError("The online video changed. Review the latest version before uploading.")
                revision = current["revision"]
        return view(service.save_video(video_id, fields, revision, publish=body.publish))

    @router.post("/api/videos/{video_id}/reload")
    @serial
    def reload_video(video_id: str, body: RevisionIn):
        idle()
        return view(app.state.video_library.discard_draft(video_id, body.revision))

    @router.post("/api/videos/{video_id}/thumbnail")
    @serial
    def thumbnail(video_id: str, body: ThumbnailIn):
        idle()
        if bool(body.image_base64) == bool(body.source_path):
            raise HTTPException(400, "Choose one image or one source video frame.")
        if body.image_base64:
            encoded = body.image_base64
            if encoded.startswith("data:"):
                encoded = encoded.split(",", 1)[-1]
            try:
                data = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError):
                raise HTTPException(400, "That image could not be read.") from None
        else:
            if body.frame is None:
                raise HTTPException(400, "Choose a thumbnail frame.")
            data = frame_image(body.source_path, body.frame)
        return view(app.state.video_library.replace_thumbnail(video_id, data, body.filename, body.revision, publish=body.publish))

    def media(request: Request, video_id: str, asset: str):
        if not VIDEO_ID.fullmatch(video_id) or not (asset in THUMBNAILS or MEDIA.fullmatch(asset)):
            raise HTTPException(404, "File not found.")
        range_header = request.headers.get("range")
        if range_header and (len(range_header) > 100 or not RANGE.fullmatch(range_header)):
            return JSONResponse({"detail": "Invalid byte range."}, status_code=416)
        service = app.state.video_library
        details = service.get_video(video_id)
        prefer_remote = (details.get("preferRemoteAssets") and video_id in app.state.remote_previews
                         and video_id not in app.state.local_preview_fallbacks
                         and asset not in details.get("pendingThumbnails", []))
        try:
            path = service.local_asset_path(video_id, asset)
        except VideoNotFoundError:
            path = None
        if path is not None and not prefer_remote:
            return FileResponse(path, media_type=MIME.get(path.suffix, "application/octet-stream"))
        if video_id not in app.state.remote_previews:
            raise HTTPException(404, "File not found. Refresh online to preview an uploaded video.")
        try:
            result = service.remote_asset(video_id, asset, range_header=range_header)
        except VideoLibraryError:
            raise
        except Exception:
            raise HTTPException(503, "Could not load the uploaded video.") from None
        body = result["Body"]
        if result.get("ContentEncoding", "identity").lower() != "identity":
            body.close()
            raise HTTPException(503, "The video preview has an unexpected encoding.")
        headers = {"Accept-Ranges": "bytes"}
        for source, target in (("ContentLength", "Content-Length"), ("ContentRange", "Content-Range")):
            if source in result:
                headers[target] = str(result[source])
        status = 206 if result.get("ContentRange") else 200
        if request.method == "HEAD":
            body.close()
            return StreamingResponse(iter(()), status_code=status, headers=headers, media_type=MIME.get(Path(asset).suffix))

        def chunks():
            try:
                while chunk := body.read(128 * 1024):
                    yield chunk
            finally:
                body.close()
        return StreamingResponse(chunks(), status_code=status, headers=headers, media_type=MIME.get(Path(asset).suffix))

    @router.api_route("/api/video-media/{video_id}/{asset:path}", methods=["GET", "HEAD"])
    def editor_media(request: Request, video_id: str, asset: str):
        return media(request, video_id, asset)

    @router.api_route("/preview/watch.html", methods=["GET", "HEAD"])
    def preview_watch():
        return FileResponse(safe_file(root / "web", "watch.html"), media_type="text/html")

    @router.get("/preview/local/index.json")
    def preview_catalog():
        return []

    @router.api_route("/preview/local/{video_id}/metadata.json", methods=["GET", "HEAD"])
    def preview_metadata(request: Request, video_id: str):
        metadata = app.state.video_library.get_video(video_id)["metadata"]
        return JSONResponse(metadata) if request.method != "HEAD" else HTMLResponse("", media_type="application/json")

    @router.api_route("/preview/local/{video_id}/{asset:path}", methods=["GET", "HEAD"])
    def preview_media(request: Request, video_id: str, asset: str):
        return media(request, video_id, asset)

    @router.api_route("/preview/{directory}/{asset:path}", methods=["GET", "HEAD"])
    def preview_static(directory: str, asset: str):
        if directory not in ("css", "js", "assets"):
            raise HTTPException(404, "File not found.")
        return FileResponse(safe_file(root / "web", f"{directory}/{asset}"), media_type=MIME.get(Path(asset).suffix, "application/octet-stream"))

    app.include_router(router)
