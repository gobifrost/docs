from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from functions import migration
from modules.migration_core import source_map_id, stable_id


ORG = "org-a"
SOURCE_ORG = "42"
DOC_ID = stable_id(ORG, "documents", "17")
FOLDER_ID = stable_id(ORG, "document_folders", "8")
REL_ID = stable_id(ORG, "related_item", "31")


def install_fakes(monkeypatch):
    rows = {
        ("docs-documents", DOC_ID): {
            "id": DOC_ID,
            "data": {
                "organization_id": ORG,
                "source_system": "itglue",
                "source_id": "17",
                "folder_id": FOLDER_ID,
                "raw": {"id": "17", "attributes": {"document-folder-id": "8"}},
            },
        },
        ("docs-source-map", source_map_id(ORG, "documents", "17")): {
            "id": source_map_id(ORG, "documents", "17"),
            "data": {
                "organization_id": ORG,
                "source_organization_id": SOURCE_ORG,
                "resource_type": "documents",
                "source_id": "17",
                "destination_id": DOC_ID,
            },
        },
        ("docs-relationships", REL_ID): {
            "id": REL_ID,
            "data": {
                "organization_id": ORG,
                "source_system": "itglue",
                "source_id": "31",
                "source_type": "documents",
                "source_destination_id": DOC_ID,
                "target_type": "passwords",
                "target_source_id": "29",
                "target_destination_id": None,
                "raw": {
                    "id": "31",
                    "attributes": {
                        "asset-id": "17",
                        "source-type": "document",
                        "destination-type": "password",
                        "destination-id": "29",
                        "password": "do-not-return-source-secret",
                    },
                },
            },
        },
    }
    responses = {
        "/documents/17": {
            "data": {
                "id": "17",
                "attributes": {
                    "organization-id": SOURCE_ORG,
                    "document-folder-id": "8",
                },
            }
        },
        "/organizations/42/relationships/document_folders/8": {
            "data": {
                "id": "8",
                "attributes": {"organization-id": SOURCE_ORG},
            }
        },
        "/passwords/29": {
            "data": {
                "id": "29",
                "attributes": {
                    "organization-id": SOURCE_ORG,
                    "name": "do-not-return-source-name",
                    "password": "do-not-return-source-secret",
                    "url": "https://private.invalid/secret",
                },
            }
        },
    }
    paths = []
    integration_reads = []
    mapping_ids = [SOURCE_ORG]

    async def get(table, row_id):
        return rows.get((table, row_id))

    async def list_mappings(name, scope):
        assert (name, scope) == ("IT Glue", "global")
        return [
            SimpleNamespace(organization_id=ORG, entity_id=id_) for id_ in mapping_ids
        ]

    async def connection(name, scope):
        assert (name, scope) == ("IT Glue", ORG)
        integration_reads.append(scope)
        return SimpleNamespace(entity_id=SOURCE_ORG, config={"api_key": "fake-api-key"})

    async def no_write(*args, **kwargs):
        raise AssertionError("A reference diagnosis must never write destination state")

    class Client:
        def __init__(self, key, **kwargs):
            assert key == "fake-api-key"

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def get_document(self, path):
            paths.append(path)
            response = responses[path]
            if isinstance(response, Exception):
                raise response
            return response

    monkeypatch.setattr(migration.tables, "get", get)
    for method in ("upsert", "insert", "update", "delete"):
        monkeypatch.setattr(migration.tables, method, no_write)
    monkeypatch.setattr(migration.integrations, "list_mappings", list_mappings)
    monkeypatch.setattr(migration.integrations, "get", connection)
    monkeypatch.setattr(migration, "ITGlueClient", Client)
    monkeypatch.setattr(migration.context, "is_platform_admin", True, raising=False)
    return rows, responses, paths, integration_reads, mapping_ids


async def diagnose(*, documents=None, relationships=None):
    return await migration.docs_migration_diagnose_references(
        document_ids=documents or [],
        relationship_ids=relationships or [],
    )


@pytest.mark.asyncio
async def test_reads_supported_folder_route_and_exposes_only_classification(
    monkeypatch,
):
    _, _, paths, _, _ = install_fakes(monkeypatch)
    result = await diagnose(documents=[DOC_ID], relationships=[REL_ID])
    assert [item["status"] for item in result["results"]] == [
        "source_exists_destination_missing",
        "source_exists_destination_missing",
    ]
    assert paths == [
        "/documents/17",
        "/organizations/42/relationships/document_folders/8",
        "/passwords/29",
    ]
    assert result["read_only"] is True
    assert result["counts"] == {"source_exists_destination_missing": 2}
    serialized = json.dumps(result)
    for forbidden in (
        "fake-api-key",
        "do-not-return",
        "private.invalid",
        "raw",
        "attributes",
    ):
        assert forbidden not in serialized


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,classification",
    [
        (404, "source_not_found_or_restricted"),
        (403, "source_access_denied"),
        (429, "source_transient_error"),
        (503, "source_transient_error"),
    ],
)
async def test_source_failures_do_not_claim_deletion_or_disclose_bodies(
    monkeypatch, status, classification
):
    _, responses, _, _, _ = install_fakes(monkeypatch)
    responses["/passwords/29"] = migration.ITGlueError(
        "do-not-return-source-secret", status_code=status
    )
    result = await diagnose(relationships=[REL_ID])
    assert result["results"][0]["status"] == classification
    assert result["results"][0]["http_status"] == status
    assert "do-not-return" not in json.dumps(result)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "guard",
    [
        "foreign_owner",
        "changed_source_id",
        "changed_map",
        "changed_raw_target",
        "unsafe_source_id",
    ],
)
async def test_invalid_provenance_never_reads_source_credentials(monkeypatch, guard):
    rows, _, paths, connections, _ = install_fakes(monkeypatch)
    rel = rows[("docs-relationships", REL_ID)]["data"]
    if guard == "foreign_owner":
        rows[("docs-documents", DOC_ID)]["data"]["organization_id"] = "org-b"
    elif guard == "changed_source_id":
        rel["source_id"] = "32"
    elif guard == "changed_map":
        rows[("docs-source-map", source_map_id(ORG, "documents", "17"))]["data"][
            "destination_id"
        ] = "other"
    elif guard == "changed_raw_target":
        rel["raw"]["attributes"]["destination-id"] = "30"
    else:
        rel["target_source_id"] = rel["raw"]["attributes"]["destination-id"] = "../29"
    result = await diagnose(relationships=[REL_ID])
    assert result["results"][0]["status"] == "provenance_invalid"
    assert paths == connections == []


@pytest.mark.asyncio
@pytest.mark.parametrize("mappings", [["99"], ["42", "42"]])
async def test_changed_or_ambiguous_mapping_prevents_source_reads(
    monkeypatch, mappings
):
    _, _, paths, connections, mapping_ids = install_fakes(monkeypatch)
    mapping_ids[:] = mappings
    result = await diagnose(relationships=[REL_ID])
    assert result["results"][0]["status"] == "mapping_changed"
    assert paths == connections == []


@pytest.mark.asyncio
async def test_changed_source_document_folder_is_reported_without_probing_old_folder(
    monkeypatch,
):
    _, responses, paths, _, _ = install_fakes(monkeypatch)
    responses["/documents/17"]["data"]["attributes"]["document-folder-id"] = "9"
    result = await diagnose(documents=[DOC_ID])
    assert result["results"][0]["status"] == "source_reference_changed"
    assert paths == ["/documents/17"]


@pytest.mark.asyncio
async def test_source_target_from_other_organization_cannot_prove_local_destination_missing(
    monkeypatch,
):
    _, responses, _, _, _ = install_fakes(monkeypatch)
    responses["/passwords/29"]["data"]["attributes"]["organization-id"] = "99"
    result = await diagnose(relationships=[REL_ID])
    assert result["results"][0]["status"] == "source_other_organization"


@pytest.mark.asyncio
async def test_unsupported_relationship_is_preserved_without_source_read(monkeypatch):
    rows, _, paths, connections, _ = install_fakes(monkeypatch)
    rel = rows[("docs-relationships", REL_ID)]["data"]
    rel["target_type"] = rel["raw"]["attributes"]["destination-type"] = "Contact"
    result = await diagnose(relationships=[REL_ID])
    assert result["results"][0]["status"] == "unsupported_target_type"
    assert paths == connections == []


@pytest.mark.asyncio
async def test_destination_target_is_verified_before_calling_it_resolved(monkeypatch):
    rows, _, _, _, _ = install_fakes(monkeypatch)
    target_id = stable_id(ORG, "passwords", "29")
    rows[("docs-passwords", target_id)] = {
        "id": target_id,
        "data": {
            "organization_id": "org-b",
            "source_id": "29",
            "source_system": "itglue",
        },
    }
    result = await diagnose(relationships=[REL_ID])
    assert result["results"][0]["status"] == "destination_identity_mismatch"


@pytest.mark.asyncio
async def test_invalid_input_and_customer_operator_are_rejected_before_reads(
    monkeypatch,
):
    _, _, paths, connections, _ = install_fakes(monkeypatch)
    for ids in (
        [],
        ["invalid-id"],
        [str(stable_id(ORG, "documents", str(i))) for i in range(101)],
    ):
        with pytest.raises(migration.UserError):
            await diagnose(documents=ids)
    monkeypatch.setattr(migration.context, "is_platform_admin", False)
    monkeypatch.setattr(
        migration.context,
        "organization",
        SimpleNamespace(is_provider=False),
        raising=False,
    )
    with pytest.raises(migration.UserError, match="provider or platform"):
        await diagnose(documents=[DOC_ID])
    assert paths == connections == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation,status",
    [
        ("wrong_id", "source_identity_mismatch"),
        ("missing_org", "source_scope_unverified"),
        ("present", "source_and_destination_present"),
    ],
)
async def test_positive_source_proof_requires_identity_scope_and_destination_ownership(
    monkeypatch, mutation, status
):
    rows, responses, _, _, _ = install_fakes(monkeypatch)
    source = responses["/passwords/29"]["data"]
    if mutation == "wrong_id":
        source["id"] = "30"
    elif mutation == "missing_org":
        source["attributes"].pop("organization-id")
    else:
        target_id = stable_id(ORG, "passwords", "29")
        rows[("docs-passwords", target_id)] = {
            "id": target_id,
            "data": {
                "organization_id": ORG,
                "source_system": "itglue",
                "source_id": "29",
            },
        }
    result = await diagnose(relationships=[REL_ID])
    assert result["results"][0]["status"] == status
    assert "do-not-return" not in json.dumps(result)


@pytest.mark.asyncio
async def test_connection_mapping_is_rechecked_before_client_construction(monkeypatch):
    _, _, paths, _, _ = install_fakes(monkeypatch)

    async def wrong_connection(*args, **kwargs):
        return SimpleNamespace(entity_id="99", config={"api_key": "must-not-use"})

    monkeypatch.setattr(migration.integrations, "get", wrong_connection)
    result = await diagnose(relationships=[REL_ID])
    assert result["results"][0]["status"] == "mapping_changed"
    assert paths == []


@pytest.mark.asyncio
async def test_root_document_has_no_folder_and_duplicate_requests_are_read_once(
    monkeypatch,
):
    rows, _, paths, _, _ = install_fakes(monkeypatch)
    document = rows[("docs-documents", DOC_ID)]["data"]
    document["folder_id"] = None
    document["raw"]["attributes"]["document-folder-id"] = None
    result = await diagnose(documents=[DOC_ID, DOC_ID])
    assert result["counts"] == {"no_folder_reference": 1}
    assert paths == []


@pytest.mark.asyncio
async def test_limit_applies_to_document_and_relationship_selection_together(
    monkeypatch,
):
    _, _, paths, connections, _ = install_fakes(monkeypatch)
    with pytest.raises(migration.UserError, match="100"):
        await diagnose(documents=[DOC_ID] * 60, relationships=[REL_ID] * 60)
    assert paths == connections == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mapping_state,classification",
    [
        ("unmapped", "unmapped"),
        ("ambiguous", "ambiguous"),
        ("missing_destination", "mapped_destination_missing"),
        ("present_destination", "mapped_destination_present"),
        ("missing_source_map", "mapped_source_map_missing"),
    ],
)
async def test_foreign_target_classification_uses_current_mapping_and_canonical_destination(
    monkeypatch, mapping_state, classification
):
    rows, responses, _, _, _ = install_fakes(monkeypatch)
    responses["/passwords/29"]["data"]["attributes"]["organization-id"] = "99"
    mappings = [SimpleNamespace(organization_id=ORG, entity_id=SOURCE_ORG)]
    if mapping_state != "unmapped":
        mappings.append(SimpleNamespace(organization_id="org-b", entity_id="99"))
    if mapping_state == "ambiguous":
        mappings.append(SimpleNamespace(organization_id="org-c", entity_id="99"))
    if mapping_state in {"present_destination", "missing_source_map"}:
        target_id = stable_id("org-b", "passwords", "29")
        rows[("docs-passwords", target_id)] = {
            "id": target_id,
            "data": {
                "organization_id": "org-b",
                "source_system": "itglue",
                "source_id": "29",
            },
        }
        if mapping_state == "present_destination":
            map_id = source_map_id("org-b", "passwords", "29")
            rows[("docs-source-map", map_id)] = {
                "id": map_id,
                "data": {
                    "organization_id": "org-b",
                    "source_organization_id": "99",
                    "resource_type": "passwords",
                    "source_id": "29",
                    "destination_id": target_id,
                },
            }

    async def list_mappings(*args, **kwargs):
        return mappings

    monkeypatch.setattr(migration.integrations, "list_mappings", list_mappings)
    result = await diagnose(relationships=[REL_ID])
    assert result["results"][0]["status"] == "source_other_organization"
    assert result["results"][0]["target_mapping_status"] == classification


@pytest.mark.asyncio
async def test_password_parent_provenance_uses_canonical_metadata_and_map_without_raw_secret_body(
    monkeypatch,
):
    rows, _, paths, _, _ = install_fakes(monkeypatch)
    parent_id = stable_id(ORG, "passwords", "57")
    rows[("docs-passwords", parent_id)] = {
        "id": parent_id,
        "data": {
            "organization_id": ORG,
            "source_system": "itglue",
            "source_id": "57",
            "raw": None,
        },
    }
    map_id = source_map_id(ORG, "passwords", "57")
    rows[("docs-source-map", map_id)] = {
        "id": map_id,
        "data": {
            "organization_id": ORG,
            "source_organization_id": SOURCE_ORG,
            "resource_type": "passwords",
            "source_id": "57",
            "destination_id": parent_id,
        },
    }
    rel = rows[("docs-relationships", REL_ID)]["data"]
    rel.update(source_type="passwords", source_destination_id=parent_id)
    rel["raw"]["attributes"].update({"asset-id": "57", "source-type": "password"})
    result = await diagnose(relationships=[REL_ID])
    assert result["results"][0]["status"] == "source_exists_destination_missing"
    assert paths == ["/passwords/29"]
