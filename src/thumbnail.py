import argparse
import logging
import subprocess
import sys
from pathlib import Path
from logging import Logger

from transcode import probe_video, parse_framerate


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
    """Generate four thumbnails for a video: full-res and 720p, HDR (AVIF) and SDR (WebP).

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
    from config import HDR_TRANSFERS

    parser = argparse.ArgumentParser(description="Generate thumbnails for a video at a specific timestamp.")
    parser.add_argument("source", help="Path to the source video file.")
    parser.add_argument("--id", dest="video_id", required=True, help="Video ID (used as output folder name under docs/local/).")
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

    root = Path(__file__).parent.parent
    out_dir = root / "docs" / "local" / args.video_id
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
