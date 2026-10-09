from __future__ import annotations

import asyncio
import hashlib
from typing import Any

import httpx
import pytest

from modules.itglue_api import ITGlueClient, ITGlueError, attributes, scrub_secrets
from modules.migration_core import (
    migration_item_id,
    reconciliation_finding_id,
    safe_file_name,
    source_is_unchanged,
    stable_id,
)


class StaticSourceStream(httpx.AsyncByteStream):
    def __init__(self, body: bytes) -> None:
        self.body = body

    async def __aiter__(self):
        yield self.body


def test_stable_ids_are_repeatable_and_tenant_specific() -> None:
    first = stable_id("org-a", "documents", "42")
    assert first == stable_id("org-a", "documents", "42")
    assert first != stable_id("org-b", "documents", "42")
    assert first != stable_id("org-a", "passwords", "42")
    assert migration_item_id("run-a", "org-a", "documents", "42") != migration_item_id(
        "run-b", "org-a", "documents", "42"
    )
    assert migration_item_id("run-a", "org-a", "documents", "42") != migration_item_id(
        "run-a", "org-b", "documents", "42"
    )


def test_secret_values_are_recursively_redacted() -> None:
    source = {
        "password": "never-table-this",
        "nested": {"otp-secret": "also-secret", "username": "safe"},
        "items": [{"totp_secret": "secret"}],
    }
    assert scrub_secrets(source) == {
        "password": "[REDACTED]",
        "nested": {"otp-secret": "[REDACTED]", "username": "safe"},
        "items": [{"totp_secret": "[REDACTED]"}],
    }


def test_attribute_and_path_normalization() -> None:
    assert attributes({"attributes": {"updated-at": "now", "parent-id": 2}}) == {
        "updated_at": "now",
        "parent_id": 2,
    }
    assert safe_file_name(" ../../unsafe invoice?.pdf ") == "unsafe_invoice_.pdf"
def test_delta_skip_requires_matching_watermarks_and_existing_destination() -> None:
    assert source_is_unchanged("2026-08-13T12:00:00Z", "2026-08-13T12:00:00Z", True)
    assert not source_is_unchanged("2026-08-13T12:00:01Z", "2026-08-13T12:00:00Z", True)
    assert not source_is_unchanged(None, None, True)
    assert not source_is_unchanged("2026-08-13T12:00:00Z", "2026-08-13T12:00:00Z", False)


def test_reconciliation_findings_are_run_and_tenant_specific() -> None:
    first = reconciliation_finding_id("run-a", "org-a", "documents", "42", "source_missing")
    assert first == reconciliation_finding_id("run-a", "org-a", "documents", "42", "source_missing")
    assert first != reconciliation_finding_id("run-b", "org-a", "documents", "42", "source_missing")
    assert first != reconciliation_finding_id("run-a", "org-b", "documents", "42", "source_missing")


def test_pagination_yields_pages_without_accumulating_account() -> None:
    seen_requests: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params["page[number]"])
        seen_requests.append(page)
        payload = {
            "data": [{"id": str(page), "type": "organizations", "attributes": {"name": f"Org {page}"}}]
            if page < 3
            else [],
            "meta": {"total-pages": 2, "total-count": 2},
        }
        return httpx.Response(200, json=payload)

    async def collect() -> list[list[str]]:
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as raw_client:
            client = ITGlueClient("not-a-real-key", page_size=1, client=raw_client)
            pages = []
            async for page in client.iter_pages("/organizations"):
                pages.append([row["id"] for row in page.records])
            return pages

    pages = asyncio.run(collect())

    assert pages == [["1"], ["2"]]
    assert seen_requests == [1, 2]


def test_api_request_does_not_follow_a_cross_origin_redirect_with_the_api_key() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(302, headers={"Location": "https://untrusted.test/collect"})

    async def request() -> None:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            follow_redirects=True,
            headers={"x-api-key": "test-key"},
        ) as raw_client:
            client = ITGlueClient("test-key", client=raw_client)
            await client.get_document("/organizations")

    with pytest.raises(ITGlueError, match="redirect"):
        asyncio.run(request())

    assert [str(request.url) for request in requests] == ["https://api.itglue.com/organizations"]


def test_file_copy_streams_exact_bytes_without_disk(monkeypatch: Any) -> None:
    payload = (b"bifrost-docs-stream" * 4096) + b"tail"
    uploaded: dict[str, Any] = {}
    source_client_type = httpx.AsyncClient

    class SourceStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            for offset in range(0, len(payload), 4096):
                yield payload[offset : offset + 4096]

    def source_handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-api-key"] == "test-key"
        return httpx.Response(
            200,
            headers={"Content-Length": str(len(payload))},
            stream=SourceStream(),
        )

    class DestinationClient:
        def __init__(self, **_: Any) -> None:
            self.source = source_client_type(transport=httpx.MockTransport(source_handler))

        async def __aenter__(self) -> "DestinationClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            await self.source.aclose()
            return None

        async def aclose(self) -> None:
            await self.source.aclose()

        def build_request(self, *args: Any, **kwargs: Any) -> httpx.Request:
            return self.source.build_request(*args, **kwargs)

        async def send(self, *args: Any, **kwargs: Any) -> httpx.Response:
            return await self.source.send(*args, **kwargs)

        async def put(
            self,
            url: str,
            *,
            headers: dict[str, str],
            content: Any,
        ) -> httpx.Response:
            chunks = [chunk async for chunk in content]
            uploaded.update(url=url, headers=headers, chunks=chunks, body=b"".join(chunks))
            return httpx.Response(200, request=httpx.Request("PUT", url))

    async def copy() -> tuple[int, str]:
        transport = httpx.MockTransport(source_handler)
        async with source_client_type(
            transport=transport,
            headers={"x-api-key": "test-key"},
        ) as raw_client:
            client = ITGlueClient("test-key", base_url="https://api.itglue.test", client=raw_client)
            return await client.stream_to_signed_url(
                "https://api.itglue.test/download/1",
                "https://storage.test/upload/1",
                content_type="application/pdf",
                size_bytes=len(payload),
                chunk_size=8192,
            )

    monkeypatch.setattr("modules.itglue_api.httpx.AsyncClient", DestinationClient)
    transferred, sha256, size_verified = asyncio.run(copy())

    assert transferred == len(payload)
    assert uploaded["body"] == payload
    assert uploaded["headers"]["Content-Length"] == str(len(payload))
    assert uploaded["headers"]["Content-Type"] == "application/pdf"
    assert len(uploaded["chunks"]) > 1
    assert sha256 == hashlib.sha256(payload).hexdigest()
    assert size_verified is True


def test_file_copy_retries_undeclared_when_metadata_size_is_stale(monkeypatch: Any) -> None:
    payload = b"stale-size-body" * 1024
    puts: list[dict[str, Any]] = []
    source_client_type = httpx.AsyncClient

    class SourceStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            for offset in range(0, len(payload), 4096):
                yield payload[offset : offset + 4096]

    def source_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"Content-Length": str(len(payload))},
            stream=SourceStream(),
        )

    class DestinationClient:
        def __init__(self, **_: Any) -> None:
            self.source = source_client_type(transport=httpx.MockTransport(source_handler))

        async def __aenter__(self) -> "DestinationClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            await self.source.aclose()
            return None

        async def aclose(self) -> None:
            await self.source.aclose()

        def build_request(self, *args: Any, **kwargs: Any) -> httpx.Request:
            return self.source.build_request(*args, **kwargs)

        async def send(self, *args: Any, **kwargs: Any) -> httpx.Response:
            return await self.source.send(*args, **kwargs)

        async def put(
            self,
            url: str,
            *,
            headers: dict[str, str],
            content: Any,
        ) -> httpx.Response:
            chunks = [chunk async for chunk in content]
            puts.append({"headers": headers, "body": b"".join(chunks)})
            return httpx.Response(200, request=httpx.Request("PUT", url))

    async def copy() -> tuple[int, str, bool]:
        transport = httpx.MockTransport(source_handler)
        async with source_client_type(
            transport=transport,
            headers={"x-api-key": "test-key"},
        ) as raw_client:
            client = ITGlueClient("test-key", base_url="https://api.itglue.test", client=raw_client)
            return await client.stream_to_signed_url(
                "https://api.itglue.test/download/1",
                "https://storage.test/upload/1",
                content_type="application/pdf",
                size_bytes=len(payload) + 500,
                chunk_size=8192,
            )

    monkeypatch.setattr("modules.itglue_api.httpx.AsyncClient", DestinationClient)
    transferred, sha256, size_verified = asyncio.run(copy())

    assert transferred == len(payload)
    assert sha256 == hashlib.sha256(payload).hexdigest()
    assert size_verified is False
    # Strict PUT with the stale size, then a remeasured PUT with the actual
    # body length. The measure pass streams and discards (no third PUT).
    assert len(puts) == 2
    assert puts[0]["headers"]["Content-Length"] == str(len(payload) + 500)
    assert puts[1]["headers"]["Content-Length"] == str(len(payload))
    assert puts[1]["body"] == payload


def test_file_copy_rejects_html_error_for_non_html_attachment_before_put(monkeypatch: Any) -> None:
    error_page = b"<!doctype html><html><body>download failed</body></html>"
    put_attempts = 0
    source_client_type = httpx.AsyncClient

    def source_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"Content-Type": "text/html", "Content-Length": str(len(error_page))},
            stream=StaticSourceStream(error_page),
        )

    class DestinationClient:
        def __init__(self, **_: Any) -> None:
            self.source = source_client_type(transport=httpx.MockTransport(source_handler))

        async def __aenter__(self) -> "DestinationClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            await self.source.aclose()

        async def aclose(self) -> None:
            await self.source.aclose()

        def build_request(self, *args: Any, **kwargs: Any) -> httpx.Request:
            return self.source.build_request(*args, **kwargs)

        async def send(self, *args: Any, **kwargs: Any) -> httpx.Response:
            return await self.source.send(*args, **kwargs)

        async def put(self, *args: Any, **kwargs: Any) -> httpx.Response:
            nonlocal put_attempts
            put_attempts += 1
            return httpx.Response(200, request=httpx.Request("PUT", "https://storage.test/upload/1"))

    async def copy() -> None:
        async with source_client_type(transport=httpx.MockTransport(source_handler)) as raw_client:
            client = ITGlueClient("test-key", base_url="https://api.itglue.test", client=raw_client)
            await client.stream_to_signed_url(
                "https://api.itglue.test/download/1",
                "https://storage.test/upload/1",
                content_type="application/pdf",
                size_bytes=len(error_page),
            )

    monkeypatch.setattr("modules.itglue_api.httpx.AsyncClient", DestinationClient)
    with pytest.raises(ITGlueError, match="unexpected HTML") as exc_info:
        asyncio.run(copy())

    assert put_attempts == 0
    assert "https://" not in str(exc_info.value)
    assert "download failed" not in str(exc_info.value)
    assert "test-key" not in str(exc_info.value)


def test_file_copy_permits_expected_html_attachment(monkeypatch: Any) -> None:
    document = b"<!doctype html><html><body>Guide</body></html>"
    uploaded: list[bytes] = []
    source_client_type = httpx.AsyncClient

    def source_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"Content-Type": "text/html; charset=utf-8", "Content-Length": str(len(document))},
            stream=StaticSourceStream(document),
        )

    class DestinationClient:
        def __init__(self, **_: Any) -> None:
            self.source = source_client_type(transport=httpx.MockTransport(source_handler))

        async def __aenter__(self) -> "DestinationClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            await self.source.aclose()

        async def aclose(self) -> None:
            await self.source.aclose()

        def build_request(self, *args: Any, **kwargs: Any) -> httpx.Request:
            return self.source.build_request(*args, **kwargs)

        async def send(self, *args: Any, **kwargs: Any) -> httpx.Response:
            return await self.source.send(*args, **kwargs)

        async def put(self, url: str, *, content: Any, **kwargs: Any) -> httpx.Response:
            uploaded.append(b"".join([chunk async for chunk in content]))
            return httpx.Response(200, request=httpx.Request("PUT", url))

    async def copy() -> tuple[int, str, bool]:
        async with source_client_type(transport=httpx.MockTransport(source_handler)) as raw_client:
            client = ITGlueClient("test-key", base_url="https://api.itglue.test", client=raw_client)
            return await client.stream_to_signed_url(
                "https://api.itglue.test/download/1",
                "https://storage.test/upload/1",
                content_type="text/html",
                size_bytes=len(document),
            )

    monkeypatch.setattr("modules.itglue_api.httpx.AsyncClient", DestinationClient)
    transferred, sha256, size_verified = asyncio.run(copy())

    assert uploaded == [document]
    assert (transferred, sha256, size_verified) == (
        len(document), hashlib.sha256(document).hexdigest(), True
    )


def test_file_copy_fallback_rejects_html_response_before_retry_put(monkeypatch: Any) -> None:
    first_body = b"original attachment"
    error_page = b"<!doctype html><html><body>expired</body></html>"
    downloads = 0
    put_attempts = 0
    source_client_type = httpx.AsyncClient

    def source_handler(request: httpx.Request) -> httpx.Response:
        nonlocal downloads
        downloads += 1
        body = first_body if downloads == 1 else error_page
        content_type = "application/pdf" if downloads == 1 else "text/html"
        return httpx.Response(
            200,
            headers={"Content-Type": content_type, "Content-Length": str(len(body))},
            stream=StaticSourceStream(body),
        )

    class DestinationClient:
        def __init__(self, **_: Any) -> None:
            self.source = source_client_type(transport=httpx.MockTransport(source_handler))

        async def __aenter__(self) -> "DestinationClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            await self.source.aclose()

        async def aclose(self) -> None:
            await self.source.aclose()

        def build_request(self, *args: Any, **kwargs: Any) -> httpx.Request:
            return self.source.build_request(*args, **kwargs)

        async def send(self, *args: Any, **kwargs: Any) -> httpx.Response:
            return await self.source.send(*args, **kwargs)

        async def put(self, *args: Any, **kwargs: Any) -> httpx.Response:
            nonlocal put_attempts
            put_attempts += 1
            async for _ in kwargs["content"]:
                pass
            return httpx.Response(200, request=httpx.Request("PUT", "https://storage.test/upload/1"))

    async def copy() -> None:
        async with source_client_type(transport=httpx.MockTransport(source_handler)) as raw_client:
            client = ITGlueClient("test-key", base_url="https://api.itglue.test", client=raw_client)
            await client.stream_to_signed_url(
                "https://api.itglue.test/download/1",
                "https://storage.test/upload/1",
                content_type="application/pdf",
                size_bytes=len(first_body) + 1,
            )

    monkeypatch.setattr("modules.itglue_api.httpx.AsyncClient", DestinationClient)
    with pytest.raises(ITGlueError, match="unexpected HTML"):
        asyncio.run(copy())

    assert downloads == 2
    assert put_attempts == 1


def test_file_copy_fallback_rejects_same_size_changed_body(monkeypatch: Any) -> None:
    first_body = b"first source body"
    measured_body = b"measured source!!"
    retry_body = b"retry body wrong!"
    assert len(first_body) == len(measured_body) == len(retry_body)
    downloads = 0
    uploads: list[bytes] = []
    source_client_type = httpx.AsyncClient

    def source_handler(request: httpx.Request) -> httpx.Response:
        nonlocal downloads
        body = (first_body, measured_body, retry_body)[downloads]
        downloads += 1
        return httpx.Response(
            200,
            headers={"Content-Type": "application/pdf", "Content-Length": str(len(body))},
            stream=StaticSourceStream(body),
        )

    class DestinationClient:
        def __init__(self, **_: Any) -> None:
            self.source = source_client_type(transport=httpx.MockTransport(source_handler))

        async def __aenter__(self) -> "DestinationClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            await self.source.aclose()

        async def aclose(self) -> None:
            await self.source.aclose()

        def build_request(self, *args: Any, **kwargs: Any) -> httpx.Request:
            return self.source.build_request(*args, **kwargs)

        async def send(self, *args: Any, **kwargs: Any) -> httpx.Response:
            return await self.source.send(*args, **kwargs)

        async def put(self, url: str, *, content: Any, **kwargs: Any) -> httpx.Response:
            uploads.append(b"".join([chunk async for chunk in content]))
            return httpx.Response(200, request=httpx.Request("PUT", url))

    async def copy() -> None:
        async with source_client_type(transport=httpx.MockTransport(source_handler)) as raw_client:
            client = ITGlueClient("test-key", base_url="https://api.itglue.test", client=raw_client)
            await client.stream_to_signed_url(
                "https://api.itglue.test/download/1",
                "https://storage.test/upload/1",
                content_type="application/pdf",
                size_bytes=len(first_body) + 1,
            )

    monkeypatch.setattr("modules.itglue_api.httpx.AsyncClient", DestinationClient)
    with pytest.raises(ITGlueError, match="body changed"):
        asyncio.run(copy())

    assert downloads == 3
    assert uploads == [first_body, retry_body]


@pytest.mark.parametrize("html", [False, True])
def test_http_gzip_is_decoded_before_file_validation_and_storage(monkeypatch: Any, html: bool) -> None:
    import gzip

    payload = b"<!DOCTYPE html><html><body>Expired download</body></html>" if html else b"%PDF-1.7\nfile bytes\n"
    compressed = gzip.compress(payload)
    client_type = httpx.AsyncClient
    uploaded: list[bytes] = []

    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield compressed

    def source_handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Accept-Encoding"] == "identity"
        return httpx.Response(200, headers={"Content-Encoding": "gzip", "Content-Length": str(len(compressed)), "Content-Type": "application/octet-stream"}, stream=Stream())

    class Client:
        def __init__(self, **_: Any) -> None:
            self.source = client_type(transport=httpx.MockTransport(source_handler))
        async def __aenter__(self):
            return self
        async def __aexit__(self, *_: object):
            await self.source.aclose()
        async def aclose(self):
            await self.source.aclose()
        def build_request(self, *args: Any, **kwargs: Any):
            return self.source.build_request(*args, **kwargs)
        async def send(self, *args: Any, **kwargs: Any):
            return await self.source.send(*args, **kwargs)
        async def put(self, url: str, *, headers: dict[str, str], content: Any):
            assert headers["Content-Length"] == str(len(payload))
            uploaded.append(b"".join([chunk async for chunk in content]))
            return httpx.Response(200, request=httpx.Request("PUT", url))

    async def copy():
        async with client_type(transport=httpx.MockTransport(source_handler)) as raw:
            client = ITGlueClient("fixture", client=raw)
            return await client.stream_to_signed_url("https://source.test/file", "https://storage.test/file", content_type="application/pdf", size_bytes=len(payload))

    monkeypatch.setattr("modules.itglue_api.httpx.AsyncClient", Client)
    if html:
        with pytest.raises(ITGlueError, match="unexpected HTML"):
            asyncio.run(copy())
        assert uploaded == []
    else:
        size, digest, verified = asyncio.run(copy())
        assert (size, digest, verified) == (len(payload), hashlib.sha256(payload).hexdigest(), True)
        assert uploaded == [payload]


def test_file_copy_maps_a_source_fetch_read_timeout_to_a_safe_gateway_error(monkeypatch: Any) -> None:
    real_client = httpx.AsyncClient
    created: list[Any] = []

    class SourceTimeoutClient:
        def __init__(self, **kwargs: Any) -> None:
            self.timeout = kwargs["timeout"]
            self.closed = False
            created.append(self)

        def build_request(self, *args: Any, **kwargs: Any) -> httpx.Request:
            return httpx.Request(*args, **kwargs)

        async def send(self, request: httpx.Request, **_: Any) -> httpx.Response:
            raise httpx.ReadTimeout("source body stalled", request=request)

        async def aclose(self) -> None:
            self.closed = True

    async def copy() -> None:
        async with real_client(transport=httpx.MockTransport(lambda request: httpx.Response(200))) as raw_client:
            client = ITGlueClient("test-key", base_url="https://api.itglue.test", client=raw_client)
            await client.stream_to_signed_url(
                "https://api.itglue.test/download/secret-source",
                "https://storage.test/upload/secret-destination",
            )

    monkeypatch.setattr("modules.itglue_api.httpx.AsyncClient", SourceTimeoutClient)
    with pytest.raises(ITGlueError) as exc_info:
        asyncio.run(copy())

    assert exc_info.value.status_code == 504
    assert "timeout" in str(exc_info.value).lower()
    assert "secret-source" not in str(exc_info.value)
    assert "secret-destination" not in str(exc_info.value)
    assert "test-key" not in str(exc_info.value)
    assert len(created) == 1 and created[0].closed
    assert created[0].timeout.connect == 20.0
    assert created[0].timeout.read == 120.0
    assert created[0].timeout.write == 120.0
    assert created[0].timeout.pool == 20.0


def test_file_copy_maps_midstream_read_and_destination_write_failures_and_closes_clients(monkeypatch: Any) -> None:
    real_client = httpx.AsyncClient

    class StallingStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"source bytes"
            raise httpx.ReadTimeout("source body stalled")

    def run_failure(destination_fails: bool) -> tuple[ITGlueError, list[Any]]:
        created: list[Any] = []

        class TransferClient:
            def __init__(self, **kwargs: Any) -> None:
                self.closed = False
                self.timeout = kwargs["timeout"]
                created.append(self)

            async def __aenter__(self) -> "TransferClient":
                return self

            async def __aexit__(self, *_: object) -> None:
                await self.aclose()

            def build_request(self, *args: Any, **kwargs: Any) -> httpx.Request:
                return httpx.Request(*args, **kwargs)

            async def send(self, request: httpx.Request, **_: Any) -> httpx.Response:
                stream: httpx.AsyncByteStream = StaticSourceStream(b"source bytes") if destination_fails else StallingStream()
                return httpx.Response(200, headers={"Content-Length": "12"}, stream=stream, request=request)

            async def put(self, url: str, *, content: Any, **_: Any) -> httpx.Response:
                async for _ in content:
                    break
                if destination_fails:
                    raise httpx.WriteTimeout("destination stalled", request=httpx.Request("PUT", url))
                return httpx.Response(200, request=httpx.Request("PUT", url))

            async def aclose(self) -> None:
                self.closed = True

        async def copy() -> None:
            async with real_client(transport=httpx.MockTransport(lambda request: httpx.Response(200))) as raw_client:
                client = ITGlueClient("test-key", base_url="https://api.itglue.test", client=raw_client)
                await client.stream_to_signed_url("https://api.itglue.test/download/1", "https://storage.test/upload/1", size_bytes=12)

        monkeypatch.setattr("modules.itglue_api.httpx.AsyncClient", TransferClient)
        with pytest.raises(ITGlueError) as exc_info:
            asyncio.run(copy())
        return exc_info.value, created

    midstream_error, midstream_clients = run_failure(destination_fails=False)
    destination_error, destination_clients = run_failure(destination_fails=True)

    assert midstream_error.status_code == 504
    assert destination_error.status_code == 504
    assert all(client.closed for client in midstream_clients)
    assert all(client.closed for client in destination_clients)


def test_file_copy_remeasure_timeout_closes_initial_source_and_destination_clients(monkeypatch: Any) -> None:
    real_client = httpx.AsyncClient
    created: list[Any] = []
    source_requests = 0

    class TransferClient:
        def __init__(self, **_: Any) -> None:
            self.closed = False
            created.append(self)

        async def __aenter__(self) -> "TransferClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            await self.aclose()

        def build_request(self, *args: Any, **kwargs: Any) -> httpx.Request:
            return httpx.Request(*args, **kwargs)

        async def send(self, request: httpx.Request, **_: Any) -> httpx.Response:
            nonlocal source_requests
            source_requests += 1
            if source_requests == 2:
                raise httpx.ReadTimeout("remeasure source stalled", request=request)
            return httpx.Response(200, headers={"Content-Length": "11"}, stream=StaticSourceStream(b"ten-bytes!"), request=request)

        async def put(self, url: str, **_: Any) -> httpx.Response:
            return httpx.Response(200, request=httpx.Request("PUT", url))

        async def aclose(self) -> None:
            self.closed = True

    async def copy() -> None:
        async with real_client(transport=httpx.MockTransport(lambda request: httpx.Response(200))) as raw_client:
            client = ITGlueClient("test-key", base_url="https://api.itglue.test", client=raw_client)
            await client.stream_to_signed_url("https://api.itglue.test/download/1", "https://storage.test/upload/1", size_bytes=11)

    monkeypatch.setattr("modules.itglue_api.httpx.AsyncClient", TransferClient)
    with pytest.raises(ITGlueError) as exc_info:
        asyncio.run(copy())

    assert exc_info.value.status_code == 504
    assert source_requests == 2
    assert len(created) == 3
    assert all(client.closed for client in created)
