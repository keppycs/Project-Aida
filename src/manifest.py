from pathlib import Path
import logging
import subprocess
import json
import re

from config import HEVC_LEVEL_BITRATES, HEVC_PROFILE_IDC


def get_hevc_codec_string(init_mp4: Path, maxrate_kbps: int, log: logging.Logger) -> str:
    """Probe an H265 init segment and return a full hvc1 codec string.

    Determines profile, level, and tier (Main vs High) based on maxrate_kbps
    against the HEVC level bitrate table from Wikipedia.
    Falls back to bare 'hvc1' on any failure.
    """
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", str(init_mp4)],
            capture_output=True, text=True,
        )
        data   = json.loads(result.stdout)
        stream = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
        if stream is None:
            raise ValueError("No video stream found")

        profile_name = stream.get("profile", "Main 10")
        level_idc    = int(stream.get("level", 156))
        profile_idc  = HEVC_PROFILE_IDC.get(profile_name, 2)

        # Determine tier: use High if Main tier max is insufficient for this variant's maxrate
        main_max, high_max = HEVC_LEVEL_BITRATES.get(level_idc, (60_000, 240_000))
        if maxrate_kbps <= main_max:
            tier = "L"  # Main tier
        elif high_max is not None:
            tier = "H"  # High tier
        else:
            tier = "L"  # High tier not defined at this level, stay Main

        codec_str = f"hvc1.{profile_idc}.4.{tier}{level_idc}.B0"
        log.info(f"  {init_mp4.name}: {profile_name} L{level_idc/30:.1f} → {codec_str}")
        return codec_str

    except Exception as e:
        log.warning(f"  Could not probe {init_mp4.name}: {e} — falling back to 'hvc1'")
        return "hvc1"


def build_hevc_codec_strings(out_dir: Path, variants: list, log: logging.Logger) -> list[str]:
    """Probe each init_N.mp4 in out_dir and return a per-variant list of full hvc1 codec strings."""
    codec_strings: list[str] = []
    for i, (_, _, _, maxrate_mbps) in enumerate(variants):
        init_mp4 = out_dir / f"init_{i}.mp4"
        codec_strings.append(get_hevc_codec_string(init_mp4, maxrate_mbps * 1000, log))
    return codec_strings


def patch_hls_video_range(master_path: Path, video_range: str, fps: float, log: logging.Logger) -> None:
    """Inject VIDEO-RANGE and FRAME-RATE on every EXT-X-STREAM-INF line in an HLS master."""
    text  = master_path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    out   = []
    fps_str = f"{fps:.3f}".rstrip("0").rstrip(".")

    for line in lines:
        if line.startswith("#EXT-X-STREAM-INF:"):
            line = line.rstrip()
            if "VIDEO-RANGE=" not in line:
                line += f",VIDEO-RANGE={video_range}"
            if "FRAME-RATE=" not in line:
                line += f",FRAME-RATE={fps_str}"
            line += "\n"
        out.append(line)

    master_path.write_text("".join(out), encoding="utf-8")
    log.info(f"  Patched VIDEO-RANGE={video_range}, FRAME-RATE={fps_str} into {master_path.name}")


def patch_hls_hdr(
    master_path: Path,
    codec_strings: list[str],
    video_range: str,
    fps: float,
    log: logging.Logger,
) -> None:
    """Patch the H265 HLS master playlist:
    - Replace bare 'hvc1' with full profile/level/tier codec strings.
    - Inject VIDEO-RANGE and FRAME-RATE on every EXT-X-STREAM-INF line.
    """
    text  = master_path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    out   = []
    stream_index = 0
    fps_str = f"{fps:.3f}".rstrip("0").rstrip(".")

    for line in lines:
        if line.startswith("#EXT-X-STREAM-INF:"):
            codec = codec_strings[stream_index] if stream_index < len(codec_strings) else "hvc1"
            # Replace bare hvc1 (with or without trailing comma/quote) with full string
            line = re.sub(r'hvc1(?=[,"])', codec, line.rstrip())
            # Inject VIDEO-RANGE if not already present
            if "VIDEO-RANGE=" not in line:
                line += f",VIDEO-RANGE={video_range}"
            if "FRAME-RATE=" not in line:
                line += f",FRAME-RATE={fps_str}"
            line += "\n"
            stream_index += 1
        out.append(line)

    master_path.write_text("".join(out), encoding="utf-8")
    log.info(f"  Patched HLS codec strings, VIDEO-RANGE={video_range}, FRAME-RATE={fps_str} into {master_path.name}")


def patch_bandwidth(
    out_dir: Path,
    num_variants: int,
    seg_duration: float,
    log: logging.Logger,
) -> None:
    """Compute peak and average bitrate from actual segment files and patch
    the HLS master playlist and DASH MPD with correct values.

    Video-only: scans chunk_{rep_id}_*.fmp4 for rep_id in 0..num_variants-1.
    HLS : BANDWIDTH        = peak segment bitrate (bits / seg_duration)
          AVERAGE-BANDWIDTH = mean segment bitrate
    DASH: bandwidth        = peak segment bitrate
    """
    peak_bps_list: list[int] = []
    avg_bps_list:  list[int] = []

    for rep_id in range(num_variants):
        segments = sorted(out_dir.glob(f"chunk_{rep_id}_*.fmp4"))
        if not segments:
            log.warning(f"  patch_bandwidth: no segments for rep {rep_id} — skipping")
            peak_bps_list.append(0)
            avg_bps_list.append(0)
            continue

        bps_per_seg = [s.stat().st_size * 8 / seg_duration for s in segments]
        peak = int(max(bps_per_seg))
        avg  = int(sum(bps_per_seg) / len(bps_per_seg))
        peak_bps_list.append(peak)
        avg_bps_list.append(avg)
        log.info(f"  rep {rep_id}: peak={peak // 1000}kbps  avg={avg // 1000}kbps  ({len(segments)} segments)")

    # ── HLS master ───────────────────────────────────────────────────────────
    hls_path = out_dir / "master.m3u8"
    if hls_path.exists():
        lines = hls_path.read_text(encoding="utf-8").splitlines(keepends=True)
        out   = []
        idx   = 0
        for line in lines:
            if line.startswith("#EXT-X-STREAM-INF:") and idx < len(peak_bps_list):
                line = line.rstrip()
                line = re.sub(r"BANDWIDTH=\d+", f"BANDWIDTH={peak_bps_list[idx]}", line)
                if "AVERAGE-BANDWIDTH=" in line:
                    line = re.sub(r"AVERAGE-BANDWIDTH=\d+", f"AVERAGE-BANDWIDTH={avg_bps_list[idx]}", line)
                else:
                    line += f",AVERAGE-BANDWIDTH={avg_bps_list[idx]}"
                line += "\n"
                idx += 1
            out.append(line)
        hls_path.write_text("".join(out), encoding="utf-8")
        log.info(f"  Patched HLS bandwidth in {hls_path.name}")

    # ── DASH MPD ─────────────────────────────────────────────────────────────
    # Video AdaptationSet is id=0 (always first); audio follows.
    # We replace only the first num_variants bandwidth= occurrences, which
    # correspond to the video Representation elements.
    mpd_path = out_dir / "manifest.mpd"
    if mpd_path.exists():
        text  = mpd_path.read_text(encoding="utf-8")
        count = 0

        def _dash_replacer(m: re.Match) -> str:
            nonlocal count
            if count >= num_variants:
                return m.group(0)
            bw = peak_bps_list[count]
            count += 1
            return f'bandwidth="{bw}"'

        patched = re.sub(r'bandwidth="\d+"', _dash_replacer, text)
        mpd_path.write_text(patched, encoding="utf-8")
        log.info(f"  Patched DASH bandwidth in {mpd_path.name}")


def patch_dash_hdr(
    mpd_path: Path,
    codec_strings: list[str],
    log: logging.Logger,
) -> None:
    """Patch the H265 DASH manifest:
    - Replace bare 'hvc1' codecs attribute on each video Representation
      with the full profile/level/tier codec string.
    """
    text      = mpd_path.read_text(encoding="utf-8")
    rep_index = 0

    def replacer(m: re.Match) -> str:
        nonlocal rep_index
        codec = codec_strings[rep_index] if rep_index < len(codec_strings) else "hvc1"
        rep_index += 1
        return f'codecs="{codec}"'

    # Only replace codecs="hvc1" (exact), leaving audio codecs untouched
    patched = re.sub(r'codecs="hvc1"', replacer, text)
    mpd_path.write_text(patched, encoding="utf-8")
    log.info(f"  Patched DASH codec strings into {mpd_path.name}")
