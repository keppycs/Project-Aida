from dotenv import load_dotenv
from pathlib import Path
from typing import Optional
import os

load_dotenv(Path(__file__).parent.parent / ".env")

# ── B2 Config ──────────────────────────────────────────────────────────────────
def _require_env(key: str) -> str:
    val = os.getenv(key)
    if not val:
        raise RuntimeError(f"Missing required environment variable: {key}")
    return val

B2_KEY_ID   = _require_env("B2_KEY_ID")
B2_APP_KEY  = _require_env("B2_APP_KEY")
B2_BUCKET   = _require_env("B2_BUCKET")
B2_ENDPOINT = _require_env("B2_ENDPOINT")  # region is embedded in the endpoint URL

# Set to True to upload encoded segments to B2 after encoding.
# Disable when testing locally to skip the upload step entirely.
UPLOAD_TO_B2 = False

# Set to True to delete local transcode files after a successful upload.
# The source video and log are always kept locally regardless.
DELETE_TRANSCODES_AFTER_UPLOAD = False

# ── Encoder settings ──────────────────────────────────────────────────────────
# Flip FAST_TRANSCODE to True for quick test encodes.
# All quality enhancement flags are disabled and preset is dialled down to p1.
FAST_TRANSCODE = False

ENCODE_SETTINGS_PRODUCTION = {
    # NVENC
    "preset":            "p7",
    "tune":              "hq",
    "multipass":         "fullres",
    "split_encode_mode": "forced",
    "spatial_aq":        True,
    "temporal_aq":       True,
    "aq_strength":       8,
    "rc_lookahead":      32,
    "lookahead_level":   3,
    "b_ref_mode":        "middle",
    "sc_threshold":      0,
    "strict_gop":        1,
    # Filter graph
    "scale_algo":        "lanczos",
    # Audio
    "audio_codec":       "aac",
    "audio_bitrate":     "320k",
}

ENCODE_SETTINGS_FAST = {
    # NVENC
    "preset":            "p1",
    "tune":              "ull",
    "multipass":         "disabled",
    "split_encode_mode": "forced",
    "spatial_aq":        False,
    "temporal_aq":       False,
    "aq_strength":       1,
    "rc_lookahead":      0,
    "lookahead_level":   0,
    "b_ref_mode":        "disabled",
    "sc_threshold":      0,
    "strict_gop":        1,
    # Filter graph
    "scale_algo":        "lanczos",
    # Audio
    "audio_codec":       "aac",
    "audio_bitrate":     "128k",
}

ENCODE_SETTINGS = ENCODE_SETTINGS_FAST if FAST_TRANSCODE else ENCODE_SETTINGS_PRODUCTION

# ── Ladder ─────────────────────────────────────────────────────────────────────
# Each entry: (label, resolution, cq, maxrate_mbps)
# maxrate is enforced as a ceiling — CQ drives quality, maxrate caps segment size.
# bufsize is always 2× maxrate (2-second window, aligned to seg duration).
# 2160p Max has a high cap to let quality breathe — in practice CQ will sit well below it.

VARIANTS_AV1_PRODUCTION = [
    ("2160p_Max", "3840:2160", 21, 60),
    ("2160p",     "3840:2160", 24, 40),
    ("1440p",     "2560:1440", 26, 25),
    ("1080p",     "1920:1080", 28, 15),
    ("720p",      "1280:720",  32, 10),
    ("540p",      "960:540",   34,  6),
    ("360p",      "640:360",   36,  3),
]

VARIANTS_H265_PRODUCTION = [
    ("2160p_Max", "3840:2160", 18, 60),
    ("2160p",     "3840:2160", 20, 40),
    ("1440p",     "2560:1440", 22, 25),
    ("1080p",     "1920:1080", 25, 15),
    ("720p",      "1280:720",  28, 10),
    ("540p",      "960:540",   32,  6),
    ("360p",      "640:360",   34,  3),
]

VARIANTS_AV1_FAST = [
    ("2160p", "3840:2160", 50, 1),
    ("1080p", "1920:1080", 50, 1),
    ("720p",  "1280:720",  50, 1),
]

VARIANTS_H265_FAST = [
    ("2160p", "3840:2160", 50, 1),
    ("1080p", "1920:1080", 50, 1),
    ("720p",  "1280:720",  50, 1),
]

VARIANTS_AV1  = VARIANTS_AV1_FAST  if FAST_TRANSCODE else VARIANTS_AV1_PRODUCTION
VARIANTS_H265 = VARIANTS_H265_FAST if FAST_TRANSCODE else VARIANTS_H265_PRODUCTION

CODECS: dict[str, tuple[str, list]] = {
    #          encoder         variant ladder
    "AV1":  ("av1_nvenc",  VARIANTS_AV1),
    "H265": ("hevc_nvenc", VARIANTS_H265),
}

CUDA_DECODERS = {
    "av1":  "av1_cuvid",
    "hevc": "hevc_cuvid",
    "h264": "h264_cuvid",
    "vp9":  "vp9_cuvid",
}

HDR_TRANSFERS    = {"smpte2084", "arib-std-b67", "smpte428", "bt2020-10", "bt2020-12"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".mxf", ".mts", ".m2ts"}
SEG_DURATION     = 2

# config_local.py is gitignored — override any flag defined above this line.
# The HEVC tables below cannot be overridden as they load after this import.
try:
    from config_local import *  # noqa: F401, F403
except ImportError:
    pass

# ── HEVC level/tier bitrate limits ────────────────────────────────────────────
# Source: https://en.wikipedia.org/wiki/High_Efficiency_Video_Coding_tiers_and_levels
# Keys are level_idc (level × 30). Values are (main_tier_max_kbps, high_tier_max_kbps).
# High tier is only defined from Level 4.0 (idc=120) onwards.
HEVC_LEVEL_BITRATES: dict[int, tuple[int, Optional[int]]] = {
    30:  (128,    None),
    60:  (1_500,  None),
    63:  (3_000,  None),
    90:  (6_000,  None),
    93:  (10_000, None),
    120: (12_000, 30_000),
    123: (20_000, 50_000),
    150: (25_000, 100_000),
    153: (40_000, 160_000),
    156: (60_000, 240_000),
    180: (60_000, 240_000),
    183: (120_000, 480_000),
    186: (240_000, 800_000),
}

# Map ffprobe profile name → profile_idc used in codec string
HEVC_PROFILE_IDC: dict[str, int] = {
    "Main":               1,
    "Main 10":            2,
    "Main Still Picture": 3,
    "Rext":               4,
}
