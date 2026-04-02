from dotenv import load_dotenv
from pathlib import Path
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

# Set to True to generate thumbnails (HDR AVIF + SDR WebP, full-res and 720p) alongside each encode.
GENERATE_THUMBNAILS = True

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
    "strict_gop":        1,
    # Filter graph (zscale filter name)
    "scale_algo":        "spline36",
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
    "strict_gop":        1,
    # Filter graph (zscale filter name)
    "scale_algo":        "spline36",
    # Audio
    "audio_codec":       "aac",
    "audio_bitrate":     "128k",
}

# ── Ladder ─────────────────────────────────────────────────────────────────────
# Each entry: (label, resolution, cq, maxrate_mbps)
# maxrate is enforced as a ceiling — CQ drives quality, maxrate caps segment size.
# bufsize is always SEG_DURATION × maxrate (aligned to seg duration).

VARIANTS_AV1_PRODUCTION = [
    ("2160p",     "3840:2160", 24, 40),
    ("1440p",     "2560:1440", 26, 25),
    ("1080p",     "1920:1080", 28, 15),
    ("720p",      "1280:720",  30, 10),
    ("540p",      "960:540",   30,  6),
    ("360p",      "640:360",   30,  3),
]

VARIANTS_HEVC_PRODUCTION = [
    ("2160p",     "3840:2160", 20, 40),
    ("1440p",     "2560:1440", 22, 25),
    ("1080p",     "1920:1080", 25, 15),
    ("720p",      "1280:720",  27, 10),
    ("540p",      "960:540",   31,  6),
    ("360p",      "640:360",   33,  3),
]

VARIANTS_AV1_FAST = [
    ("2160p", "3840:2160", 50, 1),
    ("1080p", "1920:1080", 50, 1),
    ("720p",  "1280:720",  50, 1),
]

VARIANTS_HEVC_FAST = [
    ("2160p", "3840:2160", 50, 1),
    ("1080p", "1920:1080", 50, 1),
    ("720p",  "1280:720",  50, 1),
]

CUDA_DECODERS = {
    "av1":  "av1_cuvid",
    "hevc": "hevc_cuvid",
    "h264": "h264_cuvid",
    "vp9":  "vp9_cuvid",
}

HDR_TRANSFERS    = {"smpte2084", "arib-std-b67", "smpte428", "bt2020-10", "bt2020-12"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".mxf", ".mts", ".m2ts"}
SEG_DURATION     = 4

# config_local.py is gitignored — override any flag defined above this line.
try:
    from config_local import *  # noqa: F401, F403
except ImportError:
    pass

# ── Derived settings — resolved after config_local overrides ───────────────────────
ENCODE_SETTINGS = ENCODE_SETTINGS_FAST if FAST_TRANSCODE else ENCODE_SETTINGS_PRODUCTION

VARIANTS_AV1  = VARIANTS_AV1_FAST  if FAST_TRANSCODE else VARIANTS_AV1_PRODUCTION
VARIANTS_HEVC = VARIANTS_HEVC_FAST if FAST_TRANSCODE else VARIANTS_HEVC_PRODUCTION

CODECS: dict[str, tuple[str, list]] = {
    #          encoder         variant ladder
    "AV1":  ("av1_nvenc",  VARIANTS_AV1),
    "HEVC": ("hevc_nvenc", VARIANTS_HEVC),
}

