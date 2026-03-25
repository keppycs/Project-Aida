import subprocess
from pathlib import Path
from logging import Logger


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
) -> None:
    """Generate four thumbnails for a video: full-res and 720p, HDR (AVIF) and SDR (WebP).

    All colorspace metadata is derived from probe data rather than hardcoded,
    so the output accurately reflects the source. Thumbnails are written to out_dir.
    """
    seek = max(1.0, duration * 0.1)
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
