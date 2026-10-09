from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from functions import file_grants


def test_customer_creates_only_own_exact_prefix(monkeypatch):
    writes: list[tuple] = []

    class Tables:
        async def get(self, table, row_id):
            return None

        async def insert(self, table, data, **kwargs):
            writes.append((table, data, kwargs))

    monkeypatch.setattr(file_grants, "tables", Tables())
    monkeypatch.setattr(
        file_grants,
        "context",
        SimpleNamespace(org_id="customer-a", is_platform_admin=False, organization=SimpleNamespace(is_provider=False)),
    )
    result = asyncio.run(file_grants.docs_ensure_file_grant("customer-a"))
    assert result == {"organization_id": "customer-a", "path_prefix": "customer-a"}
    assert writes[0][1] == result

    with pytest.raises(file_grants.UserError, match="own organization"):
        asyncio.run(file_grants.docs_ensure_file_grant("customer-b"))


def test_existing_prefix_must_be_exact(monkeypatch):
    class Tables:
        async def get(self, table, row_id):
            return SimpleNamespace(data={"organization_id": "customer-a", "path_prefix": "customer-b"})

    monkeypatch.setattr(file_grants, "tables", Tables())
    monkeypatch.setattr(
        file_grants,
        "context",
        SimpleNamespace(org_id="customer-a", is_platform_admin=False, organization=SimpleNamespace(is_provider=False)),
    )
    with pytest.raises(file_grants.UserError, match="administrator repair"):
        asyncio.run(file_grants.docs_ensure_file_grant("customer-a"))
