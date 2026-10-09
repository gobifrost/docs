"""Resumable, API-first IT Glue migration workflows for Bifrost Docs."""

from __future__ import annotations

import hashlib
import mimetypes
import re
import uuid
from datetime import datetime, timezone
from html import escape as html_escape
from html import unescape as html_unescape
from typing import Any, Mapping
from urllib.parse import urljoin, urlparse

from bifrost import UserError, context, files, integrations, organizations, tables, tool, workflow, workflows

from modules.itglue_api import ITGlueClient, ITGlueError, attributes, resource_id, scrub_secrets
from modules.managed_files import complete_signed_upload
from modules.migration_core import (
    DEFAULT_RESOURCE_TYPES,
    RESOURCE_SPECS,
    ResourceSpec,
    attr,
    canonical_related_item_resource_kind,
    canonical_source_fingerprint,
    flexible_asset_cursor_key,
    hydrated_document_content_fingerprint,
    migration_item_id,
    migration_cursor_key,
    project_flexible_asset_traits,
    redact_named_fields,
    reconciliation_finding_id,
    safe_file_name,
    source_is_unchanged,
    source_detail_path,
    source_map_id,
    stable_id,
)

RUNS_TABLE = "docs-migration-runs"
ITEMS_TABLE = "docs-migration-items"
MAP_TABLE = "docs-source-map"
ATTACHMENTS_TABLE = "docs-attachments"
RELATIONSHIPS_TABLE = "docs-relationships"
AUDIT_TABLE = "docs-audit-events"
FINDINGS_TABLE = "docs-reconciliation-findings"
DOCUMENTS_TABLE = "docs-documents"
DOCUMENT_FOLDERS_TABLE = "docs-document-folders"
FILE_ORG_GRANTS_TABLE = "docs-file-org-grants"
RUNTIME_REVISION = "2026-10-02-image-only-sections-v10"
TRANSFER_VERSION = "decoded-body-v2"
RUN_REF = "functions/migration.py::docs_migration_run"
ACTIVE_STATUSES = {"queued", "running", "cancelling"}
SECRET_COLUMNS = (
    "secret_algorithm",
    "secret_key_version",
    "secret_nonce",
    "secret_ciphertext",
)


def _require_no_active_recovery(run: dict[str, Any]) -> None:
    if (run.get("recovery") or {}).get("status") in {"queued", "waiting", "running", "cancelling"}:
        raise UserError("Finish or cancel file recovery before resuming or retrying this migration")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _data(row: Any) -> dict[str, Any]:
    if row is None:
        return {}
    value = getattr(row, "data", None)
    if isinstance(value, dict):
        return value
    if isinstance(row, dict):
        nested = row.get("data")
        return nested if isinstance(nested, dict) else row
    return {}


def _value(row: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(row, dict) and name in row:
            return row[name]
        value = getattr(row, name, None)
        if value is not None:
            return value
    return default


def _require_migration_operator() -> None:
    """Keep global IT Glue mapping and run state out of customer-org tools."""
    organization = getattr(context, "organization", None)
    if not (
        getattr(context, "is_platform_admin", False)
        or getattr(organization, "is_provider", False)
    ):
        raise UserError("Migration tools are restricted to provider or platform administrators")


def _absolute_platform_url(value: Any) -> str:
    """Resolve a Bifrost-relative signed URL only against this execution's platform."""
    candidate = str(value or "").strip()
    parsed = urlparse(candidate)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        return candidate
    if parsed.scheme or parsed.netloc:
        raise ITGlueError("Bifrost returned an invalid destination upload URL")
    public_url = str(getattr(context, "public_url", "") or "").strip().rstrip("/")
    origin = urlparse(public_url)
    if origin.scheme not in {"http", "https"} or not origin.netloc:
        raise ITGlueError("Bifrost did not provide a usable public URL for the upload")
    return urljoin(f"{public_url}/", candidate.lstrip("/"))


def _destination_folder_id(target_org_id: str, folder_type: str, value: Any) -> str | None:
    """Translate a source folder reference while retaining a root sentinel."""
    if value in (None, "", 0, "0"):
        return None
    return stable_id(target_org_id, folder_type, str(value))


def _destination_folder_ids(target_org_id: str, folder_type: str, values: Any) -> list[str]:
    """Translate source ancestors, omitting any root sentinels."""
    if not isinstance(values, list):
        return []
    return [
        destination_id
        for value in values
        if (destination_id := _destination_folder_id(target_org_id, folder_type, value)) is not None
    ]


async def _folder_is_restricted(
    target_org_id: str, folder_type: str, folder_id: Any
) -> bool:
    """Fail closed for unavailable folders and cycles, accepting legacy or destination IDs."""
    if folder_id in (None, "", 0, "0"):
        return False
    table_name = "docs-document-folders" if folder_type == "document_folders" else "docs-password-folders"
    pending = [str(folder_id)]
    seen: set[str] = set()
    while pending:
        current = pending.pop()
        if current in ("", "0"):
            continue
        # New projections use stable destination IDs; legacy rows retained raw
        # IT Glue IDs. Try the given ID first, then its deterministic mapping.
        row = await tables.get(table_name, current)
        resolved_id = current
        if row is None:
            resolved_id = stable_id(target_org_id, folder_type, current)
            if resolved_id != current:
                row = await tables.get(table_name, resolved_id)
        if row is None or resolved_id in seen:
            return True
        seen.add(resolved_id)
        data = _data(row)
        if str(data.get("organization_id") or "") != target_org_id:
            return True
        # A source-native restriction is authoritative. An inherited marker
        # records a previous fail-closed walk, so follow the current ancestor
        # chain instead; its parent may have recovered since that import.
        if data.get("restricted") and data.get("restriction_inferred") is not True:
            return True
        parent = data.get("parent_id")
        if parent not in (None, "", 0, "0"):
            pending.append(str(parent))
    return False


def _unchanged_folder_reference_backfill(
    spec: ResourceSpec,
    source: dict[str, Any],
    target_org_id: str,
    destination_data: Mapping[str, Any],
) -> dict[str, Any]:
    """Repair legacy raw references only when they still equal the source projection."""
    attrs = attributes(source)
    updates: dict[str, Any] = {}
    if spec.name in {"document_folders", "password_folders"}:
        source_parent = attr(attrs, "parent_id")
        if destination_data.get("parent_id") == source_parent:
            updates["parent_id"] = _destination_folder_id(target_org_id, spec.name, source_parent)
        source_ancestors = attr(attrs, "ancestor_ids", default=[])
        if isinstance(source_ancestors, list) and destination_data.get("ancestor_ids") == source_ancestors:
            updates["ancestor_ids"] = _destination_folder_ids(target_org_id, spec.name, source_ancestors)
    elif spec.name == "documents":
        source_folder = attr(attrs, "document_folder_id", "folder_id")
        if destination_data.get("folder_id") == source_folder:
            updates["folder_id"] = _destination_folder_id(target_org_id, "document_folders", source_folder)
    elif spec.name == "passwords":
        source_folder = attr(attrs, "password_folder_id", "folder_id")
        if destination_data.get("folder_id") == source_folder:
            updates["folder_id"] = _destination_folder_id(target_org_id, "password_folders", source_folder)
    return updates


def _source_restricted(attrs: Mapping[str, Any]) -> bool:
    return bool(attr(attrs, "restricted", default=False))


def _folder_reference_for_source(
    spec: ResourceSpec, source: Mapping[str, Any], target_org_id: str
) -> tuple[str, str | None] | None:
    """Return the canonical folder reference governing inherited restriction."""
    attrs = attributes(source)
    if spec.name in {"document_folders", "password_folders"}:
        return spec.name, _destination_folder_id(target_org_id, spec.name, attr(attrs, "parent_id"))
    if spec.name == "documents":
        return "document_folders", _destination_folder_id(
            target_org_id, "document_folders", attr(attrs, "document_folder_id", "folder_id")
        )
    if spec.name == "passwords":
        return "password_folders", _destination_folder_id(
            target_org_id, "password_folders", attr(attrs, "password_folder_id", "folder_id")
        )
    return None


async def _refresh_inferred_restriction(
    target_org_id: str,
    spec: ResourceSpec,
    source: Mapping[str, Any],
    destination_data: Mapping[str, Any],
) -> dict[str, Any]:
    """Re-evaluate only restrictions previously marked as folder-derived."""
    if destination_data.get("restriction_inferred") is not True:
        return {}
    attrs = attributes(source)
    if _source_restricted(attrs):
        return {
            "restricted": True,
            "restriction_inferred": False,
            "restriction_reason": "source_restricted",
        }
    reference = _folder_reference_for_source(spec, source, target_org_id)
    inherited = bool(reference and reference[1] and await _folder_is_restricted(
        target_org_id, reference[0], reference[1]
    ))
    if inherited:
        return {
            "restricted": True,
            "restriction_inferred": True,
            "restriction_reason": "restricted_folder_ancestor",
        }
    return {
        "restricted": False,
        "restriction_inferred": False,
        "restriction_reason": None,
    }


async def _record_unclassified_restriction(
    run_id: str,
    source_org_id: str,
    target_org_id: str,
    spec: ResourceSpec,
    source_id: str,
    destination_id: str,
    source: Mapping[str, Any],
    destination_data: Mapping[str, Any],
) -> None:
    """Keep historical fail-closed rows restricted until an operator resolves provenance."""
    if (
        spec.name not in {"document_folders", "password_folders", "documents", "passwords"}
        or not destination_data.get("restricted")
        or "restriction_inferred" in destination_data
        or _source_restricted(attributes(source))
    ):
        return
    await _write_reconciliation_finding(
        run_id,
        source_org_id,
        target_org_id,
        spec.name,
        source_id,
        destination_id,
        "restriction_provenance_unknown",
        "Existing restricted row has no source or inferred-restriction provenance; retained for operator review.",
    )


async def _get_run(run_id: str) -> tuple[Any, dict[str, Any]]:
    row = await tables.get(RUNS_TABLE, run_id)
    if row is None:
        raise UserError("Migration run not found")
    return row, _data(row)


async def _update_run(run_id: str, changes: dict[str, Any]) -> dict[str, Any]:
    changes["last_checkpoint_at"] = _now()
    row = await tables.update(RUNS_TABLE, run_id, changes)
    return _data(row)


async def _write_audit(
    organization_id: str,
    event_type: str,
    summary: str,
    *,
    entity_type: str = "migration_run",
    entity_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    await tables.insert(
        AUDIT_TABLE,
        {
            "organization_id": organization_id,
            "event_type": event_type,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "summary": summary,
            "actor": str(getattr(context, "user_id", None) or "workflow"),
            "occurred_at": _now(),
            "metadata": metadata or {},
        },
    )


_DOCUMENT_SPEC = next(spec for spec in RESOURCE_SPECS if spec.name == "documents")
_DOCUMENT_FOLDER_SPEC = next(spec for spec in RESOURCE_SPECS if spec.name == "document_folders")


def _row_actor(row: Any) -> str:
    """Read platform metadata without mistaking source payload fields for an actor."""
    return str(_value(row, "updated_by", default="") or "")


def _required_text(value: Any, message: str) -> str:
    result = str(value or "").strip()
    if not result:
        raise UserError(message)
    return result


async def _restriction_finding_context(finding_id: str) -> tuple[Any, dict[str, Any], Any, dict[str, Any], Any, dict[str, Any], str]:
    """Validate that a finding still names one IT Glue-owned document and proof run."""
    finding_row = await tables.get(FINDINGS_TABLE, finding_id)
    if finding_row is None:
        raise UserError("Restriction finding was not found")
    finding = _data(finding_row)
    if (
        finding.get("finding_type") != "restriction_provenance_unknown"
        or finding.get("resource_type") != "documents"
        or finding.get("status") != "open"
    ):
        raise UserError("Restriction finding is not open document provenance work")
    target_org_id = _required_text(finding.get("organization_id"), "Restriction finding has no organization")
    _required_text(finding.get("source_organization_id"), "Restriction finding has no source organization")
    source_id = _required_text(finding.get("source_id"), "Restriction finding has no source ID")
    destination_id = _required_text(
        finding.get("destination_id"), "Restriction finding has no destination ID"
    )
    if destination_id != stable_id(target_org_id, "documents", source_id):
        raise UserError("Restriction finding destination mapping is not canonical")
    run_id = _required_text(finding.get("run_id"), "Restriction finding has no migration run")
    run_row, run = await _get_run(run_id)
    if target_org_id not in {str(item) for item in run.get("bifrost_organization_ids") or []}:
        raise UserError("Restriction finding organization is outside its migration run")
    proof_actor = _row_actor(run_row)
    if not proof_actor:
        raise UserError("Migration proof actor is unavailable")
    document_row = await tables.get(DOCUMENTS_TABLE, destination_id)
    if document_row is None:
        raise UserError("Restriction finding destination document is unavailable")
    document = _data(document_row)
    if (
        str(document.get("organization_id") or "") != target_org_id
        or str(document.get("source_system") or "") != "itglue"
        or str(document.get("source_id") or "") != source_id
    ):
        raise UserError("Restriction finding destination document ownership changed")
    if _row_actor(document_row) != proof_actor:
        raise UserError("Restriction finding document changed after the proof run")
    return finding_row, finding, run_row, run, document_row, document, proof_actor


async def _current_itglue_mapping(target_org_id: str, source_org_id: str) -> Any:
    """Require the current Integration mapping to match the finding before source reads."""
    mappings = await integrations.list_mappings("IT Glue", scope="global")
    if mappings is None:
        raise UserError("The IT Glue Integration is not available")
    matches = [
        mapping
        for mapping in mappings
        if str(getattr(mapping, "organization_id", "") or "") == target_org_id
    ]
    if len(matches) != 1 or str(getattr(matches[0], "entity_id", "") or "") != source_org_id:
        raise UserError("IT Glue organization mapping changed since the proof run")
    return matches[0]


async def _fresh_unrestricted_folder_chain(
    client: ITGlueClient,
    *,
    target_org_id: str,
    source_org_id: str,
    source_id: str,
    proof_actor: str,
    destination_data: Mapping[str, Any],
) -> tuple[list[tuple[str, str | None]], str | None]:
    """Read current source document/folders and prove a same-org unrestricted path."""
    document_payload = await client.get_document(source_detail_path(_DOCUMENT_SPEC, source_id))
    source_document = document_payload.get("data")
    if not isinstance(source_document, dict) or str(resource_id(source_document) or "") != source_id:
        raise UserError("IT Glue document no longer matches the restriction finding")
    document_attrs = attributes(source_document)
    if (
        attr(document_attrs, "restricted") is not False
        or str(attr(document_attrs, "organization_id", default="") or "") != source_org_id
    ):
        raise UserError("IT Glue document is restricted, unavailable, or outside the mapped organization")

    folder_id = attr(document_attrs, "document_folder_id", "folder_id")
    expected_document_folder = _destination_folder_id(
        target_org_id, "document_folders", folder_id
    )
    if destination_data.get("folder_id") != expected_document_folder:
        raise UserError("Destination document folder changed after the proof run")
    chain: list[tuple[str, str | None]] = []
    seen: set[str] = set()
    while folder_id not in (None, "", 0, "0"):
        current_id = str(folder_id)
        if current_id in seen or len(seen) >= 100:
            raise UserError("IT Glue document folder ancestry is cyclic or too deep")
        seen.add(current_id)
        payload = await client.get_document(
            source_detail_path(_DOCUMENT_FOLDER_SPEC, current_id, source_org_id)
        )
        source_folder = payload.get("data")
        if not isinstance(source_folder, dict) or str(resource_id(source_folder) or "") != current_id:
            raise UserError("IT Glue document folder no longer matches the restriction finding")
        folder_attrs = attributes(source_folder)
        if (
            attr(folder_attrs, "restricted") is not False
            or (attr(folder_attrs, "organization_id", default=None) is not None
                and str(attr(folder_attrs, "organization_id")) != source_org_id)
        ):
            raise UserError("IT Glue document folder is restricted or outside the mapped organization")
        parent_id = attr(folder_attrs, "parent_id")
        parent = None if parent_id in (None, "", 0, "0") else str(parent_id)
        chain.append((current_id, parent))
        folder_id = parent

    await _verify_destination_folder_chain(target_org_id, chain, proof_actor)
    return chain, expected_document_folder


async def _verify_destination_folder_chain(
    target_org_id: str, chain: list[tuple[str, str | None]], proof_actor: str
) -> None:
    """Require every projected folder to remain source-owned and proof-actor current."""
    # The destination chain is the mutable side of this proof. Reusing this
    # check immediately before the document write closes the network-read race.
    for current_id, parent_id in chain:
        destination_folder_id = stable_id(target_org_id, "document_folders", current_id)
        folder_row = await tables.get(DOCUMENT_FOLDERS_TABLE, destination_folder_id)
        if folder_row is None:
            raise UserError("Destination document folder is unavailable")
        folder = _data(folder_row)
        if (
            str(folder.get("organization_id") or "") != target_org_id
            or str(folder.get("source_system") or "") != "itglue"
            or str(folder.get("source_id") or "") != current_id
            or folder.get("parent_id") != _destination_folder_id(target_org_id, "document_folders", parent_id)
            or _row_actor(folder_row) != proof_actor
        ):
            raise UserError("Destination document folder chain changed after the proof run")


async def _resolve_one_restriction_finding(finding_id: str) -> dict[str, str]:
    """Resolve one audited restriction finding only after its current provenance is proven."""
    _, finding, _, _, document_row, document, proof_actor = await _restriction_finding_context(finding_id)
    target_org_id = str(finding["organization_id"])
    source_org_id = str(finding["source_organization_id"])
    source_id = str(finding["source_id"])
    destination_id = str(finding["destination_id"])
    run_id = str(finding["run_id"])

    # A restricted=False destination with the proof actor is a stale finding.
    # It changes no document state, but records why this open review item closed.
    if document.get("restricted") is False:
        await tables.update(
            FINDINGS_TABLE,
            finding_id,
            {
                "status": "resolved",
                "resolved_at": _now(),
                "detail": "Resolved: destination document was already unrestricted under the proof actor.",
            },
        )
        await _write_audit(
            target_org_id,
            "migration.restriction_resolution",
            "Resolved stale restriction provenance finding",
            entity_type="documents",
            entity_id=destination_id,
            metadata={
                "finding_id": finding_id,
                "run_id": run_id,
                "source_id": source_id,
                "source_organization_id": source_org_id,
                "classification": "stale_already_unrestricted",
                "reason": "already_unrestricted_under_proof_actor",
            },
        )
        return {"finding_id": finding_id, "status": "resolved", "classification": "stale_already_unrestricted"}

    if document.get("restricted") is not True:
        raise UserError("Restriction finding destination state is not a supported restricted value")
    mapping = await _current_itglue_mapping(target_org_id, source_org_id)
    connection = await integrations.get("IT Glue", scope=target_org_id)
    if connection is None or str(getattr(connection, "entity_id", "") or "") != source_org_id:
        raise UserError("IT Glue Integration mapping changed since the proof run")
    api_key = getattr(connection, "config", {}).get("api_key")
    if not api_key:
        raise UserError("The IT Glue Integration has no API key configured")
    base_url = getattr(connection, "config", {}).get("base_url") or "https://api.itglue.com"
    # Keep a reference to the mapping so all proof inputs are evaluated before
    # modifying the destination.  It also makes a missing mapping non-bypassable.
    if str(getattr(mapping, "entity_id", "") or "") != source_org_id:
        raise UserError("IT Glue organization mapping changed since the proof run")
    async with ITGlueClient(str(api_key), base_url=str(base_url)) as client:
        chain, expected_document_folder = await _fresh_unrestricted_folder_chain(
            client,
            target_org_id=target_org_id,
            source_org_id=source_org_id,
            source_id=source_id,
            proof_actor=proof_actor,
            destination_data=document,
        )

    # Re-read after the network proof.  A local edit during the source request
    # invalidates the proof instead of overwriting it.
    current_row = await tables.get(DOCUMENTS_TABLE, destination_id)
    current = _data(current_row)
    if (
        current_row is None
        or _row_actor(current_row) != proof_actor
        or current.get("restricted") is not True
        or str(current.get("organization_id") or "") != target_org_id
        or str(current.get("source_id") or "") != source_id
        or current.get("folder_id") != expected_document_folder
    ):
        raise UserError("Restriction finding document changed during source verification")
    await _verify_destination_folder_chain(target_org_id, chain, proof_actor)

    original = {
        "restricted": current.get("restricted"),
        "restriction_inferred": current.get("restriction_inferred"),
        "restriction_reason": current.get("restriction_reason"),
    }
    await tables.update(
        DOCUMENTS_TABLE,
        destination_id,
        {"restricted": False, "restriction_inferred": False, "restriction_reason": None},
    )
    try:
        from functions.indexing import sync_document_index

        await sync_document_index(target_org_id, destination_id)
    except Exception as exc:
        # The access-safe fallback wins over availability: do not leave an
        # unrestricted document whose index may still omit or expose it.
        await tables.update(
            DOCUMENTS_TABLE,
            destination_id,
            {
                "restricted": True,
                "restriction_inferred": original["restriction_inferred"],
                "restriction_reason": original["restriction_reason"] or "restriction_normalization_index_failed",
            },
        )
        await _write_audit(
            target_org_id,
            "migration.restriction_resolution_failed",
            "Restored document restriction after index synchronization failed",
            entity_type="documents",
            entity_id=destination_id,
            metadata={
                "finding_id": finding_id,
                "run_id": run_id,
                "source_id": source_id,
                "source_organization_id": source_org_id,
                "classification": "source_chain_unrestricted",
                "reason": type(exc).__name__,
            },
        )
        raise UserError("Document restriction was restored because index synchronization failed") from exc

    await tables.update(
        FINDINGS_TABLE,
        finding_id,
        {
            "status": "resolved",
            "resolved_at": _now(),
            "detail": "Resolved: current IT Glue document and folder ancestry explicitly report unrestricted.",
        },
    )
    await _write_audit(
        target_org_id,
        "migration.restriction_resolution",
        "Resolved restriction provenance finding from current source ancestry",
        entity_type="documents",
        entity_id=destination_id,
        metadata={
            "finding_id": finding_id,
            "run_id": run_id,
            "source_id": source_id,
            "source_organization_id": source_org_id,
            "classification": "source_chain_unrestricted",
            "reason": "current_source_document_and_ancestors_explicitly_unrestricted",
            "folder_count": len(chain),
        },
    )
    return {"finding_id": finding_id, "status": "resolved", "classification": "source_chain_unrestricted"}


@workflow(
    name="docs_migration_resolve_restrictions",
    description="Bounded operator repair for audited IT Glue restriction provenance findings.",
    category="Bifrost Docs Migration",
)
async def docs_migration_resolve_restrictions(finding_ids: list[str]) -> dict[str, Any]:
    """Resolve at most 100 allowlisted findings, retaining every uncertain row restricted."""
    _require_migration_operator()
    normalized = [str(value).strip() for value in finding_ids if str(value).strip()]
    if not normalized:
        raise UserError("At least one restriction finding ID is required")
    if len(normalized) != len(set(normalized)):
        raise UserError("Restriction finding IDs must be unique")
    if len(normalized) > 100:
        raise UserError("At most 100 restriction finding IDs may be resolved per call")
    results: list[dict[str, str]] = []
    for finding_id in normalized:
        try:
            results.append(await _resolve_one_restriction_finding(finding_id))
        except (UserError, ITGlueError) as exc:
            results.append({"finding_id": finding_id, "status": "retained_restricted", "reason": str(exc)})
    return {
        "requested": len(normalized),
        "resolved": sum(1 for result in results if result["status"] == "resolved"),
        "retained_restricted": sum(1 for result in results if result["status"] != "resolved"),
        "results": results,
    }


@workflow(
    name="docs_migration_diagnose_references",
    description="Classify selected migrated document folders and related targets using read-only IT Glue source verification.",
)
async def docs_migration_diagnose_references(
    document_ids: list[str] | None = None,
    relationship_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Verify up to 100 explicit references in the worker without returning source bodies."""
    _require_migration_operator()
    from modules.reference_diagnostics import diagnose_references

    return await diagnose_references(
        document_ids=document_ids or [], relationship_ids=relationship_ids or [],
        tables=tables, integrations=integrations,
        verify_mapping=_current_itglue_mapping, client_factory=ITGlueClient,
    )


@tool(
    name="docs_migration_preflight",
    description="List Bifrost organizations connected to IT Glue for a scoped documentation migration.",
)
async def docs_migration_preflight() -> dict[str, Any]:
    """Return safe connection scope choices without Integration config values."""
    _require_migration_operator()
    mappings = await integrations.list_mappings("IT Glue", scope="global")
    if mappings is None:
        raise UserError("The IT Glue Integration is not available")
    org_rows = await organizations.list()
    names = {
        str(_value(row, "id")): str(_value(row, "name", default=""))
        for row in org_rows or []
    }
    choices = [
        {
            "bifrost_organization_id": str(mapping.organization_id),
            "bifrost_organization_name": names.get(str(mapping.organization_id), ""),
            "itglue_organization_id": str(mapping.entity_id),
            "itglue_organization_name": mapping.entity_name or "",
        }
        for mapping in mappings
        if mapping.organization_id and mapping.entity_id
    ]
    choices.sort(key=lambda item: (item["bifrost_organization_name"].casefold(), item["bifrost_organization_id"]))
    return {"organizations": choices, "count": len(choices), "resource_types": list(DEFAULT_RESOURCE_TYPES)}


@tool(
    name="docs_migration_start",
    description="Start a checkpointed API-first IT Glue to Bifrost Docs migration after operator confirmation.",
)
async def docs_migration_start(
    bifrost_organization_ids: list[str] | None = None,
    resource_types: list[str] | None = None,
    mode: str = "proof",
) -> dict[str, Any]:
    """Create durable run state and dispatch the long-running migration worker."""
    _require_migration_operator()
    if mode not in {"proof", "bulk", "delta", "reconcile"}:
        raise UserError("mode must be proof, bulk, delta, or reconcile")
    selected = list(dict.fromkeys(resource_types or DEFAULT_RESOURCE_TYPES))
    unsupported = sorted(set(selected) - set(DEFAULT_RESOURCE_TYPES))
    if unsupported:
        raise UserError(f"Unsupported resource types: {', '.join(unsupported)}")
    target_ids = [str(item).strip() for item in (bifrost_organization_ids or []) if str(item).strip()]
    if mode == "proof" and len(target_ids) != 1:
        raise UserError("Proof runs require exactly one Bifrost organization")
    if await integrations.get("IT Glue") is None:
        raise UserError("The IT Glue Integration is not available")

    run_id = str(uuid.uuid4())
    run_data = {
        "status": "queued",
        "mode": mode,
        "bifrost_organization_ids": target_ids,
        "resource_types": selected,
        "phase": "organizations",
        "cursors": {},
        "counts": {"succeeded": 0, "failed": 0, "skipped": 0},
        "mapping_queue": [],
        "reconciliation_counts": {},
        "incomplete_enumerations": [],
        "cancel_requested": False,
        "execution_id": None,
        "started_at": None,
        "watermark_started_at": None,
        "source_watermark_at": None,
        "completed_at": None,
        "last_checkpoint_at": _now(),
        "last_error": None,
    }
    await tables.upsert(RUNS_TABLE, run_id, run_data)
    execution_id = await workflows.execute(RUN_REF, input_data={"run_id": run_id})
    await _update_run(run_id, {"execution_id": execution_id})
    return {
        "run_id": run_id,
        "execution_id": execution_id,
        "status": "queued",
        "resource_types": selected,
        "password_values_enabled": False,
    }


@tool(
    name="docs_migration_resume",
    description="Resume an interrupted Bifrost Docs IT Glue migration from persisted checkpoints.",
)
async def docs_migration_resume(
    run_id: str,
    force: bool = False,
) -> dict[str, Any]:
    _require_migration_operator()
    _, run = await _get_run(run_id)
    _require_no_active_recovery(run)
    if run.get("status") == "completed":
        raise UserError("Completed migrations do not need to be resumed")
    if run.get("status") == "completed_with_errors":
        raise UserError("Use retry failures for a migration that completed with errors")
    if run.get("status") in ACTIVE_STATUSES and not force:
        raise UserError(
            "This migration is already active. Use force=true only after confirming its prior "
            "workflow execution is no longer running."
        )
    await _update_run(
        run_id,
        {"status": "queued", "execution_id": None, "cancel_requested": False, "completed_at": None, "last_error": None},
    )
    execution_id = await workflows.execute(RUN_REF, input_data={"run_id": run_id})
    await _update_run(run_id, {"execution_id": execution_id})
    return {"run_id": run_id, "execution_id": execution_id, "status": "queued"}


@tool(
    name="docs_migration_retry_failures",
    description="Reset failed Bifrost Docs migration items and re-enumerate safely using deterministic IDs.",
)
async def docs_migration_retry_failures(run_id: str) -> dict[str, Any]:
    _require_migration_operator()
    _, run = await _get_run(run_id)
    _require_no_active_recovery(run)
    if run.get("status") in ACTIVE_STATUSES:
        raise UserError("Cancel the active migration before retrying failed items")
    # Capture existing pending rows before changing failed rows. A prior retry
    # may have reset those rows before being interrupted, and their checkpoint
    # scopes must remain eligible for replay on the next retry.
    retry_items: list[Any] = []
    pending_offset = 0
    while True:
        pending = await tables.query(
            ITEMS_TABLE,
            where={"run_id": run_id, "status": "pending"},
            limit=1000,
            offset=pending_offset,
        )
        pending_rows = list(pending.documents or [])
        retry_items.extend(pending_rows)
        if len(pending_rows) < 1000:
            break
        pending_offset += len(pending_rows)

    reset = 0
    while True:
        failures = await tables.query(
            ITEMS_TABLE,
            where={"run_id": run_id, "status": "failed"},
            limit=1000,
        )
        if not failures.documents:
            break
        retry_items.extend(failures.documents)
        for row in failures.documents:
            await tables.update(
                ITEMS_TABLE,
                str(row.id),
                {"status": "pending", "error_code": None, "error_message": None, "completed_at": None},
            )
            reset += 1
    await _update_run(
        run_id,
        {
            "status": "queued",
            # A status refresh must not treat the previous stopped worker as
            # the owner while the replacement dispatch is still in flight.
            "execution_id": None,
            "cancel_requested": False,
            "cursors": _retry_cursors_after_failures(run.get("cursors") or {}, retry_items),
            "reconciliation_counts": _retry_cursors_after_failures(
                run.get("reconciliation_counts") or {}, retry_items
            ),
            "completed_at": None,
            "last_error": None,
        },
    )
    execution_id = await workflows.execute(RUN_REF, input_data={"run_id": run_id})
    await _update_run(run_id, {"execution_id": execution_id})
    return {"run_id": run_id, "reset_failures": reset, "execution_id": execution_id}


def _retry_cursors_after_failures(
    cursors: Mapping[str, Any], retry_items: list[Any]
) -> dict[str, Any]:
    """Replay only checkpoints with failed or previously reset pending items.

    An incomplete legacy retry row cannot safely identify its checkpoint, so
    retain the prior full-reset behavior in that case.
    """
    known_resources = {spec.name for spec in RESOURCE_SPECS}
    retry_scopes: set[tuple[str, str]] = set()
    for retry_item in retry_items:
        data = _data(retry_item)
        target_org_id = str(data.get("organization_id") or "").strip()
        resource_type = str(data.get("resource_type") or "").strip()
        if not target_org_id or resource_type not in known_resources:
            return {}
        retry_scopes.add((target_org_id, resource_type))
    if not retry_scopes:
        return {}

    retained: dict[str, Any] = {}
    for key, value in cursors.items():
        # Cursor keys are source-org:target-org:resource-type. Source IDs are
        # deliberately not part of retry scope: a target can have more than one
        # source mapping and every matching resource checkpoint must replay.
        _, separator, remainder = str(key).partition(":")
        target_org_id, separator_after_target, resource_key = remainder.partition(":")
        if not separator or not separator_after_target:
            retained[str(key)] = value
            continue
        if any(
            target_org_id == failed_target
            and (resource_key == failed_resource or resource_key.startswith(f"{failed_resource}:"))
            for failed_target, failed_resource in retry_scopes
        ):
            continue
        retained[str(key)] = value
    return retained


@tool(
    name="docs_migration_cancel",
    description="Request cooperative cancellation of a Bifrost Docs migration at the next resource checkpoint.",
)
async def docs_migration_cancel(run_id: str) -> dict[str, Any]:
    _require_migration_operator()
    _, run = await _get_run(run_id)
    if run.get("status") in {"completed", "completed_with_errors", "cancelled"}:
        return {"run_id": run_id, "status": run.get("status"), "changed": False}
    await _update_run(run_id, {"cancel_requested": True, "status": "cancelling"})
    return {"run_id": run_id, "status": "cancelling", "changed": True}


async def _reconcile_worker_status(run_id: str, run: dict[str, Any]) -> dict[str, Any]:
    """Expose saved checkpoints when the actual worker has stopped."""
    worker_id = run.get("execution_id")
    if run.get("status") not in ACTIVE_STATUSES or not worker_id:
        return run
    execution = await workflows.get(str(worker_id))
    value = getattr(execution, "status", None)
    status = str(getattr(value, "value", value) or "").lower()
    if status not in {"failed", "cancelled", "timeout", "timed_out", "success", "completed"}:
        return run
    _, current = await _get_run(run_id)
    if current.get("execution_id") != worker_id or current.get("status") not in ACTIVE_STATUSES:
        return current
    changes = {
        "status": "cancelled" if current.get("cancel_requested") else "interrupted",
        "last_error": "The migration worker stopped. Resume from the saved checkpoint.",
    }
    await _update_run(run_id, changes)
    return {**current, **changes}


@tool(
    name="docs_migration_status",
    description="Read checkpoint-backed status, counts, cursors, and recent failures for a Bifrost Docs migration.",
)
async def docs_migration_status(run_id: str | None = None) -> dict[str, Any]:
    _require_migration_operator()
    recent = await tables.query(RUNS_TABLE, order_by="created_at", order_dir="desc", limit=100)
    if run_id:
        row, run = await _get_run(run_id)
    else:
        if not recent.documents:
            return {"run": None, "runs": [], "counts": {}, "failures": [], "findings": []}
        row = next((item for item in recent.documents
                    if _data(item).get("status") in ACTIVE_STATUSES
                    or (_data(item).get("recovery") or {}).get("status")
                    in {"queued", "waiting", "running", "cancelling"}), recent.documents[0])
        run_id = str(row.id)
        run = _data(row)
    run = await _reconcile_worker_status(str(run_id), run)
    picker_rows = list(recent.documents)
    if not any(str(item.id) == str(run_id) for item in picker_rows):
        picker_rows.append(row)
    summaries = []
    for item in picker_rows:
        data = run if str(item.id) == str(run_id) else _data(item)
        summaries.append({
            "id": str(item.id), "status": data.get("status"), "mode": data.get("mode"),
            "started_at": data.get("started_at"),
            "organization_count": len(data.get("bifrost_organization_ids") or []),
            "resource_count": len(data.get("resource_types") or []),
            "recovery_status": (data.get("recovery") or {}).get("status"),
        })
    counts = {}
    for status in ("pending", "running", "succeeded", "failed", "skipped"):
        counts[status] = await tables.count(ITEMS_TABLE, where={"run_id": run_id, "status": status})
    failures = await tables.query(
        ITEMS_TABLE,
        where={"run_id": run_id, "status": "failed"},
        order_by="updated_at",
        order_dir="desc",
        limit=25,
    )
    findings = await tables.query(
        FINDINGS_TABLE,
        where={"run_id": run_id},
        order_by="detected_at",
        order_dir="desc",
        limit=50,
    )
    return {
        "code_revision": RUNTIME_REVISION,
        "run": {"id": str(_value(row, "id")), **run},
        "runs": summaries,
        "counts": counts,
        "failures": [{"id": str(item.id), **_data(item)} for item in failures.documents],
        "findings": [{"id": str(item.id), **_data(item)} for item in findings.documents],
    }


async def _resolve_organization_mappings(
    run: dict[str, Any],
) -> list[tuple[str, str]]:
    """Use the existing IT Glue Integration mappings as the sole org authority."""
    mappings = await integrations.list_mappings("IT Glue", scope="global")
    if mappings is None:
        raise UserError("The IT Glue Integration is not available")
    target_filter = set(run.get("bifrost_organization_ids") or [])
    resolved: list[tuple[str, str]] = []
    seen_targets: set[str] = set()
    for mapping in mappings:
        target_id = str(mapping.organization_id or "")
        if not target_id or (target_filter and target_id not in target_filter):
            continue
        source_id = str(mapping.entity_id or "")
        if not source_id:
            raise UserError("An IT Glue Integration mapping has no source organization ID")
        if target_id in seen_targets:
            raise UserError("The IT Glue Integration has duplicate mappings for one Bifrost organization")
        seen_targets.add(target_id)
        await _cleanup_repointed_organization_mapping(target_id, source_id)
        await tables.upsert(
            MAP_TABLE,
            stable_id(target_id, "organization-map", source_id),
            {
                "organization_id": target_id,
                "source_organization_id": source_id,
                "source_organization_name": mapping.entity_name,
                "resource_type": "organization",
                "source_id": source_id,
                "destination_id": target_id,
                "source_updated_at": None,
                "migrated_at": _now(),
            },
        )
        await tables.upsert(
            FILE_ORG_GRANTS_TABLE,
            stable_id(target_id, "file-org-grant", target_id),
            {"organization_id": target_id, "path_prefix": target_id},
        )
        resolved.append((source_id, target_id))
    if target_filter - seen_targets:
        raise UserError("One or more selected Bifrost organizations have no IT Glue Integration mapping")
    if not resolved:
        raise UserError("The IT Glue Integration has no mapped Bifrost organizations")
    return resolved


async def _cleanup_repointed_organization_mapping(
    target_org_id: str, current_source_org_id: str
) -> None:
    """Retire a former IT Glue organization mapping before accepting its replacement.

    A target organization has deterministic destination IDs that do not include
    the IT Glue organization ID.  Repointing its Integration mapping therefore
    has to remove every mapped, IT Glue-owned destination from the prior source
    before a new source can begin writing those IDs.  The old organization map
    remains until its resources are gone, making a failed cleanup safe to
    retry: a later run discovers exactly the remaining old source state.
    """
    while True:
        organization_maps = await tables.query(
            MAP_TABLE,
            where={"organization_id": target_org_id, "resource_type": "organization"},
            limit=100,
        )
        organization_map = next(
            (
                row for row in organization_maps.documents
                if str(_data(row).get("source_organization_id") or "") != current_source_org_id
            ),
            None,
        )
        if organization_map is None:
            return
        organization_data = _data(organization_map)
        old_source_org_id = str(organization_data.get("source_organization_id") or "")
        if not old_source_org_id:
            raise UserError("Refusing to clean an invalid prior IT Glue organization mapping")
        if (
            str(organization_data.get("organization_id") or "") != target_org_id
            or str(organization_data.get("resource_type") or "") != "organization"
            or str(organization_data.get("source_id") or "") != old_source_org_id
            or str(organization_data.get("destination_id") or "") != target_org_id
        ):
            raise UserError("Refusing to clean an invalid prior IT Glue organization mapping")

        while True:
            resource_maps = await tables.query(
                MAP_TABLE,
                where={
                    "organization_id": target_org_id,
                    "source_organization_id": old_source_org_id,
                },
                limit=100,
            )
            resource_map = next(
                (
                    row for row in resource_maps.documents
                    if str(_data(row).get("resource_type") or "") != "organization"
                ),
                None,
            )
            if resource_map is None:
                break
            resource_data = _data(resource_map)
            resource_type = str(resource_data.get("resource_type") or "")
            if (
                str(resource_data.get("organization_id") or "") != target_org_id
                or str(resource_data.get("source_organization_id") or "") != old_source_org_id
            ):
                raise UserError("Refusing to clean an unmatched IT Glue source mapping")
            spec = next((item for item in RESOURCE_SPECS if item.name == resource_type), None)
            source_id = str(resource_data.get("source_id") or "")
            destination_id = str(resource_data.get("destination_id") or "")
            if (
                spec is None
                or not source_id
                or not destination_id
                or str(resource_map.id) != source_map_id(target_org_id, resource_type, source_id)
            ):
                raise UserError("Refusing to clean an invalid prior IT Glue resource mapping")
            await _delete_owned_resource(target_org_id, spec, source_id, destination_id)
        await tables.delete_document(MAP_TABLE, str(organization_map.id))


async def _hydrate_resource(
    client: ITGlueClient,
    spec: ResourceSpec,
    source: dict[str, Any],
    *,
    source_org_id: str | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    source_id = resource_id(source)
    included: list[dict[str, Any]] = []
    images: list[dict[str, Any]] = []
    data = source
    if spec.name == "flexible_asset_types":
        fields: list[dict[str, Any]] = []
        async for page in client.iter_pages(
            f"/flexible_asset_types/{source_id}/relationships/flexible_asset_fields"
        ):
            fields.extend(page.records)
        source = dict(source)
        source["_fields"] = fields
        return source, [], []

    params: dict[str, Any] = {}
    if spec.include:
        params["include"] = spec.include
    detail_org_id = str(attr(attributes(source), "organization_id", default="") or source_org_id or "")
    try:
        detail_path = source_detail_path(spec, source_id, detail_org_id)
    except ValueError as exc:
        raise ITGlueError("IT Glue folder detail cannot be fetched without an organization") from exc
    detail = await client.get_document(detail_path, params=params)
    if isinstance(detail.get("data"), dict):
        data = detail["data"]
    if isinstance(detail.get("included"), list):
        included = detail["included"]
    if spec.name == "documents":
        sections: list[dict[str, Any]] = []
        async for page in client.iter_pages(
            f"/documents/{source_id}/relationships/sections", params={"sort": "id"}
        ):
            sections.extend(page.records)
        data = dict(data)
        data["_sections"] = sections
        seen_image_ids: set[str] = set()
        for section in sections:
            section_attrs = attributes(section)
            for image in section_attrs.get("document_images") or []:
                if isinstance(image, dict) and image.get("id") is not None:
                    image_id = str(image["id"])
                    if image_id not in seen_image_ids:
                        seen_image_ids.add(image_id)
                        images.append(image)
            content = str(section_attrs.get("content") or "")
            for image_id in re.findall(r"/developer/images/(\d+)", content):
                if image_id in seen_image_ids:
                    continue
                seen_image_ids.add(image_id)
                try:
                    image_doc = await client.get_document(f"/document_images/{image_id}")
                except ITGlueError as exc:
                    if exc.status_code != 404:
                        raise
                    # Keep the referenced child in the reconciliation set so
                    # its failure cannot discard otherwise usable document
                    # content or prune an existing copy. Transfer records the
                    # unavailable source explicitly after the parent upsert.
                    images.append({
                        "id": image_id,
                        "type": "document_images",
                        "_source_missing": True,
                        "attributes": {},
                    })
                    continue
                if isinstance(image_doc.get("data"), dict):
                    images.append(image_doc["data"])
        # Legacy inline image routes have no supported document_images relationship.
        # Only add a child when one section proves the exact source org/document root
        # route, or retain the exact root identity as a missing child for retry visibility.
        if source_org_id:
            for image in await _legacy_inline_images(
                client,
                sections,
                str(source_org_id),
                source_id,
                attr(attributes(data), "updated_at"),
            ):
                image_id = resource_id(image)
                if image_id not in seen_image_ids:
                    seen_image_ids.add(image_id)
                    images.append(image)
    return data, included, images


_IMAGE_ATTRIBUTE = re.compile(
    r"(?P<prefix><img\b[^>]*?\b(?:src|data-src)\s*=\s*)(?P<quote>[\"'])(?P<value>.*?)(?P=quote)",
    re.IGNORECASE | re.DOTALL,
)
_DEVELOPER_IMAGE_PATH = re.compile(r"/developer/images/([^/?#]+)(?:[/?#]|$)", re.IGNORECASE)
_LEGACY_INLINE_ROOT_PATH = re.compile(
    r"^/(?P<organization>\d+)/docs/(?P<document>\d+)/images/(?P<image>\d+)$"
)


def _canonical_legacy_image_id(value: str) -> str | None:
    """Match positive numeric legacy IDs while treating leading-zero forms as one ID."""
    if not value.isdecimal():
        return None
    canonical = value.lstrip("0")
    return canonical or None


def _legacy_inline_root_path(value: str, source_org_id: str) -> tuple[str, str, str] | None:
    """Return a same-org legacy root route, allowing only trusted absolute IT Glue links."""
    parsed = urlparse(html_unescape(value))
    host = (parsed.hostname or "").casefold()
    try:
        port = parsed.port
    except ValueError:
        return None
    absolute = bool(parsed.scheme or parsed.netloc)
    if parsed.params or parsed.query or parsed.fragment or parsed.username or parsed.password or port:
        return None
    if absolute and (parsed.scheme != "https" or not host.endswith(".itglue.com")):
        return None
    if not absolute and (parsed.scheme or parsed.netloc):
        return None
    match = _LEGACY_INLINE_ROOT_PATH.fullmatch(parsed.path)
    if match is None:
        return None
    if (
        match.group("organization") != source_org_id
    ):
        return None
    image_id = _canonical_legacy_image_id(match.group("image"))
    return (match.group("document"), image_id, parsed.path) if image_id is not None else None


async def _legacy_owner_is_unrestricted(client: ITGlueClient, source_org_id: str, owner_id: str) -> bool:
    """Fail closed unless the referenced source document and bounded folder chain are unrestricted."""
    try:
        payload = await client.get_document(f"/documents/{owner_id}")
        document = payload.get("data")
        if not isinstance(document, dict) or resource_id(document) != owner_id:
            return False
        attrs = attributes(document)
        if attr(attrs, "restricted") is not False or str(attr(attrs, "organization_id", default="")) != source_org_id:
            return False
        folder_id = attr(attrs, "document_folder_id", "folder_id")
        seen: set[str] = set()
        while folder_id not in (None, "", 0, "0"):
            current = str(folder_id)
            if current in seen or len(seen) >= 100:
                return False
            seen.add(current)
            payload = await client.get_document(source_detail_path(_DOCUMENT_FOLDER_SPEC, current, source_org_id))
            folder = payload.get("data")
            if not isinstance(folder, dict) or resource_id(folder) != current:
                return False
            folder_attrs = attributes(folder)
            if attr(folder_attrs, "restricted") is not False or str(attr(folder_attrs, "organization_id", default="")) != source_org_id:
                return False
            folder_id = attr(folder_attrs, "parent_id")
    except Exception:
        return False
    return True


def _legacy_rendered_s3_image_id(value: str) -> str | None:
    """Recognize the historic IT Glue S3 image path without accepting arbitrary URLs."""
    parsed = urlparse(html_unescape(value))
    host = (parsed.hostname or "").casefold()
    try:
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme != "https"
        or not host
        or not host.endswith(".amazonaws.com")
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
    ):
        return None
    segments = [segment for segment in parsed.path.split("/") if segment]
    numeric = [segment for segment in segments if segment.isdecimal()]
    for index in range(len(segments) - 5):
        if (
            segments[index : index + 2] == ["images", "images"]
            and all(segment.isdecimal() for segment in segments[index + 2 : index + 5])
            and segments[index + 5] == "original"
            and numeric == segments[index + 2 : index + 5]
        ):
            return _canonical_legacy_image_id("".join(segments[index + 2 : index + 5]))
    return None


def _legacy_image_file_details(source_url: str, image_id: str) -> tuple[str, str]:
    """Derive safe transfer metadata from a verified legacy source path."""
    basename = urlparse(source_url).path.rsplit("/", 1)[-1]
    file_name = safe_file_name(basename or f"legacy-image-{image_id}")
    return file_name, mimetypes.guess_type(file_name)[0] or "application/octet-stream"


async def _legacy_inline_images(
    client: ITGlueClient,
    sections: list[dict[str, Any]],
    source_org_id: str,
    source_document_id: str,
    source_updated_at: Any,
) -> list[dict[str, Any]]:
    """Build children only where source sections prove an exact legacy root/S3 pair."""
    candidates: dict[tuple[str, str], dict[str, Any]] = {}
    owner_proofs: dict[str, bool] = {}

    def missing_child(
        owner_id: str, image_id: str, alias: str, updated_at: Any, *, owner_valid: bool
    ) -> dict[str, Any]:
        return {
            "id": f"legacy-image:{source_document_id}:{image_id}",
            "type": "document_images",
            "_source_missing": True,
            "attributes": {
                "legacy-image-aliases": [alias],
                "legacy-image-owner-document-id": owner_id,
                "legacy-image-owner-validated": owner_valid,
                "updated-at": updated_at,
            },
        }

    for section in sections:
        section_attrs = attributes(section)
        section_updated_at = attr(section_attrs, "updated_at", default=source_updated_at)
        root_paths: dict[tuple[str, str], set[str]] = {}
        for match in _IMAGE_ATTRIBUTE.finditer(
            str(attr(section_attrs, "content", default="") or "")
        ):
            root = _legacy_inline_root_path(match.group("value"), source_org_id)
            if root is not None:
                root_paths.setdefault((root[0], root[1]), set()).add(root[2])
        rendered_urls: dict[str, set[str]] = {}
        for match in _IMAGE_ATTRIBUTE.finditer(
            str(attr(section_attrs, "rendered_content", default="") or "")
        ):
            source_url = html_unescape(match.group("value"))
            image_id = _legacy_rendered_s3_image_id(source_url)
            if image_id is not None:
                rendered_urls.setdefault(image_id, set()).add(source_url)
        for (owner_id, image_id), aliases in root_paths.items():
            # One identity has one canonical root path. Do not manufacture a child from
            # a malformed section that offers alternatives for that same identity.
            if len(aliases) != 1:
                continue
            alias = next(iter(aliases))
            if owner_id == source_document_id:
                owner_valid = True
            else:
                if owner_id not in owner_proofs:
                    owner_proofs[owner_id] = await _legacy_owner_is_unrestricted(
                        client, source_org_id, owner_id
                    )
                owner_valid = owner_proofs[owner_id]
            key = (owner_id, image_id)
            evidence = candidates.setdefault(
                key,
                {
                    "aliases": set(),
                    "owner-valid": owner_valid,
                    "updated-at": [],
                    "source-urls": set(),
                    "ambiguous": False,
                },
            )
            evidence["aliases"].add(alias)
            evidence["updated-at"].append(section_updated_at)
            # A newly failed owner proof must never be outweighed by a prior match.
            evidence["owner-valid"] = bool(evidence["owner-valid"]) and owner_valid
            source_urls = rendered_urls.get(image_id, set())
            if len(source_urls) == 1:
                evidence["source-urls"].update(source_urls)
            elif len(source_urls) > 1:
                # Multiple independently possible S3 sources remain ambiguous even if
                # another section later supplies a unique URL.
                evidence["ambiguous"] = True

    children: list[dict[str, Any]] = []
    for (owner_id, image_id), evidence in candidates.items():
        aliases = evidence["aliases"]
        alias = min(aliases)
        updated_at = max(evidence["updated-at"], key=lambda value: str(value))
        source_urls = evidence["source-urls"]
        owner_valid = bool(evidence["owner-valid"])
        if (
            not owner_valid
            or len(aliases) != 1
            or evidence["ambiguous"]
            or len(source_urls) != 1
        ):
            children.append(
                missing_child(owner_id, image_id, alias, updated_at, owner_valid=owner_valid)
            )
            continue
        source_url = next(iter(source_urls))
        file_name, content_type = _legacy_image_file_details(source_url, image_id)
        children.append(
            {
                "id": f"legacy-image:{source_document_id}:{image_id}",
                "type": "document_images",
                "attributes": {
                    # This alias is an exact path without a query or host. It is safe to retain
                    # with metadata and is never used as a source download URL.
                    "legacy-image-aliases": [alias],
                    "legacy-image-owner-document-id": owner_id,
                    "legacy-image-owner-validated": True,
                    "updated-at": updated_at,
                    "original-src": source_url,
                    "attachment-file-name": file_name,
                    "attachment-content-type": content_type,
                },
            }
        )
    return children


def _legacy_inline_alias(value: Any, expected_owner_id: str, expected_image_id: str) -> str | None:
    """Accept only the no-query legacy alias grammar emitted by hydration."""
    if not isinstance(value, str):
        return None
    parsed = urlparse(value)
    if (
        parsed.scheme
        or parsed.netloc
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        return None
    match = _LEGACY_INLINE_ROOT_PATH.fullmatch(parsed.path)
    if (
        match is None
        or match.group("document") != expected_owner_id
        or _canonical_legacy_image_id(match.group("image")) != expected_image_id
    ):
        return None
    return parsed.path


def _legacy_html_alias(value: str) -> str | None:
    """Return an approved relative alias from source HTML, including trusted IT Glue absolute links."""
    parsed = urlparse(html_unescape(value))
    host = (parsed.hostname or "").casefold()
    try:
        port = parsed.port
    except ValueError:
        return None
    if parsed.params or parsed.query or parsed.fragment or parsed.username or parsed.password or port:
        return None
    if (parsed.scheme or parsed.netloc) and (parsed.scheme != "https" or not host.endswith(".itglue.com")):
        return None
    return parsed.path if _LEGACY_INLINE_ROOT_PATH.fullmatch(parsed.path) else None



def _document_source_presentation(source: Mapping[str, Any]) -> tuple[str | None, str | None]:
    """Return source HTML without changing it; used to protect local document edits."""
    attrs = attributes(source)
    sections = source.get("_sections") or []
    section_attrs = [attributes(item) for item in sections if isinstance(item, Mapping)]
    raw_content = "\n".join(str(attr(item, "content", default="") or "") for item in section_attrs)
    rendered = "\n".join(str(attr(item, "rendered_content", default="") or "") for item in section_attrs)
    return raw_content or attr(attrs, "content"), rendered or attr(attrs, "rendered_content")


def _managed_document_image_refs(
    images: list[dict[str, Any]] | None, target_org_id: str
) -> tuple[dict[str, str], dict[str, str]]:
    """Map only hydrated image identifiers and original URLs to managed attachment refs."""
    by_id: dict[str, str] = {}
    by_url: dict[str, str] = {}
    for image in images or []:
        try:
            image_id = resource_id(image)
        except ITGlueError:
            # A malformed relationship cannot authorize rewriting arbitrary HTML.
            continue
        reference = f"bifrost-attachment:{stable_id(target_org_id, 'document_image', image_id)}"
        by_id[image_id] = reference
        original_src = attr(attributes(image), "original_src")
        if isinstance(original_src, str) and original_src.strip():
            by_url[html_unescape(original_src.strip())] = reference
        if image_id.startswith("legacy-image:"):
            parts = image_id.split(":", 2)
            if len(parts) != 3:
                continue
            _prefix, _current_document_id, expected_image_id = parts
            expected_owner_id = str(attr(attributes(image), "legacy_image_owner_document_id", default="") or "")
            aliases = attr(attributes(image), "legacy_image_aliases", default=[])
            if attr(attributes(image), "legacy_image_owner_validated", default=False) is True and expected_owner_id and isinstance(aliases, list):
                for value in aliases:
                    alias = _legacy_inline_alias(
                        value, expected_owner_id, expected_image_id
                    )
                    if alias is not None:
                        by_url[alias] = reference
    return by_id, by_url


def normalize_document_image_references(
    content: str | None, images: list[dict[str, Any]] | None, target_org_id: str
) -> str | None:
    """Rewrite known <img src/data-src> values while preserving all other HTML verbatim."""
    if not isinstance(content, str) or not content:
        return content
    by_id, by_url = _managed_document_image_refs(images, target_org_id)
    if not by_id and not by_url:
        return content

    def replace(match: re.Match[str]) -> str:
        source_value = html_unescape(match.group("value"))
        reference = by_url.get(source_value)
        if reference is None:
            alias = _legacy_html_alias(source_value)
            if alias is not None:
                reference = by_url.get(alias)
        if reference is None:
            path = _DEVELOPER_IMAGE_PATH.search(source_value)
            if path:
                reference = by_id.get(path.group(1))
        if reference is None:
            return match.group(0)
        return f"{match.group('prefix')}{match.group('quote')}{reference}{match.group('quote')}"

    return _IMAGE_ATTRIBUTE.sub(replace, content)


def _document_presentation(
    source: Mapping[str, Any], target_org_id: str, images: list[dict[str, Any]] | None
) -> tuple[str | None, str | None]:
    content, rendered = _document_source_presentation(source)
    by_id, _by_url = _managed_document_image_refs(images, target_org_id)
    content_sections: list[str] = []
    rendered_sections: list[str] = []
    added_image_section = False
    for section in source.get("_sections") or []:
        if not isinstance(section, Mapping):
            continue
        section_attrs = attributes(section)
        section_content = str(attr(section_attrs, "content", default="") or "")
        section_rendered = str(attr(section_attrs, "rendered_content", default="") or "")
        # Image-only sections expose structured children instead of HTML. Keep
        # their original position, using only images from current hydration.
        if not section_content.strip() and not section_rendered.strip():
            image_tags: list[str] = []
            seen_ids: set[str] = set()
            section_images = attr(section_attrs, "document_images", default=[])
            for image in section_images if isinstance(section_images, list) else []:
                if not isinstance(image, Mapping):
                    continue
                try:
                    image_id = resource_id(image)
                except ITGlueError:
                    continue
                reference = by_id.get(image_id)
                if reference is None or image_id in seen_ids:
                    continue
                seen_ids.add(image_id)
                alt = str(attr(attributes(image), "alt_text", "attachment_file_name", "name", default="Document image") or "Document image")
                image_tags.append(f'<img src="{reference}" alt="{html_escape(alt, quote=True)}">')
            if image_tags:
                section_content = section_rendered = "\n".join(image_tags)
                added_image_section = True
        content_sections.append(section_content)
        rendered_sections.append(section_rendered)
    if added_image_section:
        content = "\n".join(content_sections)
        rendered = "\n".join(rendered_sections)
    return (
        normalize_document_image_references(content, images, target_org_id),
        normalize_document_image_references(rendered, images, target_org_id),
    )


async def _backfill_document_image_references(
    target_org_id: str,
    destination_id: str,
    destination_data: Mapping[str, Any],
    hydrated: Mapping[str, Any],
    images: list[dict[str, Any]],
) -> None:
    """Repair legacy source image links only if a local user has not edited the presentation."""
    raw_source = destination_data.get("raw")
    if not isinstance(raw_source, Mapping):
        return
    raw_content, raw_rendered = _document_source_presentation(raw_source)
    stored_presentation = (destination_data.get("content"), destination_data.get("rendered_content"))
    managed_baseline = (
        normalize_document_image_references(raw_content, images, target_org_id),
        normalize_document_image_references(raw_rendered, images, target_org_id),
    )
    if stored_presentation not in ((raw_content, raw_rendered), managed_baseline):
        return
    content, rendered = _document_presentation(hydrated, target_org_id, images)
    updates = {
        key: value for key, value in {
            "content": content,
            "rendered_content": rendered,
        }.items() if destination_data.get(key) != value
    }
    if updates:
        await tables.update("docs-documents", destination_id, updates)


def _domain_row(
    spec: ResourceSpec,
    source: dict[str, Any],
    target_org_id: str,
    destination_id: str,
    *,
    flexible_asset_fields: list[dict[str, Any]] | None = None,
    images: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    attrs = attributes(source)
    base: dict[str, Any] = {
        "organization_id": target_org_id,
        "source_system": "itglue",
        "source_id": resource_id(source),
        "source_updated_at": attr(attrs, "updated_at"),
        "raw": scrub_secrets(source),
    }
    if spec.name in {"document_folders", "password_folders"}:
        base.update(
            name=attr(attrs, "name"),
            parent_id=_destination_folder_id(
                target_org_id, spec.name, attr(attrs, "parent_id")
            ),
            ancestor_ids=_destination_folder_ids(
                target_org_id, spec.name, attr(attrs, "ancestor_ids", default=[])
            ),
            restricted=_source_restricted(attrs),
            restriction_inferred=False,
            restriction_reason="source_restricted" if _source_restricted(attrs) else None,
        )
    elif spec.name in {"configuration_types", "configuration_statuses"}:
        # IT Glue's account-global taxonomy has no enabled lifecycle field.
        # Every mapped copy is active until its source record is removed; native
        # Bifrost taxonomy records use this same field for admin lifecycle control.
        base.update(name=attr(attrs, "name"), active=True)
    elif spec.name == "locations":
        base.update(
            is_enabled=not bool(attr(attrs, "archived", default=False)),
            name=attr(attrs, "name"), address_1=attr(attrs, "address_1"),
            address_2=attr(attrs, "address_2"), city=attr(attrs, "city"),
            region=attr(attrs, "region"), postal_code=attr(attrs, "postal_code"),
            country=attr(attrs, "country"), phone=attr(attrs, "phone"), notes=attr(attrs, "notes"),
            archived=bool(attr(attrs, "archived", default=False)),
        )
    elif spec.name == "configurations":
        included = source.get("_included") or []
        interfaces = [item for item in included if str(item.get("type", "")).replace("-", "_") == "configuration_interfaces"]
        base.update(
            is_enabled=not bool(attr(attrs, "archived", default=False)),
            name=attr(attrs, "name"), hostname=attr(attrs, "hostname"),
            asset_tag=attr(attrs, "asset_tag"), ip_address=attr(attrs, "primary_ip", "ip_address"),
            primary_ip=attr(attrs, "primary_ip", "ip_address"), mac_address=attr(attrs, "mac_address"),
            notes=attr(attrs, "notes"),
            serial_number=attr(attrs, "serial_number"), manufacturer_name=attr(attrs, "manufacturer_name"),
            model_name=attr(attrs, "model_name"), configuration_type_name=attr(attrs, "configuration_type_name"),
            configuration_status_name=attr(attrs, "configuration_status_name"), interfaces=scrub_secrets(interfaces),
            archived=bool(attr(attrs, "archived", default=False)),
        )
    elif spec.name == "documents":
        content, rendered_content = _document_presentation(source, target_org_id, images)
        base.update(
            name=attr(attrs, "name"), source_url=attr(attrs, "resource_url"),
            folder_id=_destination_folder_id(
                target_org_id, "document_folders", attr(attrs, "document_folder_id", "folder_id")
            ),
            content=content, rendered_content=rendered_content,
            archived=bool(attr(attrs, "archived", default=False)),
            restricted=_source_restricted(attrs),
            restriction_inferred=False,
            restriction_reason="source_restricted" if _source_restricted(attrs) else None,
        )
    elif spec.name == "flexible_asset_types":
        base.update(
            name=attr(attrs, "name"), icon=attr(attrs, "icon"),
            fields=scrub_secrets(source.get("_fields") or []),
        )
    elif spec.name == "flexible_assets":
        traits = attr(attrs, "traits", default={})
        source_type_id = str(attr(attrs, "flexible_asset_type_id", default="") or "")
        safe_traits, secret_fields = project_flexible_asset_traits(
            traits,
            flexible_asset_fields or [],
            source.get("_included") if isinstance(source.get("_included"), list) else [],
            resource_id(source),
        )
        protected_source = redact_named_fields(source, secret_fields)
        base["raw"] = scrub_secrets(protected_source)
        base.update(
            is_enabled=not bool(attr(attrs, "archived", default=False)),
            flexible_asset_type_id=(
                stable_id(target_org_id, "flexible_asset_types", source_type_id)
                if source_type_id else ""
            ),
            name=attr(attrs, "name"),
            traits=scrub_secrets(safe_traits),
            secret_fields=secret_fields,
            archived=bool(attr(attrs, "archived", default=False)),
            restricted=bool(attr(attrs, "restricted", default=False)),
            **{name: None for name in SECRET_COLUMNS},
        )
    elif spec.name == "passwords":
        base["raw"] = None
        base.update(
            name=attr(attrs, "name"), source_url=attr(attrs, "resource_url"),
            username=attr(attrs, "username"), url=attr(attrs, "url"),
            notes=None, folder_id=_destination_folder_id(
                target_org_id, "password_folders", attr(attrs, "password_folder_id")
            ),
            category_name=attr(attrs, "password_category_name"), resource_type=attr(attrs, "resource_type"),
            resource_id=str(attr(attrs, "resource_id", default="") or ""),
            restricted=_source_restricted(attrs),
            restriction_inferred=False,
            restriction_reason="source_restricted" if _source_restricted(attrs) else None,
            archived=bool(attr(attrs, "archived", default=False)),
            has_password=bool(attr(attrs, "has_password", default=False)),
            has_totp=bool(attr(attrs, "has_totp", default=False)),
            **{name: None for name in SECRET_COLUMNS},
        )
    else:
        base["destination_id"] = destination_id
    return base


def _attachment_storage_path(
    target_org_id: str,
    parent_type: str,
    parent_destination_id: str,
    destination_id: str,
    file_name: str,
    item: Mapping[str, Any],
) -> str:
    """Give each source projection an immutable managed-file object key.

    A presigned PUT cannot be rolled back. Versioning the path means a failed
    replacement leaves both the existing attachment row and its readable
    object intact until the new bytes have been finalized.
    """
    source_version = hashlib.sha256(
        canonical_source_fingerprint(item).encode("utf-8")
    ).hexdigest()[:20]
    return (
        f"{target_org_id}/itglue/{parent_type}/{parent_destination_id}/"
        f"{destination_id}/v-{source_version}/{file_name}"
    )


def _included_of_type(included: list[dict[str, Any]], wanted: str) -> list[dict[str, Any]]:
    normalized = wanted.replace("-", "_")
    return [
        item for item in included
        if str(item.get("type", "")).replace("-", "_") == normalized
    ]


def _safe_child_error_message(exc: ITGlueError) -> str:
    """Keep child diagnostics useful without retaining signed source URLs."""
    return re.sub(r"https?://[^\s]+", "[REDACTED_URL]", str(exc))[:500]


class ChildTransferError(ITGlueError):
    """A retryable parent error that retains the source classification of child failures."""

    def __init__(self, failures: list[tuple[str, ITGlueError]]) -> None:
        if not failures:
            raise ValueError("ChildTransferError requires at least one failure")
        self.failures = tuple(failures)
        # Prefer a throttling/server failure when present so the migration item
        # retains the retry classification instead of flattening it to this wrapper.
        primary = next(
            (error for _, error in failures if error.status_code == 429 or (error.status_code is not None and 500 <= error.status_code < 600)),
            failures[0][1],
        )
        details = "; ".join(
            f"{source_id}: {_safe_child_error_message(error)}" for source_id, error in failures
        )
        super().__init__(f"Child file transfer failed for {details}", status_code=primary.status_code)
        self.primary_error = primary


def _is_legacy_content_integrity_failure(exc: ITGlueError) -> bool:
    """A stale legacy blob is unsafe only when the source body is demonstrably malformed."""
    message = str(exc).lower()
    return "unexpected html" in message or "body disagrees with its response headers" in message


async def _quarantine_legacy_attachment(
    prior_data: Mapping[str, Any],
    destination_id: str,
    target_org_id: str,
    parent_type: str,
    parent_destination_id: str,
    item_id: str,
    file_kind: str,
    exc: ITGlueError,
) -> None:
    """Retain a legacy row for diagnosis while preventing an unverified blob from download."""
    if not prior_data or prior_data.get("transfer_version") == TRANSFER_VERSION:
        return
    await tables.upsert(
        ATTACHMENTS_TABLE,
        destination_id,
        {
            **prior_data,
            "organization_id": target_org_id,
            "source_system": "itglue",
            "source_id": item_id,
            "parent_type": parent_type,
            "parent_id": parent_destination_id,
            "file_kind": file_kind,
            "quarantined": True,
            "integrity_error": _safe_child_error_message(exc),
        },
    )


async def _transfer_file(
    client: ITGlueClient,
    target_org_id: str,
    parent_type: str,
    parent_destination_id: str,
    item: dict[str, Any],
    *,
    file_kind: str,
    restricted: bool = False,
) -> None:
    item_id = resource_id(item)
    if item.get("_source_missing") is True:
        raise ITGlueError(
            f"{file_kind} {item_id} metadata is unavailable from IT Glue",
            status_code=404,
        )
    attrs = attributes(item)
    source_url = attr(attrs, "download_url", "original_src")
    if not source_url:
        raise ITGlueError(f"{file_kind} {item_id} has no download URL")
    file_name = safe_file_name(str(attr(attrs, "attachment_file_name", "name", default=item_id)))
    content_type = str(attr(attrs, "attachment_content_type", "content_type", default="application/octet-stream"))
    try:
        size_bytes = int(attr(attrs, "attachment_file_size", "size"))
    except (TypeError, ValueError):
        size_bytes = None
    destination_id = stable_id(target_org_id, file_kind, item_id)
    location = (
        "docs-restricted-content" if file_kind == "document_image" else "docs-restricted-attachments"
    ) if restricted else (
        "docs-content" if file_kind == "document_image" else "docs-attachments"
    )
    path = _attachment_storage_path(
        target_org_id, parent_type, parent_destination_id, destination_id, file_name, item
    )
    prior = await tables.get(ATTACHMENTS_TABLE, destination_id)
    prior_data = _data(prior)
    source_updated_at = attr(attrs, "updated_at")
    if (
        prior_data.get("storage_path") == path
        and (str(prior_data.get("source_updated_at")) == str(source_updated_at))
        and prior_data.get("transfer_version") == TRANSFER_VERSION
        and prior_data.get("metadata_registered") is True
        and isinstance(prior_data.get("sha256"), str)
        and bool(re.fullmatch(r"[0-9a-fA-F]{64}", str(prior_data.get("sha256"))))
        and not bool(prior_data.get("quarantined"))
        and not prior_data.get("integrity_error")
        and await files.exists(path, location=location, scope=target_org_id)
    ):
        return
    signed = await files.get_signed_url(
        path,
        method="PUT",
        content_type=content_type,
        location=location,
        scope=target_org_id,
    )
    signed_url = signed.get("url") if isinstance(signed, dict) else getattr(signed, "url", signed)
    if not signed_url:
        raise ITGlueError("Bifrost did not return a destination upload URL")
    destination_url = _absolute_platform_url(signed_url)
    try:
        transferred, sha256, size_verified = await _streamed_transfer(
            client, str(source_url), str(destination_url),
            content_type=content_type, size_bytes=size_bytes,
            file_kind=file_kind, item_id=item_id,
        )
    except ITGlueError as exc:
        if _is_legacy_content_integrity_failure(exc):
            await _quarantine_legacy_attachment(
                prior_data, destination_id, target_org_id, parent_type,
                parent_destination_id, item_id, file_kind, exc,
            )
        raise
    if transferred < 0:
        raise ITGlueError(f"{file_kind} {item_id} reported an invalid transferred size")
    if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", sha256):
        raise ITGlueError(f"{file_kind} {item_id} did not produce a valid SHA-256 digest")
    await complete_signed_upload(
        path=path,
        location=location,
        scope=target_org_id,
        content_type=content_type,
        size_bytes=transferred,
        sha256=sha256,
    )
    old_path = prior_data.get("storage_path")
    old_location = prior_data.get("storage_location")
    if old_path and old_location and (old_path != path or old_location != location):
        stat = await files.stat(str(old_path), location=str(old_location), scope=target_org_id)
        if stat.get("exists"):
            await files.delete(
                str(old_path), location=str(old_location), scope=target_org_id,
                expected_version=stat.get("version"),
            )
    await tables.upsert(
        ATTACHMENTS_TABLE,
        destination_id,
        {
            "organization_id": target_org_id,
            "source_system": "itglue",
            "source_id": item_id,
            "parent_type": parent_type,
            "parent_id": parent_destination_id,
            "file_kind": file_kind,
            "restricted": restricted,
            "file_name": file_name,
            "content_type": content_type,
            "size_bytes": transferred,
            "declared_size_bytes": size_bytes,
            "size_verified": size_verified,
            "transfer_version": TRANSFER_VERSION,
            "metadata_registered": True,
            "storage_location": location,
            "storage_path": path,
            "source_updated_at": source_updated_at,
            "sha256": sha256,
            "quarantined": False,
            "integrity_error": None,
            "raw": scrub_secrets(item),
        },
    )


async def _streamed_transfer(
    client: ITGlueClient,
    source_url: str,
    destination_url: str,
    *,
    content_type: str,
    size_bytes: int | None,
    file_kind: str,
    item_id: str,
) -> tuple[int, str, bool]:
    """Call the streaming transfer with file context on failures."""
    try:
        return await client.stream_to_signed_url(
            source_url, destination_url, content_type=content_type, size_bytes=size_bytes
        )
    except ITGlueError:
        raise
    except Exception as exc:
        raise ITGlueError(
            f"[xfer-v7] {file_kind} {item_id} transfer failed "
            f"(metadata_bytes={size_bytes}, content_type={content_type}, "
            f"cause={type(exc).__name__})"
        ) from exc


def _related_target_spec(resource_type: str) -> ResourceSpec | None:
    """Return a supported related-item target without widening the resource surface."""
    return next((spec for spec in RESOURCE_SPECS if spec.name == resource_type), None)


async def _current_related_target_mappings() -> dict[str, list[str]]:
    """Read the current, non-secret IT Glue organization mapping authority."""
    mappings = await integrations.list_mappings("IT Glue", scope="global")
    if mappings is None:
        return {}
    current: dict[str, list[str]] = {}
    for mapping in mappings:
        target_org_id = str(_value(mapping, "organization_id", default="") or "")
        source_org_id = str(_value(mapping, "entity_id", default="") or "")
        if target_org_id and source_org_id:
            current.setdefault(target_org_id, []).append(source_org_id)
    return current


async def _verified_related_target_destination(
    map_row: Any,
    *,
    parent_target_org_id: str,
    parent_source_org_id: str,
    target_type: str,
    target_source_id: str,
    current_mappings: dict[str, list[str]],
) -> str | None:
    """Accept only a canonical, current map whose target is still IT Glue-owned."""
    map_data = _data(map_row)
    target_org_id = str(map_data.get("organization_id") or "")
    source_org_id = str(map_data.get("source_organization_id") or "")
    destination_id = str(map_data.get("destination_id") or "")
    target_spec = _related_target_spec(target_type)
    if (
        target_spec is None
        or not target_org_id
        or not source_org_id
        or not destination_id
        or str(_value(map_row, "id", default="") or "")
            != source_map_id(target_org_id, target_type, target_source_id)
        or str(map_data.get("resource_type") or "") != target_type
        or str(map_data.get("source_id") or "") != target_source_id
        or destination_id != stable_id(target_org_id, target_type, target_source_id)
        or (target_org_id == parent_target_org_id and source_org_id != parent_source_org_id)
    ):
        return None
    mapped_source_org_ids = current_mappings.get(target_org_id, [])
    if len(mapped_source_org_ids) != 1 or mapped_source_org_ids[0] != source_org_id:
        return None
    destination = await tables.get(target_spec.table, destination_id)
    if not _is_source_owned_destination(_data(destination), target_org_id, target_source_id):
        return None
    return destination_id


async def _resolve_related_target_destination(
    target_org_id: str,
    source_org_id: str | None,
    target_type: str | None,
    target_source_id: str,
    integration_mapping_cache: dict[str, dict[str, list[str]]],
) -> str | None:
    """Resolve a related target without turning a stale map into a foreign link."""
    if not target_type or not target_source_id:
        return None
    same_org_destination_id = stable_id(target_org_id, target_type, target_source_id)
    if not source_org_id:
        return same_org_destination_id
    same_org_map = await tables.get(
        MAP_TABLE, source_map_id(target_org_id, target_type, target_source_id)
    )
    if same_org_map is None:
        maps = await tables.query(
            MAP_TABLE,
            where={"resource_type": target_type, "source_id": target_source_id},
            limit=2,
        )
        candidates = list(getattr(maps, "documents", []) or [])
        if not candidates:
            # The current source batch can reference a same-org target whose
            # parent has not been processed yet. Keep its deterministic ID.
            return same_org_destination_id
        if len(candidates) != 1:
            return None
        candidate = candidates[0]
    else:
        candidate = same_org_map
    if "current" not in integration_mapping_cache:
        integration_mapping_cache["current"] = await _current_related_target_mappings()
    return await _verified_related_target_destination(
        candidate,
        parent_target_org_id=target_org_id,
        parent_source_org_id=source_org_id,
        target_type=target_type,
        target_source_id=target_source_id,
        current_mappings=integration_mapping_cache["current"],
    )


async def _store_related_items(
    target_org_id: str,
    source_type: str,
    source_destination_id: str,
    related_items: list[dict[str, Any]],
    source_org_id: str | None = None,
) -> None:
    integration_mapping_cache: dict[str, dict[str, list[str]]] = {}
    for item in related_items:
        item_id = resource_id(item)
        attrs = attributes(item)
        target_source_id = str(attr(attrs, "destination_id", "resource_id", default="") or "")
        raw_target_type = str(
            attr(attrs, "destination_type", "resource_type", "asset_type", default="") or ""
        ).strip()
        target_type = canonical_related_item_resource_kind(raw_target_type)
        # Keep the source-provided type for diagnostics when Docs has no matching
        # resource table, but never manufacture a destination ID for it.
        stored_target_type = target_type or raw_target_type or str(
            attr(attrs, "resource_type_name", default="unknown") or "unknown"
        )
        await tables.upsert(
            RELATIONSHIPS_TABLE,
            stable_id(target_org_id, "related_item", item_id),
            {
                "organization_id": target_org_id,
                "source_system": "itglue",
                "source_id": item_id,
                "source_type": source_type,
                "source_destination_id": source_destination_id,
                "target_type": stored_target_type,
                "target_source_id": target_source_id,
                "target_destination_id": await _resolve_related_target_destination(
                    target_org_id,
                    source_org_id,
                    target_type,
                    target_source_id,
                    integration_mapping_cache,
                ),
                "relationship_type": attr(attrs, "relationship_type", default="related"),
                "raw": scrub_secrets(item),
            },
        )


async def _prune_owned_children(
    target_org_id: str,
    parent_type: str,
    parent_destination_id: str,
    table_name: str,
    seen_source_ids: set[str],
) -> None:
    """Remove child rows omitted by a successfully hydrated parent."""
    parent_field = "parent_id" if table_name == ATTACHMENTS_TABLE else "source_destination_id"
    type_field = "parent_type" if table_name == ATTACHMENTS_TABLE else "source_type"
    offset = 0
    while True:
        page = await tables.query(
            table_name,
            where={
                "organization_id": target_org_id,
                "source_system": "itglue",
                parent_field: parent_destination_id,
                type_field: parent_type,
            },
            limit=100,
            offset=offset,
        )
        if not page.documents:
            break
        removed = 0
        for row in page.documents:
            data = _data(row)
            if (
                data.get("source_system") != "itglue"
                or str(data.get("organization_id") or "") != target_org_id
                or str(data.get(parent_field) or "") != parent_destination_id
                or str(data.get(type_field) or "") != parent_type
            ):
                continue
            if str(data.get("source_id") or "") in seen_source_ids:
                continue
            if table_name == ATTACHMENTS_TABLE:
                path = data.get("storage_path")
                location = data.get("storage_location")
                if path and location:
                    stat = await files.stat(str(path), location=str(location), scope=target_org_id)
                    if stat.get("exists"):
                        await files.delete(
                            str(path), location=str(location), scope=target_org_id,
                            expected_version=stat.get("version"),
                        )
            await tables.delete_document(table_name, str(row.id))
            removed += 1
        offset += len(page.documents) - removed
        if len(page.documents) < 100 and removed == 0:
            break


async def _sync_resource_children(
    client: ITGlueClient,
    target_org_id: str,
    spec: ResourceSpec,
    destination_id: str,
    included: list[dict[str, Any]],
    images: list[dict[str, Any]],
    *,
    restricted: bool,
    source_org_id: str | None = None,
) -> None:
    """Synchronize source-owned file and relationship children after hydration."""
    # Password records are metadata and source links only. Their binary
    # attachments can contain protected values outside the structured-field
    # redaction contract, so never transfer them or remove historical copies
    # as a side effect of this metadata-only reconciliation.
    attachments = [] if spec.name == "passwords" else _included_of_type(included, "attachments")
    failures: list[tuple[str, ITGlueError]] = []
    for attachment in attachments:
        try:
            await _transfer_file(
                client, target_org_id, spec.name, destination_id, attachment,
                file_kind="attachment", restricted=restricted,
            )
        except ITGlueError as exc:
            failures.append((resource_id(attachment), exc))
    for image in images:
        try:
            await _transfer_file(
                client, target_org_id, spec.name, destination_id, image,
                file_kind="document_image", restricted=restricted,
            )
        except ITGlueError as exc:
            failures.append((resource_id(image), exc))
    related_items = _included_of_type(included, "related_items")
    await _store_related_items(
        target_org_id,
        spec.name,
        destination_id,
        related_items,
        source_org_id,
    )
    if spec.name != "passwords":
        await _prune_owned_children(
            target_org_id, spec.name, destination_id, ATTACHMENTS_TABLE,
            {resource_id(item) for item in [*attachments, *images]},
        )
    await _prune_owned_children(
        target_org_id, spec.name, destination_id, RELATIONSHIPS_TABLE,
        {resource_id(item) for item in related_items},
    )
    if failures:
        # Every source child is deliberately present in the seen set above,
        # including failures, so a failed replacement never prunes its last
        # verified attachment row before the next retry.
        raise ChildTransferError(failures)


async def _write_reconciliation_finding(
    run_id: str,
    source_org_id: str,
    target_org_id: str,
    resource_type: str,
    source_id: str,
    destination_id: str,
    finding_type: str,
    detail: str,
    *,
    status: str = "open",
    severity: str = "warning",
) -> None:
    finding_id = reconciliation_finding_id(
        run_id, target_org_id, resource_type, source_id, finding_type
    )
    await tables.upsert(
        FINDINGS_TABLE,
        finding_id,
        {
            "run_id": run_id,
            "organization_id": target_org_id,
            "source_organization_id": source_org_id,
            "resource_type": resource_type,
            "finding_type": finding_type,
            "source_id": source_id,
            "destination_id": destination_id,
            "severity": severity,
            "status": status,
            "detail": detail,
            "detected_at": _now(),
            "resolved_at": _now() if status == "resolved" else None,
        },
    )


async def _process_resource(
    client: ITGlueClient,
    run_id: str,
    source_org_id: str,
    target_org_id: str,
    spec: ResourceSpec,
    source: dict[str, Any],
    mode: str,
) -> str:
    source_id = resource_id(source)
    destination_id = stable_id(target_org_id, spec.name, source_id)
    item_id = migration_item_id(run_id, target_org_id, spec.name, source_id)
    existing = await tables.get(ITEMS_TABLE, item_id)
    if _data(existing).get("status") in {"succeeded", "skipped"}:
        return "skipped"
    attempts = int(_data(existing).get("attempts") or 0) + 1
    source_attrs = attributes(source)
    source_updated_at = attr(source_attrs, "updated_at")
    mapped = await tables.get(MAP_TABLE, source_map_id(target_org_id, spec.name, source_id))
    mapped_data = _data(mapped)
    # Read even without a map: a deterministic ID collision must never overwrite
    # a native Bifrost row that merely happens to use this destination ID.
    destination = await tables.get(spec.table, destination_id)
    destination_missing = bool(mapped_data) and destination is None
    flexible_asset_fields = await _flexible_asset_fields(target_org_id, source, spec)
    fingerprint_source = source
    if spec.name == "flexible_assets":
        traits = attr(source_attrs, "traits", default={})
        _, redacted_fields = project_flexible_asset_traits(
            traits, flexible_asset_fields, [], source_id
        )
        fingerprint_source = redact_named_fields(source, redacted_fields)
    source_fingerprint = canonical_source_fingerprint(fingerprint_source)
    destination_data = _data(destination)
    if destination is not None and not _is_source_owned_destination(
        destination_data, target_org_id, source_id
    ):
        await _record_skipped_item(
            run_id,
            target_org_id,
            source_org_id,
            spec.name,
            source_id,
            destination_id,
            source_updated_at,
            existing,
            "native_destination",
        )
        return "skipped"
    prehydrated: tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]] | None = None
    child_only_sync = False
    parent_unchanged = source_is_unchanged(
        source_updated_at,
        mapped_data.get("source_updated_at"),
        destination is not None,
        source_fingerprint,
        mapped_data.get("source_fingerprint"),
    )
    document_needs_child_check = (
        spec.name == "documents" and destination is not None and bool(mapped_data)
    )
    if parent_unchanged:
        await _record_unclassified_restriction(
            run_id, source_org_id, target_org_id, spec, source_id, destination_id, source, destination_data
        )
        restriction_updates = await _refresh_inferred_restriction(
            target_org_id, spec, source, destination_data
        )
        if restriction_updates:
            await tables.update(spec.table, destination_id, restriction_updates)
            destination_data = {**destination_data, **restriction_updates}
    if parent_unchanged and spec.name != "documents" and spec.include:
        # Attachments and related items have their own source lifecycle. The
        # parent list watermark cannot safely suppress their reconciliation.
        hydrated, included, images = await _hydrate_resource(
            client, spec, source, source_org_id=source_org_id
        )
        reference_updates = _unchanged_folder_reference_backfill(
            spec, hydrated, target_org_id, destination_data
        )
        if reference_updates:
            await tables.update(spec.table, destination_id, reference_updates)
        # Add newly supported columns without overwriting local edits when the
        # source watermark is unchanged. Old rows must not remain permanently
        # incomplete after expanding the projection contract.
        additions = {
            "configurations": {"asset_tag", "ip_address", "primary_ip", "mac_address", "notes", "is_enabled"},
            "locations": {"notes", "is_enabled"},
            "flexible_assets": {"is_enabled"},
        }.get(spec.name, set()) - destination_data.keys()
        if additions:
            projected = _domain_row(
                spec, hydrated, target_org_id, destination_id,
                flexible_asset_fields=flexible_asset_fields,
            )
            await tables.update(
                spec.table, destination_id,
                {key: projected.get(key) for key in additions},
            )
        prehydrated = (dict(hydrated), included, images)
        child_only_sync = True
    elif parent_unchanged or document_needs_child_check:
        if parent_unchanged:
            reference_updates = _unchanged_folder_reference_backfill(
                spec, source, target_org_id, destination_data
            )
            if reference_updates:
                await tables.update(spec.table, destination_id, reference_updates)
        if spec.name != "documents":
            await _record_skipped_item(
                run_id,
                target_org_id,
                source_org_id,
                spec.name,
                source_id,
                destination_id,
                source_updated_at,
                existing,
                "unchanged",
            )
            return "skipped"
        # The document list watermark does not cover IT Glue attachments,
        # images, or sections. Hydrate documents even when the parent is
        # unchanged, then compare only document-owned source presentation with
        # the last redacted source projection stored in ``raw``. File-only
        # changes reconcile their children without clobbering local edits.
        hydrated, included, images = await _hydrate_resource(
            client, spec, source, source_org_id=source_org_id
        )
        hydrated = dict(hydrated)
        hydrated["_included"] = included
        prior_source = destination_data.get("raw")
        if (
            isinstance(prior_source, Mapping)
            and hydrated_document_content_fingerprint(hydrated)
            == hydrated_document_content_fingerprint(prior_source)
        ):
            child_only_sync = True
            prehydrated = (hydrated, included, images)
        else:
            # A section or another document-owned field changed. Treat it as
            # an effective source update and continue through the normal
            # source-authoritative upsert path below.
            prehydrated = (hydrated, included, images)
    await tables.upsert(
        ITEMS_TABLE,
        item_id,
        {
            "run_id": run_id,
            "organization_id": target_org_id,
            "source_organization_id": source_org_id,
            "resource_type": spec.name,
            "source_id": source_id,
            "destination_id": destination_id,
            "status": "running",
            "disposition": (
                "syncing_children" if child_only_sync
                else "repairing_missing_destination" if destination_missing else "upsert"
            ),
            "attempts": attempts,
            "source_updated_at": source_updated_at,
            "started_at": _now(),
            "completed_at": None,
            "error_code": None,
            "error_message": None,
        },
    )
    try:
        if child_only_sync:
            assert prehydrated is not None
            hydrated, included, images = prehydrated
            if spec.name == "documents":
                await _backfill_document_image_references(
                    target_org_id, destination_id, destination_data, hydrated, images
                )
            await _sync_resource_children(
                client,
                target_org_id,
                spec,
                destination_id,
                included,
                images,
                restricted=bool(destination_data.get("restricted")),
                source_org_id=source_org_id,
            )
            await tables.update(
                ITEMS_TABLE,
                item_id,
                {
                    "status": "skipped",
                    "disposition": "unchanged_children_synced",
                    "completed_at": _now(),
                    "error_code": None,
                    "error_message": None,
                },
            )
            return "skipped"
        if prehydrated is None:
            hydrated, included, images = await _hydrate_resource(
                client, spec, source, source_org_id=source_org_id
            )
            hydrated = dict(hydrated)
            hydrated["_included"] = included
        else:
            hydrated, included, images = prehydrated
        hydrated_fields = await _flexible_asset_fields(target_org_id, hydrated, spec)
        domain_row = _domain_row(
            spec,
            hydrated,
            target_org_id,
            destination_id,
            flexible_asset_fields=hydrated_fields,
            images=images,
        )
        reference = _folder_reference_for_source(spec, hydrated, target_org_id)
        if (
            not domain_row.get("restricted")
            and reference is not None
            and reference[1] is not None
            and await _folder_is_restricted(target_org_id, reference[0], reference[1])
        ):
            domain_row["restricted"] = True
            domain_row["restriction_inferred"] = True
            domain_row["restriction_reason"] = "restricted_folder_ancestor"
        restricted = bool(domain_row.get("restricted"))
        await tables.upsert(spec.table, destination_id, domain_row)

        await _sync_resource_children(
            client,
            target_org_id,
            spec,
            destination_id,
            included,
            images,
            restricted=restricted,
            source_org_id=source_org_id,
        )
        if spec.name == "documents":
            from functions.indexing import sync_document_index

            await sync_document_index(target_org_id, destination_id)
        await tables.upsert(
            MAP_TABLE,
            source_map_id(target_org_id, spec.name, source_id),
            {
                "organization_id": target_org_id,
                "source_organization_id": source_org_id,
                "source_organization_name": None,
                "resource_type": spec.name,
                "source_id": source_id,
                "destination_id": destination_id,
                "source_updated_at": source_updated_at,
                "source_fingerprint": source_fingerprint,
                "migrated_at": _now(),
            },
        )
        if mode == "reconcile" and destination_missing:
            await _write_reconciliation_finding(
                run_id,
                source_org_id,
                target_org_id,
                spec.name,
                source_id,
                destination_id,
                "destination_missing",
                "Mapped destination row was missing and was recreated by reconciliation.",
                status="resolved",
            )
        await tables.update(
            ITEMS_TABLE,
            item_id,
            {
                "status": "succeeded",
                "disposition": "repaired" if destination_missing else "upserted",
                "completed_at": _now(),
                "error_code": None,
                "error_message": None,
            },
        )
        return "succeeded"
    except Exception as exc:
        code = str(getattr(exc, "status_code", None) or type(exc).__name__)
        message = str(exc)[:1000]
        await tables.update(
            ITEMS_TABLE,
            item_id,
            {"status": "failed", "completed_at": _now(), "error_code": code, "error_message": message},
        )
        if mode == "reconcile" and destination_missing:
            await _write_reconciliation_finding(
                run_id,
                source_org_id,
                target_org_id,
                spec.name,
                source_id,
                destination_id,
                "destination_missing",
                "Mapped destination row is missing and the repair upsert failed.",
            )
        return "failed"


async def _flexible_asset_fields(
    target_org_id: str, source: dict[str, Any], spec: ResourceSpec
) -> list[dict[str, Any]]:
    if spec.name != "flexible_assets":
        return []
    source_type_id = str(attr(attributes(source), "flexible_asset_type_id", default="") or "")
    if not source_type_id:
        return []
    type_row = await tables.get(
        "docs-flexible-asset-types",
        stable_id(target_org_id, "flexible_asset_types", source_type_id),
    )
    fields = _data(type_row).get("fields")
    return fields if isinstance(fields, list) else []


def _is_source_owned_destination(
    data: Mapping[str, Any], target_org_id: str, source_id: str
) -> bool:
    return (
        data.get("source_system") == "itglue"
        and str(data.get("organization_id") or "") == target_org_id
        and str(data.get("source_id") or "") == source_id
    )


async def _record_skipped_item(
    run_id: str,
    target_org_id: str,
    source_org_id: str,
    resource_type: str,
    source_id: str,
    destination_id: str,
    source_updated_at: Any,
    existing: Any,
    disposition: str,
) -> None:
    await tables.upsert(
        ITEMS_TABLE,
        migration_item_id(run_id, target_org_id, resource_type, source_id),
        {
            "run_id": run_id,
            "organization_id": target_org_id,
            "source_organization_id": source_org_id,
            "resource_type": resource_type,
            "source_id": source_id,
            "destination_id": destination_id,
            "status": "skipped",
            "disposition": disposition,
            "attempts": int(_data(existing).get("attempts") or 0),
            "source_updated_at": source_updated_at,
            "started_at": None,
            "completed_at": _now(),
            "error_code": None,
            "error_message": None,
        },
    )


async def _reconcile_resource(
    client: ITGlueClient,
    run_id: str,
    source_org_id: str,
    target_org_id: str,
    spec: ResourceSpec,
) -> dict[str, int]:
    """Remove source-owned records absent from a complete IT Glue enumeration."""
    checked = 0
    stale_source = 0
    deleted = 0
    failed = await tables.count(
        ITEMS_TABLE,
        where={
            "run_id": run_id,
            "organization_id": target_org_id,
            "resource_type": spec.name,
            "status": "failed",
        },
    )
    if failed:
        return {"mapped_checked": 0, "source_missing": 0, "deleted": 0, "deletion_deferred": failed}
    offset = 0
    while True:
        mappings = await tables.query(
            MAP_TABLE,
            where={
                "organization_id": target_org_id,
                "source_organization_id": source_org_id,
                "resource_type": spec.name,
            },
            limit=1000,
            offset=offset,
        )
        for row in mappings.documents:
            data = _data(row)
            source_id = str(data.get("source_id") or "")
            if not source_id:
                continue
            checked += 1
            seen = await tables.get(
                ITEMS_TABLE,
                migration_item_id(run_id, target_org_id, spec.name, source_id),
            )
            if seen is not None:
                continue
            stale_source += 1
            if not await _source_is_confirmed_missing(client, spec, source_id, source_org_id):
                await _write_reconciliation_finding(
                    run_id, source_org_id, target_org_id, spec.name, source_id,
                    str(data.get("destination_id") or ""), "enumeration_omission",
                    "The source record still exists but was omitted from the paginated list; deletion was skipped.",
                )
                continue
            await tables.upsert(
                ITEMS_TABLE,
                migration_item_id(run_id, target_org_id, spec.name, source_id),
                {
                    "run_id": run_id,
                    "organization_id": target_org_id,
                    "source_organization_id": source_org_id,
                    "resource_type": spec.name,
                    "source_id": source_id,
                    "destination_id": str(data.get("destination_id") or ""),
                    "status": "delete_pending",
                    "disposition": "source_missing",
                    "attempts": 0,
                    "started_at": None,
                    "completed_at": None,
                    "error_code": None,
                    "error_message": None,
                },
            )
        if len(mappings.documents) < 1000:
            break
        offset += len(mappings.documents)
    while True:
        pending = await tables.query(
            ITEMS_TABLE,
            where={
                "run_id": run_id,
                "organization_id": target_org_id,
                "resource_type": spec.name,
                "status": "delete_pending",
            },
            limit=100,
        )
        if not pending.documents:
            break
        for item in pending.documents:
            item_data = _data(item)
            source_id = str(item_data.get("source_id") or "")
            destination_id = str(item_data.get("destination_id") or "")
            try:
                if not await _source_is_confirmed_missing(client, spec, source_id, source_org_id):
                    await tables.update(
                        ITEMS_TABLE,
                        str(item.id),
                        {
                            "status": "skipped",
                            "disposition": "source_reappeared",
                            "completed_at": _now(),
                            "error_code": None,
                            "error_message": None,
                        },
                    )
                    continue
                await _delete_owned_resource(target_org_id, spec, source_id, destination_id)
                await tables.update(
                    ITEMS_TABLE,
                    str(item.id),
                    {"status": "deleted", "disposition": "source_removed", "completed_at": _now()},
                )
                deleted += 1
                await _write_audit(
                    target_org_id,
                    "migration.source_removed",
                    "Removed an IT Glue-owned record absent from the completed source enumeration",
                    entity_type=spec.name,
                    entity_id=destination_id,
                    metadata={"source_id": source_id},
                )
            except Exception as exc:
                await tables.update(
                    ITEMS_TABLE,
                    str(item.id),
                    {
                        "status": "failed",
                        "completed_at": _now(),
                        "error_code": type(exc).__name__,
                        "error_message": str(exc)[:1000],
                    },
                )
    return {"mapped_checked": checked, "source_missing": stale_source, "deleted": deleted}


async def _source_is_confirmed_missing(
    client: ITGlueClient, spec: ResourceSpec, source_id: str, source_org_id: str | None = None
) -> bool:
    """Return true only for a fresh, direct source 404 immediately before deletion."""
    try:
        try:
            path = source_detail_path(spec, source_id, source_org_id)
        except ValueError:
            return False
        await client.get_document(path)
    except ITGlueError as exc:
        if exc.status_code == 404:
            return True
        raise
    return False


async def _flexible_asset_type_source_ids(target_org_id: str) -> list[str]:
    """Read source API type identifiers; Bifrost destination IDs are not valid API filters."""
    source_ids: list[str] = []
    seen: set[str] = set()
    offset = 0
    while True:
        page = await tables.query(
            "docs-flexible-asset-types",
            where={"organization_id": target_org_id, "source_system": "itglue"},
            limit=1000,
            offset=offset,
        )
        documents = list(page.documents or [])
        for row in documents:
            source_id = str(_data(row).get("source_id") or "").strip()
            if source_id and source_id not in seen:
                seen.add(source_id)
                source_ids.append(source_id)
        if len(documents) < 1000:
            return source_ids
        offset += len(documents)


async def _delete_owned_resource(
    target_org_id: str, spec: ResourceSpec, source_id: str, destination_id: str
) -> None:
    row = await tables.get(spec.table, destination_id)
    data = _data(row)
    if row is not None and (
        data.get("source_system") != "itglue"
        or str(data.get("organization_id")) != target_org_id
        or str(data.get("source_id")) != source_id
    ):
        raise UserError("Refusing to delete a destination record not owned by this IT Glue source")
    while True:
        children = await tables.query(
            ATTACHMENTS_TABLE,
            where={
                "organization_id": target_org_id,
                "source_system": "itglue",
                "parent_type": spec.name,
                "parent_id": destination_id,
            },
            limit=100,
        )
        if not children.documents:
            break
        for child in children.documents:
            child_data = _data(child)
            path = child_data.get("storage_path")
            location = child_data.get("storage_location")
            if path and location:
                stat = await files.stat(str(path), location=str(location), scope=target_org_id)
                if stat.get("exists"):
                    await files.delete(
                        str(path), location=str(location), scope=target_org_id,
                        expected_version=stat.get("version"),
                    )
            await tables.delete_document(ATTACHMENTS_TABLE, str(child.id))
    while True:
        relationships = await tables.query(
            RELATIONSHIPS_TABLE,
            where={
                "organization_id": target_org_id,
                "source_system": "itglue",
                "source_type": spec.name,
                "source_destination_id": destination_id,
            },
            limit=100,
        )
        if not relationships.documents:
            break
        for relationship in relationships.documents:
            await tables.delete_document(RELATIONSHIPS_TABLE, str(relationship.id))
    while True:
        incoming_relationships = await tables.query(
            RELATIONSHIPS_TABLE,
            where={
                "organization_id": target_org_id,
                "source_system": "itglue",
                "target_destination_id": destination_id,
            },
            limit=100,
        )
        if not incoming_relationships.documents:
            break
        for relationship in incoming_relationships.documents:
            relationship_data = _data(relationship)
            if (
                relationship_data.get("source_system") != "itglue"
                or str(relationship_data.get("organization_id") or "") != target_org_id
                or str(relationship_data.get("target_destination_id") or "") != destination_id
            ):
                continue
            await tables.delete_document(RELATIONSHIPS_TABLE, str(relationship.id))
    if row is not None:
        await tables.delete_document(spec.table, destination_id)
    if spec.name == "documents":
        from functions.indexing import delete_document_index

        await delete_document_index(target_org_id, destination_id)
    await tables.delete_document(MAP_TABLE, source_map_id(target_org_id, spec.name, source_id))


async def _cancel_requested(run_id: str) -> bool:
    _, run = await _get_run(run_id)
    return bool(run.get("cancel_requested"))


async def _lease_owned(run_id: str, lease_id: str) -> bool:
    """Refresh the lease heartbeat and stop superseded workers at checkpoints."""
    _, run = await _get_run(run_id)
    if run.get("lease_id") != lease_id:
        return False
    await _update_run(run_id, {"lease_heartbeat_at": _now()})
    return True


async def _record_checkpoint(
    run_id: str, lease_id: str, counters: dict[str, int]
) -> dict[str, Any] | None:
    """Stop between records while keeping the current page available for replay."""
    _, current = await _get_run(run_id)
    if current.get("lease_id") != lease_id:
        return {"run_id": run_id, "status": "superseded"}
    if current.get("cancel_requested"):
        await _update_run(run_id, {"status": "cancelled", "completed_at": _now(), "counts": counters})
        return {"run_id": run_id, "status": "cancelled", "counts": counters}
    await _update_run(run_id, {"lease_heartbeat_at": _now(), "counts": counters})
    return None


async def _item_counts(run_id: str) -> dict[str, int]:
    return {
        status: await tables.count(ITEMS_TABLE, where={"run_id": run_id, "status": status})
        for status in ("pending", "running", "succeeded", "failed", "skipped", "deleted", "delete_pending")
    }


@workflow(
    name="docs_migration_run",
    description="Long-running, checkpointed IT Glue migration worker. Operational timeout is set in the Solution manifest.",
    category="Bifrost Docs Migration",
)
async def docs_migration_run(run_id: str) -> dict[str, Any]:
    """Execute or resume a migration. Correctness comes from persisted checkpoints."""
    _require_migration_operator()
    _, run = await _get_run(run_id)
    if run.get("status") == "completed":
        return {"run_id": run_id, "status": "completed", "already_complete": True}
    lease_id = str(uuid.uuid4())
    observed_at = _now()
    start_changes = {
        "status": "running",
        "implementation_version": RUNTIME_REVISION,
        "started_at": run.get("started_at") or observed_at,
        "watermark_started_at": run.get("watermark_started_at") or observed_at,
        "completed_at": None,
        "last_error": None,
        "lease_id": lease_id,
        "lease_heartbeat_at": _now(),
    }
    # The worker can begin before the parent persists its dispatch result.
    # Both startup writes must carry the same owner rather than preserving a
    # queued null/previous owner in a concurrent table update.
    execution_id = getattr(context, "execution_id", None)
    if isinstance(execution_id, str) and execution_id:
        start_changes["execution_id"] = execution_id
    await _update_run(run_id, start_changes)
    counters = dict(run.get("counts") or {"succeeded": 0, "failed": 0, "skipped": 0})
    cursors = dict(run.get("cursors") or {})
    reconciliation_counts = dict(run.get("reconciliation_counts") or {})
    incomplete_enumerations = list(run.get("incomplete_enumerations") or [])
    try:
        org_mappings = await _resolve_organization_mappings(run)
        selected = set(run.get("resource_types") or DEFAULT_RESOURCE_TYPES)
        for source_org_id, target_org_id in org_mappings:
            connection = await integrations.get("IT Glue", scope=target_org_id)
            if connection is None or str(connection.entity_id or "") != source_org_id:
                raise UserError("IT Glue Integration mapping changed during the migration")
            api_key = connection.config.get("api_key")
            if not api_key:
                raise UserError("The IT Glue Integration has no API key configured")
            base_url = connection.config.get("base_url") or "https://api.itglue.com"
            async with ITGlueClient(str(api_key), base_url=str(base_url)) as client:
                await _write_audit(
                    target_org_id,
                    "migration.organization.started",
                    "IT Glue organization migration started",
                    entity_id=run_id,
                    metadata={"source_organization_id": source_org_id},
                )
                for spec in RESOURCE_SPECS:
                    if spec.name not in selected:
                        continue
                    if await _cancel_requested(run_id):
                        await _update_run(run_id, {"status": "cancelled", "completed_at": _now()})
                        return {"run_id": run_id, "status": "cancelled", "counts": counters}
                    if not await _lease_owned(run_id, lease_id):
                        return {"run_id": run_id, "status": "superseded"}
                    group_key = migration_cursor_key(source_org_id, target_org_id, spec.name)
                    # This checkpoint is persisted only after enumeration and
                    # reconciliation return. A page cursor alone cannot prove
                    # completeness. Retry removes checkpoints for failed and
                    # pending scopes; a fresh run starts without any of them.
                    completed = reconciliation_counts.get(group_key)
                    if (
                        isinstance(completed, dict)
                        and all(
                            type(completed.get(field)) is int and completed[field] >= 0
                            for field in ("mapped_checked", "source_missing", "deleted")
                        )
                        and not any(
                            entry.get("source_organization_id") == source_org_id
                            and entry.get("resource_type") == spec.name
                            for entry in incomplete_enumerations
                        )
                    ):
                        continue
                    if spec.name == "flexible_assets":
                        await _update_run(
                            run_id, {"phase": spec.name, "cursors": cursors, "counts": counters}
                        )
                        for source_type_id in await _flexible_asset_type_source_ids(target_org_id):
                            if not await _lease_owned(run_id, lease_id):
                                return {"run_id": run_id, "status": "superseded"}
                            cursor_key = flexible_asset_cursor_key(
                                source_org_id, target_org_id, source_type_id
                            )
                            start_page = int(cursors.get(cursor_key) or 1)
                            params = {
                                "include": spec.include or "",
                                "filter[organization_id]": source_org_id,
                                "filter[flexible_asset_type_id]": source_type_id,
                            }
                            async for page in client.iter_pages(
                                "/flexible_assets", params=params, start_page=start_page
                            ):
                                if not await _lease_owned(run_id, lease_id):
                                    return {"run_id": run_id, "status": "superseded"}
                                for source in page.records:
                                    stopped = await _record_checkpoint(run_id, lease_id, counters)
                                    if stopped is not None:
                                        return stopped
                                    result = await _process_resource(
                                        client,
                                        run_id,
                                        source_org_id,
                                        target_org_id,
                                        spec,
                                        source,
                                        str(run.get("mode") or "proof"),
                                    )
                                    counters[result] = int(counters.get(result) or 0) + 1
                                cursors[cursor_key] = page.number + 1
                                await _update_run(
                                    run_id, {"cursors": cursors, "counts": counters}
                                )
                        if run.get("mode") in {"proof", "bulk", "delta", "reconcile"}:
                            reconciliation_counts[
                                migration_cursor_key(source_org_id, target_org_id, spec.name)
                            ] = await _reconcile_resource(
                                client, run_id, source_org_id, target_org_id, spec
                            )
                            await _update_run(
                                run_id, {"reconciliation_counts": reconciliation_counts}
                            )
                        continue
                    cursor_key = migration_cursor_key(source_org_id, target_org_id, spec.name)
                    start_page = int(cursors.get(cursor_key) or 1)
                    endpoint = spec.endpoint.format(org=source_org_id)
                    params: dict[str, Any] = {}
                    if spec.include:
                        params["include"] = spec.include
                    if spec.name == "documents":
                        # IT Glue's organization document relationship defaults
                        # to root-level records. Its literal ``null`` filter is
                        # required to enumerate documents in folders as well.
                        params["filter[document_folder_id]"] = "null"
                    await _update_run(run_id, {"phase": spec.name, "cursors": cursors, "counts": counters})
                    try:
                        async for page in client.iter_pages(endpoint, params=params, start_page=start_page):
                            if not await _lease_owned(run_id, lease_id):
                                return {"run_id": run_id, "status": "superseded"}
                            for source in page.records:
                                stopped = await _record_checkpoint(run_id, lease_id, counters)
                                if stopped is not None:
                                    return stopped
                                result = await _process_resource(
                                    client,
                                    run_id,
                                    source_org_id,
                                    target_org_id,
                                    spec,
                                    source,
                                    str(run.get("mode") or "proof"),
                                )
                                counters[result] = int(counters.get(result) or 0) + 1
                            cursors[cursor_key] = page.number + 1
                            await _update_run(run_id, {"cursors": cursors, "counts": counters})
                    except ITGlueError as exc:
                        if exc.status_code != 404:
                            raise
                        # An org-relationship list route can 404 when the
                        # organization has no records of that type (observed
                        # for flexible_assets). Continue so one absent route
                        # cannot interrupt the run, but skip reconciliation
                        # because the route cannot independently establish an
                        # empty source enumeration.
                        incomplete = {
                            "source_organization_id": source_org_id,
                            "resource_type": spec.name,
                            "reason": "list_route_404",
                        }
                        if incomplete not in incomplete_enumerations:
                            incomplete_enumerations.append(incomplete)
                        await _update_run(
                            run_id, {"incomplete_enumerations": incomplete_enumerations}
                        )
                        await _write_audit(
                            target_org_id,
                            "migration.spec.incomplete",
                            f"IT Glue list route returned 404; source completeness is unverified for {spec.name}",
                            entity_id=run_id,
                            metadata=incomplete,
                        )
                        continue
                    if run.get("mode") in {"proof", "bulk", "delta", "reconcile"}:
                        reconciliation_counts[cursor_key] = await _reconcile_resource(
                            client, run_id, source_org_id, target_org_id, spec
                        )
                        await _update_run(
                            run_id,
                            {"reconciliation_counts": reconciliation_counts},
                        )

        counters = await _item_counts(run_id)
        final_status = (
            "completed_with_errors"
            if counters.get("failed") or incomplete_enumerations
            else "completed"
        )
        await _update_run(
            run_id,
            {
                "status": final_status,
                "phase": "complete",
                "counts": counters,
                "incomplete_enumerations": incomplete_enumerations,
                "source_watermark_at": _now(),
                "completed_at": _now(),
            },
        )
        return {
            "run_id": run_id,
            "status": final_status,
            "counts": counters,
            "incomplete_enumerations": incomplete_enumerations,
        }
    except Exception as exc:
        await _update_run(
            run_id,
            {"status": "interrupted", "last_error": str(exc)[:1000], "counts": counters},
        )
        raise
