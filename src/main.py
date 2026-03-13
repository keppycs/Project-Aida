from dotenv import load_dotenv
from pathlib import Path
from datetime import datetime
from fractions import Fraction
from typing import Optional, Any
import os
import subprocess
import logging
import json
import sys
import math
import re
import boto3
from botocore.config import Config

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


# ── Helpers ────────────────────────────────────────────────────────────────────

def probe_video(path: Path) -> dict:
    cmd = [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_streams", "-show_format",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed:\n{result.stderr}")
    return json.loads(result.stdout)


def setup_logging(log_path: Path) -> logging.Logger:
    log = logging.getLogger("transcode")
    log.setLevel(logging.DEBUG)
    fmt = logging.Formatter("%(asctime)s  %(levelname)-8s  %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = logging.FileHandler(log_path, encoding="utf-8")
    fh.setFormatter(fmt)
    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(fmt)
    log.addHandler(fh)
    log.addHandler(ch)
    return log


def parse_framerate(r_frame_rate: str) -> float:
    try:
        return float(Fraction(r_frame_rate))
    except Exception:
        return 30.0


def is_already_encoded(out_dir: Path) -> bool:
    return (out_dir / "manifest.mpd").exists() and any(out_dir.glob("*.fmp4"))


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
    "Main":              1,
    "Main 10":           2,
    "Main Still Picture": 3,
    "Rext":              4,
}


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
        data    = json.loads(result.stdout)
        stream  = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
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


def patch_hls_video_range(master_path: Path, log: logging.Logger) -> None:
    """Inject VIDEO-RANGE=PQ on every EXT-X-STREAM-INF line in an HLS master."""
    text  = master_path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    out   = []

    for line in lines:
        if line.startswith("#EXT-X-STREAM-INF:"):
            line = line.rstrip()
            if "VIDEO-RANGE=" not in line:
                line += ",VIDEO-RANGE=PQ"
            line += "\n"
        out.append(line)

    master_path.write_text("".join(out), encoding="utf-8")
    log.info(f"  Patched VIDEO-RANGE=PQ into {master_path.name}")


def patch_hls_hdr(
    master_path: Path,
    out_dir: Path,
    variants: list,
    log: logging.Logger,
) -> None:
    """Patch the H265 HLS master playlist:
    - Replace bare 'hvc1' codec strings with full profile/level/tier strings
      probed from each init segment.
    - Inject VIDEO-RANGE=PQ on every EXT-X-STREAM-INF line.
    """
    # Build per-stream codec strings by probing init_N.mp4 files
    codec_strings: list[str] = []
    for i, (_, _, _, maxrate_mbps) in enumerate(variants):
        init_mp4 = out_dir / f"init_{i}.mp4"
        codec_strings.append(get_hevc_codec_string(init_mp4, maxrate_mbps * 1000, log))

    text  = master_path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    out   = []
    stream_index = 0

    for line in lines:
        if line.startswith("#EXT-X-STREAM-INF:"):
            codec = codec_strings[stream_index] if stream_index < len(codec_strings) else "hvc1"
            # Replace bare hvc1 (with or without trailing comma/quote) with full string
            line = re.sub(r'hvc1(?=[,"])', codec, line.rstrip())
            # Inject VIDEO-RANGE=PQ if not already present
            if "VIDEO-RANGE=" not in line:
                line += ",VIDEO-RANGE=PQ"
            line += "\n"
            stream_index += 1
        out.append(line)

    master_path.write_text("".join(out), encoding="utf-8")
    log.info(f"  Patched codec strings and VIDEO-RANGE=PQ into {master_path.name}")


def build_cmd(
    source: Path,
    encoder: str,
    variants: list,
    cuda_decoder: Optional[str],
    color_primaries: str,
    color_trc: str,
    colorspace: str,
    gop_size: int,
) -> list:
    split_count   = len(variants)
    split_outputs = "".join(f"[v{i}]" for i in range(split_count))

    # ── Filter graph ────────────────────────────────────────────────────────────
    filter_parts = [f"[0:v]split={split_count}{split_outputs}"]
    for i, (_, res, _, _) in enumerate(variants):
        filter_parts.append(f"[v{i}]scale_cuda={res}:format=p010le:interp_algo=lanczos[s{i}]")

    filter_graph = ";".join(filter_parts)

    # ── Input ───────────────────────────────────────────────────────────────────
    cmd = ["ffmpeg", "-y"]
    if cuda_decoder:
        cmd += [
            "-hwaccel",               "cuda",
            "-hwaccel_output_format", "cuda",
            "-c:v",                   cuda_decoder,
        ]

    cmd += ["-i", str(source)]
    cmd += ["-filter_complex", filter_graph]

    # ── Stream mapping ──────────────────────────────────────────────────────────
    for i in range(split_count):
        cmd += ["-map", f"[s{i}]"]
    cmd += ["-map", "0:a?"]

    # ── Per-stream video encode options ─────────────────────────────────────────
    is_hevc = encoder == "hevc_nvenc"

    for i, (_, _, cq, maxrate_mbps) in enumerate(variants):
        maxrate_k = maxrate_mbps * 1000  # kbps for ffmpeg
        bufsize_k = maxrate_k * 2        # 2× maxrate = 2s buffer window

        cmd += [
            # Codec + quality
            f"-c:v:{i}",               encoder,
            f"-preset:v:{i}",          "p7",
            f"-tune:v:{i}",            "hq",
            f"-rc:v:{i}",              "vbr",          # explicit VBR for CQ+maxrate
            f"-cq:v:{i}",              str(cq),
            f"-maxrate:v:{i}",         f"{maxrate_k}k",
            f"-bufsize:v:{i}",         f"{bufsize_k}k",

            # GOP / keyframe alignment
            f"-g:v:{i}",               str(gop_size),
            f"-keyint_min:v:{i}",      str(gop_size),
            f"-sc_threshold:v:{i}",    "0",
            f"-strict_gop:v:{i}",      "1",

            # Quality enhancement
            f"-multipass:v:{i}",       "fullres",
            f"-split_encode_mode:v:{i}", "forced",
            f"-spatial-aq:v:{i}",      "1",
            f"-temporal-aq:v:{i}",     "1",
            f"-aq-strength:v:{i}",     "8",
            f"-rc-lookahead:v:{i}",    "32",
            f"-lookahead_level:v:{i}", "3",
            f"-b_ref_mode:v:{i}",      "middle",

            # HDR metadata
            f"-color_primaries:v:{i}", color_primaries,
            f"-color_trc:v:{i}",       color_trc,
            f"-colorspace:v:{i}",      colorspace,

            # Container tag — hvc1 for Safari compatibility, av01 for AV1
            f"-tag:v:{i}",             "hvc1" if is_hevc else "av01",
        ]

    # ── Audio ───────────────────────────────────────────────────────────────────
    cmd += ["-c:a", "aac", "-b:a", "320k"]

    # ── CMAF DASH + HLS output ──────────────────────────────────────────────────
    cmd += [
        "-f",                 "dash",
        "-dash_segment_type", "mp4",
        "-seg_duration",      str(SEG_DURATION),
        "-use_template",      "1",
        "-use_timeline",      "0",
        "-hls_playlist",      "1",
        "-hls_master_name",   "master.m3u8",
        "-adaptation_sets",   "id=0,streams=v id=1,streams=a",
        "-init_seg_name",     "init_$RepresentationID$.mp4",
        "-media_seg_name",    "chunk_$RepresentationID$_$Number$.fmp4",
        "manifest.mpd",
    ]

    return cmd


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    root = Path(__file__).parent

    video_file = next(
        (f for f in root.iterdir()
         if f.is_file() and f.suffix.lower() in VIDEO_EXTENSIONS),
        None,
    )
    if video_file is None:
        raise RuntimeError("No video file found.")

    transcodes_root = root.parent / "transcodes"
    transcodes_root.mkdir(exist_ok=True)
    video_folder = transcodes_root / video_file.stem
    video_folder.mkdir(exist_ok=True)
    new_video = video_folder / video_file.name
    if not new_video.exists():
        video_file.rename(new_video)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log       = setup_logging(video_folder / f"transcode_{timestamp}.log")

    log.info(f"Source  : {new_video}")
    probe = probe_video(new_video)

    video_stream = next(
        (s for s in probe["streams"] if s["codec_type"] == "video"), None
    )
    if video_stream is None:
        raise RuntimeError("No video stream found in source.")

    source_codec    = video_stream.get("codec_name",      "")
    color_primaries = video_stream.get("color_primaries", "bt2020")
    color_trc       = video_stream.get("color_transfer",  "smpte2084")
    colorspace      = video_stream.get("color_space",     "bt2020nc")
    fps             = parse_framerate(video_stream.get("r_frame_rate", "60/1"))
    gop_size        = math.ceil(fps * SEG_DURATION)

    log.info(f"Codec           : {source_codec}")
    log.info(f"Frame rate      : {fps:.3f} fps")
    log.info(f"GOP size        : {gop_size} frames  ({SEG_DURATION}s x {fps:.0f}fps)")
    log.info(f"Color primaries : {color_primaries}")
    log.info(f"Color transfer  : {color_trc}")
    log.info(f"Color space     : {colorspace}")

    if color_trc not in HDR_TRANSFERS:
        log.warning(
            f"Transfer '{color_trc}' is not a recognised HDR transfer function. "
            "Metadata will be copied as-is — verify your output."
        )

    cuda_decoder = CUDA_DECODERS.get(source_codec)
    if cuda_decoder:
        log.info(f"CUDA decoder    : {cuda_decoder}")
    else:
        log.warning(
            f"No CUDA decoder for '{source_codec}'. "
            "Falling back to software decode — GPU encode still active."
        )

    b2               = make_b2_client()
    transcode_errors: list[str] = []
    upload_errors:    list[str] = []

    for codec_name, (encoder, variants) in CODECS.items():
        out_dir   = video_folder / codec_name
        b2_prefix = f"{video_file.stem}/{codec_name}"

        out_dir.mkdir(parents=True, exist_ok=True)

        if is_already_encoded(out_dir):
            log.info(f"[SKIP ENCODE]  {codec_name} — segments already exist locally.")
        else:
            log.info(f"[START ENCODE] {codec_name}  encoder={encoder}")
            log.info(f"  Ladder: {' | '.join(f'{n} CQ{c} {m}Mbps' for n, _, c, m in variants)}")

            cmd = build_cmd(
                source=new_video,
                encoder=encoder,
                variants=variants,
                cuda_decoder=cuda_decoder,
                color_primaries=color_primaries,
                color_trc=color_trc,
                colorspace=colorspace,
                gop_size=gop_size,
            )

            log.debug("CMD: " + " ".join(cmd))

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                cwd=out_dir,
            )

            if result.returncode != 0:
                log.error(f"[FAIL ENCODE]  {codec_name}\n{result.stderr[-3000:]}")
                transcode_errors.append(codec_name)
                continue

            log.info(f"[DONE ENCODE]  {codec_name}")

            if codec_name == "AV1":
                patch_hls_video_range(out_dir / "master.m3u8", log)
            elif codec_name == "H265":
                patch_hls_hdr(out_dir / "master.m3u8", out_dir, variants, log)

        if not UPLOAD_TO_B2:
            log.info(f"[SKIP UPLOAD]  {codec_name} — UPLOAD_TO_B2 is disabled.")
            continue

        if is_already_uploaded(b2, B2_BUCKET, b2_prefix, log):
            log.info(f"[SKIP UPLOAD]  {codec_name} — already exists in B2.")
            continue

        log.info(f"[START UPLOAD] {codec_name} → b2://{B2_BUCKET}/{b2_prefix}/")
        ok = upload_folder(b2, out_dir, b2_prefix, log)

        if not ok:
            upload_errors.append(codec_name)
        elif DELETE_TRANSCODES_AFTER_UPLOAD:
            log.info(f"[CLEAN]  Removing local segments for {codec_name}")
            for f in out_dir.iterdir():
                if f.is_file():
                    f.unlink()
            out_dir.rmdir()

    if transcode_errors or upload_errors:
        if transcode_errors:
            log.error(f"Transcode failures : {', '.join(transcode_errors)}")
        if upload_errors:
            log.error(f"Upload failures    : {', '.join(upload_errors)}")
        sys.exit(1)
    else:
        log.info("All variants transcoded and uploaded.")


if __name__ == "__main__":
    main()
