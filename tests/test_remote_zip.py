from __future__ import annotations

import struct
import zipfile

import httpx
import pytest

from modules.remote_zip import (
    MAX_LOGICAL_READ,
    MAX_NETWORK_RANGE,
    RemoteZipError,
    RemoteZipReader,
)


class CloseAwareStream(httpx.SyncByteStream):
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.iterated = False
        self.closed = False

    def __iter__(self):
        self.iterated = True
        yield self.body

    def close(self) -> None:
        self.closed = True


def _sparse_zip() -> tuple[int, dict[int, bytes]]:
    """Return a valid ZIP whose selected member starts beyond 3 GiB."""
    name = b"selected.txt"
    body = b"selected entry bytes"
    offset = 3 * 1024 * 1024 * 1024
    crc = __import__("zlib").crc32(body) & 0xFFFFFFFF
    local = struct.pack(
        "<IHHHHHIIIHH",
        0x04034B50,
        20,
        0,
        0,
        0,
        0,
        crc,
        len(body),
        len(body),
        len(name),
        0,
    ) + name + body
    central_offset = offset + len(local)
    central = struct.pack(
        "<IHHHHHHIIIHHHHHII",
        0x02014B50,
        20,
        20,
        0,
        0,
        0,
        0,
        crc,
        len(body),
        len(body),
        len(name),
        0,
        0,
        0,
        0,
        0,
        offset,
    ) + name
    end = struct.pack(
        "<IHHHHIIH",
        0x06054B50,
        0,
        0,
        1,
        1,
        len(central),
        central_offset,
        0,
    )
    return central_offset + len(central) + len(end), {
        offset: local,
        central_offset: central,
        central_offset + len(central): end,
    }


def _sparse_zip64() -> tuple[int, dict[int, bytes]]:
    """Return a ZIP64 archive with one small entry beyond six logical GiB."""
    name = b"selected-zip64.txt"
    body = b"ZIP64 selected entry bytes"
    offset = 6 * 1024 * 1024 * 1024
    crc = __import__("zlib").crc32(body) & 0xFFFFFFFF
    local = struct.pack(
        "<IHHHHHIIIHH",
        0x04034B50,
        45,
        0,
        0,
        0,
        0,
        crc,
        len(body),
        len(body),
        len(name),
        0,
    ) + name + body
    central_offset = offset + len(local)
    zip64_offset_extra = struct.pack("<HHQ", 0x0001, 8, offset)
    central = struct.pack(
        "<IHHHHHHIIIHHHHHII",
        0x02014B50,
        45,
        45,
        0,
        0,
        0,
        0,
        crc,
        len(body),
        len(body),
        len(name),
        len(zip64_offset_extra),
        0,
        0,
        0,
        0,
        0xFFFFFFFF,
    ) + name + zip64_offset_extra
    zip64_end_offset = central_offset + len(central)
    zip64_end = struct.pack(
        "<IQHHIIQQQQ",
        0x06064B50,
        44,
        45,
        45,
        0,
        0,
        1,
        1,
        len(central),
        central_offset,
    )
    zip64_locator = struct.pack("<IIQI", 0x07064B50, 0, zip64_end_offset, 1)
    end = struct.pack(
        "<IHHHHIIH",
        0x06054B50,
        0,
        0,
        0xFFFF,
        0xFFFF,
        0xFFFFFFFF,
        0xFFFFFFFF,
        0,
    )
    return zip64_end_offset + len(zip64_end) + len(zip64_locator) + len(end), {
        offset: local,
        central_offset: central,
        zip64_end_offset: zip64_end,
        zip64_end_offset + len(zip64_end): zip64_locator,
        zip64_end_offset + len(zip64_end) + len(zip64_locator): end,
    }


def _sparse_slice(segments: dict[int, bytes], start: int, end: int) -> bytes:
    result = bytearray(end - start + 1)
    for offset, data in segments.items():
        overlap_start = max(start, offset)
        overlap_end = min(end + 1, offset + len(data))
        if overlap_start < overlap_end:
            result[overlap_start - start : overlap_end - start] = data[
                overlap_start - offset : overlap_end - offset
            ]
    return bytes(result)


def _range_bounds(request: httpx.Request) -> tuple[int, int]:
    header = request.headers["Range"]
    assert header.startswith("bytes=")
    start, end = header[6:].split("-", 1)
    return int(start), int(end)


def _range_response(
    request: httpx.Request,
    *,
    body: bytes,
    start: int,
    end: int,
    archive_size: int,
    etag: str = '"stable-v1"',
    extra_headers: dict[str, str] | None = None,
) -> httpx.Response:
    headers = {
        "Content-Range": f"bytes {start}-{end}/{archive_size}",
        "Content-Length": str(len(body)),
        "ETag": etag,
    }
    headers.update(extra_headers or {})
    return httpx.Response(206, headers=headers, stream=httpx.ByteStream(body), request=request)


def test_zipfile_reads_sparse_multi_gib_archive_in_bounded_ranges() -> None:
    archive_size, segments = _sparse_zip()
    requests: list[httpx.Request] = []
    responses: list[httpx.Response] = []

    def handler(request: httpx.Request) -> httpx.Response:
        start, end = _range_bounds(request)
        requests.append(request)
        response = _range_response(
            request,
            body=_sparse_slice(segments, start, end),
            start=start,
            end=end,
            archive_size=archive_size,
        )
        responses.append(response)
        return response

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        reader = RemoteZipReader(
            "https://api.example.test/exports/42/download?temporary=ignored",
            api_origin="https://api.example.test",
            api_key="test-api-key",
            client=client,
        )
        with zipfile.ZipFile(reader) as archive:
            assert archive.namelist() == ["selected.txt"]
            assert archive.read("selected.txt") == b"selected entry bytes"
        assert reader.archive_size == archive_size
        assert reader.etag == '"stable-v1"'
        reader.close()

    assert archive_size > 2**31
    assert requests
    assert all(end - start + 1 <= MAX_NETWORK_RANGE for start, end in map(_range_bounds, requests))
    assert sum(end - start + 1 for start, end in map(_range_bounds, requests)) < 4 * MAX_NETWORK_RANGE
    assert all(response.is_closed for response in responses)


def test_zipfile_reads_sparse_zip64_archive_in_bounded_ranges() -> None:
    archive_size, segments = _sparse_zip64()
    requests: list[httpx.Request] = []
    responses: list[httpx.Response] = []

    def handler(request: httpx.Request) -> httpx.Response:
        start, end = _range_bounds(request)
        requests.append(request)
        response = _range_response(
            request,
            body=_sparse_slice(segments, start, end),
            start=start,
            end=end,
            archive_size=archive_size,
        )
        responses.append(response)
        return response

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        reader = RemoteZipReader(
            "https://api.example.test/exports/zip64/download?temporary=ignored",
            api_origin="https://api.example.test",
            api_key="test-api-key",
            client=client,
        )
        with zipfile.ZipFile(reader) as archive:
            assert archive.namelist() == ["selected-zip64.txt"]
            assert archive.getinfo("selected-zip64.txt").header_offset == 6 * 1024 * 1024 * 1024
            assert archive.read("selected-zip64.txt") == b"ZIP64 selected entry bytes"
        assert reader.archive_size == archive_size
        assert reader.etag == '"stable-v1"'
        reader.close()

    assert archive_size > 2**32
    assert requests
    assert all(end - start + 1 <= MAX_NETWORK_RANGE for start, end in map(_range_bounds, requests))
    assert sum(end - start + 1 for start, end in map(_range_bounds, requests)) < 6 * MAX_NETWORK_RANGE
    assert all(request.headers["If-Match"] == '"stable-v1"' for request in requests[1:])
    assert all(response.is_closed for response in responses)


def test_rejects_200_range_response_without_consuming_its_body() -> None:
    stream = CloseAwareStream(b"response body must never be read")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream, request=request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(RemoteZipError, match="range response"):
            RemoteZipReader(
                "https://storage.example.test/archive",
                api_origin="https://api.example.test",
                api_key="test-api-key",
                client=client,
            )

    assert not stream.iterated
    assert stream.closed


def test_redirect_strips_default_credentials_before_signed_storage_request() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.host == "api.example.test":
            return httpx.Response(
                302,
                headers={"Location": "https://storage.example.test/archive?signature=hidden"},
                request=request,
            )
        start, end = _range_bounds(request)
        return _range_response(
            request,
            body=b"x",
            start=start,
            end=end,
            archive_size=1,
        )

    with httpx.Client(
        transport=httpx.MockTransport(handler),
        headers={"Authorization": "Bearer default-secret", "X-Api-Key": "default-key"},
    ) as client:
        reader = RemoteZipReader(
            "https://api.example.test/exports/42/download",
            api_origin="https://api.example.test",
            api_key="test-api-key",
            client=client,
        )
        reader.close()

    assert requests[0].headers["x-api-key"] == "test-api-key"
    assert "authorization" not in requests[0].headers
    assert "x-api-key" not in requests[1].headers
    assert "authorization" not in requests[1].headers


def test_rejects_non_https_redirect_without_following_it() -> None:
    responses: list[httpx.Response] = []

    def handler(request: httpx.Request) -> httpx.Response:
        response = httpx.Response(
            302,
            headers={"Location": "http://storage.example.test/archive"},
            request=request,
        )
        responses.append(response)
        return response

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ValueError, match="HTTPS"):
            RemoteZipReader(
                "https://api.example.test/exports/42/download",
                api_origin="https://api.example.test",
                api_key="test-api-key",
                client=client,
            )

    assert len(responses) == 1
    assert responses[0].is_closed


def test_refuses_changed_etag_and_does_not_expose_sensitive_values() -> None:
    calls = 0
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        requests.append(request)
        start, end = _range_bounds(request)
        return _range_response(
            request,
            body=b"ab"[start : end + 1],
            start=start,
            end=end,
            archive_size=2,
            etag='"stable-v1"' if calls == 1 else '"changed-v2"',
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        reader = RemoteZipReader(
            "https://storage.example.test/archive?signature=do-not-leak",
            api_origin="https://api.example.test",
            api_key="api-key-do-not-leak",
            client=client,
        )
        reader.seek(1)
        with pytest.raises(RemoteZipError) as error:
            reader.read(1)
        reader.close()

    assert requests[1].headers["If-Match"] == '"stable-v1"'
    message = str(error.value)
    assert "do-not-leak" not in message
    assert "api-key-do-not-leak" not in message


@pytest.mark.parametrize(
    ("headers", "body"),
    [
        ({"Content-Range": "bytes malformed", "Content-Length": "1", "ETag": '"stable-v1"'}, b"x"),
        (
            {
                "Content-Range": "bytes 0-0/1",
                "Content-Length": "1",
                "Content-Encoding": "gzip",
                "ETag": '"stable-v1"',
            },
            b"x",
        ),
        ({"Content-Range": "bytes 0-0/1", "Content-Length": "1", "ETag": '"stable-v1"'}, b""),
    ],
)
def test_rejects_malformed_encoded_or_truncated_range_response(
    headers: dict[str, str], body: bytes
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(206, headers=headers, stream=httpx.ByteStream(body), request=request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(RemoteZipError):
            RemoteZipReader(
                "https://storage.example.test/archive",
                api_origin="https://api.example.test",
                api_key="test-api-key",
                client=client,
            )


def test_rejects_oversized_logical_reads_without_a_request() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        start, end = _range_bounds(request)
        return _range_response(
            request,
            body=b"x",
            start=start,
            end=end,
            archive_size=MAX_LOGICAL_READ + 1,
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        reader = RemoteZipReader(
            "https://storage.example.test/archive",
            api_origin="https://api.example.test",
            api_key="test-api-key",
            client=client,
        )
        with pytest.raises(RemoteZipError, match="logical read"):
            reader.read(MAX_LOGICAL_READ + 1)
        reader.close()

    assert len(requests) == 1


def test_splits_a_permitted_logical_read_into_one_mebibyte_ranges() -> None:
    requests: list[httpx.Request] = []
    archive_size = MAX_NETWORK_RANGE + 2

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        start, end = _range_bounds(request)
        return _range_response(
            request,
            body=b"x" * (end - start + 1),
            start=start,
            end=end,
            archive_size=archive_size,
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        reader = RemoteZipReader(
            "https://storage.example.test/archive",
            api_origin="https://api.example.test",
            api_key="test-api-key",
            client=client,
        )
        assert reader.read(archive_size) == b"x" * archive_size
        reader.close()

    assert [_range_bounds(request) for request in requests] == [
        (0, 0),
        (0, MAX_NETWORK_RANGE - 1),
        (MAX_NETWORK_RANGE, MAX_NETWORK_RANGE + 1),
    ]
    assert requests[1].headers["If-Match"] == '"stable-v1"'
    assert requests[2].headers["If-Match"] == '"stable-v1"'
