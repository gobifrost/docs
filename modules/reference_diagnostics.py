"""Read-only source classification for explicitly selected migrated references.

Only canonical IT Glue provenance can select a source endpoint. Source bodies,
credentials, names, links and exception messages never enter the result.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from typing import Any, Awaitable, Callable
from uuid import UUID

from bifrost import UserError

from modules.itglue_api import ITGlueError, attributes
from modules.migration_core import (
    RESOURCE_SPECS,
    ResourceSpec,
    attr,
    canonical_related_item_resource_kind,
    source_detail_path,
    source_map_id,
    stable_id,
)

SPECS = {spec.name: spec for spec in RESOURCE_SPECS}


class ProvenanceError(ValueError):
    """Stored identity is insufficient to authorize a source diagnosis."""


def _data(row: Any) -> dict:
    value = row.get("data") if isinstance(row, dict) else getattr(row, "data", None)
    return value if isinstance(value, dict) else {}


def _id(row: Any) -> str:
    return str(row.get("id", "") if isinstance(row, dict) else getattr(row, "id", ""))


def _source_id(value: Any) -> str:
    candidate = str(value or "")
    if not re.fullmatch(r"[0-9]+", candidate):
        raise ProvenanceError
    return candidate


def validate_selection(document_ids: list[str], relationship_ids: list[str]) -> None:
    ids = [*document_ids, *relationship_ids]
    if not 1 <= len(ids) <= 100:
        raise UserError("Select between 1 and 100 document or relationship IDs")
    try:
        for id_ in ids:
            if not isinstance(id_, str) or str(UUID(id_)) != id_:
                raise ValueError
    except (ValueError, AttributeError):
        raise UserError("Reference IDs must be canonical UUIDs") from None


@dataclass(frozen=True)
class Plan:
    organization_id: str
    source_organization_id: str
    target_spec: ResourceSpec
    target_source_id: str
    owner_source_id: str | None = None
    stored_destination_id: str | None = None


async def _parent(
    tables: Any, kind: str, row_id: str, organization_id: str | None = None
) -> tuple[dict, str, str]:
    spec = SPECS.get(kind)
    if spec is None:
        raise ProvenanceError
    row = await tables.get(spec.table, row_id)
    data = _data(row)
    source_id = _source_id(data.get("source_id"))
    org = str(data.get("organization_id") or "")
    raw = data.get("raw")
    if (
        not org
        or (organization_id and org != organization_id)
        or data.get("source_system") != "itglue"
        or _id(row) != row_id
        or row_id != stable_id(org, kind, source_id)
        or not (
            (kind == "passwords" and raw is None)
            or (isinstance(raw, dict) and str(raw.get("id") or "") == source_id)
        )
    ):
        raise ProvenanceError
    # Password projections intentionally omit raw source bodies. Their stable
    # metadata identity plus the canonical source map provide parent provenance.
    map_id = source_map_id(org, kind, source_id)
    map_row = await tables.get("docs-source-map", map_id)
    mapped = _data(map_row)
    source_org = _source_id(mapped.get("source_organization_id"))
    if (
        _id(map_row) != map_id
        or mapped.get("organization_id") != org
        or mapped.get("resource_type") != kind
        or str(mapped.get("source_id") or "") != source_id
        or mapped.get("destination_id") != row_id
    ):
        raise ProvenanceError
    return data, source_id, source_org


async def _document_plan(tables: Any, id_: str) -> Plan | None:
    data, source_id, source_org = await _parent(tables, "documents", id_)
    folder = attr(attributes(data["raw"]), "document_folder_id", "folder_id")
    if folder in (None, "", 0, "0") and not data.get("folder_id"):
        return None
    folder_id = _source_id(folder)
    org = data["organization_id"]
    if data.get("folder_id") != stable_id(org, "document_folders", folder_id):
        raise ProvenanceError
    return Plan(org, source_org, SPECS["document_folders"], folder_id, source_id)


async def _relationship_plan(tables: Any, id_: str) -> Plan | None:
    row = await tables.get("docs-relationships", id_)
    data = _data(row)
    org = str(data.get("organization_id") or "")
    source_id = _source_id(data.get("source_id"))
    raw = data.get("raw")
    if (
        not org
        or data.get("source_system") != "itglue"
        or _id(row) != id_
        or id_ != stable_id(org, "related_item", source_id)
        or not isinstance(raw, dict)
        or str(raw.get("id") or "") != source_id
    ):
        raise ProvenanceError
    kind = str(data.get("source_type") or "")
    _, parent_source_id, source_org = await _parent(
        tables, kind, str(data.get("source_destination_id") or ""), org
    )
    attrs = attributes(raw)
    raw_parent = attr(attrs, "asset_id")
    raw_parent_type = attr(attrs, "source_type")
    if (raw_parent not in (None, "") and str(raw_parent) != parent_source_id) or (
        raw_parent_type not in (None, "")
        and canonical_related_item_resource_kind(raw_parent_type) != kind
    ):
        raise ProvenanceError
    raw_kind = attr(
        attrs, "destination_type", "resource_type", "asset_type", default=""
    )
    target_kind = canonical_related_item_resource_kind(raw_kind)
    if target_kind is None:
        return None
    target_source_id = _source_id(attr(attrs, "destination_id", "resource_id"))
    if (
        data.get("target_type") != target_kind
        or str(data.get("target_source_id") or "") != target_source_id
    ):
        raise ProvenanceError
    return Plan(
        org,
        source_org,
        SPECS[target_kind],
        target_source_id,
        stored_destination_id=data.get("target_destination_id"),
    )


async def _fetch(
    client: Any, spec: ResourceSpec, source_id: str, source_org: str
) -> tuple[dict | None, dict | None]:
    try:
        payload = await client.get_document(
            source_detail_path(spec, source_id, source_org)
        )
    except ITGlueError as exc:
        code = exc.status_code
        status = (
            "source_not_found_or_restricted"
            if code == 404
            else "source_access_denied"
            if code in (401, 403)
            else "source_transient_error"
            if code == 429 or (code is not None and code >= 500)
            else "source_request_failed"
        )
        return None, {"status": status, "http_status": code}
    source = payload.get("data")
    if not isinstance(source, dict) or str(source.get("id") or "") != source_id:
        return None, {"status": "source_identity_mismatch"}
    attrs = attributes(source)
    source_owner = attr(attrs, "organization_id")
    if source_owner not in (None, "") and str(source_owner) != source_org:
        return attrs, {"status": "source_other_organization"}
    if source_owner in (None, "") and spec.name not in {
        "document_folders",
        "password_folders",
    }:
        return None, {"status": "source_scope_unverified"}
    return attrs, None


async def _foreign_target_state(
    plan: Plan, attrs: dict, tables: Any, integrations: Any
) -> str:
    """Classify another source organization without creating tenants or links."""
    try:
        source_org = _source_id(attr(attrs, "organization_id"))
    except ProvenanceError:
        return "unverified"
    mappings = await integrations.list_mappings("IT Glue", scope="global")
    if mappings is None:
        return "unverified"
    matches = [
        mapping
        for mapping in mappings
        if str(getattr(mapping, "entity_id", "")) == source_org
    ]
    if not matches:
        return "unmapped"
    if len(matches) != 1:
        return "ambiguous"
    org = str(getattr(matches[0], "organization_id", "") or "")
    if (
        not org
        or len(
            [
                mapping
                for mapping in mappings
                if str(getattr(mapping, "organization_id", "")) == org
            ]
        )
        != 1
    ):
        return "ambiguous"
    target_id = stable_id(org, plan.target_spec.name, plan.target_source_id)
    target = await tables.get(plan.target_spec.table, target_id)
    if target is None:
        return "mapped_destination_missing"
    data = _data(target)
    if (
        _id(target) != target_id
        or data.get("organization_id") != org
        or data.get("source_system") != "itglue"
        or str(data.get("source_id") or "") != plan.target_source_id
    ):
        return "mapped_destination_identity_mismatch"
    map_id = source_map_id(org, plan.target_spec.name, plan.target_source_id)
    map_row = await tables.get("docs-source-map", map_id)
    if map_row is None:
        return "mapped_source_map_missing"
    mapped = _data(map_row)
    if (
        _id(map_row) != map_id
        or mapped.get("organization_id") != org
        or str(mapped.get("source_organization_id") or "") != source_org
        or mapped.get("resource_type") != plan.target_spec.name
        or str(mapped.get("source_id") or "") != plan.target_source_id
        or mapped.get("destination_id") != target_id
    ):
        return "mapped_source_map_invalid"
    return "mapped_destination_present"


async def _inspect(
    plan: Plan,
    *,
    tables: Any,
    integrations: Any,
    verify_mapping: Callable[[str, str], Awaitable[Any]],
    client_factory: Any,
) -> dict:
    try:
        await verify_mapping(plan.organization_id, plan.source_organization_id)
    except UserError:
        return {"status": "mapping_changed"}
    connection = await integrations.get("IT Glue", scope=plan.organization_id)
    if (
        connection is None
        or str(getattr(connection, "entity_id", "")) != plan.source_organization_id
    ):
        return {"status": "mapping_changed"}
    config = getattr(connection, "config", {})
    key = config.get("api_key")
    if not key:
        return {"status": "source_connection_unavailable"}
    async with client_factory(
        str(key),
        base_url=str(config.get("base_url") or "https://api.itglue.com"),
        max_retries=2,
        timeout_seconds=30,
    ) as client:
        if plan.owner_source_id:
            owner, error = await _fetch(
                client,
                SPECS["documents"],
                plan.owner_source_id,
                plan.source_organization_id,
            )
            if error:
                return {**error, "source_stage": "owner"}
            if (
                str(attr(owner, "document_folder_id", "folder_id") or "")
                != plan.target_source_id
            ):
                return {"status": "source_reference_changed"}
        target_attrs, error = await _fetch(
            client, plan.target_spec, plan.target_source_id, plan.source_organization_id
        )
        if error:
            if error["status"] == "source_other_organization":
                error["target_mapping_status"] = await _foreign_target_state(
                    plan,
                    target_attrs,
                    tables,
                    integrations,
                )
            return {**error, "source_stage": "target"}
    target_id = stable_id(
        plan.organization_id, plan.target_spec.name, plan.target_source_id
    )
    if plan.stored_destination_id and plan.stored_destination_id != target_id:
        return {"status": "destination_mapping_requires_review"}
    target = await tables.get(plan.target_spec.table, target_id)
    if target is None:
        return {"status": "source_exists_destination_missing"}
    data = _data(target)
    if (
        _id(target) != target_id
        or data.get("organization_id") != plan.organization_id
        or data.get("source_system") != "itglue"
        or str(data.get("source_id") or "") != plan.target_source_id
    ):
        return {"status": "destination_identity_mismatch"}
    return {"status": "source_and_destination_present"}


async def diagnose_references(
    *,
    document_ids: list[str],
    relationship_ids: list[str],
    tables: Any,
    integrations: Any,
    verify_mapping: Callable[[str, str], Awaitable[Any]],
    client_factory: Any,
) -> dict:
    validate_selection(document_ids, relationship_ids)
    results = []
    for kind, ids, planner in (
        ("document_folder", document_ids, _document_plan),
        ("relationship", relationship_ids, _relationship_plan),
    ):
        for id_ in dict.fromkeys(ids):
            result = {"id": id_, "reference_kind": kind}
            try:
                plan = await planner(tables, id_)
            except ProvenanceError:
                result["status"] = "provenance_invalid"
            else:
                if plan is None:
                    result["status"] = (
                        "no_folder_reference"
                        if kind == "document_folder"
                        else "unsupported_target_type"
                    )
                else:
                    result["target_resource_type"] = plan.target_spec.name
                    result.update(
                        await _inspect(
                            plan,
                            tables=tables,
                            integrations=integrations,
                            verify_mapping=verify_mapping,
                            client_factory=client_factory,
                        )
                    )
            results.append(result)
    return {
        "read_only": True,
        "results": results,
        "counts": dict(Counter(item["status"] for item in results)),
    }
