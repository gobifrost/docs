from __future__ import annotations

from types import SimpleNamespace

import pytest

from functions import migration
from modules.migration_core import migration_cursor_key


def _failed_item(organization_id: str | None, resource_type: str | None) -> SimpleNamespace:
    data = {}
    if organization_id is not None:
        data["organization_id"] = organization_id
    if resource_type is not None:
        data["resource_type"] = resource_type
    return SimpleNamespace(data=data)


def test_retry_cursor_reset_keeps_unaffected_completed_scopes() -> None:
    cursors = {
        migration_cursor_key("source-a", "target-a", "documents"): 8,
        migration_cursor_key("source-b", "target-a", "documents"): 4,
        migration_cursor_key("source-a", "target-a", "passwords"): 3,
        migration_cursor_key("source-a", "target-b", "documents"): 6,
        migration_cursor_key("source-a", "target-a", "configuration_types"): 2,
    }

    reset = migration._retry_cursors_after_failures(
        cursors, [_failed_item("target-a", "documents")]
    )

    assert reset == {
        migration_cursor_key("source-a", "target-a", "passwords"): 3,
        migration_cursor_key("source-a", "target-b", "documents"): 6,
        migration_cursor_key("source-a", "target-a", "configuration_types"): 2,
    }


def test_retry_cursor_reset_clears_all_flexible_asset_type_and_done_markers() -> None:
    cursors = {
        migration_cursor_key("source-a", "target-a", "flexible_assets:type-1"): 8,
        migration_cursor_key("source-b", "target-a", "flexible_assets:type-2"): 4,
        migration_cursor_key("source-a", "target-a", "flexible_assets:done"): 1,
        migration_cursor_key("source-a", "target-a", "flexible_assets"): 2,
        migration_cursor_key("source-a", "target-b", "flexible_assets:type-1"): 6,
        migration_cursor_key("source-a", "target-a", "documents"): 3,
    }

    reset = migration._retry_cursors_after_failures(
        cursors, [_failed_item("target-a", "flexible_assets")]
    )

    assert reset == {
        migration_cursor_key("source-a", "target-b", "flexible_assets:type-1"): 6,
        migration_cursor_key("source-a", "target-a", "documents"): 3,
    }


@pytest.mark.parametrize(
    "failures",
    [
        [],
        [_failed_item(None, "documents")],
        [_failed_item("target-a", None)],
        [_failed_item("target-a", "legacy_documents")],
    ],
)
def test_retry_cursor_reset_falls_back_to_all_cursors_for_unknown_legacy_scope(
    failures: list[SimpleNamespace],
) -> None:
    cursors = {
        migration_cursor_key("source-a", "target-a", "documents"): 8,
        migration_cursor_key("source-b", "target-b", "passwords"): 4,
    }

    assert migration._retry_cursors_after_failures(cursors, failures) == {}


@pytest.mark.asyncio
async def test_retry_failures_updates_only_failed_scope_cursors(monkeypatch) -> None:
    cursors = {
        migration_cursor_key("source-a", "target-a", "documents"): 8,
        migration_cursor_key("source-a", "target-a", "passwords"): 3,
        migration_cursor_key("source-a", "target-b", "documents"): 6,
    }
    reconciliation = {key: {"mapped_checked": 1, "source_missing": 0, "deleted": 0} for key in cursors}
    run = {"status": "completed_with_errors", "cursors": cursors, "reconciliation_counts": reconciliation}
    failed = SimpleNamespace(
        id="failed-item", data={"organization_id": "target-a", "resource_type": "documents"}
    )
    queries = 0
    item_updates: list[tuple[str, dict]] = []
    run_updates: list[dict] = []

    async def get_run(run_id: str):
        assert run_id == "run-a"
        return SimpleNamespace(id=run_id, data=run), run

    async def query(table: str, *, where: dict, limit: int, offset: int | None = None):
        assert table == migration.ITEMS_TABLE
        assert limit == 1000
        if where == {"run_id": "run-a", "status": "pending"}:
            assert offset == 0
            return SimpleNamespace(documents=[])
        assert (where, offset) == ({"run_id": "run-a", "status": "failed"}, None)
        nonlocal queries
        queries += 1
        return SimpleNamespace(documents=[failed] if queries == 1 else [])

    async def update(table: str, row_id: str, changes: dict):
        assert table == migration.ITEMS_TABLE
        item_updates.append((row_id, changes))

    async def update_run(run_id: str, changes: dict):
        assert run_id == "run-a"
        run_updates.append(changes)
        run.update(changes)

    async def execute(ref: str, *, input_data: dict):
        assert input_data == {"run_id": "run-a"}
        return "execution-a"

    monkeypatch.setattr(migration, "_get_run", get_run)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "update", update)
    monkeypatch.setattr(migration, "_update_run", update_run)
    monkeypatch.setattr(migration.workflows, "execute", execute)
    monkeypatch.setattr(migration.context, "is_platform_admin", True, raising=False)

    result = await migration.docs_migration_retry_failures("run-a")

    assert result == {"run_id": "run-a", "reset_failures": 1, "execution_id": "execution-a"}
    assert item_updates == [("failed-item", {
        "status": "pending", "error_code": None, "error_message": None, "completed_at": None,
    })]
    assert run_updates[0]["cursors"] == {
        migration_cursor_key("source-a", "target-a", "passwords"): 3,
        migration_cursor_key("source-a", "target-b", "documents"): 6,
    }
    assert run_updates[0]["reconciliation_counts"] == {
        key: reconciliation[key] for key in run_updates[0]["cursors"]
    }


@pytest.mark.asyncio
async def test_same_run_replay_does_not_reprocess_previously_skipped_child_sync_item(monkeypatch) -> None:
    spec = next(item for item in migration.RESOURCE_SPECS if item.name == "configurations")
    source = {"id": "config-1", "attributes": {"updated-at": "2026-10-02T00:00:00Z"}}
    item_id = migration.migration_item_id("run-a", "target-a", spec.name, "config-1")
    reads: list[tuple[str, str]] = []

    async def get(table: str, row_id: str):
        reads.append((table, row_id))
        assert (table, row_id) == (migration.ITEMS_TABLE, item_id)
        return SimpleNamespace(data={"status": "skipped", "disposition": "unchanged_children_synced"})

    monkeypatch.setattr(migration.tables, "get", get)

    result = await migration._process_resource(
        SimpleNamespace(), "run-a", "source-a", "target-a", spec, source, "bulk"
    )

    assert result == "skipped"
    assert reads == [(migration.ITEMS_TABLE, item_id)]


@pytest.mark.asyncio
@pytest.mark.parametrize("prior_status", ["failed", "pending", None])
async def test_nonterminal_or_new_run_item_continues_processing(monkeypatch, prior_status: str | None) -> None:
    spec = next(item for item in migration.RESOURCE_SPECS if item.name == "documents")
    source = {"id": "doc-1", "attributes": {"updated-at": "2026-10-02T00:00:00Z"}}
    item_id = migration.migration_item_id("run-a", "target-a", spec.name, "doc-1")
    map_read = False

    async def get(table: str, row_id: str):
        nonlocal map_read
        if (table, row_id) == (migration.ITEMS_TABLE, item_id):
            return SimpleNamespace(data={} if prior_status is None else {"status": prior_status})
        if table == migration.MAP_TABLE:
            map_read = True
            raise RuntimeError("stop after proving replay continues")
        raise AssertionError(f"unexpected read {table}/{row_id}")

    async def update(table: str, row_id: str, data: dict):
        assert (table, row_id) == (migration.ITEMS_TABLE, item_id)

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "update", update)

    with pytest.raises(RuntimeError, match="proving replay continues"):
        await migration._process_resource(
            SimpleNamespace(), "run-a", "source-a", "target-a", spec, source, "bulk"
        )

    assert map_read is True


@pytest.mark.asyncio
async def test_retry_after_interruption_resets_prior_pending_and_remaining_failed_scopes(monkeypatch) -> None:
    cursors = {
        migration_cursor_key("source-a", "target-a", "documents"): 8,
        migration_cursor_key("source-b", "target-b", "passwords"): 5,
        migration_cursor_key("source-c", "target-c", "documents"): 6,
    }
    run = {"status": "completed_with_errors", "cursors": cursors}
    pending = SimpleNamespace(
        id="pending-a", data={"organization_id": "target-a", "resource_type": "documents"}
    )
    failed = SimpleNamespace(
        id="failed-b", data={"organization_id": "target-b", "resource_type": "passwords"}
    )
    calls: list[tuple[str, int | None]] = []
    run_updates: list[dict] = []
    failed_queries = 0

    async def get_run(run_id: str):
        return SimpleNamespace(id=run_id, data=run), run

    async def query(table: str, *, where: dict, limit: int, offset: int | None = None):
        assert table == migration.ITEMS_TABLE
        assert limit == 1000
        calls.append((str(where["status"]), offset))
        if where == {"run_id": "run-a", "status": "pending"}:
            assert offset == 0
            return SimpleNamespace(documents=[pending])
        assert where == {"run_id": "run-a", "status": "failed"}
        assert offset is None
        nonlocal failed_queries
        failed_queries += 1
        return SimpleNamespace(documents=[failed] if failed_queries == 1 else [])

    async def update(table: str, row_id: str, changes: dict):
        assert (table, row_id) == (migration.ITEMS_TABLE, "failed-b")
        assert changes["status"] == "pending"

    async def update_run(run_id: str, changes: dict):
        run_updates.append(changes)
        run.update(changes)

    async def execute(ref: str, *, input_data: dict):
        return "execution-a"

    monkeypatch.setattr(migration, "_get_run", get_run)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration.tables, "update", update)
    monkeypatch.setattr(migration, "_update_run", update_run)
    monkeypatch.setattr(migration.workflows, "execute", execute)
    monkeypatch.setattr(migration.context, "is_platform_admin", True, raising=False)

    await migration.docs_migration_retry_failures("run-a")

    assert calls == [("pending", 0), ("failed", None), ("failed", None)]
    assert run_updates[0]["cursors"] == {
        migration_cursor_key("source-c", "target-c", "documents"): 6,
    }


@pytest.mark.asyncio
async def test_retry_pending_scope_collection_paginates_beyond_one_thousand_rows(monkeypatch) -> None:
    cursors = {
        migration_cursor_key("source-a", "target-a", "documents"): 8,
        migration_cursor_key("source-b", "target-b", "passwords"): 5,
        migration_cursor_key("source-c", "target-c", "documents"): 6,
    }
    run = {"status": "completed_with_errors", "cursors": cursors}
    pending_a = [
        SimpleNamespace(id=f"pending-a-{index}", data={"organization_id": "target-a", "resource_type": "documents"})
        for index in range(1000)
    ]
    pending_b = SimpleNamespace(
        id="pending-b", data={"organization_id": "target-b", "resource_type": "passwords"}
    )
    pending_offsets: list[int] = []
    run_updates: list[dict] = []

    async def get_run(run_id: str):
        return SimpleNamespace(id=run_id, data=run), run

    async def query(table: str, *, where: dict, limit: int, offset: int | None = None):
        assert table == migration.ITEMS_TABLE
        assert limit == 1000
        if where == {"run_id": "run-a", "status": "pending"}:
            assert offset is not None
            pending_offsets.append(offset)
            return SimpleNamespace(documents=pending_a if offset == 0 else [pending_b])
        assert where == {"run_id": "run-a", "status": "failed"}
        assert offset is None
        return SimpleNamespace(documents=[])

    async def update_run(run_id: str, changes: dict):
        run_updates.append(changes)
        run.update(changes)

    async def execute(ref: str, *, input_data: dict):
        return "execution-a"

    monkeypatch.setattr(migration, "_get_run", get_run)
    monkeypatch.setattr(migration.tables, "query", query)
    monkeypatch.setattr(migration, "_update_run", update_run)
    monkeypatch.setattr(migration.workflows, "execute", execute)
    monkeypatch.setattr(migration.context, "is_platform_admin", True, raising=False)

    result = await migration.docs_migration_retry_failures("run-a")

    assert result["reset_failures"] == 0
    assert pending_offsets == [0, 1000]
    assert run_updates[0]["cursors"] == {
        migration_cursor_key("source-c", "target-c", "documents"): 6,
    }
