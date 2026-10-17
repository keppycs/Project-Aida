"""Loopback editor integration; generated fixtures only, no credentials or B2."""

import base64
from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from fastapi.testclient import TestClient
from PIL import Image
import admin_app
from video_library import VideoLibrary


class CloudError(Exception):
    def __init__(self, code):
        super().__init__("Fake cloud operation failed")
        self.response = {"Error": {"Code": code}}


class PreviewBody(BytesIO):
    def __init__(self, data):
        super().__init__(data)
        self.read_sizes = []

    def read(self, size=-1):
        self.read_sizes.append(size)
        return super().read(size)


class FakeCloud:
    """Current-object/version storage and range responses; never contacts B2."""

    def __init__(self):
        self.objects = {}
        self.versions = {}
        self.reads = []
        self.puts = []
        self.bodies = []
        self.read_failures = {}
        self.write_failures = {}
        self.encodings = {}

    def store(self, key, value):
        self.objects[key] = value if isinstance(value, bytes) else json.dumps(value).encode("utf-8")

    def get_object(self, *, Bucket, Key, **kwargs):
        self.reads.append((Key, kwargs))
        if Key in self.read_failures:
            raise self.read_failures[Key]
        if Key not in self.objects:
            raise CloudError("NoSuchKey")
        raw = self.objects[Key]
        headers = {}
        if "Range" in kwargs:
            first, last = kwargs["Range"].removeprefix("bytes=").split("-", 1)
            start = int(first) if first else max(0, len(raw) - int(last))
            end = min(len(raw) - 1, int(last)) if first and last else len(raw) - 1
            if start >= len(raw) or end < start:
                raise CloudError("InvalidRange")
            headers["ContentRange"] = f"bytes {start}-{end}/{len(raw)}"
            raw = raw[start:end + 1]
        body = PreviewBody(raw)
        self.bodies.append((Key, body))
        if Key in self.encodings:
            headers["ContentEncoding"] = self.encodings[Key]
        return {"Body": body, "ContentLength": len(raw), **headers}

    def put_object(self, *, Bucket, Key, Body, **kwargs):
        if Key in self.write_failures:
            raise self.write_failures[Key]
        raw = Body.read() if hasattr(Body, "read") else Body
        if Key in self.objects:
            self.versions.setdefault(Key, []).append(self.objects[Key])
        self.objects[Key] = raw
        self.puts.append(Key)

    def delete_object(self, **kwargs):
        raise AssertionError("The editor must preserve cloud versions")

    def get_paginator(self, operation):
        raise AssertionError("These HTTP operations must not scan the bucket")


class EditorHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="editor-http-", dir=ROOT / "logs")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.local = self.root / "web" / "local"
        self.video = self.local / "sample120"
        (self.video / "AV1").mkdir(parents=True)
        self.metadata = {"id": "sample120", "title": "Original title", "description": "Original description",
                         "tags": ["120 fps"], "visibility": "private", "createdAt": 1,
                         "frameRate": 120, "duration": 10, "width": 1920, "height": 1080, "codecs": ["AV1"]}
        (self.video / "metadata.json").write_text(json.dumps(self.metadata), encoding="utf-8")
        (self.local / "index.json").write_text(json.dumps([self.metadata]), encoding="utf-8")
        (self.video / "AV1" / "manifest.mpd").write_text('<MPD frameRate="120/1"/>', encoding="utf-8")
        (self.video / "AV1" / "init_0.mp4").write_bytes(bytes(range(128)))
        self.previous_library = admin_app.app.state.video_library
        self.previous_previews = admin_app.app.state.remote_previews
        self.previous_fallbacks = admin_app.app.state.local_preview_fallbacks
        self.previous_busy = admin_app.app.state.editor_busy
        admin_app.app.state.video_library = VideoLibrary(self.root)
        admin_app.app.state.remote_previews = set()
        admin_app.app.state.local_preview_fallbacks = set()
        admin_app.app.state.editor_busy = lambda: False
        self.addCleanup(self.restore_state)
        # An automatic status check must never inspect the real keyring or
        # project credentials in this fixture-only HTTP suite.
        configured = patch("admin_editor.b2_configured", return_value=False)
        self.mock_configured = configured.start()
        self.addCleanup(configured.stop)
        self.client = TestClient(admin_app.app, base_url="http://127.0.0.1:8765", client=("127.0.0.1", 50500))
        self.headers = {"X-Aida-Session": admin_app.app.state.admin_token, "Origin": "http://127.0.0.1:8765"}

    def restore_state(self):
        admin_app.app.state.video_library = self.previous_library
        admin_app.app.state.remote_previews = self.previous_previews
        admin_app.app.state.local_preview_fallbacks = self.previous_fallbacks
        admin_app.app.state.editor_busy = self.previous_busy

    def detail(self):
        response = self.client.get("/api/videos/sample120")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def payload(self, **changes):
        return {"title": "Edited title", "description": "A multiline\ndescription", "tags": "one, two",
                "visibility": "unlisted", "revision": self.detail()["revision"], **changes}

    def use_cloud(self, metadata=None, catalog=None):
        cloud = FakeCloud()
        if metadata is not None:
            cloud.store("sample120/metadata.json", metadata)
        cloud.store("index.json", catalog if catalog is not None else [])
        admin_app.app.state.video_library = VideoLibrary(self.root, client_factory=lambda: (cloud, "fixture-bucket"))
        return cloud

    def refresh_cloud(self):
        response = self.client.get("/api/videos/sample120?remote=true")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_automatic_online_check_discovers_legacy_private_upload_and_enables_authenticated_preview(self):
        cloud = self.use_cloud(self.metadata)
        cloud.store("sample120/AV1/init_0.mp4", b"private-origin-video")
        self.mock_configured.return_value = True
        before = self.detail()
        self.assertFalse(before["has_remote"])
        response = self.client.get("/api/videos/sample120?check_online=true")
        self.assertEqual(response.status_code, 200, response.text)
        detail = response.json()
        self.assertTrue(detail["has_remote"])
        self.assertTrue(detail["remoteChecked"])
        self.assertTrue(detail["can_preview"])
        self.assertEqual(detail["visibility"], "private")
        self.assertNotIn("online_check_error", detail)
        preview = self.client.get("/preview/local/sample120/AV1/init_0.mp4")
        self.assertEqual(preview.content, b"private-origin-video")
        self.assertFalse(cloud.puts)

    def test_automatic_online_check_without_configuration_stays_local_without_cloud_calls(self):
        cloud = self.use_cloud(self.metadata)
        response = self.client.get("/api/videos/sample120?check_online=true")
        self.assertEqual(response.status_code, 200, response.text)
        detail = response.json()
        self.assertFalse(detail["has_remote"])
        self.assertFalse(detail["remoteChecked"])
        self.assertTrue(detail["can_preview"])
        self.assertIn("online_check_error", detail)
        self.assertFalse(cloud.reads)
        self.assertFalse(cloud.puts)

    def test_automatic_online_check_failure_keeps_pending_draft_and_local_preview(self):
        cloud = self.use_cloud(self.metadata)
        saved = self.client.post("/api/videos/sample120", json=self.payload(title="Offline draft"), headers=self.headers)
        self.assertEqual(saved.status_code, 200, saved.text)
        cloud.read_failures["sample120/metadata.json"] = OSError("simulated offline cloud")
        self.mock_configured.return_value = True
        response = self.client.get("/api/videos/sample120?check_online=true")
        self.assertEqual(response.status_code, 200, response.text)
        detail = response.json()
        self.assertEqual(detail["title"], "Offline draft")
        self.assertEqual(detail["revision"], saved.json()["revision"])
        self.assertTrue(detail["pending"])
        self.assertTrue(detail["can_preview"])
        self.assertIn("online_check_error", detail)
        self.assertEqual(self.client.get("/preview/local/sample120/AV1/init_0.mp4").content, bytes(range(128)))
        self.assertFalse(cloud.puts)

    def test_automatic_online_check_during_job_returns_local_view_without_cloud_calls(self):
        cloud = self.use_cloud(self.metadata)
        self.mock_configured.return_value = True
        admin_app.app.state.editor_busy = lambda: True
        response = self.client.get("/api/videos/sample120?check_online=true")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["can_preview"])
        self.assertIn("online_check_error", response.json())
        self.assertFalse(cloud.reads)
        self.assertFalse(cloud.puts)
        explicit = self.client.get("/api/videos/sample120?remote=true&check_online=true")
        self.assertEqual(explicit.status_code, 409)

    def test_automatic_online_check_preserves_pending_cloud_conflict(self):
        cloud = self.use_cloud(self.metadata)
        self.mock_configured.return_value = True
        self.refresh_cloud()
        saved = self.client.post("/api/videos/sample120", json=self.payload(title="Local draft"), headers=self.headers)
        self.assertEqual(saved.status_code, 200, saved.text)
        cloud.store("sample120/metadata.json", {**self.metadata, "title": "Different online edit"})
        response = self.client.get("/api/videos/sample120?check_online=true")
        self.assertEqual(response.status_code, 200, response.text)
        detail = response.json()
        self.assertEqual(detail["title"], "Local draft")
        self.assertTrue(detail["pending"])
        self.assertTrue(detail["remoteChanged"])
        self.assertTrue(detail["has_remote"])
        self.assertFalse(cloud.puts)

    def test_automatic_online_check_does_not_mark_missing_video_uploaded(self):
        cloud = self.use_cloud()
        self.mock_configured.return_value = True
        response = self.client.get("/api/videos/sample120?check_online=true")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["remoteChecked"])
        self.assertFalse(response.json()["has_remote"])
        self.assertFalse(cloud.puts)

    def test_known_uploaded_offline_preview_uses_local_media_and_thumbnail_without_changing_private_draft(self):
        cloud = self.use_cloud(self.metadata)
        cloud.store("sample120/AV1/init_0.mp4", b"different-origin-video")
        cloud.store("sample120/thumbnail_sdr.webp", b"different-origin-thumbnail")
        (self.video / "thumbnail_sdr.webp").write_bytes(b"local-thumbnail")
        self.refresh_cloud()
        saved = self.client.post("/api/videos/sample120", json=self.payload(title="Pending private draft", visibility="private"), headers=self.headers)
        self.assertEqual(saved.status_code, 200, saved.text)
        cloud.store("sample120/metadata.json", {**self.metadata, "title": "Concurrent private edit"})
        conflicted = self.refresh_cloud()
        self.assertTrue(conflicted["remoteChanged"])
        self.mock_configured.return_value = True
        cloud.read_failures["sample120/metadata.json"] = OSError("simulated offline cloud")
        response = self.client.get("/api/videos/sample120?check_online=true")
        self.assertEqual(response.status_code, 200, response.text)
        detail = response.json()
        self.assertTrue(detail["has_remote"])
        self.assertTrue(detail["pending"])
        self.assertTrue(detail["remoteChanged"])
        self.assertEqual(detail["title"], "Pending private draft")
        self.assertEqual(detail["visibility"], "private")
        self.assertEqual(detail["revision"], conflicted["revision"])
        before = len(cloud.reads)
        media = self.client.get("/preview/local/sample120/AV1/init_0.mp4", headers={"Range": "bytes=8-23"})
        self.assertEqual(media.status_code, 206)
        self.assertEqual(media.content, bytes(range(8, 24)))
        self.assertEqual(self.client.get(detail["thumbnail_url"]).content, b"local-thumbnail")
        self.assertEqual(len(cloud.reads), before)
        self.assertEqual(self.client.get("/preview/local/sample120/AV1/init_0.mp4", headers={"Origin": "http://attacker.invalid"}).status_code, 403)
        self.assertFalse(cloud.puts)

    def test_known_uploaded_local_preview_works_when_auto_check_is_unconfigured_or_busy(self):
        cloud = self.use_cloud(self.metadata)
        cloud.store("sample120/AV1/init_0.mp4", b"different-origin-video")
        cloud.store("sample120/thumbnail_sdr.webp", b"different-origin-thumbnail")
        (self.video / "thumbnail_sdr.webp").write_bytes(b"local-thumbnail")
        for mode in ("unconfigured", "busy"):
            with self.subTest(mode=mode):
                self.refresh_cloud()
                self.assertNotIn("sample120", admin_app.app.state.local_preview_fallbacks)
                self.mock_configured.return_value = mode != "unconfigured"
                admin_app.app.state.editor_busy = lambda: mode == "busy"
                before = len(cloud.reads)
                response = self.client.get("/api/videos/sample120?check_online=true")
                self.assertEqual(response.status_code, 200, response.text)
                detail = response.json()
                self.assertTrue(detail["has_remote"])
                self.assertEqual(detail["visibility"], "private")
                self.assertIn("online_check_error", detail)
                self.assertEqual(self.client.get("/preview/local/sample120/AV1/init_0.mp4").content, bytes(range(128)))
                self.assertEqual(self.client.get(detail["thumbnail_url"]).content, b"local-thumbnail")
                self.assertEqual(len(cloud.reads), before)
                admin_app.app.state.editor_busy = lambda: False
        self.assertFalse(cloud.puts)

    def test_successful_online_check_or_explicit_refresh_restores_current_remote_media(self):
        for query in ("check_online=true", "remote=true"):
            with self.subTest(query=query):
                cloud = self.use_cloud(self.metadata)
                cloud.store("sample120/AV1/init_0.mp4", b"current-origin-video")
                self.refresh_cloud()
                self.mock_configured.return_value = True
                cloud.read_failures["sample120/metadata.json"] = OSError("simulated offline cloud")
                fallback = self.client.get("/api/videos/sample120?check_online=true")
                self.assertEqual(fallback.status_code, 200, fallback.text)
                self.assertEqual(self.client.get("/preview/local/sample120/AV1/init_0.mp4").content, bytes(range(128)))
                cloud.read_failures.clear()
                refreshed = self.client.get(f"/api/videos/sample120?{query}")
                self.assertEqual(refreshed.status_code, 200, refreshed.text)
                self.assertNotIn("sample120", admin_app.app.state.local_preview_fallbacks)
                self.assertEqual(self.client.get("/preview/local/sample120/AV1/init_0.mp4").content, b"current-origin-video")
                self.assertFalse(cloud.puts)

    def test_remote_library_refresh_clears_only_returned_video_fallbacks(self):
        cloud = self.use_cloud(self.metadata)
        admin_app.app.state.local_preview_fallbacks.update(("sample120", "unrelated"))
        current = admin_app.app.state.video_library.get_video("sample120", remote=True)
        with patch.object(admin_app.app.state.video_library, "list_videos", return_value=[current]) as listing:
            response = self.client.get("/api/videos?remote=true")
        self.assertEqual(response.status_code, 200, response.text)
        listing.assert_called_once_with(refresh_remote=True)
        self.assertEqual(admin_app.app.state.local_preview_fallbacks, {"unrelated"})
        self.assertFalse(cloud.puts)

    def test_offline_fallback_does_not_fabricate_missing_local_assets(self):
        cloud = self.use_cloud(self.metadata)
        cloud.store("sample120/AV1/chunk_0_00001.fmp4", b"origin-only-chunk")
        self.refresh_cloud()
        self.mock_configured.return_value = True
        cloud.read_failures["sample120/metadata.json"] = OSError("simulated metadata check failure")
        response = self.client.get("/api/videos/sample120?check_online=true")
        self.assertEqual(response.status_code, 200, response.text)
        media = self.client.get("/preview/local/sample120/AV1/chunk_0_00001.fmp4")
        self.assertEqual(media.status_code, 200)
        self.assertEqual(media.content, b"origin-only-chunk")
        cloud.read_failures["sample120/AV1/chunk_0_00001.fmp4"] = OSError("simulated missing remote connection")
        failed = self.client.get("/preview/local/sample120/AV1/chunk_0_00001.fmp4")
        self.assertGreaterEqual(failed.status_code, 400)
        self.assertNotEqual(failed.content, b"origin-only-chunk")
        self.assertFalse(cloud.puts)

    def test_first_publish_checks_cloud_and_uploads_completed_local_draft(self):
        other = {"id": "other", "title": "Keep online video", "visibility": "public", "frameRate": 120}
        cloud = self.use_cloud(catalog=[other])
        saved = self.client.post("/api/videos/sample120", json=self.payload(title="Offline draft"), headers=self.headers)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(cloud.reads, [])
        self.assertEqual(cloud.puts, [])
        response = self.client.post("/api/videos/sample120", json=self.payload(title="Ready to publish", visibility="public", publish=True), headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        detail = response.json()
        self.assertFalse(detail["pending"])
        self.assertTrue(detail["has_remote"])
        self.assertTrue(detail["remoteChecked"])
        self.assertEqual(detail["frameRate"], 120)
        self.assertEqual(cloud.puts[-2:], ["sample120/metadata.json", "index.json"])
        self.assertIn("sample120/AV1/manifest.mpd", cloud.puts[:-2])
        self.assertIn("sample120/AV1/init_0.mp4", cloud.puts[:-2])
        self.assertEqual(json.loads(cloud.objects["sample120/metadata.json"])["title"], "Ready to publish")
        self.assertIn(other, json.loads(cloud.objects["index.json"]))

    def test_direct_first_publish_never_overwrites_unreviewed_cloud_edit(self):
        online = {**self.metadata, "title": "Changed online"}
        cloud = self.use_cloud(metadata=online)
        before = self.detail()["revision"]
        body = self.payload(title="Typed but not saved", revision=before, publish=True)
        response = self.client.post("/api/videos/sample120", json=body, headers=self.headers)
        self.assertEqual(response.status_code, 409, response.text)
        current = response.json()["current"]
        self.assertNotEqual(current["revision"], before)
        self.assertEqual(current["title"], "Typed but not saved")
        self.assertTrue(current["pending"])
        self.assertTrue(current["remoteChanged"])
        self.assertEqual(cloud.puts, [])
        self.assertEqual(json.loads(cloud.objects["sample120/metadata.json"]), online)

    def test_failed_catalog_write_returns_current_revision_and_retry_repairs_it(self):
        cloud = self.use_cloud(metadata=self.metadata)
        self.refresh_cloud()
        before = self.detail()["revision"]
        cloud.write_failures["index.json"] = ConnectionError("Fake interrupted catalogue save")
        body = self.payload(visibility="public", revision=before, publish=True)
        response = self.client.post("/api/videos/sample120", json=body, headers=self.headers)
        self.assertEqual(response.status_code, 400, response.text)
        current = response.json()["current"]
        self.assertNotEqual(current["revision"], before)
        self.assertTrue(current["pending"])
        self.assertFalse(current["remoteChanged"])
        self.assertEqual(current["title"], "Edited title")
        self.assertEqual(current["revision"], self.detail()["revision"])
        self.assertEqual(json.loads(cloud.objects["sample120/metadata.json"])["title"], "Edited title")
        self.assertEqual(json.loads(cloud.versions["sample120/metadata.json"][0]), self.metadata)
        cloud.write_failures.clear()
        body["revision"] = current["revision"]
        retried = self.client.post("/api/videos/sample120", json=body, headers=self.headers)
        self.assertEqual(retried.status_code, 200, retried.text)
        self.assertFalse(retried.json()["pending"])
        self.assertEqual(json.loads(cloud.objects["index.json"])[0]["title"], "Edited title")

    def test_live_conflict_returns_saved_local_draft_without_cloud_writes(self):
        cloud = self.use_cloud(metadata=self.metadata)
        self.refresh_cloud()
        saved = self.client.post("/api/videos/sample120", json=self.payload(title="Keep local draft"), headers=self.headers)
        self.assertEqual(saved.status_code, 200, saved.text)
        cloud.store("sample120/metadata.json", {**self.metadata, "title": "Concurrent online edit"})
        response = self.client.post("/api/videos/sample120", json=self.payload(title="Keep local draft", publish=True), headers=self.headers)
        self.assertEqual(response.status_code, 409, response.text)
        current = response.json()["current"]
        self.assertTrue(current["remoteChanged"])
        self.assertTrue(current["pending"])
        self.assertEqual(current["title"], "Keep local draft")
        self.assertEqual(current["revision"], self.detail()["revision"])
        self.assertEqual(cloud.puts, [])

    def test_authenticated_remote_preview_streams_exact_range_after_refresh(self):
        cloud = self.use_cloud(metadata=self.metadata)
        key = "sample120/AV1/chunk_0_00001.fmp4"
        cloud.store(key, bytes(range(128)))
        url = "/preview/local/sample120/AV1/chunk_0_00001.fmp4"
        before = self.client.get(url)
        self.assertEqual(before.status_code, 404)
        self.assertEqual(cloud.reads, [])
        detail = self.refresh_cloud()
        self.assertTrue(detail["has_remote"])
        self.assertTrue(detail["can_preview"])
        response = self.client.get(url, headers={"Range": "bytes=8-23"})
        self.assertEqual(response.status_code, 206, response.text)
        self.assertEqual(response.content, bytes(range(8, 24)))
        self.assertEqual(response.headers["content-range"], "bytes 8-23/128")
        self.assertEqual(response.headers["content-length"], "16")
        self.assertEqual(response.headers["content-type"], "video/mp4")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(cloud.reads[-1], (key, {"Range": "bytes=8-23"}))
        self.assertTrue(cloud.bodies[-1][1].closed)
        self.assertTrue(all(0 < size <= 128 * 1024 for size in cloud.bodies[-1][1].read_sizes))

    def test_metadata_draft_keeps_current_cloud_media_ahead_of_stale_local_copy(self):
        cloud = self.use_cloud(metadata=self.metadata)
        key = "sample120/AV1/init_0.mp4"
        cloud.store(key, b"current online rendition bytes")
        self.refresh_cloud()
        response = self.client.post("/api/videos/sample120", json=self.payload(title="Local title draft"), headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["pending"])
        preview = self.client.get("/preview/local/sample120/AV1/init_0.mp4")
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(preview.content, cloud.objects[key])
        self.assertNotEqual(preview.content, (self.video / "AV1" / "init_0.mp4").read_bytes())
        self.assertEqual(cloud.puts, [])

    def test_pending_thumbnail_uses_local_draft_while_online_video_stays_unchanged(self):
        cloud = self.use_cloud(metadata=self.metadata)
        cloud.store("sample120/thumbnail_sdr_720p.webp", b"old online still")
        self.refresh_cloud()
        image = BytesIO()
        Image.new("RGB", (160, 90), "#e8ff47").save(image, "PNG")
        response = self.client.post("/api/videos/sample120/thumbnail", json={
            "revision": self.detail()["revision"], "filename": "draft.png",
            "image_base64": base64.b64encode(image.getvalue()).decode("ascii"),
        }, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["pending"])
        before = len(cloud.reads)
        preview = self.client.get(response.json()["thumbnail_url"])
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(Image.open(BytesIO(preview.content)).size, (160, 90))
        self.assertEqual(len(cloud.reads), before)
        self.assertEqual(cloud.puts, [])
        self.assertEqual(cloud.objects["sample120/thumbnail_sdr_720p.webp"], b"old online still")

    def test_remote_head_closes_body_without_reading_media(self):
        cloud = self.use_cloud(metadata=self.metadata)
        key = "sample120/AV1/chunk_0_00001.fmp4"
        cloud.store(key, b"unchanged fixture video bytes")
        self.refresh_cloud()
        response = self.client.head("/preview/local/sample120/AV1/chunk_0_00001.fmp4")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"")
        self.assertEqual(response.headers["content-length"], str(len(cloud.objects[key])))
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(cloud.bodies[-1][0], key)
        self.assertTrue(cloud.bodies[-1][1].closed)
        self.assertEqual(cloud.bodies[-1][1].read_sizes, [])

    def test_remote_preview_rejects_bad_ranges_without_broadening_origin_request(self):
        cloud = self.use_cloud(metadata=self.metadata)
        key = "sample120/AV1/chunk_0_00001.fmp4"
        cloud.store(key, bytes(range(128)))
        self.refresh_cloud()
        before = len(cloud.reads)
        url = "/preview/local/sample120/AV1/chunk_0_00001.fmp4"
        response = self.client.get(url, headers={"Range": "bytes=0-4,12-16"})
        self.assertEqual(response.status_code, 416)
        self.assertEqual(len(cloud.reads), before)
        response = self.client.get(url, headers={"Range": "bytes=9999-"})
        self.assertEqual(response.status_code, 416, response.text)
        self.assertEqual(cloud.reads[-1], (key, {"Range": "bytes=9999-"}))

    def test_encoded_remote_preview_is_rejected_and_body_closed(self):
        cloud = self.use_cloud(metadata=self.metadata)
        key = "sample120/AV1/chunk_0_00001.fmp4"
        cloud.store(key, b"encoded bytes must not be forwarded")
        cloud.encodings[key] = "gzip"
        self.refresh_cloud()
        response = self.client.get("/preview/local/sample120/AV1/chunk_0_00001.fmp4")
        self.assertEqual(response.status_code, 503, response.text)
        self.assertNotIn("encoded bytes", response.text)
        self.assertTrue(cloud.bodies[-1][1].closed)
        self.assertEqual(cloud.bodies[-1][1].read_sizes, [])

    def test_root_injects_session_token_and_never_caches_editor(self):
        for path in ("/", "/edit?v=sample120"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertIn(f'name="aida-session" content="{admin_app.app.state.admin_token}"', response.text)
                self.assertEqual(response.headers["cache-control"], "no-store")

    def test_cross_site_host_origin_and_non_loopback_clients_are_denied(self):
        for headers in ({"Host": "attacker.invalid:8765"}, {"Origin": "null"},
                        {"Origin": "http://attacker.invalid"}, {"Origin": "http://127.0.0.1:9999"},
                        {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.client.get("/api/videos", headers=headers).status_code, 403)
        external = TestClient(admin_app.app, base_url="http://127.0.0.1:8765", client=("192.0.2.5", 50500))
        self.assertEqual(external.get("/").status_code, 403)

    def test_writes_require_session_token_even_when_origin_is_local(self):
        body = self.payload()
        for headers in ({}, {"Origin": "http://127.0.0.1:8765"}, {"X-Aida-Session": "wrong"}):
            self.assertEqual(self.client.post("/api/videos/sample120", json=body, headers=headers).status_code, 403)
        self.assertEqual(self.client.post("/api/probe", json={"path": "none"}).status_code, 403)
        self.assertEqual(self.client.post("/api/credentials", json={}).status_code, 403)

    def test_details_and_save_preserve_120fps_and_archive_prior_contents(self):
        detail = self.detail()
        self.assertTrue(detail["can_preview"])
        self.assertEqual(detail["preview_url"], "/preview/watch.html?v=sample120&local=1")
        body = self.payload()
        response = self.client.post("/api/videos/sample120", json=body, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        edited = response.json()
        self.assertEqual(edited["title"], "Edited title")
        self.assertEqual(edited["tags"], ["one", "two"])
        self.assertEqual(edited["frameRate"], 120)
        self.assertTrue(edited["pending"])
        saved = json.loads((self.video / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["visibility"], "unlisted")
        self.assertTrue(list((self.root / ".agent-trash").rglob("manifest.txt")))
        self.assertEqual(self.client.post("/api/videos/sample120", json=body, headers=self.headers).status_code, 409)

    def test_mutations_refuse_during_encode_or_maintenance(self):
        body = self.payload()
        admin_app.app.state.editor_busy = lambda: True
        response = self.client.post("/api/videos/sample120", json=body, headers=self.headers)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.detail()["title"], "Original title")

    def test_private_preview_media_and_byte_ranges(self):
        metadata = self.client.get("/preview/local/sample120/metadata.json")
        self.assertEqual(metadata.json()["visibility"], "private")
        response = self.client.get("/preview/local/sample120/AV1/init_0.mp4", headers={"Range": "bytes=8-23"})
        self.assertEqual(response.status_code, 206, response.text)
        self.assertEqual(response.content, bytes(range(8, 24)))
        self.assertEqual(response.headers["content-range"], "bytes 8-23/128")
        head = self.client.head("/preview/local/sample120/AV1/init_0.mp4")
        self.assertEqual(head.status_code, 200)
        self.assertEqual(head.content, b"")
        self.assertEqual(head.headers["content-length"], "128")
        self.assertEqual(head.headers["cache-control"], "no-store")
        self.assertEqual(self.client.get("/preview/local/index.json").json(), [])

    def test_preview_never_exposes_credentials_state_or_unapproved_files(self):
        for path in ("/preview/local/sample120/.editor-state.json", "/api/video-media/sample120/.env",
                     "/preview/local/sample120/AV1/other.txt", "/preview/local/index.json.bak",
                     "/preview/local/sample120/%2e%2e/index.json", "/preview/.env", "/preview/local/sample120/source.mp4"):
            with self.subTest(path=path):
                self.assertIn(self.client.get(path).status_code, (400, 404))
        self.assertEqual(self.client.get("/preview/local/sample120/AV1/init_0.mp4", headers={"Range":"bytes=0-1,4-5"}).status_code, 416)

    def test_thumbnail_replacement_returns_revision_and_real_images(self):
        image = BytesIO()
        Image.new("RGB", (160, 90), "#e8ff47").save(image, "PNG")
        response = self.client.post("/api/videos/sample120/thumbnail", json={
            "revision": self.detail()["revision"], "filename":"custom.png",
            "image_base64":base64.b64encode(image.getvalue()).decode("ascii"),
        }, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        detail = response.json()
        thumbnail = self.client.get(detail["thumbnail_url"])
        self.assertEqual(thumbnail.status_code, 200)
        self.assertEqual(thumbnail.headers["content-type"], "image/webp")
        self.assertEqual(Image.open(BytesIO(thumbnail.content)).size, (160, 90))
        self.assertEqual(detail["frameRate"], 120)
        self.assertNotEqual(detail["revision"], self.metadata.get("revision"))

    def test_bad_images_do_not_change_existing_metadata(self):
        before = (self.video / "metadata.json").read_bytes()
        for encoded in ("not base64!!", base64.b64encode(b"not an image").decode()):
            response = self.client.post("/api/videos/sample120/thumbnail", json={
                "revision":self.detail()["revision"], "image_base64":encoded,
            }, headers=self.headers)
            self.assertEqual(response.status_code, 400)
            self.assertEqual((self.video / "metadata.json").read_bytes(), before)

    def test_credentials_do_not_return_saved_secret_and_blank_keeps_it(self):
        config = {"B2_KEY_ID":"fixture-id", "B2_APP_KEY":"fixture-secret", "B2_BUCKET":"fixture", "B2_ENDPOINT":"https://example.invalid"}
        with patch.object(admin_app, "get_b2_config", return_value=config), patch.object(admin_app, "b2_configured", return_value=True):
            response = self.client.get("/api/credentials")
            self.assertEqual(response.json()["app_key"], "")
            self.assertNotIn("fixture-secret", response.text)
            with patch.object(admin_app, "save_b2_credentials") as save:
                body = {"key_id":"fixture-id", "app_key":"", "bucket":"fixture", "endpoint":"https://example.invalid"}
                response = self.client.post("/api/credentials", json=body, headers=self.headers)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(save.call_args.args[1], "fixture-secret")
                body["key_id"] = "different-id"
                self.assertEqual(self.client.post("/api/credentials", json=body, headers=self.headers).status_code, 400)

    def test_pipeline_id_framerate_and_handoff(self):
        source = self.root / "source.mp4"
        source.write_bytes(b"fixture, ffprobe is mocked")
        with patch.object(admin_app, "probe_source", return_value={"fps":60}), patch.object(admin_app, "_start_thread") as start:
            response = self.client.post("/api/pipeline", json={"path":str(source)}, headers=self.headers)
            self.assertEqual(response.status_code, 400)
            start.assert_not_called()
        with patch.object(admin_app, "probe_source", return_value={"fps":120}), patch.object(admin_app, "_start_thread") as start:
            response = self.client.post("/api/pipeline", json={"path":str(source),"video_id":"../bad"}, headers=self.headers)
            self.assertEqual(response.status_code, 400)
            response = self.client.post("/api/pipeline", json={"path":str(source)}, headers=self.headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertRegex(response.json()["video_id"], r"^[A-Za-z0-9_-]+$")
            self.assertEqual(start.call_args.args[1].video_id, response.json()["video_id"])
            admin_app._encode_running = False


if __name__ == "__main__":
    unittest.main()
