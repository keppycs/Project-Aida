"""Exercise local share metadata synchronization without credentials or B2."""

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


class ShareMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="share-metadata-test-", dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.local_dir = Path(self.temp.name)
        config = types.ModuleType("config")
        config.ROOT = self.local_dir
        config.LOCAL_DIR = self.local_dir
        config.INDEX_PATH = self.local_dir / "index.json"
        config.get_b2_credentials = lambda: self.fail("Credentials must not be read")
        config.normalize_visibility = lambda entry: entry.get("visibility", "public")
        upload = types.ModuleType("upload")
        for name in ("make_b2_client", "replace_file", "upload_index"):
            setattr(upload, name, lambda *args, **kwargs: self.fail("B2 must not be called"))
        with patch.dict(sys.modules, {"config": config, "upload": upload}):
            self.sync = runpy.run_path(str(ROOT / "src" / "sync_catalog.py"))
        self.log = logging.getLogger("share-metadata-test")
        self.entry = {
            "id": "test-video",
            "title": "Example video",
            "visibility": "public",
            "createdAt": 123,
        }
        self.meta_path = self.local_dir / self.entry["id"] / "metadata.json"
        self.meta_path.parent.mkdir()

    def write_metadata(self, **extra):
        metadata = {**self.entry, "frameRate": 120, **extra}
        self.meta_path.write_text(json.dumps(metadata), encoding="utf-8")

    def read_metadata(self):
        return json.loads(self.meta_path.read_text(encoding="utf-8"))

    def synchronize(self, *, apply=True):
        return self.sync["sync_metadata"](self.entry, apply=apply, log=self.log)

    def test_description_is_copied_to_public_and_unlisted_metadata(self):
        for visibility in ("public", "unlisted"):
            with self.subTest(visibility=visibility):
                self.entry["visibility"] = visibility
                self.write_metadata()
                self.entry["description"] = "A video description with <markup> & Unicode: café"
                self.assertEqual(self.synchronize(), self.meta_path)
                metadata = self.read_metadata()
                self.assertEqual(metadata["description"], self.entry["description"])
                self.assertEqual(metadata["frameRate"], 120)
                del self.entry["description"]

    def test_absent_catalogue_description_preserves_existing_metadata(self):
        self.write_metadata(description="Existing description", title="Old title")
        self.assertEqual(self.synchronize(), self.meta_path)
        metadata = self.read_metadata()
        self.assertEqual(metadata["description"], "Existing description")
        self.assertEqual(metadata["title"], self.entry["title"])

    def test_explicit_empty_description_clears_existing_value(self):
        self.write_metadata(description="Existing description")
        self.entry["description"] = ""
        self.assertEqual(self.synchronize(), self.meta_path)
        self.assertEqual(self.read_metadata()["description"], "")

    def test_applied_sync_preserves_previous_metadata_with_manifest(self):
        self.write_metadata(description="Original description")
        previous = self.meta_path.read_bytes()
        self.entry["description"] = "New description"
        self.synchronize()
        backups = list((self.local_dir / ".agent-trash").glob("*/test-video/metadata.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), previous)
        self.assertIn("test-video/metadata.json", (backups[0].parents[1] / "manifest.txt").read_text())

    def test_dry_run_does_not_change_metadata(self):
        self.write_metadata(description="Existing description")
        before = self.meta_path.read_bytes()
        self.entry["description"] = "Updated description"
        self.assertEqual(self.synchronize(apply=False), self.meta_path)
        self.assertEqual(self.meta_path.read_bytes(), before)

    def test_unchanged_description_does_not_write_metadata(self):
        self.write_metadata(description="Same description")
        self.entry["description"] = "Same description"
        self.assertIsNone(self.synchronize())


if __name__ == "__main__":
    unittest.main()
