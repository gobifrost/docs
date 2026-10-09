from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from functions import folders


class _Tables:
    def __init__(self, rows: dict[str, dict]) -> None:
        self.rows = {row_id: dict(data) for row_id, data in rows.items()}
        self.queries: list[dict] = []
        self.updates: list[tuple[str, str, dict, dict]] = []
        self.inserts: list[tuple[str, dict, dict]] = []
        self.fail_on_update: str | None = None

    async def get(self, table: str, row_id: str, **kwargs):
        assert table == folders.FOLDERS_TABLE
        data = self.rows.get(row_id)
        return SimpleNamespace(id=row_id, data=dict(data)) if data else None

    async def query(self, table: str, **kwargs):
        assert table == folders.FOLDERS_TABLE
        assert kwargs["where"] == {"organization_id": "customer-a"}
        assert kwargs["scope"] == "customer-a"
        self.queries.append(dict(kwargs))
        offset = kwargs.get("offset", 0)
        limit = kwargs["limit"]
        rows = [
            SimpleNamespace(id=row_id, data=dict(data))
            for row_id, data in sorted(self.rows.items())
            if data.get("organization_id") == "customer-a"
        ]
        return SimpleNamespace(documents=rows[offset : offset + limit])

    async def update(self, table: str, row_id: str, data: dict, **kwargs):
        assert table == folders.FOLDERS_TABLE
        if row_id == self.fail_on_update:
            raise RuntimeError("table write failed")
        self.rows[row_id].update(data)
        self.updates.append((table, row_id, dict(data), dict(kwargs)))
        return SimpleNamespace(id=row_id, data=dict(self.rows[row_id]))

    async def insert(self, table: str, data: dict, **kwargs):
        self.inserts.append((table, dict(data), dict(kwargs)))


def _set_context(monkeypatch, *, org_id: str, provider: bool = False, platform: bool = False) -> None:
    monkeypatch.setattr(
        folders,
        "context",
        SimpleNamespace(
            org_id=org_id,
            user_id="user-1",
            is_platform_admin=platform,
            organization=SimpleNamespace(is_provider=provider),
        ),
    )


def _rows() -> dict[str, dict]:
    return {
        "root": {"organization_id": "customer-a", "source_system": "bifrost", "parent_id": None, "ancestor_ids": [], "restricted": False},
        "old-parent": {"organization_id": "customer-a", "source_system": "bifrost", "parent_id": None, "ancestor_ids": [], "restricted": False},
        "branch": {"organization_id": "customer-a", "source_system": "bifrost", "parent_id": "old-parent", "ancestor_ids": ["old-parent"], "restricted": False},
        "leaf": {"organization_id": "customer-a", "source_system": "bifrost", "parent_id": "branch", "ancestor_ids": ["old-parent", "branch"], "restricted": True},
    }


def test_move_recomputes_the_native_subtree_without_changing_restrictions(monkeypatch) -> None:
    tables = _Tables(_rows())
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(folders, "tables", tables)

    result = asyncio.run(folders.docs_move_document_folder("branch", "root"))

    assert result == {
        "folder_id": "branch",
        "organization_id": "customer-a",
        "parent_id": "root",
        "updated_count": 2,
    }
    assert tables.rows["branch"]["parent_id"] == "root"
    assert tables.rows["branch"]["ancestor_ids"] == ["root"]
    assert tables.rows["leaf"]["ancestor_ids"] == ["root", "branch"]
    assert tables.rows["leaf"]["restricted"] is True
    assert [(row_id, data) for _, row_id, data, _ in tables.updates] == [
        ("branch", {"parent_id": "root", "ancestor_ids": ["root"]}),
        ("leaf", {"ancestor_ids": ["root", "branch"]}),
    ]
    audit = tables.inserts[0][1]
    assert audit["event_type"] == "document_folder.moved"
    assert audit["metadata"] == {"parent_id": "root", "updated_count": 2}


def test_move_enumerates_every_visible_folder_page_before_recomputing_descendants(monkeypatch) -> None:
    tables = _Tables(_rows())
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(folders, "tables", tables)
    monkeypatch.setattr(folders, "_PAGE_SIZE", 2)

    asyncio.run(folders.docs_move_document_folder("branch", "root"))

    assert [query["offset"] for query in tables.queries] == [0, 2, 4]
    assert tables.rows["leaf"]["ancestor_ids"] == ["root", "branch"]


def test_move_preserves_source_owned_local_copies_and_rejects_cycle_destinations(monkeypatch) -> None:
    rows = _rows()
    rows["branch"]["source_system"] = "itglue"
    rows["leaf"]["source_system"] = "itglue"
    tables = _Tables(rows)
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(folders, "tables", tables)

    asyncio.run(folders.docs_move_document_folder("branch", "root"))
    with pytest.raises(folders.UserError, match="descendant"):
        asyncio.run(folders.docs_move_document_folder("branch", "leaf"))

    assert tables.rows["branch"]["source_system"] == "itglue"
    assert tables.rows["leaf"]["source_system"] == "itglue"
    assert all("source_system" not in data and "restricted" not in data for _, _, data, _ in tables.updates)


def test_move_rejects_a_parent_outside_the_folder_organization(monkeypatch) -> None:
    rows = _rows()
    rows["other-parent"] = {"organization_id": "customer-b", "source_system": "bifrost", "parent_id": None, "ancestor_ids": [], "restricted": False}
    tables = _Tables(rows)
    _set_context(monkeypatch, org_id="provider", provider=True)
    monkeypatch.setattr(folders, "tables", tables)

    with pytest.raises(folders.UserError, match="another organization"):
        asyncio.run(folders.docs_move_document_folder("branch", "other-parent"))

    assert tables.updates == []


def test_customer_cannot_move_a_folder_from_another_organization(monkeypatch) -> None:
    rows = _rows()
    rows["branch"]["organization_id"] = "customer-b"
    tables = _Tables(rows)
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(folders, "tables", tables)

    with pytest.raises(folders.UserError, match="own organization"):
        asyncio.run(folders.docs_move_document_folder("branch", None))

    assert tables.updates == []


def test_move_workflow_is_limited_to_docs_editors_and_administrators() -> None:
    manifest_path = Path(__file__).parents[1] / ".bifrost" / "workflows.yaml"
    workflows = yaml.safe_load(manifest_path.read_text())["workflows"]
    workflow = workflows["34d3d63b-1bca-4698-8fcc-eb9b70b9d9ea"]

    assert workflow["path"] == "functions/folders.py"
    assert workflow["function_name"] == "docs_move_document_folder"
    assert workflow["role_names"] == ["Bifrost Docs Editor", "Bifrost Docs Administrator"]


def test_move_into_a_restricted_parent_fails_before_any_visibility_promotion(monkeypatch) -> None:
    rows = _rows()
    rows["root"]["restricted"] = True
    tables = _Tables(rows)
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(folders, "tables", tables)

    with pytest.raises(folders.UserError, match="restriction promotion"):
        asyncio.run(folders.docs_move_document_folder("branch", "root"))

    assert tables.updates == []


def test_move_rolls_back_prior_subtree_writes_when_a_later_write_fails(monkeypatch) -> None:
    tables = _Tables(_rows())
    tables.fail_on_update = "leaf"
    _set_context(monkeypatch, org_id="customer-a")
    monkeypatch.setattr(folders, "tables", tables)

    with pytest.raises(folders.UserError, match="rolled back"):
        asyncio.run(folders.docs_move_document_folder("branch", "root"))

    assert tables.rows["branch"]["parent_id"] == "old-parent"
    assert tables.rows["branch"]["ancestor_ids"] == ["old-parent"]
    assert tables.rows["leaf"]["ancestor_ids"] == ["old-parent", "branch"]
    assert [(row_id, data) for _, row_id, data, _ in tables.updates] == [
        ("branch", {"parent_id": "root", "ancestor_ids": ["root"]}),
        ("branch", {"parent_id": "old-parent", "ancestor_ids": ["old-parent"]}),
    ]
    assert tables.inserts[0][1]["event_type"] == "document_folder.move_reverted"
