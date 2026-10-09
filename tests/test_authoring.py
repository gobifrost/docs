from __future__ import annotations

import asyncio
import inspect
from types import SimpleNamespace

import pytest

from functions import authoring


class _Tables:
    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}
        self.inserts: list[tuple[str, str | None, dict, dict]] = []
        self.gets: list[tuple[str, str, dict]] = []
        self.updates: list[tuple[str, str, dict, dict]] = []

    async def insert(self, table: str, data: dict, **kwargs):
        row_id = kwargs.get("id") or f"row-{len(self.rows) + 1}"
        self.rows[row_id] = dict(data)
        self.inserts.append((table, kwargs.get("id"), dict(data), kwargs))
        return SimpleNamespace(id=row_id, data=dict(data))

    async def get(self, table: str, row_id: str, **kwargs):
        self.gets.append((table, row_id, dict(kwargs)))
        data = self.rows.get(row_id)
        return SimpleNamespace(id=row_id, data=dict(data)) if data else None

    async def update(self, table: str, row_id: str, data: dict, **kwargs):
        self.rows[row_id].update(data)
        self.updates.append((table, row_id, dict(data), kwargs))
        return SimpleNamespace(id=row_id, data=dict(self.rows[row_id]))


def _set_context(monkeypatch, *, org_id: str, provider: bool = False, platform: bool = False) -> None:
    monkeypatch.setattr(
        authoring,
        "context",
        SimpleNamespace(
            org_id=org_id,
            user_id="user-1",
            is_platform_admin=platform,
            organization=SimpleNamespace(is_provider=provider),
        ),
    )


def test_customer_author_cannot_create_a_document_for_another_organization(monkeypatch) -> None:
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(authoring, "tables", _Tables())

    with pytest.raises(authoring.UserError, match="only for your own organization"):
        asyncio.run(
            authoring.docs_create_draft(
                organization_id="customer-b",
                title="Recovery procedure",
                content="Contact the service desk and follow the recovery procedure.",
            )
        )


def test_create_draft_writes_a_native_scoped_draft_and_audit_event(monkeypatch) -> None:
    tables = _Tables()
    _set_context(monkeypatch, org_id="provider", provider=True)
    monkeypatch.setattr(authoring, "tables", tables)
    monkeypatch.setattr(authoring.uuid, "uuid4", lambda: "native-doc-1")

    result = asyncio.run(
        authoring.docs_create_draft(
            organization_id="customer-a",
            title="VPN recovery",
            content="Use the managed VPN client, then contact the service desk if access fails.",
            source_refs=[{"ticket_id": "HD-123", "ticket_url": "https://halo.example/tickets/123"}],
        )
    )

    assert result == {"document_id": "native-doc-1", "organization_id": "customer-a", "status": "draft"}
    document = tables.rows["native-doc-1"]
    assert document["source_system"] == "bifrost"
    assert document["source_id"] == "native-doc-1"
    assert document["status"] == "draft"
    assert document["visibility"] == "organization"
    assert document["source_refs"] == [{"ticket_id": "HD-123", "ticket_url": "https://halo.example/tickets/123"}]
    assert all(table != authoring.DOCUMENTS_TABLE or data["source_system"] == "bifrost" for table, _, data, _ in tables.inserts)
    audit = next(data for table, _, data, _ in tables.inserts if table == authoring.AUDIT_TABLE)
    assert audit["event_type"] == "document.draft_created"
    assert audit["organization_id"] == "customer-a"


def test_create_draft_persists_only_a_folder_from_the_target_organization(monkeypatch) -> None:
    tables = _Tables()
    tables.rows["folder-a"] = {"organization_id": "customer-a", "restricted": False}
    _set_context(monkeypatch, org_id="provider", provider=True)
    monkeypatch.setattr(authoring, "tables", tables)
    monkeypatch.setattr(authoring.uuid, "uuid4", lambda: "native-doc-1")

    asyncio.run(
        authoring.docs_create_draft(
            organization_id="customer-a",
            title="VPN recovery",
            content="Use the managed VPN client.",
            folder_id="folder-a",
        )
    )

    assert tables.rows["native-doc-1"]["folder_id"] == "folder-a"
    assert (authoring.FOLDERS_TABLE, "folder-a", {"scope": "customer-a"}) in tables.gets


def test_create_draft_in_a_restricted_folder_starts_restricted(monkeypatch) -> None:
    tables = _Tables()
    tables.rows["folder-a"] = {"organization_id": "customer-a", "restricted": True}
    _set_context(monkeypatch, org_id="provider", provider=True)
    monkeypatch.setattr(authoring, "tables", tables)
    monkeypatch.setattr(authoring.uuid, "uuid4", lambda: "native-doc-1")

    asyncio.run(
        authoring.docs_create_draft(
            organization_id="customer-a",
            title="Restricted runbook",
            content="Use the managed VPN client.",
            folder_id="folder-a",
        )
    )

    assert tables.rows["native-doc-1"]["restricted"] is True


def test_create_draft_rejects_a_folder_outside_the_target_organization(monkeypatch) -> None:
    tables = _Tables()
    tables.rows["other-folder"] = {"organization_id": "customer-b", "restricted": False}
    _set_context(monkeypatch, org_id="provider", provider=True)
    monkeypatch.setattr(authoring, "tables", tables)

    with pytest.raises(authoring.UserError, match="belongs to another organization"):
        asyncio.run(
            authoring.docs_create_draft(
                organization_id="customer-a",
                title="VPN recovery",
                content="Use the managed VPN client.",
                folder_id="other-folder",
            )
        )

    assert tables.inserts == []


def test_publish_requires_provider_context_confirmation_and_indexes_only_published_content(monkeypatch) -> None:
    tables = _Tables()
    tables.rows["native-doc-1"] = {
        "organization_id": "customer-a",
        "source_system": "bifrost",
        "source_id": "native-doc-1",
        "name": "VPN recovery",
        "content": "Use the managed VPN client.",
        "rendered_content": "Use the managed VPN client.",
        "status": "draft",
        "archived": False,
        "restricted": False,
    }
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(authoring, "tables", tables)
    synced: list[tuple[str, str]] = []

    async def sync(org_id: str, doc_id: str) -> None:
        synced.append((org_id, doc_id))

    monkeypatch.setattr(authoring, "sync_document_index", sync)
    with pytest.raises(authoring.UserError, match="provider or platform"):
        asyncio.run(authoring.docs_publish_draft("native-doc-1", confirmed=True))
    assert synced == []

    _set_context(monkeypatch, org_id="provider", provider=True)
    with pytest.raises(authoring.UserError, match="confirmation"):
        asyncio.run(authoring.docs_publish_draft("native-doc-1", confirmed=False))
    assert synced == []

    result = asyncio.run(authoring.docs_publish_draft("native-doc-1", confirmed=True))
    assert result == {"document_id": "native-doc-1", "organization_id": "customer-a", "status": "published"}
    assert tables.rows["native-doc-1"]["status"] == "published"
    assert synced == [("customer-a", "native-doc-1")]
    assert any(data["event_type"] == "document.published" for table, _, data, _ in tables.inserts if table == authoring.AUDIT_TABLE)


def test_publish_reverts_to_draft_when_knowledge_indexing_fails(monkeypatch) -> None:
    tables = _Tables()
    tables.rows["native-doc-1"] = {
        "organization_id": "customer-a",
        "source_system": "bifrost",
        "source_id": "native-doc-1",
        "name": "VPN recovery",
        "content": "Use the managed VPN client.",
        "status": "draft",
        "archived": False,
        "restricted": False,
    }
    _set_context(monkeypatch, org_id="provider", provider=True)
    monkeypatch.setattr(authoring, "tables", tables)

    async def failing_sync(*_args: str) -> None:
        raise RuntimeError("embedding service unavailable")

    monkeypatch.setattr(authoring, "sync_document_index", failing_sync)

    with pytest.raises(authoring.UserError, match="reverted to draft"):
        asyncio.run(authoring.docs_publish_draft("native-doc-1", confirmed=True))

    assert tables.rows["native-doc-1"]["status"] == "draft"
    assert tables.rows["native-doc-1"]["published_at"] is None
    assert any(
        data["event_type"] == "document.publish_reverted"
        for table, _, data, _ in tables.inserts
        if table == authoring.AUDIT_TABLE
    )


def test_secret_like_native_content_is_rejected_before_any_write(monkeypatch) -> None:
    tables = _Tables()
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(authoring, "tables", tables)

    with pytest.raises(authoring.UserError, match="secret-like"):
        asyncio.run(
            authoring.docs_create_draft(
                organization_id="customer-a",
                title="VPN recovery",
                content="api_key = abcdefghijklmnop",
            )
        )
    assert tables.inserts == []


def test_update_and_archive_only_mutate_native_drafts_and_remove_index(monkeypatch) -> None:
    tables = _Tables()
    tables.rows["native-doc-1"] = {
        "organization_id": "customer-a",
        "source_system": "bifrost",
        "source_id": "native-doc-1",
        "name": "Old title",
        "content": "Old safe content.",
        "status": "draft",
        "archived": False,
        "restricted": False,
    }
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(authoring, "tables", tables)
    synced: list[tuple[str, str]] = []

    async def sync(org_id: str, doc_id: str) -> None:
        synced.append((org_id, doc_id))

    monkeypatch.setattr(authoring, "sync_document_index", sync)

    updated = asyncio.run(
        authoring.docs_update_draft(
            "native-doc-1",
            title="New title",
            content="New safe content.",
            source_refs=[{"ticket_id": "HD-124", "ticket_url": "https://halo.example/tickets/124"}],
        )
    )
    archived = asyncio.run(authoring.docs_archive_native("native-doc-1"))

    assert updated["status"] == "draft"
    assert archived["status"] == "archived"
    assert tables.rows["native-doc-1"]["name"] == "New title"
    assert tables.rows["native-doc-1"]["archived"] is True
    assert synced == [("customer-a", "native-doc-1")]
    assert {data["event_type"] for table, _, data, _ in tables.inserts if table == authoring.AUDIT_TABLE} == {
        "document.draft_updated",
        "document.archived",
    }


def test_update_draft_preserves_or_explicitly_changes_its_folder(monkeypatch) -> None:
    tables = _Tables()
    tables.rows["native-doc-1"] = {
        "organization_id": "customer-a",
        "source_system": "bifrost",
        "source_id": "native-doc-1",
        "name": "Old title",
        "content": "Old safe content.",
        "status": "draft",
        "folder_id": "old-folder",
        "archived": False,
        "restricted": False,
    }
    tables.rows["new-folder"] = {"organization_id": "customer-a", "restricted": False}
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(authoring, "tables", tables)

    asyncio.run(
        authoring.docs_update_draft(
            "native-doc-1", title="First edit", content="First safe content."
        )
    )
    assert tables.rows["native-doc-1"]["folder_id"] == "old-folder"
    assert "folder_id" not in tables.updates[-1][2]

    asyncio.run(
        authoring.docs_update_draft(
            "native-doc-1", title="Second edit", content="Second safe content.", folder_id=None
        )
    )
    assert tables.rows["native-doc-1"]["folder_id"] is None
    assert tables.updates[-1][2]["folder_id"] is None

    asyncio.run(
        authoring.docs_update_draft(
            "native-doc-1", title="Third edit", content="Third safe content.", folder_id="new-folder"
        )
    )
    assert tables.rows["native-doc-1"]["folder_id"] == "new-folder"
    assert tables.updates[-1][2]["folder_id"] == "new-folder"
    assert (authoring.FOLDERS_TABLE, "new-folder", {"scope": "customer-a"}) in tables.gets


def test_update_draft_rejects_a_move_into_a_restricted_folder(monkeypatch) -> None:
    tables = _Tables()
    tables.rows["native-doc-1"] = {
        "organization_id": "customer-a",
        "source_system": "bifrost",
        "source_id": "native-doc-1",
        "name": "Old title",
        "content": "Old safe content.",
        "status": "draft",
        "folder_id": None,
        "archived": False,
        "restricted": False,
    }
    tables.rows["restricted-folder"] = {"organization_id": "customer-a", "restricted": True}
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(authoring, "tables", tables)

    with pytest.raises(authoring.UserError, match="restriction promotion"):
        asyncio.run(
            authoring.docs_update_draft(
                "native-doc-1",
                title="New title",
                content="New safe content.",
                folder_id="restricted-folder",
            )
        )

    assert tables.updates == []


def test_update_draft_uses_a_serializable_omitted_folder_marker() -> None:
    default = inspect.signature(authoring.docs_update_draft).parameters["folder_id"].default
    assert isinstance(default, str)


def test_archive_remains_safe_and_auditable_when_index_cleanup_fails(monkeypatch) -> None:
    tables = _Tables()
    tables.rows["native-doc-1"] = {
        "organization_id": "customer-a",
        "source_system": "bifrost",
        "source_id": "native-doc-1",
        "name": "VPN recovery",
        "content": "Use the managed VPN client.",
        "status": "published",
        "archived": False,
        "restricted": False,
    }
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(authoring, "tables", tables)

    async def failing_sync(*_args: str) -> None:
        raise RuntimeError("knowledge cleanup unavailable")

    monkeypatch.setattr(authoring, "sync_document_index", failing_sync)

    with pytest.raises(authoring.UserError, match="knowledge cleanup is pending"):
        asyncio.run(authoring.docs_archive_native("native-doc-1"))

    assert tables.rows["native-doc-1"]["status"] == "archived"
    assert tables.rows["native-doc-1"]["archived"] is True
    assert any(
        data["event_type"] == "document.archived_index_pending"
        for table, _, data, _ in tables.inserts
        if table == authoring.AUDIT_TABLE
    )


def test_folder_only_draft_update_preserves_body_and_ticket_citations(monkeypatch):
    tables = _Tables()
    original = {"organization_id": "customer-a", "source_system": "bifrost", "status": "draft",
                "name": "Original", "content": "x" * 40_000, "rendered_content": "<p>Original</p>",
                "source_refs": [{"ticket_id": "HD-1", "ticket_url": "https://halo.example/tickets/1"}],
                "source_url": "https://halo.example/tickets/1", "folder_id": None}
    tables.rows["doc-1"] = dict(original)
    tables.rows["folder-1"] = {"organization_id": "customer-a", "restricted": False}
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(authoring, "tables", tables)
    asyncio.run(authoring.docs_update_draft("doc-1", folder_id="folder-1"))
    assert tables.rows["doc-1"] == {**original, "folder_id": "folder-1", "source_updated_at": tables.rows["doc-1"]["source_updated_at"]}
    assert set(tables.updates[-1][2]) == {"folder_id", "source_updated_at"}
