"""Version-preserving uploads and catalogue merges without credentials or B2."""

from io import BytesIO
import json
import logging
from pathlib import Path
import runpy
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


class MissingKey(Exception):
    response = {"Error": {"Code": "NoSuchKey"}}


class FakeB2:
    def __init__(self, objects=None):
        self.objects = {
            key: value if isinstance(value, bytes) else json.dumps(value).encode()
            for key, value in (objects or {}).items()
        }
        self.versions = {key: [value] for key, value in self.objects.items()}
        self.reads = []
        self.writes = []
        self.streams = []
        self.read_failures = {}
        self.write_failure = None
        self.write_failures = {}

    def get_object(self, *, Bucket, Key):
        self.reads.append(Key)
        if Key in self.read_failures:
            raise self.read_failures[Key]
        if Key not in self.objects:
            raise MissingKey(Key)
        stream = BytesIO(self.objects[Key])
        self.streams.append(stream)
        return {"Body": stream, "ContentLength": len(self.objects[Key])}

    def head_object(self, *, Bucket, Key):
        self.reads.append(Key)
        if Key in self.read_failures:
            raise self.read_failures[Key]
        if Key not in self.objects:
            raise MissingKey(Key)
        return {"ContentLength": len(self.objects[Key])}

    def put_object(self, *, Bucket, Key, Body, ContentType):
        if Key in self.write_failures:
            raise self.write_failures[Key]
        if self.write_failure:
            raise self.write_failure
        self.writes.append((Key, ContentType))
        self.versions.setdefault(Key, []).append(Body)
        self.objects[Key] = Body

    def upload_file(self, filename, bucket, key, *, ExtraArgs):
        self.put_object(Bucket=bucket, Key=key, Body=Path(filename).read_bytes(),
                        ContentType=ExtraArgs["ContentType"])

    def delete_object(self, **kwargs):
        raise AssertionError("Ordinary uploads must never delete old versions")

    def get_paginator(self, name):
        raise AssertionError("Catalogue uploads must not scan or delete bucket versions")


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="upload-test-", dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.index = self.work / "index.json"
        config = types.ModuleType("config")
        config.get_b2_credentials = lambda: self.fail("Credentials must not be read")
        config.normalize_visibility = lambda entry: (
            entry["visibility"] if entry.get("visibility") in ("public", "unlisted", "private")
            else "unlisted" if entry.get("unlisted") else "public"
        )
        boto3 = types.ModuleType("boto3")
        boto3.client = lambda *args, **kwargs: self.fail("Real B2 must not be called")
        botocore = types.ModuleType("botocore")
        botocore_config = types.ModuleType("botocore.config")
        botocore_config.Config = lambda **kwargs: kwargs
        with patch.dict(sys.modules, {
            "config": config, "boto3": boto3, "botocore": botocore,
            "botocore.config": botocore_config,
        }):
            self.upload = runpy.run_path(str(ROOT / "src" / "upload.py"))
        self.log = logging.getLogger("upload-test")
        self.log.addHandler(logging.NullHandler())
        self.addCleanup(self.log.handlers.pop)
        self.log.propagate = False

    def publish(self, b2, local):
        self.index.write_text(json.dumps(local), encoding="utf-8")
        self.upload["upload_index"](b2, "ProjectAida", self.index, self.log)
        return json.loads(b2.objects["index.json"])

    @staticmethod
    def entry(video_id="video", **fields):
        return {"id": video_id, "title": "Local title", "visibility": "public",
                "description": "Local description", "createdAt": 123,
                "frameRate": 120, **fields}

    def test_existing_upload_head_returns_true(self):
        b2 = FakeB2({"video/metadata.json": self.entry()})
        self.assertTrue(self.upload["is_already_uploaded"](b2, "ProjectAida", "video", self.log))
        self.assertEqual(b2.reads, ["video/metadata.json"])
        self.assertEqual(b2.writes, [])

    def test_upload_head_only_recognized_missing_key_errors_return_false(self):
        for code in ("404", "NoSuchKey", "NotFound"):
            with self.subTest(code=code):
                b2 = FakeB2()
                error = RuntimeError("Storage returned a missing key")
                error.response = {"Error": {"Code": code}}
                b2.read_failures["video/metadata.json"] = error
                self.assertFalse(self.upload["is_already_uploaded"](b2, "ProjectAida", "video", self.log))
                self.assertEqual(b2.writes, [])

    def test_upload_head_auth_network_and_unknown_errors_propagate(self):
        denied = PermissionError("Storage denied access")
        denied.response = {"Error": {"Code": "403"}}
        for error in (denied, ConnectionError("Network unavailable"), RuntimeError("404 in an unrelated error message")):
            with self.subTest(error=error):
                b2 = FakeB2()
                b2.read_failures["video/metadata.json"] = error
                with self.assertRaises(type(error)) as raised:
                    self.upload["is_already_uploaded"](b2, "ProjectAida", "video", self.log)
                self.assertIs(raised.exception, error)
                self.assertEqual(b2.writes, [])

    def test_replace_file_preserves_previous_version(self):
        path = self.work / "metadata.json"
        path.write_bytes(b"new metadata")
        b2 = FakeB2({"video/metadata.json": b"old metadata"})
        self.upload["replace_file"](b2, "ProjectAida", "video/metadata.json", path,
                                    "application/json", self.log)
        self.assertEqual(b2.versions["video/metadata.json"], [b"old metadata", b"new metadata"])
        self.assertEqual(b2.writes, [("video/metadata.json", "application/json")])

    def test_replace_object_preserves_previous_versions(self):
        b2 = FakeB2({"index.json": b"old catalogue"})
        self.upload["replace_object"](b2, "ProjectAida", "index.json", b"new catalogue",
                                      "application/json", self.log)
        self.assertEqual(b2.versions["index.json"], [b"old catalogue", b"new catalogue"])

    def test_failed_replacements_leave_previous_data_readable(self):
        path = self.work / "metadata.json"
        path.write_bytes(b"new metadata")
        for helper, body in (("replace_file", path), ("replace_object", b"new metadata")):
            with self.subTest(helper=helper):
                b2 = FakeB2({"video/metadata.json": b"old metadata"})
                b2.write_failure = RuntimeError("Upload interrupted")
                with self.assertRaisesRegex(RuntimeError, "interrupted"):
                    self.upload[helper](b2, "ProjectAida", "video/metadata.json", body,
                                        "application/json", self.log)
                self.assertEqual(b2.objects["video/metadata.json"], b"old metadata")
                self.assertEqual(b2.versions["video/metadata.json"], [b"old metadata"])

    def test_video_folder_upload_omits_local_state_and_unrelated_files(self):
        package = self.work / "video"
        codec = package / "AV1"
        codec.mkdir(parents=True)
        expected = ("metadata.json", "thumbnail_sdr.webp", "AV1/manifest.mpd",
                    "AV1/master.m3u8", "AV1/media_0.m3u8", "AV1/init_0.mp4",
                    "AV1/chunk_0_00001.fmp4")
        ignored = (".editor-state.json", "personal.txt", "source.mp4",
                   "AV1/personal.txt", "AV1/.editor-temp.tmp", "AV1/nested/manifest.mpd")
        for relative in (*expected, *ignored):
            path = package / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(f"fixture:{relative}".encode())
        b2 = FakeB2()
        result = self.upload["upload_folder"](b2, "ProjectAida", package, "video", self.log,
                                               on_progress=lambda *args: None)
        self.assertTrue(result)
        self.assertEqual(set(b2.objects), {f"video/{relative}" for relative in expected})
        self.assertEqual(b2.objects["video/AV1/init_0.mp4"], b"fixture:AV1/init_0.mp4")
        self.assertEqual(b2.writes[-1][0], "video/metadata.json")

    def test_failed_asset_upload_never_replaces_metadata(self):
        package = self.work / "video"
        codec = package / "AV1"
        codec.mkdir(parents=True)
        (package / "metadata.json").write_bytes(b"new public metadata")
        (codec / "manifest.mpd").write_bytes(b"manifest")
        (codec / "chunk_0_00001.fmp4").write_bytes(b"chunk")
        for existing in (None, b"old private metadata"):
            with self.subTest(existing=existing):
                b2 = FakeB2({"video/metadata.json": existing} if existing else {})
                b2.write_failures["video/AV1/chunk_0_00001.fmp4"] = RuntimeError("Upload interrupted")
                result = self.upload["upload_folder"](b2, "ProjectAida", package, "video", self.log,
                                                       on_progress=lambda *args: None)
                self.assertFalse(result)
                self.assertNotIn("video/metadata.json", [key for key, content_type in b2.writes])
                self.assertEqual(b2.objects.get("video/metadata.json"), existing)
                if existing:
                    self.assertEqual(b2.versions["video/metadata.json"], [existing])

    def test_video_folder_rejects_linked_assets_before_any_upload(self):
        package = self.work / "video"
        package.mkdir()
        (package / "metadata.json").write_bytes(b"fixture metadata")
        target = self.work / "generated-still.webp"
        target.write_bytes(b"fixture still")
        try:
            (package / "thumbnail_sdr.webp").symlink_to(target)
        except OSError:
            self.skipTest("Creating symlinks needs privileges on this Windows host")
        b2 = FakeB2()
        self.assertFalse(self.upload["upload_folder"](b2, "ProjectAida", package, "video", self.log))
        self.assertEqual(b2.writes, [])

    def test_empty_video_package_cannot_report_success(self):
        package = self.work / "video"
        package.mkdir()
        (package / ".editor-state.json").write_bytes(b"local state")
        b2 = FakeB2()
        self.assertFalse(self.upload["upload_folder"](b2, "ProjectAida", package, "video", self.log))
        self.assertEqual(b2.writes, [])

    def test_video_folder_rejects_windows_reparse_assets_before_any_upload(self):
        package = self.work / "video"
        package.mkdir()
        (package / "metadata.json").write_bytes(b"fixture metadata")
        linked = package / "thumbnail_sdr.webp"
        linked.write_bytes(b"fixture still")
        original_lstat = Path.lstat

        def report_reparse(path, *args, **kwargs):
            info = original_lstat(path, *args, **kwargs)
            return types.SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400) if path == linked else info

        b2 = FakeB2()
        with patch.object(Path, "lstat", report_reparse):
            self.assertFalse(self.upload["upload_folder"](b2, "ProjectAida", package, "video", self.log))
        self.assertEqual(b2.writes, [])

    def test_current_metadata_wins_and_remote_only_entries_survive(self):
        remote_only = self.entry("other", title="Uploaded elsewhere", createdAt=999, tags=["online"])
        remote = self.entry(title="Earlier online title", tags=["online tag"], hdr=True)
        b2 = FakeB2({
            "index.json": [remote_only, remote],
            "video/metadata.json": self.entry(title="Current online title", description="Online edit", id="legacy-id"),
        })
        old_index = b2.objects["index.json"]
        result = self.publish(b2, [self.entry(tags=["stale local tag"], hdr=False)])
        self.assertEqual(result[0], remote_only)
        self.assertEqual(result[1]["id"], "video")
        self.assertEqual(result[1]["title"], "Current online title")
        self.assertEqual(result[1]["description"], "Online edit")
        self.assertEqual(result[1]["tags"], ["online tag"])
        self.assertTrue(result[1]["hdr"])
        self.assertEqual(result[1]["frameRate"], 120)
        self.assertEqual(b2.reads, ["index.json", "video/metadata.json"])
        self.assertEqual(b2.versions["index.json"][0], old_index)
        self.assertTrue(all(stream.closed for stream in b2.streams))

    def test_new_upload_uses_metadata_and_local_index_only_fields(self):
        b2 = FakeB2({"index.json": [], "new/metadata.json": self.entry("new", title="Fresh upload")})
        result = self.publish(b2, [self.entry("new", title="Stale title", tags=["new tag"], hdr=True,
                                           sourcePath="must not be published")])
        self.assertEqual(result[0]["title"], "Fresh upload")
        self.assertEqual(result[0]["tags"], ["new tag"])
        self.assertTrue(result[0]["hdr"])
        self.assertNotIn("sourcePath", result[0])

    def test_private_and_unlisted_metadata_remove_stale_public_rows(self):
        for visibility in ("private", "unlisted", "unknown", None, ["public"]):
            with self.subTest(visibility=visibility):
                b2 = FakeB2({"index.json": [self.entry()],
                             "video/metadata.json": self.entry(visibility=visibility)})
                self.assertEqual(self.publish(b2, [self.entry()]), [])

    def test_missing_descriptions_and_titles_are_not_resurrected(self):
        metadata = {"visibility": "public", "frameRate": 120, "tags": []}
        b2 = FakeB2({"index.json": [self.entry(tags=["stale"])] , "video/metadata.json": metadata})
        result = self.publish(b2, [self.entry()])
        self.assertNotIn("title", result[0])
        self.assertNotIn("description", result[0])
        self.assertEqual(result[0]["tags"], [])

    def test_local_candidates_without_uploaded_metadata_are_omitted(self):
        b2 = FakeB2({"index.json": [self.entry()]})
        self.assertEqual(self.publish(b2, [self.entry(), self.entry("not-uploaded")]), [])

    def test_first_upload_can_create_an_absent_index(self):
        b2 = FakeB2({"video/metadata.json": self.entry()})
        self.assertEqual(self.publish(b2, [self.entry()])[0]["id"], "video")

    def test_legacy_public_requires_a_current_remote_public_entry(self):
        metadata = {"id": "older", "title": "Legacy video", "frameRate": 120}
        b2 = FakeB2({"index.json": [self.entry()], "video/metadata.json": metadata,
                     "new/metadata.json": metadata})
        result = self.publish(b2, [self.entry(), self.entry("new")])
        self.assertEqual([entry["id"] for entry in result], ["video"])

    def test_remote_only_private_unlisted_and_invalid_rows_are_omitted(self):
        b2 = FakeB2({"index.json": [self.entry("private", visibility="private"),
                                   self.entry("unlisted", visibility="unlisted"),
                                   self.entry("invalid", visibility="surprise"),
                                   self.entry("public")]})
        self.assertEqual([entry["id"] for entry in self.publish(b2, [])], ["public"])

    def test_remote_read_failures_abort_without_publishing(self):
        for key in ("index.json", "video/metadata.json"):
            with self.subTest(key=key):
                b2 = FakeB2({"index.json": [self.entry()], "video/metadata.json": self.entry()})
                b2.read_failures[key] = PermissionError("Denied")
                previous = b2.objects["index.json"]
                with self.assertRaisesRegex(PermissionError, "Denied"):
                    self.publish(b2, [self.entry()])
                self.assertEqual(b2.writes, [])
                self.assertEqual(b2.objects["index.json"], previous)

    def test_invalid_remote_json_never_overwrites_the_catalogue(self):
        for key, value in (("index.json", None), ("index.json", {}),
                           ("index.json", b"broken JSON"),
                           ("video/metadata.json", None),
                           ("video/metadata.json", []),
                           ("video/metadata.json", b"broken JSON")):
            with self.subTest(key=key, value=value):
                objects = {"index.json": [self.entry()], "video/metadata.json": self.entry(), key: value}
                b2 = FakeB2(objects)
                with self.assertRaises((ValueError, json.JSONDecodeError)):
                    self.publish(b2, [self.entry()])
                self.assertEqual(b2.writes, [])
                self.assertTrue(all(stream.closed for stream in b2.streams))

    def test_oversized_remote_objects_abort_before_publish(self):
        for key, limit in (("index.json", 1_000_000), ("video/metadata.json", 128_000)):
            with self.subTest(key=key):
                b2 = FakeB2({"index.json": [self.entry()], "video/metadata.json": self.entry(), key: b" " * (limit + 1)})
                with self.assertRaisesRegex(ValueError, "too large"):
                    self.publish(b2, [self.entry()])
                self.assertEqual(b2.writes, [])
                self.assertTrue(all(stream.closed for stream in b2.streams))

    def test_oversized_stream_without_declared_length_is_still_bounded(self):
        b2 = FakeB2({"index.json": b" " * 1_000_001})
        original_get = b2.get_object

        def get_without_length(**kwargs):
            response = original_get(**kwargs)
            response.pop("ContentLength")
            return response

        b2.get_object = get_without_length
        with self.assertRaisesRegex(ValueError, "too large"):
            self.publish(b2, [])
        self.assertEqual(b2.writes, [])
        self.assertTrue(all(stream.closed for stream in b2.streams))

    def test_malformed_remote_catalogue_ids_abort_without_publishing(self):
        for remote in ([self.entry("../private")], [self.entry(), self.entry()], [None]):
            with self.subTest(remote=remote):
                b2 = FakeB2({"index.json": remote})
                with self.assertRaises(ValueError):
                    self.publish(b2, [])
                self.assertEqual(b2.writes, [])

    def test_non_finite_fields_cannot_publish_invalid_json(self):
        b2 = FakeB2({"index.json": [], "video/metadata.json": self.entry(duration=float("nan"))})
        with self.assertRaises(ValueError):
            self.publish(b2, [self.entry()])
        self.assertEqual(b2.writes, [])

    def test_unsafe_and_duplicate_local_ids_are_rejected_before_remote_reads(self):
        for entries in ([self.entry("../private")], [self.entry("video/path")],
                        [self.entry("encoded%2fid")], [self.entry(), self.entry()], {}):
            with self.subTest(entries=entries):
                b2 = FakeB2()
                with self.assertRaises(ValueError):
                    self.publish(b2, entries)
                self.assertEqual(b2.reads, [])
                self.assertEqual(b2.writes, [])

    def test_failed_catalogue_write_propagates_and_keeps_prior_versions(self):
        b2 = FakeB2({"index.json": [self.entry()], "video/metadata.json": self.entry()})
        old_index = b2.objects["index.json"]
        b2.write_failure = RuntimeError("Connection lost")
        with self.assertRaisesRegex(RuntimeError, "Connection lost"):
            self.publish(b2, [self.entry()])
        self.assertEqual(b2.versions["index.json"], [old_index])


if __name__ == "__main__":
    unittest.main()
