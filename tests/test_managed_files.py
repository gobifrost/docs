from __future__ import annotations

import pytest

from modules import managed_files


@pytest.mark.asyncio
async def test_complete_signed_upload_uses_authenticated_solution_context_and_verified_metadata(monkeypatch) -> None:
    """The private SDK bridge must preserve execution identity and target scope."""
    calls: list[tuple[str, dict]] = []

    class Response:
        is_success = True
        status_code = 204

    class Client:
        async def post(self, url: str, *, json: dict):
            calls.append((url, json))
            return Response()

    monkeypatch.setattr(managed_files, "get_client", lambda: Client())
    monkeypatch.setattr(
        managed_files,
        "_solution_query",
        lambda: "?solution=solution-1&caller_solution=caller-1",
    )

    await managed_files.complete_signed_upload(
        path="org-a/itglue/documents/doc-1/attachment-1/guide.pdf",
        location="docs-attachments",
        scope="org-a",
        content_type="application/pdf",
        size_bytes=42,
        sha256="a" * 64,
    )

    assert calls == [
        (
            "/api/files/complete-upload?solution=solution-1&caller_solution=caller-1",
            {
                "path": "org-a/itglue/documents/doc-1/attachment-1/guide.pdf",
                "location": "docs-attachments",
                "scope": "org-a",
                "content_type": "application/pdf",
                "size_bytes": 42,
                "sha256": "a" * 64,
            },
        )
    ]
