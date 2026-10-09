"""Tenant-safe native Bifrost Docs authoring tools for documentation agents.

These tools create only Bifrost-authored records.  They deliberately do not
modify the migration ownership or merge behavior of IT Glue-backed rows.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Mapping
from urllib.parse import parse_qs, urlparse

from bifrost import UserError, context, tables, tool

from functions.indexing import sync_document_index
from modules.indexing_core import contains_secret_like_text


DOCUMENTS_TABLE = "docs-documents"
FOLDERS_TABLE = "docs-document-folders"
AUDIT_TABLE = "docs-audit-events"
SOURCE_SYSTEM = "bifrost"
_FOLDER_UNSET = "__bifrost_docs_folder_id_omitted__"
_MAX_TITLE_CHARS = 240
_MAX_CONTENT_CHARS = 30_000
_MAX_SOURCE_REFS = 20
_MAX_TICKET_ID_CHARS = 200
_MAX_TICKET_URL_CHARS = 2_000
_SENSITIVE_QUERY_KEYS = frozenset(
    {"access_token", "api_key", "authorization", "client_secret", "password", "secret", "token"}
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _data(row: Any) -> dict[str, Any]:
    value = getattr(row, "data", None)
    if isinstance(value, dict):
        return value
    if isinstance(row, dict):
        nested = row.get("data")
        return nested if isinstance(nested, dict) else row
    return {}


def _caller_org_id() -> str:
    org_id = str(getattr(context, "org_id", "") or "").strip()
    if not org_id:
        raise UserError("No organization is available for document authoring")
    return org_id


def _is_provider_or_platform() -> bool:
    organization = getattr(context, "organization", None)
    return bool(
        getattr(context, "is_platform_admin", False)
        or getattr(organization, "is_provider", False)
    )


def _require_author_target(organization_id: str) -> str:
    target = str(organization_id or "").strip()
    if not target:
        raise UserError("organization_id is required")
    if not _is_provider_or_platform() and target != _caller_org_id():
        raise UserError("You can author only for your own organization")
    return target


def _require_publisher() -> None:
    # Bifrost's execution context intentionally does not expose role claims;
    # the workflow row must require Bifrost Docs Administrator. This runtime
    # gate adds the independent provider/platform boundary.
    if not _is_provider_or_platform():
        raise UserError("Publishing requires a provider or platform Docs Admin context")


def _safe_text(value: str, name: str, maximum: int) -> str:
    text = str(value or "").strip()
    if not text:
        raise UserError(f"{name} is required")
    if len(text) > maximum:
        raise UserError(f"{name} must be at most {maximum} characters")
    if contains_secret_like_text(text):
        raise UserError(f"{name} contains secret-like material and cannot be stored")
    return text


def _normalize_source_refs(source_refs: list[Mapping[str, Any]] | None) -> list[dict[str, str]]:
    if source_refs is None:
        return []
    if not isinstance(source_refs, list) or len(source_refs) > _MAX_SOURCE_REFS:
        raise UserError(f"source_refs must contain at most {_MAX_SOURCE_REFS} ticket references")
    normalized: list[dict[str, str]] = []
    for item in source_refs:
        if not isinstance(item, Mapping):
            raise UserError("Each source_refs entry must be ticket URL/ID metadata")
        ticket_id = _safe_text(str(item.get("ticket_id") or ""), "ticket_id", _MAX_TICKET_ID_CHARS)
        ticket_url = _safe_text(str(item.get("ticket_url") or ""), "ticket_url", _MAX_TICKET_URL_CHARS)
        parsed = urlparse(ticket_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
            raise UserError("ticket_url must be an absolute HTTP(S) URL without credentials")
        if any(key.casefold() in _SENSITIVE_QUERY_KEYS for key in parse_qs(parsed.query)):
            raise UserError("ticket_url must not include secret-like query parameters")
        normalized.append({"ticket_id": ticket_id, "ticket_url": ticket_url})
    return normalized


def _validate_document_input(
    title: str, content: str, source_refs: list[Mapping[str, Any]] | None
) -> tuple[str, str, list[dict[str, str]]]:
    return (
        _safe_text(title, "title", _MAX_TITLE_CHARS),
        _safe_text(content, "content", _MAX_CONTENT_CHARS),
        _normalize_source_refs(source_refs),
    )


async def _get_native_draft(document_id: str) -> tuple[str, dict[str, Any]]:
    doc_id = str(document_id or "").strip()
    if not doc_id:
        raise UserError("document_id is required")
    row = await tables.get(DOCUMENTS_TABLE, doc_id)
    if row is None:
        raise UserError("Document not found")
    data = _data(row)
    if str(data.get("source_system") or "").casefold() != SOURCE_SYSTEM:
        raise UserError("Only Bifrost-authored documents can be changed by native authoring tools")
    if str(data.get("status") or "").casefold() != "draft":
        raise UserError("Only draft documents can be updated or published")
    org_id = str(data.get("organization_id") or "").strip()
    if not org_id:
        raise UserError("Document is missing its organization")
    _require_author_target(org_id)
    return doc_id, data


async def _validate_document_folder(organization_id: str, folder_id: str | None) -> tuple[str | None, bool]:
    """Return a folder ID and its restriction state after a scoped tenant check."""
    normalized = str(folder_id or "").strip()
    if not normalized:
        return None, False
    row = await tables.get(FOLDERS_TABLE, normalized, scope=organization_id)
    if row is None:
        raise UserError("Document folder not found")
    if str(_data(row).get("organization_id") or "") != organization_id:
        raise UserError("Document folder belongs to another organization")
    return normalized, bool(_data(row).get("restricted"))


async def _write_audit(
    organization_id: str, event_type: str, document_id: str, *, metadata: dict[str, Any] | None = None
) -> None:
    await tables.insert(
        AUDIT_TABLE,
        {
            "organization_id": organization_id,
            "event_type": event_type,
            "entity_type": "document",
            "entity_id": document_id,
            "summary": event_type.replace(".", " "),
            "actor": str(getattr(context, "user_id", None) or "workflow"),
            "occurred_at": _now(),
            "metadata": metadata or {},
        },
    )


@tool(
    name="docs_create_draft",
    description="Create a bounded, tenant-scoped Bifrost Docs draft with safe ticket citations.",
)
async def docs_create_draft(
    organization_id: str,
    title: str,
    content: str,
    source_refs: list[dict[str, str]] | None = None,
    folder_id: str | None = None,
) -> dict[str, str]:
    """Create a native organization-scoped draft; it is never globally visible."""
    target_org = _require_author_target(organization_id)
    safe_title, safe_content, safe_refs = _validate_document_input(title, content, source_refs)
    safe_folder_id, folder_restricted = await _validate_document_folder(target_org, folder_id)
    document_id = str(uuid.uuid4())
    now = _now()
    await tables.insert(
        DOCUMENTS_TABLE,
        {
            "organization_id": target_org,
            "source_system": SOURCE_SYSTEM,
            "source_id": document_id,
            "source_url": safe_refs[0]["ticket_url"] if safe_refs else None,
            "source_updated_at": now,
            "name": safe_title,
            "content": safe_content,
            "rendered_content": safe_content,
            "status": "draft",
            "visibility": "organization",
            "source_refs": safe_refs,
            "folder_id": safe_folder_id,
            "archived": False,
            "restricted": folder_restricted,
        },
        id=document_id,
        scope=target_org,
    )
    await _write_audit(target_org, "document.draft_created", document_id)
    return {"document_id": document_id, "organization_id": target_org, "status": "draft"}


@tool(
    name="docs_update_draft",
    description="Update a bounded Bifrost Docs native draft before provider Docs Admin publication.",
)
async def docs_update_draft(
    document_id: str,
    title: str | None = None,
    content: str | None = None,
    source_refs: list[dict[str, str]] | None = None,
    folder_id: str | None = _FOLDER_UNSET,
) -> dict[str, str]:
    """Update only a native draft after validating tenant authority and safe content.

    Omitting ``folder_id`` leaves the current folder unchanged; an explicit
    null or blank value clears it.
    """
    doc_id, existing = await _get_native_draft(document_id)
    org_id = str(existing["organization_id"])
    changes: dict[str, Any] = {"source_updated_at": _now()}
    if title is not None or content is not None or source_refs is not None:
        safe_title, safe_content, safe_refs = _validate_document_input(
            title if title is not None else str(existing.get("name") or ""),
            content if content is not None else str(existing.get("content") or ""),
            source_refs if source_refs is not None else existing.get("source_refs"),
        )
        if title is not None:
            changes["name"] = safe_title
        if content is not None:
            changes.update(content=safe_content, rendered_content=safe_content)
        if source_refs is not None:
            changes.update(source_url=safe_refs[0]["ticket_url"] if safe_refs else None, source_refs=safe_refs)
    if folder_id != _FOLDER_UNSET:
        safe_folder_id, folder_restricted = await _validate_document_folder(org_id, folder_id)
        current_folder_id = str(existing.get("folder_id") or "").strip() or None
        if folder_restricted and safe_folder_id != current_folder_id:
            raise UserError(
                "Moving an existing draft into a restricted folder requires a restriction promotion workflow"
            )
        changes["folder_id"] = safe_folder_id
    await tables.update(
        DOCUMENTS_TABLE,
        doc_id,
        changes,
        scope=org_id,
    )
    await _write_audit(org_id, "document.draft_updated", doc_id)
    return {"document_id": doc_id, "organization_id": org_id, "status": "draft"}


@tool(
    name="docs_publish_draft",
    description="Publish a confirmed native Bifrost Docs draft and index its safe organization-scoped content.",
)
async def docs_publish_draft(document_id: str, confirmed: bool = False) -> dict[str, str]:
    """Publish one native draft only after provider/platform Docs Admin confirmation."""
    _require_publisher()
    if confirmed is not True:
        raise UserError("Publishing requires confirmed=true user confirmation")
    doc_id, existing = await _get_native_draft(document_id)
    org_id = str(existing["organization_id"])
    _validate_document_input(
        str(existing.get("name") or ""),
        str(existing.get("rendered_content") or existing.get("content") or ""),
        existing.get("source_refs"),
    )
    published_at = _now()
    await tables.update(
        DOCUMENTS_TABLE,
        doc_id,
        {"status": "published", "published_at": published_at, "source_updated_at": published_at},
        scope=org_id,
    )
    try:
        await sync_document_index(org_id, doc_id)
    except Exception as index_error:
        try:
            await tables.update(
                DOCUMENTS_TABLE,
                doc_id,
                {"status": "draft", "published_at": None, "source_updated_at": _now()},
                scope=org_id,
            )
        except Exception as compensation_error:
            raise UserError(
                "Publishing could not be indexed and requires Docs Admin recovery"
            ) from compensation_error
        await _write_audit(
            org_id,
            "document.publish_reverted",
            doc_id,
            metadata={"reason": "knowledge_index_failed"},
        )
        raise UserError(
            "Publication was reverted to draft because knowledge indexing failed"
        ) from index_error
    await _write_audit(org_id, "document.published", doc_id)
    return {"document_id": doc_id, "organization_id": org_id, "status": "published"}


@tool(
    name="docs_archive_native",
    description="Archive a native Bifrost Docs document and remove its knowledge entry.",
)
async def docs_archive_native(document_id: str) -> dict[str, str]:
    """Archive a native document without deleting its audit trail or source citations."""
    doc_id = str(document_id or "").strip()
    if not doc_id:
        raise UserError("document_id is required")
    row = await tables.get(DOCUMENTS_TABLE, doc_id)
    if row is None:
        raise UserError("Document not found")
    existing = _data(row)
    if str(existing.get("source_system") or "").casefold() != SOURCE_SYSTEM:
        raise UserError("Only Bifrost-authored documents can be archived by native authoring tools")
    org_id = _require_author_target(str(existing.get("organization_id") or ""))
    await tables.update(
        DOCUMENTS_TABLE,
        doc_id,
        {"status": "archived", "archived": True, "source_updated_at": _now()},
        scope=org_id,
    )
    try:
        await sync_document_index(org_id, doc_id)
    except Exception as index_error:
        # Keep the archival state: search revalidates the source row before
        # returning a knowledge hit, so reverting would be less safe than
        # leaving the row inaccessible while cleanup is retried.
        await _write_audit(
            org_id,
            "document.archived_index_pending",
            doc_id,
            metadata={"reason": "knowledge_cleanup_failed"},
        )
        raise UserError("Document is archived, but knowledge cleanup is pending") from index_error
    await _write_audit(org_id, "document.archived", doc_id)
    return {"document_id": doc_id, "organization_id": org_id, "status": "archived"}
