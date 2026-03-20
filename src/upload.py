from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any
import argparse
import logging
import sys
import boto3
from botocore.config import Config

from config import B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_ENDPOINT


def make_b2_client() -> Any:
    return boto3.client(
        "s3",
        endpoint_url=B2_ENDPOINT,
        aws_access_key_id=B2_KEY_ID,
        aws_secret_access_key=B2_APP_KEY,
        config=Config(signature_version="s3v4"),
    )


def is_already_uploaded(b2: Any, bucket: str, prefix: str, log: logging.Logger) -> bool:
    """Check if a manifest already exists at this prefix in B2."""
    try:
        b2.head_object(Bucket=bucket, Key=f"{prefix}/manifest.mpd")
        return True
    except Exception as e:
        if "404" in str(e) or "NoSuchKey" in str(e) or "Not Found" in str(e):
            return False
        log.warning(f"Could not check B2 for existing upload at '{prefix}': {e}")
        return False


def upload_folder(b2: Any, local_dir: Path, b2_prefix: str, log: logging.Logger, max_workers: int = 20) -> bool:
    files  = [f for f in local_dir.rglob("*") if f.is_file()]
    total  = len(files)
    failed = []

    mime_map = {
        ".mpd":  "application/dash+xml",
        ".m3u8": "application/x-mpegURL",
        ".mp4":  "video/mp4",
        ".fmp4": "video/mp4",
    }

    def upload_one(i: int, f: Path) -> str | None:
        relative     = f.relative_to(local_dir)
        key          = f"{b2_prefix}/{relative.as_posix()}"
        content_type = mime_map.get(f.suffix.lower(), "application/octet-stream")
        log.info(f"  Uploading [{i}/{total}] {relative.as_posix()} → {key}")
        try:
            b2.upload_file(
                str(f),
                B2_BUCKET,
                key,
                ExtraArgs={"ContentType": content_type},
            )
            return None
        except Exception as e:
            log.error(f"  Upload failed for {relative.as_posix()}: {e}")
            return str(relative)

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {
            pool.submit(upload_one, i, f): f
            for i, f in enumerate(files, 1)
        }
        for future in as_completed(futures):
            result = future.result()
            if result:
                failed.append(result)

    if failed:
        log.error(f"  {len(failed)} file(s) failed to upload: {', '.join(failed)}")
        return False

    log.info(f"  Upload complete → b2://{B2_BUCKET}/{b2_prefix}/")
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Upload a local folder to the Project Aida B2 bucket.")
    parser.add_argument("folder", help="Path to the folder to upload (e.g. docs/debug/00000000000/AV1)")
    parser.add_argument("--prefix", default=None, metavar="PREFIX",
                        help="B2 key prefix override (default: last two path components, e.g. 00000000000/AV1)")
    args = parser.parse_args()

    folder = Path(args.folder).resolve()
    if not folder.is_dir():
        print(f"Error: '{folder}' is not a directory.", file=sys.stderr)
        sys.exit(1)

    # Derive prefix from last two components (id/codec) unless overridden
    prefix = args.prefix or folder.name

    log = logging.getLogger("upload")
    log.setLevel(logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s  %(levelname)-8s  %(message)s", "%Y-%m-%d %H:%M:%S"))
    log.addHandler(handler)
    log.propagate = False

    log.info(f"Folder : {folder}")
    log.info(f"Prefix : {prefix}")
    log.info(f"Bucket : {B2_BUCKET}")

    b2 = make_b2_client()
    ok = upload_folder(b2, folder, prefix, log)
    sys.exit(0 if ok else 1)
