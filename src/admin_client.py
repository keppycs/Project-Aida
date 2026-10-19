"""Server-side single-publisher client using process env and exact project configuration."""

from __future__ import annotations

import base64
from datetime import datetime, timezone
from hashlib import md5, sha256
from io import StringIO
import json
import os
from pathlib import Path
import re
import stat
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, parse_qsl
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import uuid4


VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
VARIANTS = {"thumbnail_sdr.webp": "image/webp", "thumbnail_sdr_720p.webp": "image/webp", "thumbnail_share.jpg": "image/jpeg"}
MAX_RESPONSE = 2 * 1024 * 1024
MAX_REQUEST = 12_000_000
MAX_VARIANT = 1_900_000
PROJECT_ENV = Path(__file__).absolute().parent.parent / ".env"
CONFIG_KEYS = ("AIDA_ADMIN_URL", "AIDA_ACCESS_CLIENT_ID", "AIDA_ACCESS_CLIENT_SECRET")


class AdminClientError(RuntimeError):
    def __init__(self, message: str, status_code: int = 503, current: dict | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.current = current


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # In particular, never forward service secrets to a login redirect.
        return None


def encode_variants(images: dict[str, bytes] | None) -> dict:
    if not images:
        return {}
    if set(images) != set(VARIANTS):
        raise AdminClientError("The central publisher needs all three SDR thumbnail variants.", 400)
    if any(not isinstance(data, bytes) or not data or len(data) > MAX_VARIANT for data in images.values()) or sum(map(len, images.values())) > 6_000_000:
        raise AdminClientError("The thumbnail variants are too large for the central publisher.", 413)
    return {name: {"data": base64.b64encode(data).decode("ascii"), "type": VARIANTS[name]} for name, data in images.items()}


class AdminClient:
    def __init__(self, url: str, client_id: str, client_secret: str, *, opener=None):
        if not isinstance(url, str) or any(character.isspace() for character in url):
            raise AdminClientError("AIDA_ADMIN_URL must be an HTTPS /edit/api endpoint.", 400)
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except (ValueError, TypeError):
            raise AdminClientError("AIDA_ADMIN_URL must be an HTTPS /edit/api endpoint.", 400) from None
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or parsed.path.rstrip("/") != "/edit/api"
                or port not in (None, 443)):
            raise AdminClientError("AIDA_ADMIN_URL must be an HTTPS /edit/api endpoint.", 400)
        if any(not isinstance(value, str) or not value.strip() or "\r" in value or "\n" in value for value in (client_id, client_secret)):
            raise AdminClientError("Configure both AIDA_ACCESS_CLIENT_ID and AIDA_ACCESS_CLIENT_SECRET.", 400)
        self.url = url.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self.opener = opener
        self.upload_opener = None

    @staticmethod
    def _id(video_id: str) -> str:
        if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id):
            raise AdminClientError("Invalid central video ID.", 400)
        return video_id

    def _request(self, path: str, payload: dict | None = None):
        if self.opener is None:
            self.opener = build_opener(ProxyHandler({}), _NoRedirect())
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8") if payload is not None else None
        if body is not None and len(body) > MAX_REQUEST:
            raise AdminClientError("The central publication request is too large.", 413)
        headers = {"Accept": "application/json", "User-Agent": "ProjectAidaStudio/1.0", "CF-Access-Client-Id": self.client_id, "CF-Access-Client-Secret": self.client_secret}
        if body is not None:
            headers["Content-Type"] = "application/json"
        for attempt in range(2):
            response = None
            try:
                request = Request(self.url + path, data=body, headers=headers, method="POST" if body is not None else "GET")
                try:
                    response = self.opener.open(request, timeout=30)
                except HTTPError as exc:
                    response = exc
                status = response.status if hasattr(response, "status") else response.code
                if status in (502, 503, 504) and attempt == 0:
                    continue
                if 300 <= status < 400:
                    raise AdminClientError("The central publisher redirected the request. Check its Access configuration.")
                raw = response.read(MAX_RESPONSE + 1)
                if len(raw) > MAX_RESPONSE:
                    raise AdminClientError("The central publisher returned an oversized response.")
                try:
                    result = json.loads(raw)
                except (ValueError, UnicodeError):
                    raise AdminClientError("The central publisher did not return JSON. Check its Access configuration.") from None
                if not 200 <= status < 300:
                    message = "The live video changed. Refresh online and review before publishing." if status == 409 else "The central publisher could not complete this request. Your local files are kept."
                    raise AdminClientError(message, status, result.get("current") if isinstance(result, dict) else None)
                if not isinstance(result, (dict, list)):
                    raise AdminClientError("The central publisher returned an invalid response.")
                return result
            except (URLError, OSError, TimeoutError):
                if attempt:
                    raise AdminClientError("The central publisher is unavailable. Your local files are kept.") from None
            finally:
                if response is not None:
                    response.close()

    def get_video(self, video_id: str) -> dict | None:
        try:
            result = self._request(f"/videos/{self._id(video_id)}")
        except AdminClientError as exc:
            if exc.status_code == 404:
                return None
            raise
        if not isinstance(result, dict) or result.get("id") != video_id or not isinstance(result.get("revision"), str) or not result["revision"] or not isinstance(result.get("metadata"), dict):
            raise AdminClientError("The central video details are incomplete.")
        return result

    def get_tags(self) -> dict:
        result = self._request("/tags")
        if not isinstance(result, dict) or not isinstance(result.get("revision"), str) or not result["revision"]:
            raise AdminClientError("The central master tag list is incomplete.")
        from tags import normalize_registry
        try:
            normalize_registry(result)
        except ValueError:
            raise AdminClientError("The central master tag list is invalid.") from None
        return result

    def save_tags(self, revision: str, *, tag=None, merge=None, operation_id=None) -> dict:
        payload = {"revision": revision, "operation_id": operation_id or str(uuid4())}
        payload["tag" if tag is not None else "merge"] = tag if tag is not None else merge
        result = self._request("/tags", payload)
        if not isinstance(result, dict) or not isinstance(result.get("revision"), str) or not result["revision"]:
            raise AdminClientError("The central master tag save was not confirmed.")
        from tags import normalize_registry
        try:
            normalize_registry(result)
        except ValueError:
            raise AdminClientError("The central master tag save is invalid.") from None
        return result

    def open_asset(self, video_id: str, relative: str, range_header: str | None = None) -> dict:
        """Authenticated, streaming private preview. Caller owns Body.close()."""
        self._id(video_id)
        if not isinstance(relative, str) or not (relative in (*VARIANTS, "thumbnail_hdr.avif", "thumbnail_hdr_720p.avif", "metadata.json") or
                re.fullmatch(r"(?:AV1|HEVC)/(?:manifest\.mpd|master\.m3u8|media_[0-9]+\.m3u8|init_[0-9]+\.mp4|chunk_[0-9]+_[0-9]+\.fmp4)", relative)):
            raise AdminClientError("Invalid private preview asset.", 400)
        if range_header is not None and (not isinstance(range_header, str) or len(range_header) > 100 or not re.fullmatch(r"bytes=(?:[0-9]+-[0-9]*|-[0-9]+)", range_header)):
            raise AdminClientError("Invalid preview byte range.", 416)
        if self.opener is None:
            self.opener = build_opener(ProxyHandler({}), _NoRedirect())
        headers = {"User-Agent": "ProjectAidaStudio/1.0", "Accept-Encoding": "identity", "CF-Access-Client-Id": self.client_id, "CF-Access-Client-Secret": self.client_secret}
        if range_header is not None:
            headers["Range"] = range_header
        response = None
        try:
            try:
                response = self.opener.open(Request(self.url + f"/media/{video_id}/{relative}", headers=headers), timeout=30)
            except HTTPError as exc:
                response = exc
            if response.status not in (200, 206):
                raise AdminClientError("The private preview is unavailable.", response.status if response.status in (404, 416) else 503)
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
            expected = "application/json" if relative == "metadata.json" else "image/avif" if relative.endswith(".avif") else VARIANTS.get(relative) or ("application/dash+xml" if relative.endswith(".mpd") else "application/vnd.apple.mpegurl" if relative.endswith(".m3u8") else "video/mp4")
            if content_type != expected or response.headers.get("Content-Encoding", "identity").lower() != "identity":
                raise AdminClientError("The private preview returned an unexpected file.")
            result = {"Body": response, "ContentType": content_type, "ContentEncoding": "identity"}
            if response.headers.get("Content-Length") is not None:
                length = response.headers["Content-Length"]
                if not re.fullmatch(r"[0-9]+", length):
                    raise AdminClientError("The private preview size is invalid.")
                result["ContentLength"] = int(length)
            if response.headers.get("Content-Range") is not None:
                content_range = response.headers["Content-Range"]
                if not re.fullmatch(r"bytes [0-9]+-[0-9]+/[0-9]+", content_range) or response.status != 206:
                    raise AdminClientError("The private preview byte range is invalid.")
                result["ContentRange"] = content_range
            if response.status == 206 and "ContentRange" not in result:
                raise AdminClientError("The private preview byte range is incomplete.")
            return result
        except (URLError, OSError, TimeoutError):
            if response is not None:
                response.close()
            raise AdminClientError("The private preview connection was interrupted.") from None
        except Exception:
            if response is not None:
                response.close()
            raise

    def list_videos(self) -> list[dict]:
        videos, seen, cursor = [], set(), None
        while True:
            result = self._request("/videos" + ("?cursor=" + quote(cursor, safe="") if cursor else ""))
            page = result.get("videos") if isinstance(result, dict) else result
            if not isinstance(page, list) or any(not isinstance(video, dict) or not isinstance(video.get("id"), str) or not VIDEO_ID.fullmatch(video["id"]) for video in page):
                raise AdminClientError("The central video list is invalid.")
            videos.extend(page)
            cursor = result.get("next_cursor") if isinstance(result, dict) else None
            if cursor is None:
                return videos
            if not isinstance(cursor, str) or not cursor or len(cursor) > 2048 or cursor in seen or len(videos) > 10_000:
                raise AdminClientError("The central video list pagination is invalid.")
            seen.add(cursor)

    def reserve(self, video_id: str, operation_id: str) -> str:
        result = self._request("/uploads/reserve", {"id": self._id(video_id), "operation_id": operation_id})
        if not isinstance(result, dict) or not isinstance(result.get("lease"), str) or not result["lease"]:
            raise AdminClientError("The central upload reservation is incomplete.")
        return result["lease"]

    def finalize(self, video_id: str, lease: str, metadata: dict, entry: dict, *, images=None, operation_id: str):
        # Definitions are a presentation projection. The central registry owns
        # canonical names and aliases; uploads carry only their assignments.
        metadata = {key: value for key, value in metadata.items() if key != "tagDefinitions"}
        entry = {key: value for key, value in entry.items() if key != "tagDefinitions"}
        payload = {"lease": lease, "metadata": metadata, "entry": entry, "operation_id": operation_id, "media_complete": True}
        if images:
            payload["variants"] = encode_variants(images)
        return self._request(f"/uploads/{self._id(video_id)}/finalize", payload)

    def upload_grants(self, video_id: str, lease: str, reservation_operation_id: str, files: list[dict], *, operation_id: str):
        result = self._request(f"/videos/{self._id(video_id)}/upload-grants", {"lease": lease,
            "reservation_operation_id": reservation_operation_id, "files": files, "operation_id": operation_id})
        grants = result.get("grants") if isinstance(result, dict) else None
        try:
            expiration = datetime.fromisoformat(result["expires_at"].replace("Z", "+00:00"))
            if expiration.utcoffset() is None or expiration.utcoffset().total_seconds() != 0:
                raise ValueError()
            expires = expiration.timestamp()
            if expires > datetime.now(timezone.utc).timestamp() + 305:
                raise ValueError()
        except (ValueError, KeyError, TypeError, AttributeError):
            raise AdminClientError("The upload permissions are incomplete.") from None
        if not isinstance(grants, list) or len(grants) != len(files):
            raise AdminClientError("The upload permissions are incomplete.")
        expected = {file["path"]: file for file in files}
        seen = set()
        for grant in grants:
            if not isinstance(grant, dict) or grant.get("path") not in expected or grant["path"] in seen:
                raise AdminClientError("The upload permissions contain unexpected files.")
            self._validate_upload_grant(video_id, grant, expected[grant["path"]])
            try:
                signed_at = datetime.strptime(dict(parse_qsl(urlsplit(grant["url"]).query))["X-Amz-Date"], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).timestamp()
            except ValueError:
                raise AdminClientError("The upload permission date is invalid.") from None
            if not 0 <= expires - signed_at - 300 < 1:
                raise AdminClientError("The upload permission expiry is inconsistent.")
            seen.add(grant["path"])
        return {**result, "expires_timestamp": expires}

    @staticmethod
    def _validate_upload_grant(video_id: str, grant: dict, file: dict):
        try:
            if not isinstance(grant["url"], str) or any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in grant["url"]):
                raise ValueError()
            parsed = urlsplit(grant["url"])
            pairs = parse_qsl(parsed.query, strict_parsing=True)
            query = dict(pairs)
            headers = grant["headers"]
            valid = (parsed.scheme == "https" and parsed.netloc == "s3.eu-central-003.backblazeb2.com" and
                parsed.path == f"/ProjectAida/{video_id}/{file['path']}" and not parsed.fragment and
                len(query) == len(pairs) == 6 and set(query) == {"X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires", "X-Amz-SignedHeaders", "X-Amz-Signature"} and
                query["X-Amz-Algorithm"] == "AWS4-HMAC-SHA256" and query["X-Amz-Expires"] == "300" and
                re.fullmatch(r"[A-Za-z0-9]+/\d{8}/eu-central-003/s3/aws4_request", query["X-Amz-Credential"]) and query["X-Amz-Credential"].split("/")[1] == query["X-Amz-Date"][:8] and
                re.fullmatch(r"\d{8}T\d{6}Z", query["X-Amz-Date"]) and re.fullmatch(r"[a-f0-9]{64}", query["X-Amz-Signature"]) and
                query["X-Amz-SignedHeaders"] == "content-length;content-md5;content-type;host;x-amz-content-sha256" and
                headers == {"Content-Length": str(file["size"]), "Content-MD5": file["md5"], "Content-Type": file["content_type"], "X-Amz-Content-Sha256": file["sha256"]})
        except (ValueError, TypeError, KeyError):
            valid = False
        if not valid:
            raise AdminClientError("The upload permissions point to an unexpected destination.")

    def upload_media(self, video_id: str, path: Path, file: dict, grant: dict):
        """PUT exactly the granted bytes; Access credentials never leave the publisher."""
        self._validate_upload_grant(self._id(video_id), grant, file)
        if self.upload_opener is None:
            self.upload_opener = build_opener(ProxyHandler({}), _NoRedirect())
        if not 0 < file["size"] <= 512 * 1024 * 1024:
            raise AdminClientError("The upload file is too large.", 413)
        response = None
        try:
            with path.open("rb") as stream:
                sha, checksum, size = sha256(), md5(), 0
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    size += len(chunk)
                    if size > file["size"]:
                        break
                    sha.update(chunk)
                    checksum.update(chunk)
                if size != file["size"] or sha.hexdigest() != file["sha256"] or base64.b64encode(checksum.digest()).decode() != file["md5"]:
                    raise AdminClientError("The video package changed. Keep it for review.", 409)
                stream.seek(0)
                try:
                    response = self.upload_opener.open(Request(grant["url"], data=stream, headers=grant["headers"], method="PUT"), timeout=90)
                except HTTPError as exc:
                    response = exc
            if not 200 <= response.status < 300:
                raise AdminClientError("A video file could not be uploaded. Your local package is kept.", response.status)
        except (URLError, OSError, TimeoutError):
            raise AdminClientError("A video upload was interrupted. Your local package is kept.") from None
        finally:
            if response is not None:
                response.close()

    def publish(self, video_id: str, fields: dict, revision: str, *, images=None, operation_id: str | None = None):
        payload = {**{key: fields[key] for key in ("title", "description", "tags", "tagIds", "visibility") if key in fields},
                   "revision": revision, "publish": True, "operation_id": operation_id or str(uuid4())}
        if images:
            payload["variants"] = encode_variants(images)
        return self._request(f"/videos/{self._id(video_id)}", payload)


def _project_values() -> dict:
    try:
        info = PROJECT_ENV.lstat()
    except FileNotFoundError:
        return {}
    except OSError:
        raise AdminClientError("The project's central publisher configuration could not be read.", 400) from None
    if not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400 or info.st_size > 128_000:
        raise AdminClientError("Use a regular project .env file smaller than128KB for central publisher configuration.", 400)
    try:
        from dotenv import dotenv_values
        text = PROJECT_ENV.read_text(encoding="utf-8-sig")
        values = dotenv_values(stream=StringIO(text), interpolate=False)
    except (ImportError, OSError, UnicodeError):
        raise AdminClientError("Could not load project .env. Install the project requirements and check that file.", 400) from None
    for name in CONFIG_KEYS:
        if re.search(rf"(?m)^\s*(?:export\s+)?{name}\b", text) and name not in values:
            raise AdminClientError("A central publisher setting in project .env is invalid.", 400)
    return {name: values[name] for name in CONFIG_KEYS if name in values}


def central_client() -> AdminClient | None:
    """Process env wins; only this project's exact .env supplies missing values.

    B2/keyring initialization is deliberately unrelated. A partial configured
    setup must never silently return to direct B2 publication.
    """
    process = {name: os.environ.get(name, "").strip() for name in CONFIG_KEYS}
    project = {} if all(process.values()) else _project_values()
    configured = bool(project) or any(name in os.environ for name in CONFIG_KEYS)
    url, client_id, secret = (process[name] or str(project.get(name) or "").strip() for name in CONFIG_KEYS)
    if not configured:
        return None
    if not url:
        raise AdminClientError("Set AIDA_ADMIN_URL when central publisher credentials are configured.", 400)
    return AdminClient(url, client_id, secret)
