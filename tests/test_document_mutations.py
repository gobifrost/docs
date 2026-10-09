from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from functions import document_mutations


def _set_context(monkeypatch, *, org_id: str, provider: bool = False, platform: bool = False) -> None:
    monkeypatch.setattr(
        document_mutations,
        "context",
        SimpleNamespace(
            org_id=org_id,
            user_id="user-1",
            is_platform_admin=platform,
            organization=SimpleNamespace(is_provider=provider),
        ),
    )


def test_update_preserves_itglue_provenance_and_refreshes_the_tenant_index(monkeypatch) -> None:
    document = {
        "organization_id": "customer-a",
        "source_system": "itglue",
        "source_id": "itglue-doc-1",
        "source_url": "https://app.itglue.test/documents/1",
        "source_updated_at": "2026-09-22T00:00:00Z",
        "raw": {"id": "itglue-doc-1"},
        "restricted": True,
        "name": "Old title",
        "content": "Old content",
        "folder_id": "old-folder",
    }
    updates: list[tuple[str, str, dict, dict]] = []
    audits: list[dict] = []
    indexed: list[tuple[str, str]] = []

    class Tables:
        async def get(self, table, row_id, **kwargs):
            if (table, row_id) == (document_mutations.DOCUMENTS_TABLE, "doc-1"):
                return SimpleNamespace(id="doc-1", data=dict(document))
            if (table, row_id) == (document_mutations.FOLDERS_TABLE, "new-folder"):
                assert kwargs == {"scope": "customer-a"}
                return SimpleNamespace(id="new-folder", data={"organization_id": "customer-a"})
            raise AssertionError((table, row_id))

        async def update(self, table, row_id, data, **kwargs):
            updates.append((table, row_id, data, kwargs))
            return SimpleNamespace(id=row_id, data={**document, **data})

        async def insert(self, table, data, **kwargs):
            audits.append(data)

    async def sync(org_id, doc_id):
        indexed.append((org_id, doc_id))

    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(document_mutations, "tables", Tables())
    monkeypatch.setattr(document_mutations, "sync_document_index", sync)

    result = asyncio.run(
        document_mutations.docs_update_document(
            "doc-1", "New title", "New safe content", "new-folder"
        )
    )

    assert result == {"document_id": "doc-1", "organization_id": "customer-a", "status": "updated"}
    assert updates == [
        (
            document_mutations.DOCUMENTS_TABLE,
            "doc-1",
            {
                "name": "New title",
                "content": "New safe content",
                "rendered_content": "New safe content",
                "folder_id": "new-folder",
            },
            {"scope": "customer-a"},
        )
    ]
    assert indexed == [("customer-a", "doc-1")]
    assert audits[0]["event_type"] == "document.updated"
    assert "source_system" not in updates[0][2]
    assert "source_updated_at" not in updates[0][2]


def test_customer_cannot_update_another_tenant_document(monkeypatch) -> None:
    class Tables:
        async def get(self, *args, **kwargs):
            return SimpleNamespace(id="doc-1", data={"organization_id": "customer-b"})

    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(document_mutations, "tables", Tables())

    with pytest.raises(document_mutations.UserError, match="own organization"):
        asyncio.run(document_mutations.docs_update_document("doc-1", "Title", "Content", None))


def test_update_rejects_moving_an_existing_document_into_a_restricted_folder(monkeypatch) -> None:
    document = {
        "organization_id": "customer-a",
        "source_system": "bifrost",
        "source_id": "native-doc-1",
        "name": "Draft",
        "content": "Safe content",
        "folder_id": None,
        "restricted": False,
    }

    class Tables:
        async def get(self, table, row_id, **kwargs):
            if table == document_mutations.DOCUMENTS_TABLE:
                return SimpleNamespace(id="doc-1", data=dict(document))
            if table == document_mutations.FOLDERS_TABLE:
                assert kwargs == {"scope": "customer-a"}
                return SimpleNamespace(id="restricted-folder", data={"organization_id": "customer-a", "restricted": True})
            raise AssertionError((table, row_id))

        async def update(self, *_args, **_kwargs):
            raise AssertionError("restricted folder move must not write the document")

    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(document_mutations, "tables", Tables())

    with pytest.raises(document_mutations.UserError, match="restriction promotion"):
        asyncio.run(
            document_mutations.docs_update_document("doc-1", "New title", "New content", "restricted-folder")
        )


def test_update_rolls_back_presentation_fields_when_index_refresh_fails(monkeypatch) -> None:
    document = {
        "organization_id": "customer-a",
        "source_system": "itglue",
        "source_id": "itglue-doc-1",
        "name": "Old title",
        "content": "Old content",
        "rendered_content": "Old content",
        "folder_id": "old-folder",
    }
    updates: list[dict] = []
    index_attempts = 0
    audits: list[dict] = []

    class Tables:
        async def get(self, table, row_id, **kwargs):
            return SimpleNamespace(id="doc-1", data=dict(document))

        async def update(self, table, row_id, data, **kwargs):
            document.update(data)
            updates.append(dict(data))
            return SimpleNamespace(id=row_id, data=dict(document))

        async def insert(self, table, data, **kwargs):
            audits.append(data)

    async def sync(org_id, doc_id):
        nonlocal index_attempts
        index_attempts += 1
        raise RuntimeError("embedding service unavailable")

    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(document_mutations, "tables", Tables())
    monkeypatch.setattr(document_mutations, "sync_document_index", sync)

    with pytest.raises(document_mutations.UserError, match="rolled back"):
        asyncio.run(document_mutations.docs_update_document("doc-1", "New title", "New content", None))

    assert document["name"] == "Old title"
    assert document["content"] == "Old content"
    assert document["rendered_content"] == "Old content"
    assert document["folder_id"] == "old-folder"
    assert updates == [
        {"name": "New title", "content": "New content", "rendered_content": "New content", "folder_id": None},
        {"name": "Old title", "content": "Old content", "rendered_content": "Old content", "folder_id": "old-folder"},
    ]
    assert index_attempts == 2
    assert audits == []


def test_delete_removes_index_owned_files_attachment_and_relationship_rows_then_document(monkeypatch) -> None:
    document = {
        "organization_id": "customer-a",
        "source_system": "itglue",
        "source_id": "itglue-doc-1",
        "name": "Imported document",
        "restricted": True,
    }
    deleted_rows: list[tuple[str, str, dict]] = []
    file_deletes: list[tuple[str, str, str, str]] = []
    index_deletes: list[tuple[str, str]] = []
    audits: list[dict] = []
    attachment_pages = [[SimpleNamespace(id="attachment-1", data={
        "organization_id": "customer-a", "source_system": "itglue", "source_id": "source-attachment-1",
        "parent_type": "documents", "parent_id": "doc-1", "file_name": "file.pdf",
        "storage_path": "customer-a/itglue/documents/doc-1/attachment-1/v-abc/file.pdf",
        "storage_location": "docs-restricted-attachments",
    })], []]
    outgoing_relationship_pages = [[SimpleNamespace(id="relationship-1", data={
        "organization_id": "customer-a",
        "source_type": "documents",
        "source_destination_id": "doc-1",
    })], []]
    incoming_relationship_pages = [[]]

    class Tables:
        async def get(self, table, row_id, **kwargs):
            if table == document_mutations.DOCUMENTS_TABLE:
                return SimpleNamespace(id="doc-1", data=document)
            raise AssertionError((table, row_id))

        async def query(self, table, **kwargs):
            if table == document_mutations.ATTACHMENTS_TABLE:
                return SimpleNamespace(documents=attachment_pages.pop(0))
            if table == document_mutations.RELATIONSHIPS_TABLE:
                if "source_destination_id" in kwargs["where"]:
                    return SimpleNamespace(documents=outgoing_relationship_pages.pop(0))
                assert kwargs["where"] == {
                    "organization_id": "customer-a",
                    "target_destination_id": "doc-1",
                }
                assert kwargs["scope"] == "customer-a"
                return SimpleNamespace(documents=incoming_relationship_pages.pop(0))
            raise AssertionError(table)

        async def delete_document(self, table, row_id, **kwargs):
            deleted_rows.append((table, row_id, kwargs))

        async def insert(self, table, data, **kwargs):
            audits.append(data)

    class Files:
        async def stat(self, path, *, location, scope):
            return {"exists": True, "version": "v1"}

        async def delete(self, path, *, location, scope, expected_version):
            file_deletes.append((path, location, scope, expected_version))

    async def delete_index(org_id, doc_id):
        index_deletes.append((org_id, doc_id))

    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(document_mutations, "tables", Tables())
    monkeypatch.setattr(document_mutations, "files", Files())
    monkeypatch.setattr(document_mutations, "delete_document_index", delete_index)

    result = asyncio.run(document_mutations.docs_delete_document("doc-1"))

    assert result == {"document_id": "doc-1", "organization_id": "customer-a", "status": "deleted"}
    assert index_deletes == [("customer-a", "doc-1")]
    assert file_deletes == [
        ("customer-a/itglue/documents/doc-1/attachment-1/v-abc/file.pdf", "docs-restricted-attachments", "customer-a", "v1")
    ]
    assert deleted_rows == [
        (document_mutations.ATTACHMENTS_TABLE, "attachment-1", {"scope": "customer-a"}),
        (document_mutations.RELATIONSHIPS_TABLE, "relationship-1", {"scope": "customer-a"}),
        (document_mutations.DOCUMENTS_TABLE, "doc-1", {"scope": "customer-a"}),
    ]
    assert audits[0]["event_type"] == "document.deleted"


def test_delete_removes_native_and_imported_incoming_relationships_for_the_document(monkeypatch) -> None:
    document = {"organization_id": "customer-a", "source_system": "bifrost", "source_id": "doc-1"}
    deleted_rows: list[tuple[str, str, dict]] = []
    audits: list[dict] = []
    outgoing_relationship_pages = [[]]
    incoming_relationship_pages = [[
        SimpleNamespace(id="native-incoming", data={
            "organization_id": "customer-a",
            "source_system": "bifrost",
            "target_destination_id": "doc-1",
        }),
        SimpleNamespace(id="imported-incoming", data={
            "organization_id": "customer-a",
            "source_system": "itglue",
            "target_destination_id": "doc-1",
        }),
        SimpleNamespace(id="other-document", data={
            "organization_id": "customer-a",
            "source_system": "bifrost",
            "target_destination_id": "doc-2",
        }),
        SimpleNamespace(id="other-tenant", data={
            "organization_id": "customer-b",
            "source_system": "bifrost",
            "target_destination_id": "doc-1",
        }),
    ], []]

    class Tables:
        async def get(self, table, row_id, **kwargs):
            assert (table, row_id) == (document_mutations.DOCUMENTS_TABLE, "doc-1")
            return SimpleNamespace(id="doc-1", data=document)

        async def query(self, table, **kwargs):
            if table == document_mutations.ATTACHMENTS_TABLE:
                return SimpleNamespace(documents=[])
            assert table == document_mutations.RELATIONSHIPS_TABLE
            if "source_destination_id" in kwargs["where"]:
                return SimpleNamespace(documents=outgoing_relationship_pages.pop(0))
            assert kwargs["where"] == {
                "organization_id": "customer-a",
                "target_destination_id": "doc-1",
            }
            assert kwargs["scope"] == "customer-a"
            return SimpleNamespace(documents=incoming_relationship_pages.pop(0))

        async def delete_document(self, table, row_id, **kwargs):
            deleted_rows.append((table, row_id, kwargs))

        async def insert(self, table, data, **kwargs):
            audits.append(data)

    async def delete_index(*args, **kwargs):
        return None

    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(document_mutations, "tables", Tables())
    monkeypatch.setattr(document_mutations, "delete_document_index", delete_index)

    asyncio.run(document_mutations.docs_delete_document("doc-1"))

    assert deleted_rows == [
        (document_mutations.RELATIONSHIPS_TABLE, "native-incoming", {"scope": "customer-a"}),
        (document_mutations.RELATIONSHIPS_TABLE, "imported-incoming", {"scope": "customer-a"}),
        (document_mutations.DOCUMENTS_TABLE, "doc-1", {"scope": "customer-a"}),
    ]
    assert audits[0]["metadata"]["relationship_count"] == 2


def test_delete_never_uses_an_attachment_path_outside_the_document_org_prefix(monkeypatch) -> None:
    document = {"organization_id": "customer-a", "source_system": "bifrost", "source_id": "doc-1"}
    file_calls: list[str] = []
    attachment_pages = [[SimpleNamespace(id="attachment-1", data={
        "storage_path": "customer-b/private.pdf", "storage_location": "docs-attachments",
    })], []]

    class Tables:
        async def get(self, *args, **kwargs):
            return SimpleNamespace(id="doc-1", data=document)

        async def query(self, table, **kwargs):
            if table == document_mutations.ATTACHMENTS_TABLE:
                return SimpleNamespace(documents=attachment_pages.pop(0))
            return SimpleNamespace(documents=[])

        async def delete_document(self, *args, **kwargs):
            return None

        async def insert(self, *args, **kwargs):
            return None

    class Files:
        async def stat(self, *args, **kwargs):
            file_calls.append("stat")
            return {"exists": True, "version": "v1"}

        async def delete(self, *args, **kwargs):
            file_calls.append("delete")

    async def delete_index(*args, **kwargs):
        return None

    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(document_mutations, "tables", Tables())
    monkeypatch.setattr(document_mutations, "files", Files())
    monkeypatch.setattr(document_mutations, "delete_document_index", delete_index)

    asyncio.run(document_mutations.docs_delete_document("doc-1"))

    assert file_calls == []


def test_delete_never_uses_stored_attachment_metadata_for_another_document_file(monkeypatch) -> None:
    document = {"organization_id": "customer-a", "source_system": "bifrost", "source_id": "doc-1"}
    file_calls: list[str] = []
    attachment_pages = [[SimpleNamespace(id="attachment-1", data={
        "organization_id": "customer-a", "source_system": "bifrost", "source_id": "attachment-1",
        "parent_type": "documents", "parent_id": "doc-1", "file_kind": "attachment", "file_name": "secret.pdf",
        "storage_path": "customer-a/bifrost/documents/other-document/attachment-1/secret.pdf",
        "storage_location": "docs-attachments",
    })], []]

    class Tables:
        async def get(self, *args, **kwargs): return SimpleNamespace(id="doc-1", data=document)
        async def query(self, table, **kwargs):
            return SimpleNamespace(documents=attachment_pages.pop(0) if table == document_mutations.ATTACHMENTS_TABLE else [])
        async def delete_document(self, *args, **kwargs): return None
        async def insert(self, *args, **kwargs): return None

    class Files:
        async def stat(self, *args, **kwargs):
            file_calls.append("stat")
            return {"exists": True, "version": "v1"}

        async def delete(self, *args, **kwargs):
            file_calls.append("delete")

    async def delete_index(*args, **kwargs): return None

    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(document_mutations, "tables", Tables())
    monkeypatch.setattr(document_mutations, "files", Files())
    monkeypatch.setattr(document_mutations, "delete_document_index", delete_index)

    asyncio.run(document_mutations.docs_delete_document("doc-1"))

    assert file_calls == []


def test_delete_index_failure_reports_a_retry_safe_error_without_deleting_rows(monkeypatch) -> None:
    deleted_rows: list[tuple] = []
    document = {"organization_id": "customer-a", "source_system": "itglue", "source_id": "itglue-doc-1"}

    class Tables:
        async def get(self, *args, **kwargs):
            return SimpleNamespace(id="doc-1", data=document)

        async def delete_document(self, *args, **kwargs):
            deleted_rows.append(args)

    async def delete_index(*args, **kwargs):
        raise RuntimeError("knowledge backend unavailable")

    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(document_mutations, "tables", Tables())
    monkeypatch.setattr(document_mutations, "delete_document_index", delete_index)

    with pytest.raises(document_mutations.UserError, match="may be retried"):
        asyncio.run(document_mutations.docs_delete_document("doc-1"))

    assert deleted_rows == []


def test_bulk_archive_archives_only_native_rows_and_reports_source_owned_rows(monkeypatch) -> None:
    rows = {
        "native-document": {
            "organization_id": "customer-a",
            "source_system": "bifrost",
            "source_id": "native-document",
            "status": "published",
            "archived": False,
            "restricted": False,
        },
        "source-document": {
            "organization_id": "customer-a",
            "source_system": "itglue",
            "source_id": "itglue-document",
            "status": "published",
            "archived": False,
            "restricted": False,
        },
        "already-archived": {
            "organization_id": "customer-a",
            "source_system": "bifrost",
            "source_id": "already-archived",
            "status": "archived",
            "archived": True,
            "restricted": False,
        },
    }
    updates: list[tuple[str, str, dict, dict]] = []
    audits: list[dict] = []
    indexed: list[tuple[str, str]] = []

    class Tables:
        async def get(self, table, row_id, **kwargs):
            assert table == document_mutations.DOCUMENTS_TABLE
            data = rows.get(row_id)
            return SimpleNamespace(id=row_id, data=dict(data)) if data else None

        async def update(self, table, row_id, data, **kwargs):
            assert table == document_mutations.DOCUMENTS_TABLE
            rows[row_id].update(data)
            updates.append((table, row_id, dict(data), kwargs))

        async def insert(self, table, data, **kwargs):
            assert table == document_mutations.AUDIT_TABLE
            audits.append(data)

    async def sync(org_id, document_id):
        indexed.append((org_id, document_id))

    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(document_mutations, "tables", Tables())
    monkeypatch.setattr(document_mutations, "sync_document_index", sync)

    result = asyncio.run(
        document_mutations.docs_bulk_archive_documents(
            ["native-document", "source-document", "already-archived", "native-document"]
        )
    )

    assert result == {
        "requested_count": 3,
        "archived_document_ids": ["native-document"],
        "already_archived_document_ids": ["already-archived"],
        "skipped_source_owned_document_ids": ["source-document"],
        "pending_index_cleanup_document_ids": [],
    }
    assert len(updates) == 1
    assert updates[0][0:2] == (document_mutations.DOCUMENTS_TABLE, "native-document")
    assert updates[0][2]["status"] == "archived"
    assert updates[0][2]["archived"] is True
    assert updates[0][2]["source_updated_at"]
    assert updates[0][3] == {"scope": "customer-a"}
    assert indexed == [("customer-a", "native-document")]
    assert len(audits) == 1
    assert audits[0]["event_type"] == "document.bulk_archived"
    assert audits[0]["metadata"] == {"source_system": "bifrost", "restricted": False}
    assert rows["source-document"]["archived"] is False


def test_bulk_archive_rejects_another_tenant_before_archiving_any_selection(monkeypatch) -> None:
    rows = {
        "native-document": {
            "organization_id": "customer-a",
            "source_system": "bifrost",
            "status": "published",
            "archived": False,
        },
        "other-tenant-document": {
            "organization_id": "customer-b",
            "source_system": "bifrost",
            "status": "published",
            "archived": False,
        },
    }
    updates: list[tuple] = []

    class Tables:
        async def get(self, table, row_id, **kwargs):
            return SimpleNamespace(id=row_id, data=dict(rows[row_id]))

        async def update(self, *args, **kwargs):
            updates.append((args, kwargs))

    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(document_mutations, "tables", Tables())

    with pytest.raises(document_mutations.UserError, match="own organization"):
        asyncio.run(
            document_mutations.docs_bulk_archive_documents(
                ["native-document", "other-tenant-document"]
            )
        )

    assert updates == []


def test_folder_only_update_preserves_large_imported_content_and_provenance(monkeypatch):
    original = {"organization_id": "customer-a", "name": "Original", "content": "x" * 40_000,
                "rendered_content": "<p>Original rendering</p>", "source_system": "itglue",
                "raw": {"id": "source-1"}, "folder_id": None}
    updates = []

    class Tables:
        async def get(self, table, row_id, **kwargs):
            data = original if table == document_mutations.DOCUMENTS_TABLE else {"organization_id": "customer-a"}
            return SimpleNamespace(id=row_id, data=data)

        async def update(self, table, row_id, data, **kwargs):
            updates.append(dict(data))

        async def insert(self, *args, **kwargs):
            pass

    async def sync(*args):
        pass

    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(document_mutations, "tables", Tables())
    monkeypatch.setattr(document_mutations, "sync_document_index", sync)
    asyncio.run(document_mutations.docs_update_document("doc-1", folder_id="folder-1"))
    assert updates == [{"folder_id": "folder-1"}]
