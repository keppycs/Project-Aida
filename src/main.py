from pathlib import Path
from datetime import datetime
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
                codec_strings = build_hevc_codec_strings(out_dir, variants, log)
                patch_hls_hdr(out_dir / "master.m3u8", codec_strings, log)
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
