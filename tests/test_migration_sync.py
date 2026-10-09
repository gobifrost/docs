from __future__ import annotations

from types import SimpleNamespace

import pytest

from functions import migration
from modules.itglue_api import ITGlueError, ITGluePage
from modules.migration_core import (
    RESOURCE_SPECS,
    canonical_source_fingerprint,
    migration_cursor_key,
    source_map_id,
    stable_id,
)

SHA256 = "a" * 64


async def _complete_upload(**kwargs) -> None:
    return None


def _spec(name: str):
    return next(item for item in RESOURCE_SPECS if item.name == name)


@pytest.mark.asyncio
async def test_customer_docs_admin_cannot_access_migration_tools(monkeypatch) -> None:
    """Role membership alone must never permit global mapping or run access."""
    monkeypatch.setattr(migration.context, "is_platform_admin", False, raising=False)
    monkeypatch.setattr(
        migration.context, "organization", SimpleNamespace(is_provider=False), raising=False
    )

    calls = [
        migration.docs_migration_preflight(),
        migration.docs_migration_start(),
        migration.docs_migration_resume("run-1"),
        migration.docs_migration_retry_failures("run-1"),
        migration.docs_migration_cancel("run-1"),
        migration.docs_migration_status("run-1"),
        migration.docs_migration_run("run-1"),
    ]
    for call in calls:
        with pytest.raises(migration.UserError, match="provider or platform"):
            await call


@pytest.mark.asyncio
async def test_integration_mapping_is_only_organization_authority(monkeypatch) -> None:
    mappings = [
        SimpleNamespace(organization_id="bifrost-1", entity_id="itglue-42", entity_name="Acme"),
        SimpleNamespace(organization_id="bifrost-2", entity_id="itglue-99", entity_name="Other"),
    ]
    written: list[tuple[str, str, dict]] = []

    async def list_mappings(name, scope):
        assert (name, scope) == ("IT Glue", "global")
        return mappings

    async def upsert(table, row_id, data):
        written.append((table, row_id, data))

    async def query(*args, **kwargs):
        return SimpleNamespace(documents=[])

    monkeypatch.setattr(migration.integrations, "list_mappings", list_mappings)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.tables, "query", query)

    selected = await migration._resolve_organization_mappings(
        {"bifrost_organization_ids": ["bifrost-1"]}
    )

    assert selected == [("itglue-42", "bifrost-1")]
    assert len(written) == 2
    source_map = next(data for table, _, data in written if table == migration.MAP_TABLE)
    grant_id, grant = next(
        (row_id, data) for table, row_id, data in written
        if table == migration.FILE_ORG_GRANTS_TABLE
    )
    assert source_map["source_organization_id"] == "itglue-42"
    assert source_map["organization_id"] == "bifrost-1"
    assert grant_id == stable_id("bifrost-1", "file-org-grant", "bifrost-1")
    assert grant == {"organization_id": "bifrost-1", "path_prefix": "bifrost-1"}


@pytest.mark.asyncio
async def test_attachment_paths_are_organization_prefixed_and_replace_legacy_paths(monkeypatch) -> None:
    uploaded: list[str] = []
    removed: list[tuple[str, str, str]] = []
    stored: dict = {}

    async def get(table, row_id):
        assert table == migration.ATTACHMENTS_TABLE
        return SimpleNamespace(data={
            "storage_path": "itglue/documents/parent/attachment-1/guide.pdf",
            "storage_location": "docs-attachments",
        })

    async def exists(*args, **kwargs):
        return False

    async def signed_url(path, **kwargs):
        uploaded.append(path)
        return {"url": "/api/files/local-upload/attachment-1"}

    async def upsert(table, row_id, data):
        stored.update(data)

    async def stat(*args, **kwargs):
        return {"exists": True, "version": "v1"}

    async def delete(path, *, location, scope, expected_version):
        removed.append((path, location, scope))

    class Client:
        async def stream_to_signed_url(self, *args, **kwargs):
            assert args[1] == "https://bifrost.test/api/files/local-upload/attachment-1"
            return 3, SHA256, True

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.files, "exists", exists)
    monkeypatch.setattr(migration.files, "get_signed_url", signed_url)
    monkeypatch.setattr(migration.files, "stat", stat)
    monkeypatch.setattr(migration.files, "delete", delete)
    monkeypatch.setattr(migration.context, "public_url", "https://bifrost.test", raising=False)
    monkeypatch.setattr(migration, "complete_signed_upload", _complete_upload)

    await migration._transfer_file(
        Client(),
        "org-a",
        "documents",
        "parent",
        {"id": "attachment-1", "attributes": {
            "download-url": "https://source.test/guide.pdf",
            "attachment-file-name": "guide.pdf",
        }},
        file_kind="attachment",
    )

    attachment_id = stable_id("org-a", "attachment", "attachment-1")
    assert uploaded[0].startswith(f"org-a/itglue/documents/parent/{attachment_id}/v-")
    assert uploaded[0].endswith("/guide.pdf")
    assert stored["storage_path"] == uploaded[0]
    assert removed == [("itglue/documents/parent/attachment-1/guide.pdf", "docs-attachments", "org-a")]


@pytest.mark.asyncio
async def test_quarantined_attachment_retries_even_when_source_watermark_is_unchanged(monkeypatch) -> None:
    prior = SimpleNamespace(data={
        "storage_path": "org-a/itglue/documents/parent/attachment-1/guide.pdf",
        "storage_location": "docs-attachments",
        "source_updated_at": "2026-09-01T00:00:00Z",
        "quarantined": True,
        "integrity_error": "unexpected_html",
    })
    uploads = 0
    stored: dict = {}

    async def get(*args, **kwargs): return prior
    async def exists(*args, **kwargs): return True
    async def stat(*args, **kwargs): return {"exists": False}
    async def signed(*args, **kwargs): return {"url": "/api/files/local-upload/attachment-1"}
    async def stream(*args, **kwargs):
        nonlocal uploads
        uploads += 1
        return 3, SHA256, True
    async def upsert(table, row_id, data): stored.update(data)

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.files, "exists", exists)
    monkeypatch.setattr(migration.files, "stat", stat)
    monkeypatch.setattr(migration.files, "get_signed_url", signed)
    monkeypatch.setattr(migration.context, "public_url", "https://bifrost.test", raising=False)
    monkeypatch.setattr(migration, "complete_signed_upload", _complete_upload)

    await migration._transfer_file(
        SimpleNamespace(stream_to_signed_url=stream), "org-a", "documents", "parent",
        {"id": "attachment-1", "attributes": {"download-url": "https://source.test/guide.pdf", "attachment-file-name": "guide.pdf", "updated-at": "2026-09-01T00:00:00Z"}}, file_kind="attachment",
    )

    assert uploads == 1
    assert stored["quarantined"] is False
    assert stored["integrity_error"] is None


@pytest.mark.asyncio
async def test_transfer_retries_old_file_cleanup_before_repointing_restricted_metadata(monkeypatch) -> None:
    """A failed move must retain old metadata so a retry cannot skip old deletion."""
    prior = SimpleNamespace(data={
        "storage_path": "org-a/itglue/documents/parent/attachment-1/guide.pdf",
        "storage_location": "docs-attachments",
        "source_updated_at": "2026-09-01T00:00:00Z",
    })
    upserts: list[dict] = []
    delete_attempts = 0

    async def get(table, row_id):
        assert table == migration.ATTACHMENTS_TABLE
        return prior

    async def exists(*args, **kwargs):
        return False

    async def signed_url(*args, **kwargs):
        return {"url": "/api/files/local-upload/attachment-1"}

    async def stream_to_signed_url(*args, **kwargs):
        return 3, SHA256, True

    async def stat(*args, **kwargs):
        return {"exists": True, "version": "v1"}

    async def delete(*args, **kwargs):
        nonlocal delete_attempts
        delete_attempts += 1
        if delete_attempts == 1:
            raise RuntimeError("temporary deletion failure")

    async def upsert(table, row_id, data):
        upserts.append(data)

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.files, "exists", exists)
    monkeypatch.setattr(migration.files, "get_signed_url", signed_url)
    monkeypatch.setattr(migration.files, "stat", stat)
    monkeypatch.setattr(migration.files, "delete", delete)
    monkeypatch.setattr(migration.context, "public_url", "https://bifrost.test", raising=False)
    monkeypatch.setattr(migration, "complete_signed_upload", _complete_upload)

    item = {"id": "attachment-1", "attributes": {
        "download-url": "https://source.test/guide.pdf",
        "attachment-file-name": "guide.pdf",
        "updated-at": "2026-09-01T00:00:00Z",
    }}
    client = SimpleNamespace(stream_to_signed_url=stream_to_signed_url)

    with pytest.raises(RuntimeError, match="temporary deletion failure"):
        await migration._transfer_file(
            client, "org-a", "documents", "parent", item,
            file_kind="attachment", restricted=True,
        )
    assert upserts == []

    await migration._transfer_file(
        client, "org-a", "documents", "parent", item,
        file_kind="attachment", restricted=True,
    )

    assert delete_attempts == 2
    assert upserts[0]["storage_location"] == "docs-restricted-attachments"


@pytest.mark.asyncio
async def test_streamed_transfer_error_does_not_expose_source_url_or_body() -> None:
    class Client:
        async def stream_to_signed_url(self, *args, **kwargs):
            raise RuntimeError("request to https://source.test/download?token=secret failed")

    with pytest.raises(ITGlueError) as exc_info:
        await migration._streamed_transfer(
            Client(),
            "https://source.test/download?token=secret",
            "https://storage.test/upload",
            content_type="application/pdf",
            size_bytes=42,
            file_kind="attachment",
            item_id="attachment-1",
        )

    assert "https://" not in str(exc_info.value)
    assert "secret" not in str(exc_info.value)
    assert "cause=RuntimeError" in str(exc_info.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("table_name", [migration.ATTACHMENTS_TABLE, migration.RELATIONSHIPS_TABLE])
async def test_prune_owned_children_preserves_native_child_returned_by_query(monkeypatch, table_name) -> None:
    """Only IT Glue-owned children may be pruned, even if query filtering is broad."""
    native = SimpleNamespace(id="native-child", data={
        "organization_id": "org-a",
        "source_system": "bifrost",
        "source_id": "native-1",
        "parent_type" if table_name == migration.ATTACHMENTS_TABLE else "source_type": "documents",
        "parent_id" if table_name == migration.ATTACHMENTS_TABLE else "source_destination_id": "document-1",
    })
    deleted: list[tuple[str, str]] = []
    pages = [[native], []]

    async def query(*args, **kwargs):
        return SimpleNamespace(documents=pages.pop(0))

    async def delete_document(table, row_id):
        deleted.append((table, row_id))

    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "delete_document", delete_document)

    await migration._prune_owned_children(
        "org-a", "documents", "document-1", table_name, set()
    )

    assert deleted == []


@pytest.mark.asyncio
async def test_repointed_integration_mapping_cleans_old_owned_data_before_new_map(monkeypatch) -> None:
    old_document_map_id = source_map_id("org-a", "documents", "doc-old")
    old_org_map = SimpleNamespace(id="old-org-map", data={
        "organization_id": "org-a", "source_organization_id": "itglue-old",
        "resource_type": "organization", "source_id": "itglue-old", "destination_id": "org-a",
    })
    old_document_map = SimpleNamespace(id=old_document_map_id, data={
        "organization_id": "org-a", "source_organization_id": "itglue-old",
        "resource_type": "documents", "source_id": "doc-old", "destination_id": "document-old",
    })
    remaining = [old_org_map, old_document_map]
    events: list[tuple] = []

    async def list_mappings(*args, **kwargs):
        return [SimpleNamespace(organization_id="org-a", entity_id="itglue-new", entity_name="New")]

    async def query(table, *, where, limit, offset=0):
        assert table == migration.MAP_TABLE
        if where.get("resource_type") == "organization":
            return SimpleNamespace(documents=[row for row in remaining if row.data["resource_type"] == "organization"])
        return SimpleNamespace(documents=[row for row in remaining if row.data.get("source_organization_id") == where.get("source_organization_id")])

    async def delete_owned(target_org_id, spec, source_id, destination_id):
        events.append(("resource", spec.name, source_id, destination_id))
        remaining[:] = [row for row in remaining if row.id != old_document_map_id]

    async def delete_document(table, row_id):
        events.append(("map", row_id))
        remaining[:] = [row for row in remaining if row.id != row_id]

    async def upsert(table, row_id, data):
        events.append(("upsert", table, row_id, data["source_organization_id"] if table == migration.MAP_TABLE else None))

    monkeypatch.setattr(migration.integrations, "list_mappings", list_mappings)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "delete_document", delete_document)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration, "_delete_owned_resource", delete_owned)

    assert await migration._resolve_organization_mappings({"bifrost_organization_ids": ["org-a"]}) == [("itglue-new", "org-a")]
    assert events[:2] == [
        ("resource", "documents", "doc-old", "document-old"),
        ("map", "old-org-map"),
    ]
    assert events[2][0:2] == ("upsert", migration.MAP_TABLE)
    assert events[2][3] == "itglue-new"


@pytest.mark.asyncio
async def test_repoint_cleanup_failure_keeps_old_mapping_and_blocks_new_import_until_retry(monkeypatch) -> None:
    old_document_map_id = source_map_id("org-a", "documents", "doc-old")
    old_org_map = SimpleNamespace(id="old-org-map", data={
        "organization_id": "org-a", "source_organization_id": "itglue-old",
        "resource_type": "organization", "source_id": "itglue-old", "destination_id": "org-a",
    })
    old_document_map = SimpleNamespace(id=old_document_map_id, data={
        "organization_id": "org-a", "source_organization_id": "itglue-old",
        "resource_type": "documents", "source_id": "doc-old", "destination_id": "document-old",
    })
    remaining = [old_org_map, old_document_map]
    deleted_resources: list[str] = []
    upserts: list[tuple[str, dict]] = []

    async def list_mappings(*args, **kwargs):
        return [SimpleNamespace(organization_id="org-a", entity_id="itglue-new", entity_name="New")]

    async def query(table, *, where, limit, offset=0):
        if where.get("resource_type") == "organization":
            return SimpleNamespace(documents=[row for row in remaining if row.data["resource_type"] == "organization"])
        return SimpleNamespace(documents=[row for row in remaining if row.data.get("source_organization_id") == where.get("source_organization_id")])

    async def delete_owned(*args):
        deleted_resources.append(args[2])
        if len(deleted_resources) == 1:
            raise RuntimeError("cleanup failed")
        remaining[:] = [row for row in remaining if row.id != old_document_map_id]

    async def delete_document(table, row_id):
        remaining[:] = [row for row in remaining if row.id != row_id]

    async def upsert(table, row_id, data):
        upserts.append((table, data))

    monkeypatch.setattr(migration.integrations, "list_mappings", list_mappings)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "delete_document", delete_document)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration, "_delete_owned_resource", delete_owned)

    with pytest.raises(RuntimeError, match="cleanup failed"):
        await migration._resolve_organization_mappings({"bifrost_organization_ids": ["org-a"]})
    assert [row.id for row in remaining] == ["old-org-map", old_document_map_id]
    assert upserts == []

    await migration._resolve_organization_mappings({"bifrost_organization_ids": ["org-a"]})
    assert deleted_resources == ["doc-old", "doc-old"]
    assert remaining == []
    assert upserts[0][1]["source_organization_id"] == "itglue-new"


@pytest.mark.asyncio
async def test_repoint_cleanup_preserves_native_row_and_fails_closed(monkeypatch) -> None:
    old_document_map_id = source_map_id("org-a", "documents", "doc-old")
    old_org_map = SimpleNamespace(id="old-org-map", data={
        "organization_id": "org-a", "source_organization_id": "itglue-old",
        "resource_type": "organization", "source_id": "itglue-old", "destination_id": "org-a",
    })
    old_document_map = SimpleNamespace(id=old_document_map_id, data={
        "organization_id": "org-a", "source_organization_id": "itglue-old",
        "resource_type": "documents", "source_id": "doc-old", "destination_id": "document-old",
    })
    native = SimpleNamespace(data={"organization_id": "org-a", "source_system": "bifrost", "source_id": "doc-old"})
    deleted: list[tuple[str, str]] = []
    upserts: list[tuple] = []

    async def list_mappings(*args, **kwargs):
        return [SimpleNamespace(organization_id="org-a", entity_id="itglue-new", entity_name="New")]

    async def query(table, *, where, limit, offset=0):
        if where.get("resource_type") == "organization":
            return SimpleNamespace(documents=[old_org_map])
        return SimpleNamespace(documents=[old_org_map, old_document_map])

    async def get(table, row_id):
        assert table == _spec("documents").table
        assert row_id == "document-old"
        return native

    async def delete_document(table, row_id):
        deleted.append((table, row_id))

    async def upsert(*args):
        upserts.append(args)

    monkeypatch.setattr(migration.integrations, "list_mappings", list_mappings)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "delete_document", delete_document)
    monkeypatch.setattr(migration.tables, "upsert", upsert)

    with pytest.raises(migration.UserError, match="not owned"):
        await migration._resolve_organization_mappings({"bifrost_organization_ids": ["org-a"]})
    assert deleted == []
    assert upserts == []


async def _process_location(
    monkeypatch, *, source: dict, mapped: dict | None, destination: dict | None, mode: str, updates: list | None = None
) -> tuple[str, list[tuple[str, str, dict]], int]:
    spec = _spec("locations")
    source_id = source["id"]
    destination_id = stable_id("org-a", spec.name, source_id)
    hydrated = 0
    upserts: list[tuple[str, str, dict]] = []

    async def get(table, row_id):
        if table == migration.ITEMS_TABLE:
            return None
        if table == migration.MAP_TABLE:
            assert row_id == source_map_id("org-a", spec.name, source_id)
            return SimpleNamespace(data=mapped) if mapped is not None else None
        if table == spec.table:
            assert row_id == destination_id
            return SimpleNamespace(data=destination) if destination is not None else None
        raise AssertionError((table, row_id))

    async def upsert(table, row_id, data):
        upserts.append((table, row_id, data))

    async def update(*args, **kwargs):
        if updates is not None:
            updates.append(args)
        return None

    async def hydrate(*args, **kwargs):
        nonlocal hydrated
        hydrated += 1
        return source, [], []

    async def no_op(*args, **kwargs):
        return None

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.tables, "update", update)
    monkeypatch.setattr(migration, "_hydrate_resource", hydrate)
    monkeypatch.setattr(migration, "_prune_owned_children", no_op)

    result = await migration._process_resource(
        object(), "run-1", "itglue-1", "org-a", spec, source, mode
    )
    return result, upserts, hydrated


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["proof", "bulk"])
async def test_unchanged_source_keeps_local_edits_in_every_import_mode(monkeypatch, mode) -> None:
    source = {"id": "loc-1", "attributes": {"name": "IT Glue name", "updated-at": "2026-09-01T00:00:00Z"}}
    mapped = {"source_updated_at": "2026-09-01T00:00:00Z"}
    destination = {
        "organization_id": "org-a", "source_system": "itglue", "source_id": "loc-1",
        "name": "Locally edited name",
    }

    result, upserts, hydrated = await _process_location(
        monkeypatch, source=source, mapped=mapped, destination=destination, mode=mode
    )

    assert result == "skipped"
    # A child attachment may change independently of this parent watermark.
    assert hydrated == 1
    assert not any(table == _spec("locations").table for table, _, _ in upserts)


@pytest.mark.asyncio
async def test_changed_source_overwrites_local_edits_and_refreshes_mapping(monkeypatch) -> None:
    source = {"id": "loc-1", "attributes": {"name": "IT Glue updated", "updated-at": "2026-09-02T00:00:00Z"}}
    mapped = {"source_updated_at": "2026-09-01T00:00:00Z"}
    destination = {
        "organization_id": "org-a", "source_system": "itglue", "source_id": "loc-1",
        "name": "Locally edited name",
    }

    result, upserts, hydrated = await _process_location(
        monkeypatch, source=source, mapped=mapped, destination=destination, mode="bulk"
    )

    assert result == "succeeded"
    assert hydrated == 1
    row = next(data for table, _, data in upserts if table == _spec("locations").table)
    assert row["name"] == "IT Glue updated"
    source_map = next(data for table, _, data in upserts if table == migration.MAP_TABLE)
    assert source_map["source_updated_at"] == "2026-09-02T00:00:00Z"


@pytest.mark.asyncio
async def test_unchanged_source_repairs_a_missing_mapped_destination(monkeypatch) -> None:
    source = {"id": "loc-1", "attributes": {"name": "IT Glue name", "updated-at": "2026-09-01T00:00:00Z"}}
    mapped = {"source_updated_at": "2026-09-01T00:00:00Z"}

    result, upserts, hydrated = await _process_location(
        monkeypatch, source=source, mapped=mapped, destination=None, mode="proof"
    )

    assert result == "succeeded"
    assert hydrated == 1
    assert any(table == _spec("locations").table for table, _, _ in upserts)


@pytest.mark.asyncio
async def test_native_destination_is_never_modified_by_a_source_mapping(monkeypatch) -> None:
    source = {"id": "loc-1", "attributes": {"name": "IT Glue updated", "updated-at": "2026-09-02T00:00:00Z"}}
    destination = {
        "organization_id": "org-a", "source_system": "bifrost", "source_id": "loc-1",
        "name": "Native Bifrost record",
    }

    result, upserts, hydrated = await _process_location(
        monkeypatch, source=source, mapped=None, destination=destination, mode="bulk"
    )

    assert result == "skipped"
    assert hydrated == 0
    assert not any(table in {_spec("locations").table, migration.MAP_TABLE} for table, _, _ in upserts)


@pytest.mark.asyncio
async def test_fingerprint_skips_unchanged_source_when_no_watermark_exists(monkeypatch) -> None:
    source = {"id": "loc-1", "attributes": {"name": "IT Glue name", "phone": "555-0100"}}
    fingerprint = canonical_source_fingerprint(source)
    mapped = {"source_fingerprint": fingerprint}
    destination = {
        "organization_id": "org-a", "source_system": "itglue", "source_id": "loc-1",
        "name": "Locally edited name",
    }

    result, _, hydrated = await _process_location(
        monkeypatch, source=source, mapped=mapped, destination=destination, mode="bulk"
    )

    assert result == "skipped"
    assert hydrated == 1


@pytest.mark.asyncio
async def test_unchanged_document_hydrates_and_syncs_changed_attachments_without_overwriting_local_content(
    monkeypatch,
) -> None:
    """Attachment metadata can change without changing the parent document watermark."""
    spec = _spec("documents")
    source = {
        "id": "doc-1",
        "attributes": {"name": "IT Glue title", "updated-at": "2026-09-01T00:00:00Z"},
    }
    prior_source = {
        **source,
        "_sections": [{"id": "section-1", "attributes": {"content": "IT Glue body"}}],
        "_included": [{"id": "attachment-1", "type": "attachments"}],
    }
    hydrated = {
        **source,
        "_sections": [{"id": "section-1", "attributes": {"content": "IT Glue body"}}],
    }
    changed_attachment = {
        "id": "attachment-1",
        "type": "attachments",
        "attributes": {
            "attachment-file-name": "guide.pdf",
            "updated-at": "2026-09-02T00:00:00Z",
        },
    }
    changed_image = {
        "id": "image-1",
        "type": "document_images",
        "attributes": {"name": "diagram.png", "updated-at": "2026-09-02T00:00:00Z"},
    }
    destination_id = stable_id("org-a", spec.name, "doc-1")
    destination = {
        "organization_id": "org-a",
        "source_system": "itglue",
        "source_id": "doc-1",
        "name": "Locally edited title",
        "content": "Locally edited body",
        "rendered_content": "Locally edited body",
        "restricted": False,
        "raw": prior_source,
    }
    upserts: list[tuple[str, str, dict]] = []
    transferred: list[str] = []
    hydrated_calls = 0

    async def get(table, row_id):
        if table == migration.ITEMS_TABLE:
            return None
        if table == migration.MAP_TABLE:
            return SimpleNamespace(data={"source_updated_at": "2026-09-01T00:00:00Z"})
        if table == spec.table:
            assert row_id == destination_id
            return SimpleNamespace(data=destination)
        raise AssertionError((table, row_id))

    async def hydrate_resource(*args, **kwargs):
        nonlocal hydrated_calls
        hydrated_calls += 1
        return hydrated, [changed_attachment], [changed_image]

    async def transfer_file(*args, **kwargs):
        transferred.append(args[4]["id"])

    async def no_op(*args, **kwargs):
        return None

    async def upsert(table, row_id, data):
        upserts.append((table, row_id, data))

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.tables, "update", no_op)
    monkeypatch.setattr(migration, "_hydrate_resource", hydrate_resource)
    monkeypatch.setattr(migration, "_transfer_file", transfer_file)
    monkeypatch.setattr(migration, "_store_related_items", no_op)
    monkeypatch.setattr(migration, "_prune_owned_children", no_op)

    result = await migration._process_resource(
        object(), "run-1", "itglue-1", "org-a", spec, source, "bulk"
    )

    assert result == "skipped"
    assert hydrated_calls == 1
    assert transferred == ["attachment-1", "image-1"]
    assert not any(table == spec.table for table, _, _ in upserts)


@pytest.mark.asyncio
async def test_unchanged_location_hydrates_and_syncs_attachment_without_overwriting_local_fields(
    monkeypatch,
) -> None:
    """Non-document children are also mutable independently of their parent."""
    spec = _spec("locations")
    source = {
        "id": "location-1",
        "attributes": {"name": "IT Glue location", "updated-at": "2026-09-01T00:00:00Z"},
    }
    destination_id = stable_id("org-a", spec.name, "location-1")
    destination = {
        "organization_id": "org-a",
        "source_system": "itglue",
        "source_id": "location-1",
        "name": "Locally edited location",
    }
    changed_attachment = {
        "id": "attachment-1",
        "type": "attachments",
        "attributes": {"attachment-file-name": "floorplan.pdf", "updated-at": "2026-09-02T00:00:00Z"},
    }
    upserts: list[tuple[str, str, dict]] = []
    transferred: list[str] = []
    hydrated_calls = 0

    async def get(table, row_id):
        if table == migration.ITEMS_TABLE:
            return None
        if table == migration.MAP_TABLE:
            return SimpleNamespace(data={"source_updated_at": "2026-09-01T00:00:00Z"})
        if table == spec.table:
            assert row_id == destination_id
            return SimpleNamespace(data=destination)
        raise AssertionError((table, row_id))

    async def hydrate_resource(*args, **kwargs):
        nonlocal hydrated_calls
        hydrated_calls += 1
        return source, [changed_attachment], []

    async def transfer_file(*args, **kwargs):
        transferred.append(args[4]["id"])

    async def no_op(*args, **kwargs):
        return None

    async def upsert(table, row_id, data):
        upserts.append((table, row_id, data))

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.tables, "update", no_op)
    monkeypatch.setattr(migration, "_hydrate_resource", hydrate_resource)
    monkeypatch.setattr(migration, "_transfer_file", transfer_file)
    monkeypatch.setattr(migration, "_store_related_items", no_op)
    monkeypatch.setattr(migration, "_prune_owned_children", no_op)

    result = await migration._process_resource(
        object(), "run-1", "itglue-1", "org-a", spec, source, "bulk"
    )

    assert result == "skipped"
    assert hydrated_calls == 1
    assert transferred == ["attachment-1"]
    assert not any(table == spec.table for table, _, _ in upserts)


@pytest.mark.asyncio
async def test_source_delete_removes_only_itglue_owned_incoming_relationships(monkeypatch) -> None:
    spec = _spec("locations")
    destination_id = stable_id("org-a", spec.name, "location-1")
    incoming = SimpleNamespace(
        id="itglue-incoming",
        data={
            "organization_id": "org-a",
            "source_system": "itglue",
            "source_type": "passwords",
            "source_destination_id": "password-1",
            "target_destination_id": destination_id,
        },
    )
    native_incoming = SimpleNamespace(
        id="native-incoming",
        data={
            "organization_id": "org-a",
            "source_system": "bifrost",
            "source_type": "passwords",
            "source_destination_id": "password-2",
            "target_destination_id": destination_id,
        },
    )
    deleted: list[tuple[str, str]] = []
    incoming_pending = [[incoming, native_incoming]]

    async def get(table, row_id):
        if table == spec.table:
            return SimpleNamespace(data={
                "organization_id": "org-a", "source_system": "itglue", "source_id": "location-1"
            })
        raise AssertionError((table, row_id))

    async def query(table, *, where, limit):
        if table == migration.ATTACHMENTS_TABLE:
            return SimpleNamespace(documents=[])
        assert table == migration.RELATIONSHIPS_TABLE
        if where.get("source_destination_id") == destination_id:
            return SimpleNamespace(documents=[])
        assert where == {
            "organization_id": "org-a",
            "source_system": "itglue",
            "target_destination_id": destination_id,
        }
        if incoming_pending:
            return SimpleNamespace(documents=incoming_pending.pop())
        return SimpleNamespace(documents=[])

    async def delete_document(table, row_id):
        deleted.append((table, row_id))

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "delete_document", delete_document)

    await migration._delete_owned_resource("org-a", spec, "location-1", destination_id)

    assert deleted == [
        (migration.RELATIONSHIPS_TABLE, "itglue-incoming"),
        (spec.table, destination_id),
        (migration.MAP_TABLE, source_map_id("org-a", spec.name, "location-1")),
    ]


@pytest.mark.asyncio
async def test_document_delete_keeps_index_until_file_cleanup_succeeds(monkeypatch) -> None:
    spec = _spec("documents")
    destination_id = stable_id("org-a", spec.name, "document-1")
    child = SimpleNamespace(
        id="attachment-1",
        data={"storage_path": "org-a/attachment.pdf", "storage_location": "docs-attachments"},
    )
    children = [child]
    delete_attempts = 0
    index_deletes: list[tuple[str, str]] = []
    deleted_rows: list[tuple[str, str]] = []

    async def get(table, row_id):
        assert (table, row_id) == (spec.table, destination_id)
        return SimpleNamespace(data={
            "organization_id": "org-a", "source_system": "itglue", "source_id": "document-1"
        })

    async def query(table, *, where, limit):
        if table == migration.ATTACHMENTS_TABLE:
            return SimpleNamespace(documents=list(children))
        return SimpleNamespace(documents=[])

    async def stat(*args, **kwargs):
        return {"exists": True, "version": "v1"}

    async def delete_file(*args, **kwargs):
        nonlocal delete_attempts
        delete_attempts += 1
        if delete_attempts == 1:
            raise RuntimeError("storage temporarily unavailable")

    async def delete_document(table, row_id):
        deleted_rows.append((table, row_id))
        if table == migration.ATTACHMENTS_TABLE:
            children.clear()

    async def delete_index(org_id, doc_id):
        index_deletes.append((org_id, doc_id))

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "delete_document", delete_document)
    monkeypatch.setattr(migration.files, "stat", stat)
    monkeypatch.setattr(migration.files, "delete", delete_file)
    monkeypatch.setattr("functions.indexing.delete_document_index", delete_index)

    with pytest.raises(RuntimeError, match="storage temporarily unavailable"):
        await migration._delete_owned_resource("org-a", spec, "document-1", destination_id)

    assert index_deletes == []
    assert children == [child]

    await migration._delete_owned_resource("org-a", spec, "document-1", destination_id)

    assert delete_attempts == 2
    assert index_deletes == [("org-a", destination_id)]
    assert deleted_rows == [
        (migration.ATTACHMENTS_TABLE, "attachment-1"),
        (spec.table, destination_id),
        (migration.MAP_TABLE, source_map_id("org-a", spec.name, "document-1")),
    ]


@pytest.mark.asyncio
async def test_unchanged_document_parent_watermark_still_overwrites_when_sections_change(monkeypatch) -> None:
    """Section content is document content, so it is an effective source change."""
    spec = _spec("documents")
    source = {
        "id": "doc-1",
        "attributes": {"name": "IT Glue title", "updated-at": "2026-09-01T00:00:00Z"},
    }
    prior_source = {
        **source,
        "_sections": [{"id": "section-1", "attributes": {"content": "Old IT Glue body"}}],
    }
    hydrated = {
        **source,
        "_sections": [{"id": "section-1", "attributes": {"content": "New IT Glue body"}}],
    }
    destination_id = stable_id("org-a", spec.name, "doc-1")
    destination = {
        "organization_id": "org-a",
        "source_system": "itglue",
        "source_id": "doc-1",
        "name": "Locally edited title",
        "content": "Locally edited body",
        "rendered_content": "Locally edited body",
        "restricted": False,
        "raw": prior_source,
    }
    upserts: list[tuple[str, str, dict]] = []
    hydrated_calls = 0
    indexed: list[str] = []

    async def get(table, row_id):
        if table == migration.ITEMS_TABLE:
            return None
        if table == migration.MAP_TABLE:
            return SimpleNamespace(data={"source_updated_at": "2026-09-01T00:00:00Z"})
        if table == spec.table:
            assert row_id == destination_id
            return SimpleNamespace(data=destination)
        raise AssertionError((table, row_id))

    async def hydrate_resource(*args, **kwargs):
        nonlocal hydrated_calls
        hydrated_calls += 1
        return hydrated, [], []

    async def no_op(*args, **kwargs):
        return None

    async def upsert(table, row_id, data):
        upserts.append((table, row_id, data))

    async def sync_index(org_id, document_id):
        indexed.append(document_id)

    async def folder_not_restricted(*args, **kwargs):
        return False

    from functions import indexing

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.tables, "update", no_op)
    monkeypatch.setattr(migration, "_hydrate_resource", hydrate_resource)
    monkeypatch.setattr(migration, "_transfer_file", no_op)
    monkeypatch.setattr(migration, "_store_related_items", no_op)
    monkeypatch.setattr(migration, "_prune_owned_children", no_op)
    monkeypatch.setattr(migration, "_folder_is_restricted", folder_not_restricted)
    monkeypatch.setattr(indexing, "sync_document_index", sync_index)

    result = await migration._process_resource(
        object(), "run-1", "itglue-1", "org-a", spec, source, "bulk"
    )

    assert result == "succeeded"
    assert hydrated_calls == 1
    row = next(data for table, _, data in upserts if table == spec.table)
    assert row["content"] == "New IT Glue body"
    assert indexed == [destination_id]


@pytest.mark.asyncio
async def test_reconciliation_keeps_record_that_still_exists_at_source(monkeypatch) -> None:
    source_map = SimpleNamespace(
        id="map-1", data={"source_id": "doc-1", "destination_id": "dest-1"}
    )
    findings: list[str] = []

    async def count(*args, **kwargs):
        return 0

    async def query(table, **kwargs):
        if table == migration.MAP_TABLE:
            return SimpleNamespace(documents=[source_map])
        return SimpleNamespace(documents=[])

    async def get(*args, **kwargs):
        return None

    async def write_finding(*args, **kwargs):
        findings.append(args[6])

    class Client:
        async def get_document(self, path):
            assert path == "/documents/doc-1"
            return {"data": {"id": "doc-1"}}

    monkeypatch.setattr(migration.tables, "count", count)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration, "_write_reconciliation_finding", write_finding)
    result = await migration._reconcile_resource(
        Client(), "run-1", "itglue-42", "bifrost-1", _spec("documents")
    )

    assert result["deleted"] == 0
    assert findings == ["enumeration_omission"]


@pytest.mark.asyncio
async def test_reconciliation_deletes_only_after_confirmed_source_404(monkeypatch) -> None:
    source_map = SimpleNamespace(
        id="map-1", data={"source_id": "doc-1", "destination_id": "dest-1"}
    )
    items: list[SimpleNamespace] = []
    deleted: list[tuple[str, str]] = []

    async def count(*args, **kwargs):
        return 0

    async def query(table, **kwargs):
        if table == migration.MAP_TABLE:
            return SimpleNamespace(documents=[source_map])
        pending = [item for item in items if item.data["status"] == "delete_pending"]
        return SimpleNamespace(documents=pending)

    async def get(*args, **kwargs):
        return None

    async def upsert(table, row_id, data):
        items.append(SimpleNamespace(id=row_id, data=data))

    async def update(table, row_id, data):
        item = next(item for item in items if item.id == row_id)
        item.data.update(data)

    async def delete_owned(org_id, spec, source_id, destination_id):
        deleted.append((source_id, destination_id))

    async def audit(*args, **kwargs):
        return None

    class Client:
        async def get_document(self, path):
            raise ITGlueError("not found", status_code=404)

    monkeypatch.setattr(migration.tables, "count", count)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.tables, "update", update)
    monkeypatch.setattr(migration, "_delete_owned_resource", delete_owned)
    monkeypatch.setattr(migration, "_write_audit", audit)
    result = await migration._reconcile_resource(
        Client(), "run-1", "itglue-42", "bifrost-1", _spec("documents")
    )

    assert result["deleted"] == 1
    assert deleted == [("doc-1", "dest-1")]
    assert items[0].data["status"] == "deleted"


@pytest.mark.asyncio
async def test_reconciliation_rechecks_pending_delete_with_direct_get(monkeypatch) -> None:
    """A resumed worker must not delete a source record that has reappeared."""
    source_map = SimpleNamespace(
        id="map-1", data={"source_id": "doc-1", "destination_id": "dest-1"}
    )
    pending = SimpleNamespace(
        id="item-1",
        data={"source_id": "doc-1", "destination_id": "dest-1", "status": "delete_pending"},
    )
    deleted: list[tuple[str, str]] = []

    async def count(*args, **kwargs):
        return 0

    async def query(table, **kwargs):
        if table == migration.MAP_TABLE:
            return SimpleNamespace(documents=[source_map])
        return SimpleNamespace(documents=[pending] if pending.data["status"] == "delete_pending" else [])

    async def get(*args, **kwargs):
        return pending

    async def update(table, row_id, data):
        assert (table, row_id) == (migration.ITEMS_TABLE, "item-1")
        pending.data.update(data)

    async def delete_owned(*args):
        deleted.append((args[2], args[3]))

    class Client:
        async def get_document(self, path):
            assert path == "/documents/doc-1"
            return {"data": {"id": "doc-1"}}

    monkeypatch.setattr(migration.tables, "count", count)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "update", update)
    monkeypatch.setattr(migration, "_delete_owned_resource", delete_owned)
    result = await migration._reconcile_resource(
        Client(), "run-1", "itglue-42", "bifrost-1", _spec("documents")
    )

    assert result["deleted"] == 0
    assert deleted == []
    assert pending.data["status"] == "skipped"
    assert pending.data["disposition"] == "source_reappeared"


@pytest.mark.asyncio
async def test_document_hydration_uses_supported_sections_and_image_routes() -> None:
    requested: list[str] = []

    class Client:
        async def get_document(self, path, params=None):
            requested.append(path)
            if path == "/documents/7":
                return {"data": {"id": "7", "attributes": {"name": "Guide"}}}
            if path == "/document_images/34":
                return {"data": {"id": "34", "attributes": {"original-src": "https://example.test/image"}}}
            raise AssertionError(path)

        async def iter_pages(self, path, params=None):
            requested.append(path)
            yield ITGluePage(
                number=1,
                records=[{
                    "id": "section-1", "attributes": {
                        "content": '<img src="/7/docs/7/developer/images/34">'
                    }
                }],
                included=[], total_pages=1, total_count=1,
            )

    data, _, images = await migration._hydrate_resource(Client(), _spec("documents"), {"id": "7"})

    assert len(data["_sections"]) == 1
    assert [image["id"] for image in images] == ["34"]
    assert requested == [
        "/documents/7", "/documents/7/relationships/sections", "/document_images/34"
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [404, 503])
async def test_missing_inline_image_preserves_document_but_transient_hydration_errors_propagate(status) -> None:
    class Client:
        async def get_document(self, path, params=None):
            if path == "/documents/7":
                return {"data": {"id": "7", "attributes": {"name": "Guide"}}}
            raise ITGlueError("source unavailable", status_code=status)

        async def iter_pages(self, path, params=None):
            yield ITGluePage(
                number=1, records=[{"id": "section-1", "attributes": {
                    "content": '<p>Usable content</p><img src="/developer/images/34">'
                }}], included=[], total_pages=1, total_count=1,
            )

    if status != 404:
        with pytest.raises(ITGlueError) as error:
            await migration._hydrate_resource(Client(), _spec("documents"), {"id": "7"})
        assert error.value.status_code == 503
        return

    data, _, images = await migration._hydrate_resource(Client(), _spec("documents"), {"id": "7"})
    assert "Usable content" in data["_sections"][0]["attributes"]["content"]
    assert images == [{"id": "34", "type": "document_images", "_source_missing": True, "attributes": {}}]
    projected = migration._domain_row(_spec("documents"), data, "org-a", "parent", images=images)
    assert "Usable content" in projected["content"]
    assert "/developer/images/34" not in projected["content"]
    with pytest.raises(ITGlueError, match="metadata is unavailable") as error:
        await migration._transfer_file(
            Client(), "org-a", "documents", "parent", images[0], file_kind="document_image"
        )
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_folder_hydration_uses_organization_relationship_detail_route() -> None:
    requested: list[str] = []

    class Client:
        async def get_document(self, path, params=None):
            requested.append(path)
            return {"data": {"id": "folder-7", "attributes": {"name": "Runbooks"}}}

    data, included, images = await migration._hydrate_resource(
        Client(), _spec("document_folders"), {"id": "folder-7"}, source_org_id="itglue-42"
    )

    assert data["id"] == "folder-7"
    assert included == []
    assert images == []
    assert requested == ["/organizations/itglue-42/relationships/document_folders/folder-7"]


def test_resume_cursors_are_isolated_by_both_source_and_target_organization() -> None:
    assert migration_cursor_key("itglue-42", "bifrost-a", "documents") != migration_cursor_key(
        "itglue-42", "bifrost-b", "documents"
    )


@pytest.mark.asyncio
async def test_resume_does_not_share_a_legacy_cursor_between_target_organizations(monkeypatch) -> None:
    run = {
        "status": "queued",
        "resource_types": ["documents"],
        "mode": "bulk",
        # This is the pre-hardening cursor format. It is unsafe to reuse when
        # the same IT Glue org maps to more than one Bifrost organization.
        "cursors": {"itglue-42:documents": 3},
        "counts": {},
        "reconciliation_counts": {},
    }
    starts: list[int] = []
    document_list_params: list[dict] = []

    async def get_run(run_id):
        return SimpleNamespace(id=run_id, data=run), run

    async def update_run(run_id, changes):
        run.update(changes)
        return run

    async def resolve_mappings(current_run):
        assert current_run is run
        return [("itglue-42", "bifrost-a"), ("itglue-42", "bifrost-b")]

    async def get_integration(name, scope):
        return SimpleNamespace(entity_id="itglue-42", config={"api_key": "not-a-real-key"})

    async def no_op(*args, **kwargs):
        return None

    async def true(*args, **kwargs):
        return True

    async def false(*args, **kwargs):
        return False

    async def item_counts(*args, **kwargs):
        return {"failed": 0}

    async def reconcile(*args, **kwargs):
        return {"deleted": 0}

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def iter_pages(self, endpoint, *, params, start_page):
            starts.append(start_page)
            if endpoint.endswith("/relationships/documents"):
                document_list_params.append(params)
            if False:
                yield None

    monkeypatch.setattr(migration, "_get_run", get_run)
    monkeypatch.setattr(migration, "_update_run", update_run)
    monkeypatch.setattr(migration, "_resolve_organization_mappings", resolve_mappings)
    monkeypatch.setattr(migration.integrations, "get", get_integration)
    monkeypatch.setattr(migration, "_write_audit", no_op)
    monkeypatch.setattr(migration, "_cancel_requested", false)
    monkeypatch.setattr(migration, "_lease_owned", true)
    monkeypatch.setattr(migration, "_item_counts", item_counts)
    monkeypatch.setattr(migration, "_reconcile_resource", reconcile)
    monkeypatch.setattr(migration, "ITGlueClient", Client)
    monkeypatch.setattr(migration.context, "is_platform_admin", True, raising=False)

    result = await migration.docs_migration_run("run-1")

    assert result["status"] == "completed"
    assert starts == [1, 1]
    assert document_list_params == [
        {"include": "attachments,related_items", "filter[document_folder_id]": "null"},
        {"include": "attachments,related_items", "filter[document_folder_id]": "null"},
    ]


@pytest.mark.asyncio
async def test_flexible_assets_enumerate_each_source_type_with_independent_resume_cursors(monkeypatch) -> None:
    run = {
        "status": "queued",
        "resource_types": ["flexible_assets", "passwords"],
        "mode": "proof",
        "cursors": {migration_cursor_key("itglue-42", "bifrost-a", "flexible_assets:type-9"): 3},
        "counts": {},
        "reconciliation_counts": {},
    }
    requests: list[tuple[str, dict, int]] = []
    reconciliations: list[str] = []

    async def get_run(run_id):
        return SimpleNamespace(id=run_id, data=run), run

    async def update_run(run_id, changes):
        run.update(changes)
        return run

    async def resolve_mappings(current_run):
        return [("itglue-42", "bifrost-a")]

    async def get_integration(name, scope):
        return SimpleNamespace(entity_id="itglue-42", config={"api_key": "not-a-real-key"})

    async def no_op(*args, **kwargs):
        return None

    async def audit(*args, **kwargs):
        return None

    async def true(*args, **kwargs):
        return True

    async def false(*args, **kwargs):
        return False

    async def item_counts(*args, **kwargs):
        return {"failed": 0}

    async def reconcile(*args, **kwargs):
        reconciliations.append(args[4].name)
        return {"deleted": 0}

    async def query(table, *, where, limit, offset=0):
        assert table == "docs-flexible-asset-types"
        assert where == {"organization_id": "bifrost-a", "source_system": "itglue"}
        return SimpleNamespace(documents=[
            SimpleNamespace(data={"source_id": "type-9"}),
            SimpleNamespace(data={"source_id": "type-10"}),
        ])

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def iter_pages(self, endpoint, *, params, start_page):
            if endpoint == "/flexible_assets":
                requests.append((endpoint, params, start_page))
            if False:
                yield None

    monkeypatch.setattr(migration, "_get_run", get_run)
    monkeypatch.setattr(migration, "_update_run", update_run)
    monkeypatch.setattr(migration, "_resolve_organization_mappings", resolve_mappings)
    monkeypatch.setattr(migration.integrations, "get", get_integration)
    monkeypatch.setattr(migration, "_write_audit", audit)
    monkeypatch.setattr(migration, "_cancel_requested", false)
    monkeypatch.setattr(migration, "_lease_owned", true)
    monkeypatch.setattr(migration, "_item_counts", item_counts)
    monkeypatch.setattr(migration, "_reconcile_resource", reconcile)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration, "ITGlueClient", Client)
    monkeypatch.setattr(migration.context, "is_platform_admin", True, raising=False)

    result = await migration.docs_migration_run("run-1")

    assert result["status"] == "completed"
    assert requests == [
        ("/flexible_assets", {"include": _spec("flexible_assets").include, "filter[organization_id]": "itglue-42", "filter[flexible_asset_type_id]": "type-9"}, 3),
        ("/flexible_assets", {"include": _spec("flexible_assets").include, "filter[organization_id]": "itglue-42", "filter[flexible_asset_type_id]": "type-10"}, 1),
    ]
    assert reconciliations == ["flexible_assets", "passwords"]


@pytest.mark.asyncio
async def test_password_hydration_never_requests_password_values() -> None:
    requested_params: dict | None = None

    class Client:
        async def get_document(self, path, params=None):
            nonlocal requested_params
            assert path == "/passwords/7"
            requested_params = params
            return {"data": {"id": "7", "attributes": {"name": "VPN"}}}

    await migration._hydrate_resource(Client(), _spec("passwords"), {"id": "7"})

    assert requested_params is not None
    assert "show_password" not in requested_params


@pytest.mark.asyncio
async def test_unchanged_source_backfills_new_columns_without_overwriting_local_edits(monkeypatch):
    source = {"id": "loc-1", "attributes": {"name": "Source", "notes": "Source notes", "updated-at": "same"}}
    destination = {"organization_id": "org-a", "source_system": "itglue", "source_id": "loc-1", "name": "Local", "is_enabled": False}
    updates = []
    result, upserts, _ = await _process_location(
        monkeypatch, source=source, mapped={"source_updated_at": "same"},
        destination=destination, mode="bulk", updates=updates,
    )
    assert result == "skipped"
    domain_changes = [args[2] for args in updates if args[0] == _spec("locations").table]
    assert domain_changes == [{"notes": "Source notes"}]
    assert not any(table == _spec("locations").table for table, _, _ in upserts)


@pytest.mark.asyncio
async def test_attachment_completion_precedes_repoint_and_marks_verified_metadata(monkeypatch) -> None:
    events: list[str] = []
    stored: dict = {}

    async def get(*args, **kwargs):
        return SimpleNamespace(data={})

    async def exists(*args, **kwargs):
        return False

    async def signed_url(*args, **kwargs):
        return {"url": "/api/files/local-upload/attachment-1"}

    async def complete(**kwargs):
        assert kwargs["sha256"] == SHA256
        events.append("complete")

    async def upsert(table, row_id, data):
        events.append("upsert")
        stored.update(data)

    async def stream(*args, **kwargs):
        events.append("put")
        return 3, SHA256, True

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.files, "exists", exists)
    monkeypatch.setattr(migration.files, "get_signed_url", signed_url)
    monkeypatch.setattr(migration.context, "public_url", "https://bifrost.test", raising=False)
    monkeypatch.setattr(migration, "complete_signed_upload", complete)

    await migration._transfer_file(
        SimpleNamespace(stream_to_signed_url=stream),
        "org-a", "documents", "parent",
        {"id": "attachment-1", "attributes": {
            "download-url": "https://source.test/guide.pdf",
            "attachment-file-name": "guide.pdf",
        }},
        file_kind="attachment",
    )

    assert events == ["put", "complete", "upsert"]
    assert stored["transfer_version"] == migration.TRANSFER_VERSION
    assert stored["metadata_registered"] is True
    assert stored["size_verified"] is True


@pytest.mark.asyncio
async def test_attachment_completion_failure_preserves_valid_prior_metadata(monkeypatch) -> None:
    """A failed finalization cannot replace or delete a previously readable attachment."""
    prior = SimpleNamespace(data={
        "storage_path": f"org-a/itglue/documents/parent/{stable_id('org-a', 'attachment', 'attachment-1')}/guide.pdf",
        "storage_location": "docs-attachments",
        "source_updated_at": "2026-09-01T00:00:00Z",
        "transfer_version": migration.TRANSFER_VERSION,
        "metadata_registered": True,
        "size_verified": True,
        "sha256": SHA256,
    })
    mutations: list[str] = []
    signed_paths: list[str] = []

    async def get(*args, **kwargs): return prior
    async def exists(*args, **kwargs): return False
    async def signed_url(path, **kwargs):
        signed_paths.append(path)
        return {"url": "/api/files/local-upload/attachment-1"}
    async def stream(*args, **kwargs): return 3, SHA256, True
    async def complete(**kwargs): raise RuntimeError("metadata unavailable")
    async def upsert(*args, **kwargs): mutations.append("upsert")
    async def delete(*args, **kwargs): mutations.append("delete")

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.files, "exists", exists)
    monkeypatch.setattr(migration.files, "get_signed_url", signed_url)
    monkeypatch.setattr(migration.files, "delete", delete)
    monkeypatch.setattr(migration.context, "public_url", "https://bifrost.test", raising=False)
    monkeypatch.setattr(migration, "complete_signed_upload", complete)

    with pytest.raises(RuntimeError, match="metadata unavailable"):
        await migration._transfer_file(
            SimpleNamespace(stream_to_signed_url=stream), "org-a", "documents", "parent",
            {"id": "attachment-1", "attributes": {
                "download-url": "https://source.test/guide.pdf",
                "attachment-file-name": "guide.pdf",
                "updated-at": "2026-09-01T00:00:00Z",
            }},
            file_kind="attachment",
        )

    assert mutations == []
    assert signed_paths != [prior.data["storage_path"]]


@pytest.mark.asyncio
async def test_legacy_same_watermark_retransfers_until_metadata_is_registered(monkeypatch) -> None:
    attachment_id = stable_id("org-a", "attachment", "attachment-1")
    path = f"org-a/itglue/documents/parent/{attachment_id}/guide.pdf"
    prior = SimpleNamespace(data={
        "storage_path": path,
        "storage_location": "docs-attachments",
        "source_updated_at": "2026-09-01T00:00:00Z",
        "size_verified": True,
        "sha256": SHA256,
        # Deliberately no transfer_version or metadata_registered: the old
        # presigned PUT path never populated platform file metadata.
    })
    uploads = 0
    finalized = 0

    async def get(*args, **kwargs): return prior
    async def exists(*args, **kwargs): return True
    async def signed_url(*args, **kwargs): return {"url": "/api/files/local-upload/attachment-1"}
    async def stream(*args, **kwargs):
        nonlocal uploads
        uploads += 1
        return 3, SHA256, True
    async def complete(**kwargs):
        nonlocal finalized
        finalized += 1
    async def upsert(*args, **kwargs): return None
    async def stat(*args, **kwargs): return {"exists": False}

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.files, "exists", exists)
    monkeypatch.setattr(migration.files, "get_signed_url", signed_url)
    monkeypatch.setattr(migration.files, "stat", stat)
    monkeypatch.setattr(migration.context, "public_url", "https://bifrost.test", raising=False)
    monkeypatch.setattr(migration, "complete_signed_upload", complete)

    await migration._transfer_file(
        SimpleNamespace(stream_to_signed_url=stream), "org-a", "documents", "parent",
        {"id": "attachment-1", "attributes": {
            "download-url": "https://source.test/guide.pdf",
            "attachment-file-name": "guide.pdf",
            "updated-at": "2026-09-01T00:00:00Z",
        }},
        file_kind="attachment",
    )

    assert (uploads, finalized) == (1, 1)


@pytest.mark.asyncio
async def test_measured_fallback_finalizes_and_records_stale_declared_size(monkeypatch) -> None:
    finalized: dict = {}
    stored: dict = {}

    async def get(*args, **kwargs): return None
    async def signed_url(*args, **kwargs): return {"url": "/api/files/local-upload/attachment-1"}
    async def stream(*args, **kwargs): return 3, SHA256, False
    async def complete(**kwargs): finalized.update(kwargs)
    async def upsert(table, row_id, data): stored.update(data)

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.files, "get_signed_url", signed_url)
    monkeypatch.setattr(migration.context, "public_url", "https://bifrost.test", raising=False)
    monkeypatch.setattr(migration, "complete_signed_upload", complete)

    await migration._transfer_file(
        SimpleNamespace(stream_to_signed_url=stream), "org-a", "documents", "parent",
        {"id": "attachment-1", "attributes": {
            "download-url": "https://source.test/guide.pdf",
            "attachment-file-name": "guide.pdf",
            "attachment-file-size": 42,
        }},
        file_kind="attachment",
    )

    assert finalized["size_bytes"] == 3
    assert finalized["sha256"] == SHA256
    assert stored["size_verified"] is False
    assert stored["metadata_registered"] is True


@pytest.mark.asyncio
async def test_finalized_measured_fallback_can_skip_unchanged_source(monkeypatch) -> None:
    attachment_id = stable_id("org-a", "attachment", "attachment-1")
    item = {"id": "attachment-1", "attributes": {
        "download-url": "https://source.test/guide.pdf",
        "attachment-file-name": "guide.pdf",
        "updated-at": "2026-09-01T00:00:00Z",
    }}
    path = migration._attachment_storage_path(
        "org-a", "documents", "parent", attachment_id, "guide.pdf", item
    )
    prior = SimpleNamespace(data={
        "storage_path": path,
        "storage_location": "docs-attachments",
        "source_updated_at": "2026-09-01T00:00:00Z",
        "transfer_version": migration.TRANSFER_VERSION,
        "metadata_registered": True,
        "size_verified": False,
        "sha256": SHA256,
    })

    async def get(*args, **kwargs): return prior
    async def exists(*args, **kwargs): return True
    async def signed_url(*args, **kwargs): raise AssertionError("unchanged fallback must skip")

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.files, "exists", exists)
    monkeypatch.setattr(migration.files, "get_signed_url", signed_url)

    await migration._transfer_file(
        SimpleNamespace(), "org-a", "documents", "parent", item, file_kind="attachment"
    )


@pytest.mark.asyncio
async def test_invalid_digest_is_never_finalized_or_attached(monkeypatch) -> None:
    finalized = False
    upserted = False

    async def get(*args, **kwargs): return None
    async def signed_url(*args, **kwargs): return {"url": "/api/files/local-upload/attachment-1"}
    async def stream(*args, **kwargs): return 3, "not-a-sha256", True
    async def complete(**kwargs):
        nonlocal finalized
        finalized = True
    async def upsert(*args, **kwargs):
        nonlocal upserted
        upserted = True

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.files, "get_signed_url", signed_url)
    monkeypatch.setattr(migration.context, "public_url", "https://bifrost.test", raising=False)
    monkeypatch.setattr(migration, "complete_signed_upload", complete)

    with pytest.raises(ITGlueError, match="valid SHA-256"):
        await migration._transfer_file(
            SimpleNamespace(stream_to_signed_url=stream), "org-a", "documents", "parent",
            {"id": "attachment-1", "attributes": {
                "download-url": "https://source.test/guide.pdf",
                "attachment-file-name": "guide.pdf",
            }},
            file_kind="attachment",
        )

    assert finalized is False
    assert upserted is False


@pytest.mark.asyncio
async def test_child_transfer_failure_keeps_failed_source_seen_while_syncing_siblings_and_relationships(
    monkeypatch,
) -> None:
    spec = _spec("documents")
    attachments = [
        {"id": "attachment-bad", "type": "attachments", "attributes": {}},
        {"id": "attachment-good", "type": "attachments", "attributes": {}},
    ]
    images = [{"id": "image-good", "type": "document_images", "attributes": {}}]
    related = [{"id": "related-good", "type": "related_items", "attributes": {}}]
    transferred: list[str] = []
    stored_relationships: list[str] = []
    pruned: list[tuple[str, set[str]]] = []

    async def transfer_file(*args, **kwargs):
        source_id = args[4]["id"]
        if source_id == "attachment-bad":
            raise ITGlueError("source https://example.test/signed?token=secret failed", status_code=429)
        transferred.append(source_id)

    async def store_related(*args):
        stored_relationships.extend(item["id"] for item in args[3])

    async def prune(*args):
        pruned.append((args[3], args[4]))

    monkeypatch.setattr(migration, "_transfer_file", transfer_file)
    monkeypatch.setattr(migration, "_store_related_items", store_related)
    monkeypatch.setattr(migration, "_prune_owned_children", prune)

    with pytest.raises(ITGlueError) as exc_info:
        await migration._sync_resource_children(
            object(), "org-a", spec, "document-1", [*attachments, *related], images, restricted=False
        )

    assert exc_info.value.status_code == 429
    assert "attachment-bad" in str(exc_info.value)
    assert "https://" not in str(exc_info.value)
    assert "secret" not in str(exc_info.value)
    assert transferred == ["attachment-good", "image-good"]
    assert stored_relationships == ["related-good"]
    assert pruned == [
        (migration.ATTACHMENTS_TABLE, {"attachment-bad", "attachment-good", "image-good"}),
        (migration.RELATIONSHIPS_TABLE, {"related-good"}),
    ]


@pytest.mark.asyncio
async def test_password_metadata_sync_never_transfers_binary_attachments_or_prunes_historical_files(monkeypatch) -> None:
    pruned = []
    stored = []

    async def transfer(*args, **kwargs):
        raise AssertionError("Password attachments must stay outside binary migration")

    async def prune(*args):
        pruned.append((args[3], args[4]))

    async def relationships(*args):
        stored.extend(item["id"] for item in args[3])

    monkeypatch.setattr(migration, "_transfer_file", transfer)
    monkeypatch.setattr(migration, "_prune_owned_children", prune)
    monkeypatch.setattr(migration, "_store_related_items", relationships)
    await migration._sync_resource_children(
        object(), "org-a", _spec("passwords"), "password-1",
        [{"id": "protected-file", "type": "attachments", "attributes": {}},
         {"id": "related-safe", "type": "related_items", "attributes": {}}],
        [], restricted=True,
    )
    assert stored == ["related-safe"]
    assert pruned == [(migration.RELATIONSHIPS_TABLE, {"related-safe"})]


@pytest.mark.asyncio
async def test_child_sync_keeps_existing_all_valid_transfer_and_pruning_behavior(monkeypatch) -> None:
    spec = _spec("documents")
    transferred: list[str] = []
    pruned: list[tuple[str, set[str]]] = []

    async def transfer_file(*args, **kwargs):
        transferred.append(args[4]["id"])

    async def store_related(*args):
        return None

    async def prune(*args):
        pruned.append((args[3], args[4]))

    monkeypatch.setattr(migration, "_transfer_file", transfer_file)
    monkeypatch.setattr(migration, "_store_related_items", store_related)
    monkeypatch.setattr(migration, "_prune_owned_children", prune)

    await migration._sync_resource_children(
        object(), "org-a", spec, "document-1",
        [{"id": "attachment-1", "type": "attachments", "attributes": {}}, {"id": "related-1", "type": "related_items", "attributes": {}}],
        [{"id": "image-1", "type": "document_images", "attributes": {}}],
        restricted=False,
    )

    assert transferred == ["attachment-1", "image-1"]
    assert pruned == [
        (migration.ATTACHMENTS_TABLE, {"attachment-1", "image-1"}),
        (migration.RELATIONSHIPS_TABLE, {"related-1"}),
    ]



@pytest.mark.asyncio
async def test_legacy_html_transfer_failure_quarantines_prior_attachment_but_current_verified_prior_is_preserved(
    monkeypatch,
) -> None:
    stored: list[dict] = []
    prior_data = {
        "organization_id": "org-a",
        "source_system": "itglue",
        "source_id": "attachment-1",
        "storage_path": "org-a/legacy/attachment-1.pdf",
        "storage_location": "docs-attachments",
        "transfer_version": "legacy-put-v1",
        "metadata_registered": False,
    }

    async def get(*args, **kwargs):
        return SimpleNamespace(data=prior_data)

    async def signed_url(*args, **kwargs):
        return {"url": "/api/files/local-upload/attachment-1"}

    async def stream(*args, **kwargs):
        raise ITGlueError("[xfer-v7] File transfer rejected unexpected HTML (response_html=True)")

    async def upsert(table, row_id, data):
        assert (table, row_id) == (migration.ATTACHMENTS_TABLE, stable_id("org-a", "attachment", "attachment-1"))
        stored.append(data)

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.files, "get_signed_url", signed_url)
    monkeypatch.setattr(migration.context, "public_url", "https://bifrost.test", raising=False)

    item = {"id": "attachment-1", "attributes": {
        "download-url": "https://source.test/attachment?token=secret",
        "attachment-file-name": "guide.pdf",
    }}
    with pytest.raises(ITGlueError, match="unexpected HTML"):
        await migration._transfer_file(
            SimpleNamespace(stream_to_signed_url=stream), "org-a", "documents", "parent", item, file_kind="attachment"
        )

    assert len(stored) == 1
    assert stored[0]["storage_path"] == prior_data["storage_path"]
    assert stored[0]["quarantined"] is True
    assert "https://" not in stored[0]["integrity_error"]

    stored.clear()
    prior_data["transfer_version"] = migration.TRANSFER_VERSION
    prior_data["metadata_registered"] = True
    prior_data["sha256"] = SHA256
    with pytest.raises(ITGlueError, match="unexpected HTML"):
        await migration._transfer_file(
            SimpleNamespace(stream_to_signed_url=stream), "org-a", "documents", "parent", item, file_kind="attachment"
        )
    assert stored == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("asset_type", "expected_type"),
    [
        ("configuration", "configurations"),
        ("configurations", "configurations"),
        ("location", "locations"),
        ("locations", "locations"),
        ("document", "documents"),
        ("documents", "documents"),
        ("document/folder", "document_folders"),
        ("document-folder", "document_folders"),
        ("document_folders", "document_folders"),
        ("flexible_asset", "flexible_assets"),
        ("flexible-assets", "flexible_assets"),
        ("password", "passwords"),
        ("passwords", "passwords"),
    ],
)
async def test_related_items_project_hyphenated_asset_type_to_canonical_destination(
    monkeypatch, asset_type, expected_type
) -> None:
    written: list[tuple[str, str, dict]] = []

    async def upsert(table, row_id, data):
        written.append((table, row_id, data))

    monkeypatch.setattr(migration.tables, "upsert", upsert)
    await migration._store_related_items("org-a", "documents", "source-document", [{
        "id": "related-1",
        "attributes": {
            "asset-type": asset_type,
            "resource-id": "target-9",
            "resource-type-name": "Customer-defined display label",
        },
    }])

    table, row_id, data = written.pop()
    assert table == migration.RELATIONSHIPS_TABLE
    assert row_id == stable_id("org-a", "related_item", "related-1")
    assert data["target_type"] == expected_type
    assert data["target_source_id"] == "target-9"
    assert data["target_destination_id"] == stable_id("org-a", expected_type, "target-9")


@pytest.mark.asyncio
async def test_related_items_keeps_legacy_destination_type_fields_compatible(monkeypatch) -> None:
    written: list[dict] = []

    async def upsert(_table, _row_id, data):
        written.append(data)

    monkeypatch.setattr(migration.tables, "upsert", upsert)
    await migration._store_related_items("org-a", "documents", "source-document", [{
        "id": "related-legacy",
        "attributes": {"destination-type": "location", "destination-id": "legacy-9"},
    }])

    assert written[0]["target_type"] == "locations"
    assert written[0]["target_source_id"] == "legacy-9"
    assert written[0]["target_destination_id"] == stable_id("org-a", "locations", "legacy-9")


@pytest.mark.asyncio
async def test_related_items_preserve_unsupported_type_without_inventing_destination_id(monkeypatch) -> None:
    written: list[dict] = []

    async def upsert(_table, _row_id, data):
        written.append(data)

    monkeypatch.setattr(migration.tables, "upsert", upsert)
    await migration._store_related_items("org-a", "documents", "source-document", [{
        "id": "related-custom",
        "attributes": {
            "asset-type": "custom_device",
            "resource-id": "target-custom",
            "resource-type-name": "Customer device",
        },
    }])

    assert written[0]["target_type"] == "custom_device"
    assert written[0]["target_source_id"] == "target-custom"
    assert written[0]["target_destination_id"] is None
    assert written[0]["raw"]["attributes"]["resource-type-name"] == "Customer device"


def _related_item_targeting_configuration() -> list[dict]:
    return [{
        "id": "related-configuration",
        "attributes": {"asset-type": "configuration", "resource-id": "configuration-9"},
    }]


def _related_source_map(target_org_id: str, source_org_id: str) -> SimpleNamespace:
    destination_id = stable_id(target_org_id, "configurations", "configuration-9")
    return SimpleNamespace(
        id=source_map_id(target_org_id, "configurations", "configuration-9"),
        data={
            "organization_id": target_org_id,
            "source_organization_id": source_org_id,
            "resource_type": "configurations",
            "source_id": "configuration-9",
            "destination_id": destination_id,
        },
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("mapping_is_current", [True, False])
async def test_related_document_folder_uses_verified_mapping_and_preserves_raw_type(
    monkeypatch, mapping_is_current
) -> None:
    written: list[dict] = []
    folder_id = stable_id("org-target", "document_folders", "folder-9")
    folder_map = SimpleNamespace(
        id=source_map_id("org-target", "document_folders", "folder-9"),
        data={
            "organization_id": "org-target",
            "source_organization_id": "itglue-target",
            "resource_type": "document_folders",
            "source_id": "folder-9",
            "destination_id": folder_id,
        },
    )

    async def get(table, row_id):
        if table == migration.MAP_TABLE:
            assert row_id == source_map_id("org-parent", "document_folders", "folder-9")
            return None
        assert mapping_is_current
        assert (table, row_id) == ("docs-document-folders", folder_id)
        return SimpleNamespace(data={
            "organization_id": "org-target", "source_system": "itglue", "source_id": "folder-9",
        })

    async def query(table, *, where, limit):
        assert (table, where, limit) == (
            migration.MAP_TABLE, {"resource_type": "document_folders", "source_id": "folder-9"}, 2,
        )
        return SimpleNamespace(documents=[folder_map])

    async def list_mappings(*_args, **_kwargs):
        return [SimpleNamespace(
            organization_id="org-target",
            entity_id="itglue-target" if mapping_is_current else "itglue-repointed",
        )]

    async def upsert(_table, _row_id, data):
        written.append(data)

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.integrations, "list_mappings", list_mappings)
    source_item = {
        "id": "related-folder",
        "attributes": {"asset-type": "document/folder", "resource-id": "folder-9"},
    }
    await migration._store_related_items(
        "org-parent", "documents", "parent-1", [source_item], "itglue-parent"
    )

    assert written[0]["organization_id"] == "org-parent"
    assert written[0]["target_type"] == "document_folders"
    assert written[0]["target_destination_id"] == (folder_id if mapping_is_current else None)
    assert written[0]["raw"] == source_item


@pytest.mark.asyncio
async def test_related_items_link_a_unique_verified_foreign_source_map(monkeypatch) -> None:
    written: list[dict] = []
    foreign_map = _related_source_map("org-target", "itglue-target")
    foreign_destination = foreign_map.data["destination_id"]

    async def get(table, row_id):
        if table == migration.MAP_TABLE:
            assert row_id == source_map_id("org-parent", "configurations", "configuration-9")
            return None
        assert (table, row_id) == ("docs-configurations", foreign_destination)
        return SimpleNamespace(data={"organization_id": "org-target", "source_system": "itglue", "source_id": "configuration-9"})

    async def query(table, *, where, limit):
        assert (table, where, limit) == (migration.MAP_TABLE, {"resource_type": "configurations", "source_id": "configuration-9"}, 2)
        return SimpleNamespace(documents=[foreign_map])

    async def list_mappings(*_args, **_kwargs):
        return [SimpleNamespace(organization_id="org-target", entity_id="itglue-target")]

    async def upsert(_table, _row_id, data):
        written.append(data)

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.integrations, "list_mappings", list_mappings)

    await migration._store_related_items(
        "org-parent", "documents", "parent-1", _related_item_targeting_configuration(), "itglue-parent"
    )

    assert written[0]["organization_id"] == "org-parent"
    assert written[0]["target_destination_id"] == foreign_destination


@pytest.mark.asyncio
async def test_related_items_reject_foreign_map_when_current_integration_mapping_differs(monkeypatch) -> None:
    written: list[dict] = []
    foreign_map = _related_source_map("org-target", "itglue-target")

    async def get(table, _row_id):
        assert table == migration.MAP_TABLE
        return None

    async def query(*_args, **_kwargs):
        return SimpleNamespace(documents=[foreign_map])

    async def list_mappings(*_args, **_kwargs):
        return [SimpleNamespace(organization_id="org-target", entity_id="itglue-repointed")]

    async def upsert(_table, _row_id, data):
        written.append(data)

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.integrations, "list_mappings", list_mappings)

    await migration._store_related_items(
        "org-parent", "documents", "parent-1", _related_item_targeting_configuration(), "itglue-parent"
    )

    assert written[0]["target_destination_id"] is None


@pytest.mark.asyncio
async def test_related_items_reject_noncanonical_foreign_source_map(monkeypatch) -> None:
    written: list[dict] = []
    foreign_map = _related_source_map("org-target", "itglue-target")
    foreign_map.id = "noncanonical-map-id"

    async def get(table, _row_id):
        assert table == migration.MAP_TABLE
        return None

    async def query(*_args, **_kwargs):
        return SimpleNamespace(documents=[foreign_map])

    async def list_mappings(*_args, **_kwargs):
        return [SimpleNamespace(organization_id="org-target", entity_id="itglue-target")]

    async def upsert(_table, _row_id, data):
        written.append(data)

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.integrations, "list_mappings", list_mappings)

    await migration._store_related_items(
        "org-parent", "documents", "parent-1", _related_item_targeting_configuration(), "itglue-parent"
    )

    assert written[0]["target_destination_id"] is None


@pytest.mark.asyncio
async def test_related_items_reject_ambiguous_global_source_maps(monkeypatch) -> None:
    written: list[dict] = []

    async def get(table, _row_id):
        assert table == migration.MAP_TABLE
        return None

    async def query(*_args, **_kwargs):
        return SimpleNamespace(documents=[
            _related_source_map("org-target-a", "itglue-target-a"),
            _related_source_map("org-target-b", "itglue-target-b"),
        ])

    async def upsert(_table, _row_id, data):
        written.append(data)

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "upsert", upsert)

    await migration._store_related_items(
        "org-parent", "documents", "parent-1", _related_item_targeting_configuration(), "itglue-parent"
    )

    assert written[0]["target_destination_id"] is None


@pytest.mark.asyncio
async def test_related_items_rejects_native_foreign_destination_collision(monkeypatch) -> None:
    written: list[dict] = []
    foreign_map = _related_source_map("org-target", "itglue-target")

    async def get(table, row_id):
        if table == migration.MAP_TABLE:
            return None
        assert (table, row_id) == ("docs-configurations", foreign_map.data["destination_id"])
        return SimpleNamespace(data={"organization_id": "org-target", "source_system": "bifrost", "source_id": "configuration-9"})

    async def query(*_args, **_kwargs):
        return SimpleNamespace(documents=[foreign_map])

    async def list_mappings(*_args, **_kwargs):
        return [SimpleNamespace(organization_id="org-target", entity_id="itglue-target")]

    async def upsert(_table, _row_id, data):
        written.append(data)

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.integrations, "list_mappings", list_mappings)

    await migration._store_related_items(
        "org-parent", "documents", "parent-1", _related_item_targeting_configuration(), "itglue-parent"
    )

    assert written[0]["target_destination_id"] is None


@pytest.mark.asyncio
async def test_related_items_prefer_a_verified_same_organization_source_map(monkeypatch) -> None:
    written: list[dict] = []
    same_map = _related_source_map("org-parent", "itglue-parent")

    async def get(table, row_id):
        if table == migration.MAP_TABLE:
            assert row_id == same_map.id
            return same_map
        assert (table, row_id) == ("docs-configurations", same_map.data["destination_id"])
        return SimpleNamespace(data={"organization_id": "org-parent", "source_system": "itglue", "source_id": "configuration-9"})

    async def query(*_args, **_kwargs):
        raise AssertionError("A valid same-organization map must take precedence")

    async def list_mappings(*_args, **_kwargs):
        return [SimpleNamespace(organization_id="org-parent", entity_id="itglue-parent")]

    async def upsert(_table, _row_id, data):
        written.append(data)

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.integrations, "list_mappings", list_mappings)

    await migration._store_related_items(
        "org-parent", "documents", "parent-1", _related_item_targeting_configuration(), "itglue-parent"
    )

    assert written[0]["target_destination_id"] == same_map.data["destination_id"]


@pytest.mark.asyncio
async def test_related_items_keep_same_organization_pending_id_when_no_map_exists(monkeypatch) -> None:
    written: list[dict] = []
    map_queries: list[tuple[dict, int]] = []

    async def get(table, _row_id):
        assert table == migration.MAP_TABLE
        return None

    async def query(_table, *, where, limit):
        map_queries.append((where, limit))
        return SimpleNamespace(documents=[])

    async def upsert(_table, _row_id, data):
        written.append(data)

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "upsert", upsert)

    await migration._store_related_items(
        "org-parent", "documents", "parent-1", _related_item_targeting_configuration(), "itglue-parent"
    )

    assert map_queries == [({"resource_type": "configurations", "source_id": "configuration-9"}, 2)]
    assert written[0]["target_destination_id"] == stable_id("org-parent", "configurations", "configuration-9")
