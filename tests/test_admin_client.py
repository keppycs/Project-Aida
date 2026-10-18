"""Central publisher transport never contacts a real account or credential store."""

from io import BytesIO
import base64
from datetime import datetime, timedelta, timezone
from email.message import Message
from hashlib import md5, sha256
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, parse_qsl
from urllib.request import ProxyHandler

ROOT = Path(__file__).absolute().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import admin_client
from admin_client import AdminClient, AdminClientError, MAX_RESPONSE, _NoRedirect, central_client, encode_variants


class Response(BytesIO):
    def __init__(self, data, status=200, headers=None):
        super().__init__(data if isinstance(data, bytes) else json.dumps(data).encode())
        self.status = status
        self.headers = Message()
        for name, value in (headers or {}).items():
            self.headers[name] = value


class PreviewResponse(Response):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.reads = []

    def read(self, size=-1):
        self.reads.append(size)
        return super().read(size)


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


class StreamingOpener(Opener):
    """Consume the PUT stream inside open(), as urllib does before returning."""
    def __init__(self, *responses):
        super().__init__(*responses)
        self.bodies = []

    def open(self, request, timeout):
        self.bodies.append(request.data.read())
        return super().open(request, timeout)


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

    def upload_fixture(self, data=b"synthetic-120fps-media-chunk", *, date=None):
        path = Path(self.temp.name) / "chunk.fmp4"
        path.write_bytes(data)
        file = {"path": "AV1/chunk_0_1.fmp4", "size": len(data), "content_type": "video/mp4",
                "md5": base64.b64encode(md5(data).digest()).decode(), "sha256": sha256(data).hexdigest()}
        date = date or datetime.now(timezone.utc).replace(microsecond=0)
        query = {"X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": f"SyntheticKey/{date:%Y%m%d}/eu-central-003/s3/aws4_request",
                 "X-Amz-Date": date.strftime("%Y%m%dT%H%M%SZ"), "X-Amz-Expires": "300",
                 "X-Amz-SignedHeaders": "content-length;content-md5;content-type;host;x-amz-content-sha256", "X-Amz-Signature": "a" * 64}
        grant = {"path": file["path"], "url": f"https://s3.eu-central-003.backblazeb2.com/ProjectAida/video/{file['path']}?{urlencode(query)}",
                 "headers": {"Content-Length": str(file["size"]), "Content-MD5": file["md5"], "Content-Type": file["content_type"], "X-Amz-Content-Sha256": file["sha256"]}}
        result = {"grants": [grant], "expires_at": (date + timedelta(seconds=300)).isoformat().replace("+00:00", "Z")}
        return path, file, grant, result

    def grant_client(self, result):
        opener = Opener(Response(result))
        return AdminClient("https://keppy.dev/edit/api", "synthetic-access-id", "synthetic-access-secret", opener=opener), opener

    def get_grants(self, client, file):
        return client.upload_grants("video", "synthetic-lease", "reservation-op", [file], operation_id="grants-op")

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

    def test_upload_grants_bind_exact_files_and_put_streams_without_access_credentials(self):
        data = b"synthetic-120fps-media" * 70_000
        path, file, grant, result = self.upload_fixture(data)
        client, publisher = self.grant_client(result)
        granted = self.get_grants(client, file)
        api = publisher.requests[0][0]
        self.assertEqual(api.full_url, "https://keppy.dev/edit/api/videos/video/upload-grants")
        self.assertEqual(json.loads(api.data), {"lease": "synthetic-lease", "reservation_operation_id": "reservation-op", "files": [file], "operation_id": "grants-op"})
        self.assertEqual(api.get_header("Cf-access-client-secret"), "synthetic-access-secret")
        self.assertEqual(granted["expires_timestamp"], datetime.fromisoformat(result["expires_at"].replace("Z", "+00:00")).timestamp())
        uploaded = Response(b"", 200)
        client.upload_opener = StreamingOpener(uploaded)
        client.upload_media("video", path, file, granted["grants"][0])
        put, timeout = client.upload_opener.requests[0]
        self.assertEqual(put.get_method(), "PUT")
        self.assertEqual(put.full_url, grant["url"])
        self.assertEqual(timeout, 90)
        self.assertEqual(client.upload_opener.bodies, [data])
        self.assertEqual({key.lower(): value for key, value in put.header_items()}, {key.lower(): value for key, value in grant["headers"].items()})
        self.assertNotIn("synthetic-access", repr(put.header_items()))
        self.assertNotIn("cf-access-client-secret", {key.lower() for key, _ in put.header_items()})
        self.assertTrue(put.data.closed)
        self.assertTrue(uploaded.closed)
        self.assertEqual(len(publisher.requests), 1)

    def test_unexpected_upload_destinations_queries_and_headers_fail_before_file_or_s3_access(self):
        path, file, valid, result = self.upload_fixture()
        parsed = urlsplit(valid["url"])
        query = dict(parse_qsl(parsed.query))
        bad = []
        for target in ("http://s3.eu-central-003.backblazeb2.com", "https://other.invalid", "https://s3.eu-central-003.backblazeb2.com.evil.invalid", "https://user:secret@s3.eu-central-003.backblazeb2.com", "https://s3.eu-central-003.backblazeb2.com:443"):
            bad.append({**valid, "url": target + parsed.path + "?" + parsed.query})
        for route in ("/OtherBucket/video/AV1/chunk_0_1.fmp4", "/ProjectAida/other/AV1/chunk_0_1.fmp4", "/ProjectAida/video/metadata.json", "/ProjectAida/video/AV1/%63hunk_0_1.fmp4"):
            bad.append({**valid, "url": f"https://{parsed.netloc}{route}?{parsed.query}"})
        bad.extend([{**valid, "url": valid["url"] + suffix} for suffix in ("&X-Amz-Signature=" + "b" * 64, "&token=unexpected", "#fragment")])
        bad.append({**valid, "url": valid["url"].replace("X-Amz-Algorithm", "X-Amz-\nAlgorithm")})
        for name, value in (("X-Amz-Expires", "3600"), ("X-Amz-Algorithm", "none"), ("X-Amz-SignedHeaders", "host"), ("X-Amz-Credential", "SyntheticKey/20261018/other-region/s3/aws4_request"), ("X-Amz-Signature", "not-a-signature")):
            bad.append({**valid, "url": f"https://{parsed.netloc}{parsed.path}?{urlencode({**query, name: value})}"})
        for name, value in (("Content-Length", "1"), ("Content-MD5", "wrong"), ("Content-Type", "text/html"), ("X-Amz-Content-Sha256", "0" * 64), ("CF-Access-Client-Secret", "unexpected"), ("Authorization", "unexpected")):
            bad.append({**valid, "headers": {**valid["headers"], name: value}})
        bad.extend([{**valid, "headers": {}}, {**valid, "url": None}, {**valid, "headers": None}])
        for grant in bad:
            with self.subTest(grant=grant):
                client, publisher = self.grant_client({**result, "grants": [grant]})
                client.upload_opener = StreamingOpener(Response(b"", 200))
                with self.assertRaises(AdminClientError):
                    self.get_grants(client, file)
                with patch.object(Path, "open", side_effect=AssertionError("Invalid destination must be rejected before opening a file")), self.assertRaises(AdminClientError):
                    client.upload_media("video", path, file, grant)
                self.assertEqual(client.upload_opener.requests, [])
                self.assertTrue(publisher.responses == [])

    def test_upload_grant_response_requires_exact_file_set_and_bounded_utc_expiry(self):
        _, file, grant, valid = self.upload_fixture()
        future = datetime.now(timezone.utc) + timedelta(seconds=3600)
        invalid = [[], {}, {**valid, "grants": []}, {**valid, "grants": [grant, grant]}, {**valid, "grants": [{**grant, "path": "metadata.json"}]},
                   {**valid, "expires_at": None}, {**valid, "expires_at": "invalid"},
                   {**valid, "expires_at": future.isoformat()},
                   {**valid, "expires_at": valid["expires_at"].replace("Z", "")},
                   {**valid, "expires_at": valid["expires_at"].replace("Z", "+02:00")},
                   {**valid, "expires_at": (datetime.fromisoformat(valid["expires_at"].replace("Z", "+00:00")) - timedelta(seconds=20)).isoformat()}]
        for result in invalid:
            with self.subTest(result=result):
                client, publisher = self.grant_client(result)
                with self.assertRaises(AdminClientError):
                    self.get_grants(client, file)
                self.assertEqual(len(publisher.requests), 1)
        # An expired journal replay is returned to upload.py for explicit renewal,
        # provided its reported expiry still agrees with the old signed URL.
        _, old_file, _, expired = self.upload_fixture(date=datetime.now(timezone.utc) - timedelta(minutes=10))
        client, _ = self.grant_client(expired)
        self.assertLess(self.get_grants(client, old_file)["expires_timestamp"], datetime.now(timezone.utc).timestamp())

    def test_changed_media_size_sha256_or_md5_is_rejected_before_upload(self):
        original = b"synthetic-120fps-media"
        for mutation in (original + b"extra", original[:-1], b"x" * len(original)):
            with self.subTest(mutation=mutation):
                path, file, grant, _ = self.upload_fixture(original)
                path.write_bytes(mutation)
                client, _ = self.grant_client({})
                client.upload_opener = StreamingOpener(Response(b"", 200))
                with self.assertRaises(AdminClientError) as caught:
                    client.upload_media("video", path, file, grant)
                self.assertEqual(caught.exception.status_code, 409)
                self.assertEqual(client.upload_opener.requests, [])
        for checksum in ("sha256", "md5"):
            path, file, _, _ = self.upload_fixture(original)
            # Keep the grant consistent with the supplied manifest so verification
            # must hash the open file, rather than only comparing grant fields.
            file[checksum] = "0" * 64 if checksum == "sha256" else "AAAAAAAAAAAAAAAAAAAAAA=="
            _, _, grant, _ = self.upload_fixture(original)
            grant["headers"]["X-Amz-Content-Sha256" if checksum == "sha256" else "Content-MD5"] = file[checksum]
            client, _ = self.grant_client({})
            client.upload_opener = StreamingOpener(Response(b"", 200))
            with self.subTest(checksum=checksum), self.assertRaises(AdminClientError) as caught:
                client.upload_media("video", path, file, grant)
            self.assertEqual(caught.exception.status_code, 409)
            self.assertEqual(client.upload_opener.requests, [])
        for size in (0, 512 * 1024 * 1024 + 1):
            path, file, grant, _ = self.upload_fixture(original)
            file["size"] = size
            grant["headers"]["Content-Length"] = str(size)
            client, _ = self.grant_client({})
            client.upload_opener = StreamingOpener(Response(b"", 200))
            with self.subTest(size=size), patch.object(Path, "open", side_effect=AssertionError("Out-of-bounds size must not open media")), self.assertRaises(AdminClientError) as caught:
                client.upload_media("video", path, file, grant)
            self.assertEqual(caught.exception.status_code, 413)
            self.assertEqual(client.upload_opener.requests, [])

    def test_s3_redirect_and_transport_failure_do_not_retry_or_reveal_service_secrets(self):
        path, file, grant, _ = self.upload_fixture()
        for response in (Response(b"", 302), Response(b"", 307), HTTPError(grant["url"], 308, "redirect", {"Location": "https://other.invalid"}, BytesIO(b"")), URLError("synthetic-access-secret"), TimeoutError("synthetic-access-secret")):
            client, _ = self.grant_client({})
            uploader = StreamingOpener(response)
            client.upload_opener = uploader
            with self.subTest(response=response), self.assertRaises(AdminClientError) as caught:
                client.upload_media("video", path, file, grant)
            self.assertEqual(len(uploader.requests), 1)
            self.assertNotIn("synthetic-access-secret", str(caught.exception))
            self.assertTrue(uploader.requests[0][0].data.closed)
            if not isinstance(response, (URLError, TimeoutError)) or isinstance(response, HTTPError):
                self.assertTrue(response.closed)
        # A fresh S3 opener disables ambient proxies and redirects independently
        # of the authenticated API opener.
        client, _ = self.grant_client({})
        uploader = StreamingOpener(Response(b"", 200))
        with patch.object(admin_client, "build_opener", return_value=uploader) as build:
            client.upload_media("video", path, file, grant)
        handlers = build.call_args.args
        self.assertTrue(any(isinstance(handler, ProxyHandler) and handler.proxies == {} for handler in handlers))
        self.assertTrue(any(isinstance(handler, _NoRedirect) for handler in handlers))

    def test_private_preview_streams_through_service_api_without_b2_or_eager_reads(self):
        response = PreviewResponse(b"120!", 206, {"Content-Type": "video/mp4", "Content-Length": "4", "Content-Range": "bytes 2-5/24"})
        opener = Opener(response)
        environment = {"AIDA_ADMIN_URL": "https://keppy.dev/edit/api", "AIDA_ACCESS_CLIENT_ID": "synthetic-access-id", "AIDA_ACCESS_CLIENT_SECRET": "synthetic-access-secret"}
        with patch.dict("os.environ", environment, clear=True), patch.dict("sys.modules", {"boto3": None, "botocore": None, "keyring": None}), patch.object(admin_client, "_project_values", side_effect=AssertionError("Complete central configuration must not read stored credentials")):
            client = central_client()
            client.opener = opener
            asset = client.open_asset("video", "AV1/chunk_0_1.fmp4", "bytes=2-5")
        self.assertIs(asset["Body"], response)
        self.assertEqual(response.reads, [])
        self.assertFalse(response.closed)
        self.assertEqual({key: value for key, value in asset.items() if key != "Body"}, {"ContentType": "video/mp4", "ContentEncoding": "identity", "ContentLength": 4, "ContentRange": "bytes 2-5/24"})
        request, timeout = opener.requests[0]
        self.assertEqual(request.full_url, "https://keppy.dev/edit/api/media/video/AV1/chunk_0_1.fmp4")
        self.assertEqual(request.get_method(), "GET")
        self.assertIsNone(request.data)
        self.assertEqual(request.get_header("Range"), "bytes=2-5")
        self.assertEqual(request.get_header("Accept-encoding"), "identity")
        self.assertEqual(request.get_header("Cf-access-client-id"), "synthetic-access-id")
        self.assertEqual(request.get_header("Cf-access-client-secret"), "synthetic-access-secret")
        self.assertEqual(timeout, 30)
        self.assertEqual(asset["Body"].read(2), b"12")
        self.assertEqual(response.reads, [2])
        asset["Body"].close()
        self.assertTrue(response.closed)

    def test_private_preview_rejects_nonfixed_paths_ids_and_ranges_before_api(self):
        client, opener = self.grant_client({})
        for video_id in ("", "..", "video/other", "video?query", "video%2fother", "video\n", None):
            with self.subTest(video_id=video_id), self.assertRaises(AdminClientError):
                client.open_asset(video_id, "AV1/init_0.mp4")
        for relative in ("index.json", "../metadata.json", "AV1/../metadata.json", "AV1\\init_0.mp4", "AV1/%69nit_0.mp4", "AV1/init_0.mp4?token=x", "AV1/init_0.mp4#fragment", "AV1/source.mp4", ".editor-state.json", ".aida-editor/drafts/image.webp", "AV1/init_0.mp4\n", None):
            with self.subTest(relative=relative), self.assertRaises(AdminClientError):
                client.open_asset("video", relative)
        for range_header in ("bytes=0-1,2-3", "bytes=-", "items=0-3", "bytes=0-1\r\nX-Extra: yes", "bytes=" + "1" * 100 + "-", 1):
            with self.subTest(range_header=range_header), self.assertRaises(AdminClientError) as caught:
                client.open_asset("video", "AV1/init_0.mp4", range_header)
            self.assertEqual(caught.exception.status_code, 416)
        self.assertEqual(opener.requests, [])

    def test_private_preview_all_fixed_asset_families_accept_only_their_expected_mime(self):
        paths = {"metadata.json": "application/json", "thumbnail_sdr.webp": "image/webp", "thumbnail_sdr_720p.webp": "image/webp", "thumbnail_share.jpg": "image/jpeg", "thumbnail_hdr.avif": "image/avif", "thumbnail_hdr_720p.avif": "image/avif", "AV1/manifest.mpd": "application/dash+xml", "HEVC/master.m3u8": "application/vnd.apple.mpegurl", "AV1/media_0.m3u8": "application/vnd.apple.mpegurl", "HEVC/init_0.mp4": "video/mp4", "AV1/chunk_0_1.fmp4": "video/mp4"}
        for relative, content_type in paths.items():
            with self.subTest(relative=relative):
                response = PreviewResponse(b"synthetic", headers={"Content-Type": content_type + "; charset=utf-8", "Content-Length": "9"})
                opener = Opener(response)
                client = AdminClient("https://keppy.dev/edit/api", "fake-id", "fake-secret", opener=opener)
                asset = client.open_asset("video", relative, "bytes=-9")
                self.assertEqual(asset["ContentType"], content_type)
                self.assertEqual(response.reads, [])
                self.assertEqual(opener.requests[0][0].get_header("Range"), "bytes=-9")
                asset["Body"].close()
                self.assertTrue(response.closed)

    def test_private_preview_rejected_responses_are_closed_without_consuming_login_or_media(self):
        headers = {"Content-Type": "video/mp4", "Content-Length": "4"}
        responses = [(PreviewResponse(b"denied", status, headers), status if status in (404, 416) else 503) for status in (404, 416, 302)]
        responses.extend((PreviewResponse(b"120!", 200, item), 503) for item in (
            {}, {**headers, "Content-Type": "text/html"}, {**headers, "Content-Type": "application/octet-stream"},
            {**headers, "Content-Encoding": "gzip"}, {**headers, "Content-Encoding": "br"},
            {**headers, "Content-Length": "-1"}, {**headers, "Content-Length": "four"},
            {**headers, "Content-Range": "bytes 0-3/4"}))
        responses.extend((PreviewResponse(b"120!", 206, item), 503) for item in (
            headers, {**headers, "Content-Range": "not-a-range"}))
        error_body = PreviewResponse(b"missing")
        responses.append((HTTPError("https://keppy.dev/edit/api/media/video/AV1/init_0.mp4", 404, "missing", Message(), error_body), 404))
        for response, expected_status in responses:
            with self.subTest(status=response.status, headers=response.headers):
                opener = Opener(response)
                client = AdminClient("https://keppy.dev/edit/api", "fake-id", "fake-secret", opener=opener)
                with self.assertRaises(AdminClientError) as caught:
                    client.open_asset("video", "AV1/init_0.mp4")
                self.assertEqual(caught.exception.status_code, expected_status)
                self.assertEqual(len(opener.requests), 1)
                self.assertTrue(response.closed)
                self.assertEqual(error_body.reads if isinstance(response, HTTPError) else response.reads, [])
        for error in (URLError("synthetic-access-secret"), TimeoutError("synthetic-access-secret")):
            opener = Opener(error)
            client = AdminClient("https://keppy.dev/edit/api", "fake-id", "fake-secret", opener=opener)
            with self.subTest(error=error), self.assertRaises(AdminClientError) as caught:
                client.open_asset("video", "AV1/init_0.mp4")
            self.assertEqual(len(opener.requests), 1)
            self.assertNotIn("synthetic-access-secret", str(caught.exception))

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
