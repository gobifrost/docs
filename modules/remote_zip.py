"""Seekable, bounded HTTP range reader for remotely retained ZIP archives."""

from __future__ import annotations

import os
import re
from collections.abc import Iterator
from typing import Final
from urllib.parse import urljoin, urlsplit

import httpx


MAX_NETWORK_RANGE: Final = 1024 * 1024
"""Maximum bytes requested in one HTTP byte-range request."""

MAX_LOGICAL_READ: Final = 16 * 1024 * 1024
"""Maximum bytes returned by one file-like ``read`` call."""

_MAX_REDIRECTS: Final = 4
_CONTENT_RANGE = re.compile(r"^bytes (\d+)-(\d+)/(\d+)$")
_REDIRECT_CODES: Final = frozenset({301, 302, 303, 307, 308})
_STRIPPED_HEADERS: Final = frozenset(
    {
        "authorization",
        "proxy-authorization",
        "cookie",
        "x-api-key",
        "api-key",
        "x-auth-token",
    }
)


class RemoteZipError(RuntimeError):
    """Safe remote-archive failure; deliberately excludes URLs and bodies."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


def _https_origin(value: str, *, label: str) -> tuple[str, str, int]:
    parsed = urlsplit(value)
    if parsed.scheme.lower() != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError(f"{label} must be an HTTPS origin")
    try:
        port = parsed.port or 443
    except ValueError:
        raise ValueError(f"{label} must be an HTTPS origin") from None
    return ("https", parsed.hostname.lower(), port)


def _is_strong_etag(value: str | None) -> bool:
    return bool(value and value.startswith('"') and value.endswith('"') and len(value) >= 2)


class RemoteZipReader:
    """A read-only, seekable ZIP source backed by validated HTTP ranges.

    The reader does not cache archive bytes or write temporary files.  It is
    intentionally synchronous because :class:`zipfile.ZipFile` consumes the
    ordinary synchronous file protocol.
    """

    def __init__(
        self,
        download_url: str,
        *,
        api_origin: str,
        api_key: str,
        client: httpx.Client | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        self._api_origin = _https_origin(api_origin, label="api_origin")
        _https_origin(download_url, label="download_url")
        self._download_url = download_url
        self._api_key = api_key
        self._client = client or httpx.Client(follow_redirects=False)
        self._owns_client = client is None
        self._position = 0
        self._closed = False
        self.archive_size = 0
        self.etag = ""

        try:
            _ = self._fetch_range(0, 0, establish_snapshot=True)
        except Exception:
            self.close()
            raise

    def __enter__(self) -> "RemoteZipReader":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @property
    def closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._owns_client:
            self._client.close()

    def readable(self) -> bool:
        return not self._closed

    def seekable(self) -> bool:
        return not self._closed

    def writable(self) -> bool:
        return False

    def tell(self) -> int:
        self._check_open()
        return self._position

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        self._check_open()
        if not isinstance(offset, int):
            raise TypeError("offset must be an integer")
        if whence == os.SEEK_SET:
            position = offset
        elif whence == os.SEEK_CUR:
            position = self._position + offset
        elif whence == os.SEEK_END:
            position = self.archive_size + offset
        else:
            raise ValueError("invalid seek origin")
        if position < 0:
            raise ValueError("negative seek position")
        self._position = position
        return position

    def read(self, size: int = -1) -> bytes:
        self._check_open()
        if not isinstance(size, int):
            raise TypeError("size must be an integer")
        remaining = max(0, self.archive_size - self._position)
        requested = remaining if size < 0 else size
        if requested > MAX_LOGICAL_READ:
            raise RemoteZipError("Remote archive logical read exceeds the safety limit")
        if requested == 0 or remaining == 0:
            return b""
        requested = min(requested, remaining)
        start = self._position
        result = bytearray()
        while len(result) < requested:
            chunk_start = start + len(result)
            chunk_end = min(chunk_start + MAX_NETWORK_RANGE, start + requested) - 1
            result.extend(self._fetch_range(chunk_start, chunk_end))
        self._position += requested
        return bytes(result)

    def _check_open(self) -> None:
        if self._closed:
            raise ValueError("I/O operation on closed remote archive")

    def _is_api_origin(self, url: str) -> bool:
        return _https_origin(url, label="redirect target") == self._api_origin

    def _request_for(self, url: str, start: int, end: int) -> httpx.Request:
        request = self._client.build_request(
            "GET",
            url,
            headers={
                "Range": f"bytes={start}-{end}",
                "Accept-Encoding": "identity",
            },
        )
        # An injected client can carry defaults. Never forward credentials or
        # cookies to signed storage, even after a redirect.
        for header in tuple(request.headers):
            lowered = header.lower()
            if (
                lowered in _STRIPPED_HEADERS
                or any(marker in lowered for marker in ("auth", "key", "token", "secret"))
            ):
                del request.headers[header]
        if self._is_api_origin(url):
            request.headers["X-API-Key"] = self._api_key
        if self.etag:
            request.headers["If-Match"] = self.etag
        return request

    def _fetch_range(self, start: int, end: int, *, establish_snapshot: bool = False) -> bytes:
        if start < 0 or end < start or end - start + 1 > MAX_NETWORK_RANGE:
            raise RemoteZipError("Remote archive range request is invalid")
        if not establish_snapshot:
            if end >= self.archive_size:
                raise RemoteZipError("Remote archive range is outside the snapshot")
        expected_length = end - start + 1
        url = self._download_url
        redirects = 0

        while True:
            response: httpx.Response | None = None
            try:
                request = self._request_for(url, start, end)
                response = self._client.send(request, stream=True, follow_redirects=False)
                if response.status_code in _REDIRECT_CODES:
                    location = response.headers.get("Location")
                    if not location or redirects >= _MAX_REDIRECTS:
                        raise RemoteZipError("Remote archive redirect was rejected")
                    next_url = urljoin(url, location)
                    _https_origin(next_url, label="redirect target")
                    redirects += 1
                    url = next_url
                    continue
                if response.status_code != 206:
                    raise RemoteZipError(
                        f"Remote archive range response was not partial (HTTP {response.status_code})",
                        status_code=response.status_code,
                    )
                return self._validated_body(
                    response,
                    start=start,
                    end=end,
                    expected_length=expected_length,
                    establish_snapshot=establish_snapshot,
                )
            except RemoteZipError:
                raise
            except httpx.HTTPError:
                raise RemoteZipError("Remote archive range request failed") from None
            finally:
                if response is not None:
                    response.close()

    def _validated_body(
        self,
        response: httpx.Response,
        *,
        start: int,
        end: int,
        expected_length: int,
        establish_snapshot: bool,
    ) -> bytes:
        encoding = response.headers.get("Content-Encoding", "identity").strip().lower()
        if encoding not in {"", "identity"}:
            raise RemoteZipError("Remote archive range response used content encoding")

        match = _CONTENT_RANGE.fullmatch(response.headers.get("Content-Range", ""))
        if not match:
            raise RemoteZipError("Remote archive range response had an invalid content range")
        actual_start, actual_end, archive_size = (int(value) for value in match.groups())
        if actual_start != start or actual_end != end or archive_size <= 0:
            raise RemoteZipError("Remote archive range response did not match the request")
        if not establish_snapshot and archive_size != self.archive_size:
            raise RemoteZipError("Remote archive changed while it was being read")

        try:
            content_length = int(response.headers["Content-Length"])
        except (KeyError, ValueError):
            raise RemoteZipError("Remote archive range response had an invalid content length") from None
        if content_length != expected_length:
            raise RemoteZipError("Remote archive range response had an unexpected length")

        etag = response.headers.get("ETag")
        if establish_snapshot:
            if not _is_strong_etag(etag):
                raise RemoteZipError("Remote archive did not provide a strong snapshot validator")
            self.archive_size = archive_size
            self.etag = str(etag)
        elif etag != self.etag:
            raise RemoteZipError("Remote archive changed while it was being read")

        data = bytearray()
        try:
            chunks: Iterator[bytes] = response.iter_raw(chunk_size=min(64 * 1024, expected_length))
            for chunk in chunks:
                data.extend(chunk)
                if len(data) > expected_length:
                    raise RemoteZipError("Remote archive range response exceeded its declared length")
        except httpx.HTTPError:
            raise RemoteZipError("Remote archive range body could not be read") from None
        if len(data) != expected_length:
            raise RemoteZipError("Remote archive range response was truncated")
        return bytes(data)
