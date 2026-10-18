"""Loopback admin mode isolation; synthetic configuration, no keyring or B2."""

import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType
import unittest
from unittest.mock import patch

ROOT = Path(__file__).absolute().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from fastapi.testclient import TestClient

# Import the route module without loading a user's optional local settings.
# Credentials themselves are lazy and are guarded independently in each test.
_previous_local_config = sys.modules.get("config_local")
sys.modules["config_local"] = ModuleType("config_local")
try:
    import admin_app
finally:
    if _previous_local_config is None:
        sys.modules.pop("config_local", None)
    else:
        sys.modules["config_local"] = _previous_local_config

from admin_client import AdminClientError, CONFIG_KEYS
from dedupe_bucket import DedupeResult
from video_library import VideoLibrary


class CentralAdminHTTPTests(unittest.TestCase):
    def setUp(self):
        artifacts = ROOT / "logs" / "central-admin-tests"
        artifacts.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="fixture-", dir=artifacts)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "web" / "local").mkdir(parents=True)
        self.start_patch("admin_client.PROJECT_ENV", self.root / ".env")
        env = {key: "" for key in (*CONFIG_KEYS, "B2_KEY_ID", "B2_APP_KEY", "B2_BUCKET", "B2_ENDPOINT")}
        patcher = patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)

        self.writer = object()
        self.central = self.start_patch("admin_app.central_client", return_value=self.writer)
        denied = AssertionError("This request must not inspect B2 credentials or keyring")
        self.get_b2 = self.start_patch("admin_app.get_b2_config", side_effect=denied)
        self.configured = self.start_patch("admin_app.b2_configured", side_effect=denied)
        self.save_b2 = self.start_patch("admin_app.save_b2_credentials", side_effect=denied)
        # Guard lower-level entry points too, so a new route implementation
        # cannot silently bypass the direct-import mocks above.
        for target in ("config._load_b2_config", "config.get_b2_config", "config.save_b2_credentials"):
            self.start_patch(target, side_effect=denied)
        self.start_job = self.start_patch("admin_app._start_thread")
        self.start_patch("admin_app.run_dedupe", side_effect=AssertionError("HTTP tests must not run bucket jobs"))

        for name, value in (("_encode_running", False), ("_maint_running", False), ("_last_dedupe_scan", None)):
            self.patch_object(admin_app, name, value)
        for name, value in (("video_library", VideoLibrary(self.root)), ("editor_saving", False)):
            self.patch_object(admin_app.app.state, name, value)
        self.client = TestClient(admin_app.app, base_url="http://127.0.0.1:8765", client=("127.0.0.1", 50400))
        self.addCleanup(self.client.close)
        self.headers = {"X-Aida-Session": admin_app.app.state.admin_token, "Origin": "http://127.0.0.1:8765"}
        self.credentials = {"key_id": " fixture-key-id ", "app_key": " fixture-app-key ",
                            "bucket": " fixture-bucket ", "endpoint": " https://fixture.invalid "}

    def start_patch(self, target, *args, **kwargs):
        patcher = patch(target, *args, **kwargs)
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def patch_object(self, target, name, value):
        patcher = patch.object(target, name, value)
        patcher.start()
        self.addCleanup(patcher.stop)

    def legacy(self, *, configured=True, credentials=None):
        self.central.return_value = None
        self.configured.side_effect = None
        self.configured.return_value = configured
        self.get_b2.side_effect = None
        self.get_b2.return_value = credentials or {}
        self.save_b2.side_effect = None

    def cached_scan(self):
        result = DedupeResult(bucket="fixture-bucket", prefix="fixture/", applied=False,
                              keys_with_duplicates=1, versions_to_delete=2, bytes_reclaimed=1024,
                              plans=[{"Key": "fixture/video120/init_0.mp4", "VersionId": "fixture-old"}])
        admin_app._last_dedupe_scan = result
        return result

    def assert_no_credentials_or_jobs(self):
        self.get_b2.assert_not_called()
        self.configured.assert_not_called()
        self.save_b2.assert_not_called()
        self.start_job.assert_not_called()
        self.assertFalse(admin_app._maint_running)

    def test_central_status_reports_ready_without_inspecting_b2(self):
        response = self.client.get("/api/status")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"encode_running": False, "maint_running": False,
                                          "b2_configured": True, "cloud_mode": "central"})
        self.central.assert_called_once_with()
        self.assert_no_credentials_or_jobs()

    def test_central_credentials_expose_only_nonsecret_mode_metadata(self):
        response = self.client.get("/api/credentials")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"cloud_mode": "central", "configured": True})
        self.assert_no_credentials_or_jobs()

    def test_central_credentials_save_rejects_both_new_and_reused_keys_before_access(self):
        for app_key in ("fixture-new-key", ""):
            with self.subTest(app_key=bool(app_key)):
                response = self.client.post("/api/credentials", json={**self.credentials, "app_key": app_key}, headers=self.headers)
                self.assertEqual(response.status_code, 409, response.text)
        self.assert_no_credentials_or_jobs()

    def test_central_dedupe_rejects_scan_apply_and_cached_result_without_access(self):
        cached = self.cached_scan()
        for method, route in (("POST", "scan"), ("POST", "apply"), ("GET", "last")):
            with self.subTest(route=route):
                kwargs = {"json": {"prefix": cached.prefix}, "headers": self.headers} if method == "POST" else {}
                response = self.client.request(method, f"/api/dedupe/{route}", **kwargs)
                self.assertEqual(response.status_code, 409, response.text)
                self.assertNotIn("fixture-old", response.text)
        self.assertIs(admin_app._last_dedupe_scan, cached)
        self.assert_no_credentials_or_jobs()

    def test_partial_or_invalid_central_configuration_fails_closed_for_every_mode_route(self):
        cached = self.cached_scan()
        self.central.side_effect = AdminClientError("Incomplete synthetic central setup", 400)
        requests = (("GET", "/api/status", None), ("GET", "/api/credentials", None),
                    ("POST", "/api/credentials", self.credentials),
                    ("POST", "/api/dedupe/scan", {"prefix": cached.prefix}),
                    ("POST", "/api/dedupe/apply", {"prefix": cached.prefix}),
                    ("GET", "/api/dedupe/last", None))
        for method, route, body in requests:
            with self.subTest(route=route):
                kwargs = {"json": body, "headers": self.headers} if body is not None else {}
                response = self.client.request(method, route, **kwargs)
                self.assertEqual(response.status_code, 503, response.text)
                self.assertNotIn("fixture-old", response.text)
        self.assertIs(admin_app._last_dedupe_scan, cached)
        self.assert_no_credentials_or_jobs()

    def test_legacy_status_uses_mocked_b2_configuration_and_running_flags(self):
        self.legacy()
        admin_app._encode_running = True
        for configured in (True, False):
            with self.subTest(configured=configured):
                self.configured.return_value = configured
                response = self.client.get("/api/status")
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["b2_configured"], configured)
                self.assertTrue(response.json()["encode_running"])
                self.assertFalse(response.json()["maint_running"])
                self.assertEqual(response.json()["cloud_mode"], "legacy")
        self.assertEqual(self.configured.call_count, 2)
        self.get_b2.assert_not_called()

    def test_legacy_credentials_preserve_fields_but_never_return_the_application_key(self):
        self.legacy(credentials={"B2_KEY_ID": "fixture-key-id", "B2_APP_KEY": "private-fixture-key",
                                 "B2_BUCKET": "fixture-bucket", "B2_ENDPOINT": "https://fixture.invalid"})
        response = self.client.get("/api/credentials")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"key_id": "fixture-key-id", "app_key": "", "bucket": "fixture-bucket",
                                          "endpoint": "https://fixture.invalid", "configured": True, "cloud_mode": "legacy"})
        self.assertNotIn("private-fixture-key", response.text)
        self.get_b2.assert_called_once_with()
        self.configured.assert_called_once_with()

    def test_legacy_credentials_unconfigured_fields_are_empty(self):
        self.legacy(configured=False)
        response = self.client.get("/api/credentials")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"key_id": "", "app_key": "", "bucket": "", "endpoint": "",
                                          "configured": False, "cloud_mode": "legacy"})

    def test_legacy_credentials_save_trims_supplied_values_without_reading_old_keys(self):
        self.legacy()
        response = self.client.post("/api/credentials", json=self.credentials, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.save_b2.assert_called_once_with("fixture-key-id", "fixture-app-key", "fixture-bucket", "https://fixture.invalid")
        self.get_b2.assert_not_called()

    def test_legacy_credentials_save_reuses_an_existing_key_only_for_the_same_id(self):
        self.legacy(credentials={"B2_KEY_ID": "fixture-key-id", "B2_APP_KEY": "stored-fixture-key"})
        response = self.client.post("/api/credentials", json={**self.credentials, "app_key": "  "}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.save_b2.assert_called_once_with("fixture-key-id", "stored-fixture-key", "fixture-bucket", "https://fixture.invalid")

    def test_legacy_credentials_do_not_reuse_missing_keys_or_keys_for_another_id(self):
        self.legacy()
        for previous in ({}, {"B2_KEY_ID": "fixture-key-id"}, {"B2_KEY_ID": "other-key-id", "B2_APP_KEY": "stored-fixture-key"}):
            with self.subTest(previous=sorted(previous)):
                self.get_b2.return_value = previous
                response = self.client.post("/api/credentials", json={**self.credentials, "app_key": ""}, headers=self.headers)
                self.assertEqual(response.status_code, 400, response.text)
        self.save_b2.assert_not_called()

    def test_legacy_dedupe_scan_requires_mocked_b2_configuration(self):
        self.legacy(configured=False)
        response = self.client.post("/api/dedupe/scan", json={"prefix": "fixture/"}, headers=self.headers)
        self.assertEqual(response.status_code, 400, response.text)
        self.start_job.assert_not_called()
        self.assertFalse(admin_app._maint_running)

    def test_legacy_dedupe_scan_starts_the_existing_background_job(self):
        self.legacy()
        response = self.client.post("/api/dedupe/scan", json={"prefix": "fixture/"}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.start_job.assert_called_once_with(admin_app._run_dedupe_job, apply=False, prefix="fixture/", plans=None)
        self.assertTrue(admin_app._maint_running)

    def test_legacy_dedupe_apply_forwards_only_the_matching_cached_plan(self):
        self.legacy()
        cached = self.cached_scan()
        response = self.client.post("/api/dedupe/apply", json={"prefix": cached.prefix}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.start_job.assert_called_once_with(admin_app._run_dedupe_job, apply=True, prefix=cached.prefix, plans=cached.plans)
        self.assertTrue(admin_app._maint_running)

    def test_legacy_dedupe_apply_requires_a_matching_scan_with_duplicates(self):
        self.legacy()
        duplicate_scan = self.cached_scan()
        cases = ((None, "fixture/"), (DedupeResult("fixture-bucket", "fixture/", False), "fixture/"),
                 (duplicate_scan, "different/"))
        for cached, prefix in cases:
            with self.subTest(cached=bool(cached), prefix=prefix):
                admin_app._last_dedupe_scan = cached
                response = self.client.post("/api/dedupe/apply", json={"prefix": prefix}, headers=self.headers)
                self.assertEqual(response.status_code, 400, response.text)
        self.start_job.assert_not_called()
        self.assertFalse(admin_app._maint_running)

    def test_legacy_dedupe_keeps_encode_maintenance_and_editor_busy_checks(self):
        self.legacy()
        cached = self.cached_scan()
        busy_states = ((admin_app, "_encode_running"), (admin_app, "_maint_running"), (admin_app.app.state, "editor_saving"))
        for target, name in busy_states:
            with patch.object(target, name, True):
                for route in ("scan", "apply"):
                    with self.subTest(busy=name, route=route):
                        response = self.client.post(f"/api/dedupe/{route}", json={"prefix": cached.prefix}, headers=self.headers)
                        self.assertEqual(response.status_code, 409, response.text)
        self.start_job.assert_not_called()

    def test_legacy_dedupe_last_preserves_empty_and_cached_responses_without_b2_reads(self):
        self.central.return_value = None
        empty = self.client.get("/api/dedupe/last")
        self.assertEqual(empty.status_code, 200, empty.text)
        self.assertIsNone(empty.json())
        cached = self.cached_scan()
        response = self.client.get("/api/dedupe/last")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["plans"], cached.plans)
        self.assertEqual(response.json()["versions_to_delete"], 2)
        self.assertIn("summary", response.json())
        self.assert_no_credentials_or_jobs()


if __name__ == "__main__":
    unittest.main()
