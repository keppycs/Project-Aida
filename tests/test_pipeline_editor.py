"""Pipeline-to-editor handoff with mocked encoders and storage."""

from contextlib import ExitStack
import json
from pathlib import Path
import sys
import tempfile
from datetime import timezone
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import main


class PipelineEditorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pipeline-editor-", dir=ROOT / "logs")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.local = self.root / "web" / "local"
        self.local.mkdir(parents=True)
        self.index = self.local / "index.json"
        self.original = [{"id":"older", "title":"Keep this", "visibility":"private", "createdAt":1}]
        self.index.write_text(json.dumps(self.original), encoding="utf-8")
        self.source = self.root / "source.mp4"
        self.source.write_bytes(b"synthetic source; never decoded")
        self.probe = {"streams":[{"codec_type":"video", "codec_name":"av1", "r_frame_rate":"120/1", "width":1920, "height":1080, "pix_fmt":"yuv420p"}], "format":{"duration":"1"}}
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(main, "central_client", return_value=None))
        for name, value in (("ROOT",self.root),("LOCAL_DIR",self.local),("INDEX_PATH",self.index)):
            stack.enter_context(patch.object(main,name,value))
        stack.enter_context(patch.object(main,"ZoneInfo",return_value=timezone.utc))
        stack.enter_context(patch.object(main,"setup_logging",return_value=Mock()))
        stack.enter_context(patch.object(main,"probe_video",return_value=self.probe))
        stack.enter_context(patch.object(main,"get_b2_credentials",return_value=("fake","fake","fixture","https://example.invalid")))
        self.ffmpeg = stack.enter_context(patch.object(main,"run_ffmpeg",side_effect=AssertionError("No encoder may run")))

        def existing(out_dir):
            (out_dir / "manifest.mpd").write_text('<MPD frameRate="120/1"/>', encoding="utf-8")
            (out_dir / "init_0.mp4").write_bytes(b"synthetic init")
            return True
        stack.enter_context(patch.object(main,"is_already_encoded",side_effect=existing))

    def run_pipeline(self, **extra):
        return main.run_pipeline(self.source, video_id="new120", title="New title", description="Full local details", tags="one, two", visibility="private", gen_thumbnails=False, **extra)

    def test_completed_encode_registers_editor_draft_and_keeps_previous_catalog(self):
        self.run_pipeline(upload_to_b2=False)
        metadata = json.loads((self.local / "new120" / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["frameRate"],120)
        self.assertEqual(metadata["tags"],["one","two"])
        self.assertEqual(metadata["visibility"],"private")
        state = json.loads((self.local / "new120" / ".editor-state.json").read_text(encoding="utf-8"))
        self.assertTrue(state["pending"])
        saved_index = json.loads(self.index.read_text(encoding="utf-8"))
        self.assertEqual(saved_index[1], self.original[0])
        previous = list((self.root / ".agent-trash").rglob("index.json"))
        self.assertEqual(json.loads(previous[0].read_text(encoding="utf-8")),self.original)
        self.ffmpeg.assert_not_called()

    def test_lower_framerate_is_rejected_before_encoding_or_output(self):
        self.probe["streams"][0]["r_frame_rate"]="60/1"
        with self.assertRaisesRegex(ValueError,"120 fps"):
            self.run_pipeline(upload_to_b2=False)
        self.ffmpeg.assert_not_called()
        self.assertFalse((self.local / "new120").exists())

    def test_existing_local_or_remote_id_is_never_overwritten(self):
        folder = self.local / "new120"
        folder.mkdir()
        path = folder / "metadata.json"
        path.write_bytes(b"keep this exact original")
        with self.assertRaisesRegex(ValueError,"already exists"):
            self.run_pipeline(upload_to_b2=False)
        self.assertEqual(path.read_bytes(), b"keep this exact original")
        with patch.object(main,"make_b2_client",return_value=(Mock(),"fixture")), patch.object(main,"is_already_uploaded",return_value=True):
            with self.assertRaisesRegex(ValueError,"already exists online"):
                main.run_pipeline(self.source, video_id="remote120", upload_to_b2=True)
        self.assertFalse((self.local / "remote120").exists())

    def test_upload_acknowledgment_precedes_recoverable_archive(self):
        calls=[]
        with patch.object(main,"make_b2_client",return_value=(Mock(),"fixture")), patch.object(main,"is_already_uploaded",return_value=False), \
             patch.object(main,"upload_folder",side_effect=lambda *a,**k: calls.append("media") or True), \
             patch.object(main,"upload_index",side_effect=lambda *a: calls.append("catalog")), \
             patch.object(main.VideoLibrary,"mark_uploaded",side_effect=lambda *a: calls.append("verify")), \
             patch.object(main.VideoLibrary,"archive_encoded_media",side_effect=lambda *a: calls.append("archive")):
            self.run_pipeline(upload_to_b2=True,delete_after_upload=True)
        self.assertEqual(calls,["media","catalog","verify","archive"])

    def test_failed_upload_never_acknowledges_or_archives_local_video(self):
        with patch.object(main,"make_b2_client",return_value=(Mock(),"fixture")), patch.object(main,"is_already_uploaded",return_value=False), \
             patch.object(main,"upload_folder",return_value=False), patch.object(main.VideoLibrary,"mark_uploaded") as verify, \
             patch.object(main.VideoLibrary,"archive_encoded_media") as archive:
            with self.assertRaisesRegex(RuntimeError,"Upload failed"):
                self.run_pipeline(upload_to_b2=True,delete_after_upload=True)
        verify.assert_not_called()
        archive.assert_not_called()
        self.assertTrue((self.local / "new120" / "AV1" / "init_0.mp4").is_file())

    def test_central_finalization_precedes_verification_and_skips_bulk_index(self):
        calls = []
        def finalized(*args, **kwargs):
            self.assertEqual(kwargs["entry"]["frameRate"], 120)
            self.assertEqual(kwargs["entry"]["id"], "new120")
            calls.append("central-finalized")
            return True
        with patch.object(main, "central_client", return_value=object()), \
             patch.object(main, "make_b2_client", return_value=(Mock(), "fixture")), \
             patch.object(main, "is_already_uploaded", return_value=False), \
             patch.object(main, "upload_folder", side_effect=finalized), \
             patch.object(main, "upload_index", side_effect=AssertionError("No whole-catalogue write in central mode")), \
             patch.object(main.VideoLibrary, "mark_uploaded", side_effect=lambda *_: calls.append("verify")), \
             patch.object(main.VideoLibrary, "archive_encoded_media", side_effect=lambda *_: calls.append("archive")):
            self.run_pipeline(upload_to_b2=True, delete_after_upload=True)
        self.assertEqual(calls, ["central-finalized", "verify", "archive"])

    def test_incomplete_central_credentials_stop_before_encoding_or_b2_setup(self):
        with patch.object(main, "central_client", side_effect=RuntimeError("Missing central credentials")), \
             patch.object(main, "make_b2_client", side_effect=AssertionError("No direct fallback")):
            with self.assertRaisesRegex(RuntimeError, "Missing central"):
                self.run_pipeline(upload_to_b2=True)
        self.ffmpeg.assert_not_called()
        self.assertFalse((self.local / "new120").exists())


if __name__ == "__main__":
    unittest.main()
