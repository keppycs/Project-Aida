from pathlib import Path
from fractions import Fraction
from typing import Optional
import logging
import subprocess
import json
import sys

from config import SEG_DURATION, ENCODE_SETTINGS


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
    log.propagate = False
    return log


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


def parse_framerate(r_frame_rate: str) -> float:
    try:
        return float(Fraction(r_frame_rate))
    except Exception:
        return 30.0


def is_already_encoded(out_dir: Path) -> bool:
    return (out_dir / "manifest.mpd").exists() and any(out_dir.glob("*.fmp4"))


def build_cmd(
    source: Path,
    encoder: str,
    variants: list,
    cuda_decoder: Optional[str],
    color_primaries: str,
    color_trc: str,
    colorspace: str,
    gop_size: int,
    pix_fmt: str,
    settings: dict = ENCODE_SETTINGS,
) -> list:
    split_count   = len(variants)
    split_outputs = "".join(f"[v{i}]" for i in range(split_count))

    # ── Filter graph ────────────────────────────────────────────────────────────
    filter_parts = [f"[0:v]split={split_count}{split_outputs}"]
    for i, (_, res, _, _) in enumerate(variants):
        filter_parts.append(f"[v{i}]scale_cuda={res}:format={pix_fmt}:interp_algo={settings['scale_algo']}[s{i}]")

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
            f"-c:v:{i}",                 encoder,
            f"-preset:v:{i}",            settings["preset"],
            f"-tune:v:{i}",              settings["tune"],
            f"-rc:v:{i}",                "vbr",
            f"-cq:v:{i}",                str(cq),
            f"-maxrate:v:{i}",           f"{maxrate_k}k",
            f"-bufsize:v:{i}",           f"{bufsize_k}k",

            # GOP / keyframe alignment
            f"-g:v:{i}",                 str(gop_size),
            f"-keyint_min:v:{i}",        str(gop_size),
            f"-sc_threshold:v:{i}",      str(settings["sc_threshold"]),
            f"-strict_gop:v:{i}",        str(settings["strict_gop"]),

            # Quality enhancement
            f"-multipass:v:{i}",         settings["multipass"],
            f"-split_encode_mode:v:{i}", settings["split_encode_mode"],
            f"-spatial-aq:v:{i}",        "1" if settings["spatial_aq"] else "0",
            f"-temporal-aq:v:{i}",       "1" if settings["temporal_aq"] else "0",
            f"-aq-strength:v:{i}",       str(settings["aq_strength"]),
            f"-rc-lookahead:v:{i}",      str(settings["rc_lookahead"]),
            f"-lookahead_level:v:{i}",   str(settings["lookahead_level"]),
            f"-b_ref_mode:v:{i}",        settings["b_ref_mode"],

            # HDR metadata
            f"-color_primaries:v:{i}",   color_primaries,
            f"-color_trc:v:{i}",         color_trc,
            f"-colorspace:v:{i}",        colorspace,

            # Container tag — hvc1 for Safari compatibility, av01 for AV1
            # NOTE: these are placeholder tags; manifest.py will patch in the
            # full profile/level/tier strings after encode.
            f"-tag:v:{i}",               "hvc1" if is_hevc else "av01",
        ]

    # ── Audio ───────────────────────────────────────────────────────────────────
    cmd += ["-c:a", settings["audio_codec"], "-b:a", settings["audio_bitrate"]]

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
