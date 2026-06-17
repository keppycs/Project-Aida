"""Project Aida — NiceGUI desktop interface."""

from collections import deque
from pathlib import Path
import logging
import tkinter as tk
from tkinter import filedialog

from nicegui import ui, run

from config import (
    VIDEO_EXTENSIONS,
    UPLOAD_TO_B2, GENERATE_THUMBNAILS,
    DELETE_TRANSCODES_AFTER_UPLOAD, FAST_TRANSCODE,
    get_b2_config, save_b2_credentials,
)
from main import probe_source, run_pipeline


# Thread-safe queues for background → UI communication
_progress_queue: deque[tuple[str, int, int]] = deque()
_log_queue: deque[str] = deque()


class _LogBridge(logging.Handler):
    """Forward log records into the queue for the UI timer to pick up."""
    def emit(self, record: logging.LogRecord):
        try:
            _log_queue.append(self.format(record))
        except Exception:
            pass


def _pick_file() -> str:
    """Open a native Windows file dialog. Runs in a worker thread."""
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    exts = " ".join(f"*{e}" for e in VIDEO_EXTENSIONS)
    path = filedialog.askopenfilename(
        title="Select source video",
        filetypes=[("Video files", exts), ("All files", "*.*")],
    )
    root.destroy()
    return path or ""


def _on_progress(stage: str, current: int, total: int) -> None:
    """Progress callback handed to the pipeline (called from worker thread)."""
    _progress_queue.append((stage, current, total))


@ui.page("/")
def _build():
    # ── Layout ─────────────────────────────────────────────────────────────

    with ui.column().classes("w-full max-w-2xl mx-auto p-6 gap-4"):
        ui.label("Project Aida").classes("text-3xl font-bold")

        # ── Source ─────────────────────────────────────────────────────────
        with ui.card().classes("w-full"):
            ui.label("Source").classes("text-lg font-semibold")
            with ui.row().classes("w-full items-center gap-2"):
                source = ui.input("Video file path").props("outlined dense").classes("flex-grow")
                browse_btn = ui.button("Browse", icon="folder_open")
            info_label = ui.label("").classes("text-sm text-gray-400")

        # ── Metadata ───────────────────────────────────────────────────────
        with ui.card().classes("w-full"):
            ui.label("Metadata").classes("text-lg font-semibold")
            vid_id = ui.input("Video ID", placeholder="auto-generated if empty") \
                .props("outlined dense").classes("w-full")
            desc = ui.input("Description").props("outlined dense").classes("w-full")
            tags = ui.input("Tags", placeholder="comma-separated") \
                .props("outlined dense").classes("w-full")

        # ── Options ────────────────────────────────────────────────────────
        with ui.card().classes("w-full"):
            ui.label("Options").classes("text-lg font-semibold")
            sw_thumb  = ui.switch("Generate thumbnails", value=GENERATE_THUMBNAILS)
            sw_upload = ui.switch("Upload to B2",        value=UPLOAD_TO_B2)
            sw_delete = ui.switch("Delete after upload", value=DELETE_TRANSCODES_AFTER_UPLOAD)
            sw_fast   = ui.switch("Fast transcode",      value=FAST_TRANSCODE)

        # ── B2 Credentials ─────────────────────────────────────────────────
        creds = get_b2_config()
        with ui.expansion("B2 Credentials", icon="key").classes("w-full"):
            cr_key = ui.input("Key ID", value=creds.get("B2_KEY_ID", "")) \
                .props("outlined dense").classes("w-full")
            cr_secret = ui.input(
                "Application Key",
                value=creds.get("B2_APP_KEY", ""),
                password=True,
                password_toggle_button=True,
            ).props("outlined dense").classes("w-full")
            cr_bucket = ui.input("Bucket", value=creds.get("B2_BUCKET", "")) \
                .props("outlined dense").classes("w-full")
            cr_endpoint = ui.input("Endpoint", value=creds.get("B2_ENDPOINT", "")) \
                .props("outlined dense").classes("w-full")

            def _save_creds():
                try:
                    save_b2_credentials(
                        cr_key.value.strip(), cr_secret.value.strip(),
                        cr_bucket.value.strip(), cr_endpoint.value.strip(),
                    )
                    ui.notify("Credentials saved to keyring", type="positive")
                except Exception as exc:
                    ui.notify(f"Failed to save: {exc}", type="negative")

            ui.button("Save Credentials", icon="save", on_click=_save_creds)

        # ── Start ──────────────────────────────────────────────────────────
        start_btn = ui.button("Start Pipeline", icon="play_arrow") \
            .classes("w-full").props("color=primary size=lg")

        # ── Progress ───────────────────────────────────────────────────────
        progress_card = ui.card().classes("w-full")
        with progress_card:
            ui.label("Progress").classes("text-lg font-semibold")
            bars: dict[str, ui.linear_progress] = {}
            for stage in ("Thumbnails", "AV1", "HEVC", "Upload"):
                with ui.row().classes("w-full items-center gap-2"):
                    ui.label(stage).classes("w-24 text-sm")
                    bars[stage] = ui.linear_progress(value=0).classes("flex-grow")
        progress_card.set_visibility(False)

        # ── Log ────────────────────────────────────────────────────────────
        log_card = ui.card().classes("w-full")
        with log_card:
            ui.label("Log").classes("text-lg font-semibold")
            log_el = ui.log(max_lines=500).classes("w-full h-64")
        log_card.set_visibility(False)

    # ── Timer: drain queues → UI on the main thread ────────────────────────

    def _poll():
        while _progress_queue:
            stage, cur, tot = _progress_queue.popleft()
            if stage in bars and tot > 0:
                bars[stage].set_value(cur / tot)
        while _log_queue:
            log_el.push(_log_queue.popleft())

    ui.timer(0.1, _poll)

    # ── Event handlers ─────────────────────────────────────────────────────

    all_inputs = (source, browse_btn, vid_id, desc, tags,
                  sw_thumb, sw_upload, sw_delete, sw_fast, start_btn)

    async def _browse():
        path = await run.io_bound(_pick_file)
        if not path:
            return
        source.value = path
        try:
            info = await run.io_bound(probe_source, Path(path))
            hdr = "HDR" if info["is_hdr"] else "SDR"
            info_label.text = (
                f'{info["width"]}\u00d7{info["height"]}  \u00b7  '
                f'{info["fps"]:.1f} fps  \u00b7  {hdr}  \u00b7  '
                f'{info["source_codec"].upper()}  \u00b7  {info["duration"]:.1f}s'
            )
        except Exception as exc:
            info_label.text = f"Probe error: {exc}"

    browse_btn.on_click(_browse)

    async def _start():
        if not source.value:
            ui.notify("Select a video file first", type="warning")
            return
        p = Path(source.value)
        if not p.is_file():
            ui.notify("File not found", type="negative")
            return

        # Reset UI
        for b in bars.values():
            b.set_value(0)
        log_el.clear()
        _progress_queue.clear()
        _log_queue.clear()
        progress_card.set_visibility(True)
        log_card.set_visibility(True)
        for el in all_inputs:
            el.disable()

        handler = _LogBridge()
        handler.setFormatter(logging.Formatter(
            "%(asctime)s  %(levelname)-8s  %(message)s", "%Y-%m-%d %H:%M:%S",
        ))

        try:
            await run.io_bound(
                run_pipeline,
                video_file=p,
                video_id=vid_id.value.strip() or None,
                description=desc.value.strip(),
                tags=tags.value.strip(),
                upload_to_b2=sw_upload.value,
                gen_thumbnails=sw_thumb.value,
                delete_after_upload=sw_delete.value,
                fast_transcode=sw_fast.value,
                on_progress=_on_progress,
                extra_log_handler=handler,
            )
            for b in bars.values():
                if b.value > 0:
                    b.set_value(1.0)
            ui.notify("Pipeline complete!", type="positive")
        except Exception as exc:
            ui.notify(f"Pipeline failed: {exc}", type="negative")
        finally:
            for el in all_inputs:
                el.enable()

    start_btn.on_click(_start)


ui.run(
    native=True,
    title="Project Aida",
    window_size=(750, 950),
    dark=True,
    reload=False,
)
