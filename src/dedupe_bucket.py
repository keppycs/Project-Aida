"""Remove duplicate object versions from the Project Aida B2 bucket.

B2 versioning keeps every re-upload as a separate version of the same key.
This script scans the bucket, keeps only the newest version per key, and
deletes older versions (and any stale delete-markers).

Default is dry-run. Pass --apply to perform deletions.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Callable
import argparse
import logging
import sys

from config import get_b2_credentials
from upload import make_b2_client

ProgressCallback = Callable[[str, int, int], None]

SCAN_LOG_EVERY = 500
DELETE_LOG_EVERY = 100


@dataclass
class DedupeResult:
    bucket: str
    prefix: str
    applied: bool
    keys_with_duplicates: int = 0
    versions_to_delete: int = 0
    bytes_reclaimed: int = 0
    deleted_count: int = 0
    failed_count: int = 0
    error: str | None = None
    plans: list[dict] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.error is None and self.failed_count == 0

    @property
    def has_duplicates(self) -> bool:
        return self.keys_with_duplicates > 0


def setup_logging(verbose: bool) -> logging.Logger:
    log = logging.getLogger("dedupe_bucket")
    log.setLevel(logging.DEBUG if verbose else logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s  %(levelname)-8s  %(message)s", "%Y-%m-%d %H:%M:%S"))
    log.addHandler(handler)
    log.propagate = False
    return log


def _report(
    on_progress: ProgressCallback | None,
    phase: str,
    current: int,
    total: int,
) -> None:
    if on_progress:
        on_progress(phase, current, total)


def collect_version_groups(
    b2,
    bucket: str,
    prefix: str,
    log: logging.Logger,
    on_progress: ProgressCallback | None = None,
) -> dict[str, list[dict]]:
    """Group every object version and delete-marker by key."""
    groups: dict[str, list[dict]] = defaultdict(list)
    paginator = b2.get_paginator("list_object_versions")
    kwargs: dict = {"Bucket": bucket}
    if prefix:
        kwargs["Prefix"] = prefix

    listed = 0
    log.info("Listing object versions from B2…")

    for page in paginator.paginate(**kwargs):
        for item in page.get("Versions", []):
            groups[item["Key"]].append({**item, "_type": "version"})
            listed += 1
        for item in page.get("DeleteMarkers", []):
            groups[item["Key"]].append({**item, "_type": "delete_marker"})
            listed += 1

        if listed % SCAN_LOG_EVERY == 0:
            log.info(f"  …listed {listed:,} version entries so far")
            _report(on_progress, "scan", listed, 0)

    log.info(f"  Listed {listed:,} version entries across {len(groups):,} key(s).")
    _report(on_progress, "scan", listed, listed)
    return groups


def plan_deletions(groups: dict[str, list[dict]]) -> list[dict]:
    """Return a deletion plan: keep newest version, drop everything else."""
    plans: list[dict] = []

    for key in sorted(groups):
        items = groups[key]
        versions = [item for item in items if item["_type"] == "version"]
        delete_markers = [item for item in items if item["_type"] == "delete_marker"]

        if not versions:
            continue

        if len(versions) == 1 and not delete_markers:
            continue

        versions.sort(key=lambda item: item["LastModified"], reverse=True)
        keep = versions[0]
        to_delete = versions[1:] + delete_markers

        plans.append({"key": key, "keep": keep, "delete": to_delete})

    return plans


def format_version(item: dict) -> str:
    ts = item["LastModified"].strftime("%Y-%m-%d %H:%M:%S")
    size = item.get("Size", 0)
    kind = "delete-marker" if item["_type"] == "delete_marker" else "version"
    return f"{item['VersionId']} ({kind}, {size:,} B, {ts})"


def apply_deletions(
    b2,
    bucket: str,
    plans: list[dict],
    log: logging.Logger,
    on_progress: ProgressCallback | None = None,
) -> tuple[int, int]:
    """Delete planned versions. Returns (deleted_count, failed_count)."""
    deleted = 0
    failed = 0
    total = sum(len(plan["delete"]) for plan in plans)

    log.info(f"Deleting {total:,} old version(s)…")
    _report(on_progress, "delete", 0, total)

    for plan in plans:
        key = plan["key"]
        for item in plan["delete"]:
            try:
                b2.delete_object(Bucket=bucket, Key=key, VersionId=item["VersionId"])
                deleted += 1
                if deleted % DELETE_LOG_EVERY == 0 or deleted == total:
                    log.info(f"  …deleted {deleted:,}/{total:,}")
                _report(on_progress, "delete", deleted, total)
            except Exception as exc:
                failed += 1
                log.error(f"  ERR  {key}  {item['VersionId']}: {exc}")

    return deleted, failed


def summarize_plans(plans: list[dict]) -> tuple[int, int]:
    """Return (versions_to_delete, bytes_reclaimed)."""
    versions_to_delete = 0
    bytes_reclaimed = 0

    for plan in plans:
        for item in plan["delete"]:
            versions_to_delete += 1
            if item["_type"] == "version":
                bytes_reclaimed += item.get("Size", 0)

    return versions_to_delete, bytes_reclaimed


def _log_scan_results(
    plans: list[dict],
    versions_to_delete: int,
    bytes_reclaimed: int,
    log: logging.Logger,
    *,
    verbose: bool,
) -> None:
    if not plans:
        log.info("No duplicate versions found.")
        return

    log.info(f"Found {len(plans):,} key(s) with duplicate versions.")
    log.info(
        f"Would delete {versions_to_delete:,} old version(s), "
        f"reclaiming ~{bytes_reclaimed / (1024 * 1024):.1f} MiB."
    )

    if verbose:
        for plan in plans:
            keep = plan["keep"]
            log.info(f"  KEEP {plan['key']}  {format_version(keep)}")
            for item in plan["delete"]:
                log.info(f"  DEL  {plan['key']}  {format_version(item)}")


def run_dedupe(
    *,
    prefix: str = "",
    apply: bool = False,
    verbose: bool = False,
    plans: list[dict] | None = None,
    on_progress: ProgressCallback | None = None,
    log: logging.Logger | None = None,
) -> DedupeResult:
    """Scan the bucket for duplicate versions and optionally delete old ones."""
    log = log or logging.getLogger("dedupe_bucket")
    prefix = prefix.strip()

    try:
        get_b2_credentials()
    except RuntimeError as exc:
        log.error(str(exc))
        return DedupeResult(bucket="", prefix=prefix, applied=apply, error=str(exc))

    b2, bucket = make_b2_client()
    log.info(f"Bucket : {bucket}")
    log.info(f"Prefix : {prefix or '(entire bucket)'}")
    log.info(f"Mode   : {'apply' if apply else 'dry-run'}")

    if plans is None:
        try:
            groups = collect_version_groups(b2, bucket, prefix, log, on_progress)
        except Exception as exc:
            msg = f"Could not list object versions: {exc}"
            log.error(msg)
            log.error("Is versioning enabled on this bucket?")
            return DedupeResult(bucket=bucket, prefix=prefix, applied=apply, error=msg)

        plans = plan_deletions(groups)
    else:
        log.info(f"Using cached scan — {len(plans):,} key(s) with duplicates.")

    versions_to_delete, bytes_reclaimed = summarize_plans(plans)
    _log_scan_results(plans, versions_to_delete, bytes_reclaimed, log, verbose=verbose)

    result = DedupeResult(
        bucket=bucket,
        prefix=prefix,
        applied=apply,
        keys_with_duplicates=len(plans),
        versions_to_delete=versions_to_delete,
        bytes_reclaimed=bytes_reclaimed,
        plans=plans,
    )

    if not plans:
        return result

    if not apply:
        log.info("Dry-run complete. Rerun with --apply to delete old versions.")
        return result

    deleted, failed = apply_deletions(b2, bucket, plans, log, on_progress)
    result.deleted_count = deleted
    result.failed_count = failed

    if failed:
        log.error(f"Done with errors: deleted {deleted:,}, failed {failed:,}.")
        result.error = f"{failed} deletion(s) failed"
        return result

    log.info(f"Done. Deleted {deleted:,} old version(s).")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Delete duplicate B2 object versions, keeping only the newest per key.",
    )
    parser.add_argument(
        "--prefix",
        default="",
        metavar="PREFIX",
        help="Only scan keys under this prefix (e.g. a video ID folder).",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually delete old versions (default: dry-run).",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Log every version kept/deleted.",
    )
    args = parser.parse_args()

    log = setup_logging(args.verbose)
    result = run_dedupe(prefix=args.prefix, apply=args.apply, verbose=args.verbose, log=log)
    if result.error:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
