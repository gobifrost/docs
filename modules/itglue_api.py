"""Bounded-memory IT Glue JSON:API client used by migration workflows."""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urljoin, urlparse

import h11
import httpcore
import httpx


_HTML_SIGNATURE_BYTES = 1024
_HTML_SIGNATURES = (b"<!doctype html", b"<html", b"<head", b"<body")
_TRANSFER_TIMEOUT = httpx.Timeout(connect=20.0, read=120.0, write=120.0, pool=20.0)


class ITGlueError(RuntimeError):
    """Safe-to-report IT Glue error that never includes credentials or bodies."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class SizeMismatchError(ITGlueError):
    """Declared file size disagreed with the transferred body (stale metadata)."""


def _safe_transfer_request_error(exc: httpx.RequestError) -> ITGlueError:
    """Classify stream transport failures without exposing signed URLs or bodies."""
    if isinstance(exc, httpx.TimeoutException):
        return ITGlueError("[xfer-v7] File transfer timeout", status_code=504)
    return ITGlueError("[xfer-v7] File transfer network request failed", status_code=503)


@dataclass(frozen=True)
class ITGluePage:
    number: int
    records: list[dict[str, Any]]
    included: list[dict[str, Any]]
    total_pages: int | None
    total_count: int | None


def attributes(resource: Mapping[str, Any]) -> dict[str, Any]:
    """Return a normalized copy of a JSON:API resource's attributes."""
    raw = resource.get("attributes")
    if not isinstance(raw, Mapping):
        return {}
    return {str(key).replace("-", "_"): value for key, value in raw.items()}


def resource_id(resource: Mapping[str, Any]) -> str:
    value = resource.get("id")
    if value is None or str(value).strip() == "":
        raise ITGlueError("IT Glue returned a resource without an id")
    return str(value)


def scrub_secrets(value: Any) -> Any:
    """Remove password/TOTP-like values before data can enter tables or logs."""
    secret_keys = {
        "password",
        "password_value",
        "password-value",
        "otp_secret",
        "otp-secret",
        "totp_secret",
        "totp-secret",
        "download_url",
        "download-url",
        "original_src",
        "original-src",
    }
    if isinstance(value, Mapping):
        return {
            str(key): "[REDACTED]" if str(key).lower() in secret_keys else scrub_secrets(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [scrub_secrets(item) for item in value]
    return value


@dataclass
class _SourceFetch:
    """An open streaming source download; close when the body is consumed."""

    client: httpx.AsyncClient
    response: httpx.Response
    resolved_source: str
    source_headers: dict[str, str]

    async def aclose(self) -> None:
        try:
            await self.response.aclose()
        finally:
            await self.client.aclose()


class ITGlueClient:
    """Async client with pagination, throttling retries, and streamed file copies."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = "https://api.itglue.com",
        timeout_seconds: float = 60.0,
        page_size: int = 1000,
        max_retries: int = 7,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        if page_size < 1 or page_size > 1000:
            raise ValueError("page_size must be between 1 and 1000")
        self.base_url = base_url.rstrip("/") + "/"
        self.page_size = page_size
        self.max_retries = max_retries
        self._api_key = api_key
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds, connect=20.0),
            follow_redirects=False,
            headers={
                "x-api-key": api_key,
                "Accept": "application/vnd.api+json",
                "User-Agent": "Bifrost-Docs-Migration/0.1",
            },
        )

    async def __aenter__(self) -> "ITGlueClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        if self._owns_client:
            await self._client.aclose()

    def _url(self, path_or_url: str) -> str:
        if path_or_url.startswith(("https://", "http://")):
            return path_or_url
        return urljoin(self.base_url, path_or_url.lstrip("/"))

    @staticmethod
    def _retry_delay(response: httpx.Response | None, attempt: int) -> float:
        if response is not None:
            raw = response.headers.get("Retry-After")
            if raw:
                try:
                    return max(0.0, min(float(raw), 120.0))
                except ValueError:
                    try:
                        parsed = parsedate_to_datetime(raw)
                        return max(0.0, min((parsed.timestamp() - __import__("time").time()), 120.0))
                    except (TypeError, ValueError, OverflowError):
                        pass
        return min(2**attempt, 60) + (attempt * 0.137)

    async def request(
        self,
        method: str,
        path_or_url: str,
        *,
        params: Mapping[str, Any] | None = None,
    ) -> httpx.Response:
        response: httpx.Response | None = None
        for attempt in range(self.max_retries + 1):
            try:
                response = await self._client.request(
                    method, self._url(path_or_url), params=params, follow_redirects=False
                )
            except httpx.TransportError as exc:
                if attempt >= self.max_retries:
                    raise ITGlueError(f"IT Glue transport failed after {attempt + 1} attempts") from exc
                await asyncio.sleep(self._retry_delay(None, attempt))
                continue

            if response.status_code not in {408, 425, 429, 500, 502, 503, 504}:
                break
            if attempt >= self.max_retries:
                break
            delay = self._retry_delay(response, attempt)
            await response.aclose()
            await asyncio.sleep(delay)

        if response is None:
            raise ITGlueError("IT Glue request failed without a response")
        if response.is_redirect:
            await response.aclose()
            raise ITGlueError("IT Glue API redirected the request")
        if response.is_error:
            request_id = response.headers.get("X-Request-Id") or response.headers.get("X-Trace-Id")
            suffix = f" (request {request_id})" if request_id else ""
            raise ITGlueError(
                f"IT Glue returned HTTP {response.status_code}{suffix}",
                status_code=response.status_code,
            )
        return response

    async def get_document(
        self,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        response = await self.request("GET", path, params=params)
        try:
            payload = response.json()
        except ValueError as exc:
            raise ITGlueError("IT Glue returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise ITGlueError("IT Glue returned an unexpected JSON document")
        return payload

    async def iter_pages(
        self,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        start_page: int = 1,
    ) -> AsyncIterator[ITGluePage]:
        page_number = max(1, int(start_page))
        while True:
            page_params = dict(params or {})
            page_params["page[number]"] = page_number
            page_params["page[size]"] = self.page_size
            payload = await self.get_document(path, params=page_params)
            data = payload.get("data") or []
            if not isinstance(data, list):
                raise ITGlueError("IT Glue list endpoint returned non-list data")
            included = payload.get("included") or []
            if not isinstance(included, list):
                included = []
            meta = payload.get("meta") if isinstance(payload.get("meta"), Mapping) else {}
            total_pages = _as_int(meta.get("total-pages") or meta.get("total_pages"))
            total_count = _as_int(meta.get("total-count") or meta.get("total_count"))
            yield ITGluePage(page_number, data, included, total_pages, total_count)
            if not data or len(data) < self.page_size:
                break
            if total_pages is not None and page_number >= total_pages:
                break
            page_number += 1

    async def stream_to_signed_url(
        self,
        source_url: str,
        destination_url: str,
        *,
        content_type: str = "application/octet-stream",
        size_bytes: int | None = None,
        chunk_size: int = 1024 * 1024,
    ) -> tuple[int, str, bool]:
        """Forward a source download to storage without buffering the file or using disk.

        Returns ``(transferred_bytes, sha256_hex, size_verified)``. The first
        attempt declares IT Glue's metadata size so a truncated or over-long
        body fails loud. If the body disagrees with the declared size (IT Glue
        metadata is stale for some files), fall back to a two-pass transfer:
        measure the source body first, then PUT with the measured length.
        The stored row keeps both the declared and actual byte counts with
        ``size_verified=False``.
        """
        try:
            attempt = await self._fetch_response(source_url)
            try:
                try:
                    transferred, digest = await self._forward_file_response(
                        attempt.response, destination_url, content_type=content_type,
                        size_bytes=size_bytes, chunk_size=chunk_size,
                    )
                    return transferred, digest, size_bytes is None or transferred == size_bytes
                except (httpx.LocalProtocolError, httpcore.LocalProtocolError, h11.LocalProtocolError, SizeMismatchError) as first_exc:
                    # The body disagreed with the declared size — or with the
                    # source's own response headers when no metadata size exists.
                    # Measure the source body (still bounded-memory: stream, hash,
                    # discard), then PUT with the measured length.
                    measured, measured_digest = await self._measure_source(
                        attempt.resolved_source, attempt.source_headers,
                        expected_content_type=content_type,
                        declared_size=size_bytes, chunk_size=chunk_size,
                    )
                    await attempt.response.aclose()
                    second = await self._fetch_response(
                        source_url, resolved=attempt.resolved_source, headers=attempt.source_headers
                    )
                    try:
                        transferred, digest = await self._forward_file_response(
                            second.response, destination_url, content_type=content_type,
                            size_bytes=measured, chunk_size=chunk_size,
                        )
                    except (httpx.LocalProtocolError, httpcore.LocalProtocolError, h11.LocalProtocolError, SizeMismatchError) as second_exc:
                        raise ITGlueError(
                            "[xfer-v7] File transfer failed after remeasuring "
                            f"(metadata_bytes={size_bytes}, measured_bytes={measured}, "
                            f"first_error={type(first_exc).__name__}, "
                            f"retry_error={type(second_exc).__name__})"
                        ) from second_exc
                    finally:
                        await second.aclose()
                    if digest != measured_digest:
                        raise ITGlueError(
                            "[xfer-v7] File transfer retry body changed after measurement "
                            f"(measured_bytes={measured}, retry_bytes={transferred})"
                        )
                    return transferred, digest, False
            finally:
                await attempt.aclose()
        except httpx.RequestError as exc:
            raise _safe_transfer_request_error(exc) from exc

    async def _fetch_response(
        self,
        source_url: str,
        *,
        resolved: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> _SourceFetch:
        """Open a streaming source GET, following redirects without the API key.

        Attachment URLs are commonly signed storage URLs. Never send the API
        key to one, or carry it across a redirect from the API host. The
        caller owns the returned fetch and must aclose it.
        """
        resolved_source = resolved or self._url(source_url)
        api_origin = urlparse(self.base_url)
        if headers is None:
            source_origin = urlparse(resolved_source)
            headers = (
                {"x-api-key": self._api_key}
                if (source_origin.scheme, source_origin.netloc)
                == (api_origin.scheme, api_origin.netloc)
                else {}
            )
        source_client = httpx.AsyncClient(timeout=_TRANSFER_TIMEOUT, follow_redirects=False)
        try:
            for _ in range(5):
                request = source_client.build_request(
                    "GET", resolved_source, headers={"Accept-Encoding": "identity", **headers}
                )
                response = await source_client.send(request, stream=True)
                if response.status_code not in {301, 302, 303, 307, 308}:
                    break
                redirect = response.headers.get("Location")
                await response.aclose()
                if not redirect:
                    raise ITGlueError("IT Glue file download redirected without a location")
                resolved_source = urljoin(resolved_source, redirect)
                headers = (
                    {"x-api-key": self._api_key}
                    if (urlparse(resolved_source).scheme, urlparse(resolved_source).netloc)
                    == (api_origin.scheme, api_origin.netloc)
                    else {}
                )
            else:
                raise ITGlueError("IT Glue file download redirected too many times")
            return _SourceFetch(source_client, response, resolved_source, headers)
        except Exception:
            await source_client.aclose()
            raise

    async def _measure_source(
        self,
        resolved_source: str,
        source_headers: dict[str, str],
        *,
        expected_content_type: str,
        declared_size: int | None,
        chunk_size: int,
    ) -> tuple[int, str]:
        """Stream the source body to /dev/null, returning (bytes, sha256)."""
        fetch = await self._fetch_response(
            resolved_source, resolved=resolved_source, headers=source_headers
        )
        digest = hashlib.sha256()
        measured = 0
        try:
            if not fetch.response.is_success:
                raise ITGlueError(
                    f"IT Glue file download returned HTTP {fetch.response.status_code}",
                    status_code=fetch.response.status_code,
                )
            leading_chunks, remaining_chunks = await _read_leading_chunks(
                fetch.response, chunk_size=chunk_size
            )
            _reject_unexpected_html(
                expected_content_type, fetch.response.headers.get("Content-Type"), leading_chunks
            )
            for chunk in leading_chunks:
                digest.update(chunk)
                measured += len(chunk)
            async for chunk in remaining_chunks:
                if not chunk:
                    continue
                digest.update(chunk)
                measured += len(chunk)
            return measured, digest.hexdigest()
        except (httpx.LocalProtocolError, httpcore.LocalProtocolError, h11.LocalProtocolError) as exc:
            raise ITGlueError(
                "[xfer-v7] IT Glue file body disagrees with its response headers "
                f"(received_bytes={measured}, metadata_bytes={declared_size}, "
                f"error={type(exc).__name__})"
            ) from exc
        finally:
            await fetch.aclose()

    async def _forward_file_response(
        self,
        source: httpx.Response,
        destination_url: str,
        *,
        content_type: str,
        size_bytes: int | None,
        chunk_size: int,
    ) -> tuple[int, str]:
        digest = hashlib.sha256()
        transferred = 0
        if not source.is_success:
            raise ITGlueError(
                f"IT Glue file download returned HTTP {source.status_code}",
                status_code=source.status_code,
            )
        leading_chunks, remaining_chunks = await _read_leading_chunks(source, chunk_size=chunk_size)
        _reject_unexpected_html(
            content_type, source.headers.get("Content-Type"), leading_chunks
        )

        async def chunks() -> AsyncIterator[bytes]:
            nonlocal transferred
            for chunk in leading_chunks:
                digest.update(chunk)
                transferred += len(chunk)
                yield chunk
            # Decode HTTP content encoding; storage must contain the original file,
            # not a compressed transport envelope (IT Glue can gzip error pages).
            async for chunk in remaining_chunks:
                if not chunk:
                    continue
                digest.update(chunk)
                transferred += len(chunk)
                yield chunk

        headers = {"Content-Type": content_type or "application/octet-stream"}
        actual_size = size_bytes
        if actual_size is None and source.headers.get("Content-Encoding", "identity").lower() == "identity":
            actual_size = _as_int(source.headers.get("Content-Length"))
        if actual_size is not None:
            headers["Content-Length"] = str(actual_size)
        async with httpx.AsyncClient(timeout=_TRANSFER_TIMEOUT, follow_redirects=False) as destination_client:
            response = await destination_client.put(destination_url, headers=headers, content=chunks())
            try:
                if not response.is_success:
                    raise ITGlueError(f"Managed-file upload returned HTTP {response.status_code}")
            finally:
                await response.aclose()
        if size_bytes is not None and transferred != size_bytes:
            raise SizeMismatchError(
                f"File transfer size mismatch: expected {size_bytes} bytes, received {transferred}"
            )
        return transferred, digest.hexdigest()


def _as_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


async def _read_leading_chunks(
    source: httpx.Response, *, chunk_size: int
) -> tuple[list[bytes], AsyncIterator[bytes]]:
    """Read a small source prefix so HTML errors are caught before the destination PUT."""
    iterator = source.aiter_bytes(chunk_size=max(1, min(chunk_size, _HTML_SIGNATURE_BYTES)))
    chunks: list[bytes] = []
    prefix_size = 0
    while prefix_size < _HTML_SIGNATURE_BYTES:
        try:
            chunk = await anext(iterator)
        except StopAsyncIteration:
            break
        if not chunk:
            continue
        chunks.append(chunk)
        prefix_size += len(chunk)
    return chunks, iterator


def _reject_unexpected_html(
    expected_content_type: str, response_content_type: str | None, leading_chunks: list[bytes]
) -> None:
    """Reject a likely HTML error page without including URLs or response content in errors."""
    if _mime_is_html(expected_content_type):
        return
    response_html = _mime_is_html(response_content_type)
    leading_html = _has_html_signature(b"".join(leading_chunks)[:_HTML_SIGNATURE_BYTES])
    if response_html or leading_html:
        raise ITGlueError(
            "[xfer-v7] File transfer rejected unexpected HTML "
            f"(response_html={response_html}, leading_html={leading_html})"
        )


def _mime_is_html(value: str | None) -> bool:
    mime_type = str(value or "").split(";", 1)[0].strip().casefold()
    return mime_type in {"text/html", "application/xhtml+xml"}


def _has_html_signature(value: bytes) -> bool:
    leading = value.lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    return any(leading.startswith(signature) for signature in _HTML_SIGNATURES)
