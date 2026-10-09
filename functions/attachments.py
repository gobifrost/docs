"""Tenant-safe registration and deletion of browser-uploaded record files."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from bifrost import UserError, context, files, tables, workflow

from modules.migration_core import safe_file_name


DOCUMENTS_TABLE = "docs-documents"
ATTACHMENTS_TABLE = "docs-attachments"
AUDIT_TABLE = "docs-audit-events"
_PARENT_TABLES = {
    "documents": DOCUMENTS_TABLE,
    "configurations": "docs-configurations",
    "locations": "docs-locations",
    "flexible_assets": "docs-flexible-assets",
}
_ATTACHMENT_LOCATIONS = frozenset({"docs-attachments", "docs-restricted-attachments"})
_IMAGE_LOCATIONS = frozenset({"docs-content", "docs-restricted-content"})
_MAX_CONTENT_TYPE_CHARS = 200


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
        raise UserError("No organization is available for attachment operations")
    return org_id


def _may_cross_org() -> bool:
    organization = getattr(context, "organization", None)
    return bool(
        getattr(context, "is_platform_admin", False)
        or getattr(organization, "is_provider", False)
    )


def _require_target_org(organization_id: Any) -> str:
    target_org = str(organization_id or "").strip()
    if not target_org:
        raise UserError("Attachment metadata is missing its organization")
    if not _may_cross_org() and target_org != _caller_org_id():
        raise UserError("You can manage attachments only for your own organization")
    return target_org


def _attachment_location(restricted: bool) -> str:
    return "docs-restricted-attachments" if restricted else "docs-attachments"


def _content_location(restricted: bool) -> str:
    return "docs-restricted-content" if restricted else "docs-content"


def _parent_table(parent_type: Any) -> tuple[str, str]:
    normalized = str(parent_type or "").strip()
    table = _PARENT_TABLES.get(normalized)
    if table is None:
        raise UserError("parent_type is not supported for native attachments")
    return normalized, table


def _validate_content_type(value: str) -> str:
    content_type = str(value or "").strip()
    if (
        not content_type
        or len(content_type) > _MAX_CONTENT_TYPE_CHARS
        or "/" not in content_type
        or any(character in content_type for character in "\r\n\x00")
    ):
        raise UserError("content_type must be a bounded MIME type")
    return content_type


def _validate_size(size_bytes: int) -> int:
    if isinstance(size_bytes, bool) or not isinstance(size_bytes, int) or size_bytes < 0:
        raise UserError("size_bytes must be a non-negative integer")
    return size_bytes


def _parse_native_attachment_path(
    organization_id: str, parent_type: str, parent_document_id: str, storage_path: str, file_name: str
) -> tuple[str, str]:
    parent_id = str(parent_document_id or "").strip()
    if not parent_id or "/" in parent_id or "\\" in parent_id:
        raise UserError("parent_document_id is invalid")
    original_name = str(file_name or "").strip()
    safe_name = safe_file_name(original_name)
    if not original_name or safe_name != original_name:
        raise UserError("file_name must already be a safe filename")
    path = str(storage_path or "").strip()
    parts = path.split("/")
    if len(parts) != 6 or any(part in {"", ".", ".."} for part in parts):
        raise UserError("storage_path must be an organization-scoped Bifrost record path")
    if parts[:4] != [organization_id, "bifrost", parent_type, parent_id] or parts[5] != safe_name:
        raise UserError("storage_path does not match the record's organization, type, and filename")
    try:
        attachment_id = str(uuid.UUID(parts[4]))
    except (ValueError, AttributeError):
        raise UserError("storage_path must include a UUID attachment segment") from None
    expected_path = f"{organization_id}/bifrost/{parent_type}/{parent_id}/{attachment_id}/{safe_name}"
    if path != expected_path:
        raise UserError("storage_path must use a canonical UUID attachment segment")
    return attachment_id, path


def validate_owned_attachment_storage_path(
    organization_id: str, attachment_id: str, data: dict[str, Any]
) -> str:
    """Accept only the deterministic key owned by this attachment metadata row."""
    path = str(data.get("storage_path") or "").strip()
    if (
        not path.startswith(f"{organization_id}/")
        or "\\" in path
        or any(part in {"", ".", ".."} for part in path.split("/"))
    ):
        raise UserError("Attachment storage_path is not organization-prefixed and safe")
    parent_type = str(data.get("parent_type") or "").strip()
    parent_id = str(data.get("parent_id") or "").strip()
    file_name = str(data.get("file_name") or "").strip()
    source_system = str(data.get("source_system") or "").strip()
    parts = path.split("/")
    if (
        parent_type not in _PARENT_TABLES
        or not parent_id
        or "/" in parent_id
        or "\\" in parent_id
        or not file_name
        or safe_file_name(file_name) != file_name
        or parts[-1] != file_name
    ):
        raise UserError("Attachment storage_path is not owned by its metadata")
    if source_system == "bifrost":
        expected = [organization_id, "bifrost", parent_type, parent_id, attachment_id, file_name]
        if parts != expected or str(data.get("source_id") or "") != attachment_id:
            raise UserError("Attachment storage_path is not owned by its metadata")
    elif source_system == "itglue":
        expected_prefix = [organization_id, "itglue", parent_type, parent_id, attachment_id]
        if len(parts) < 6 or parts[:5] != expected_prefix:
            raise UserError("Attachment storage_path is not owned by its metadata")
    else:
        raise UserError("Attachment storage_path is not owned by its metadata")
    return path


async def _write_audit(
    organization_id: str, event_type: str, attachment_id: str, *, metadata: dict[str, Any] | None = None
) -> None:
    await tables.insert(
        AUDIT_TABLE,
        {
            "organization_id": organization_id,
            "event_type": event_type,
            "entity_type": "attachment",
            "entity_id": attachment_id,
            "summary": event_type.replace(".", " "),
            "actor": str(getattr(context, "user_id", None) or "workflow"),
            "occurred_at": _now(),
            "metadata": metadata or {},
        },
    )


@workflow(
    name="docs_register_attachment",
    description="Register a verified browser-uploaded Bifrost Docs record attachment.",
)
async def docs_register_attachment(
    parent_document_id: str,
    storage_path: str,
    file_name: str,
    content_type: str,
    size_bytes: int,
    parent_type: str = "documents",
) -> dict[str, Any]:
    """Register an existing managed file only after tenant and path verification."""
    parent_id = str(parent_document_id or "").strip()
    normalized_parent_type, parent_table = _parent_table(parent_type)
    parent = await tables.get(parent_table, parent_id)
    if parent is None:
        raise UserError("Parent record not found")
    parent_data = _data(parent)
    organization_id = _require_target_org(parent_data.get("organization_id"))
    attachment_id, path = _parse_native_attachment_path(
        organization_id, normalized_parent_type, parent_id, storage_path, file_name
    )
    safe_content_type = _validate_content_type(content_type)
    safe_size = _validate_size(size_bytes)
    restricted = bool(parent_data.get("restricted"))
    location = _attachment_location(restricted)
    stat = await files.stat(path, location=location, scope=organization_id)
    if not isinstance(stat, dict) or not stat.get("exists"):
        raise UserError("Uploaded file was not found; retry the upload before registering it")
    reported_size = stat.get("size", stat.get("size_bytes"))
    if reported_size is not None:
        try:
            if int(reported_size) != safe_size:
                raise UserError("Uploaded file size does not match size_bytes")
        except (TypeError, ValueError):
            raise UserError("Uploaded file metadata has an invalid size") from None
    metadata = {
        "organization_id": organization_id,
        "source_system": "bifrost",
        "source_id": attachment_id,
        "parent_type": normalized_parent_type,
        "parent_id": parent_id,
        "file_kind": "attachment",
        "restricted": restricted,
        "file_name": file_name,
        "content_type": safe_content_type,
        "size_bytes": safe_size,
        "storage_location": location,
        "storage_path": path,
    }
    existing = await tables.get(ATTACHMENTS_TABLE, attachment_id, scope=organization_id)
    if existing is not None:
        existing_data = _data(existing)
        if any(existing_data.get(key) != value for key, value in metadata.items()):
            raise UserError("Attachment ID already belongs to another attachment")
    else:
        await tables.insert(
            ATTACHMENTS_TABLE,
            metadata,
            id=attachment_id,
            scope=organization_id,
        )
    await _write_audit(organization_id, "attachment.registered", attachment_id)
    return {
        "attachment_id": attachment_id,
        "organization_id": organization_id,
        "storage_location": location,
    }


@workflow(
    name="docs_delete_attachment",
    description="Delete a verified Bifrost Docs attachment file and its metadata with version protection.",
)
async def docs_delete_attachment(attachment_id: str) -> dict[str, Any]:
    """Delete a tenant-scoped attachment; source-owned metadata may be restored by migration."""
    row_id = str(attachment_id or "").strip()
    if not row_id:
        raise UserError("attachment_id is required")
    attachment = await tables.get(ATTACHMENTS_TABLE, row_id)
    if attachment is None:
        raise UserError("Attachment not found")
    data = _data(attachment)
    organization_id = _require_target_org(data.get("organization_id"))
    location = str(data.get("storage_location") or "").strip()
    file_kind = str(data.get("file_kind") or "").strip()
    restricted = bool(data.get("restricted"))
    if file_kind == "attachment":
        expected_location = _attachment_location(restricted)
        if location not in _ATTACHMENT_LOCATIONS:
            raise UserError("Attachment storage location is not permitted")
    elif file_kind == "document_image":
        if data.get("parent_type") != "documents" or data.get("metadata_registered") is not True:
            raise UserError("Document image metadata is not a verified managed image")
        expected_location = _content_location(restricted)
        if location not in _IMAGE_LOCATIONS:
            raise UserError("Document image storage location is not permitted")
    else:
        raise UserError("Attachment file kind is not permitted")
    if location != expected_location:
        raise UserError("Attachment storage location does not match its restriction")
    path = validate_owned_attachment_storage_path(organization_id, row_id, data)
    stat = await files.stat(path, location=location, scope=organization_id)
    if not isinstance(stat, dict):
        raise UserError("Attachment file metadata could not be verified; retry later")
    if stat.get("exists"):
        version = stat.get("version")
        if not version:
            raise UserError("Attachment file has no version for safe deletion; retry later")
        await files.delete(
            path,
            location=location,
            scope=organization_id,
            expected_version=str(version),
        )
    await tables.delete_document(ATTACHMENTS_TABLE, row_id, scope=organization_id)
    await _write_audit(organization_id, "attachment.deleted", row_id)
    return {"attachment_id": row_id, "organization_id": organization_id, "deleted": True}
