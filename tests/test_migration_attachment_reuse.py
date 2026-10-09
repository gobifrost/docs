"""A verified source projection remains reusable when IT Glue omits timestamps."""
from types import SimpleNamespace

import pytest

from functions import migration
from modules.migration_core import stable_id


@pytest.mark.asyncio
@pytest.mark.parametrize("changed_metadata", [False, True])
async def test_verified_attachment_without_timestamp_reuses_only_exact_source_projection(monkeypatch, changed_metadata):
    source = {"id": "attachment-1", "attributes": {
        "download-url": "https://source.invalid/download", "attachment-file-name": "guide.pdf",
        "attachment-file-size": 3,
    }}
    attachment_id = stable_id("org-a", "attachment", "attachment-1")
    path = migration._attachment_storage_path("org-a", "documents", "parent", attachment_id, "guide.pdf", source)
    prior = {"storage_path": path, "storage_location": "docs-attachments", "transfer_version": migration.TRANSFER_VERSION,
             "metadata_registered": True, "sha256": "a" * 64, "quarantined": False}
    async def get(*args, **kwargs): return SimpleNamespace(data=prior)
    async def exists(*args, **kwargs): return True
    async def signed_url(*args, **kwargs): raise RuntimeError("transfer_attempted")
    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.files, "exists", exists)
    monkeypatch.setattr(migration.files, "get_signed_url", signed_url)
    if changed_metadata:
        source["attributes"]["attachment-file-size"] = 4
        with pytest.raises(RuntimeError, match="transfer_attempted"):
            await migration._transfer_file(SimpleNamespace(), "org-a", "documents", "parent", source, file_kind="attachment")
    else:
        await migration._transfer_file(SimpleNamespace(), "org-a", "documents", "parent", source, file_kind="attachment")
