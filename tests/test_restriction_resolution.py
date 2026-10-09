from __future__ import annotations

import pytest

from functions import migration


@pytest.mark.asyncio
async def test_restriction_resolution_rejects_more_than_one_hundred_finding_ids(monkeypatch) -> None:
    monkeypatch.setattr(migration.context, "is_platform_admin", True, raising=False)

    with pytest.raises(migration.UserError, match="At most 100"):
        await migration.docs_migration_resolve_restrictions([f"finding-{index}" for index in range(101)])


class _SourceClient:
    def __init__(self, responses: dict[str, dict], **_: object) -> None:
        self._responses = responses
        self.paths: list[str] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def get_document(self, path: str, **_: object) -> dict:
        self.paths.append(path)
        if path not in self._responses:
            raise migration.ITGlueError("source row unavailable", status_code=404)
        return self._responses[path]


def _restriction_state(*, document_restricted: bool = True, document_actor: str = "proof", folder_restricted: bool = False):
    target_org_id = "org-a"
    source_org_id = "itglue-a"
    source_id = "17"
    folder_source_id = "8"
    document_id = migration.stable_id(target_org_id, "documents", source_id)
    folder_id = migration.stable_id(target_org_id, "document_folders", folder_source_id)
    rows = {
        (migration.FINDINGS_TABLE, "finding-1"): {
            "id": "finding-1",
            "updated_by": "proof",
            "data": {
                "run_id": "run-1", "organization_id": target_org_id,
                "source_organization_id": source_org_id, "resource_type": "documents",
                "finding_type": "restriction_provenance_unknown", "source_id": source_id,
                "destination_id": document_id, "status": "open",
            },
        },
        (migration.RUNS_TABLE, "run-1"): {
            "id": "run-1", "updated_by": "proof",
            "data": {"bifrost_organization_ids": [target_org_id]},
        },
        (migration.DOCUMENTS_TABLE, document_id): {
            "id": document_id, "updated_by": document_actor,
            "data": {
                "organization_id": target_org_id, "source_system": "itglue", "source_id": source_id,
                "restricted": document_restricted, "restriction_inferred": None,
                "restriction_reason": None, "folder_id": folder_id,
            },
        },
        (migration.DOCUMENT_FOLDERS_TABLE, folder_id): {
            "id": folder_id, "updated_by": "proof",
            "data": {
                "organization_id": target_org_id, "source_system": "itglue", "source_id": folder_source_id,
                "parent_id": None, "restricted": folder_restricted,
            },
        },
    }
    responses = {
        "/documents/17": {"data": {"id": source_id, "attributes": {"restricted": False, "organization-id": source_org_id, "document-folder-id": folder_source_id}}},
        f"/organizations/{source_org_id}/relationships/document_folders/{folder_source_id}": {
            "data": {"id": folder_source_id, "attributes": {"restricted": folder_restricted, "parent-id": None}}
        },
    }
    return rows, responses, document_id


def _install_restriction_fakes(monkeypatch, rows, responses):
    updates: list[tuple[str, str, dict]] = []
    audits: list[dict] = []
    clients: list[_SourceClient] = []

    async def get(table, row_id):
        return rows.get((table, row_id))

    async def update(table, row_id, changes):
        updates.append((table, row_id, dict(changes)))
        row = rows[(table, row_id)]
        row["data"].update(changes)
        return row

    async def insert(table, data):
        assert table == migration.AUDIT_TABLE
        audits.append(dict(data))

    async def list_mappings(name, scope):
        assert (name, scope) == ("IT Glue", "global")
        return [type("Mapping", (), {"organization_id": "org-a", "entity_id": "itglue-a"})()]

    async def integration_get(name, scope):
        assert (name, scope) == ("IT Glue", "org-a")
        return type("Connection", (), {"entity_id": "itglue-a", "config": {"api_key": "test-key"}})()

    class ClientFactory:
        def __init__(self, *_args, **kwargs):
            client = _SourceClient(responses, **kwargs)
            clients.append(client)
            self._client = client

        async def __aenter__(self):
            return await self._client.__aenter__()

        async def __aexit__(self, *args):
            return await self._client.__aexit__(*args)

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "update", update)
    monkeypatch.setattr(migration.tables, "insert", insert)
    monkeypatch.setattr(migration.integrations, "list_mappings", list_mappings)
    monkeypatch.setattr(migration.integrations, "get", integration_get)
    monkeypatch.setattr(migration, "ITGlueClient", ClientFactory)
    monkeypatch.setattr(migration.context, "is_platform_admin", True, raising=False)
    return updates, audits, clients


@pytest.mark.asyncio
async def test_restriction_resolution_clears_only_currently_proven_unrestricted_chain(monkeypatch) -> None:
    rows, responses, document_id = _restriction_state()
    updates, audits, clients = _install_restriction_fakes(monkeypatch, rows, responses)
    from functions import indexing

    indexed: list[tuple[str, str]] = []

    async def sync(organization_id, destination_id):
        indexed.append((organization_id, destination_id))

    monkeypatch.setattr(indexing, "sync_document_index", sync)

    result = await migration.docs_migration_resolve_restrictions(["finding-1"])

    assert result["resolved"] == 1
    assert rows[(migration.DOCUMENTS_TABLE, document_id)]["data"]["restricted"] is False
    assert indexed == [("org-a", document_id)]
    assert rows[(migration.FINDINGS_TABLE, "finding-1")]["data"]["status"] == "resolved"
    assert clients[0].paths == [
        "/documents/17", "/organizations/itglue-a/relationships/document_folders/8"
    ]
    assert any(table == migration.DOCUMENTS_TABLE and data["restricted"] is False for table, _, data in updates)
    assert audits[-1]["metadata"] == {
        "finding_id": "finding-1", "run_id": "run-1", "source_id": "17",
        "source_organization_id": "itglue-a", "classification": "source_chain_unrestricted",
        "reason": "current_source_document_and_ancestors_explicitly_unrestricted", "folder_count": 1,
    }


@pytest.mark.asyncio
async def test_restriction_resolution_retains_explicit_source_folder_restriction(monkeypatch) -> None:
    rows, responses, document_id = _restriction_state(folder_restricted=True)
    updates, _audits, _clients = _install_restriction_fakes(monkeypatch, rows, responses)

    result = await migration.docs_migration_resolve_restrictions(["finding-1"])

    assert result["retained_restricted"] == 1
    assert rows[(migration.DOCUMENTS_TABLE, document_id)]["data"]["restricted"] is True
    assert not [call for call in updates if call[0] == migration.DOCUMENTS_TABLE]
    assert rows[(migration.FINDINGS_TABLE, "finding-1")]["data"]["status"] == "open"


@pytest.mark.asyncio
async def test_restriction_resolution_rejects_a_document_changed_after_proof(monkeypatch) -> None:
    rows, responses, document_id = _restriction_state(document_actor="local-user")
    updates, _audits, clients = _install_restriction_fakes(monkeypatch, rows, responses)

    result = await migration.docs_migration_resolve_restrictions(["finding-1"])

    assert result["retained_restricted"] == 1
    assert "changed after the proof run" in result["results"][0]["reason"]
    assert clients == []
    assert not [call for call in updates if call[0] == migration.DOCUMENTS_TABLE]
    assert rows[(migration.DOCUMENTS_TABLE, document_id)]["data"]["restricted"] is True


@pytest.mark.asyncio
async def test_restriction_resolution_restores_restriction_when_indexing_fails(monkeypatch) -> None:
    rows, responses, document_id = _restriction_state()
    _updates, audits, _clients = _install_restriction_fakes(monkeypatch, rows, responses)
    from functions import indexing

    async def sync(*_args):
        raise RuntimeError("index unavailable")

    monkeypatch.setattr(indexing, "sync_document_index", sync)

    result = await migration.docs_migration_resolve_restrictions(["finding-1"])

    assert result["retained_restricted"] == 1
    assert rows[(migration.DOCUMENTS_TABLE, document_id)]["data"]["restricted"] is True
    assert rows[(migration.FINDINGS_TABLE, "finding-1")]["data"]["status"] == "open"
    assert audits[-1]["event_type"] == "migration.restriction_resolution_failed"


@pytest.mark.asyncio
async def test_restriction_resolution_closes_stale_finding_without_source_write(monkeypatch) -> None:
    rows, responses, document_id = _restriction_state(document_restricted=False)
    updates, audits, clients = _install_restriction_fakes(monkeypatch, rows, responses)

    result = await migration.docs_migration_resolve_restrictions(["finding-1"])

    assert result["results"] == [{"finding_id": "finding-1", "status": "resolved", "classification": "stale_already_unrestricted"}]
    assert clients == []
    assert not [call for call in updates if call[0] == migration.DOCUMENTS_TABLE]
    assert rows[(migration.DOCUMENTS_TABLE, document_id)]["data"]["restricted"] is False
    assert audits[-1]["metadata"]["classification"] == "stale_already_unrestricted"


@pytest.mark.asyncio
async def test_restriction_resolution_retains_document_moved_from_source_folder(monkeypatch) -> None:
    rows, responses, document_id = _restriction_state()
    rows[(migration.DOCUMENTS_TABLE, document_id)]["data"]["folder_id"] = None
    updates, _audits, _clients = _install_restriction_fakes(monkeypatch, rows, responses)

    result = await migration.docs_migration_resolve_restrictions(["finding-1"])

    assert result["retained_restricted"] == 1
    assert "folder changed" in result["results"][0]["reason"]
    assert not [call for call in updates if call[0] == migration.DOCUMENTS_TABLE]
    assert rows[(migration.DOCUMENTS_TABLE, document_id)]["data"]["restricted"] is True


@pytest.mark.asyncio
async def test_restriction_resolution_rechecks_destination_folder_chain_before_write(monkeypatch) -> None:
    rows, responses, document_id = _restriction_state()
    updates, _audits, _clients = _install_restriction_fakes(monkeypatch, rows, responses)
    original_get = migration.tables.get
    folder_key = next(key for key in rows if key[0] == migration.DOCUMENT_FOLDERS_TABLE)
    calls = 0

    async def get(table, row_id):
        nonlocal calls
        row = await original_get(table, row_id)
        if (table, row_id) == folder_key:
            calls += 1
            if calls == 1:
                snapshot = {**row, "data": dict(row["data"])}
                row["updated_by"] = "local-user"
                return snapshot
        return row

    monkeypatch.setattr(migration.tables, "get", get)

    result = await migration.docs_migration_resolve_restrictions(["finding-1"])

    assert result["retained_restricted"] == 1
    assert not [call for call in updates if call[0] == migration.DOCUMENTS_TABLE]
    assert rows[(migration.DOCUMENTS_TABLE, document_id)]["data"]["restricted"] is True


@pytest.mark.asyncio
async def test_restriction_resolution_retains_missing_source_folder_chain(monkeypatch) -> None:
    rows, responses, document_id = _restriction_state()
    del responses["/organizations/itglue-a/relationships/document_folders/8"]
    updates, _audits, _clients = _install_restriction_fakes(monkeypatch, rows, responses)

    result = await migration.docs_migration_resolve_restrictions(["finding-1"])

    assert result["retained_restricted"] == 1
    assert not [call for call in updates if call[0] == migration.DOCUMENTS_TABLE]
    assert rows[(migration.DOCUMENTS_TABLE, document_id)]["data"]["restricted"] is True
