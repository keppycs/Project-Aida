"""Private local previews use fake central streams, never B2/keyring/network."""
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).absolute().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from fastapi import FastAPI
from fastapi.testclient import TestClient
import admin_editor
from admin_client import AdminClientError
from video_library import VideoLibrary, VideoLibraryError, VideoNotFoundError


class Writer:
    url = "https://keppy.dev/edit/api"

    def __init__(self, metadata):
        self.metadata = metadata
        self.calls = []
        self.bodies = []
        self.failure = None

    def get_video(self, video_id):
        self.calls.append(("read", video_id))
        return {"id": video_id, "metadata": deepcopy(self.metadata), "published_metadata": deepcopy(self.metadata),
                "entry": None, "revision": "central-r1", "pending": False}

    def open_asset(self, video_id, relative, *, range_header=None):
        self.calls.append(("asset", video_id, relative, range_header))
        if self.failure:
            raise self.failure
        data = b"private120fps-origin"
        result = {}
        if range_header:
            first, last = range_header.removeprefix("bytes=").split("-")
            start, end = int(first), int(last)
            result["ContentRange"] = f"bytes {start}-{end}/{len(data)}"
            data = data[start:end + 1]
        body = BytesIO(data)
        self.bodies.append(body)
        return {"Body": body, "ContentLength": len(data), "ContentType": "video/mp4", **result}


class CentralPreviewTests(unittest.TestCase):
    def setUp(self):
        artifacts = ROOT / "logs" / "central-preview-tests"
        artifacts.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="fixture-", dir=artifacts)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        folder = self.root / "web" / "local" / "video120"
        folder.mkdir(parents=True)
        self.metadata = {"id": "video120", "title": "Private fixture", "visibility": "private", "frameRate": 120,
                         "codecs": ["AV1"], "duration": 1, "width": 1280, "height": 720}
        (folder / "metadata.json").write_text(json.dumps(self.metadata), encoding="utf-8")
        self.writer = Writer(self.metadata)
        self.library = VideoLibrary(self.root)
        self.app = FastAPI()
        admin_editor.install_local_boundary(self.app)
        admin_editor.install_editor(self.app, self.root, self.library)
        self.app.state.editor_busy = lambda: False
        self.client = TestClient(self.app, base_url="http://127.0.0.1:8765", client=("127.0.0.1", 50200))
        for target, value in (("video_library.central_client", self.writer), ("admin_editor.central_client", self.writer)):
            patcher = patch(target, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for target in ("admin_editor.b2_configured", "config.get_b2_config", "config._load_b2_config"):
            patcher = patch(target, side_effect=AssertionError("Central preview must never inspect B2 credentials/keyring"))
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(self.library, "_client", side_effect=AssertionError("Central preview must not construct a B2 client"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_auto_refresh_and_private_range_preview_need_no_local_b2_key(self):
        detail = self.client.get("/api/videos/video120?check_online=true")
        self.assertEqual(detail.status_code, 200)
        self.assertNotIn("online_check_error", detail.json())
        self.assertEqual(detail.json()["visibility"], "private")
        self.assertTrue(detail.json()["has_remote"])
        self.assertTrue(detail.json()["can_preview"])
        response = self.client.get("/preview/local/video120/AV1/init_0.mp4", headers={"Range": "bytes=0-7"})
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.content, b"private1")
        self.assertEqual(response.headers["content-range"], "bytes 0-7/20")
        self.assertTrue(self.writer.bodies[-1].closed)
        self.assertEqual(self.writer.calls[-1], ("asset", "video120", "AV1/init_0.mp4", "bytes=0-7"))
        head = self.client.head("/preview/local/video120/AV1/init_0.mp4")
        self.assertEqual(head.status_code, 200)
        self.assertEqual(head.content, b"")
        self.assertTrue(self.writer.bodies[-1].closed)
        self.assertEqual(self.client.get("/preview/local/video120/AV1/init_0.mp4", headers={"Origin": "https://attacker.invalid"}).status_code, 403)

    def test_preview_requires_refresh_and_rejects_unknown_files_before_central_reads(self):
        with self.assertRaises(VideoLibraryError):
            self.library.remote_asset("video120", "AV1/init_0.mp4")
        self.assertEqual(self.writer.calls, [])
        self.library.get_video("video120", remote=True)
        before = len(self.writer.calls)
        for path in (".env", "AV1/source.mp4", "../metadata.json"):
            with self.subTest(path=path), self.assertRaises(VideoLibraryError):
                self.library.remote_asset("video120", path)
        with self.assertRaises(VideoLibraryError):
            self.library.remote_asset("video120", "AV1/init_0.mp4", "bytes=0-1,4-5")
        self.assertEqual(len(self.writer.calls), before)

    def test_central_missing_range_and_auth_failures_map_without_b2_fallback(self):
        self.library.get_video("video120", remote=True)
        for status, expected in ((404, 404), (416, 416), (401, 503), (403, 503), (503, 503)):
            with self.subTest(status=status):
                self.writer.failure = AdminClientError("Must not reflect private upstream information", status)
                with self.assertRaises(VideoLibraryError) as caught:
                    self.library.remote_asset("video120", "AV1/init_0.mp4")
                self.assertEqual(caught.exception.status_code, expected)
                self.assertNotIn("upstream information", str(caught.exception))
                if status == 404:
                    self.assertIsInstance(caught.exception, VideoNotFoundError)

    def test_invalid_central_setup_keeps_local_draft_without_consulting_b2(self):
        original = self.library.get_video("video120")
        draft = self.library.save_video("video120", {"title": "My unsent draft"}, original["revision"])
        with patch("admin_editor.central_client", side_effect=AdminClientError("Partial central setup")):
            response = self.client.get("/api/videos/video120?check_online=true")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["title"], "My unsent draft")
        self.assertTrue(response.json()["pending"])
        self.assertIn("online_check_error", response.json())
        self.assertEqual(response.json()["revision"], draft["revision"])
        self.assertEqual(self.writer.calls, [])


if __name__ == "__main__":
    unittest.main()
