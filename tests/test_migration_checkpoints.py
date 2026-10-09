import pytest

from functions import migration


@pytest.mark.asyncio
async def test_cancel_between_records_preserves_page_for_replay(monkeypatch):
    current = {"lease_id": "worker-a", "cancel_requested": True, "cursors": {"org:documents": 4}}
    writes = []

    async def get_run(_):
        return None, current

    async def update_run(_, changes):
        writes.append(changes)
        current.update(changes)

    monkeypatch.setattr(migration, "_get_run", get_run)
    monkeypatch.setattr(migration, "_update_run", update_run)
    result = await migration._record_checkpoint("run", "worker-a", {"succeeded": 17})
    assert result["status"] == "cancelled"
    assert current["counts"] == {"succeeded": 17}
    assert current["cursors"] == {"org:documents": 4}
    assert "cursors" not in writes[0]


@pytest.mark.asyncio
async def test_old_worker_cannot_cancel_or_write_new_worker_state(monkeypatch):
    async def get_run(_):
        return None, {"lease_id": "worker-b", "cancel_requested": True}

    async def unexpected_write(*args):
        pytest.fail("A superseded worker must not modify the new lease")

    monkeypatch.setattr(migration, "_get_run", get_run)
    monkeypatch.setattr(migration, "_update_run", unexpected_write)
    assert await migration._record_checkpoint("run", "worker-a", {"succeeded": 17}) == {"run_id": "run", "status": "superseded"}
