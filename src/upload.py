from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any, Callable
import argparse
import json
import logging
import os
import re
import stat
import sys
import boto3
from botocore.config import Config

from config import get_b2_credentials, normalize_visibility


MIME_MAP = {
    ".mpd":  "application/dash+xml",
    ".m3u8": "application/x-mpegURL",
    ".mp4":  "video/mp4",
    ".fmp4": "video/mp4",
    ".json": "application/json",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png":  "image/png",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".gif":  "image/gif",
}

_VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_PROJECT_ROOT = Path(__file__).absolute().parent.parent
_THUMBNAILS = frozenset((
    "thumbnail_sdr.webp", "thumbnail_sdr_720p.webp", "thumbnail_hdr.avif",
    "thumbnail_hdr_720p.avif", "thumbnail_share.jpg",
))
_MEDIA_ASSET = re.compile(
    r"(?:AV1|HEVC)/(?:manifest\.mpd|master\.m3u8|media_[0-9]+\.m3u8|"
    r"init_[0-9]+\.mp4|chunk_[0-9]+_[0-9]+\.fmp4)\Z"
)
_CATALOG_LIMIT = 1_000_000
_METADATA_LIMIT = 128_000
_MISSING = object()
_CATALOG_FIELDS = (
    "title", "description", "tags", "date", "createdAt", "duration", "width",
    "height", "frameRate", "hdr", "codecs",
)
_INDEX_ONLY_FIELDS = {"tags", "date", "hdr"}


def make_b2_client() -> tuple[Any, str]:
    """Create a B2/S3 client. Returns (client, bucket_name)."""
    key_id, app_key, bucket, endpoint = get_b2_credentials()
    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=key_id,
        aws_secret_access_key=app_key,
        config=Config(
            signature_version="s3v4", connect_timeout=10, read_timeout=30,
            retries={"mode": "standard", "max_attempts": 2},
        ),
    )
    return client, bucket


def _not_found(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "404" in msg or "nosuchkey" in msg or "not found" in msg


def delete_object_versions(
    b2: Any,
    bucket: str,
    key: str,
    log: logging.Logger | None = None,
) -> int:
    """Delete every version and delete-marker for a key (versioned buckets)."""
    removed = 0
    try:
        paginator = b2.get_paginator("list_object_versions")
        for page in paginator.paginate(Bucket=bucket, Prefix=key):
            for item in page.get("Versions", []):
                if item["Key"] != key:
                    continue
                b2.delete_object(Bucket=bucket, Key=key, VersionId=item["VersionId"])
                removed += 1
            for item in page.get("DeleteMarkers", []):
                if item["Key"] != key:
                    continue
                b2.delete_object(Bucket=bucket, Key=key, VersionId=item["VersionId"])
                removed += 1
    except Exception as exc:
        if log:
            log.debug(f"  list_object_versions failed for {key}, falling back: {exc}")
        try:
            b2.delete_object(Bucket=bucket, Key=key)
            removed += 1
        except Exception as exc2:
            if not _not_found(exc2) and log:
                log.warning(f"  Could not delete {key}: {exc2}")
    return removed


def replace_file(
    b2: Any,
    bucket: str,
    key: str,
    local_path: Path,
    content_type: str,
    log: logging.Logger | None = None,
) -> None:
    """Upload a new current version while preserving previous B2 versions."""
    b2.upload_file(str(local_path), bucket, key, ExtraArgs={"ContentType": content_type})


def replace_object(
    b2: Any,
    bucket: str,
    key: str,
    body: bytes,
    content_type: str,
    log: logging.Logger | None = None,
) -> None:
    """Write a new current version while preserving previous B2 versions."""
    b2.put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type)


def is_already_uploaded(b2: Any, bucket: str, video_id: str, log: logging.Logger) -> bool:
    """Check the current metadata key; uncertain reads must never permit reuse."""
    try:
        b2.head_object(Bucket=bucket, Key=f"{video_id}/metadata.json")
        return True
    except Exception as e:
        error = (getattr(e, "response", None) or {}).get("Error", {})
        if str(error.get("Code", "")) in ("404", "NoSuchKey", "NotFound"):
            return False
        log.warning(f"Could not check B2 for existing upload at '{video_id}': {e}")
        raise


def _packaged_files(local_dir: Path) -> list[Path]:
    """Enumerate known package assets without following links or other folders."""
    local_dir = Path(os.path.abspath(local_dir))
    try:
        local_dir.relative_to(_PROJECT_ROOT)
    except ValueError:
        raise ValueError("Video packages must stay inside this project") from None

    def inspect(path: Path):
        relative = path.relative_to(_PROJECT_ROOT)
        current = _PROJECT_ROOT
        result = None
        for part in ("", *relative.parts):
            if part:
                current /= part
            try:
                result = current.lstat()
            except FileNotFoundError:
                return None
            if stat.S_ISLNK(result.st_mode) or getattr(result, "st_file_attributes", 0) & 0x400:
                raise ValueError("Linked video package files and folders are not allowed")
        return result

    folder = inspect(local_dir)
    if folder is None or not stat.S_ISDIR(folder.st_mode):
        raise ValueError("Video package folder is missing")
    candidates = [local_dir / "metadata.json", *(local_dir / name for name in sorted(_THUMBNAILS))]
    for codec in ("AV1", "HEVC"):
        directory = local_dir / codec
        info = inspect(directory)
        if info is None:
            continue
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("A codec package path is not a folder")
        candidates.extend(path for path in directory.iterdir()
                          if _MEDIA_ASSET.fullmatch(f"{codec}/{path.name}"))
    files = []
    for path in candidates:
        info = inspect(path)
        if info is None:
            continue
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("A video package asset is not a regular file")
        files.append(path)
    return files


def upload_folder(
    b2: Any,
    bucket: str,
    local_dir: Path,
    b2_prefix: str,
    log: logging.Logger,
    max_workers: int = 20,
    on_progress: Callable[[int, int], None] | None = None,
) -> bool:
    """Upload known video package assets under b2_prefix, concurrently.

    Local editor state, unrelated files and linked paths are never uploaded.
    Metadata follows all other assets and is withheld if any asset fails.
    Returns True if all uploads succeeded.
    """
    local_dir = Path(os.path.abspath(local_dir))
    try:
        files = _packaged_files(local_dir)
    except (OSError, ValueError) as exc:
        log.error(f"  Invalid video package: {exc}")
        return False
    if not files:
        log.error("  No packaged video assets were found")
        return False
    total = len(files)
    failed: list[str] = []
    done  = 0
    lock  = Lock()

    def upload_one(f: Path) -> str | None:
        nonlocal done
        relative     = f.relative_to(local_dir)
        key          = f"{b2_prefix}/{relative.as_posix()}"
        content_type = MIME_MAP.get(f.suffix.lower(), "application/octet-stream")
        try:
            replace_file(b2, bucket, key, f, content_type, log)
            log.debug(f"  OK  {key}")
            result = None
        except Exception as e:
            log.debug(f"  ERR {key}: {e}")
            result = str(relative)
        with lock:
            done += 1
            if on_progress:
                on_progress(done, total)
            else:
                ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                sys.stdout.write(f"\r{ts}  INFO      [UPLOAD]       {done}/{total} files")
                sys.stdout.flush()
        return result

    metadata = next((path for path in files if path.name == "metadata.json"), None)
    assets = [path for path in files if path != metadata]
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(upload_one, f): f for f in assets}
        for future in as_completed(futures):
            result = future.result()
            if result:
                failed.append(result)

    # Metadata is the visibility gate. A new ID must remain unavailable until
    # every rendition and thumbnail has reached storage successfully.
    if metadata is not None and not failed:
        result = upload_one(metadata)
        if result:
            failed.append(result)

    if not on_progress:
        sys.stdout.write("\n")
        sys.stdout.flush()

    if failed:
        log.error(f"  {len(failed)} file(s) failed: {', '.join(failed)}")
        return False

    log.info(f"  Upload complete -> b2://{bucket}/{b2_prefix}/")
    return True


def _read_remote_json(b2: Any, bucket: str, key: str, limit: int) -> Any:
    """Read the current object with a bound; only a missing key means absent."""
    try:
        response = b2.get_object(Bucket=bucket, Key=key)
    except Exception as exc:
        error = getattr(exc, "response", {}).get("Error", {})
        if error.get("Code") in {"NoSuchKey", "NotFound", "404"}:
            return _MISSING
        raise

    stream = response["Body"]
    try:
        if int(response.get("ContentLength", 0)) > limit:
            raise ValueError(f"{key} is too large")
        raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise ValueError(f"{key} is too large")
        return json.loads(raw.decode("utf-8"))
    finally:
        stream.close()


def _catalogue_entries(raw: Any, source: str) -> dict[str, dict]:
    if not isinstance(raw, list):
        raise ValueError(f"{source} must contain a JSON array")
    entries: dict[str, dict] = {}
    for entry in raw:
        if (not isinstance(entry, dict) or not isinstance(entry.get("id"), str)
                or not _VIDEO_ID.fullmatch(entry["id"])):
            raise ValueError(f"{source} contains an invalid video ID")
        if entry["id"] in entries:
            raise ValueError(f"{source} contains duplicate video IDs")
        entries[entry["id"]] = entry
    return entries


def _metadata_visibility(metadata: dict, existing: dict | None) -> str:
    if "visibility" in metadata:
        visibility = metadata["visibility"]
        return visibility if visibility in ("public", "unlisted", "private") else "private"
    if metadata.get("unlisted"):
        return "unlisted"
    # A reviewed legacy public entry may predate visibility in metadata.
    # A stale local catalogue alone must never publish an unknown legacy video.
    if existing is not None and _existing_public(existing):
        return "public"
    return "private"


def _existing_public(entry: dict) -> bool:
    return ("visibility" not in entry or entry["visibility"] == "public") and normalize_visibility(entry) == "public"


def _created_at(entry: dict) -> float:
    try:
        return float(entry.get("createdAt", 0))
    except (TypeError, ValueError):
        return 0


def upload_index(b2: Any, bucket: str, index_path: Path, log: logging.Logger) -> None:
    """Merge local IDs into the current public index without undoing live edits.

    Current remote metadata owns title, description and visibility. Remote-only
    catalogue entries remain intact, and candidates without uploaded metadata
    are omitted. Failures propagate so callers cannot report a successful sync.
    """
    try:
        local = _catalogue_entries(json.loads(index_path.read_text(encoding="utf-8")), "Local index")
        raw_remote = _read_remote_json(b2, bucket, "index.json", _CATALOG_LIMIT)
        remote = _catalogue_entries([] if raw_remote is _MISSING else raw_remote, "Remote index")
        merged = {
            video_id: entry for video_id, entry in remote.items()
            if _existing_public(entry)
        }
        for video_id, local_entry in local.items():
            metadata = _read_remote_json(b2, bucket, f"{video_id}/metadata.json", _METADATA_LIMIT)
            if metadata is _MISSING:
                merged.pop(video_id, None)
                continue
            if not isinstance(metadata, dict):
                raise ValueError(f"Metadata for {video_id} must contain a JSON object")
            existing = remote.get(video_id)
            if _metadata_visibility(metadata, existing) != "public":
                merged.pop(video_id, None)
                continue
            entry = {"id": video_id, "visibility": "public"}
            for field in _CATALOG_FIELDS:
                if field in metadata:
                    entry[field] = metadata[field]
                elif field in _INDEX_ONLY_FIELDS:
                    fallback = existing if existing is not None else local_entry
                    if field in fallback:
                        entry[field] = fallback[field]
            merged[video_id] = entry
        public = sorted(merged.values(), key=_created_at, reverse=True)
        body = json.dumps(public, indent=2, allow_nan=False).encode("utf-8")
        if len(body) > _CATALOG_LIMIT:
            raise ValueError("Merged index is too large")
        replace_object(b2, bucket, "index.json", body, "application/json", log)
        log.info(
            f"[INDEX]        Uploaded index.json -> b2://{bucket}/index.json "
            f"({len(public)} public entries)"
        )
    except Exception as e:
        log.error(f"[INDEX]        Failed to upload index.json: {e}")
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Upload a video ID folder to the Project Aida B2 bucket.")
    parser.add_argument("folder", help="Path to a project video ID folder (e.g. web/local/00000000000). Uploads its known video package assets.")
    parser.add_argument("--prefix", default=None, metavar="PREFIX",
                        help="B2 key prefix override (default: folder name, i.e. the video ID)")
    args = parser.parse_args()

    folder = Path(os.path.abspath(args.folder))
    try:
        package_files = _packaged_files(folder)
        if not package_files:
            raise ValueError("No packaged video assets were found")
    except (OSError, ValueError) as exc:
        print(f"Error: {exc}.", file=sys.stderr)
        sys.exit(1)

    prefix = args.prefix or folder.name

    log = logging.getLogger("upload")
    log.setLevel(logging.DEBUG)
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter("%(asctime)s  %(levelname)-8s  %(message)s", "%Y-%m-%d %H:%M:%S"))
    log.addHandler(handler)
    log.propagate = False

    b2, bucket = make_b2_client()

    log.info(f"Folder : {folder}")
    log.info(f"Prefix : {prefix}")
    log.info(f"Bucket : {bucket}")

    ok = upload_folder(b2, bucket, folder, prefix, log)
    sys.exit(0 if ok else 1)
