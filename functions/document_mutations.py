"""Tenant-scoped Bifrost Docs document edit and delete workflows."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from bifrost import UserError, context, files, tables, workflow

from functions.attachments import validate_owned_attachment_storage_path
from functions.indexing import delete_document_index, sync_document_index


DOCUMENTS_TABLE = "docs-documents"
FOLDERS_TABLE = "docs-document-folders"
ATTACHMENTS_TABLE = "docs-attachments"
RELATIONSHIPS_TABLE = "docs-relationships"
AUDIT_TABLE = "docs-audit-events"
_FOLDER_UNSET = "__bifrost_docs_folder_id_omitted__"
_MAX_TITLE_CHARS = 240
_MAX_CONTENT_CHARS = 30_000
_MAX_BULK_ARCHIVE_DOCUMENTS = 100
_NATIVE_SOURCE_SYSTEM = "bifrost"
_DOCUMENT_FILE_LOCATIONS = {
    "docs-content",
    "docs-attachments",
    "docs-restricted-content",
    "docs-restricted-attachments",
}


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
    organization_id = str(getattr(context, "org_id", "") or "").strip()
    if not organization_id:
        raise UserError("No organization is available for document changes")
    return organization_id


def _may_cross_org() -> bool:
    organization = getattr(context, "organization", None)
    return bool(
        getattr(context, "is_platform_admin", False)
        or getattr(organization, "is_provider", False)
    )


def _require_document_id(document_id: str) -> str:
    normalized = str(document_id or "").strip()
    if not normalized:
        raise UserError("document_id is required")
    return normalized


def _normalize_bulk_document_ids(document_ids: list[str]) -> list[str]:
    if not isinstance(document_ids, list):
        raise UserError("document_ids must be a list of document IDs")
    normalized: list[str] = []
    seen: set[str] = set()
    for document_id in document_ids:
        document_id = _require_document_id(document_id)
        if document_id not in seen:
            normalized.append(document_id)
            seen.add(document_id)
    if not normalized:
        raise UserError("Select at least one document to archive")
    if len(normalized) > _MAX_BULK_ARCHIVE_DOCUMENTS:
        raise UserError(f"Select at most {_MAX_BULK_ARCHIVE_DOCUMENTS} documents to archive at once")
    return normalized


def _require_text(value: str, name: str, maximum: int, *, allow_empty: bool = False) -> str:
    text = str(value or "").strip()
    if not text and not allow_empty:
        raise UserError(f"{name} is required")
    if len(text) > maximum:
        raise UserError(f"{name} must be at most {maximum} characters")
    return text


def _require_document_org(data: dict[str, Any]) -> str:
    organization_id = str(data.get("organization_id") or "").strip()
    if not organization_id:
        raise UserError("Document is missing its organization")
    if not _may_cross_org() and organization_id != _caller_org_id():
        raise UserError("You can change only documents in your own organization")
    return organization_id


async def _get_document(document_id: str) -> tuple[str, dict[str, Any], str]:
    doc_id = _require_document_id(document_id)
    row = await tables.get(DOCUMENTS_TABLE, doc_id)
    if row is None:
        raise UserError("Document not found")
    data = _data(row)
    return doc_id, data, _require_document_org(data)


async def _validate_folder(organization_id: str, folder_id: str | None) -> tuple[str | None, bool]:
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
    organization_id: str, event_type: str, document_id: str, *, metadata: dict[str, Any]
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
            "metadata": metadata,
        },
    )


def _safe_attachment_path(
    organization_id: str, attachment_id: str, data: dict[str, Any]
) -> tuple[str, str] | None:
    normalized_location = str(data.get("storage_location") or "").strip()
    if normalized_location not in _DOCUMENT_FILE_LOCATIONS:
        return None
    try:
        return validate_owned_attachment_storage_path(organization_id, attachment_id, data), normalized_location
    except UserError:
        return None


async def _delete_attachments(organization_id: str, document_id: str) -> int:
    deleted = 0
    while True:
        page = await tables.query(
            ATTACHMENTS_TABLE,
            where={
                "organization_id": organization_id,
                "parent_type": "documents",
                "parent_id": document_id,
            },
            limit=100,
            scope=organization_id,
        )
        if not page.documents:
            return deleted
        for row in page.documents:
            data = _data(row)
            owned_path = _safe_attachment_path(
                organization_id, str(row.id), data
            )
            if owned_path is not None:
                path, location = owned_path
                stat = await files.stat(path, location=location, scope=organization_id)
                if stat.get("exists"):
                    await files.delete(
                        path,
                        location=location,
                        scope=organization_id,
                        expected_version=stat.get("version"),
                    )
            await tables.delete_document(ATTACHMENTS_TABLE, str(row.id), scope=organization_id)
            deleted += 1


async def _delete_relationships(organization_id: str, document_id: str) -> int:
    deleted = 0
    relationship_queries = (
        (
            {
                "organization_id": organization_id,
                "source_type": "documents",
                "source_destination_id": document_id,
            },
            lambda data: (
                str(data.get("organization_id") or "") == organization_id
                and str(data.get("source_type") or "") == "documents"
                and str(data.get("source_destination_id") or "") == document_id
            ),
        ),
        (
            {
                "organization_id": organization_id,
                "target_destination_id": document_id,
            },
            lambda data: (
                str(data.get("organization_id") or "") == organization_id
                and str(data.get("target_destination_id") or "") == document_id
            ),
        ),
    )
    for where, references_document in relationship_queries:
        while True:
            page = await tables.query(
                RELATIONSHIPS_TABLE,
                where=where,
                limit=100,
                scope=organization_id,
            )
            if not page.documents:
                break
            deleted_this_page = 0
            for row in page.documents:
                if not references_document(_data(row)):
                    continue
                await tables.delete_document(RELATIONSHIPS_TABLE, str(row.id), scope=organization_id)
                deleted += 1
                deleted_this_page += 1
            if not deleted_this_page:
                break
    return deleted


@workflow(
    name="docs_update_document",
    description="Update title, content, and folder for one tenant-scoped Bifrost Docs document.",
    category="Bifrost Docs",
)
async def docs_update_document(
    document_id: str,
    title: str | None = None,
    content: str | None = None,
    folder_id: str | None = _FOLDER_UNSET,
) -> dict[str, str]:
    """Update presentation fields only, preserving native or IT Glue provenance."""
    doc_id, existing, organization_id = await _get_document(document_id)
    changes: dict[str, Any] = {}
    if title is not None:
        changes["name"] = _require_text(title, "title", _MAX_TITLE_CHARS)
    if content is not None:
        safe_content = _require_text(content, "content", _MAX_CONTENT_CHARS, allow_empty=True)
        changes.update(content=safe_content, rendered_content=safe_content)
    if folder_id != _FOLDER_UNSET:
        safe_folder_id, folder_restricted = await _validate_folder(organization_id, folder_id)
        current_folder_id = str(existing.get("folder_id") or "").strip() or None
        if folder_restricted and safe_folder_id != current_folder_id:
            raise UserError(
                "Moving an existing document into a restricted folder requires a restriction promotion workflow"
            )
        changes["folder_id"] = safe_folder_id
    if not changes:
        raise UserError("Provide title, content, or folder_id to update")
    # Omitted presentation fields are untouched, including large source bodies.
    # Table policies enforce Editor/Admin and restricted-row authority.
    await tables.update(DOCUMENTS_TABLE, doc_id, changes, scope=organization_id)
    previous_presentation = {key: existing.get(key) for key in changes}
    try:
        await sync_document_index(organization_id, doc_id)
    except Exception as index_error:
        try:
            await tables.update(
                DOCUMENTS_TABLE,
                doc_id,
                previous_presentation,
                scope=organization_id,
            )
        except Exception as rollback_error:
            raise UserError(
                "Document index refresh failed and the automatic edit rollback could not be completed"
            ) from rollback_error
        try:
            # Rebuild the prior entry if the first attempt partially wrote it.
            await sync_document_index(organization_id, doc_id)
        except Exception:
            pass
        raise UserError(
            "Document index refresh failed; the document changes were rolled back"
        ) from index_error
    await _write_audit(
        organization_id,
        "document.updated",
        doc_id,
        metadata={"source_system": existing.get("source_system"), "restricted": bool(existing.get("restricted"))},
    )
    return {"document_id": doc_id, "organization_id": organization_id, "status": "updated"}


@workflow(
    name="docs_bulk_archive_documents",
    description="Archive a bounded selection of native Bifrost Docs documents without changing source-owned records.",
    category="Bifrost Docs",
)
async def docs_bulk_archive_documents(document_ids: list[str]) -> dict[str, Any]:
    """Archive native documents after validating every selected ID and tenant boundary.

    IT Glue-backed documents remain source-owned before cutover, so they are
    intentionally reported as skipped rather than locally hidden or deleted.
    This workflow does not accept password IDs or operate on password metadata.
    """
    normalized_ids = _normalize_bulk_document_ids(document_ids)
    # Complete preflight before the first write. A missing or cross-tenant ID
    # must never turn a multi-select action into a partial archive.
    selected = [await _get_document(document_id) for document_id in normalized_ids]
    archived_document_ids: list[str] = []
    already_archived_document_ids: list[str] = []
    skipped_source_owned_document_ids: list[str] = []
    pending_index_cleanup_document_ids: list[str] = []

    for document_id, data, organization_id in selected:
        if str(data.get("source_system") or "").casefold() != _NATIVE_SOURCE_SYSTEM:
            skipped_source_owned_document_ids.append(document_id)
            continue
        if bool(data.get("archived")) or str(data.get("status") or "").casefold() == "archived":
            already_archived_document_ids.append(document_id)
            continue

        await tables.update(
            DOCUMENTS_TABLE,
            document_id,
            {"status": "archived", "archived": True, "source_updated_at": _now()},
            scope=organization_id,
        )
        try:
            # The synchronizer removes any existing knowledge entry once the
            # row is archived. It is safer to retain archival on cleanup
            # failure than to restore discoverability accidentally.
            await sync_document_index(organization_id, document_id)
        except Exception:
            pending_index_cleanup_document_ids.append(document_id)
            await _write_audit(
                organization_id,
                "document.bulk_archived_index_pending",
                document_id,
                metadata={"reason": "knowledge_cleanup_failed"},
            )
            continue
        await _write_audit(
            organization_id,
            "document.bulk_archived",
            document_id,
            metadata={"source_system": _NATIVE_SOURCE_SYSTEM, "restricted": bool(data.get("restricted"))},
        )
        archived_document_ids.append(document_id)

    return {
        "requested_count": len(normalized_ids),
        "archived_document_ids": archived_document_ids,
        "already_archived_document_ids": already_archived_document_ids,
        "skipped_source_owned_document_ids": skipped_source_owned_document_ids,
        "pending_index_cleanup_document_ids": pending_index_cleanup_document_ids,
    }


@workflow(
    name="docs_delete_document",
    description="Delete one tenant-scoped Bifrost Docs document and its managed children.",
    category="Bifrost Docs",
)
async def docs_delete_document(document_id: str) -> dict[str, str]:
    """Remove a document's index, attachments, relationships, row, and audit event."""
    doc_id, existing, organization_id = await _get_document(document_id)
    try:
        await delete_document_index(organization_id, doc_id)
        attachment_count = await _delete_attachments(organization_id, doc_id)
        relationship_count = await _delete_relationships(organization_id, doc_id)
    except Exception as delete_error:
        try:
            await _write_audit(
                organization_id,
                "document.delete_failed",
                doc_id,
                metadata={"source_system": existing.get("source_system")},
            )
        except Exception:
            pass
        raise UserError("Document deletion did not complete and may be retried") from delete_error

    await tables.delete_document(DOCUMENTS_TABLE, doc_id, scope=organization_id)
    try:
        await _write_audit(
            organization_id,
            "document.deleted",
            doc_id,
            metadata={
                "source_system": existing.get("source_system"),
                "source_id": existing.get("source_id"),
                "restricted": bool(existing.get("restricted")),
                "attachment_count": attachment_count,
                "relationship_count": relationship_count,
            },
        )
    except Exception as audit_error:
        raise UserError(
            "Document was deleted, but its audit event could not be written; operator follow-up is required"
        ) from audit_error
    return {"document_id": doc_id, "organization_id": organization_id, "status": "deleted"}
