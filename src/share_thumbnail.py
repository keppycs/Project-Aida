"""Backfill social JPEG stills from local WebP thumbnails without uploading.

Examples:
    python src/share_thumbnail.py docs/local/VIDEO_ID
    python src/share_thumbnail.py --all
    python src/share_thumbnail.py docs/local/VIDEO_ID --replace

Existing JPEGs are skipped unless --replace is supplied. Replaced JPEGs are
preserved in .agent-trash. This tool never re-encodes video or contacts B2.
"""

import argparse
import logging
from pathlib import Path

from thumbnail import ROOT, generate_share_thumbnail


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("folder", nargs="?", type=Path, help="Local video output directory inside this project.")
    selection.add_argument("--all", action="store_true", help="Process all direct video directories in docs/local.")
    parser.add_argument("--replace", action="store_true", help="Regenerate existing JPEGs, saving their previous versions in .agent-trash.")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    log = logging.getLogger("share-thumbnail")
    base = ((ROOT / "docs" / "local") if args.all else args.folder).resolve()
    if not base.is_relative_to(ROOT):
        parser.error("The output directory must be inside this project.")
    if not base.is_dir():
        parser.error(f"Directory does not exist: {base}")

    directories = sorted(path for path in base.iterdir() if not path.is_symlink() and path.is_dir()) if args.all else [base]
    failed = 0
    for directory in directories:
        try:
            result = generate_share_thumbnail(directory, log, replace=args.replace)
        except ValueError as exc:
            log.error("%s: %s", directory, exc)
            result = None
        if result is None:
            failed += 1
    log.info("Share thumbnails ready: %d; failed or missing source: %d", len(directories) - failed, failed)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
