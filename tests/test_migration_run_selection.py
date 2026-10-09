from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from functions import migration


def row(run_id, **data):
    return SimpleNamespace(id=run_id, data=data)


@pytest.fixture
def status_store(monkeypatch):
    monkeypatch.setattr(migration, "_require_migration_operator", lambda: None)
    monkeypatch.setattr(migration, "_reconcile_worker_status", AsyncMock(side_effect=lambda _, run: run))
    monkeypatch.setattr(migration.tables, "count", AsyncMock(return_value=0))

    def install(rows):
        async def query(table, **kwargs):
            return SimpleNamespace(documents=rows if table == migration.RUNS_TABLE else [])

        monkeypatch.setattr(migration.tables, "query", query)
        return rows

    return install


@pytest.mark.asyncio
@pytest.mark.parametrize("recovery_status", ["queued", "waiting", "running", "cancelling"])
async def test_default_selects_active_recovery_instead_of_newer_completed_verification(status_store, recovery_status):
    status_store([
        row("verification", status="completed", mode="bulk", bifrost_organization_ids=["northern-star"]),
        row("bulk", status="completed_with_errors", mode="bulk", recovery={"status": recovery_status}),
    ])
    result = await migration.docs_migration_status()
    assert result["run"]["id"] == "bulk"
    assert [run["id"] for run in result["runs"]] == ["verification", "bulk"]


@pytest.mark.asyncio
async def test_default_prefers_newest_active_work_and_then_newest_terminal_run(status_store):
    rows = status_store([
        row("newest", status="completed"),
        row("active", status="running"),
        row("older", status="completed_with_errors", recovery={"status": "running"}),
    ])
    assert (await migration.docs_migration_status())["run"]["id"] == "active"
    rows[1].data["status"] = "completed"
    rows[2].data["recovery"]["status"] = "completed_with_errors"
    assert (await migration.docs_migration_status())["run"]["id"] == "newest"


@pytest.mark.asyncio
async def test_explicit_selection_is_preserved_and_picker_excludes_operational_payloads(status_store, monkeypatch):
    selected = row("selected", status="completed", mode="proof", started_at="2026-10-02T12:00:00Z",
                   bifrost_organization_ids=["northern-star"], resource_types=["documents"],
                   recovery={"status": "completed", "secret_key": "must-not-be-in-picker", "groups": []},
                   mapping_queue=[{"source": "private"}], last_error="private-source-detail")
    status_store([row("active", status="running"), selected])
    monkeypatch.setattr(migration, "_get_run", AsyncMock(return_value=(selected, selected.data)))
    result = await migration.docs_migration_status("selected")
    assert result["run"]["id"] == "selected"
    assert result["runs"][1] == {
        "id": "selected", "status": "completed", "mode": "proof", "started_at": "2026-10-02T12:00:00Z",
        "organization_count": 1, "resource_count": 1, "recovery_status": "completed",
    }


@pytest.mark.asyncio
async def test_no_runs_returns_empty_picker(status_store):
    status_store([])
    result = await migration.docs_migration_status()
    assert result["run"] is None
    assert result["runs"] == []
