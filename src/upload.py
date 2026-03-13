from pathlib import Path
from typing import Any
import logging
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


def upload_folder(b2: Any, local_dir: Path, b2_prefix: str, log: logging.Logger) -> bool:
    """
    Upload every file in local_dir to B2 under b2_prefix.
    Returns True if all uploads succeeded.
    """
    files  = list(local_dir.iterdir())
    total  = len(files)
    failed = []

    mime_map = {
        ".mpd":  "application/dash+xml",
        ".m3u8": "application/x-mpegURL",
        ".mp4":  "video/mp4",
        ".fmp4": "video/mp4",
    }

    for i, f in enumerate(files, 1):
        if not f.is_file():
            continue
        key          = f"{b2_prefix}/{f.name}"
        content_type = mime_map.get(f.suffix.lower(), "application/octet-stream")
        log.info(f"  Uploading [{i}/{total}] {f.name} → {key}")
        try:
            b2.upload_file(
                str(f),
                B2_BUCKET,
                key,
                ExtraArgs={"ContentType": content_type},
            )
        except Exception as e:
            log.error(f"  Upload failed for {f.name}: {e}")
            failed.append(f.name)

    if failed:
        log.error(f"  {len(failed)} file(s) failed to upload: {', '.join(failed)}")
        return False

    log.info(f"  Upload complete → b2://{B2_BUCKET}/{b2_prefix}/")
    return True
