from __future__ import annotations

from types import SimpleNamespace

import pytest

from functions import migration
from modules.migration_core import (
    RESOURCE_SPECS,
    flexible_asset_cursor_key,
    source_detail_path,
    stable_id,
)


def _spec(name: str):
    return next(item for item in RESOURCE_SPECS if item.name == name)


def test_configuration_taxonomy_specs_copy_account_global_resources_per_tenant() -> None:
    """Configuration taxonomy must participate in the normal source-owned lifecycle."""
    assert _spec("configuration_types").endpoint == "/configuration_types"
    assert _spec("configuration_types").table == "docs-configuration-types"
    assert _spec("configuration_statuses").endpoint == "/configuration_statuses"
    assert _spec("configuration_statuses").table == "docs-configuration-statuses"


def test_folder_detail_paths_use_the_supported_organization_relationship_route() -> None:
    assert source_detail_path(_spec("document_folders"), "folder-7", "itglue-42") == (
        "/organizations/itglue-42/relationships/document_folders/folder-7"
    )
    assert source_detail_path(_spec("password_folders"), "folder-8", "itglue-42") == (
        "/organizations/itglue-42/relationships/password_folders/folder-8"
    )
    assert source_detail_path(_spec("documents"), "document-1", "itglue-42") == "/documents/document-1"
    assert flexible_asset_cursor_key("itglue-42", "bifrost-1", "type-9") != flexible_asset_cursor_key(
        "itglue-42", "bifrost-1", "type-10"
    )


@pytest.mark.parametrize(
    ("resource_type", "table"),
    [
        ("configuration_types", "docs-configuration-types"),
        ("configuration_statuses", "docs-configuration-statuses"),
    ],
)
def test_configuration_taxonomy_projection_preserves_name_provenance_and_is_active_by_default(
    resource_type: str, table: str
) -> None:
    source = {
        "id": "taxonomy-1",
        "attributes": {"name": "Network equipment", "updated-at": "2026-09-22T12:00:00Z"},
    }

    row = migration._domain_row(
        _spec(resource_type), source, "org-a", stable_id("org-a", resource_type, "taxonomy-1")
    )

    assert _spec(resource_type).table == table
    assert row == {
        "organization_id": "org-a",
        "source_system": "itglue",
        "source_id": "taxonomy-1",
        "source_updated_at": "2026-09-22T12:00:00Z",
        "raw": source,
        "name": "Network equipment",
        "active": True,
    }


@pytest.mark.asyncio
async def test_flexible_asset_processing_redacts_password_kinds_and_ambiguous_rich_traits(monkeypatch) -> None:
    """The production upsert path must use stored field metadata, not an injected hint."""
    source = {
        "id": "asset-1",
        "type": "flexible-assets",
        "attributes": {
            "name": "Firewall",
            "flexible-asset-type-id": "type-9",
            "traits": {
                "admin-password": "never-table-this",
                "hostname": "fw-01",
                "unmapped-rich-value": {"password": "also-never-table-this"},
            },
        },
    }
    included = [
        {
            "id": "cell-1",
            "type": "passwords",
            "attributes": {
                "name": "Admin Password",
                "resource-type": "StructuredData::Cell",
                "resource-id": "asset-1",
            },
        }
    ]
    upserts: list[tuple[str, str, dict]] = []

    async def get(table, row_id):
        if table == "docs-flexible-asset-types":
            return SimpleNamespace(data={"fields": [
                {
                    "id": "field-password",
                    "type": "flexible-asset-fields",
                    "attributes": {
                        "name": "Admin Password",
                        "name-key": "admin-password",
                        "kind": "Password",
                    },
                },
                {
                    "id": "field-hostname",
                    "type": "flexible-asset-fields",
                    "attributes": {
                        "name": "Hostname",
                        "name-key": "hostname",
                        "kind": "Text",
                    },
                },
            ]})
        return None

    async def upsert(table, row_id, data):
        upserts.append((table, row_id, data))

    async def update(*args, **kwargs):
        return None

    async def hydrate(*args, **kwargs):
        return source, included, []

    async def no_op(*args, **kwargs):
        return None

    monkeypatch.setattr(migration.tables, "get", get)
    monkeypatch.setattr(migration.tables, "upsert", upsert)
    monkeypatch.setattr(migration.tables, "update", update)
    monkeypatch.setattr(migration, "_hydrate_resource", hydrate)
    monkeypatch.setattr(migration, "_prune_owned_children", no_op)

    result = await migration._process_resource(
        object(), "run-1", "itglue-1", "org-a", _spec("flexible_assets"), source, "bulk"
    )

    assert result == "succeeded"
    row = next(data for table, _, data in upserts if table == "docs-flexible-assets")

    assert row["flexible_asset_type_id"] == stable_id(
        "org-a", "flexible_asset_types", "type-9"
    )
    assert row["secret_fields"] == ["admin-password", "unmapped-rich-value"]
    assert row["secret_ciphertext"] is None
    assert row["traits"]["admin-password"] == "[REDACTED]"
    assert row["traits"]["hostname"] == "fw-01"
    assert row["traits"]["unmapped-rich-value"] == "[REDACTED]"
    assert row["raw"]["attributes"]["traits"]["admin-password"] == "[REDACTED]"
    assert "never-table-this" not in str(row)
    assert "also-never-table-this" not in str(row)


def test_password_projection_keeps_only_metadata_and_source_link() -> None:
    source = {
        "id": "password-source-1",
        "type": "passwords",
        "attributes": {
            "name": "Production VPN",
            "username": "ops@example.test",
            "resource-url": "https://app.itglue.test/passwords/1",
            "password": "secret-value",
            "otp-secret": "otp-value",
        },
    }

    row = migration._domain_row(
        _spec("passwords"), source, "org-a", "password-destination-1"
    )

    assert row["name"] == "Production VPN"
    assert row["source_url"] == "https://app.itglue.test/passwords/1"
    assert row["has_password"] is False
    assert row["has_totp"] is False
    assert row["raw"] is None
    assert all(row[column] is None for column in migration.SECRET_COLUMNS)
    assert "secret-value" not in str(row)
    assert "otp-value" not in str(row)


def test_folder_and_record_projections_use_destination_folder_ids() -> None:
    """Source folder identifiers must never be written into destination references."""
    target_org_id = "org-a"
    parent_source_id = "folder-parent"
    child_source_id = "folder-child"
    folder = migration._domain_row(
        _spec("document_folders"),
        {
            "id": child_source_id,
            "attributes": {
                "name": "Child",
                "parent-id": parent_source_id,
                "ancestor-ids": ["folder-root", parent_source_id],
            },
        },
        target_org_id,
        stable_id(target_org_id, "document_folders", child_source_id),
    )
    document = migration._domain_row(
        _spec("documents"),
        {"id": "document-1", "attributes": {"name": "Guide", "document-folder-id": child_source_id}},
        target_org_id,
        "document-destination-1",
    )
    password = migration._domain_row(
        _spec("passwords"),
        {"id": "password-1", "attributes": {"name": "VPN", "password-folder-id": child_source_id}},
        target_org_id,
        "password-destination-1",
    )

    assert folder["parent_id"] == stable_id(target_org_id, "document_folders", parent_source_id)
    assert folder["ancestor_ids"] == [
        stable_id(target_org_id, "document_folders", "folder-root"),
        stable_id(target_org_id, "document_folders", parent_source_id),
    ]
    assert document["folder_id"] == stable_id(target_org_id, "document_folders", child_source_id)
    assert password["folder_id"] == stable_id(target_org_id, "password_folders", child_source_id)


@pytest.mark.asyncio
async def test_folder_restriction_lookup_accepts_destination_ids_and_fails_closed_on_cycles(monkeypatch) -> None:
    """Canonical references work while malformed legacy cycles remain restricted."""
    parent_id = stable_id("org-a", "document_folders", "parent")
    child_id = stable_id("org-a", "document_folders", "child")
    rows = {
        parent_id: SimpleNamespace(id=parent_id, data={"organization_id": "org-a", "parent_id": child_id, "restricted": False}),
        child_id: SimpleNamespace(id=child_id, data={"organization_id": "org-a", "parent_id": parent_id, "restricted": False}),
    }

    async def get(table, row_id):
        assert table == "docs-document-folders"
        return rows.get(row_id)

    monkeypatch.setattr(migration.tables, "get", get)

    assert await migration._folder_is_restricted("org-a", "document_folders", parent_id) is True


def test_source_restriction_projection_marks_only_ancestor_inference_as_recoverable() -> None:
    """Imported source restrictions and inferred ancestor restrictions have distinct provenance."""
    row = migration._domain_row(
        _spec("documents"),
        {"id": "document-1", "attributes": {"name": "Guide", "restricted": False}},
        "org-a",
        "document-destination-1",
    )

    assert row["restriction_inferred"] is False
    assert row["restriction_reason"] is None


def test_unchanged_reference_backfill_repairs_only_legacy_raw_source_values() -> None:
    source = {"id": "doc-1", "attributes": {"document-folder-id": "source-folder"}}
    destination_folder = stable_id("org-a", "document_folders", "source-folder")

    assert migration._unchanged_folder_reference_backfill(
        _spec("documents"), source, "org-a", {"folder_id": "source-folder"}
    ) == {"folder_id": destination_folder}
    assert migration._unchanged_folder_reference_backfill(
        _spec("documents"), source, "org-a", {"folder_id": stable_id("org-a", "document_folders", "local-folder")}
    ) == {}


@pytest.mark.asyncio
async def test_only_marked_inferred_restrictions_are_released_after_folder_recovery(monkeypatch) -> None:
    source = {"id": "doc-1", "attributes": {"document-folder-id": "folder-1", "restricted": False}}

    async def get(*args, **kwargs):
        return SimpleNamespace(data={"organization_id": "org-a", "restricted": False, "parent_id": None})

    monkeypatch.setattr(migration.tables, "get", get)

    release = await migration._refresh_inferred_restriction(
        "org-a", _spec("documents"), source,
        {"restricted": True, "restriction_inferred": True, "restriction_reason": "restricted_folder_ancestor"},
    )
    preserve = await migration._refresh_inferred_restriction(
        "org-a", _spec("documents"), source,
        {"restricted": True, "restriction_inferred": False, "restriction_reason": "source_restricted"},
    )

    assert release == {"restricted": False, "restriction_inferred": False, "restriction_reason": None}
    assert preserve == {}


@pytest.mark.asyncio
async def test_unclassified_historical_restriction_creates_operator_finding(monkeypatch) -> None:
    findings: list[dict] = []

    async def upsert(table, row_id, data):
        assert table == migration.FINDINGS_TABLE
        findings.append(data)

    monkeypatch.setattr(migration.tables, "upsert", upsert)

    await migration._record_unclassified_restriction(
        "run-1", "itglue-1", "org-a", _spec("documents"), "doc-1", "dest-1",
        {"id": "doc-1", "attributes": {"restricted": False}},
        {"restricted": True},
    )

    assert findings[0]["finding_type"] == "restriction_provenance_unknown"
    assert findings[0]["status"] == "open"


@pytest.mark.asyncio
async def test_inferred_folder_restriction_traces_same_org_ancestors_and_rejects_foreign_rows(monkeypatch) -> None:
    child_id = stable_id("org-a", "document_folders", "child")
    parent_id = stable_id("org-a", "document_folders", "parent")
    rows = {
        child_id: SimpleNamespace(data={
            "organization_id": "org-a", "restricted": True, "restriction_inferred": True, "parent_id": parent_id,
        }),
        parent_id: SimpleNamespace(data={
            "organization_id": "org-a", "restricted": False, "parent_id": None,
        }),
    }

    async def get(table, row_id):
        assert table == "docs-document-folders"
        return rows.get(row_id)

    monkeypatch.setattr(migration.tables, "get", get)
    assert await migration._folder_is_restricted("org-a", "document_folders", child_id) is False

    rows[parent_id] = SimpleNamespace(data={
        "organization_id": "org-b", "restricted": False, "parent_id": None,
    })
    assert await migration._folder_is_restricted("org-a", "document_folders", child_id) is True


def test_document_projection_rewrites_only_hydrated_image_attributes_to_managed_references() -> None:
    source = {
        "id": "document-1",
        "attributes": {"name": "Guide"},
        "_sections": [{
            "id": "section-1",
            "attributes": {
                "content": (
                    '<p>Keep https://source.test/images/34 as text.</p>'
                    '<img src="/7/docs/7/developer/images/34">'
                    '<img data-src="https://source.test/image-35?token=secret">'
                    '<img src="/developer/images/unknown"><a href="https://source.test/image-35?token=secret">source</a>'
                ),
                "rendered-content": '<img src="https://source.test/image-35?token=secret">',
            },
        }],
    }
    images = [
        {"id": "34", "attributes": {"original-src": "https://source.test/image-34?token=secret"}},
        {"id": "35", "attributes": {"original-src": "https://source.test/image-35?token=secret"}},
    ]

    row = migration._domain_row(
        _spec("documents"), source, "org-a", "document-destination-1", images=images
    )

    image_34 = f"bifrost-attachment:{stable_id('org-a', 'document_image', '34')}"
    image_35 = f"bifrost-attachment:{stable_id('org-a', 'document_image', '35')}"
    assert f'src="{image_34}"' in row["content"]
    assert f'data-src="{image_35}"' in row["content"]
    assert f'src="{image_35}"' in row["rendered_content"]
    assert 'src="/developer/images/unknown"' in row["content"]
    assert '<a href="https://source.test/image-35?token=secret">source</a>' in row["content"]
    assert "https://source.test/images/34 as text" in row["content"]
    assert row["raw"] == source



@pytest.mark.asyncio
async def test_child_only_image_backfill_requires_stored_presentation_to_equal_raw_source(monkeypatch) -> None:
    raw_source = {
        "id": "document-1",
        "attributes": {"name": "Guide"},
        "_sections": [{"id": "section-1", "attributes": {
            "content": '<img src="/developer/images/34">',
            "rendered-content": '<img src="/developer/images/34">',
        }}],
    }
    updates: list[dict] = []

    async def update(table, row_id, values):
        assert (table, row_id) == ("docs-documents", "document-destination-1")
        updates.append(values)

    monkeypatch.setattr(migration.tables, "update", update)
    images = [{"id": "34", "attributes": {"original-src": "https://source.test/image-34"}}]
    destination = {
        "raw": raw_source,
        "content": '<img src="/developer/images/34">',
        "rendered_content": '<img src="/developer/images/34">',
    }

    await migration._backfill_document_image_references(
        "org-a", "document-destination-1", destination, raw_source, images
    )

    reference = f"bifrost-attachment:{stable_id('org-a', 'document_image', '34')}"
    assert updates == [{"content": f'<img src="{reference}">', "rendered_content": f'<img src="{reference}">'}]

    updates.clear()
    await migration._backfill_document_image_references(
        "org-a", "document-destination-1",
        {**destination, "content": "<p>Local edit</p>"},
        raw_source, images,
    )
    assert updates == []
