import asyncio
from types import SimpleNamespace

import pytest

from functions import indexing
from modules.indexing_core import DOCUMENT_NAMESPACE, document_key


class _Knowledge:
    def __init__(self) -> None:
        self.stored: list[dict] = []
        self.deleted: list[dict] = []

    async def store(self, content: str, **kwargs) -> str:
        self.stored.append({"content": content, **kwargs})
        return "knowledge-id"

    async def delete(self, key: str, **kwargs) -> bool:
        self.deleted.append({"key": key, **kwargs})
        return True


class _Tables:
    def __init__(self, row) -> None:
        self.row = row

    async def get(self, table: str, document_id: str, **kwargs):
        assert table == "docs-documents"
        assert document_id == "document-1"
        assert kwargs == {"scope": "org-a"}
        return self.row


class _SearchKnowledge:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def search(self, query: str, **kwargs):
        self.calls.append({"query": query, **kwargs})
        return [
            SimpleNamespace(
                content="Safe VPN guidance",
                score=0.9,
                metadata={
                    "product": "bifrost-docs",
                    "resource_type": "document",
                    "organization_id": "org-a",
                    "document_id": "document-1",
                    "title": "VPN",
                    "citation": "IT Glue document source-1: VPN",
                    "source_system": "itglue",
                    "source_id": "source-1",
                    "source_updated_at": "",
                },
            ),
            SimpleNamespace(
                content="Must not escape tenant filtering",
                score=0.99,
                metadata={
                    "product": "bifrost-docs",
                    "resource_type": "document",
                    "organization_id": "other-org",
                },
            ),
        ]


def test_sync_document_index_upserts_only_the_safe_projection(monkeypatch) -> None:
    knowledge = _Knowledge()
    tables = _Tables(
        SimpleNamespace(
            data={
                "organization_id": "org-a",
                "source_system": "itglue",
                "source_id": "source-1",
                "name": "VPN",
                "rendered_content": "Connect through the managed VPN client.",
            }
        )
    )
    monkeypatch.setattr(indexing, "knowledge", knowledge)
    monkeypatch.setattr(indexing, "tables", tables)

    asyncio.run(indexing.sync_document_index("org-a", "document-1"))

    assert knowledge.deleted == []
    assert knowledge.stored == [
        {
            "content": "Connect through the managed VPN client.",
            "namespace": DOCUMENT_NAMESPACE,
            "key": document_key("org-a", "document-1"),
            "metadata": {
                "product": "bifrost-docs",
                "resource_type": "document",
                "organization_id": "org-a",
                "document_id": "document-1",
                "source_system": "itglue",
                "source_id": "source-1",
                "source_updated_at": "",
                "title": "VPN",
                "citation": "IT Glue document source-1: VPN",
            },
            "scope": "org-a",
        }
    ]


def test_sync_document_index_deletes_stale_entry_when_row_is_restricted(monkeypatch) -> None:
    knowledge = _Knowledge()
    tables = _Tables(
        SimpleNamespace(
            data={
                "organization_id": "org-a",
                "source_id": "source-1",
                "restricted": True,
            }
        )
    )
    monkeypatch.setattr(indexing, "knowledge", knowledge)
    monkeypatch.setattr(indexing, "tables", tables)

    asyncio.run(indexing.sync_document_index("org-a", "document-1"))

    assert knowledge.stored == []
    assert knowledge.deleted == [
        {
            "key": document_key("org-a", "document-1"),
            "namespace": DOCUMENT_NAMESPACE,
            "scope": "org-a",
        }
    ]


def test_delete_document_index_targets_only_the_scoped_stable_key(monkeypatch) -> None:
    knowledge = _Knowledge()
    monkeypatch.setattr(indexing, "knowledge", knowledge)

    asyncio.run(indexing.delete_document_index("org-a", "document-1"))

    assert knowledge.deleted == [
        {
            "key": document_key("org-a", "document-1"),
            "namespace": DOCUMENT_NAMESPACE,
            "scope": "org-a",
        }
    ]


def test_agent_search_disables_global_fallback_and_filters_stale_cross_tenant_rows(monkeypatch) -> None:
    knowledge = _SearchKnowledge()
    monkeypatch.setattr(indexing, "knowledge", knowledge)
    monkeypatch.setattr(indexing, "tables", _Tables(SimpleNamespace(data={
        "organization_id": "org-a",
        "source_system": "itglue",
        "source_id": "source-1",
        "name": "VPN",
        "rendered_content": "Safe VPN guidance",
    })))
    monkeypatch.setattr(
        indexing,
        "context",
        SimpleNamespace(
            org_id="org-a",
            is_platform_admin=False,
            organization=SimpleNamespace(is_provider=False),
        ),
    )

    result = asyncio.run(indexing.docs_search_knowledge("vpn"))

    assert knowledge.calls == [
        {
            "query": "vpn",
            "namespace": DOCUMENT_NAMESPACE,
            "limit": 5,
            "scope": "org-a",
            "fallback": False,
        }
    ]
    assert result["result_count"] == 1
    assert result["results"][0]["citation"] == "IT Glue document source-1: VPN"
    assert result["secrets_included"] is False


def test_index_repair_rejects_a_customer_supplied_foreign_organization_before_querying(monkeypatch) -> None:
    class Tables:
        async def query(self, *_args, **_kwargs):
            raise AssertionError("foreign organization must be rejected before querying")

    monkeypatch.setattr(indexing, "tables", Tables())
    monkeypatch.setattr(
        indexing,
        "context",
        SimpleNamespace(
            org_id="org-a",
            is_platform_admin=False,
            organization=SimpleNamespace(is_provider=False),
        ),
    )

    with pytest.raises(indexing.UserError, match="only your own organization"):
        asyncio.run(indexing.docs_sync_knowledge_index("org-b"))
