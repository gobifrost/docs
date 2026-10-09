"""Admin repair and tenant-safe agent search for Bifrost Docs knowledge.

Stable knowledge keys are ``bifrost-docs:documents:{organization_id}:{document_id}``.
The ``document_id`` is the stable ``docs-documents`` destination row ID, so the
migration path can call ``sync_document_index`` after every upsert and
``delete_document_index`` before/after a document delete without consulting
mutable source names.
"""

from __future__ import annotations

from typing import Any

from bifrost import UserError, context, knowledge, tables, tool, workflow

from modules.indexing_core import DOCUMENT_NAMESPACE, document_key, project_document


DOCUMENTS_TABLE = "docs-documents"
_MAX_SYNC_PAGE_SIZE = 100
_MAX_SEARCH_RESULTS = 10
_MAX_EXCERPT_CHARS = 1_000


def _data(row: Any) -> dict[str, Any]:
    value = getattr(row, "data", None)
    if isinstance(value, dict):
        return value
    if isinstance(row, dict):
        nested = row.get("data")
        return nested if isinstance(nested, dict) else row
    return {}


def _required_identifier(value: str | None, name: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise UserError(f"{name} is required")
    return normalized


def _caller_org_id() -> str | None:
    value = getattr(context, "org_id", None)
    return str(value) if value else None


def _caller_may_cross_org() -> bool:
    organization = getattr(context, "organization", None)
    return bool(
        getattr(context, "is_platform_admin", False)
        or getattr(organization, "is_provider", False)
    )


def _resolve_caller_org(organization_id: str | None) -> str:
    """Resolve a requested tenant without widening a customer caller's scope."""
    caller_org = _caller_org_id()
    requested = str(organization_id or caller_org or "").strip()
    if not requested:
        raise UserError("organization_id is required for provider-wide searches")
    if not _caller_may_cross_org():
        if not caller_org:
            raise UserError("No organization is available for this search")
        if requested != caller_org:
            raise UserError("You can search only your own organization")
    return requested


async def delete_document_index(organization_id: str, document_id: str) -> None:
    """Delete one document's deterministic, organization-scoped index entry."""
    org_id = _required_identifier(organization_id, "organization_id")
    doc_id = _required_identifier(document_id, "document_id")
    await knowledge.delete(
        document_key(org_id, doc_id),
        namespace=DOCUMENT_NAMESPACE,
        scope=org_id,
    )


async def sync_document_index(organization_id: str, document_id: str) -> None:
    """Upsert a safe projection, or remove the stale entry if it is ineligible.

    This is intentionally the migration integration point: call it after a
    ``docs-documents`` upsert.  The function never indexes a row outside the
    supplied Bifrost organization and removes a previously valid entry when the
    row becomes restricted, archived, secret-shaped, or disappears.
    """
    org_id = _required_identifier(organization_id, "organization_id")
    doc_id = _required_identifier(document_id, "document_id")
    row = await tables.get(DOCUMENTS_TABLE, doc_id, scope=org_id)
    decision = project_document(_data(row), organization_id=org_id, document_id=doc_id)
    if decision.entry is None:
        await delete_document_index(org_id, doc_id)
        return
    await knowledge.store(
        decision.entry.content,
        namespace=decision.entry.namespace,
        key=decision.entry.key,
        metadata=decision.entry.metadata,
        scope=org_id,
    )


@workflow(
    name="docs_sync_knowledge_index",
    description="Repair a bounded page of safe Bifrost Docs document knowledge for one organization.",
    category="Bifrost Docs Administration",
)
async def docs_sync_knowledge_index(
    organization_id: str,
    limit: int = _MAX_SYNC_PAGE_SIZE,
    offset: int = 0,
) -> dict[str, Any]:
    """Admin-only repair workflow; sync in bounded pages rather than broad writes."""
    org_id = _resolve_caller_org(organization_id)
    if limit < 1 or limit > _MAX_SYNC_PAGE_SIZE:
        raise UserError(f"limit must be between 1 and {_MAX_SYNC_PAGE_SIZE}")
    if offset < 0:
        raise UserError("offset must be zero or greater")

    page = await tables.query(
        DOCUMENTS_TABLE,
        where={"organization_id": org_id},
        order_by="created_at",
        order_dir="asc",
        limit=limit,
        offset=offset,
        scope=org_id,
    )
    indexed = 0
    removed = 0
    for row in page.documents:
        doc_id = str(getattr(row, "id", "") or "")
        decision = project_document(_data(row), organization_id=org_id, document_id=doc_id)
        await sync_document_index(org_id, doc_id)
        if decision.entry is None:
            removed += 1
        else:
            indexed += 1

    returned = len(page.documents)
    return {
        "organization_id": org_id,
        "indexed": indexed,
        "removed": removed,
        "processed": returned,
        "next_offset": offset + returned if returned == limit else None,
    }


@tool(
    name="docs_search_knowledge",
    description=(
        "Search safe, non-restricted Bifrost Docs document excerpts for one authorized "
        "organization and return source citations."
    ),
)
async def docs_search_knowledge(
    query: str,
    organization_id: str | None = None,
    limit: int = 5,
) -> dict[str, Any]:
    """Tenant-safe agent read tool over the explicitly indexed document subset."""
    text = (query or "").strip()
    if len(text) < 2:
        raise UserError("Search query must contain at least two characters")
    if len(text) > 1_000:
        raise UserError("Search query must be at most 1000 characters")
    if limit < 1 or limit > _MAX_SEARCH_RESULTS:
        raise UserError(f"limit must be between 1 and {_MAX_SEARCH_RESULTS}")

    org_id = _resolve_caller_org(organization_id)
    matches = await knowledge.search(
        text,
        namespace=DOCUMENT_NAMESPACE,
        limit=limit,
        scope=org_id,
        fallback=False,
    )
    results: list[dict[str, Any]] = []
    for item in matches:
        metadata = getattr(item, "metadata", None)
        if not isinstance(metadata, dict):
            continue
        # Defense in depth for stale/manual knowledge rows: only this module's
        # typed, organization-matching projection may be returned to the agent.
        if (
            metadata.get("product") != "bifrost-docs"
            or metadata.get("resource_type") != "document"
            or metadata.get("organization_id") != org_id
        ):
            continue
        document_id = str(metadata.get("document_id") or "")
        if not document_id:
            continue
        try:
            source_row = await tables.get(DOCUMENTS_TABLE, document_id, scope=org_id)
        except Exception:
            continue
        current = project_document(
            _data(source_row), organization_id=org_id, document_id=document_id
        )
        if (
            current.entry is None
            or current.entry.key != document_key(org_id, document_id)
            or current.entry.metadata.get("source_updated_at") != metadata.get("source_updated_at")
        ):
            continue
        results.append(
            {
                "document_id": metadata.get("document_id"),
                "title": metadata.get("title"),
                "citation": metadata.get("citation"),
                "source_system": metadata.get("source_system"),
                "source_id": metadata.get("source_id"),
                "source_updated_at": metadata.get("source_updated_at") or None,
                "score": getattr(item, "score", None),
                "excerpt": str(getattr(item, "content", ""))[:_MAX_EXCERPT_CHARS],
            }
        )
    return {
        "query": text,
        "organization_id": org_id,
        "results": results,
        "result_count": len(results),
        "citations_required": True,
        "secrets_included": False,
    }
