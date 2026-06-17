from pathlib import Path
import os

# ── B2 Config ──────────────────────────────────────────────────────────────────
# Credentials lazy-load from keyring first, .env fallback.
# No import-time crash when B2 is not configured.

_B2_KEYS = ("B2_KEY_ID", "B2_APP_KEY", "B2_BUCKET", "B2_ENDPOINT")
_b2_cache: dict[str, str] | None = None


def _load_b2_config() -> dict[str, str]:
    global _b2_cache
    if _b2_cache is not None:
        return _b2_cache

    config: dict[str, str] = {}

    try:
        import keyring
        for key in _B2_KEYS:
            val = keyring.get_password("project-aida", key)
            if val:
                config[key] = val
    except Exception:
        pass

    if len(config) < len(_B2_KEYS):
        try:
            from dotenv import load_dotenv
            load_dotenv(Path(__file__).parent.parent / ".env")
        except Exception:
            pass
        for key in _B2_KEYS:
            if key not in config:
                val = os.getenv(key)
                if val:
                    config[key] = val.strip()

    _b2_cache = config
    return config


def get_b2_config() -> dict[str, str]:
    """Return whatever B2 credentials are available (may be incomplete)."""
    return dict(_load_b2_config())


def get_b2_credentials() -> tuple[str, str, str, str]:
    """Return (key_id, app_key, bucket, endpoint). Raises if incomplete."""
    config = _load_b2_config()
    missing = [k for k in _B2_KEYS if k not in config]
    if missing:
        raise RuntimeError(
            f"Missing B2 credentials: {', '.join(missing)}. "
            "Configure them in the GUI settings or in a .env file."
        )
    return config["B2_KEY_ID"], config["B2_APP_KEY"], config["B2_BUCKET"], config["B2_ENDPOINT"]


def save_b2_credentials(key_id: str, app_key: str, bucket: str, endpoint: str) -> None:
    """Persist B2 credentials to the OS keyring."""
    import keyring
    for key, val in zip(_B2_KEYS, (key_id, app_key, bucket, endpoint)):
        keyring.set_password("project-aida", key, val)
    global _b2_cache
    _b2_cache = None


def b2_configured() -> bool:
    """True when all four B2 credentials are available."""
    return all(k in _load_b2_config() for k in _B2_KEYS)

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

