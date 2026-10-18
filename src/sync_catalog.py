"""Sync catalogue fields from web/local/index.json into per-video metadata.json.

By default runs as a dry-run. Use --apply to write local files, --upload to
push changed metadata.json files and the public index to B2.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
import argparse
import json
import logging
import sys
from uuid import uuid4

from config import ROOT, LOCAL_DIR, INDEX_PATH, get_b2_credentials, normalize_visibility
from upload import make_b2_client, replace_file, upload_index
from admin_client import AdminClientError, central_client

CATALOG_FIELDS = ("id", "title", "visibility", "createdAt", "description")


@dataclass
class SyncResult:
    apply: bool
    upload: bool
    changed_count: int = 0
    orphan_ids: list[str] = field(default_factory=list)
    uploaded_metadata: int = 0
    index_uploaded: bool = False
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None

    @property
    def has_changes(self) -> bool:
        return self.changed_count > 0


def setup_logging() -> logging.Logger:
    log = logging.getLogger("sync_catalog")
    log.setLevel(logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s  %(levelname)-8s  %(message)s", "%Y-%m-%d %H:%M:%S"))
    log.addHandler(handler)
    log.propagate = False
    return log


def load_index(path: Path) -> list[dict]:
    if not path.exists():
        raise FileNotFoundError(f"Index not found: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"Expected a JSON array in {path}")
    return data


def catalogue_patch(entry: dict) -> dict:
    video_id = entry["id"]
    patch = {
        "id": video_id,
        "title": entry["title"],
        "visibility": normalize_visibility(entry),
        "createdAt": entry["createdAt"],
    }
    if "description" in entry:
        patch["description"] = entry["description"]
    return patch


def format_change(field: str, old, new) -> str:
    return f"{field}: {old!r} -> {new!r}"


def write_metadata_preserving_previous(path: Path, metadata: dict) -> None:
    """Keep non-Git metadata recoverable when applying catalogue changes."""
    relative = path.resolve().relative_to(ROOT.resolve())
    trash = ROOT / ".agent-trash"
    if not trash.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError("Metadata backups must stay inside the project")
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M%S_%f")
    operation = trash / f"{stamp}-sync-share-metadata-{uuid4().hex[:8]}"
    backup = operation / relative
    temporary = path.with_name(f".metadata-sync-{uuid4().hex}.tmp")
    moved = False
    try:
        temporary.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        backup.parent.mkdir(parents=True, exist_ok=False)
        (operation / "manifest.txt").write_text(
            f"Original path: {relative.as_posix()}\n"
            "Reason: synchronize catalogue fields, including share descriptions.\n"
            "Task: video link previews. Timestamp is UTC.\n"
            "Restoration: move the backup to its original path, preserving the replacement first. "
            "Stop a running encode or metadata sync before restoring.\n",
            encoding="utf-8",
        )
        path.rename(backup)
        moved = True
        temporary.rename(path)
    except Exception:
        if moved and not path.exists():
            backup.rename(path)
        raise
    finally:
        # Unique, reproducible serialization of metadata supplied to this call.
        temporary.unlink(missing_ok=True)


def sync_metadata(
    entry: dict,
    *,
    apply: bool,
    log: logging.Logger,
) -> Path | None:
    """Return metadata.json path when it was or would be updated."""
    video_id = entry.get("id")
    if not video_id:
        log.warning("  SKIP entry with no id")
        return None

    meta_path = LOCAL_DIR / video_id / "metadata.json"
    if not meta_path.exists():
        log.warning(f"  SKIP {video_id}: no local metadata.json")
        return None

    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception as exc:
        log.error(f"  SKIP {video_id}: could not read metadata.json ({exc})")
        return None

    patch = catalogue_patch(entry)
    changes: list[str] = []

    for field in CATALOG_FIELDS:
        if field not in patch:
            continue
        new_val = patch[field]
        old_val = meta.get(field)
        if old_val != new_val:
            changes.append(format_change(field, old_val, new_val))

    if meta.get("unlisted"):
        changes.append(format_change("unlisted", True, "(removed)"))

    if not changes:
        log.info(f"  OK   {video_id}")
        return None

    action = "SYNC" if apply else "PLAN"
    log.info(f"  {action} {video_id}")
    for line in changes:
        log.info(f"         {line}")

    if apply:
        for field in CATALOG_FIELDS:
            if field in patch:
                meta[field] = patch[field]
        meta.pop("unlisted", None)
        write_metadata_preserving_previous(meta_path, meta)

    return meta_path


def upload_changed_metadata(
    b2,
    bucket: str,
    paths: list[Path],
    log: logging.Logger,
) -> None:
    if central_client() is not None:
        raise AdminClientError("Bulk metadata uploads are disabled with the central publisher. Use Videos to refresh, review and publish.", 409)
    for path in paths:
        video_id = path.parent.name
        key = f"{video_id}/metadata.json"
        replace_file(b2, bucket, key, path, "application/json", log)
        log.info(f"  UP   b2://{bucket}/{key}")


def format_sync_summary(result: SyncResult) -> str:
    if result.error:
        return result.error

    if not result.apply:
        if result.has_changes:
            return (
                f"{result.changed_count} metadata file(s) would change — "
                "use Apply to write locally."
            )
        return "Everything already in sync."

    parts: list[str] = []
    if result.has_changes:
        parts.append(f"Updated {result.changed_count} metadata file(s) locally.")
    else:
        parts.append("Local metadata already in sync.")

    if result.upload:
        if result.uploaded_metadata:
            parts.append(f"Uploaded {result.uploaded_metadata} metadata file(s) to B2.")
        if result.index_uploaded:
            parts.append("Uploaded public index.json to B2.")

    if result.orphan_ids:
        parts.append(
            f"{len(result.orphan_ids)} local folder(s) not in index: "
            f"{', '.join(result.orphan_ids[:5])}"
            + ("…" if len(result.orphan_ids) > 5 else "")
        )

    return " ".join(parts)


def run_sync(
    *,
    apply: bool = False,
    upload: bool = False,
    log: logging.Logger | None = None,
) -> SyncResult:
    """Sync catalogue fields from index.json into per-video metadata.json."""
    result = SyncResult(apply=apply, upload=upload)
    if log is None:
        log = setup_logging()
    if upload:
        try:
            if central_client() is not None:
                result.error = "Bulk cloud sync is disabled with the central publisher. Use Videos to refresh, review and publish."
                log.error(result.error)
                return result
        except AdminClientError as exc:
            result.error = str(exc)
            log.error(result.error)
            return result

    log.info(f"Index  : {INDEX_PATH}")
    mode = "apply + upload" if upload else "apply" if apply else "dry-run"
    log.info(f"Mode   : {mode}")

    try:
        index = load_index(INDEX_PATH)
    except Exception as exc:
        result.error = str(exc)
        log.error(result.error)
        return result

    changed: list[Path] = []
    for entry in index:
        path = sync_metadata(entry, apply=apply, log=log)
        if path is not None:
            changed.append(path)

    result.changed_count = len(changed)

    indexed_ids = {e["id"] for e in index if e.get("id")}
    if LOCAL_DIR.exists():
        for child in sorted(LOCAL_DIR.iterdir()):
            if not child.is_dir():
                continue
            meta_path = child / "metadata.json"
            if meta_path.exists() and child.name not in indexed_ids:
                result.orphan_ids.append(child.name)
                log.warning(f"  WARN local folder not in index: {child.name}")

    if not apply:
        if changed:
            log.info(f"Done. {len(changed)} file(s) would change - rerun with --apply to write.")
        else:
            log.info("Done. Everything already in sync.")
        return result

    if upload:
        try:
            get_b2_credentials()
        except RuntimeError as exc:
            result.error = str(exc)
            log.error(result.error)
            return result

        b2, bucket = make_b2_client()
        log.info(f"Bucket : {bucket}")

        if changed:
            log.info(f"Uploading {len(changed)} metadata.json file(s)...")
            upload_changed_metadata(b2, bucket, changed, log)
            result.uploaded_metadata = len(changed)
        else:
            log.info("No metadata changes to upload.")

        log.info("Uploading public index.json...")
        upload_index(b2, bucket, INDEX_PATH, log)
        result.index_uploaded = True

    if changed:
        log.info(f"Done. Updated {len(changed)} metadata file(s).")
    else:
        log.info("Done. Metadata already in sync.")

    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sync index.json catalogue fields into per-video metadata.json.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write updated metadata.json files locally (default: dry-run).",
    )
    parser.add_argument(
        "--upload",
        action="store_true",
        help="Upload changed metadata.json files and the public index to B2 (implies --apply).",
    )
    args = parser.parse_args()

    apply = args.apply or args.upload
    log = setup_logging()
    result = run_sync(apply=apply, upload=args.upload, log=log)
    if result.error:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
