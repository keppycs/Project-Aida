"""Master tags use only synthetic project-local catalogues and in-memory storage."""

import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).absolute().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from tags import (hydrate_video_tags, legacy_tag_id, normalize_registry,
                  normalize_tag, registry_from_videos, update_registry)
from video_library import VideoConflictError, VideoLibrary, VideoLibraryError
from admin_client import AdminClientError


class TagRulesTests(unittest.TestCase):
    def test_normalization_preserves_sequels_and_meaningful_symbols(self):
        self.assertEqual(normalize_tag("  Counter—Strike_2  "), "counter strike 2")
        self.assertEqual(normalize_tag("F.E.A.R."), "fear")
        self.assertEqual(normalize_tag("Clancy’s: (Game!)"), "clancys game")
        self.assertEqual(normalize_tag("C++ / C# 2"), "c++ c# 2")
        self.assertEqual(legacy_tag_id("Counter-Strike 2"), legacy_tag_id("counter strike 2"))

    def test_registry_derives_legacy_choices_and_persistent_alias_resolution(self):
        source = [{"tags": ["Counter-Strike 2", "counter strike 2"]}]
        registry = registry_from_videos(source)
        self.assertEqual(len(registry["tags"]), 1)
        identity = registry["tags"][0]["id"]
        registry = update_registry(registry, tag={"id": identity, "name": "Counter-Strike 2", "aliases": ["CS2"]})
        self.assertEqual(hydrate_video_tags({"tags": ["cs2"]}, registry)["tagIds"], [identity])
        registry = update_registry(registry, tag={"id": identity, "name": "CS Two", "aliases": ["CS2"]})
        self.assertEqual(hydrate_video_tags(source[0], registry)["tags"], ["CS Two"])

    def test_master_ids_are_authoritative_and_merges_keep_old_assignments(self):
        registry = normalize_registry({"version": 1, "tags": [
            {"id": "one", "name": "One", "aliases": []},
            {"id": "two", "name": "Two", "aliases": ["Second"]}], "redirects": {}})
        self.assertEqual(hydrate_video_tags({"tags": ["One"], "tagIds": []}, registry)["tags"], [])
        registry = update_registry(registry, merge={"source": "two", "target": "one"})
        video = hydrate_video_tags({"tagIds": ["two"], "tags": ["Stale"]}, registry)
        self.assertEqual(video["tagIds"], ["one"])
        self.assertEqual(video["tags"], ["One"])
        self.assertIn("Second", video["tagDefinitions"][0]["aliases"])
        self.assertEqual(registry_from_videos([{"tagIds": [], "tags": ["Stale"]}], registry), registry)

    def test_alias_collisions_and_invalid_redirects_fail(self):
        registry = registry_from_videos([{"tags": ["First", "Second"]}])
        with self.assertRaisesRegex(ValueError, "already used"):
            update_registry(registry, tag={"id": registry["tags"][0]["id"], "name": "First", "aliases": ["second"]})
        with self.assertRaises(ValueError):
            normalize_registry({"version": 1, "tags": [], "redirects": {"a": "b", "b": "a"}})

    def test_unindexed_legacy_name_can_be_renamed_when_original_identity_is_retained(self):
        identity = legacy_tag_id("Original private tag")
        registry = update_registry(normalize_registry(), tag={"id": identity, "name": "Renamed tag", "aliases": ["Original private tag"]})
        self.assertEqual(hydrate_video_tags({"tags": ["Original private tag"]}, registry)["tagIds"], [identity])
        registry["tags"][0]["aliases"] = []
        self.assertEqual(hydrate_video_tags({"tags": ["Original private tag"]}, registry)["tags"], ["Renamed tag"])

    def test_renamed_and_merged_legacy_assignments_survive_old_name_or_alias_reuse(self):
        identity = legacy_tag_id("Original")
        for merged in (False, True):
            for alias in (False, True):
                with self.subTest(merged=merged, alias=alias):
                    destination = "canonical" if merged else identity
                    reused = {"id": "new-distinct-tag", "name": "Other tag" if alias else "Original",
                              "aliases": ["Original"] if alias else []}
                    registry = {"version": 1, "tags": [
                        {"id": destination, "name": "Current name", "aliases": []}, reused],
                        "redirects": {identity: "middle", "middle": destination} if merged else {}}
                    video = hydrate_video_tags({"tags": ["Original"]}, registry)
                    self.assertEqual(video["tagIds"], [destination])
                    self.assertEqual(video["tags"], ["Current name"])
                    self.assertEqual(hydrate_video_tags({"tags": ["Original"], "tagIds": [reused["id"]]}, registry)["tagIds"], [reused["id"]])


class MemoryStorage:
    def __init__(self):
        self.objects = {}
        self.puts = []

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise FileNotFoundError(Key)
        return {"Body": io.BytesIO(json.dumps(self.objects[Key]).encode())}

    def put_object(self, Bucket, Key, Body, **kwargs):
        self.objects[Key] = json.loads(Body)
        self.puts.append(Key)


class LocalTagTests(unittest.TestCase):
    def setUp(self):
        directory = ROOT / "logs" / "tag-tests"
        directory.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=directory)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.local = self.root / "web" / "local"
        self.folder = self.local / "clip"
        self.folder.mkdir(parents=True)
        self.raw = {"id": "clip", "title": "Synthetic clip", "tags": ["Counter-Strike 2"], "visibility": "public", "frameRate": 120}
        (self.folder / "metadata.json").write_text(json.dumps(self.raw), encoding="utf-8")
        (self.local / "index.json").write_text(json.dumps([self.raw]), encoding="utf-8")
        self.storage = MemoryStorage()
        self.library = VideoLibrary(self.root, client_factory=lambda: (self.storage, "fixture"))
        direct = patch("video_library.central_client", return_value=None)
        direct.start()
        self.addCleanup(direct.stop)

    def test_global_alias_edit_keeps_video_revision_and_preserves_registry_backup(self):
        baseline = self.library.get_video("clip")["revision"]
        registry = self.library.get_tags()
        identity = registry["tags"][0]["id"]
        first = self.library.save_tags(registry["revision"], tag={"id": identity, "name": "Counter-Strike 2", "aliases": ["CS2"]})
        second = self.library.save_tags(first["revision"], tag={"id": identity, "name": "CS Two", "aliases": ["CS2"]})
        video = self.library.get_video("clip")
        self.assertEqual(video["revision"], baseline)
        self.assertEqual(video["metadata"]["tags"], ["CS Two"])
        self.assertTrue(list((self.root / ".agent-trash").rglob("tags.json")))
        with self.assertRaises(VideoConflictError):
            self.library.save_tags(first["revision"], tag={"id": identity, "name": "Old form", "aliases": []})
        self.assertEqual(second["revision"], self.library.get_tags()["revision"])

    def test_assign_and_remove_master_tags_uses_ids_and_legacy_clients_can_replace(self):
        registry = self.library.get_tags()
        identity = registry["tags"][0]["id"]
        self.library.save_tags(registry["revision"], tag={"id": identity, "name": "Counter-Strike 2", "aliases": ["CS2"]})
        video = self.library.get_video("clip")
        result = self.library.save_video("clip", {"tagIds": []}, video["revision"])
        self.assertEqual(result["metadata"]["tags"], [])
        result = self.library.save_video("clip", {"tagIds": [identity]}, result["revision"])
        self.assertEqual(result["metadata"]["tagDefinitions"][0]["aliases"], ["CS2"])
        result = self.library.save_video("clip", {"tags": []}, result["revision"])
        self.assertEqual(result["metadata"]["tagIds"], [])
        with self.assertRaises(VideoLibraryError):
            self.library.save_video("clip", {"tagIds": ["missing"]}, result["revision"])

    def test_direct_publication_keeps_global_aliases_and_detects_unknown_remote_change(self):
        registry = self.library.get_tags()
        identity = registry["tags"][0]["id"]
        self.library.save_tags(registry["revision"], tag={"id": identity, "name": "Counter-Strike 2", "aliases": ["CS2"]})
        self.storage.objects.update({"clip/metadata.json": self.raw, "index.json": [self.raw]})
        video = self.library.get_video("clip", remote=True)
        self.library.save_video("clip", {"tagIds": [identity]}, video["revision"], publish=True)
        self.assertIn("tags.json", self.storage.puts)
        self.assertEqual(self.storage.objects["index.json"][0]["tagDefinitions"][0]["aliases"], ["CS2"])
        registry = self.library.get_tags()
        self.library.save_tags(registry["revision"], tag={"id": identity, "name": "Local name", "aliases": ["CS2"]})
        self.storage.objects["tags.json"]["tags"][0]["name"] = "Changed online"
        video = self.library.get_video("clip")
        with self.assertRaises(VideoConflictError):
            self.library.save_video("clip", {}, video["revision"], publish=True)

    def test_central_registry_forwards_revision_and_does_not_fallback_to_direct(self):
        registry = self.library.get_tags()
        calls = []

        class Writer:
            url = "https://example.invalid/edit/api"

            def get_tags(self):
                calls.append("read")
                return {**registry, "revision": "central-before"}

            def save_tags(self, revision, **fields):
                calls.append((revision, fields))
                changed = update_registry(registry, tag=fields["tag"])
                return {**changed, "revision": "central-after"}

        writer = Writer()
        with patch("video_library.central_client", return_value=writer):
            loaded = self.library.get_tags()
            self.assertEqual(loaded["revision"], "central-before")
            saved = self.library.save_tags("central-before", tag={"id": registry["tags"][0]["id"], "name": "Counter-Strike 2", "aliases": ["CS2"]}, operation_id="synthetic-operation")
            self.assertEqual(saved["revision"], "central-after")
            self.assertEqual(calls[-1][0], "central-before")
            self.assertEqual(calls[-1][1]["operation_id"], "synthetic-operation")
            writer.get_tags = lambda: (_ for _ in ()).throw(AdminClientError("Offline"))
            cached = self.library.get_tags()
            self.assertTrue(cached["offline"])
            self.assertEqual(cached["tags"][0]["aliases"], ["CS2"])
            writer.save_tags = lambda *args, **kwargs: (_ for _ in ()).throw(AdminClientError("Changed", 409))
            with self.assertRaises(VideoConflictError):
                self.library.save_tags("central-after", tag={"name": "Local fallback", "aliases": []})
        self.assertFalse(self.storage.puts)

    def test_explicit_legacy_metadata_tags_do_not_restore_old_catalog_ids(self):
        registry = self.library.get_tags()
        identity = registry["tags"][0]["id"]
        self.library.save_tags(registry["revision"], tag={"id": identity, "name": "Counter-Strike 2", "aliases": ["CS2"]})
        for names in ([], ["Replacement"]):
            with self.subTest(names=names):
                metadata = self.library._metadata("clip", {**self.raw, "tags": names}, {**self.raw, "tagIds": [identity], "tagDefinitions": registry["tags"]})
                self.assertEqual(metadata["tags"], names)
                self.assertNotIn(identity, metadata["tagIds"])

    def test_direct_legacy_replacement_clears_canonical_cloud_and_catalog_assignments(self):
        definition = {"id": "master-old", "name": "Original game", "aliases": []}
        original = {**self.raw, "tags": [definition["name"]], "tagIds": [definition["id"]], "tagDefinitions": [definition]}
        for names in ([], ["Replacement game"]):
            with self.subTest(names=names):
                (self.folder / "metadata.json").write_text(json.dumps(original), encoding="utf-8")
                (self.local / "index.json").write_text(json.dumps([original]), encoding="utf-8")
                self.storage.objects.update({"clip/metadata.json": original, "index.json": [original]})
                self.assertFalse((self.local / "tags.json").exists())
                current = self.library.get_video("clip", remote=True)
                saved = self.library.save_video("clip", {"tags": names}, current["revision"], publish=True)
                self.assertEqual(saved["metadata"]["tags"], names)
                for item in (self.storage.objects["clip/metadata.json"], self.storage.objects["index.json"][0],
                             json.loads((self.local / "index.json").read_text(encoding="utf-8"))[0]):
                    self.assertEqual(item["tags"], names)
                    self.assertNotIn("tagIds", item)
                    self.assertNotIn("tagDefinitions", item)

    def test_direct_registry_read_accepts_catalog_sized_registry(self):
        # Larger than video metadata, within the master registry's 1 MB limit.
        registry = {"version": 1, "tags": [{"id": f"tag-{index}", "name": f"Fixture game {index}", "aliases": [f"Fixture alias {index} " + "x" * 60]}
                                            for index in range(1000)], "redirects": {}}
        self.assertGreater(len(json.dumps(registry).encode("utf-8")), 128000)
        self.storage.objects["tags.json"] = registry
        refreshed = self.library.get_tags(remote=True)
        self.assertTrue({tag["id"] for tag in registry["tags"]}.issubset({tag["id"] for tag in refreshed["tags"]}))

    def test_remote_merge_and_chained_merge_follow_unchanged_local_tags(self):
        registry = self.library.get_tags()
        source = registry["tags"][0]["id"]
        registry = self.library.save_tags(registry["revision"], tag={"name": "Target", "aliases": []})
        target = next(tag["id"] for tag in registry["tags"] if tag["name"] == "Target")
        registry = self.library.save_tags(registry["revision"], tag={"name": "Final", "aliases": []})
        final = next(tag["id"] for tag in registry["tags"] if tag["name"] == "Final")
        self.storage.objects["tags.json"] = normalize_registry(registry)
        self.library.get_tags(remote=True)
        self.storage.objects["tags.json"] = update_registry(registry, merge={"source": source, "target": target})
        refreshed = self.library.get_tags(remote=True)
        self.assertNotIn(source, {tag["id"] for tag in refreshed["tags"]})
        self.assertEqual(refreshed["redirects"][source], target)
        self.assertEqual(self.library.get_video("clip")["metadata"]["tags"], ["Target"])
        self.storage.objects["tags.json"] = update_registry(refreshed, merge={"source": target, "target": final})
        chained = self.library.get_tags(remote=True)
        self.assertEqual(chained["redirects"][source], final)
        self.assertEqual(chained["redirects"][target], final)
        self.assertEqual(self.library.get_video("clip")["metadata"]["tags"], ["Final"])

    def test_remote_merge_conflicts_with_a_real_local_alias_edit(self):
        registry = self.library.get_tags()
        source = registry["tags"][0]["id"]
        registry = self.library.save_tags(registry["revision"], tag={"name": "Target", "aliases": []})
        target = next(tag["id"] for tag in registry["tags"] if tag["name"] == "Target")
        self.storage.objects["tags.json"] = normalize_registry(registry)
        self.library.get_tags(remote=True)
        current = self.library.get_tags()
        local = self.library.save_tags(current["revision"], tag={"id": source, "name": "Counter-Strike 2", "aliases": ["Local alias"]})
        self.storage.objects["tags.json"] = update_registry(registry, merge={"source": source, "target": target})
        with self.assertRaises(VideoConflictError):
            self.library.get_tags(remote=True)
        self.assertEqual(self.library.get_tags()["revision"], local["revision"])

    def test_local_operation_receipts_replay_before_cas_and_reject_payload_reuse(self):
        registry = self.library.get_tags()
        baseline = normalize_registry(registry)
        self.library._save_tag_state(directBaseline=baseline, writerURL="https://example.invalid/edit/api", custom="keep")
        request = {"revision": registry["revision"], "tag": {"name": "New master", "aliases": ["NM"]}, "operation_id": "synthetic-retry"}
        first = self.library.save_tags(**request)
        self.assertEqual(self.library.save_tags(**request), first)
        current = self.library.save_tags(first["revision"], tag={"name": "Later edit", "aliases": []})
        self.assertEqual(self.library.save_tags(**request), first)
        self.assertEqual(self.library.get_tags()["revision"], current["revision"])
        with self.assertRaises(VideoConflictError):
            self.library.save_tags(**{**request, "tag": {"name": "Different", "aliases": []}})
        state = self.library._tag_state()
        self.assertEqual(state["directBaseline"], baseline)
        self.assertEqual(state["custom"], "keep")
        self.assertEqual(state["writerURL"], "https://example.invalid/edit/api")

    def test_pending_receipt_recovers_registry_commit_and_receipt_write_interruptions(self):
        for stage in ("registry", "receipt"):
            with self.subTest(stage=stage):
                before = self.library.get_tags()
                request = {"revision": before["revision"], "tag": {"name": f"Recovered {stage}", "aliases": []}, "operation_id": f"synthetic-{stage}"}
                write = self.library._write
                state_save = self.library._save_tag_state
                calls = 0

                def interrupted_write(path, body):
                    if stage == "registry" and path.name == "tags.json":
                        raise OSError("Synthetic registry move interruption")
                    return write(path, body)

                def interrupted_state(**updates):
                    nonlocal calls
                    calls += 1
                    if stage == "receipt" and calls == 2:
                        raise OSError("Synthetic receipt completion interruption")
                    return state_save(**updates)

                with patch.object(self.library, "_write", side_effect=interrupted_write), patch.object(self.library, "_save_tag_state", side_effect=interrupted_state):
                    with self.assertRaises(OSError):
                        self.library.save_tags(**request)
                restarted = VideoLibrary(self.root, client_factory=lambda: (self.storage, "fixture"))
                recovered = restarted.save_tags(**request)
                self.assertEqual(sum(tag["name"] == f"Recovered {stage}" for tag in recovered["tags"]), 1)
                self.assertEqual(restarted.save_tags(**request), recovered)
                self.assertFalse(next(item for item in restarted._tag_state()["receipts"] if item["operation_id"] == request["operation_id"])["pending"])
                self.library = restarted


if __name__ == "__main__":
    unittest.main()
