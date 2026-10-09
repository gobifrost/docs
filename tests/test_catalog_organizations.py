import asyncio
from pathlib import Path
from types import SimpleNamespace

import yaml

from functions import catalog


class _Organizations:
    def __init__(self, rows: list[object]) -> None:
        self.rows = rows
        self.calls = 0

    async def list(self) -> list[object]:
        self.calls += 1
        return self.rows


def test_customer_receives_only_its_trusted_organization_without_directory_access(monkeypatch) -> None:
    directory = _Organizations([])
    monkeypatch.setattr(
        catalog,
        "context",
        SimpleNamespace(
            org_id="customer-a",
            is_platform_admin=False,
            organization=SimpleNamespace(is_provider=False, name="Customer A"),
        ),
    )
    monkeypatch.setattr(catalog, "organizations", directory)

    result = asyncio.run(catalog.docs_list_organizations())

    assert result == {
        "caller_mode": "fixed",
        "own_organization_id": "customer-a",
        "organizations": [{"id": "customer-a", "name": "Customer A"}],
    }
    assert directory.calls == 0


def test_provider_reads_only_active_organizations(monkeypatch) -> None:
    directory = _Organizations([
        SimpleNamespace(id="org-b", name="Beta", is_active=True),
        SimpleNamespace(id="org-a", name="Alpha", is_active=True),
        SimpleNamespace(id="org-inactive", name="Former customer", is_active=False),
    ])
    monkeypatch.setattr(
        catalog,
        "context",
        SimpleNamespace(
            org_id="provider-org",
            is_platform_admin=False,
            organization=SimpleNamespace(is_provider=True, name="Provider"),
        ),
    )
    monkeypatch.setattr(catalog, "organizations", directory)

    result = asyncio.run(catalog.docs_list_organizations())

    assert result == {
        "caller_mode": "picker",
        "own_organization_id": "provider-org",
        "organizations": [{"id": "org-a", "name": "Alpha"}, {"id": "org-b", "name": "Beta"}],
    }
    assert directory.calls == 1


def test_customer_without_an_organization_cannot_enumerate_the_directory(monkeypatch) -> None:
    directory = _Organizations([])
    monkeypatch.setattr(
        catalog,
        "context",
        SimpleNamespace(org_id=None, is_platform_admin=False, organization=SimpleNamespace(is_provider=False)),
    )
    monkeypatch.setattr(catalog, "organizations", directory)

    result = asyncio.run(catalog.docs_list_organizations())

    assert result == {"caller_mode": "missing", "own_organization_id": None, "organizations": []}
    assert directory.calls == 0


def test_directory_workflow_is_available_to_all_docs_roles() -> None:
    workflows = yaml.safe_load((Path(__file__).parents[1] / ".bifrost" / "workflows.yaml").read_text())["workflows"]
    workflow = workflows["b7a4a0a3-df26-40b4-b0a4-5601854f4cd6"]

    assert workflow["type"] == "workflow"
    assert workflow["path"] == "functions/catalog.py"
    assert workflow["function_name"] == "docs_list_organizations"
    assert workflow["access_level"] == "role_based"
    assert workflow["role_names"] == ["Bifrost Docs Reader", "Bifrost Docs Editor", "Bifrost Docs Administrator"]
