"""Internal bridges for managed-file operations missing from the public SDK."""

from __future__ import annotations

import re

from bifrost.client import get_client, raise_for_status_with_detail
from bifrost.files import _solution_query

_SHA256 = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)


async def complete_signed_upload(
    *,
    path: str,
    location: str,
    scope: str | None,
    content_type: str,
    size_bytes: int,
    sha256: str,
) -> None:
    """Finalize verified bytes uploaded through a presigned PUT.

    ``bifrost.files.get_signed_url`` deliberately exposes only URL issuance in
    the public Python SDK. The browser SDK also calls ``complete-upload`` so
    the platform records file metadata used by backups and file inventory.
    This small bridge retains the injected authenticated client and the SDK's
    private solution/caller query context until that public SDK operation is
    available.
    """
    if size_bytes < 0:
        raise ValueError("size_bytes must be non-negative")
    if not _SHA256.fullmatch(sha256):
        raise ValueError("sha256 must be a 64-character hexadecimal digest")

    response = await get_client().post(
        f"/api/files/complete-upload{_solution_query()}",
        json={
            "path": path,
            "location": location,
            "scope": scope,
            "content_type": content_type,
            "size_bytes": size_bytes,
            "sha256": sha256,
        },
    )
    raise_for_status_with_detail(response)
