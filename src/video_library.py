"""Local owner editor. Remote reads and publication happen only when requested.

All replacements keep their previous local contents in .agent-trash. B2 writes
create versions; this module never deletes objects or their previous versions.
The local lock and revision checks prevent stale forms from silently winning.
B2 has no assumed compare-and-swap support: a future live editor must share a
single writer with this editor before claiming concurrent atomic publication.
"""

from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
import logging
import mimetypes
import os
from pathlib import Path
import re
from threading import RLock
from typing import Any, Callable
from uuid import uuid4

from admin_client import AdminClientError, VARIANTS as CENTRAL_THUMBNAILS, central_client


ROOT = Path(__file__).absolute().parent.parent
VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
MEDIA = re.compile(r"(?:AV1|HEVC)/(?:manifest\.mpd|master\.m3u8|media_[0-9]+\.m3u8|init_[0-9]+\.mp4|chunk_[0-9]+_[0-9]+\.fmp4)\Z")
THUMBNAILS = ("thumbnail_sdr.webp", "thumbnail_sdr_720p.webp", "thumbnail_hdr.avif", "thumbnail_hdr_720p.avif", "thumbnail_share.jpg")
EDITABLE = frozenset(("title", "description", "tags", "visibility"))
CATALOG_FIELDS = ("id", "title", "description", "tags", "date", "createdAt", "duration", "width", "height", "frameRate", "hdr", "codecs", "visibility")
JSON_LIMIT = 2 * 1024 * 1024
METADATA_LIMIT = 128_000
CATALOG_LIMIT = 1_000_000
_LOCK = RLock()


class VideoLibraryError(ValueError):
    status_code = 400


class VideoConflictError(VideoLibraryError):
    status_code = 409


class VideoNotFoundError(VideoLibraryError):
    status_code = 404


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def _digest(value: Any) -> str:
    return sha256(_json_bytes(value)).hexdigest()


def _bounded_json_bytes(value: Any, limit: int, label: str) -> bytes:
    body = _json_bytes(value)
    if len(body) > limit:
        raise VideoLibraryError(f"The {label} is too large for the live site. Your local draft is kept.")
    return body


def _missing(exc: Exception) -> bool:
    response = getattr(exc, "response", {})
    return str(response.get("Error", {}).get("Code", "")) in ("404", "NoSuchKey", "NotFound") or isinstance(exc, FileNotFoundError)


class VideoLibrary:
    def __init__(self, project_root: Path = ROOT, local_dir: Path | None = None, client_factory: Callable | None = None):
        self.root = Path(os.path.abspath(project_root))
        self.local = Path(os.path.abspath(local_dir or self.root / "web" / "local"))
        self.client_factory = client_factory
        self._refresh_generations: dict[str, int] = {}
        self._safe(self.local)

    def _safe(self, path: Path) -> Path:
        """Check lexical containment before touching any component or resolving it."""
        path = Path(os.path.abspath(path))
        try:
            relative = path.relative_to(self.root)
        except ValueError:
            raise VideoLibraryError("Files must stay inside this project.") from None
        current = self.root
        for part in ("", *relative.parts):
            if part:
                current /= part
            try:
                stat = current.lstat()
            except FileNotFoundError:
                continue
            if current.is_symlink() or getattr(stat, "st_file_attributes", 0) & 0x400:
                raise VideoLibraryError("Linked folders and files are not allowed here.")
        return path

    def _id(self, video_id: str) -> str:
        reserved = {"CON", "PRN", "AUX", "NUL", *(f"COM{x}" for x in range(1, 10)), *(f"LPT{x}" for x in range(1, 10))}
        if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id) or video_id.upper() in reserved:
            raise VideoLibraryError("Invalid video ID.")
        return video_id

    def _path(self, video_id: str, name: str) -> Path:
        return self._safe(self.local / self._id(video_id) / name)

    def _read(self, path: Path, default=None):
        self._safe(path)
        if not path.exists():
            return default
        if not path.is_file() or path.stat().st_size > JSON_LIMIT:
            raise VideoLibraryError("Invalid or oversized editor data.")
        try:
            return json.loads(path.read_bytes())
        except (ValueError, UnicodeError):
            raise VideoLibraryError("A saved JSON file is damaged; it was left unchanged.") from None

    def _write(self, path: Path, body: bytes) -> None:
        self._safe(path)
        if path.exists() and path.read_bytes() == body:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._safe(path.with_name(f".editor-{uuid4().hex}.tmp"))
        temporary.write_bytes(body)
        backup = None
        try:
            if path.exists():
                if not path.is_file():
                    raise VideoLibraryError("Refusing to replace a folder.")
                stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M%S_%f")
                operation = self._safe(self.root / ".agent-trash" / f"{stamp}-video-editor-{uuid4().hex[:8]}")
                backup = self._safe(operation / path.relative_to(self.root))
                backup.parent.mkdir(parents=True, exist_ok=False)
                (operation / "manifest.txt").write_text(
                    f"Original path: {path.relative_to(self.root).as_posix()}\n"
                    "Reason: save video editor changes while keeping the previous file.\n"
                    "Task: local video library/editor. Timestamp is UTC.\n"
                    "Restoration: stop an encode or editor save, preserve the replacement, then move this file back.\n",
                    encoding="utf-8",
                )
                path.rename(backup)
            temporary.rename(path)
        except Exception:
            if backup is not None and backup.exists() and not path.exists():
                backup.rename(path)
            raise
        finally:
            # Unique, reproducible serialization/image generated by this call.
            temporary.unlink(missing_ok=True)

    def _archive(self, path: Path, reason: str) -> None:
        self._safe(path)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M%S_%f")
        operation = self._safe(self.root / ".agent-trash" / f"{stamp}-{reason}-{uuid4().hex[:8]}")
        backup = self._safe(operation / path.relative_to(self.root))
        backup.parent.mkdir(parents=True, exist_ok=False)
        (operation / "manifest.txt").write_text(
            f"Original path: {path.relative_to(self.root).as_posix()}\n"
            "Reason: explicitly reload a live video and preserve its replaced thumbnail draft.\n"
            "Task: local video editor. Timestamp is UTC.\n"
            "Restoration: stop editor saves, preserve any replacement, then move this file back.\n",
            encoding="utf-8",
        )
        path.rename(backup)

    def _index(self) -> list[dict]:
        data = self._read(self.local / "index.json", [])
        if not isinstance(data, list) or any(not isinstance(item, dict) for item in data):
            raise VideoLibraryError("The local video list is damaged; it was left unchanged.")
        return data

    def _state(self, video_id: str) -> dict:
        state = self._read(self._path(video_id, ".editor-state.json"), {})
        if not isinstance(state, dict):
            raise VideoLibraryError("The saved editor state is damaged.")
        return state

    def _save_state(self, video_id: str, state: dict) -> None:
        self._write(self._path(video_id, ".editor-state.json"), _json_bytes(state))

    def _client(self):
        if self.client_factory:
            return self.client_factory()
        try:
            from upload import make_b2_client
            return make_b2_client()
        except (ImportError, RuntimeError):
            raise VideoLibraryError("Cloud storage is not configured. Save locally or configure Backblaze first.") from None

    def _remote_json(self, client, bucket: str, key: str, default=None, *, limit: int = METADATA_LIMIT):
        try:
            result = client.get_object(Bucket=bucket, Key=key)
        except Exception as exc:
            if _missing(exc):
                return default
            raise VideoLibraryError("Could not read cloud storage. Nothing was replaced.") from None
        body = result["Body"]
        try:
            raw = body.read(limit + 1)
        finally:
            close = getattr(body, "close", None)
            if close:
                close()
        if len(raw) > limit:
            raise VideoLibraryError("The cloud metadata file is too large.")
        try:
            return json.loads(raw)
        except (ValueError, UnicodeError):
            raise VideoLibraryError("The cloud metadata is damaged; it was left unchanged.") from None

    def _remote_index(self, client, bucket: str) -> list[dict]:
        data = self._remote_json(client, bucket, "index.json", [], limit=CATALOG_LIMIT)
        if not isinstance(data, list) or any(not isinstance(item, dict) for item in data):
            raise VideoLibraryError("The cloud video list is damaged; it was left unchanged.")
        return data

    @staticmethod
    def _writer():
        try:
            return central_client()
        except AdminClientError as exc:
            raise VideoLibraryError(str(exc)) from None

    def _remote_snapshot(self, video_id: str):
        writer = self._writer()
        if writer is None:
            client, bucket = self._client()
            raw = self._remote_json(client, bucket, f"{video_id}/metadata.json")
            entry = next((item for item in self._remote_index(client, bucket) if item.get("id") == video_id), None)
            return raw, entry, {}
        try:
            detail = writer.get_video(video_id)
        except AdminClientError as exc:
            raise VideoLibraryError(str(exc)) from None
        if detail is None:
            return None, None, {"writerURL": writer.url, "writerRevision": None}
        # Local Refresh online continues to mean the published version. An
        # unfinished browser draft must be reviewed there before another client
        # can overwrite it with a newly adopted revision.
        raw = detail.get("published_metadata")
        if raw is not None and not isinstance(raw, dict):
            raise VideoLibraryError("The central published metadata is invalid.")
        return raw, detail.get("entry"), {"writerURL": writer.url, "writerRevision": detail["revision"], "writerDraftPending": bool(detail.get("pending"))}

    def _metadata(self, video_id: str, metadata: dict, entry: dict | None = None) -> dict:
        if not isinstance(metadata, dict):
            raise VideoLibraryError("Invalid video metadata.")
        metadata = dict(metadata)
        # Old pipelines stored tags in the index only. Explicit metadata wins.
        for field in ("tags", "date", "hdr"):
            if field not in metadata and entry and field in entry:
                metadata[field] = entry[field]
        metadata["id"] = video_id
        if "visibility" not in metadata:
            metadata["visibility"] = "unlisted" if metadata.get("unlisted") else (entry or {}).get("visibility", "private")
        if metadata["visibility"] not in ("public", "unlisted", "private"):
            metadata["visibility"] = "private"
        metadata.pop("unlisted", None)
        metadata.setdefault("description", "")
        metadata.setdefault("tags", [])
        return metadata

    def _view(self, video_id: str) -> dict:
        state = self._state(video_id)
        local_metadata = self._read(self._path(video_id, "metadata.json"))
        entry = next((item for item in self._index() if item.get("id") == video_id), None)
        chosen = local_metadata
        if not state.get("pending") and state.get("remoteMetadata") is not None and _digest(local_metadata) == state.get("localAtRefresh"):
            chosen = state["remoteMetadata"]
        if chosen is None:
            chosen = state.get("remoteMetadata")
        if chosen is None:
            raise VideoNotFoundError("Video not found. Refresh the cloud list if it was uploaded elsewhere.")
        metadata = self._metadata(video_id, chosen, entry)
        fingerprints = {}
        for name in THUMBNAILS:
            path = self._path(video_id, name)
            if path.is_file():
                fingerprints[name] = sha256(path.read_bytes()).hexdigest()
        revision = _digest({"metadata": local_metadata, "state": state, "entry": entry, "thumbnails": fingerprints})
        return {"id": video_id, "metadata": metadata, "revision": revision, "local": local_metadata is not None,
                "uploaded": bool(state.get("uploaded")), "pending": bool(state.get("pending")),
                "remoteChecked": bool(state.get("remoteChecked")), "remoteChanged": bool(state.get("remoteChanged")),
                "preferRemoteAssets": bool(state.get("uploaded")),
                "pendingThumbnails": [name for name in state.get("pendingThumbnails", []) if name in THUMBNAILS],
                "thumbnail": "thumbnail_sdr_720p.webp" if "thumbnail_sdr_720p.webp" in fingerprints else "thumbnail_sdr.webp",
                "localThumbnail": bool(fingerprints)}

    def get_video(self, video_id: str, remote: bool = False) -> dict:
        with _LOCK:
            video_id = self._id(video_id)
            if not remote:
                return self._view(video_id)
            generation = self._refresh_generations.get(video_id, 0) + 1
            self._refresh_generations[video_id] = generation
            before_state = self._state(video_id)
            try:
                before_revision = self._view(video_id)["revision"]
            except VideoNotFoundError:
                before_revision = None
        # Slow origin reads must not hold the local library lock. Publication
        # still owns that lock for its complete write transaction.
        raw, remote_entry, writer_state = self._remote_snapshot(video_id)
        with _LOCK:
            if generation != self._refresh_generations.get(video_id):
                return self._view(video_id)
            state = self._state(video_id)
            try:
                current_revision = self._view(video_id)["revision"]
            except VideoNotFoundError:
                current_revision = None
            baseline_changed = any(state.get(key) != before_state.get(key) for key in ("remoteHash", "remoteEntryHash", "remoteChecked"))
            if baseline_changed or current_revision != before_revision:
                # A local save, publish/reload, external metadata change or
                # newer refresh invalidates this response. Keep the exact
                # successful save revision so the next action can use it.
                return self._view(video_id)
            remote_hash = _digest(raw) if raw is not None else None
            if state.get("pending") and state.get("remoteChecked"):
                state["remoteChanged"] = bool(state.get("needsReview")) or remote_hash != state.get("remoteHash") or _digest(remote_entry) != state.get("remoteEntryHash")
            else:
                local_entry = next((item for item in self._index() if item.get("id") == video_id), None)
                remote_metadata = self._metadata(video_id, raw, remote_entry or local_entry) if raw is not None else None
                original = state.get("offlineBase")
                if original is None:
                    local_metadata = self._read(self._path(video_id, "metadata.json"))
                    original = self._descriptive(self._metadata(video_id, local_metadata, local_entry)) if local_metadata is not None else None
                needs_review = bool(state.get("pending") and raw is not None and original != self._descriptive(remote_metadata))
                state.update(remoteHash=remote_hash, remoteEntryHash=_digest(remote_entry), remoteMetadata=remote_metadata,
                             localAtRefresh=_digest(self._read(self._path(video_id, "metadata.json"))), remoteChanged=False)
                if needs_review:
                    state["remoteChanged"] = True
                    state["needsReview"] = True
            migration_matches = (state.get("writerURL") != writer_state.get("writerURL")
                                 and remote_hash == state.get("remoteHash") and _digest(remote_entry) == state.get("remoteEntryHash")
                                 and not writer_state.get("writerDraftPending"))
            if not state.get("pending") or not state.get("remoteChecked") or migration_matches:
                state.update(writer_state)
            state.update(remoteChecked=True, uploaded=raw is not None)
            if raw is not None or self._path(video_id, "metadata.json").exists() or self._path(video_id, ".editor-state.json").exists():
                self._save_state(video_id, state)
            return self._view(video_id)

    def list_videos(self, refresh_remote: bool = False) -> list[dict]:
        with _LOCK:
            ids = set()
            if self.local.exists():
                for child in self.local.iterdir():
                    if VIDEO_ID.fullmatch(child.name):
                        self._safe(child)
                        if child.is_dir() and (self._path(child.name, "metadata.json").is_file() or self._path(child.name, ".editor-state.json").is_file()):
                            ids.add(child.name)
        if refresh_remote:
            try:
                writer = self._writer()
                if writer is not None:
                    ids.update(item["id"] for item in writer.list_videos())
                else:
                    client, bucket = self._client()
                    pages = client.get_paginator("list_objects_v2").paginate(Bucket=bucket)
                    for page in pages:
                        for obj in page.get("Contents", []):
                            parts = obj.get("Key", "").split("/")
                            if len(parts) == 2 and parts[1] == "metadata.json" and VIDEO_ID.fullmatch(parts[0]):
                                ids.add(parts[0])
            except Exception:
                raise VideoLibraryError("Could not refresh the cloud video list.") from None
        result = []
        for video_id in sorted(ids):
            try:
                video = self.get_video(video_id, remote=refresh_remote)
            except VideoNotFoundError:
                continue
            result.append({**video["metadata"], **{key: value for key, value in video.items() if key != "metadata"}})
        return sorted(result, key=lambda item: float(item.get("createdAt") or 0), reverse=True)

    def _check_revision(self, video_id: str, revision: str) -> dict:
        video = self._view(video_id)
        if not isinstance(revision, str) or video["revision"] != revision:
            raise VideoConflictError("This video changed since you opened it. Reload before saving.")
        return video

    @staticmethod
    def _descriptive(metadata: dict) -> dict:
        return {key: metadata.get(key) for key in EDITABLE}

    def _remember_offline_base(self, state: dict, metadata: dict) -> None:
        if not state.get("remoteChecked") and "offlineBase" not in state:
            state["offlineBase"] = self._descriptive(metadata)

    def _patch(self, fields: dict) -> dict:
        if not isinstance(fields, dict) or set(fields) - EDITABLE:
            raise VideoLibraryError("Only title, description, tags and visibility can be edited.")
        fields = dict(fields)
        for name, limit in (("title", 300), ("description", 20000)):
            if name in fields:
                if not isinstance(fields[name], str) or len(fields[name]) > limit:
                    raise VideoLibraryError(f"Invalid {name}.")
                if name == "title":
                    fields[name] = fields[name].strip()
                    if not fields[name]:
                        raise VideoLibraryError("Give the video a title.")
        if "visibility" in fields and fields["visibility"] not in ("public", "unlisted", "private"):
            raise VideoLibraryError("Choose public, unlisted or private.")
        if "tags" in fields:
            tags = fields["tags"]
            if isinstance(tags, str):
                tags = tags.split(",")
            if not isinstance(tags, list) or len(tags) > 50 or any(not isinstance(tag, str) or len(tag) > 100 for tag in tags):
                raise VideoLibraryError("Use up to 50 short tags.")
            fields["tags"] = list(dict.fromkeys(tag.strip() for tag in tags if tag.strip()))
        return fields

    def _save_local(self, video_id: str, metadata: dict, state: dict) -> None:
        index = self._index()
        previous = next((item for item in index if item.get("id") == video_id), {})
        entry = {**previous, **{key: metadata[key] for key in CATALOG_FIELDS if key in metadata}}
        index = [entry, *(item for item in index if item.get("id") != video_id)]
        self._write(self._path(video_id, "metadata.json"), _json_bytes(metadata))
        self._write(self.local / "index.json", _json_bytes(index))
        self._save_state(video_id, state)

    def save_video(self, video_id: str, fields: dict, revision: str, publish: bool = False) -> dict:
        with _LOCK:
            video_id = self._id(video_id)
            video = self._check_revision(video_id, revision)
            metadata = {**video["metadata"], **self._patch(fields)}
            state = self._state(video_id)
            self._remember_offline_base(state, video["metadata"])
            state["pending"] = True
            self._save_local(video_id, metadata, state)
            if publish:
                self._publish(video_id, metadata, state)
            return self._view(video_id)

    def store_encoded_video(self, video_id: str, metadata: dict, entry: dict) -> dict:
        """Register a completed new encode without replacing another video.

        Media encoding stays with the pipeline. This helper only records its
        supplied metadata, preserves the prior index, and makes a local draft.
        """
        with _LOCK:
            video_id = self._id(video_id)
            if not isinstance(metadata, dict) or not isinstance(entry, dict) or metadata.get("id") != video_id or entry.get("id") != video_id:
                raise VideoLibraryError("Encoded metadata and catalog must have the same video ID.")
            if metadata.get("frameRate") != 120 or entry.get("frameRate", 120) != 120:
                raise VideoLibraryError("Only a 120 fps encode can be added. The supplied frame rate was left unchanged.")
            index = self._index()
            state = self._state(video_id)
            if self._path(video_id, "metadata.json").exists() or any(item.get("id") == video_id for item in index) or state.get("pending") or state.get("uploaded"):
                raise VideoConflictError("That video ID already exists. Choose a new ID before encoding.")
            metadata = self._metadata(video_id, metadata, entry)
            # Validate both serializations before touching either destination.
            metadata_body = _json_bytes(metadata)
            index_body = _json_bytes([entry, *index])
            self._write(self._path(video_id, "metadata.json"), metadata_body)
            self._write(self.local / "index.json", index_body)
            self._save_state(video_id, {"pending": True, "remoteChecked": False, "uploaded": False, "offlineBase": self._descriptive(metadata)})
            return self._view(video_id)

    def mark_uploaded(self, video_id: str) -> dict:
        """Acknowledge a successful pipeline upload only after reading it back.

        The caller must have completed all media uploads successfully. This
        verifies the descriptive/technical metadata and public listing; it does
        not claim to download and validate every uploaded video segment.
        """
        with _LOCK:
            video_id = self._id(video_id)
            local_metadata = self._read(self._path(video_id, "metadata.json"))
            if local_metadata is None:
                raise VideoNotFoundError("The local encode metadata is missing; its upload was not acknowledged.")
            local_entry = next((item for item in self._index() if item.get("id") == video_id), None)
            intended = self._metadata(video_id, local_metadata, local_entry)
            self.get_video(video_id, remote=True)
            raw, remote_entry, writer_state = self._remote_snapshot(video_id)
            remote_metadata = self._metadata(video_id, raw, remote_entry) if raw is not None else None
            matches = remote_metadata is not None and all(remote_metadata.get(key) == value for key, value in intended.items())
            if intended.get("visibility") == "public":
                matches = matches and remote_entry is not None and all(
                    remote_entry.get(key) == value for key, value in (local_entry or {}).items() if key in CATALOG_FIELDS
                )
            else:
                matches = matches and remote_entry is None
            current_entry = next((item for item in self._index() if item.get("id") == video_id), None)
            matches = matches and self._read(self._path(video_id, "metadata.json")) == local_metadata and current_entry == local_entry
            state = self._state(video_id)
            if not matches:
                state.update(pending=True, remoteChanged=True)
                self._save_state(video_id, state)
                raise VideoConflictError("Cloud metadata or listing does not match the local upload. Your draft is kept for review.")
            state.update(remoteHash=_digest(raw), remoteEntryHash=_digest(remote_entry), remoteMetadata=remote_metadata,
                         remoteChecked=True, uploaded=True, pending=False, pendingThumbnails=[], remoteChanged=False,
                         needsReview=False, localAtRefresh=_digest(local_metadata))
            state.update(writer_state)
            self._save_state(video_id, state)
            return self._view(video_id)

    def archive_encoded_media(self, video_id: str, codecs: list[str]) -> list[str]:
        """Move acknowledged local transcodes into recoverable project trash."""
        with _LOCK:
            video_id = self._id(video_id)
            if not isinstance(codecs, (list, tuple)) or any(codec not in ("AV1", "HEVC") for codec in codecs):
                raise VideoLibraryError("Only AV1 and HEVC transcode folders can be archived.")
            state = self._state(video_id)
            if not state.get("remoteChecked") or not state.get("uploaded") or state.get("pending"):
                raise VideoConflictError("Verify the completed upload before archiving local video files.")
            sources = []
            for codec in dict.fromkeys(codecs):
                directory = self._safe(self.local / video_id / codec)
                if not directory.exists():
                    continue
                if not directory.is_dir():
                    raise VideoLibraryError("The transcode folder is not a directory.")
                for child in directory.iterdir():
                    self._safe(child)
                    if not child.is_file() or not MEDIA.fullmatch(f"{codec}/{child.name}"):
                        raise VideoLibraryError("The transcode folder has other files. Nothing was archived.")
                sources.append(directory)
            if not sources:
                return []
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M%S_%f")
            operation = self._safe(self.root / ".agent-trash" / f"{stamp}-archive-encoded-media-{uuid4().hex[:8]}")
            operation.mkdir(parents=True, exist_ok=False)
            (operation / "manifest.txt").write_text(
                "Original paths:\n" + "".join(f"- {source.relative_to(self.root).as_posix()}\n" for source in sources)
                + "Reason: archive local transcodes after a verified successful upload.\n"
                "Task: local video upload/editor. Timestamp is UTC.\n"
                "Restoration: stop encodes/editor saves, preserve any newly generated codec folder, then move the archived folders back.\n",
                encoding="utf-8",
            )
            moved = []
            try:
                for source in sources:
                    self._safe(source)
                    destination = self._safe(operation / source.relative_to(self.root))
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    source.rename(destination)
                    moved.append((source, destination))
            except Exception:
                for source, destination in reversed(moved):
                    if not source.exists():
                        destination.rename(source)
                raise
            return [str(destination.relative_to(self.root)) for _, destination in moved]

    def _put(self, client, bucket: str, key: str, body, content_type: str) -> None:
        if self._writer() is not None:
            raise VideoLibraryError("Direct publication is disabled. Refresh online to use the central publisher.")
        try:
            client.put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type, CacheControl="no-store")
        except Exception:
            raise VideoLibraryError("Cloud save did not finish. Your local draft and previous cloud versions are kept.") from None

    @staticmethod
    def _merge_catalog(catalog: list[dict], video_id: str, metadata: dict) -> list[dict]:
        previous = next((item for item in catalog if item.get("id") == video_id), {})
        merged = [item for item in catalog if item.get("id") != video_id]
        if metadata.get("visibility") == "public":
            merged.insert(0, {**previous, **{key: metadata[key] for key in CATALOG_FIELDS if key in metadata}})
        return merged

    def _publish(self, video_id: str, metadata: dict, state: dict) -> None:
        if not state.get("remoteChecked"):
            raise VideoConflictError("Refresh this video from cloud storage before publishing, then review your draft.")
        if state.get("needsReview"):
            raise VideoConflictError("This offline draft has not been compared with the live video. Reload the live version before publishing.")
        writer = self._writer()
        if writer is not None:
            self._publish_central(writer, video_id, metadata, state)
            return
        client, bucket = self._client()
        current = self._remote_json(client, bucket, f"{video_id}/metadata.json")
        if (_digest(current) if current is not None else None) != state.get("remoteHash"):
            state["remoteChanged"] = True
            self._save_state(video_id, state)
            raise VideoConflictError("The live video changed. Your draft is saved; reload and review before publishing.")
        # Validate the catalog before touching metadata. Merge it again at the
        # final write so unrelated new uploads are not replaced by a local list.
        remote_index = self._remote_index(client, bucket)
        remote_entry = next((item for item in remote_index if item.get("id") == video_id), None)
        if _digest(remote_entry) != state.get("remoteEntryHash"):
            state["remoteChanged"] = True
            self._save_state(video_id, state)
            raise VideoConflictError("The live video listing changed. Your draft is kept; reload before publishing.")
        if current is not None:
            # The editor owns descriptive fields, never an old local encode's
            # codec/frame-rate/color metadata. Preserve current cloud values.
            desired = {key: metadata[key] for key in EDITABLE if key in metadata}
            if state.get("pendingThumbnails") and "thumbnailUpdatedAt" in metadata:
                desired["thumbnailUpdatedAt"] = metadata["thumbnailUpdatedAt"]
            metadata = {**self._metadata(video_id, current), **desired}
            self._save_local(video_id, metadata, state)
        metadata_body = _bounded_json_bytes(metadata, METADATA_LIMIT, "video metadata")
        _bounded_json_bytes(self._merge_catalog(remote_index, video_id, metadata), CATALOG_LIMIT, "public video list")
        new_upload = current is None
        assets = list(state.get("pendingThumbnails", []))
        if new_upload:
            if metadata.get("frameRate") != 120:
                raise VideoLibraryError("A new upload needs verified 120 fps metadata. No video was published.")
            folder = self._path(video_id, "metadata.json").parent
            for codec in ("AV1", "HEVC"):
                codec_dir = self._safe(folder / codec)
                if codec_dir.is_dir():
                    for path in codec_dir.iterdir():
                        self._safe(path)
                        asset = f"{codec}/{path.name}"
                        if path.is_file() and MEDIA.fullmatch(asset):
                            assets.append(asset)
            if not any(asset.endswith("manifest.mpd") for asset in assets):
                raise VideoLibraryError("The local encode is missing. Upload its video files before publishing.")
            assets.extend(name for name in THUMBNAILS if self._path(video_id, name).is_file())
        metadata_key = f"{video_id}/metadata.json"
        closing = metadata.get("visibility") == "private" and current is not None
        if closing:
            self._put(client, bucket, metadata_key, metadata_body, "application/json")
            # If a later thumbnail fails, retry must recognize our successful
            # privacy change rather than mistake it for somebody else's edit.
            state.update(remoteHash=_digest(metadata), remoteMetadata=metadata, uploaded=True, remoteChanged=False)
            self._save_state(video_id, state)
        for asset in dict.fromkeys(assets):
            path = self.local_asset_path(video_id, asset)
            with path.open("rb") as stream:
                self._put(client, bucket, f"{video_id}/{asset}", stream, mimetypes.guess_type(asset)[0] or "video/mp4")
        if not closing:
            self._put(client, bucket, metadata_key, metadata_body, "application/json")
        # Record the successful metadata write even if the subsequent catalog
        # fails: retrying the saved draft can repair listing without a conflict.
        state.update(remoteHash=_digest(metadata), remoteMetadata=metadata, uploaded=True, remoteChanged=False)
        self._save_state(video_id, state)
        catalog = self._remote_index(client, bucket)
        latest_entry = next((item for item in catalog if item.get("id") == video_id), None)
        if _digest(latest_entry) != state.get("remoteEntryHash"):
            state["remoteChanged"] = True
            self._save_state(video_id, state)
            raise VideoConflictError("The live video listing changed during publication. Your draft is kept; reload before publishing.")
        catalog = self._merge_catalog(catalog, video_id, metadata)
        self._put(client, bucket, "index.json", _bounded_json_bytes(catalog, CATALOG_LIMIT, "public video list"), "application/json")
        published_entry = next((item for item in catalog if item.get("id") == video_id), None)
        state.update(pending=False, pendingThumbnails=[], localAtRefresh=_digest(metadata), remoteEntryHash=_digest(published_entry))
        self._save_state(video_id, state)

    def _publish_central(self, writer, video_id: str, metadata: dict, state: dict) -> None:
        try:
            if not state.get("uploaded"):
                # upload_folder owns reservation, media-only transfer and the
                # single central finalization, including thumbnails/catalogue.
                from upload import upload_folder
                client, bucket = self._client()
                entry = next((item for item in self._index() if item.get("id") == video_id), {})
                if not upload_folder(client, bucket, self._path(video_id, "metadata.json").parent, video_id,
                                     logging.getLogger("video-library"), entry=entry):
                    raise VideoLibraryError("Upload did not finish. Your local draft and media are kept.")
                self.mark_uploaded(video_id)
                return
            if state.get("writerURL") != writer.url or not state.get("writerRevision"):
                raise VideoConflictError("Refresh online before publishing through the central writer.")
            images = {name: self.local_asset_path(video_id, name).read_bytes() for name in CENTRAL_THUMBNAILS} if state.get("pendingThumbnails") else None
            fields = {key: metadata[key] for key in ("title", "description", "tags", "visibility") if key in metadata}
            fingerprint = _digest({"fields": fields, "images": {name: sha256(data).hexdigest() for name, data in (images or {}).items()}, "writer": writer.url})
            operation = state.get("centralPublish")
            if not isinstance(operation, dict) or operation.get("fingerprint") != fingerprint:
                if state.get("writerDraftPending"):
                    raise VideoConflictError("Finish or discard the online editor draft before publishing from this PC.")
                operation = {"fingerprint": fingerprint, "revision": state["writerRevision"], "operation_id": str(uuid4())}
                state["centralPublish"] = operation
                self._save_state(video_id, state)
            detail = writer.publish(video_id, fields, operation["revision"], images=images, operation_id=operation["operation_id"])
            published = detail.get("published_metadata")
            if (not isinstance(published, dict) or published.get("id") != video_id or detail.get("pending") is not False
                    or not isinstance(detail.get("revision"), str) or not detail["revision"]
                    or any(published.get(key) != value for key, value in fields.items())):
                raise VideoLibraryError("The central writer did not confirm publication. Your local draft is kept.")
            remote_entry = detail.get("entry")
            metadata = self._metadata(video_id, published, remote_entry)
            state.update(remoteHash=_digest(published), remoteEntryHash=_digest(remote_entry), remoteMetadata=metadata,
                         remoteChecked=True, uploaded=True, pending=False, pendingThumbnails=[], remoteChanged=False,
                         needsReview=False, writerRevision=detail["revision"], writerURL=writer.url, writerDraftPending=False)
            state.pop("centralPublish", None)
            self._save_local(video_id, metadata, state)
            state["localAtRefresh"] = _digest(metadata)
            self._save_state(video_id, state)
        except AdminClientError as exc:
            if exc.status_code == 409:
                state["remoteChanged"] = True
                self._save_state(video_id, state)
                raise VideoConflictError(str(exc)) from None
            raise VideoLibraryError(str(exc)) from None

    def discard_draft(self, video_id: str, revision: str) -> dict:
        """Explicitly reload cloud metadata, preserving the replaced local draft."""
        with _LOCK:
            video_id = self._id(video_id)
            self._check_revision(video_id, revision)
            raw, remote_entry, writer_state = self._remote_snapshot(video_id)
            if raw is None:
                raise VideoNotFoundError("There is no live version to reload. Your local draft is kept.")
            metadata = self._metadata(video_id, raw, remote_entry)
            state = {"remoteChecked": True, "uploaded": True, "remoteHash": _digest(raw), "remoteMetadata": metadata,
                     "remoteEntryHash": _digest(remote_entry), "pending": False, "pendingThumbnails": [],
                     "remoteChanged": False, "localAtRefresh": _digest(metadata)}
            state.update(writer_state)
            # Pending stills cannot be represented as live previews after a
            # reload. Archive them as well; the remote preview remains usable.
            old_state = self._state(video_id)
            for name in old_state.get("pendingThumbnails", []):
                if name not in THUMBNAILS:
                    raise VideoLibraryError("Invalid saved thumbnail state.")
                path = self._path(video_id, name)
                if path.is_file():
                    self._archive(path, "discard-thumbnail-draft")
            self._save_local(video_id, metadata, state)
            return self._view(video_id)

    def replace_thumbnail(self, video_id: str, image_bytes: bytes, filename: str, revision: str, publish: bool = False) -> dict:
        with _LOCK:
            video_id = self._id(video_id)
            video = self._check_revision(video_id, revision)
            if not isinstance(image_bytes, bytes) or not image_bytes or len(image_bytes) > 20 * 1024 * 1024:
                raise VideoLibraryError("Choose an image smaller than 20 MB.")
            if not isinstance(filename, str) or Path(filename).suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp", ".avif"):
                raise VideoLibraryError("Choose a JPEG, PNG, WebP or AVIF image.")
            try:
                from PIL import Image, ImageOps
                with Image.open(BytesIO(image_bytes)) as source:
                    if source.width * source.height > 40_000_000:
                        raise VideoLibraryError("Choose an image below 40 megapixels.")
                    image = ImageOps.exif_transpose(source).convert("RGB")
                image.thumbnail((3840, 2160))
                small = image.copy()
                small.thumbnail((1280, 720))
                generated = {}
                for name in THUMBNAILS:
                    output = BytesIO()
                    fmt = "AVIF" if name.endswith(".avif") else "WEBP" if name.endswith(".webp") else "JPEG"
                    (small if "720p" in name or fmt == "JPEG" else image).save(output, format=fmt, quality=85)
                    generated[name] = output.getvalue()
            except VideoLibraryError:
                raise
            except ImportError:
                raise VideoLibraryError("Install Pillow 11.3 or newer to replace thumbnails.") from None
            except Exception:
                raise VideoLibraryError("That image could not be opened or converted. Previous thumbnails are kept.") from None
            for name, data in generated.items():
                self._write(self._path(video_id, name), data)
            metadata = dict(video["metadata"], thumbnailUpdatedAt=datetime.now(timezone.utc).isoformat())
            state = self._state(video_id)
            self._remember_offline_base(state, video["metadata"])
            state.update(pending=True, pendingThumbnails=list(THUMBNAILS))
            self._save_local(video_id, metadata, state)
            if publish:
                self._publish(video_id, metadata, state)
            return self._view(video_id)

    def local_asset_path(self, video_id: str, relative: str) -> Path:
        self._id(video_id)
        self._validate_asset(relative)
        path = self._path(video_id, relative)
        if not path.is_file():
            raise VideoNotFoundError("This preview file is not stored locally.")
        return path

    @staticmethod
    def _validate_asset(relative: str) -> None:
        if not isinstance(relative, str) or relative not in (*THUMBNAILS, "metadata.json") and not MEDIA.fullmatch(relative):
            raise VideoLibraryError("That file is not a video preview asset.")

    def remote_asset(self, video_id: str, relative: str, range_header: str | None = None) -> dict:
        """Return authenticated origin data after an explicit cloud refresh.

        The route must close result['Body'] when streaming ends or is cancelled.
        No remote file contents are written to disk, buffered or re-encoded.
        """
        with _LOCK:
            video_id = self._id(video_id)
            self._validate_asset(relative)
            state = self._state(video_id)
            if not state.get("remoteChecked") or not state.get("uploaded"):
                raise VideoLibraryError("Refresh this video from cloud storage before using its online preview.")
            if range_header is not None and (not isinstance(range_header, str) or not re.fullmatch(r"bytes=(?:[0-9]+-[0-9]*|-[0-9]+)", range_header)):
                raise VideoLibraryError("Invalid preview byte range.")
        client, bucket = self._client()
        kwargs = {"Range": range_header} if range_header is not None else {}
        try:
            return client.get_object(Bucket=bucket, Key=f"{video_id}/{relative}", **kwargs)
        except Exception as exc:
            if _missing(exc):
                raise VideoNotFoundError("This preview file is missing from cloud storage.") from None
            if str(getattr(exc, "response", {}).get("Error", {}).get("Code", "")) in ("InvalidRange", "416"):
                error = VideoLibraryError("That byte range is outside the preview file.")
                error.status_code = 416
                raise error from None
            raise VideoLibraryError("Could not read the online video preview.") from None


_default_library = VideoLibrary()
list_videos = _default_library.list_videos
get_video = _default_library.get_video
save_video = _default_library.save_video
store_encoded_video = _default_library.store_encoded_video
mark_uploaded = _default_library.mark_uploaded
archive_encoded_media = _default_library.archive_encoded_media
replace_thumbnail = _default_library.replace_thumbnail
discard_draft = _default_library.discard_draft
local_asset_path = _default_library.local_asset_path
remote_asset = _default_library.remote_asset
