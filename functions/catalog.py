"""Tenant-safe catalog reads exposed to the Bifrost Documentation Agent."""

from __future__ import annotations

from typing import Any

from bifrost import UserError, context, organizations, tables, tool, workflow


def _caller_org_id() -> str | None:
    value = getattr(context, "org_id", None)
    return str(value) if value else None


def _is_provider() -> bool:
    organization = getattr(context, "organization", None)
    return bool(
        getattr(context, "is_platform_admin", False)
        or getattr(organization, "is_provider", False)
    )


def _row_data(row: Any) -> dict[str, Any]:
    value = getattr(row, "data", None)
    return value if isinstance(value, dict) else {}


def _organization_field(organization: Any, field: str, default: Any = None) -> Any:
    if isinstance(organization, dict):
        return organization.get(field, default)
    return getattr(organization, field, default)


@workflow(
    name="docs_list_organizations",
    description="Return the Docs organization scope that the authenticated caller may use.",
    category="Bifrost Docs",
)
async def docs_list_organizations() -> dict[str, Any]:
    """Return a trusted fixed scope for customers or an active provider directory."""
    caller_org_id = _caller_org_id()
    caller_organization = getattr(context, "organization", None)
    if not _is_provider():
        if not caller_org_id:
            return {"caller_mode": "missing", "own_organization_id": None, "organizations": []}
        caller_name = str(_organization_field(caller_organization, "name", "") or caller_org_id)
        return {
            "caller_mode": "fixed",
            "own_organization_id": caller_org_id,
            "organizations": [{"id": caller_org_id, "name": caller_name}],
        }

    choices = [
        {
            "id": str(_organization_field(organization, "id", "") or ""),
            "name": str(_organization_field(organization, "name", "") or _organization_field(organization, "id", "")),
        }
        for organization in await organizations.list()
        if bool(_organization_field(organization, "is_active", True))
        and str(_organization_field(organization, "id", "") or "")
    ]
    choices.sort(key=lambda organization: (organization["name"].casefold(), organization["id"]))
    return {
        "caller_mode": "picker",
        "own_organization_id": caller_org_id,
        "organizations": choices,
    }


@tool(
    name="docs_search_catalog",
    description="Search authorized Bifrost Docs documents, configurations, locations, flexible assets, and password metadata without revealing secrets.",
)
async def docs_search_catalog(
    query: str,
    organization_id: str | None = None,
    limit_per_type: int = 10,
) -> dict[str, Any]:
    """Return bounded, attributable catalog matches for agent answers."""
    text = (query or "").strip()
    if len(text) < 2:
        raise UserError("Search query must contain at least two characters")
    if limit_per_type < 1 or limit_per_type > 50:
        raise UserError("limit_per_type must be between 1 and 50")
    caller_org_id = _caller_org_id()
    target_org_id = organization_id or caller_org_id
    if not _is_provider():
        if not caller_org_id:
            raise UserError("No organization is available for this search")
        if target_org_id != caller_org_id:
            raise UserError("You can search only your own organization")
        target_org_id = caller_org_id
    if not target_org_id:
        raise UserError("organization_id is required for provider-wide searches")

    specs = (
        ("document", "docs-documents", "name", "rendered_content"),
        ("configuration", "docs-configurations", "name", "hostname"),
        ("location", "docs-locations", "name", "city"),
        ("flexible_asset", "docs-flexible-assets", "name", None),
        ("password_metadata", "docs-passwords", "name", "username"),
    )
    results: list[dict[str, Any]] = []
    for resource_type, table_name, name_field, secondary_field in specs:
        seen: set[str] = set()
        filters = [name_field] + ([secondary_field] if secondary_field else [])
        for field in filters:
            page = await tables.query(
                table_name,
                where={"organization_id": target_org_id, field: {"contains": text}},
                order_by="updated_at",
                order_dir="desc",
                limit=limit_per_type,
            )
            for row in page.documents:
                row_id = str(row.id)
                if row_id in seen:
                    continue
                seen.add(row_id)
                data = _row_data(row)
                content = str(data.get("rendered_content") or data.get("content") or "")
                results.append(
                    {
                        "resource_type": resource_type,
                        "id": row_id,
                        "organization_id": data.get("organization_id"),
                        "name": data.get("name") or "(unnamed)",
                        "summary": content[:500] if resource_type == "document" else str(data.get(secondary_field or "") or "")[:200],
                        "source_id": data.get("source_id"),
                        "updated_at": getattr(row, "updated_at", None),
                    }
                )
                if len(seen) >= limit_per_type:
                    break
    return {
        "query": text,
        "organization_id": target_org_id,
        "results": results,
        "result_count": len(results),
        "secrets_included": False,
    }
