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
B2_REGION   = _require_env("B2_REGION")
B2_ENDPOINT = _require_env("B2_ENDPOINT")

# Set to True to upload encoded segments to B2 after encoding.
# Disable when testing locally to skip the upload step entirely.
UPLOAD_TO_B2 = False

# Set to True to delete local transcode files after a successful upload.
# The source video and log are always kept locally regardless.
DELETE_TRANSCODES_AFTER_UPLOAD = False

# ── Ladder ─────────────────────────────────────────────────────────────────────
# Each entry: (label, resolution, cq, maxrate_mbps)
# maxrate is enforced as a ceiling — CQ drives quality, maxrate caps segment size.
# bufsize is always 2× maxrate (2-second window, aligned to seg duration).
# 2160p Max has a high cap to let quality breathe — in practice CQ will sit well below it.

VARIANTS_AV1 = [
    ("2160p_Max", "3840:2160", 18, 180),
    ("2160p",     "3840:2160", 24,  80),
    ("1440p",     "2560:1440", 26,  50),
    ("1080p",     "1920:1080", 28,  30),
    ("720p",      "1280:720",  32,  15),
    ("540p",      "960:540",   32,  15),
    ("360p",      "640:360",   32,  15),
]

VARIANTS_H265 = [
    ("2160p_Max", "3840:2160", 15, 180),
    ("2160p",     "3840:2160", 20,  80),
    ("1440p",     "2560:1440", 22,  50),
    ("1080p",     "1920:1080", 24,  30),
    ("720p",      "1280:720",  28,  15),
    ("540p",      "960:540",   32,  15),
    ("360p",      "640:360",   32,  15),
]

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
