from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from functions import migration


@pytest.mark.asyncio
@pytest.mark.parametrize('worker_status,cancel_requested,expected', [
    ('Failed', False, 'interrupted'), ('Cancelled', True, 'cancelled'),
    ('Success', False, 'interrupted'), ('Running', False, 'running'),
])
async def test_status_exposes_resume_after_worker_loss_without_dispatching_duplicate(monkeypatch, worker_status, cancel_requested, expected):
    run = {'status': 'running', 'execution_id': 'worker-a', 'cancel_requested': cancel_requested, 'cursors': {'org:documents': 4}}
    monkeypatch.setattr(migration, '_require_migration_operator', lambda: None)
    monkeypatch.setattr(migration, '_get_run', AsyncMock(return_value=(SimpleNamespace(id='run'), run)))
    monkeypatch.setattr(migration.workflows, 'get', AsyncMock(return_value=SimpleNamespace(status=SimpleNamespace(value=worker_status))))
    monkeypatch.setattr(migration.tables, 'count', AsyncMock(return_value=0))
    monkeypatch.setattr(migration.tables, 'query', AsyncMock(return_value=SimpleNamespace(documents=[])))
    write = AsyncMock()
    dispatch = AsyncMock()
    monkeypatch.setattr(migration, '_update_run', write)
    monkeypatch.setattr(migration.workflows, 'execute', dispatch)
    result = await migration.docs_migration_status('run')
    assert result['run']['status'] == expected
    assert result['run']['cursors'] == {'org:documents': 4}
    if expected != 'running':
        assert write.call_args.args[1]['status'] == expected
        assert 'stopped' in result['run']['last_error'].lower()
    else:
        write.assert_not_called()
    dispatch.assert_not_called()


@pytest.mark.asyncio
async def test_status_of_old_failed_worker_cannot_overwrite_concurrent_resume(monkeypatch):
    old = {'status': 'running', 'execution_id': 'worker-old'}
    newer = {'status': 'queued', 'execution_id': 'worker-new'}
    monkeypatch.setattr(migration, '_require_migration_operator', lambda: None)
    monkeypatch.setattr(migration, '_get_run', AsyncMock(side_effect=[(SimpleNamespace(id='run'), old), (SimpleNamespace(id='run'), newer)]))
    monkeypatch.setattr(migration.workflows, 'get', AsyncMock(return_value=SimpleNamespace(status='Failed')))
    monkeypatch.setattr(migration.tables, 'count', AsyncMock(return_value=0))
    monkeypatch.setattr(migration.tables, 'query', AsyncMock(return_value=SimpleNamespace(documents=[])))
    write = AsyncMock()
    monkeypatch.setattr(migration, '_update_run', write)
    result = await migration.docs_migration_status('run')
    assert result['run']['execution_id'] == 'worker-new'
    assert result['run']['status'] == 'queued'
    write.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize('action_name', ['docs_migration_resume', 'docs_migration_retry_failures'])
async def test_queue_transition_does_not_reconcile_the_previous_worker_as_the_new_dispatch(monkeypatch, action_name):
    run = {'status': 'interrupted', 'execution_id': 'stopped-worker', 'cursors': {'saved': 12}}
    monkeypatch.setattr(migration, '_require_migration_operator', lambda: None)
    monkeypatch.setattr(migration, '_get_run', AsyncMock(side_effect=lambda _: (SimpleNamespace(id='run'), dict(run))))
    monkeypatch.setattr(migration.tables, 'query', AsyncMock(return_value=SimpleNamespace(documents=[])))
    old_worker = AsyncMock(return_value=SimpleNamespace(status='Failed'))
    monkeypatch.setattr(migration.workflows, 'get', old_worker)

    async def update(_run_id, changes):
        run.update(changes)
        return dict(run)

    monkeypatch.setattr(migration, '_update_run', update)

    async def dispatch(*_args, **_kwargs):
        # The status page can refresh while the queue request is in flight.
        observed = await migration._reconcile_worker_status('run', dict(run))
        assert observed['status'] == 'queued'
        assert observed.get('execution_id') is None
        old_worker.assert_not_called()
        return 'new-worker'

    monkeypatch.setattr(migration.workflows, 'execute', dispatch)
    result = await getattr(migration, action_name)('run')
    assert result['execution_id'] == 'new-worker'
    assert run['execution_id'] == 'new-worker'
    assert run['status'] == 'queued'
    if action_name == 'docs_migration_resume':
        assert run['cursors'] == {'saved': 12}


@pytest.mark.asyncio
@pytest.mark.parametrize('previous_owner', [None, 'stopped-worker'])
async def test_worker_claims_its_runtime_execution_before_recording_progress(monkeypatch, previous_owner):
    """A fast worker must retain ownership while its parent saves dispatch metadata."""
    run = {'status': 'queued', 'execution_id': previous_owner, 'cursors': {'saved': 12}}
    monkeypatch.setattr(migration, '_require_migration_operator', lambda: None)
    monkeypatch.setattr(migration, '_get_run', AsyncMock(return_value=(SimpleNamespace(id='run'), run)))
    monkeypatch.setattr(migration.context, 'execution_id', 'current-worker', raising=False)

    class Claimed(RuntimeError):
        pass

    async def first_progress(_run_id, changes):
        assert changes.get('execution_id') == 'current-worker'
        assert changes['status'] == 'running'
        raise Claimed

    monkeypatch.setattr(migration, '_update_run', first_progress)
    with pytest.raises(Claimed):
        await migration.docs_migration_run('run')
