"""Fake central writer/B2 integration; no network, media decoding or credentials."""

from copy import deepcopy
import base64
from hashlib import md5, sha256
import time
import json
import logging
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).absolute().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import upload
import video_library
import sync_catalog
from admin_client import AdminClientError, VARIANTS


class FakeMedia:
    def __init__(self):
        self.writes = []
        self.fail = None

    def upload_file(self, path, bucket, key, ExtraArgs):
        raise AssertionError("Central uploads must not use reusable B2 credentials")

    def put_object(self, **kwargs):
        raise AssertionError("Central mode must never directly write metadata/catalogue/thumbnails")

    def get_object(self, **kwargs):
        raise AssertionError("Central metadata reads must not bypass the writer")


class FakeWriter:
    url = "https://keppy.dev/edit/api"

    def __init__(self):
        self.current = None
        self.calls = []
        self.failure = None

    def get_video(self, video_id):
        self.calls.append(("read", video_id))
        return deepcopy(self.current)

    def reserve(self, video_id, operation_id):
        self.calls.append(("reserve", video_id, operation_id))
        if self.current:
            raise AdminClientError("Existing ID", 409)
        return "synthetic-lease"

    def upload_grants(self, video_id, lease, reservation_operation_id, files, *, operation_id):
        self.calls.append(("grants", video_id, deepcopy(files)))
        return {"expires_timestamp": time.time() + 300, "grants": [{"path": file["path"]} for file in files]}

    def upload_media(self, video_id, path, descriptor, grant):
        key = f"{video_id}/{descriptor['path']}"
        if self.media.fail and key.endswith(self.media.fail):
            raise AdminClientError("Synthetic media failure")
        data = path.read_bytes()
        assert descriptor["size"] == len(data)
        assert descriptor["sha256"] == sha256(data).hexdigest()
        assert descriptor["md5"] == base64.b64encode(md5(data).digest()).decode()
        self.media.writes.append((key, data))

    def _result(self, metadata, entry):
        self.current = {"id": metadata["id"], "metadata": deepcopy(metadata), "published_metadata": deepcopy(metadata),
                        "entry": deepcopy(entry) if metadata["visibility"] == "public" else None, "revision": "central-r2", "pending": False, "has_remote": True}
        return deepcopy(self.current)

    def finalize(self, video_id, lease, metadata, entry, *, images, operation_id):
        self.calls.append(("finalize", video_id, lease, deepcopy(metadata), deepcopy(images), operation_id))
        if self.failure:
            raise self.failure
        return self._result(metadata, entry)

    def publish(self, video_id, fields, revision, *, images, operation_id):
        self.calls.append(("publish", video_id, deepcopy(fields), revision, deepcopy(images), operation_id))
        if self.failure:
            raise self.failure
        if revision != self.current["revision"]:
            raise AdminClientError("Conflict", 409)
        return self._result({**self.current["published_metadata"], **fields}, self.current["entry"])


class CentralPublishingTests(unittest.TestCase):
    def setUp(self):
        artifacts = ROOT / "logs" / "central-publishing-tests"
        artifacts.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="fixture-", dir=artifacts)
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name)
        self.local = self.project / "web" / "local"
        self.folder = self.local / "video"
        self.folder.mkdir(parents=True)
        self.metadata = {"id": "video", "title": "Original", "description": "Before", "tags": ["120fps"], "visibility": "private", "frameRate": 120, "duration": 1.0, "codecs": ["AV1"], "width": 1920, "height": 1080}
        self.path = self.folder / "metadata.json"
        self.path.write_text(json.dumps(self.metadata), encoding="utf-8")
        self.entry = dict(self.metadata)
        (self.local / "index.json").write_text(json.dumps([self.entry]), encoding="utf-8")
        (self.folder / "AV1").mkdir()
        (self.folder / "AV1" / "manifest.mpd").write_bytes(b'<MPD frameRate="120/1"/>')
        (self.folder / "AV1" / "init_0.mp4").write_bytes(b"synthetic media")
        for name in VARIANTS:
            (self.folder / name).write_bytes(b"synthetic image; validated by fake server")
        (self.folder / "thumbnail_hdr.avif").write_bytes(b"local HDR thumbnail remains local")
        self.media, self.writer = FakeMedia(), FakeWriter()
        self.writer.media = self.media
        self.library = video_library.VideoLibrary(self.project, self.local, client_factory=lambda: (self.media, "fixture"))
        self.log = logging.getLogger("central-publishing-test")
        for module in (upload, video_library, sync_catalog):
            patcher = patch.object(module, "central_client", return_value=self.writer)
            patcher.start()
            self.addCleanup(patcher.stop)
        project_patch = patch.object(upload, "_PROJECT_ROOT", self.project)
        project_patch.start()
        self.addCleanup(project_patch.stop)

    def upload(self):
        return upload.upload_folder(self.media, "fixture", self.folder, "video", self.log, on_progress=lambda *_: None, entry=self.entry)

    def test_new_upload_reserves_before_media_then_finalizes_all_sdr_thumbnails(self):
        original_reserve = self.writer.reserve
        self.writer.reserve = lambda *args: self.assertEqual(self.media.writes, []) or original_reserve(*args)
        original_finalize = self.writer.finalize
        self.writer.finalize = lambda *args, **kwargs: self.assertEqual(len(self.media.writes), 2) or original_finalize(*args, **kwargs)
        self.assertTrue(self.upload())
        self.assertEqual({key for key, _ in self.media.writes}, {"video/AV1/manifest.mpd", "video/AV1/init_0.mp4"})
        finalized = [call for call in self.writer.calls if call[0] == "finalize"][0]
        self.assertEqual(set(finalized[4]), set(VARIANTS))
        self.assertEqual(finalized[3]["frameRate"], 120)
        self.assertTrue(self.library._state("video")["centralUpload"]["confirmed"])
        self.assertTrue((self.folder / "thumbnail_hdr.avif").exists())

    def test_partial_media_failure_never_finalizes_and_retry_keeps_reservation(self):
        self.media.fail = "init_0.mp4"
        self.assertFalse(self.upload())
        self.assertFalse(any(call[0] == "finalize" for call in self.writer.calls))
        first_operation = deepcopy(self.library._state("video")["centralUpload"])
        self.media.fail = None
        self.assertTrue(self.upload())
        operation = self.library._state("video")["centralUpload"]
        self.assertEqual(operation["reserve_operation_id"], first_operation["reserve_operation_id"])
        self.assertEqual(operation["operation_id"], first_operation["operation_id"])
        self.assertEqual(sum(call[0] == "reserve" for call in self.writer.calls), 1)

    def test_slow_upload_waves_get_fresh_grants_after_prior_files_finish(self):
        for index in range(1, 4):
            (self.folder / "AV1" / f"chunk_0_{index}.fmp4").write_bytes(b"synthetic chunk")
        original = self.writer.upload_grants
        def grants(*args, **kwargs):
            previous = sum(call[0] == "grants" for call in self.writer.calls)
            self.assertEqual(len(self.media.writes), previous)
            self.assertEqual(len(args[3]), 1)
            return original(*args, **kwargs)
        self.writer.upload_grants = grants
        self.assertTrue(upload.upload_folder(None, "fixture", self.folder, "video", self.log,
            max_workers=1, on_progress=lambda *_: None, entry=self.entry))
        self.assertEqual(len(self.media.writes), 5)

    def test_expiry_during_upload_renews_only_that_file_once(self):
        original = self.writer.upload_media
        attempts = []
        def transfer(video_id, path, descriptor, grant):
            if descriptor["path"].endswith("init_0.mp4"):
                attempts.append(1)
                if len(attempts) == 1:
                    raise AdminClientError("Synthetic expired link", 403)
            return original(video_id, path, descriptor, grant)
        self.writer.upload_media = transfer
        self.assertTrue(self.upload())
        self.assertEqual(len(attempts), 2)
        grant_calls = [call for call in self.writer.calls if call[0] == "grants"]
        self.assertEqual(len(grant_calls), 2)
        self.assertEqual([file["path"] for file in grant_calls[-1][2]], ["AV1/init_0.mp4"])

    def test_finalize_failure_retry_does_not_reupload_media_or_change_operation(self):
        self.writer.failure = AdminClientError("Synthetic timeout")
        with self.assertRaises(AdminClientError):
            self.upload()
        writes = list(self.media.writes)
        operation = deepcopy(self.library._state("video")["centralUpload"])
        self.writer.failure = None
        self.assertTrue(self.upload())
        self.assertEqual(self.media.writes, writes)
        finalizations = [call for call in self.writer.calls if call[0] == "finalize"]
        self.assertEqual(finalizations[0][-1], finalizations[1][-1])
        self.assertEqual(finalizations[1][-1], operation["operation_id"])

    def test_server_thumbnail_marker_is_adopted_before_local_upload_acknowledgement(self):
        self.metadata["thumbnailUpdatedAt"] = "old-local-marker"
        self.path.write_text(json.dumps(self.metadata), encoding="utf-8")
        original_finalize = self.writer.finalize
        def finalized(*args, **kwargs):
            result = original_finalize(*args, **kwargs)
            self.writer.current["published_metadata"].update(thumbnailMode="sdr", thumbnailUpdatedAt="server-marker")
            self.writer.current["metadata"] = deepcopy(self.writer.current["published_metadata"])
            return deepcopy(self.writer.current)
        self.writer.finalize = finalized
        self.assertTrue(self.upload())
        self.assertEqual(self.library.get_video("video")["metadata"]["thumbnailUpdatedAt"], "server-marker")
        acknowledged = self.library.mark_uploaded("video")
        self.assertTrue(acknowledged["uploaded"])
        self.assertFalse(acknowledged["pending"])

    def test_master_assignments_confirm_against_current_central_names_and_aliases(self):
        from tags import hydrate_video_tags
        before = {"version": 1, "tags": [{"id": "game-one", "name": "Old name", "aliases": []}], "redirects": {}}
        current = {"version": 1, "tags": [{"id": "game-one", "name": "Current name", "aliases": ["Old name", "FG"]}], "redirects": {}}
        self.metadata = hydrate_video_tags({**self.metadata, "tagIds": ["game-one"]}, before)
        self.entry = dict(self.metadata)
        self.path.write_text(json.dumps(self.metadata), encoding="utf-8")
        (self.local / "tags.json").write_text(json.dumps(before), encoding="utf-8")
        (self.local / "index.json").write_text(json.dumps([self.entry]), encoding="utf-8")
        self.writer.get_tags = lambda: {**current, "revision": "registry-current"}
        original_finalize = self.writer.finalize

        def finalized(*args, **kwargs):
            result = original_finalize(*args, **kwargs)
            canonical = hydrate_video_tags(result["published_metadata"], current)
            self.writer.current.update(metadata=deepcopy(canonical), published_metadata=canonical)
            return deepcopy(self.writer.current)

        self.writer.finalize = finalized
        self.assertTrue(self.upload())
        saved = self.library.get_video("video")["metadata"]
        self.assertEqual(saved["tagIds"], ["game-one"])
        self.assertEqual(saved["tags"], ["Current name"])
        self.assertEqual(saved["tagDefinitions"][0]["aliases"], ["Old name", "FG"])
        self.assertFalse(self.library.mark_uploaded("video")["pending"])

    def test_existing_id_and_incomplete_thumbnails_fail_before_any_media(self):
        self.writer._result(self.metadata, self.entry)
        with self.assertRaises(AdminClientError):
            self.upload()
        self.assertEqual(self.media.writes, [])
        (self.folder / "thumbnail_share.jpg").unlink()
        with self.assertRaises(AdminClientError):
            self.upload()
        self.assertEqual(self.media.writes, [])

    def test_bulk_writes_are_explicitly_disabled_and_cannot_claim_success(self):
        with self.assertRaisesRegex(AdminClientError, "owns index"):
            upload.upload_index(self.media, "fixture", self.local / "index.json", self.log)
        with self.assertRaises(AdminClientError):
            upload.replace_file(self.media, "fixture", "video/metadata.json", self.path, "application/json")
        with self.assertRaises(AdminClientError):
            upload.replace_object(self.media, "fixture", "video/thumbnail_sdr.webp", b"bytes", "image/webp")
        result = sync_catalog.run_sync(apply=True, upload=True, log=self.log)
        self.assertIn("Use Videos", result.error)
        self.assertEqual(self.media.writes, [])

    def _existing(self):
        self.writer._result(self.metadata, self.entry)
        return self.library.get_video("video", remote=True)

    def test_existing_edit_uses_canonical_revision_and_never_uploads_video(self):
        current = self._existing()
        fields = {"title": "Edited", "description": "After", "tags": [], "visibility": "private"}
        saved = self.library.save_video("video", fields, current["revision"], publish=True)
        self.assertFalse(saved["pending"])
        self.assertEqual(saved["metadata"]["title"], "Edited")
        self.assertEqual(saved["metadata"]["frameRate"], 120)
        self.assertEqual(self.media.writes, [])
        call = [call for call in self.writer.calls if call[0] == "publish"][0]
        self.assertEqual(call[3], "central-r2")
        self.assertEqual(set(call[2]), {"title", "description", "tags", "visibility"})

    def test_local_editor_first_publication_uses_reserve_media_and_finalize(self):
        self.library._client = lambda: self.fail("Central publication must never load B2 credentials")
        current = self.library.get_video("video", remote=True)
        saved = self.library.save_video("video", {"title": "First upload", "visibility": "private"}, current["revision"], publish=True)
        self.assertFalse(saved["pending"])
        self.assertTrue(saved["uploaded"])
        self.assertEqual(saved["metadata"]["frameRate"], 120)
        self.assertEqual([call[0] for call in self.writer.calls if call[0] != "read"], ["reserve", "grants", "finalize"])
        self.assertEqual(len(self.media.writes), 2)

    def test_existing_pending_stills_publish_with_details_in_one_revision_checked_call(self):
        current = self._existing()
        state = self.library._state("video")
        state["pendingThumbnails"] = list(video_library.THUMBNAILS)
        self.library._save_state("video", state)
        current = self.library.get_video("video")
        self.library.save_video("video", {"title": "Caption and still", "visibility": "private"}, current["revision"], publish=True)
        calls = [call for call in self.writer.calls if call[0] == "publish"]
        self.assertEqual(len(calls), 1)
        self.assertEqual(set(calls[0][4]), set(VARIANTS))
        self.assertEqual(calls[0][2]["title"], "Caption and still")
        self.assertEqual(self.media.writes, [])

    def test_new_cloud_revision_rejects_old_local_form_without_adopting_it(self):
        current = self._existing()
        self.writer.current["revision"] = "another-browser-r3"
        self.writer.current["published_metadata"]["title"] = "Other browser won"
        with self.assertRaises(video_library.VideoConflictError):
            self.library.save_video("video", {"title": "Stale local edit", "visibility": "private"}, current["revision"], publish=True)
        self.assertEqual(self.writer.current["published_metadata"]["title"], "Other browser won")
        self.assertEqual(self.library._state("video")["writerRevision"], "central-r2")
        self.assertEqual(self.library.get_video("video")["metadata"]["title"], "Stale local edit")

    def test_conflict_and_auth_failures_keep_local_draft_without_direct_fallback(self):
        for status in (403, 409, 503):
            with self.subTest(status=status):
                current = self._existing()
                self.writer.failure = AdminClientError("Synthetic denied", status)
                with self.assertRaises(video_library.VideoLibraryError):
                    self.library.save_video("video", {"title": f"Kept{status}", "visibility": "private"}, current["revision"], publish=True)
                saved = self.library.get_video("video")
                self.assertTrue(saved["pending"])
                self.assertEqual(saved["metadata"]["title"], f"Kept{status}")
                self.assertEqual(self.media.writes, [])
                self.writer.failure = None
                self.library.discard_draft("video", saved["revision"])

    def test_failed_existing_publish_replays_identical_revision_and_operation(self):
        current = self._existing()
        self.writer.failure = AdminClientError("Synthetic timeout")
        fields = {"title": "Retry me", "visibility": "private"}
        with self.assertRaises(video_library.VideoLibraryError):
            self.library.save_video("video", fields, current["revision"], publish=True)
        current = self.library.get_video("video")
        self.writer.failure = None
        self.library.save_video("video", fields, current["revision"], publish=True)
        calls = [call for call in self.writer.calls if call[0] == "publish"]
        self.assertEqual(calls[0], calls[1])

    def test_remote_unfinished_draft_cannot_be_silently_overwritten_locally(self):
        self.writer._result(self.metadata, self.entry)
        self.writer.current["pending"] = True
        self.writer.current["metadata"]["title"] = "Unfinished browser edit"
        current = self.library.get_video("video", remote=True)
        with self.assertRaisesRegex(video_library.VideoConflictError, "online editor draft"):
            self.library.save_video("video", {"title": "Local draft", "visibility": "private"}, current["revision"], publish=True)
        self.assertFalse(any(call[0] == "publish" for call in self.writer.calls))

    def test_missing_central_credentials_never_falls_back_to_direct_publication(self):
        current = self._existing()
        with patch.object(video_library, "central_client", side_effect=AdminClientError("Missing service credentials")):
            with self.assertRaisesRegex(video_library.VideoLibraryError, "Missing service"):
                self.library.save_video("video", {"title": "Keep", "visibility": "private"}, current["revision"], publish=True)
        self.assertEqual(self.media.writes, [])


if __name__ == "__main__":
    unittest.main()
