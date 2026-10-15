import argparse
import logging
import math
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from logging import Logger
from uuid import uuid4


ROOT = Path(__file__).resolve().parent.parent


def generate_share_thumbnail(
    out_dir: Path,
    log: Logger,
    *,
    replace: bool = False,
) -> Path | None:
    """Create a crawler-compatible SDR JPEG from an existing SDR still.

    This only converts a still image; no video rendition is changed. Existing
    JPEGs are kept unless replace=True. Replacements are preserved in the
    project's .agent-trash directory after the new image has been generated.
    """
    out_dir = out_dir.resolve()
    try:
        out_dir.relative_to(ROOT)
    except ValueError:
        raise ValueError("Share thumbnails must be generated inside the project.") from None

    output = out_dir / "thumbnail_share.jpg"
    if output.is_symlink() or (output.exists() and not output.is_file()):
        raise ValueError("Refusing to replace a non-file share thumbnail.")
    if output.exists() and not replace:
        log.info("[THUMBNAIL]    Keeping existing thumbnail_share.jpg")
        return output

    # Full-resolution SDR preserves the source aspect ratio. The 720p image is
    # a useful fallback when backfilling a catalog with only small stills kept.
    source = next((
        path for path in (
            out_dir / "thumbnail_sdr.webp",
            out_dir / "thumbnail_sdr_720p.webp",
        ) if not path.is_symlink() and path.is_file()
    ), None)
    if source is None:
        log.warning("[THUMBNAIL]    No SDR WebP available for thumbnail_share.jpg")
        return None
    if not source.resolve().is_relative_to(ROOT):
        raise ValueError("Share thumbnail source must be inside the project.")

    # Write a new file first so an FFmpeg failure cannot destroy the old JPEG.
    temporary = out_dir / f".thumbnail_share-{uuid4().hex}.jpg"
    cmd = [
        "ffmpeg", "-nostdin", "-n", "-i", str(source),
        "-frames:v", "1", "-an",
        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,format=yuvj420p",
        "-c:v", "mjpeg", "-q:v", "2", "-update", "1",
        str(temporary),
    ]
    log.info("[THUMBNAIL]    Generating thumbnail_share.jpg ...")
    archived: Path | None = None
    try:
        subprocess.run(cmd, check=True, capture_output=True)
        if not temporary.is_file() or temporary.stat().st_size == 0:
            raise RuntimeError("FFmpeg did not produce a non-empty share thumbnail")

        if output.exists():
            if not replace:
                return output
            if not output.is_file() or output.is_symlink():
                raise ValueError("Refusing to replace a non-file share thumbnail.")
            trash = ROOT / ".agent-trash"
            if not trash.resolve().is_relative_to(ROOT):
                raise ValueError("Share thumbnail backups must stay inside the project.")
            timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M%S_%f")
            operation = trash / f"{timestamp}-replace-share-thumbnail-{uuid4().hex[:8]}"
            archived = operation / output.relative_to(ROOT)
            archived.parent.mkdir(parents=True, exist_ok=False)
            (operation / "manifest.txt").write_text(
                f"Original path: {output.relative_to(ROOT).as_posix()}\n"
                "Reason: replace social share thumbnail after successful JPEG generation.\n"
                "Task: add video link previews. Timestamp is UTC.\n"
                "Restoration: move the archived file to its original path; preserve or move "
                "the replacement first. No process needs stopping.\n",
                encoding="utf-8",
            )
            output.rename(archived)
            log.info("[THUMBNAIL]    Previous share thumbnail saved to %s", archived)
        temporary.rename(output)
        log.info("[THUMBNAIL]    thumbnail_share.jpg done")
        return output
    except (subprocess.CalledProcessError, OSError, RuntimeError) as exc:
        if archived is not None and archived.is_file() and not output.exists():
            archived.rename(output)
        detail = exc.stderr.decode(errors="replace") if isinstance(exc, subprocess.CalledProcessError) and exc.stderr else str(exc)
        log.warning("[THUMBNAIL]    Failed to generate thumbnail_share.jpg: %s", detail)
        return None
    finally:
        # This unique temporary image is reproducible from the SDR source above.
        temporary.unlink(missing_ok=True)


# ffprobe → zscale name mappings (pass-through for matching names, fallback to raw value)
_TRC_MAP = {
    "smpte2084":    "smpte2084",
    "arib-std-b67": "arib-std-b67",
    "bt2020-10":    "bt2020-10",
    "bt2020-12":    "bt2020-12",
    "bt709":        "bt709",
    "smpte428":     "smpte428",
}
_PRIMARIES_MAP = {
    "bt2020": "bt2020",
    "bt709":  "bt709",
    "p3":     "p3",
}
_MATRIX_MAP = {
    "bt2020nc": "bt2020nc",
    "bt2020c":  "bt2020c",
    "bt709":    "bt709",
}


def frame_to_seek(frame: int, fps: float, duration: float) -> float:
    """Convert a 1-based frame number to a seek time in seconds."""
    if frame < 1:
        raise ValueError(f"frame must be >= 1, got {frame}")

    total_frames = max(1, math.ceil(duration * fps))
    clamped = min(frame, total_frames)
    seek = (clamped - 1) / fps
    if seek >= duration:
        seek = max(0.0, duration - (1.0 / fps))
    return seek


def generate_thumbnails(
    input_path: Path,
    out_dir: Path,
    duration: float,
    color_primaries: str,
    color_trc: str,
    colorspace: str,
    log: Logger,
    seek_override: float | None = None,
) -> None:
    """Generate HDR/SDR stills plus an SDR JPEG for social link previews.

    All colorspace metadata is derived from probe data rather than hardcoded,
    so the output accurately reflects the source. Thumbnails are written to out_dir.
    """
    seek = seek_override if seek_override is not None else max(1.0, duration * 0.1)
    seek_str = f"{seek:.3f}"

    z_primaries = _PRIMARIES_MAP.get(color_primaries, color_primaries)
    z_trc       = _TRC_MAP.get(color_trc, color_trc)
    z_matrix    = _MATRIX_MAP.get(colorspace, colorspace)

    hdr_full = out_dir / "thumbnail_hdr.avif"
    hdr_720p = out_dir / "thumbnail_hdr_720p.avif"
    sdr_full = out_dir / "thumbnail_sdr.webp"
    sdr_720p = out_dir / "thumbnail_sdr_720p.webp"

    # HDR → SDR tonemap chain at full source resolution
    tonemap_full = (
        f"zscale=t=linear:npl=1000:m={z_matrix}:p={z_primaries},"
        "format=gbrpf32le,"
        "tonemap=mobius,"
        "zscale=p=bt709:t=bt709:m=bt709:r=tv,"
        "format=yuv420p"
    )
    # HDR → SDR at 720p: tonemap first at source res for quality, then scale down
    tonemap_720p = (
        f"zscale=t=linear:npl=1000:m={z_matrix}:p={z_primaries},"
        "format=gbrpf32le,"
        "tonemap=mobius,"
        "zscale=p=bt709:t=bt709:m=bt709:r=tv:w=1280:h=720:f=lanczos,"
        "format=yuv420p"
    )

    commands: list[tuple[Path, list[str]]] = [
        # Full-res HDR AVIF
        (hdr_full, [
            "ffmpeg", "-y", "-ss", seek_str, "-i", str(input_path),
            "-frames:v", "1", "-an",
            "-c:v", "libsvtav1", "-pix_fmt", "yuv420p10le",
            "-svtav1-params", "tune=0:enable-hdr=1",
            "-color_range", "tv",
            "-color_primaries", color_primaries,
            "-color_trc", color_trc,
            "-colorspace", colorspace,
            "-crf", "20",
            str(hdr_full),
        ]),
        # 720p HDR AVIF
        (hdr_720p, [
            "ffmpeg", "-y", "-ss", seek_str, "-i", str(input_path),
            "-frames:v", "1", "-an",
            "-vf", f"zscale=w=1280:h=720:f=lanczos:p={z_primaries}:t={z_trc}:m={z_matrix},format=yuv420p10le",
            "-c:v", "libsvtav1",
            "-svtav1-params", "tune=0:enable-hdr=1",
            "-color_range", "tv",
            "-color_primaries", color_primaries,
            "-color_trc", color_trc,
            "-colorspace", colorspace,
            "-crf", "20",
            str(hdr_720p),
        ]),
        # Full-res SDR WebP
        (sdr_full, [
            "ffmpeg", "-y", "-ss", seek_str, "-i", str(input_path),
            "-frames:v", "1", "-an",
            "-vf", tonemap_full,
            "-c:v", "libwebp", "-lossless", "0",
            "-compression_level", "6", "-q:v", "80",
            str(sdr_full),
        ]),
        # 720p SDR WebP — tonemap at source res first, then scale (quality-first)
        (sdr_720p, [
            "ffmpeg", "-y", "-ss", seek_str, "-i", str(input_path),
            "-frames:v", "1", "-an",
            "-vf", tonemap_720p,
            "-c:v", "libwebp", "-lossless", "0",
            "-compression_level", "6", "-q:v", "80",
            str(sdr_720p),
        ]),
    ]

    for out_file, cmd in commands:
        log.info(f"[THUMBNAIL]    Generating {out_file.name} ...")
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            log.info(f"[THUMBNAIL]    {out_file.name} done")
        except subprocess.CalledProcessError as e:
            log.warning(
                f"[THUMBNAIL]    Failed to generate {out_file.name}: "
                f"{e.stderr.decode(errors='replace')}\n"
                f"CMD: {' '.join(cmd)}"
            )

    generate_share_thumbnail(out_dir, log, replace=True)


def _parse_seek(value: str) -> float:
    """Parse a seek value — accepts seconds (e.g. '368.742') or HH:MM:SS.ms (e.g. '00:06:08.742')."""
    if ":" in value:
        parts = value.split(":")
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
    return float(value)


if __name__ == "__main__":
    from config import HDR_TRANSFERS, LOCAL_DIR
    from transcode import probe_video

    parser = argparse.ArgumentParser(description="Generate thumbnails for a video at a specific timestamp.")
    parser.add_argument("source", help="Path to the source video file.")
    parser.add_argument("--id", dest="video_id", required=True, help="Video ID (used as output folder name under web/local/).")
    parser.add_argument("--seek", default=None, help="Timestamp to capture (seconds or HH:MM:SS.ms). Default: 10%% of duration.")
    args = parser.parse_args()

    video_file = Path(args.source).resolve()
    if not video_file.is_file():
        print(f"Error: '{video_file}' is not a file.", file=sys.stderr)
        sys.exit(1)

    log = logging.getLogger("thumbnail")
    log.setLevel(logging.DEBUG)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s  %(levelname)-8s  %(message)s", "%Y-%m-%d %H:%M:%S"))
    log.addHandler(handler)

    probe = probe_video(video_file)
    vs = next((s for s in probe["streams"] if s["codec_type"] == "video"), None)
    if vs is None:
        print("Error: no video stream found.", file=sys.stderr)
        sys.exit(1)

    duration = float(probe.get("format", {}).get("duration", 0))
    color_primaries = vs.get("color_primaries", "bt709")
    color_trc = vs.get("color_transfer", "bt709")
    colorspace = vs.get("color_space", "bt709")

    seek = _parse_seek(args.seek) if args.seek else None
    if seek is not None and seek > duration:
        print(f"Warning: seek {seek:.3f}s exceeds duration {duration:.3f}s, clamping.", file=sys.stderr)
        seek = max(0, duration - 1.0)

    out_dir = LOCAL_DIR / args.video_id
    out_dir.mkdir(parents=True, exist_ok=True)

    log.info(f"Source     : {video_file}")
    log.info(f"Output     : {out_dir}")
    log.info(f"Duration   : {duration:.3f}s")
    log.info(f"Seek       : {seek if seek is not None else 'auto (10%)'}")

    generate_thumbnails(
        input_path=video_file,
        out_dir=out_dir,
        duration=duration,
        color_primaries=color_primaries,
        color_trc=color_trc,
        colorspace=colorspace,
        log=log,
        seek_override=seek,
    )
