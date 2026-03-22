from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any
import argparse
import logging
import sys
import boto3
from botocore.config import Config

from config import B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_ENDPOINT


MIME_MAP = {
    ".mpd":  "application/dash+xml",
    ".m3u8": "application/x-mpegURL",
    ".mp4":  "video/mp4",
    ".fmp4": "video/mp4",
    ".json": "application/json",
}


def make_b2_client() -> Any:
    return boto3.client(
        "s3",
        endpoint_url=B2_ENDPOINT,
        aws_access_key_id=B2_KEY_ID,
        aws_secret_access_key=B2_APP_KEY,
        config=Config(signature_version="s3v4"),
    )


def is_already_uploaded(b2: Any, bucket: str, video_id: str, log: logging.Logger) -> bool:
    """Check if metadata.json already exists for this video ID in B2."""
    try:
        b2.head_object(Bucket=bucket, Key=f"{video_id}/metadata.json")
        return True
    except Exception as e:
        if "404" in str(e) or "NoSuchKey" in str(e) or "Not Found" in str(e):
            return False
        log.warning(f"Could not check B2 for existing upload at '{video_id}': {e}")
        return False


def upload_folder(b2: Any, local_dir: Path, b2_prefix: str, log: logging.Logger, max_workers: int = 20) -> bool:
    """Upload all files in local_dir recursively to B2 under b2_prefix, concurrently.

    Returns True if all uploads succeeded.
    """
    files = [f for f in local_dir.rglob("*") if f.is_file()]
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
            b2.upload_file(str(f), B2_BUCKET, key, ExtraArgs={"ContentType": content_type})
            log.debug(f"  OK  {key}")
            result = None
        except Exception as e:
            log.debug(f"  ERR {key}: {e}")
            result = str(relative)
        with lock:
            done += 1
            # \r overwrites the line in the terminal; debug log gets full detail
            ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            sys.stdout.write(f"\r{ts}  INFO      [UPLOAD]       {done}/{total} files")
            sys.stdout.flush()
        return result

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(upload_one, f): f for f in files}
        for future in as_completed(futures):
            result = future.result()
            if result:
                failed.append(result)

    print()  # newline after the progress line

    if failed:
        log.error(f"  {len(failed)} file(s) failed: {', '.join(failed)}")
        return False

    log.info(f"  Upload complete → b2://{B2_BUCKET}/{b2_prefix}/")
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Upload a video ID folder to the Project Aida B2 bucket.")
    parser.add_argument("folder", help="Path to the video ID folder (e.g. docs/debug/00000000000). All contents uploaded recursively.")
    parser.add_argument("--prefix", default=None, metavar="PREFIX",
                        help="B2 key prefix override (default: folder name, i.e. the video ID)")
    args = parser.parse_args()

    folder = Path(args.folder).resolve()
    if not folder.is_dir():
        print(f"Error: '{folder}' is not a directory.", file=sys.stderr)
        sys.exit(1)

    prefix = args.prefix or folder.name

    log = logging.getLogger("upload")
    log.setLevel(logging.DEBUG)
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(logging.INFO)  # console: INFO+ only, per-file detail is DEBUG
    handler.setFormatter(logging.Formatter("%(asctime)s  %(levelname)-8s  %(message)s", "%Y-%m-%d %H:%M:%S"))
    log.addHandler(handler)
    log.propagate = False

    log.info(f"Folder : {folder}")
    log.info(f"Prefix : {prefix}")
    log.info(f"Bucket : {B2_BUCKET}")

    b2 = make_b2_client()
    ok = upload_folder(b2, folder, prefix, log)
    sys.exit(0 if ok else 1)
