from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from functions import attachments


class _Tables:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], dict] = {}
        self.upserts: list[tuple[str, str, dict, dict]] = []
        self.deletes: list[tuple[str, str, dict]] = []
        self.inserts: list[tuple[str, dict, dict]] = []

    async def get(self, table: str, row_id: str, **kwargs):
        data = self.rows.get((table, row_id))
        return SimpleNamespace(id=row_id, data=dict(data)) if data else None

    async def upsert(self, table: str, row_id: str, data: dict, **kwargs):
        self.rows[(table, row_id)] = dict(data)
        self.upserts.append((table, row_id, dict(data), kwargs))
        return SimpleNamespace(id=row_id, data=dict(data))

    async def delete_document(self, table: str, row_id: str, **kwargs):
        self.rows.pop((table, row_id), None)
        self.deletes.append((table, row_id, kwargs))
        return True

    async def insert(self, table: str, data: dict, **kwargs):
        row_id = kwargs.get("id")
        if row_id:
            self.rows[(table, row_id)] = dict(data)
        self.inserts.append((table, dict(data), kwargs))
        return SimpleNamespace(id=f"audit-{len(self.inserts)}", data=dict(data))


class _Files:
    def __init__(self, stats: dict[tuple[str, str, str], dict]) -> None:
        self.stats = stats
        self.deletes: list[tuple[str, dict]] = []

    async def stat(self, path: str, **kwargs):
        return self.stats.get((path, kwargs["location"], kwargs["scope"]), {"exists": False})

    async def delete(self, path: str, **kwargs):
        self.deletes.append((path, kwargs))


def _set_context(monkeypatch, *, org_id: str, provider: bool = False) -> None:
    monkeypatch.setattr(
        attachments,
        "context",
        SimpleNamespace(
            org_id=org_id,
            user_id="user-1",
            is_platform_admin=False,
            organization=SimpleNamespace(is_provider=provider),
        ),
    )


def test_registers_only_an_uploaded_attachment_at_the_parent_scoped_path(monkeypatch) -> None:
    tables = _Tables()
    tables.rows[(attachments.DOCUMENTS_TABLE, "doc-1")] = {
        "organization_id": "customer-a",
        "restricted": True,
    }
    path = "customer-a/bifrost/documents/doc-1/123e4567-e89b-12d3-a456-426614174000/guide.pdf"
    files = _Files({(path, "docs-restricted-attachments", "customer-a"): {"exists": True, "size": 42}})
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(attachments, "tables", tables)
    monkeypatch.setattr(attachments, "files", files)

    result = asyncio.run(
        attachments.docs_register_attachment(
            parent_document_id="doc-1",
            storage_path=path,
            file_name="guide.pdf",
            content_type="application/pdf",
            size_bytes=42,
        )
    )

    assert result == {
        "attachment_id": "123e4567-e89b-12d3-a456-426614174000",
        "organization_id": "customer-a",
        "storage_location": "docs-restricted-attachments",
    }
    assert tables.inserts[0] == (
        attachments.ATTACHMENTS_TABLE,
        {
            "organization_id": "customer-a",
            "source_system": "bifrost",
            "source_id": "123e4567-e89b-12d3-a456-426614174000",
            "parent_type": "documents",
            "parent_id": "doc-1",
            "file_kind": "attachment",
            "restricted": True,
            "file_name": "guide.pdf",
            "content_type": "application/pdf",
            "size_bytes": 42,
            "storage_location": "docs-restricted-attachments",
            "storage_path": path,
        },
        {"id": "123e4567-e89b-12d3-a456-426614174000", "scope": "customer-a"},
    )
    assert tables.inserts[1][1]["event_type"] == "attachment.registered"


@pytest.mark.parametrize(
    ("parent_type", "parent_table", "parent_id"),
    [
        ("configurations", "docs-configurations", "configuration-1"),
        ("locations", "docs-locations", "location-1"),
        ("flexible_assets", "docs-flexible-assets", "asset-1"),
    ],
)
def test_registers_native_attachments_for_supported_non_document_parents(
    monkeypatch, parent_type: str, parent_table: str, parent_id: str
) -> None:
    tables = _Tables()
    attachment_id = "123e4567-e89b-12d3-a456-426614174000"
    path = f"customer-a/bifrost/{parent_type}/{parent_id}/{attachment_id}/guide.pdf"
    tables.rows[(parent_table, parent_id)] = {"organization_id": "customer-a", "restricted": False}
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(attachments, "tables", tables)
    monkeypatch.setattr(attachments, "files", _Files({(path, "docs-attachments", "customer-a"): {"exists": True, "size": 42}}))

    result = asyncio.run(
        attachments.docs_register_attachment(
            parent_document_id=parent_id,
            parent_type=parent_type,
            storage_path=path,
            file_name="guide.pdf",
            content_type="application/pdf",
            size_bytes=42,
        )
    )

    assert result["attachment_id"] == attachment_id
    assert tables.inserts[0][1]["parent_type"] == parent_type
    assert tables.inserts[0][1]["parent_id"] == parent_id


def test_register_rejects_a_non_document_parent_path_for_another_parent_type(monkeypatch) -> None:
    tables = _Tables()
    tables.rows[("docs-configurations", "configuration-1")] = {"organization_id": "customer-a", "restricted": False}
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(attachments, "tables", tables)
    monkeypatch.setattr(attachments, "files", _Files({}))

    with pytest.raises(attachments.UserError, match="does not match"):
        asyncio.run(
            attachments.docs_register_attachment(
                parent_document_id="configuration-1",
                parent_type="configurations",
                storage_path="customer-a/bifrost/documents/configuration-1/123e4567-e89b-12d3-a456-426614174000/guide.pdf",
                file_name="guide.pdf",
                content_type="application/pdf",
                size_bytes=42,
            )
        )
    assert tables.inserts == []


def test_register_rejects_cross_tenant_or_unverified_paths_before_metadata_write(monkeypatch) -> None:
    tables = _Tables()
    tables.rows[(attachments.DOCUMENTS_TABLE, "doc-1")] = {
        "organization_id": "customer-a",
        "restricted": False,
    }
    _set_context(monkeypatch, org_id="customer-b")
    monkeypatch.setattr(attachments, "tables", tables)
    monkeypatch.setattr(attachments, "files", _Files({}))

    with pytest.raises(attachments.UserError, match="only for your own organization"):
        asyncio.run(
            attachments.docs_register_attachment(
                "doc-1",
                "customer-a/bifrost/documents/doc-1/123e4567-e89b-12d3-a456-426614174000/guide.pdf",
                "guide.pdf",
                "application/pdf",
                42,
            )
        )
    assert tables.upserts == []
    assert tables.inserts == []


def test_register_requires_the_uploaded_managed_file_to_exist(monkeypatch) -> None:
    tables = _Tables()
    tables.rows[(attachments.DOCUMENTS_TABLE, "doc-1")] = {
        "organization_id": "customer-a",
        "restricted": False,
    }
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(attachments, "tables", tables)
    monkeypatch.setattr(attachments, "files", _Files({}))

    with pytest.raises(attachments.UserError, match="not found"):
        asyncio.run(
            attachments.docs_register_attachment(
                "doc-1",
                "customer-a/bifrost/documents/doc-1/123e4567-e89b-12d3-a456-426614174000/guide.pdf",
                "guide.pdf",
                "application/pdf",
                42,
            )
        )
    assert tables.upserts == []
    assert tables.inserts == []


def test_register_never_overwrites_an_existing_imported_attachment_id(monkeypatch) -> None:
    tables = _Tables()
    attachment_id = "123e4567-e89b-12d3-a456-426614174000"
    path = f"customer-a/bifrost/documents/doc-1/{attachment_id}/guide.pdf"
    tables.rows[(attachments.DOCUMENTS_TABLE, "doc-1")] = {
        "organization_id": "customer-a",
        "restricted": False,
    }
    tables.rows[(attachments.ATTACHMENTS_TABLE, attachment_id)] = {
        "organization_id": "customer-a",
        "source_system": "itglue",
        "source_id": "source-attachment-1",
        "parent_id": "doc-1",
        "storage_path": path,
        "storage_location": "docs-attachments",
    }
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(attachments, "tables", tables)
    monkeypatch.setattr(
        attachments,
        "files",
        _Files({(path, "docs-attachments", "customer-a"): {"exists": True, "size": 42}}),
    )

    with pytest.raises(attachments.UserError, match="already belongs to another attachment"):
        asyncio.run(
            attachments.docs_register_attachment(
                "doc-1", path, "guide.pdf", "application/pdf", 42
            )
        )

    assert tables.rows[(attachments.ATTACHMENTS_TABLE, attachment_id)]["source_system"] == "itglue"
    assert tables.upserts == []


def test_register_idempotently_accepts_the_exact_same_native_attachment(monkeypatch) -> None:
    tables = _Tables()
    attachment_id = "123e4567-e89b-12d3-a456-426614174000"
    path = f"customer-a/bifrost/documents/doc-1/{attachment_id}/guide.pdf"
    tables.rows[(attachments.DOCUMENTS_TABLE, "doc-1")] = {
        "organization_id": "customer-a",
        "restricted": False,
    }
    tables.rows[(attachments.ATTACHMENTS_TABLE, attachment_id)] = {
        "organization_id": "customer-a",
        "source_system": "bifrost",
        "source_id": attachment_id,
        "parent_type": "documents",
        "parent_id": "doc-1",
        "file_kind": "attachment",
        "restricted": False,
        "file_name": "guide.pdf",
        "content_type": "application/pdf",
        "size_bytes": 42,
        "storage_location": "docs-attachments",
        "storage_path": path,
    }
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(attachments, "tables", tables)
    monkeypatch.setattr(
        attachments,
        "files",
        _Files({(path, "docs-attachments", "customer-a"): {"exists": True, "size": 42}}),
    )

    result = asyncio.run(
        attachments.docs_register_attachment("doc-1", path, "guide.pdf", "application/pdf", 42)
    )

    assert result["attachment_id"] == attachment_id
    assert [table for table, _, _ in tables.inserts] == [attachments.AUDIT_TABLE]


def test_delete_uses_current_file_version_then_removes_metadata_and_audits(monkeypatch) -> None:
    tables = _Tables()
    attachment_id = "123e4567-e89b-12d3-a456-426614174000"
    path = f"customer-a/bifrost/documents/doc-1/{attachment_id}/guide.pdf"
    tables.rows[(attachments.ATTACHMENTS_TABLE, attachment_id)] = {
        "organization_id": "customer-a",
        "storage_path": path,
        "storage_location": "docs-attachments",
        "restricted": False,
        "file_kind": "attachment",
        "file_name": "guide.pdf",
        "parent_type": "documents",
        "parent_id": "doc-1",
        "source_system": "bifrost",
        "source_id": attachment_id,
    }
    files = _Files({(path, "docs-attachments", "customer-a"): {"exists": True, "version": "v2"}})
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(attachments, "tables", tables)
    monkeypatch.setattr(attachments, "files", files)

    result = asyncio.run(attachments.docs_delete_attachment(attachment_id))

    assert result == {"attachment_id": attachment_id, "organization_id": "customer-a", "deleted": True}
    assert files.deletes == [
        (path, {"location": "docs-attachments", "scope": "customer-a", "expected_version": "v2"})
    ]
    assert tables.deletes == [(attachments.ATTACHMENTS_TABLE, attachment_id, {"scope": "customer-a"})]
    assert tables.inserts[0][1]["event_type"] == "attachment.deleted"


def test_delete_allows_a_verified_imported_document_image_in_the_content_location(monkeypatch) -> None:
    tables = _Tables()
    path = "customer-a/itglue/documents/doc-1/image-1/v-abc/diagram.png"
    tables.rows[(attachments.ATTACHMENTS_TABLE, "image-1")] = {
        "organization_id": "customer-a",
        "source_system": "itglue",
        "source_id": "source-image-1",
        "parent_type": "documents",
        "parent_id": "doc-1",
        "file_kind": "document_image",
        "file_name": "diagram.png",
        "restricted": False,
        "metadata_registered": True,
        "storage_path": path,
        "storage_location": "docs-content",
    }
    _set_context(monkeypatch, org_id="customer-a")
    files = _Files({(path, "docs-content", "customer-a"): {"exists": True, "version": "v3"}})
    monkeypatch.setattr(attachments, "tables", tables)
    monkeypatch.setattr(attachments, "files", files)

    asyncio.run(attachments.docs_delete_attachment("image-1"))

    assert files.deletes == [(path, {"location": "docs-content", "scope": "customer-a", "expected_version": "v3"})]


@pytest.mark.parametrize(
    "data",
    [
        {"parent_type": "documents", "file_kind": "document_image", "restricted": True, "metadata_registered": True, "storage_location": "docs-content"},
        {"parent_type": "documents", "file_kind": "attachment", "restricted": False, "storage_location": "docs-content"},
        {"parent_type": "documents", "file_kind": "document_image", "restricted": False, "metadata_registered": False, "storage_location": "docs-content"},
    ],
)
def test_delete_refuses_mismatched_or_unverified_image_content_metadata(monkeypatch, data: dict) -> None:
    tables = _Tables()
    tables.rows[(attachments.ATTACHMENTS_TABLE, "image-1")] = {
        "organization_id": "customer-a",
        "parent_id": "doc-1",
        "storage_path": "customer-a/itglue/documents/doc-1/image-1/v-abc/diagram.png",
        **data,
    }
    _set_context(monkeypatch, org_id="customer-a")
    files = _Files({})
    monkeypatch.setattr(attachments, "tables", tables)
    monkeypatch.setattr(attachments, "files", files)

    with pytest.raises(attachments.UserError):
        asyncio.run(attachments.docs_delete_attachment("image-1"))
    assert files.deletes == []
    assert tables.deletes == []


def test_delete_refuses_an_attachment_path_outside_the_organization_prefix(monkeypatch) -> None:
    tables = _Tables()
    tables.rows[(attachments.ATTACHMENTS_TABLE, "attachment-1")] = {
        "organization_id": "customer-a",
        "storage_path": "customer-b/bifrost/documents/doc-1/file.pdf",
        "storage_location": "docs-attachments",
        "file_kind": "attachment",
        "restricted": False,
    }
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(attachments, "tables", tables)
    monkeypatch.setattr(attachments, "files", _Files({}))

    with pytest.raises(attachments.UserError, match="organization-prefixed"):
        asyncio.run(attachments.docs_delete_attachment("attachment-1"))
    assert tables.deletes == []


def test_delete_refuses_stored_metadata_that_points_at_another_record_file(monkeypatch) -> None:
    """A forged attachment row must not turn document deletion into file authority."""
    tables = _Tables()
    path = "customer-a/bifrost/documents/other-document/123e4567-e89b-12d3-a456-426614174000/secret.pdf"
    tables.rows[(attachments.ATTACHMENTS_TABLE, "attachment-1")] = {
        "organization_id": "customer-a",
        "source_system": "bifrost",
        "source_id": "attachment-1",
        "parent_type": "documents",
        "parent_id": "document-1",
        "file_kind": "attachment",
        "file_name": "secret.pdf",
        "storage_path": path,
        "storage_location": "docs-attachments",
        "restricted": False,
    }
    _set_context(monkeypatch, org_id="customer-a")
    files = _Files({(path, "docs-attachments", "customer-a"): {"exists": True, "version": "v1"}})
    monkeypatch.setattr(attachments, "tables", tables)
    monkeypatch.setattr(attachments, "files", files)

    with pytest.raises(attachments.UserError, match="not owned by its metadata"):
        asyncio.run(attachments.docs_delete_attachment("attachment-1"))
    assert files.deletes == []
    assert tables.deletes == []
