"""Establish a narrowly scoped managed-file prefix for native Docs authoring."""

from __future__ import annotations

from typing import Any

from bifrost import UserError, context, tables, workflow

from modules.migration_core import stable_id


GRANTS_TABLE = "docs-file-org-grants"


def _data(row: Any) -> dict[str, Any]:
    value = getattr(row, "data", None)
    if isinstance(value, dict):
        return value
    if isinstance(row, dict):
        nested = row.get("data")
        return nested if isinstance(nested, dict) else row
    return {}


def _may_cross_org() -> bool:
    organization = getattr(context, "organization", None)
    return bool(
        getattr(context, "is_platform_admin", False)
        or getattr(organization, "is_provider", False)
    )


@workflow(
    name="docs_ensure_file_grant",
    description="Establish the exact Bifrost organization file prefix before a native attachment upload.",
    category="Bifrost Docs",
)
async def docs_ensure_file_grant(organization_id: str) -> dict[str, str]:
    target = str(organization_id or "").strip()
    caller = str(getattr(context, "org_id", "") or "").strip()
    if not target:
        raise UserError("organization_id is required")
    if not _may_cross_org() and (not caller or target != caller):
        raise UserError("You can establish file access only for your own organization")
    grant_id = stable_id(target, "file-org-grant", target)
    current = await tables.get(GRANTS_TABLE, grant_id)
    if current is not None:
        existing = _data(current)
        if existing.get("organization_id") != target or existing.get("path_prefix") != target:
            raise UserError("The existing file grant requires administrator repair")
        return {"organization_id": target, "path_prefix": target}
    await tables.insert(
        GRANTS_TABLE,
        {"organization_id": target, "path_prefix": target},
        id=grant_id,
    )
    return {"organization_id": target, "path_prefix": target}
