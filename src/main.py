from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Callable, Optional
import argparse
import json
import logging
import math
import shutil
import sys
import time

from config import (
    CUDA_DECODERS, HDR_TRANSFERS, VIDEO_EXTENSIONS,
    SEG_DURATION,
    UPLOAD_TO_B2, DELETE_TRANSCODES_AFTER_UPLOAD, GENERATE_THUMBNAILS, FAST_TRANSCODE,
    ENCODE_SETTINGS_PRODUCTION, ENCODE_SETTINGS_FAST,
    VARIANTS_AV1_PRODUCTION, VARIANTS_AV1_FAST,
    VARIANTS_HEVC_PRODUCTION, VARIANTS_HEVC_FAST,
    get_b2_credentials,
)
from thumbnail import generate_thumbnails as _gen_thumbs
from transcode import (
    setup_logging,
    probe_video,
    parse_framerate,
    infer_audio_channel_layout,
    is_already_encoded,
    build_cmd,
    run_ffmpeg,
)
from manifest import patch_hls_stream_inf, patch_bandwidth
from upload import make_b2_client, is_already_uploaded, upload_folder, upload_index

ROOT = Path(__file__).parent.parent


def probe_source(video_file: Path) -> dict:
    """Probe a video file and return a metadata summary for the GUI."""
    probe = probe_video(video_file)
    vs = next((s for s in probe["streams"] if s["codec_type"] == "video"), None)
    if vs is None:
        raise RuntimeError("No video stream found in source.")

    fps = parse_framerate(vs.get("r_frame_rate", "60/1"))
    color_trc = vs.get("color_transfer", "bt709")
    duration = float(probe.get("format", {}).get("duration", 0))
    _bits_raw = int(vs.get("bits_per_raw_sample") or 0)
    _bits_coded = int(vs.get("bits_per_coded_sample") or 0)
    _pix = vs.get("pix_fmt", "")
    _hbd = {"yuv420p10le", "yuv420p12le", "yuv422p10le", "yuv422p12le",
            "yuv444p10le", "yuv444p12le", "p010le", "p012le", "gbrp10le", "gbrp12le"}
    bits = _bits_raw or _bits_coded or (10 if _pix in _hbd else 8)

    return {
        "source_codec": vs.get("codec_name", ""),
        "width": int(vs.get("width", 0)),
        "height": int(vs.get("height", 0)),
        "fps": fps,
        "duration": duration,
        "color_primaries": vs.get("color_primaries", "bt709"),
        "color_trc": color_trc,
        "colorspace": vs.get("color_space", "bt709"),
        "source_bits": bits,
        "is_hdr": color_trc in HDR_TRANSFERS,
        "has_audio": any(s["codec_type"] == "audio" for s in probe["streams"]),
    }


def run_pipeline(
    video_file: Path,
    video_id: str | None = None,
    description: str = "",
    tags: str = "",
    upload_to_b2: bool = UPLOAD_TO_B2,
    gen_thumbnails: bool = GENERATE_THUMBNAILS,
    delete_after_upload: bool = DELETE_TRANSCODES_AFTER_UPLOAD,
    fast_transcode: bool = FAST_TRANSCODE,
    on_progress: Optional[Callable[[str, int, int], None]] = None,
    extra_log_handler: Optional[logging.Handler] = None,
) -> None:
    """Run the full transcode -> package -> upload pipeline."""

    # Validate B2 credentials early so a missing config doesn't surprise
    # you after a multi-hour encode.
    if upload_to_b2:
        get_b2_credentials()

    video_id = video_id or f"0{int(time.time())}"
    created_at = int(time.time())
    ams = ZoneInfo("Europe/Amsterdam")

    logs_dir = ROOT / "logs"
    logs_dir.mkdir(exist_ok=True)
    ts = datetime.now(tz=ams).strftime("%d-%m-%Y_%H-%M-%S_%Z")
    log = setup_logging(logs_dir / f"{ts}_{video_file.stem}.log")
    if extra_log_handler:
        log.addHandler(extra_log_handler)

    log.info(f"Source          : {video_file}")
    log.info(f"Video ID        : {video_id}")

    probe = probe_video(video_file)
    video_stream = next(
        (s for s in probe["streams"] if s["codec_type"] == "video"), None
    )
    if video_stream is None:
        raise RuntimeError("No video stream found in source.")

    source_codec    = video_stream.get("codec_name",      "")
    color_primaries = video_stream.get("color_primaries", "bt709")
    color_trc       = video_stream.get("color_transfer",  "bt709")
    colorspace      = video_stream.get("color_space",     "bt709")
    fps             = parse_framerate(video_stream.get("r_frame_rate", "60/1"))
    gop_size        = math.ceil(fps * SEG_DURATION)
    source_height   = int(video_stream.get("height", 2160))
    source_width    = int(video_stream.get("width",  3840))
    _bits_raw   = int(video_stream.get("bits_per_raw_sample")  or 0)
    _bits_coded = int(video_stream.get("bits_per_coded_sample") or 0)
    _stream_pix = video_stream.get("pix_fmt", "")
    _hbd_fmts   = {"yuv420p10le", "yuv420p12le", "yuv422p10le", "yuv422p12le",
                   "yuv444p10le", "yuv444p12le", "p010le", "p012le", "gbrp10le", "gbrp12le"}
    source_bits = _bits_raw or _bits_coded or (10 if _stream_pix in _hbd_fmts else 8)
    duration    = float(probe.get("format", {}).get("duration", 0))
    pix_fmt     = "p010le" if source_bits >= 10 else "nv12"
    is_hdr      = color_trc in HDR_TRANSFERS

    log.info(f"Codec           : {source_codec}")
    log.info(f"Resolution      : {source_width}x{source_height}")
    log.info(f"Frame rate      : {fps:.3f} fps")
    log.info(f"Duration        : {duration:.2f}s")
    log.info(f"GOP size        : {gop_size} frames  ({SEG_DURATION}s x {fps:.0f}fps)")
    log.info(f"Color primaries : {color_primaries}")
    log.info(f"Color transfer  : {color_trc}")
    log.info(f"Color space     : {colorspace}")
    log.info(f"Pixel format    : {pix_fmt} ({source_bits}-bit source)")
    log.info(f"HDR             : {is_hdr}")

    audio_stream = next(
        (s for s in probe["streams"] if s["codec_type"] == "audio"), None
    )
    audio_channel_layout = (
        infer_audio_channel_layout(audio_stream) if audio_stream else None
    )
    if audio_stream:
        _layout = audio_channel_layout or audio_stream.get("channel_layout") or "unknown"
        log.info(
            f"Audio           : {audio_stream.get('codec_name', '?')}  "
            f"channels={audio_stream.get('channels', '?')}  "
            f"layout={_layout}"
        )

    cuda_decoder = CUDA_DECODERS.get(source_codec)
    if cuda_decoder:
        log.info(f"CUDA decoder    : {cuda_decoder}")
    else:
        log.warning(
            f"No CUDA decoder for '{source_codec}'. "
            "Falling back to software decode — GPU encode still active."
        )

    # ── Thumbnails ─────────────────────────────────────────────────────────────
    if gen_thumbnails:
        if on_progress:
            on_progress("Thumbnails", 0, 1)
        thumb_dir = ROOT / "docs" / "local" / video_id
        thumb_dir.mkdir(parents=True, exist_ok=True)
        _gen_thumbs(
            input_path=video_file,
            out_dir=thumb_dir,
            duration=duration,
            color_primaries=color_primaries,
            color_trc=color_trc,
            colorspace=colorspace,
            log=log,
        )
        if on_progress:
            on_progress("Thumbnails", 1, 1)

    # ── Encode ─────────────────────────────────────────────────────────────────
    if fast_transcode:
        codecs = {
            "AV1":  ("av1_nvenc",  VARIANTS_AV1_FAST),
            "HEVC": ("hevc_nvenc", VARIANTS_HEVC_FAST),
        }
        encode_settings = ENCODE_SETTINGS_FAST
    else:
        codecs = {
            "AV1":  ("av1_nvenc",  VARIANTS_AV1_PRODUCTION),
            "HEVC": ("hevc_nvenc", VARIANTS_HEVC_PRODUCTION),
        }
        encode_settings = ENCODE_SETTINGS_PRODUCTION

    total_frames = math.ceil(duration * fps)
    transcode_errors: list[str] = []
    encoded_codecs:   list[str] = []

    for codec_name, (encoder, variants) in codecs.items():
        out_dir = ROOT / "docs" / "local" / video_id / codec_name
        out_dir.mkdir(parents=True, exist_ok=True)

        active_variants = [
            v for v in variants
            if int(v[1].split(":")[1]) <= source_height
        ]
        if not active_variants:
            log.warning(f"[SKIP ENCODE]  {codec_name} — no variants at or below source height {source_height}px.")
            continue

        if is_already_encoded(out_dir):
            log.info(f"[SKIP ENCODE]  {codec_name} — segments already exist locally.")
        else:
            log.info(f"[START ENCODE] {codec_name}  encoder={encoder}")
            log.info(f"  Ladder: {' | '.join(f'{n} CQ{c} {m}Mbps' for n, _, c, m in active_variants)}")

            cmd = build_cmd(
                source=video_file,
                encoder=encoder,
                variants=active_variants,
                cuda_decoder=cuda_decoder,
                color_primaries=color_primaries,
                color_trc=color_trc,
                colorspace=colorspace,
                gop_size=gop_size,
                pix_fmt=pix_fmt,
                settings=encode_settings,
                audio_channel_layout=audio_channel_layout,
            )

            log.debug("CMD: " + " ".join(cmd))

            rc = run_ffmpeg(cmd, out_dir, total_frames, codec_name, log,
                            on_progress=on_progress)

            if rc != 0:
                transcode_errors.append(codec_name)
                continue

            log.info(f"[DONE ENCODE]  {codec_name}")

            video_range = "PQ" if is_hdr else "SDR"
            patch_hls_stream_inf(out_dir / "master.m3u8", video_range, fps, log)
            patch_bandwidth(out_dir, len(active_variants), SEG_DURATION, log)

        encoded_codecs.append(codec_name)

    if transcode_errors:
        msg = f"Transcode failures: {', '.join(transcode_errors)}"
        log.error(msg)
        raise RuntimeError(msg)

    # ── metadata.json ──────────────────────────────────────────────────────────
    meta = {
        "id":             video_id,
        "title":          video_file.stem,
        "createdAt":      created_at,
        "duration":       round(duration, 3),
        "frameRate":      round(fps, 3),
        "width":          source_width,
        "height":         source_height,
        "colorPrimaries": color_primaries,
        "colorTransfer":  color_trc,
        "colorSpace":     colorspace,
        "codecs":         encoded_codecs,
    }

    meta_local = ROOT / "docs" / "local" / video_id / "metadata.json"
    meta_local.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    log.info(f"[METADATA]     Written {meta_local}")

    # Update local index.json always, so you have a catalogue regardless of upload
    date_str    = datetime.fromtimestamp(created_at, tz=ams).strftime("%d-%m-%Y %H:%M:%S %Z")
    tags_list   = [t.strip() for t in tags.split(",") if t.strip()]
    entry = {
        "id":          video_id,
        "title":       video_file.stem,
        "description": description,
        "tags":        tags_list,
        "date":        date_str,
        "createdAt":   created_at,
        "duration":    round(duration, 3),
        "width":       source_width,
        "height":      source_height,
        "frameRate":   round(fps, 3),
        "hdr":         is_hdr,
        "codecs":      encoded_codecs,
    }
    index_path = ROOT / "logs" / "index.json"
    try:
        index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    except Exception:
        index = []
    index = [e for e in index if e.get("id") != video_id]
    index.insert(0, entry)
    index_path.write_text(json.dumps(index, indent=2), encoding="utf-8")
    log.info(f"[INDEX]        Updated logs/index.json ({len(index)} entries)")

    # ── Upload ─────────────────────────────────────────────────────────────────
    if upload_to_b2:
        b2, bucket = make_b2_client()
        video_dir = ROOT / "docs" / "local" / video_id
        if is_already_uploaded(b2, bucket, video_id, log):
            log.info(f"[SKIP UPLOAD]  {video_id} — already exists in B2.")
        else:
            log.info(f"[START UPLOAD] {video_id} → b2://{bucket}/{video_id}/")
            upload_cb = (lambda d, t: on_progress("Upload", d, t)) if on_progress else None
            ok = upload_folder(b2, bucket, video_dir, video_id, log, on_progress=upload_cb)
            if ok:
                upload_index(b2, bucket, index_path, log)
                if delete_after_upload:
                    log.info("[CLEAN]  Removing local segments")
                    for cn in encoded_codecs:
                        shutil.rmtree(video_dir / cn, ignore_errors=True)
            else:
                raise RuntimeError("Upload failed.")
        log.info("All variants transcoded and uploaded.")
    else:
        log.info("[SKIP UPLOAD]  Upload to B2 is disabled.")
        log.info("All variants transcoded.")


def main() -> None:
    """CLI entry point — parse arguments and run the pipeline."""
    parser = argparse.ArgumentParser(description="Project Aida transcode pipeline")
    parser.add_argument(
        "source", nargs="?", default=None,
        help="Path to source video (positional). If omitted, scans Project Aida/ for a video file.",
    )
    parser.add_argument(
        "video_id", nargs="?", default=None,
        help="YouTube video ID to use as the B2 folder name (positional).",
    )
    parser.add_argument(
        "-i", dest="source_flag", default=None, metavar="PATH",
        help="Path to source video (named alternative to positional).",
    )
    parser.add_argument(
        "-id", dest="id_flag", default=None, metavar="ID",
        help="YouTube video ID (named alternative to positional).",
    )
    parser.add_argument(
        "-desc", "--description", dest="description", default="", metavar="TEXT",
        help="Short description shown on the homepage.",
    )
    parser.add_argument(
        "-tags", "--tags", dest="tags", default="", metavar="TAG1,TAG2",
        help="Comma-separated tags for filtering on the homepage.",
    )
    args = parser.parse_args()

    source_path = args.source_flag or args.source
    yt_id       = args.id_flag    or args.video_id

    if source_path:
        video_file = Path(source_path)
        if not video_file.is_file():
            raise RuntimeError(f"Source file not found: {video_file}")
    else:
        video_file = next(
            (f for f in ROOT.iterdir()
             if f.is_file() and f.suffix.lower() in VIDEO_EXTENSIONS),
            None,
        )
        if video_file is None:
            raise RuntimeError(f"No video file found in {ROOT}")

    try:
        run_pipeline(
            video_file=video_file,
            video_id=yt_id,
            description=args.description,
            tags=args.tags,
        )
    except RuntimeError:
        sys.exit(1)


if __name__ == "__main__":
    main()
