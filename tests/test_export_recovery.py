import io
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from functions import export_recovery as recovery


def test_export_scope_excludes_passwords_and_unselected_asset_types():
    group = {"source_org": "1774800", "kind": "flexible_assets", "type_id": "49770"}
    attrs = recovery.export_request(group, "synthetic-password")["data"]["attributes"]
    assert attrs["organization-id"] == 1774800
    assert attrs["include-passwords"] is False
    assert attrs["include-logs"] is False
    assert attrs["all-flexible-assets"] is False
    assert attrs["core-assets-types"] == []
    assert attrs["flexible-assets-types"] == ["49770"]


def test_one_organization_export_combines_only_selected_failed_resource_types():
    group = {"source_org": "1774800", "kind": "documents", "kinds": ["documents", "flexible_assets"], "type_ids": ["49770", "383489"]}
    attrs = recovery.export_request(group, "synthetic")["data"]["attributes"]
    assert attrs["core-assets-types"] == ["documents"]
    assert attrs["flexible-assets-types"] == ["49770", "383489"]
    assert attrs["all-flexible-assets"] is False and attrs["include-passwords"] is False


def test_archive_reconciliation_never_opens_unknown_or_password_members():
    body = io.BytesIO()
    with zipfile.ZipFile(body, "w") as z:
        z.writestr("attachments/flexible-assets/42/file.bin", b"okay")
        z.writestr("attachments/flexible_assets/99/file.bin", b"okay")
        z.writestr("passwords/42/file.bin", b"okay")
        z.writestr("../attachments/flexible_assets/42/file.bin", b"okay")
    record = {"kind": "flexible_assets", "parent_source_id": "42", "name": "file.bin", "size": 4, "file_kind": "attachment"}
    with zipfile.ZipFile(body) as z:
        assert recovery.match_member(z.infolist(), record, "1774800").filename == "attachments/flexible-assets/42/file.bin"
        assert recovery.match_member(z.infolist(), {**record, "size": 5}, "1774800") is None
        assert recovery.match_member(z.infolist() * 2, record, "1774800") is None


@pytest.mark.asyncio
async def test_start_refuses_live_migration_before_dispatch(monkeypatch):
    monkeypatch.setattr(recovery, "_require_migration_operator", lambda: None)
    monkeypatch.setattr(recovery, "_get_run", AsyncMock(return_value=(None, {"status": "running"})))
    dispatch = AsyncMock()
    monkeypatch.setattr(recovery.workflows, "execute", dispatch)
    with pytest.raises(Exception, match="migration"):
        await recovery.docs_export_recovery_start("run-a")
    dispatch.assert_not_called()


@pytest.mark.asyncio
async def test_status_excludes_internal_plans_password_reference_and_download_urls(monkeypatch):
    monkeypatch.setattr(recovery, "_require_migration_operator", lambda: None)
    monkeypatch.setattr(recovery, "_get_run", AsyncMock(return_value=(None, {"recovery": {
        "status": "waiting", "total_files": 6, "secret_key": "private-ref",
        "groups": [{"url": "https://storage.test/?secret=value"}], "generation": "private-lease",
    }})))
    result = await recovery.docs_export_recovery_status("run-a")
    assert result["status"] == "waiting"
    assert result["total_files"] == 6
    assert "secret" not in repr(result) and "storage.test" not in repr(result)
    assert "groups" not in result and "generation" not in result


@pytest.mark.asyncio
async def test_cancel_cooperatively_preserves_export_and_file_checkpoint(monkeypatch):
    monkeypatch.setattr(recovery, "_require_migration_operator", lambda: None)
    state = {"status": "running", "file_index": 3, "export_id": "owned-export", "groups": []}
    monkeypatch.setattr(recovery, "_get_run", AsyncMock(return_value=(None, {"recovery": state})))
    update = AsyncMock()
    monkeypatch.setattr(recovery, "_update_run", update)
    await recovery.docs_export_recovery_cancel("run-a")
    written = update.call_args.args[1]["recovery"]
    assert written["status"] == "cancelling" and written["cancel_requested"] is True
    assert written["file_index"] == 3 and written["export_id"] == "owned-export"


@pytest.mark.asyncio
async def test_superseded_worker_cannot_fetch_export_or_mutate_destination(monkeypatch):
    monkeypatch.setattr(recovery, "_require_migration_operator", lambda: None)
    monkeypatch.setattr(recovery, "_get_run", AsyncMock(return_value=(None, {"recovery": {"generation": "new-generation", "status": "running"}})))
    update = AsyncMock()
    monkeypatch.setattr(recovery, "_update_run", update)
    result = await recovery.docs_export_recovery_step("run-a", "old-generation")
    assert result["status"] == "superseded"
    update.assert_not_called()


@pytest.mark.asyncio
async def test_new_customer_cannot_read_or_start_global_recovery(monkeypatch):
    monkeypatch.setattr(recovery, "context", SimpleNamespace(is_platform_admin=False, organization=SimpleNamespace(is_provider=False)))
    monkeypatch.setattr(recovery, "_require_migration_operator", recovery.require_operator)
    with pytest.raises(Exception, match="provider|platform"):
        await recovery.docs_export_recovery_status("run-a")


@pytest.mark.asyncio
async def test_documented_pending_export_response_does_not_require_unreturned_request_fields(monkeypatch):
    from datetime import datetime, timezone
    state = {"status": "waiting", "phase": "exports", "generation": "g", "export_index": 0,
             "groups": [{"source_org": "1774800", "target_org": "org", "kind": "documents", "files": []}],
             "export_id": "owned", "export_passwords_excluded": True,
             "export_created_at": datetime.now(timezone.utc).isoformat()}
    monkeypatch.setattr(recovery, "_require_migration_operator", lambda: None)
    monkeypatch.setattr(recovery, "_owned_state", AsyncMock(return_value=state))
    monkeypatch.setattr(recovery, "_connection", AsyncMock(return_value=object()))
    monkeypatch.setattr(recovery, "_source_api", AsyncMock(return_value={"data": {"id": "owned", "attributes": {
        "organization-id": 1774800, "export-all": False, "encrypted-status": True, "download-url": None,
    }}}))
    dispatch = AsyncMock()
    monkeypatch.setattr(recovery, "_dispatch", dispatch)
    monkeypatch.setattr(recovery, "_save", AsyncMock())
    result = await recovery.docs_export_recovery_step("run", "g")
    assert result["status"] == "waiting"
    assert dispatch.call_args.kwargs == {"delay": 30}


@pytest.mark.asyncio
async def test_cleanup_checkpoint_resumes_without_reopening_completed_file(monkeypatch):
    state = {"status": "queued", "phase": "cleanup", "generation": "g", "export_index": 0,
             "file_index": 1, "groups": [{"source_org": "1774800", "target_org": "org", "files": [{}]}],
             "export_id": "owned", "secret_key": "key"}
    monkeypatch.setattr(recovery, "_require_migration_operator", lambda: None)
    monkeypatch.setattr(recovery, "_owned_state", AsyncMock(return_value=state))
    monkeypatch.setattr(recovery, "_connection", AsyncMock(return_value=object()))
    cleanup = AsyncMock()
    monkeypatch.setattr(recovery, "_cleanup_export", cleanup)
    monkeypatch.setattr(recovery, "_dispatch", AsyncMock())
    monkeypatch.setattr(recovery, "_save", AsyncMock())
    request = AsyncMock(side_effect=AssertionError("must not reopen finished archive"))
    monkeypatch.setattr(recovery, "_source_api", request)
    result = await recovery.docs_export_recovery_step("run", "g")
    cleanup.assert_awaited_once()
    request.assert_not_called()
    assert result["export_index"] == 1


@pytest.mark.asyncio
async def test_missing_attachment_size_cannot_authorize_export_member_recovery():
    record = {"kind": "documents", "parent_source_id": "42", "name": "file.bin", "size": None, "file_kind": "attachment"}
    member = zipfile.ZipInfo("attachments/documents/42/file.bin")
    member.file_size = 4
    assert recovery.match_member([member], record, "1774800") is None


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["docs_migration_resume", "docs_migration_retry_failures"])
async def test_main_migration_cannot_resume_or_retry_during_file_recovery(monkeypatch, action):
    from functions import migration
    monkeypatch.setattr(migration, "_require_migration_operator", lambda: None)
    monkeypatch.setattr(migration, "_get_run", AsyncMock(return_value=(None, {"status": "cancelled", "recovery": {"status": "running"}})))
    write = AsyncMock()
    monkeypatch.setattr(migration, "_update_run", write)
    with pytest.raises(Exception, match="recovery"):
        await getattr(migration, action)("run-a")
    write.assert_not_called()


@pytest.mark.asyncio
async def test_status_terminalizes_lost_cancelling_worker_without_starting_a_duplicate(monkeypatch):
    monkeypatch.setattr(recovery, "_require_migration_operator", lambda: None)
    monkeypatch.setattr(recovery, "_get_run", AsyncMock(return_value=(None, {"recovery": {
        "status": "cancelling", "cancel_requested": True, "execution_id": "lost", "export_id": "owned", "file_index": 2,
    }})))
    monkeypatch.setattr(recovery.workflows, "get", AsyncMock(return_value=SimpleNamespace(status="Failed")))
    write = AsyncMock()
    monkeypatch.setattr(recovery, "_update_run", write)
    result = await recovery.docs_export_recovery_status("run-a")
    assert result["status"] == "cancelled"
    assert write.call_args.args[1]["recovery"]["file_index"] == 2
    assert write.call_args.args[1]["recovery"]["export_id"] == "owned"


@pytest.mark.asyncio
async def test_discard_cleans_only_owned_export_and_secret_without_deleting_recovered_files(monkeypatch):
    monkeypatch.setattr(recovery, "_require_migration_operator", lambda: None)
    state = {"status": "cancelled", "export_id": "owned", "secret_key": "owned-secret",
             "groups": [{"source_org": "1774800", "target_org": "org"}], "export_index": 0}
    monkeypatch.setattr(recovery, "_get_run", AsyncMock(return_value=(None, {"status": "cancelled", "recovery": state})))
    monkeypatch.setattr(recovery, "_connection", AsyncMock(return_value=object()))
    api = AsyncMock()
    monkeypatch.setattr(recovery, "_source_api", api)
    secret_delete = AsyncMock()
    monkeypatch.setattr(recovery.config, "delete", secret_delete)
    monkeypatch.setattr(recovery, "_save", AsyncMock())
    file_delete = AsyncMock()
    monkeypatch.setattr(recovery.files, "delete", file_delete)
    result = await recovery.docs_export_recovery_discard("run-a")
    api.assert_awaited_once()
    assert api.call_args.args[-2:] == ("DELETE", "/exports/owned")
    secret_delete.assert_awaited_once_with("owned-secret", scope="global")
    file_delete.assert_not_called()
    assert result["status"] == "idle"


async def transfer_fixture(monkeypatch, *, mime="application/octet-stream", corrupt=False, cancelled=False):
    body = b"<html>legitimate exported document</html>" if mime == "text/html" else b"source bytes" * 100
    record = {"kind": "documents", "parent_source_id": "42", "parent_id": "parent", "source_id": "7",
              "name": "file.bin", "size": len(body), "file_kind": "attachment", "restricted": False,
              "raw": {"id": "7", "attributes": {"attachment-file-name": "file.bin", "attachment-file-size": len(body), "attachment-content-type": mime}}}
    member = zipfile.ZipInfo("attachments/documents/42/file.bin")
    member.file_size = len(body)
    member.flag_bits = 1
    verified = False
    uploaded = bytearray()
    async def handler(request):
        nonlocal verified
        if request.method == "PUT":
            uploaded.extend(await request.aread())
            return httpx.Response(200)
        verified = True
        return httpx.Response(200, content=b"wrong" if corrupt else bytes(uploaded))
    client_type = httpx.AsyncClient
    monkeypatch.setattr(recovery.httpx, "AsyncClient", lambda **kwargs: client_type(transport=httpx.MockTransport(handler), **kwargs))
    async def get(table, _id):
        if table == "docs-documents":
            return SimpleNamespace(data={"source_system": "itglue", "organization_id": "org", "source_id": "42", "restricted": False})
        return None
    monkeypatch.setattr(recovery.tables, "get", AsyncMock(side_effect=get))
    writes = AsyncMock()
    monkeypatch.setattr(recovery.tables, "upsert", writes)
    monkeypatch.setattr(recovery.files, "get_signed_url", AsyncMock(return_value={"url": "https://destination.test/file"}))
    complete = AsyncMock()
    monkeypatch.setattr(recovery, "complete_signed_upload", complete)
    async def owned(*args):
        return None if cancelled and verified else {"status": "running"}
    monkeypatch.setattr(recovery, "_owned_state", owned)
    return body, record, member, SimpleNamespace(open=lambda *args: io.BytesIO(body)), complete, writes


@pytest.mark.asyncio
async def test_recovered_bytes_are_verified_before_registration_and_keep_canonical_source_projection(monkeypatch):
    import hashlib
    body, record, member, archive, complete, writes = await transfer_fixture(monkeypatch)
    result = await recovery._transfer_member("run", "g", {"target_org": "org"}, record, archive, member, b"synthetic")
    assert result == (True, len(body))
    complete.assert_awaited_once()
    assert complete.call_args.kwargs["sha256"] == hashlib.sha256(body).hexdigest()
    metadata = writes.call_args.args[2]
    assert metadata["sha256"] == hashlib.sha256(body).hexdigest()
    assert metadata["metadata_registered"] is True and metadata["quarantined"] is False


@pytest.mark.asyncio
async def test_declared_html_file_is_not_misclassified_as_source_error_page(monkeypatch):
    body, record, member, archive, complete, _ = await transfer_fixture(monkeypatch, mime="text/html")
    assert await recovery._transfer_member("run", "g", {"target_org": "org"}, record, archive, member, b"synthetic") == (True, len(body))
    complete.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["corrupt", "cancelled"])
async def test_failed_destination_hash_or_supersession_cannot_register_attachment(monkeypatch, failure):
    _, record, member, archive, complete, writes = await transfer_fixture(monkeypatch, **{failure: True})
    with pytest.raises(Exception, match="hash|stopped"):
        await recovery._transfer_member("run", "g", {"target_org": "org"}, record, archive, member, b"synthetic")
    complete.assert_not_called()
    assert all(call.args[0] != recovery.ATTACHMENTS_TABLE for call in writes.call_args_list)


@pytest.mark.asyncio
async def test_lost_export_creation_response_is_reconciled_by_password_proof_not_scope_alone(monkeypatch):
    state = {"export_baseline_ids": ["old"], "secret_key": "owned-secret", "export_created_at": "2026-10-02T10:00:00+00:00"}
    def export(id):
        return {"id": id, "attributes": {"organization-id": 1774800, "export-all": False,
                                         "encrypted-status": True, "download-url": "https://storage.test/" + id}}
    monkeypatch.setattr(recovery, "_export_inventory", AsyncMock(return_value=[export("old"), export("foreign"), export("ours")]))
    monkeypatch.setattr(recovery.config, "get", AsyncMock(return_value="synthetic-password"))
    proof = AsyncMock(side_effect=lambda _connection, _group, url, password: url.endswith("ours") and password == b"synthetic-password")
    monkeypatch.setattr(recovery, "_prove_export_password", proof)
    api = AsyncMock(side_effect=AssertionError("must not create another export"))
    monkeypatch.setattr(recovery, "_source_api", api)
    result = await recovery._reconcile_created_export(object(), {"source_org": "1774800"}, state)
    assert result == "ours"
    assert proof.await_count == 2
    api.assert_not_called()


@pytest.mark.asyncio
async def test_worker_checkpoint_preserves_a_concurrent_cancel_request(monkeypatch):
    monkeypatch.setattr(recovery, "_get_run", AsyncMock(return_value=(None, {"recovery": {"generation": "g", "cancel_requested": True, "status": "cancelling"}})))
    write = AsyncMock()
    monkeypatch.setattr(recovery, "_update_run", write)
    await recovery._save("run", {"generation": "g", "cancel_requested": False, "status": "running"})
    stored = write.call_args.args[1]["recovery"]
    assert stored["cancel_requested"] is True and stored["status"] == "cancelling"


@pytest.mark.asyncio
@pytest.mark.parametrize("change_after_upload", [False, True])
async def test_parent_restriction_change_cannot_register_recovery_in_public_storage(monkeypatch, change_after_upload):
    _, record, member, archive, complete, writes = await transfer_fixture(monkeypatch)
    parent_reads = 0
    async def get(table, _id):
        nonlocal parent_reads
        if table == "docs-documents":
            parent_reads += 1
            return SimpleNamespace(data={"source_system": "itglue", "organization_id": "org", "source_id": "42",
                                         "restricted": not change_after_upload or parent_reads > 1})
        return None
    monkeypatch.setattr(recovery.tables, "get", AsyncMock(side_effect=get))
    with pytest.raises(Exception, match="parent|restriction"):
        await recovery._transfer_member("run", "g", {"target_org": "org"}, record, archive, member, b"synthetic")
    complete.assert_not_called()
    assert all(call.args[0] != recovery.ATTACHMENTS_TABLE for call in writes.call_args_list)


def test_flexible_attachment_folder_comes_from_verified_source_type_name():
    member = zipfile.ZipInfo('attachments/Synthetic-Network-Devices/42/file.bin')
    member.file_size = 4
    record = {'kind': 'flexible_assets', 'parent_source_id': '42', 'name': 'file.bin', 'size': 4,
              'file_kind': 'attachment', 'export_type_name': 'Synthetic Network Devices'}
    assert recovery.match_member([member], record, '1774800') is member
    assert recovery.match_member([member], {**record, 'export_type_name': 'Other type'}, '1774800') is None


def test_stale_size_fallback_still_requires_a_unique_parent_type_and_original_name():
    member = zipfile.ZipInfo('attachments/documents/42/file.bin')
    member.file_size = 4
    record = {'kind': 'documents', 'parent_source_id': '42', 'name': 'file.bin', 'size': 5, 'file_kind': 'attachment'}
    assert recovery.match_member([member], record, '1774800') is None
    assert recovery.match_member([member], record, '1774800', allow_size_mismatch=True) is member
    assert recovery.match_member([member, member], record, '1774800', allow_size_mismatch=True) is None
    assert recovery.match_member([member], {**record, 'parent_source_id': 'other'}, '1774800', allow_size_mismatch=True) is None
    assert recovery.match_member([member], {**record, 'size': None}, '1774800', allow_size_mismatch=True) is None


@pytest.mark.asyncio
@pytest.mark.parametrize('foreign', [False, True])
async def test_resume_enriches_only_the_selected_source_organization_and_asset_type(monkeypatch, foreign):
    request = AsyncMock(return_value={'data': {'id': '42', 'attributes': {
        'organization-id': 999 if foreign else 1774800, 'flexible-asset-type-id': 7,
        'flexible-asset-type-name': 'Synthetic Network Devices',
    }}})
    monkeypatch.setattr(recovery, '_source_api', request)
    group = {'source_org': '1774800', 'type_ids': ['7']}
    record = {'kind': 'flexible_assets', 'parent_source_id': '42'}
    if foreign:
        with pytest.raises(Exception, match='scope|organization'):
            await recovery._prepare_export_type_name(object(), group, record)
        assert 'export_type_name' not in record
    else:
        await recovery._prepare_export_type_name(object(), group, record)
        assert record['export_type_name'] == 'Synthetic Network Devices'


@pytest.mark.asyncio
async def test_export_type_enrichment_cannot_adopt_a_type_outside_the_owned_export(monkeypatch):
    monkeypatch.setattr(recovery, '_source_api', AsyncMock(return_value={'data': {'id': '42', 'attributes': {
        'organization-id': 1774800, 'flexible-asset-type-id': 9, 'flexible-asset-type-name': 'Wrong type',
    }}}))
    record = {'kind': 'flexible_assets', 'parent_source_id': '42'}
    with pytest.raises(Exception, match='scope|type'):
        await recovery._prepare_export_type_name(object(), {'source_org': '1774800', 'type_ids': ['7']}, record)
    assert 'export_type_name' not in record


@pytest.mark.asyncio
async def test_retained_export_recovers_unique_stale_size_file_with_verified_actual_size(monkeypatch):
    body, record, member, archive, complete, writes = await transfer_fixture(monkeypatch)
    record['size'] = len(body) + 1
    record['raw']['attributes']['attachment-file-size'] = len(body) + 1
    archive.infolist = lambda: [member]
    archive.close = lambda: None
    state = {'status': 'queued', 'phase': 'files', 'generation': 'g', 'export_index': 0, 'file_index': 0,
             'groups': [{'source_org': '1774800', 'target_org': 'org', 'files': [record]}],
             'export_id': 'owned', 'export_passwords_excluded': True, 'secret_key': 'owned-key',
             'recovered_files': 0, 'skipped_files': 0, 'failed_files': 0, 'bytes_transferred': 0}
    monkeypatch.setattr(recovery, '_require_migration_operator', lambda: None)
    monkeypatch.setattr(recovery, '_owned_state', AsyncMock(return_value=state))
    monkeypatch.setattr(recovery, '_save', AsyncMock())
    monkeypatch.setattr(recovery, '_dispatch', AsyncMock())
    monkeypatch.setattr(recovery, '_cleanup_export', AsyncMock())
    monkeypatch.setattr(recovery, '_connection', AsyncMock(return_value=object()))
    monkeypatch.setattr(recovery.config, 'get', AsyncMock(return_value='synthetic'))
    monkeypatch.setattr(recovery, '_source_api', AsyncMock(return_value={'data': {'attributes': {
        'organization-id': 1774800, 'export-all': False, 'encrypted-status': True, 'download-url': 'https://source.test/owned',
    }}}))
    monkeypatch.setattr(recovery, '_open_archive', lambda *args: (SimpleNamespace(etag='"owned"', close=lambda: None), archive))
    result = await recovery.docs_export_recovery_step('run', 'g')
    assert result['recovered_files'] == 1 and result['failed_files'] == 0
    assert result['bytes_transferred'] == len(body)
    complete.assert_awaited_once()
    metadata = writes.call_args.args[2]
    assert metadata['size_bytes'] == len(body)
    assert metadata['declared_size_bytes'] == len(body) + 1 and metadata['size_verified'] is False
