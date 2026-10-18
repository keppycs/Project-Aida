"""Central publisher transport never contacts a real account or credential store."""

from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError

ROOT = Path(__file__).absolute().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import admin_client
from admin_client import AdminClient, AdminClientError, MAX_RESPONSE, _NoRedirect, central_client, encode_variants


class Response(BytesIO):
    def __init__(self, data, status=200):
        super().__init__(data if isinstance(data, bytes) else json.dumps(data).encode())
        self.status = status


class Opener:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class AdminClientTests(unittest.TestCase):
    def setUp(self):
        artifacts = ROOT / "logs" / "admin-client-tests"
        artifacts.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="fixture-", dir=artifacts)
        self.addCleanup(self.temp.cleanup)
        self.project_env = Path(self.temp.name) / ".env"
        patcher = patch.object(admin_client, "PROJECT_ENV", self.project_env)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_environment_is_optional_but_partial_setup_never_falls_back(self):
        with patch.dict("os.environ", {}, clear=True):
            self.assertIsNone(central_client())
        for setup in ({"AIDA_ADMIN_URL": "https://keppy.dev/edit/api"}, {"AIDA_ACCESS_CLIENT_ID": "fake"}):
            with self.subTest(setup=setup), patch.dict("os.environ", setup, clear=True):
                with self.assertRaises(AdminClientError):
                    central_client()

    def test_endpoint_and_header_injection_are_rejected_without_network(self):
        for url in ("http://keppy.dev/edit/api", "https://user:secret@keppy.dev/edit/api", "https://keppy.dev/edit/api?token=x", "https://keppy.dev/other", "https://keppy.dev:bad/edit/api", "https://keppy.dev:444/edit/api"):
            with self.subTest(url=url), self.assertRaises(AdminClientError):
                AdminClient(url, "fake-id", "fake-secret")
        with self.assertRaises(AdminClientError):
            AdminClient("https://keppy.dev/edit/api", "fake\r\ninjected", "fake-secret")

    def test_post_retries_exact_payload_and_operation_after_ambiguous_network_failure(self):
        opener = Opener(URLError("synthetic failure"), Response({"revision": "r2"}))
        client = AdminClient("https://keppy.dev/edit/api", "fake-id", "fake-secret", opener=opener)
        client.publish("video", {"title": "Edited", "visibility": "private", "width": 1}, "r1", operation_id="fixed-op")
        first, second = (item[0] for item in opener.requests)
        self.assertEqual(first.data, second.data)
        self.assertEqual(json.loads(first.data), {"title": "Edited", "visibility": "private", "revision": "r1", "publish": True, "operation_id": "fixed-op"})
        self.assertEqual(first.get_header("Cf-access-client-id"), "fake-id")
        self.assertEqual(first.get_header("Cf-access-client-secret"), "fake-secret")
        self.assertTrue(all(request.get_header("User-agent") == "ProjectAidaStudio/1.0" for request, _ in opener.requests))
        self.assertTrue(all(timeout == 30 for _, timeout in opener.requests))

    def test_redirect_is_never_followed_and_login_html_is_not_success(self):
        self.assertIsNone(_NoRedirect().redirect_request(None, None, 302, "login", {}, "https://other.invalid"))
        for response in (Response(b"login", 302), Response(b"<html>Sign in</html>")):
            with self.subTest(status=response.status):
                opener = Opener(response)
                with self.assertRaises(AdminClientError):
                    AdminClient("https://keppy.dev/edit/api", "fake", "fake", opener=opener).get_video("video")
                self.assertEqual(len(opener.requests), 1)

    def test_missing_is_distinct_from_denied_and_conflict_preserves_current(self):
        client = AdminClient("https://keppy.dev/edit/api", "fake", "fake", opener=Opener(Response({}, 404)))
        self.assertIsNone(client.get_video("missing"))
        for status in (401, 403, 409):
            with self.subTest(status=status):
                client.opener = Opener(Response({"detail": "do not reflect this private error", "current": {"revision": "r2"}}, status))
                with self.assertRaises(AdminClientError) as caught:
                    client.get_video("video")
                self.assertEqual(caught.exception.status_code, status)
                self.assertEqual(caught.exception.current, {"revision": "r2"})
                self.assertNotIn("private error", str(caught.exception))

    def test_oversized_and_incomplete_responses_fail_closed(self):
        for response in (Response(b"x" * (MAX_RESPONSE + 1)), Response({"metadata": {}}), Response([])):
            client = AdminClient("https://keppy.dev/edit/api", "fake", "fake", opener=Opener(response))
            with self.assertRaises(AdminClientError):
                client.get_video("video")
            self.assertTrue(response.closed)

    def test_private_library_pagination_and_cursor_are_bounded(self):
        opener = Opener(Response({"videos": [{"id": "private"}], "next_cursor": "a/b+"}), Response({"videos": [{"id": "unlisted"}], "next_cursor": None}))
        client = AdminClient("https://keppy.dev/edit/api", "fake", "fake", opener=opener)
        self.assertEqual([item["id"] for item in client.list_videos()], ["private", "unlisted"])
        self.assertTrue(opener.requests[1][0].full_url.endswith("?cursor=a%2Fb%2B"))
        self.assertTrue(all(request.get_header("User-agent") == "ProjectAidaStudio/1.0" for request, _ in opener.requests))
        client.opener = Opener(Response({"videos": [], "next_cursor": "same"}), Response({"videos": [], "next_cursor": "same"}))
        with self.assertRaises(AdminClientError):
            client.list_videos()

    def test_thumbnail_variants_require_complete_bounded_sdr_set(self):
        images = {"thumbnail_sdr.webp": b"synthetic", "thumbnail_sdr_720p.webp": b"synthetic", "thumbnail_share.jpg": b"synthetic"}
        variants = encode_variants(images)
        self.assertEqual(variants["thumbnail_share.jpg"]["type"], "image/jpeg")
        self.assertEqual(variants["thumbnail_sdr.webp"]["type"], "image/webp")
        with self.assertRaises(AdminClientError):
            encode_variants({"thumbnail_sdr.webp": b"synthetic"})
        images["thumbnail_share.jpg"] = b"x" * (2 * 1024 * 1024 + 1)
        with self.assertRaises(AdminClientError):
            encode_variants(images)

    def test_no_thumbnail_finalize_omits_optional_variants(self):
        opener = Opener(Response({"revision": "r2"}))
        client = AdminClient("https://keppy.dev/edit/api", "fake", "fake", opener=opener)
        client.finalize("video", "lease", {"id": "video", "frameRate": 120}, {"id": "video"}, operation_id="fixed-operation")
        payload = json.loads(opener.requests[0][0].data)
        self.assertNotIn("variants", payload)
        self.assertIs(payload["media_complete"], True)

    def test_exact_project_file_supplies_config_independently_of_b2(self):
        self.project_env.write_text('B2_KEY_ID=ignored-synthetic\nAIDA_ADMIN_URL=https://keppy.dev/edit/api\nAIDA_ACCESS_CLIENT_ID=file-id\nAIDA_ACCESS_CLIENT_SECRET="file-${UNEXPANDED}-secret"\n', encoding="utf-8")
        with patch.dict("os.environ", {}, clear=True):
            client = central_client()
            self.assertEqual(client.url, "https://keppy.dev/edit/api")
            self.assertEqual(client.client_id, "file-id")
            self.assertEqual(client.client_secret, "file-${UNEXPANDED}-secret")
            self.assertNotIn("AIDA_ADMIN_URL", __import__("os").environ)

    def test_nonempty_process_values_win_and_project_fills_only_missing_fields(self):
        self.project_env.write_text('AIDA_ADMIN_URL=https://wrong.invalid/edit/api\nAIDA_ACCESS_CLIENT_ID=file-id\nAIDA_ACCESS_CLIENT_SECRET=file-secret\n', encoding="utf-8")
        with patch.dict("os.environ", {"AIDA_ADMIN_URL": "https://keppy.dev/edit/api", "AIDA_ACCESS_CLIENT_ID": "process-id"}, clear=True):
            client = central_client()
            self.assertEqual(client.url, "https://keppy.dev/edit/api")
            self.assertEqual(client.client_id, "process-id")
            self.assertEqual(client.client_secret, "file-secret")
        with patch.dict("os.environ", {"AIDA_ADMIN_URL": "https://keppy.dev/edit/api", "AIDA_ACCESS_CLIENT_ID": "process-id", "AIDA_ACCESS_CLIENT_SECRET": "process-secret"}, clear=True), patch.object(admin_client, "_project_values", side_effect=AssertionError("Complete process env must not read a file")):
            self.assertEqual(central_client().client_secret, "process-secret")

    def test_partial_blank_and_invalid_project_settings_fail_closed(self):
        for text in ('AIDA_ADMIN_URL=https://keppy.dev/edit/api\n', 'AIDA_ADMIN_URL=\n', 'AIDA_ADMIN_URL="unterminated\n'):
            with self.subTest(text=text):
                self.project_env.write_text(text, encoding="utf-8")
                with patch.dict("os.environ", {}, clear=True), self.assertRaises(AdminClientError):
                    central_client()
        self.project_env.write_text('B2_KEY_ID=synthetic-unrelated\n', encoding="utf-8")
        with patch.dict("os.environ", {}, clear=True):
            self.assertIsNone(central_client())


if __name__ == "__main__":
    unittest.main()
