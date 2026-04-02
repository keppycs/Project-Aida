from pathlib import Path
import logging
import re


def patch_hls_stream_inf(master_path: Path, video_range: str, fps: float, log: logging.Logger) -> None:
    """Inject VIDEO-RANGE and FRAME-RATE on every EXT-X-STREAM-INF line in an HLS master."""
    text    = master_path.read_text(encoding="utf-8")
    lines   = text.splitlines(keepends=True)
    out     = []
    fps_str = f"{fps:.3f}".rstrip("0").rstrip(".")

    for line in lines:
        if line.startswith("#EXT-X-STREAM-INF:"):
            line = line.rstrip()
            if "VIDEO-RANGE=" not in line:
                line += f",VIDEO-RANGE={video_range}"
            if "FRAME-RATE=" not in line:
                line += f",FRAME-RATE={fps_str}"
            line += "\n"
        out.append(line)

    master_path.write_text("".join(out), encoding="utf-8")
    log.info(f"  Patched VIDEO-RANGE={video_range}, FRAME-RATE={fps_str} into {master_path.name}")


def patch_bandwidth(
    out_dir: Path,
    num_variants: int,
    seg_duration: float,
    log: logging.Logger,
) -> None:
    """Compute peak and average bitrate from actual segment files and patch
    the HLS master playlist and DASH MPD with correct values.

    Video-only: scans chunk_{rep_id}_*.fmp4 for rep_id in 0..num_variants-1.
    HLS : BANDWIDTH         = peak segment bitrate (bits / seg_duration)
          AVERAGE-BANDWIDTH = mean segment bitrate
    DASH: bandwidth         = peak segment bitrate
    """
    peak_bps_list: list[int] = []
    avg_bps_list:  list[int] = []

    for rep_id in range(num_variants):
        segments = sorted(out_dir.glob(f"chunk_{rep_id}_*.fmp4"))
        if not segments:
            log.warning(f"  patch_bandwidth: no segments for rep {rep_id} — skipping")
            peak_bps_list.append(0)
            avg_bps_list.append(0)
            continue

        bps_per_seg = [s.stat().st_size * 8 / seg_duration for s in segments]
        peak = int(max(bps_per_seg))
        avg  = int(sum(bps_per_seg) / len(bps_per_seg))
        peak_bps_list.append(peak)
        avg_bps_list.append(avg)
        log.info(f"  rep {rep_id}: peak={peak // 1000}kbps  avg={avg // 1000}kbps  ({len(segments)} segments)")

    # ── HLS master ───────────────────────────────────────────────────────────
    hls_path = out_dir / "master.m3u8"
    if hls_path.exists():
        lines = hls_path.read_text(encoding="utf-8").splitlines(keepends=True)
        out   = []
        idx   = 0
        for line in lines:
            if line.startswith("#EXT-X-STREAM-INF:") and idx < len(peak_bps_list):
                line = line.rstrip()
                line = re.sub(r"BANDWIDTH=\d+", f"BANDWIDTH={peak_bps_list[idx]}", line)
                if "AVERAGE-BANDWIDTH=" in line:
                    line = re.sub(r"AVERAGE-BANDWIDTH=\d+", f"AVERAGE-BANDWIDTH={avg_bps_list[idx]}", line)
                else:
                    line += f",AVERAGE-BANDWIDTH={avg_bps_list[idx]}"
                line += "\n"
                idx += 1
            out.append(line)
        hls_path.write_text("".join(out), encoding="utf-8")
        log.info(f"  Patched HLS bandwidth in {hls_path.name}")

    # ── DASH MPD ─────────────────────────────────────────────────────────────
    # Video AdaptationSet is id=0 (always first); audio follows.
    # We replace only the first num_variants bandwidth= occurrences, which
    # correspond to the video Representation elements.
    mpd_path = out_dir / "manifest.mpd"
    if mpd_path.exists():
        text  = mpd_path.read_text(encoding="utf-8")
        count = 0

        def _dash_replacer(m: re.Match) -> str:
            nonlocal count
            if count >= num_variants:
                return m.group(0)
            bw = peak_bps_list[count]
            count += 1
            return f'bandwidth="{bw}"'

        patched = re.sub(r'bandwidth="\d+"', _dash_replacer, text)
        mpd_path.write_text(patched, encoding="utf-8")
        log.info(f"  Patched DASH bandwidth in {mpd_path.name}")
