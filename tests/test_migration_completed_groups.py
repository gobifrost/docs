from types import SimpleNamespace

import pytest

from functions import migration
from modules.migration_core import migration_cursor_key


@pytest.mark.asyncio
@pytest.mark.parametrize("resource", ["documents", "flexible_assets"])
@pytest.mark.parametrize(
    "checkpoint,incomplete,should_replay",
    [
        ({"mapped_checked": 4, "source_missing": 0, "deleted": 0}, False, False),
        ({"mapped_checked": 0, "source_missing": 0, "deleted": 0, "deletion_deferred": 2}, False, False),
        (None, False, True),
        ({}, False, True),
        ({"deleted": 0}, False, True),
        ({"mapped_checked": -1, "source_missing": 0, "deleted": 0}, False, True),
        ({"mapped_checked": True, "source_missing": 0, "deleted": 0}, False, True),
        ({"mapped_checked": 4, "source_missing": 0, "deleted": 0}, True, True),
    ],
)
async def test_resume_only_replays_unfinished_resource_groups(
    monkeypatch, resource, checkpoint, incomplete, should_replay
):
    key = migration_cursor_key("source", "target", resource)
    run = {
        "status": "interrupted", "resource_types": [resource], "mode": "bulk",
        "cursors": {key: 3}, "counts": {},
        "reconciliation_counts": {} if checkpoint is None else {key: checkpoint},
        "incomplete_enumerations": [{"source_organization_id": "source", "resource_type": resource}]
        if incomplete else [],
    }
    requested = []
    reconciled = []
    integrations_checked = []

    async def get_run(run_id):
        return SimpleNamespace(data=run), run

    async def update_run(run_id, changes):
        run.update(changes)

    async def mappings(current):
        return [("source", "target")]

    async def integration(name, scope):
        integrations_checked.append(scope)
        return SimpleNamespace(entity_id="source", config={"api_key": "fixture"})

    async def no_op(*args, **kwargs):
        pass

    async def true(*args):
        return True

    async def false(*args):
        return False

    async def counts(*args):
        return {"failed": 0}

    async def types(*args):
        return ["type-1"]

    async def reconcile(*args):
        reconciled.append(args[4].name)
        return {"mapped_checked": 4, "source_missing": 0, "deleted": 0}

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def iter_pages(self, endpoint, *, params, start_page):
            requested.append((endpoint, start_page))
            if False:
                yield None

    for name, value in {
        "_get_run": get_run, "_update_run": update_run,
        "_resolve_organization_mappings": mappings, "_write_audit": no_op,
        "_cancel_requested": false, "_lease_owned": true, "_item_counts": counts,
        "_flexible_asset_type_source_ids": types, "_reconcile_resource": reconcile,
        "ITGlueClient": Client,
    }.items():
        monkeypatch.setattr(migration, name, value)
    monkeypatch.setattr(migration.integrations, "get", integration)
    monkeypatch.setattr(migration.context, "is_platform_admin", True, raising=False)

    await migration.docs_migration_run("run")

    assert integrations_checked == ["target"]
    assert bool(requested) is should_replay
    assert reconciled == ([resource] if should_replay else [])
    if not should_replay:
        assert run["reconciliation_counts"][key] == checkpoint
        assert run["cursors"] == {key: 3}
