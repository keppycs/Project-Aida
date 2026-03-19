from pathlib import Path
from datetime import datetime
import argparse
import json
import math
import subprocess
import sys

from config import (
    CODECS, CUDA_DECODERS, HDR_TRANSFERS, VIDEO_EXTENSIONS,
    SEG_DURATION, B2_BUCKET,
    UPLOAD_TO_B2, DELETE_TRANSCODES_AFTER_UPLOAD,
)
from transcode import setup_logging, probe_video, parse_framerate, is_already_encoded, build_cmd
from manifest import build_hevc_codec_strings, patch_hls_video_range, patch_hls_hdr, patch_dash_hdr
from upload import make_b2_client, is_already_uploaded, upload_folder


def main() -> None:
    root = Path(__file__).parent.parent  # Project Aida/

    parser = argparse.ArgumentParser(description="Project Aida transcode pipeline")
    parser.add_argument(
        "source", nargs="?", default=None,
        help="Path to source video. If omitted, scans Project Aida/ for a video file.",
    )
    args = parser.parse_args()

    if args.source:
        video_file = Path(args.source)
        if not video_file.is_file():
            raise RuntimeError(f"Source file not found: {video_file}")
    else:
        video_file = next(
            (f for f in root.iterdir()
             if f.is_file() and f.suffix.lower() in VIDEO_EXTENSIONS),
            None,
        )
        if video_file is None:
            raise RuntimeError(f"No video file found in {root}")

    logs_dir = root / "logs"
    logs_dir.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log       = setup_logging(logs_dir / f"{video_file.stem}_{timestamp}.log")

    log.info(f"Source  : {video_file}")
    probe = probe_video(video_file)

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
    source_height   = int(video_stream.get("height", 2160))
    source_bits     = int(video_stream.get("bits_per_raw_sample") or
                         video_stream.get("bits_per_coded_sample") or 8)
    # NVENC only supports 8-bit (nv12) and 10-bit (p010le) — 12-bit input is
    # downsampled to p010le since that's the highest CUDA-compatible format.
    pix_fmt         = "p010le" if source_bits >= 10 else "nv12"
    is_hdr          = color_trc in HDR_TRANSFERS

    log.info(f"Codec           : {source_codec}")
    log.info(f"Frame rate      : {fps:.3f} fps")
    log.info(f"GOP size        : {gop_size} frames  ({SEG_DURATION}s x {fps:.0f}fps)")
    log.info(f"Color primaries : {color_primaries}")
    log.info(f"Color transfer  : {color_trc}")
    log.info(f"Color space     : {colorspace}")
    log.info(f"Source height   : {source_height}px")
    log.info(f"Pixel format    : {pix_fmt} ({source_bits}-bit source)")
    log.info(f"HDR             : {is_hdr}")

    if not is_hdr:
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
        out_dir   = root / "docs" / "debug" / video_file.stem / codec_name
        b2_prefix = f"{video_file.stem}/{codec_name}"

        out_dir.mkdir(parents=True, exist_ok=True)

        # Drop any variants taller than the source — never upscale
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

            video_range = "PQ" if is_hdr else "SDR"

            if codec_name == "AV1":
                patch_hls_video_range(out_dir / "master.m3u8", video_range, log)
            elif codec_name == "H265":
                codec_strings = build_hevc_codec_strings(out_dir, active_variants, log)
                patch_hls_hdr(out_dir / "master.m3u8", codec_strings, video_range, log)
                patch_dash_hdr(out_dir / "manifest.mpd", codec_strings, log)

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

    if not UPLOAD_TO_B2 and not transcode_errors:
        config_js = root / "docs" / "debug" / "config.js"
        is_hdr = color_trc in HDR_TRANSFERS
        config_js.write_text(
            f"// Auto-generated by Project Aida pipeline — do not edit manually.\n"
            f"const DEBUG_STEM = {json.dumps(video_file.stem)};\n"
            f"const DEBUG_IS_HDR = {'true' if is_hdr else 'false'};\n",
            encoding="utf-8",
        )
        log.info(f"[DEBUG CONFIG] Written docs/debug/config.js  stem={video_file.stem!r}  hdr={is_hdr}")

    if transcode_errors or upload_errors:
        if transcode_errors:
            log.error(f"Transcode failures : {', '.join(transcode_errors)}")
        if upload_errors:
            log.error(f"Upload failures    : {', '.join(upload_errors)}")
        sys.exit(1)
    elif UPLOAD_TO_B2:
        log.info("All variants transcoded and uploaded.")
    else:
        log.info("All variants transcoded. (upload disabled)")


if __name__ == "__main__":
    main()
