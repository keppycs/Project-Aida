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


def patch_hls_video_range(master_path: Path, video_range: str, log: logging.Logger) -> None:
    """Inject VIDEO-RANGE on every EXT-X-STREAM-INF line in an HLS master."""
    text  = master_path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    out   = []

    for line in lines:
        if line.startswith("#EXT-X-STREAM-INF:"):
            line = line.rstrip()
            if "VIDEO-RANGE=" not in line:
                line += f",VIDEO-RANGE={video_range}"
            line += "\n"
        out.append(line)

    master_path.write_text("".join(out), encoding="utf-8")
    log.info(f"  Patched VIDEO-RANGE={video_range} into {master_path.name}")


def patch_hls_hdr(
    master_path: Path,
    codec_strings: list[str],
    video_range: str,
    log: logging.Logger,
) -> None:
    """Patch the H265 HLS master playlist:
    - Replace bare 'hvc1' with full profile/level/tier codec strings.
    - Inject VIDEO-RANGE on every EXT-X-STREAM-INF line.
    """
    text  = master_path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    out   = []
    stream_index = 0

    for line in lines:
        if line.startswith("#EXT-X-STREAM-INF:"):
            codec = codec_strings[stream_index] if stream_index < len(codec_strings) else "hvc1"
            # Replace bare hvc1 (with or without trailing comma/quote) with full string
            line = re.sub(r'hvc1(?=[,"])', codec, line.rstrip())
            # Inject VIDEO-RANGE if not already present
            if "VIDEO-RANGE=" not in line:
                line += f",VIDEO-RANGE={video_range}"
            line += "\n"
            stream_index += 1
        out.append(line)

    master_path.write_text("".join(out), encoding="utf-8")
    log.info(f"  Patched HLS codec strings and VIDEO-RANGE={video_range} into {master_path.name}")


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
