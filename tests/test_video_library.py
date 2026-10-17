"""Editor safety tests use generated project fixtures and an in-memory B2 fake."""

import io
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import runpy
import tempfile
from threading import Event
import unittest


ROOT = Path(__file__).absolute().parents[1]
MODULE = runpy.run_path(str(ROOT / "src" / "video_library.py"))
VideoLibrary = MODULE["VideoLibrary"]
VideoLibraryError = MODULE["VideoLibraryError"]
VideoConflictError = MODULE["VideoConflictError"]
VideoNotFoundError = MODULE["VideoNotFoundError"]
THUMBNAILS = MODULE["THUMBNAILS"]


class FakeB2:
    def __init__(self):
        self.objects = {}
        self.puts = []
        self.versions = {}
        self.fail_key = None

    def store(self, key, value):
        self.objects[key] = json.dumps(value).encode()

    def get_object(self, Bucket, Key, **kwargs):
        if Key not in self.objects:
            raise FileNotFoundError(Key)
        result = {"Body": io.BytesIO(self.objects[Key])}
        if kwargs:
            result["RequestedRange"] = kwargs["Range"]
        return result

    def put_object(self, Bucket, Key, Body, **kwargs):
        if self.fail_key == Key:
            raise OSError("simulated storage error")
        data = Body.read() if hasattr(Body, "read") else Body
        if Key in self.objects:
            self.versions.setdefault(Key, []).append(self.objects[Key])
        self.objects[Key] = data
        self.puts.append(Key)

    def get_paginator(self, name):
        if name != "list_objects_v2":
            raise AssertionError("Version deletion/listing is forbidden")
        return self

    def paginate(self, Bucket):
        yield {"Contents": [{"Key": key} for key in self.objects]}


class VideoLibraryTests(unittest.TestCase):
    def setUp(self):
        artifacts = ROOT / "logs" / "video-library-tests"
        artifacts.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="fixture-", dir=artifacts)
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name)
        self.local = self.project / "web" / "local"
        self.local.mkdir(parents=True)
        self.b2 = FakeB2()
        self.client_calls = 0

        def factory():
            self.client_calls += 1
            return self.b2, "test-bucket"

        self.library = VideoLibrary(self.project, client_factory=factory)
        self.metadata = {"id": "video-a", "title": "Original", "description": "Before", "visibility": "private",
                         "createdAt": 123, "frameRate": 120, "width": 3840, "height": 2160,
                         "duration": 33.333, "codecs": ["AV1"], "colorTransfer": "smpte2084"}
        self.folder = self.local / "video-a"
        self.folder.mkdir()
        self.write_local(self.metadata)
        self.write_index([{**self.metadata, "tags": ["old-tag"], "hdr": True}])

    def write_local(self, value):
        (self.folder / "metadata.json").write_text(json.dumps(value), encoding="utf-8")

    def write_index(self, entries):
        (self.local / "index.json").write_text(json.dumps(entries), encoding="utf-8")

    def cloud(self, metadata=None, index=None):
        self.b2.store("video-a/metadata.json", metadata or self.metadata)
        self.b2.store("index.json", index if index is not None else [])

    def view(self, remote=False):
        return self.library.get_video("video-a", remote=remote)

    def save(self, fields=None, publish=False):
        return self.library.save_video("video-a", fields or {}, self.view()["revision"], publish=publish)

    def test_local_list_and_save_never_read_credentials_or_network(self):
        self.assertEqual(len(self.library.list_videos()), 1)
        saved = self.save({"title": "Edited", "tags": "two, three, two"})
        self.assertEqual(saved["metadata"]["tags"], ["two", "three"])
        self.assertTrue(saved["pending"])
        self.assertEqual(self.client_calls, 0)
        self.assertFalse(self.b2.puts)

    def test_only_editorial_fields_are_editable_and_technical_fields_survive(self):
        for fields in ({"frameRate": 60}, {"source": "outside.mkv"}, {"id": "other"}, {"title": " "}, {"visibility": "published"}):
            with self.subTest(fields=fields), self.assertRaises(VideoLibraryError):
                self.save(fields)
        saved = self.save({"description": "<markup> Unicode café"})["metadata"]
        for key in ("frameRate", "width", "height", "duration", "codecs", "colorTransfer"):
            self.assertEqual(saved[key], self.metadata[key])

    def test_old_form_revision_rejected_after_metadata_or_index_change(self):
        previous = self.view()["revision"]
        self.write_local({**self.metadata, "title": "Changed outside editor"})
        with self.assertRaises(VideoConflictError):
            self.library.save_video("video-a", {"title": "Stale"}, previous)
        previous = self.view()["revision"]
        self.write_index([{**self.metadata, "tags": ["new-tag"]}])
        with self.assertRaises(VideoConflictError):
            self.library.save_video("video-a", {}, previous)

    def test_overwritten_local_metadata_and_index_have_recoverable_backups(self):
        previous = (self.folder / "metadata.json").read_bytes()
        old_index = (self.local / "index.json").read_bytes()
        self.save({"title": "Edited"})
        backups = list((self.project / ".agent-trash").glob("*/web/local/video-a/metadata.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), previous)
        index_backups = list((self.project / ".agent-trash").glob("*/web/local/index.json"))
        self.assertEqual(index_backups[0].read_bytes(), old_index)
        self.assertTrue(list((self.project / ".agent-trash").glob("*/manifest.txt")))

    def test_remote_refresh_uses_authoritative_metadata_and_normalizes_legacy_id(self):
        live = {**self.metadata, "id": "2", "title": "Online edit", "frameRate": 120}
        self.cloud(live, [{"id": "video-a", "tags": ["live-tag"], "visibility": "public"}])
        view = self.view(remote=True)
        self.assertEqual(view["metadata"]["title"], "Online edit")
        self.assertEqual(view["metadata"]["id"], "video-a")
        self.assertEqual(view["metadata"]["tags"], ["live-tag"])
        saved = self.save({"title": "New local draft"})
        self.assertEqual(saved["metadata"]["frameRate"], 120)
        self.assertEqual(saved["metadata"]["colorTransfer"], "smpte2084")

    def test_explicit_invalid_visibility_is_private_even_with_public_legacy_index(self):
        for visibility in (None, "PUBLIC", False, "bad"):
            with self.subTest(visibility=visibility):
                self.cloud({**self.metadata, "visibility": visibility}, [{"id": "video-a", "visibility": "public"}])
                self.assertEqual(self.view(remote=True)["metadata"]["visibility"], "private")
        legacy = dict(self.metadata)
        del legacy["visibility"]
        self.cloud(legacy, [{"id": "video-a", "visibility": "public"}])
        self.assertEqual(self.view(remote=True)["metadata"]["visibility"], "public")

    def test_explicit_refresh_includes_uploaded_only_private_and_unlisted(self):
        self.cloud()
        self.b2.store("private-b/metadata.json", {**self.metadata, "id": "private-b", "visibility": "private"})
        self.b2.store("unlisted-c/metadata.json", {**self.metadata, "id": "unlisted-c", "visibility": "unlisted"})
        self.b2.store("video-a/.editor-state.json", {"not": "catalogued"})
        videos = self.library.list_videos(refresh_remote=True)
        self.assertEqual({video["id"] for video in videos}, {"video-a", "private-b", "unlisted-c"})
        self.assertTrue(all(video["uploaded"] for video in videos))
        self.assertEqual(len(self.library.list_videos()), 3)

    def test_publication_requires_explicit_remote_check(self):
        with self.assertRaises(VideoConflictError):
            self.save({"title": "Draft"}, publish=True)
        self.assertEqual(self.view()["metadata"]["title"], "Draft")
        self.assertTrue(self.view()["pending"])
        self.assertEqual(self.client_calls, 0)

    def test_offline_draft_cannot_silently_replace_unreviewed_live_details(self):
        self.save({"title": "Offline edit"})
        self.cloud({**self.metadata, "title": "Other online change"})
        self.assertTrue(self.view(remote=True)["remoteChanged"])
        with self.assertRaises(VideoConflictError):
            self.save(publish=True)
        self.assertFalse(self.b2.puts)
        live = self.library.discard_draft("video-a", self.view()["revision"])
        self.assertEqual(live["metadata"]["title"], "Other online change")
        self.assertFalse(live["pending"])

    def test_offline_edit_can_publish_when_cloud_descriptive_baseline_is_unchanged(self):
        self.save({"title": "Offline edit"})
        self.cloud({**self.metadata, "width": 1920, "colorTransfer": "bt709"})
        self.assertFalse(self.view(remote=True)["remoteChanged"])
        saved = self.save(publish=True)
        self.assertFalse(saved["pending"])
        self.assertEqual(saved["metadata"]["title"], "Offline edit")
        self.assertEqual(saved["metadata"]["width"], 1920)
        self.assertEqual(saved["metadata"]["colorTransfer"], "bt709")

    def test_remote_changes_reject_publication_without_any_cloud_write(self):
        self.cloud()
        self.view(remote=True)
        self.save({"title": "Draft"})
        self.b2.store("video-a/metadata.json", {**self.metadata, "title": "Online won first"})
        self.assertTrue(self.view(remote=True)["remoteChanged"])
        with self.assertRaises(VideoConflictError):
            self.save(publish=True)
        self.assertFalse(self.b2.puts)

    def block_next_metadata_read(self):
        entered, release = Event(), Event()
        original = self.b2.get_object

        def delayed(**kwargs):
            response = original(**kwargs)
            if kwargs["Key"] == "video-a/metadata.json" and not entered.is_set():
                entered.set()
                if not release.wait(5):
                    raise AssertionError("Fixture metadata read was not released")
            return response

        self.b2.get_object = delayed
        return entered, release

    def test_slow_cloud_refresh_allows_local_reads_and_saves_and_preserves_the_new_draft(self):
        self.cloud({**self.metadata, "title": "Different live title"})
        entered, release = self.block_next_metadata_read()
        with ThreadPoolExecutor(max_workers=2) as pool:
            refresh = pool.submit(self.view, True)
            try:
                self.assertTrue(entered.wait(1))
                local = pool.submit(self.view).result(timeout=1)
                self.assertEqual(local["metadata"]["title"], "Original")
                self.assertEqual(len(pool.submit(self.library.list_videos).result(timeout=1)), 1)
                draft = pool.submit(self.library.save_video, "video-a", {"title": "Typed during refresh"}, local["revision"]).result(timeout=1)
                self.assertTrue(draft["pending"])
            finally:
                release.set()
            result = refresh.result(timeout=2)
        self.assertEqual(result["metadata"]["title"], "Typed during refresh")
        self.assertEqual(result["revision"], draft["revision"])
        self.assertTrue(result["pending"])
        self.assertFalse(result["remoteChanged"])
        self.assertFalse(result["remoteChecked"])
        following = self.library.save_video("video-a", {"description": "Immediate next save"}, draft["revision"])
        self.assertEqual(following["metadata"]["description"], "Immediate next save")
        # A new, deliberately requested check may still compare this pending
        # draft against the live version and report the actual conflict.
        self.assertTrue(self.view(remote=True)["remoteChanged"])
        self.assertFalse(self.b2.puts)

    def test_refresh_started_before_thumbnail_save_keeps_its_revision_valid_for_next_save(self):
        from PIL import Image
        image = io.BytesIO()
        Image.new("RGB", (16, 12), "yellow").save(image, format="PNG")
        self.cloud()
        entered, release = self.block_next_metadata_read()
        with ThreadPoolExecutor(max_workers=2) as pool:
            refresh = pool.submit(self.view, True)
            try:
                self.assertTrue(entered.wait(1))
                local = pool.submit(self.view).result(timeout=1)
                draft = pool.submit(self.library.replace_thumbnail, "video-a", image.getvalue(), "frame.png", local["revision"]).result(timeout=2)
                self.assertTrue(draft["pending"])
            finally:
                release.set()
            result = refresh.result(timeout=2)
        self.assertEqual(result["revision"], draft["revision"])
        self.assertEqual(result["pendingThumbnails"], list(THUMBNAILS))
        self.assertFalse(result["remoteChecked"])
        following = self.library.save_video("video-a", {"description": "Saved after thumbnail"}, draft["revision"])
        self.assertEqual(following["metadata"]["description"], "Saved after thumbnail")
        self.assertEqual(following["pendingThumbnails"], list(THUMBNAILS))
        self.assertFalse(self.b2.puts)

    def test_older_refresh_cannot_replace_a_newer_refresh_result(self):
        self.cloud()
        entered, release = self.block_next_metadata_read()
        with ThreadPoolExecutor(max_workers=2) as pool:
            old_refresh = pool.submit(self.view, True)
            try:
                self.assertTrue(entered.wait(1))
                self.b2.store("video-a/metadata.json", {**self.metadata, "title": "Newest live title"})
                latest = pool.submit(self.view, True).result(timeout=1)
                self.assertEqual(latest["metadata"]["title"], "Newest live title")
            finally:
                release.set()
            old_result = old_refresh.result(timeout=2)
        self.assertEqual(old_result["revision"], latest["revision"])
        self.assertEqual(self.view()["metadata"]["title"], "Newest live title")
        self.assertFalse(self.b2.puts)

    def test_refresh_started_before_publish_cannot_undo_the_published_baseline(self):
        self.cloud()
        self.view(remote=True)
        entered, release = self.block_next_metadata_read()
        with ThreadPoolExecutor(max_workers=2) as pool:
            old_refresh = pool.submit(self.view, True)
            try:
                self.assertTrue(entered.wait(1))
                published = pool.submit(self.save, {"title": "Published during refresh"}, True).result(timeout=1)
                self.assertFalse(published["pending"])
            finally:
                release.set()
            result = old_refresh.result(timeout=2)
        self.assertEqual(result["revision"], published["revision"])
        self.assertEqual(result["metadata"]["title"], "Published during refresh")
        self.assertFalse(result["remoteChanged"])
        self.assertEqual(self.b2.puts, ["video-a/metadata.json", "index.json"])

    def test_slow_cloud_catalog_listing_does_not_block_the_local_library(self):
        self.cloud()
        entered, release = Event(), Event()
        original = self.b2.paginate

        def delayed(**kwargs):
            entered.set()
            if not release.wait(5):
                raise AssertionError("Fixture catalog read was not released")
            yield from original(**kwargs)

        self.b2.paginate = delayed
        with ThreadPoolExecutor(max_workers=2) as pool:
            cloud_list = pool.submit(self.library.list_videos, True)
            try:
                self.assertTrue(entered.wait(1))
                self.assertEqual(len(pool.submit(self.library.list_videos).result(timeout=1)), 1)
                self.assertEqual(pool.submit(self.view).result(timeout=1)["metadata"]["title"], "Original")
            finally:
                release.set()
            self.assertEqual(len(cloud_list.result(timeout=2)), 1)

    def test_slow_origin_asset_headers_do_not_block_local_metadata_reads(self):
        self.cloud()
        self.view(remote=True)
        self.b2.objects["video-a/AV1/init_0.mp4"] = b"unchanged-video"
        entered, release = Event(), Event()
        original = self.b2.get_object

        def delayed(**kwargs):
            if kwargs["Key"] == "video-a/AV1/init_0.mp4":
                entered.set()
                if not release.wait(5):
                    raise AssertionError("Fixture asset headers were not released")
            return original(**kwargs)

        self.b2.get_object = delayed
        with ThreadPoolExecutor(max_workers=2) as pool:
            asset = pool.submit(self.library.remote_asset, "video-a", "AV1/init_0.mp4")
            try:
                self.assertTrue(entered.wait(1))
                self.assertEqual(pool.submit(self.view).result(timeout=1)["metadata"]["title"], "Original")
            finally:
                release.set()
            response = asset.result(timeout=2)
        self.assertEqual(response["Body"].read(), b"unchanged-video")
        response["Body"].close()

    def test_remote_legacy_index_tag_change_also_conflicts(self):
        self.cloud(index=[{"id": "video-a", "tags": ["before"]}])
        self.view(remote=True)
        self.b2.store("index.json", [{"id": "video-a", "tags": ["after"]}])
        with self.assertRaises(VideoConflictError):
            self.save({"title": "Local"}, publish=True)
        self.assertFalse(self.b2.puts)
        conflict = self.view()
        self.assertTrue(conflict["remoteChanged"])
        self.assertTrue(conflict["pending"])
        self.assertEqual(conflict["metadata"]["title"], "Local")
        reloaded = self.library.discard_draft("video-a", conflict["revision"])
        self.assertFalse(reloaded["remoteChanged"])
        self.assertEqual(reloaded["metadata"]["tags"], ["after"])

    def test_publication_merges_cloud_catalog_and_preserves_previous_versions(self):
        other = {"id": "unrelated", "title": "Keep", "visibility": "public", "tags": ["existing"]}
        self.cloud(index=[other])
        old_metadata = self.b2.objects["video-a/metadata.json"]
        self.view(remote=True)
        # Another upload appears after this editor was opened.
        second = {"id": "just-uploaded", "title": "Also keep", "visibility": "public"}
        self.b2.store("index.json", [other, second])
        saved = self.save({"title": "Published", "visibility": "public"}, publish=True)
        catalog = json.loads(self.b2.objects["index.json"])
        self.assertEqual({entry["id"] for entry in catalog}, {"video-a", "unrelated", "just-uploaded"})
        self.assertEqual(catalog[1], other)
        self.assertEqual(self.b2.versions["video-a/metadata.json"], [old_metadata])
        self.assertFalse(saved["pending"])
        self.assertEqual(self.b2.puts, ["video-a/metadata.json", "index.json"])

    def test_existing_publish_never_overwrites_cloud_technical_fields_with_local_values(self):
        self.cloud({**self.metadata, "width": 1920, "height": 1080, "colorTransfer": "bt709"})
        self.view(remote=True)
        self.save({"title": "Draft"})
        # Simulate local encode metadata changing while the descriptive draft
        # remains. The editor cannot use it to rewrite live technical values.
        local = json.loads((self.folder / "metadata.json").read_bytes())
        self.write_local({**local, "frameRate": 60, "width": 999, "colorTransfer": "wrong"})
        self.save(publish=True)
        published = json.loads(self.b2.objects["video-a/metadata.json"])
        self.assertEqual(published["frameRate"], 120)
        self.assertEqual(published["width"], 1920)
        self.assertEqual(published["colorTransfer"], "bt709")
        self.assertEqual(self.view()["metadata"]["width"], 1920)

    def test_register_encode_preserves_existing_catalog_and_rejects_duplicate_id(self):
        metadata = {**self.metadata, "id": "new-encode", "title": "New"}
        entry = {**metadata, "tags": ["new-tag"]}
        view = self.library.store_encoded_video("new-encode", metadata, entry)
        self.assertTrue(view["pending"])
        self.assertEqual(view["metadata"]["tags"], ["new-tag"])
        self.assertEqual(len(self.library.list_videos()), 2)
        before = (self.local / "new-encode" / "metadata.json").read_bytes()
        with self.assertRaises(VideoConflictError):
            self.library.store_encoded_video("new-encode", {**metadata, "title": "Duplicate"}, entry)
        self.assertEqual((self.local / "new-encode" / "metadata.json").read_bytes(), before)
        backups = list((self.project / ".agent-trash").glob("*/web/local/index.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(json.loads(backups[0].read_bytes())[0]["id"], "video-a")

    def test_register_encode_rejects_below_120_fps_without_writes_or_relabelling(self):
        metadata = {**self.metadata, "id": "new-encode", "frameRate": 60}
        old_index = (self.local / "index.json").read_bytes()
        with self.assertRaises(VideoLibraryError):
            self.library.store_encoded_video("new-encode", metadata, metadata)
        self.assertFalse((self.local / "new-encode").exists())
        self.assertEqual((self.local / "index.json").read_bytes(), old_index)
        self.assertEqual(metadata["frameRate"], 60)

    def test_completed_upload_is_acknowledged_only_after_reading_matching_metadata_and_index(self):
        metadata = {**self.metadata, "tags": ["old-tag"], "hdr": True, "visibility": "public"}
        self.write_local(metadata)
        self.write_index([metadata])
        self.cloud(metadata, [metadata])
        state = {"pending": True, "pendingThumbnails": list(THUMBNAILS)}
        self.library._save_state("video-a", state)
        view = self.library.mark_uploaded("video-a")
        self.assertFalse(view["pending"])
        self.assertTrue(view["uploaded"])
        self.assertEqual(view["pendingThumbnails"], [])
        self.assertFalse(self.b2.puts)

    def test_mismatching_uploaded_metadata_or_public_index_keeps_draft_pending(self):
        metadata = {**self.metadata, "tags": ["old-tag"], "hdr": True, "visibility": "public"}
        self.write_local(metadata)
        self.write_index([metadata])
        self.cloud(metadata, [{**metadata, "title": "Different index title"}])
        with self.assertRaises(VideoConflictError):
            self.library.mark_uploaded("video-a")
        self.assertTrue(self.view()["pending"])
        self.assertFalse(self.b2.puts)

    def test_archiving_verified_transcodes_is_recoverable_and_keeps_metadata_and_thumbnails(self):
        metadata = {**self.metadata, "tags": ["old-tag"], "hdr": True}
        self.write_local(metadata)
        self.cloud(metadata)
        self.library.mark_uploaded("video-a")
        codec = self.folder / "AV1"
        codec.mkdir()
        (codec / "manifest.mpd").write_bytes(b"generated-manifest")
        (codec / "chunk_0_1.fmp4").write_bytes(b"generated-120fps-media")
        (self.folder / "thumbnail_sdr.webp").write_bytes(b"keep-still")
        destinations = self.library.archive_encoded_media("video-a", ["AV1"])
        self.assertFalse(codec.exists())
        self.assertEqual(len(destinations), 1)
        archived = self.project / destinations[0]
        self.assertEqual((archived / "chunk_0_1.fmp4").read_bytes(), b"generated-120fps-media")
        self.assertTrue(list((self.project / ".agent-trash").glob("*archive-encoded-media*/manifest.txt")))
        self.assertTrue((self.folder / "metadata.json").is_file())
        self.assertEqual((self.folder / "thumbnail_sdr.webp").read_bytes(), b"keep-still")

    def test_archiving_requires_verified_upload_and_rejects_other_files_before_any_move(self):
        codec = self.folder / "AV1"
        codec.mkdir()
        (codec / "manifest.mpd").write_bytes(b"generated-manifest")
        with self.assertRaises(VideoConflictError):
            self.library.archive_encoded_media("video-a", ["AV1"])
        self.library._save_state("video-a", {"uploaded": True, "remoteChecked": True, "pending": False})
        (codec / "my-notes.txt").write_bytes(b"preserve-user-file")
        with self.assertRaises(VideoLibraryError):
            self.library.archive_encoded_media("video-a", ["AV1"])
        self.assertTrue((codec / "manifest.mpd").is_file())
        self.assertEqual((codec / "my-notes.txt").read_bytes(), b"preserve-user-file")
        with self.assertRaises(VideoLibraryError):
            self.library.archive_encoded_media("video-a", ["../other"])

    def test_private_metadata_closes_gate_before_thumbnail_and_catalog_writes(self):
        self.cloud({**self.metadata, "visibility": "public"}, [{**self.metadata, "visibility": "public"}])
        self.view(remote=True)
        (self.folder / "thumbnail_sdr.webp").write_bytes(b"generated-still")
        state = self.library._state("video-a")
        state["pendingThumbnails"] = ["thumbnail_sdr.webp"]
        self.library._save_state("video-a", state)
        self.save({"visibility": "private"}, publish=True)
        self.assertEqual(self.b2.puts, ["video-a/metadata.json", "video-a/thumbnail_sdr.webp", "index.json"])
        self.assertEqual(json.loads(self.b2.objects["index.json"]), [])

    def test_pending_metadata_keeps_remote_media_and_marks_only_edited_thumbnail_files(self):
        self.cloud()
        self.view(remote=True)
        view = self.save({"title": "Local descriptive draft"})
        self.assertTrue(view["preferRemoteAssets"])
        self.assertEqual(view["pendingThumbnails"], [])
        state = self.library._state("video-a")
        state["pendingThumbnails"] = ["thumbnail_sdr.webp"]
        self.library._save_state("video-a", state)
        self.assertEqual(self.view()["pendingThumbnails"], ["thumbnail_sdr.webp"])

    def test_metadata_cdn_size_limit_is_checked_before_any_cloud_write(self):
        self.cloud({**self.metadata, "technicalExtra": "x" * 108_000})
        self.view(remote=True)
        with self.assertRaisesRegex(VideoLibraryError, "too large"):
            self.save({"description": "x" * 20_000}, publish=True)
        self.assertFalse(self.b2.puts)

    def almost_full_catalog(self):
        other = {"id": "other", "title": "Keep", "visibility": "public", "padding": ""}
        other["padding"] = "x" * (MODULE["CATALOG_LIMIT"] - len(MODULE["_json_bytes"]([other])) - 100)
        return [other]

    def test_catalog_cdn_size_limit_is_checked_before_any_cloud_write(self):
        self.cloud(index=self.almost_full_catalog())
        self.view(remote=True)
        with self.assertRaisesRegex(VideoLibraryError, "too large"):
            self.save({"visibility": "public"}, publish=True)
        self.assertFalse(self.b2.puts)

    def test_final_catalog_merge_checks_limit_again_after_other_upload(self):
        self.cloud()
        self.view(remote=True)
        put = self.b2.put_object

        def concurrent_upload(**kwargs):
            put(**kwargs)
            if kwargs["Key"] == "video-a/metadata.json":
                self.b2.store("index.json", self.almost_full_catalog())

        self.b2.put_object = concurrent_upload
        with self.assertRaisesRegex(VideoLibraryError, "too large"):
            self.save({"visibility": "public"}, publish=True)
        self.assertEqual(self.b2.puts, ["video-a/metadata.json"])
        self.assertEqual(json.loads(self.b2.objects["index.json"])[0]["id"], "other")
        self.assertTrue(self.view()["pending"])

    def test_same_video_catalog_change_during_publish_is_preserved_and_marked_conflicting(self):
        self.cloud()
        self.view(remote=True)
        put = self.b2.put_object
        concurrent_entry = {"id": "video-a", "title": "Concurrent catalog edit", "tags": ["new"]}

        def concurrent_catalog_edit(**kwargs):
            put(**kwargs)
            if kwargs["Key"] == "video-a/metadata.json":
                self.b2.store("index.json", [concurrent_entry])

        self.b2.put_object = concurrent_catalog_edit
        with self.assertRaises(VideoConflictError):
            self.save({"title": "Local", "visibility": "public"}, publish=True)
        self.assertEqual(self.b2.puts, ["video-a/metadata.json"])
        self.assertEqual(json.loads(self.b2.objects["index.json"]), [concurrent_entry])
        self.assertTrue(self.view()["remoteChanged"])
        self.assertTrue(self.view()["pending"])

    def test_failed_catalog_write_keeps_draft_and_can_be_retried(self):
        self.cloud()
        self.view(remote=True)
        self.b2.fail_key = "index.json"
        with self.assertRaises(VideoLibraryError):
            self.save({"title": "Changed", "visibility": "public"}, publish=True)
        self.assertTrue(self.view()["pending"])
        self.b2.fail_key = None
        self.assertFalse(self.save(publish=True)["pending"])

    def test_failed_thumbnail_after_privacy_change_can_be_retried(self):
        self.cloud({**self.metadata, "visibility": "public"})
        self.view(remote=True)
        (self.folder / "thumbnail_sdr.webp").write_bytes(b"generated-still")
        state = self.library._state("video-a")
        state["pendingThumbnails"] = ["thumbnail_sdr.webp"]
        self.library._save_state("video-a", state)
        self.b2.fail_key = "video-a/thumbnail_sdr.webp"
        with self.assertRaises(VideoLibraryError):
            self.save({"visibility": "private"}, publish=True)
        self.assertEqual(json.loads(self.b2.objects["video-a/metadata.json"])["visibility"], "private")
        self.b2.fail_key = None
        self.assertFalse(self.save(publish=True)["pending"])

    def test_new_publish_uploads_allowed_media_before_metadata_and_rejects_non_120(self):
        self.b2.store("index.json", [])
        self.view(remote=True)
        codec = self.folder / "AV1"
        codec.mkdir()
        (codec / "manifest.mpd").write_bytes(b'<MPD frameRate="120/1"/>')
        (codec / "init_0.mp4").write_bytes(b"120fps-init")
        (codec / "chunk_0_00001.fmp4").write_bytes(b"120fps-chunk")
        (codec / "personal.txt").write_bytes(b"never-upload")
        self.save({"visibility": "unlisted"}, publish=True)
        self.assertNotIn("video-a/AV1/personal.txt", self.b2.puts)
        self.assertLess(self.b2.puts.index("video-a/AV1/manifest.mpd"), self.b2.puts.index("video-a/metadata.json"))
        self.assertEqual(json.loads(self.b2.objects["video-a/metadata.json"])["frameRate"], 120)

    def test_new_non_120_video_is_not_published_or_relabelled(self):
        self.write_local({**self.metadata, "frameRate": 60})
        self.b2.store("index.json", [])
        self.view(remote=True)
        with self.assertRaisesRegex(VideoLibraryError, "120 fps"):
            self.save({"visibility": "public"}, publish=True)
        self.assertEqual(self.view()["metadata"]["frameRate"], 60)
        self.assertFalse(self.b2.puts)

    def test_thumbnail_replacement_generates_all_variants_and_preserves_old_files(self):
        from PIL import Image
        output = io.BytesIO()
        Image.new("RGB", (48, 32), "yellow").save(output, format="PNG")
        previous = b"old-thumbnail"
        (self.folder / "thumbnail_sdr.webp").write_bytes(previous)
        view = self.library.replace_thumbnail("video-a", output.getvalue(), "picture.png", self.view()["revision"])
        self.assertTrue(view["pending"])
        self.assertEqual(view["metadata"]["frameRate"], 120)
        for name in THUMBNAILS:
            with Image.open(self.folder / name) as image:
                self.assertEqual(image.size, (48, 32))
        old = list((self.project / ".agent-trash").glob("*/web/local/video-a/thumbnail_sdr.webp"))
        self.assertEqual(old[0].read_bytes(), previous)

    def test_bad_thumbnail_keeps_current_picture_and_metadata(self):
        (self.folder / "thumbnail_sdr.webp").write_bytes(b"old")
        previous = (self.folder / "metadata.json").read_bytes()
        with self.assertRaises(VideoLibraryError):
            self.library.replace_thumbnail("video-a", b"not an image", "bad.png", self.view()["revision"])
        self.assertEqual((self.folder / "thumbnail_sdr.webp").read_bytes(), b"old")
        self.assertEqual((self.folder / "metadata.json").read_bytes(), previous)

    def test_remote_preview_requires_explicit_refresh_and_preserves_byte_range(self):
        with self.assertRaises(VideoLibraryError):
            self.library.remote_asset("video-a", "AV1/init_0.mp4")
        self.assertEqual(self.client_calls, 0)
        self.cloud()
        self.b2.objects["video-a/AV1/init_0.mp4"] = b"unchanged-video-bytes"
        self.view(remote=True)
        response = self.library.remote_asset("video-a", "AV1/init_0.mp4", "bytes=0-19")
        self.assertEqual(response["Body"].read(), b"unchanged-video-bytes")
        self.assertEqual(response["RequestedRange"], "bytes=0-19")
        response["Body"].close()
        for relative, range_header in ((".editor-state.json", None), ("../index.json", None), ("AV1/init_0.mp4", "bytes=0-5,9-10")):
            with self.assertRaises(VideoLibraryError):
                self.library.remote_asset("video-a", relative, range_header)

    def test_reload_preserves_pending_thumbnail_draft_and_returns_remote_preview(self):
        self.cloud()
        self.view(remote=True)
        (self.folder / "thumbnail_sdr.webp").write_bytes(b"draft-picture")
        state = self.library._state("video-a")
        state.update(pending=True, pendingThumbnails=["thumbnail_sdr.webp"])
        self.library._save_state("video-a", state)
        view = self.library.discard_draft("video-a", self.view()["revision"])
        self.assertFalse(view["pending"])
        self.assertTrue(view["preferRemoteAssets"])
        self.assertFalse((self.folder / "thumbnail_sdr.webp").exists())
        archived = list((self.project / ".agent-trash").glob("*/web/local/video-a/thumbnail_sdr.webp"))
        self.assertEqual(archived[0].read_bytes(), b"draft-picture")

    def test_preview_allowlist_rejects_paths_state_files_and_unrelated_files(self):
        for relative in ("../index.json", ".editor-state.json", "AV1/../../../secret.txt", "AV1/personal.txt", "thumbnail_sdr.webp?x=1", "AV1\\manifest.mpd"):
            with self.subTest(relative=relative), self.assertRaises(VideoLibraryError):
                self.library.local_asset_path("video-a", relative)
        for video_id in ("../other", "a/b", ".", "x%2f", ""):
            with self.subTest(video_id=video_id), self.assertRaises(VideoLibraryError):
                self.library.get_video(video_id)

    def test_linked_folder_is_rejected_before_reading_target(self):
        target = self.project / "generated-target"
        target.mkdir()
        linked = self.local / "linked"
        try:
            linked.symlink_to(target, target_is_directory=True)
        except OSError:
            self.skipTest("Creating symlinks needs privileges on this Windows host")
        with self.assertRaises(VideoLibraryError):
            self.library.get_video("linked")

    def test_oversized_or_malformed_json_is_not_replaced(self):
        (self.local / "index.json").write_bytes(b"not-json")
        previous = (self.folder / "metadata.json").read_bytes()
        with self.assertRaises(VideoLibraryError):
            self.library.get_video("video-a")
        self.assertEqual((self.folder / "metadata.json").read_bytes(), previous)


if __name__ == "__main__":
    unittest.main()
