"""Tenant-safe native document-folder hierarchy workflows."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from bifrost import UserError, context, tables, workflow


FOLDERS_TABLE = "docs-document-folders"
AUDIT_TABLE = "docs-audit-events"
_PAGE_SIZE = 200


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


def _normalize_id(value: Any, name: str, *, required: bool = False) -> str | None:
    normalized = str(value or "").strip()
    if not normalized:
        if required:
            raise UserError(f"{name} is required")
        return None
    return normalized


def _may_cross_organization() -> bool:
    organization = getattr(context, "organization", None)
    return bool(
        getattr(context, "is_platform_admin", False)
        or getattr(organization, "is_provider", False)
    )


def _require_folder_organization(data: dict[str, Any]) -> str:
    organization_id = _normalize_id(data.get("organization_id"), "Folder organization", required=True)
    caller_org_id = _normalize_id(getattr(context, "org_id", None), "organization", required=True)
    if not _may_cross_organization() and organization_id != caller_org_id:
        raise UserError("You can change only folders in your own organization")
    return organization_id


async def _get_folder(folder_id: str) -> tuple[str, dict[str, Any], str]:
    normalized_id = _normalize_id(folder_id, "folder_id", required=True)
    row = await tables.get(FOLDERS_TABLE, normalized_id)
    if row is None:
        raise UserError("Document folder not found")
    data = _data(row)
    return normalized_id, data, _require_folder_organization(data)


async def _visible_organization_folders(organization_id: str) -> dict[str, dict[str, Any]]:
    folders: dict[str, dict[str, Any]] = {}
    offset = 0
    while True:
        page = await tables.query(
            FOLDERS_TABLE,
            where={"organization_id": organization_id},
            order_by="created_at",
            order_dir="asc",
            limit=_PAGE_SIZE,
            offset=offset,
            scope=organization_id,
        )
        documents = list(getattr(page, "documents", None) or [])
        added = 0
        for row in documents:
            row_id = _normalize_id(getattr(row, "id", None), "folder_id")
            data = _data(row)
            if row_id is None or str(data.get("organization_id") or "") != organization_id:
                continue
            if row_id not in folders:
                folders[row_id] = data
                added += 1
        if not documents:
            return folders
        if added == 0:
            raise UserError("Document folder hierarchy cannot be safely enumerated")
        if len(documents) < _PAGE_SIZE:
            return folders
        offset += len(documents)


def _subtree_ids(folders: dict[str, dict[str, Any]], folder_id: str) -> list[str]:
    children: dict[str, list[str]] = {}
    for child_id, data in folders.items():
        parent_id = _normalize_id(data.get("parent_id"), "parent_id")
        if parent_id:
            children.setdefault(parent_id, []).append(child_id)
    subtree: list[str] = []
    pending = [folder_id]
    seen: set[str] = set()
    while pending:
        current = pending.pop(0)
        if current in seen:
            continue
        seen.add(current)
        subtree.append(current)
        pending.extend(children.get(current, []))
    return subtree


def _ancestor_ids(folders: dict[str, dict[str, Any]], parent_id: str | None) -> list[str]:
    lineage: list[str] = []
    seen: set[str] = set()
    current = parent_id
    while current:
        if current in seen:
            raise UserError("Document folder hierarchy contains a cycle")
        seen.add(current)
        data = folders.get(current)
        if data is None:
            raise UserError("Document folder hierarchy cannot be safely moved because an ancestor is unavailable")
        lineage.append(current)
        current = _normalize_id(data.get("parent_id"), "parent_id")
    lineage.reverse()
    return lineage


async def _write_audit(
    organization_id: str, event_type: str, folder_id: str, metadata: dict[str, Any]
) -> None:
    await tables.insert(
        AUDIT_TABLE,
        {
            "organization_id": organization_id,
            "event_type": event_type,
            "entity_type": "document_folder",
            "entity_id": folder_id,
            "summary": event_type.replace(".", " "),
            "actor": str(getattr(context, "user_id", None) or "workflow"),
            "occurred_at": _now(),
            "metadata": metadata,
        },
    )


@workflow(
    name="docs_move_document_folder",
    description="Move a local Bifrost Docs folder copy and recompute its visible descendant hierarchy.",
    category="Bifrost Docs",
)
async def docs_move_document_folder(folder_id: str, parent_id: str | None = None) -> dict[str, Any]:
    """Move a local folder copy without changing ownership or restriction fields."""
    normalized_folder_id, folder, organization_id = await _get_folder(folder_id)
    normalized_parent_id = _normalize_id(parent_id, "parent_id")
    target_is_restricted = False

    if normalized_parent_id:
        _, parent, parent_organization_id = await _get_folder(normalized_parent_id)
        if parent_organization_id != organization_id:
            raise UserError("Document folder parent belongs to another organization")
        target_is_restricted = bool(parent.get("restricted"))

    folders = await _visible_organization_folders(organization_id)
    folders[normalized_folder_id] = folder
    if normalized_parent_id:
        folders[normalized_parent_id] = parent
    subtree_ids = _subtree_ids(folders, normalized_folder_id)
    if normalized_parent_id in subtree_ids:
        raise UserError("A document folder cannot be moved into itself or a descendant")
    if target_is_restricted:
        raise UserError(
            "Moving a folder into a restricted folder requires a restriction promotion workflow"
        )

    parent_ancestors = _ancestor_ids(folders, normalized_parent_id)
    changes: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    pending: list[tuple[str, list[str]]] = [(normalized_folder_id, parent_ancestors)]
    children: dict[str, list[str]] = {}
    for child_id in subtree_ids:
        if child_id == normalized_folder_id:
            continue
        old_parent_id = _normalize_id(folders[child_id].get("parent_id"), "parent_id")
        if old_parent_id:
            children.setdefault(old_parent_id, []).append(child_id)
    scheduled: set[str] = set()
    while pending:
        current_id, ancestors = pending.pop(0)
        if current_id in scheduled:
            raise UserError("Document folder hierarchy contains a cycle")
        scheduled.add(current_id)
        current_data = folders[current_id]
        if current_id == normalized_folder_id:
            update = {"parent_id": normalized_parent_id, "ancestor_ids": ancestors}
            previous = {
                "parent_id": current_data.get("parent_id"),
                "ancestor_ids": current_data.get("ancestor_ids"),
            }
        else:
            update = {"ancestor_ids": ancestors}
            previous = {"ancestor_ids": current_data.get("ancestor_ids")}
        changes.append((current_id, update, previous))
        for child_id in children.get(current_id, []):
            pending.append((child_id, [*ancestors, current_id]))

    applied: list[tuple[str, dict[str, Any]]] = []
    try:
        for current_id, update, previous in changes:
            await tables.update(FOLDERS_TABLE, current_id, update, scope=organization_id)
            applied.append((current_id, previous))
    except Exception as write_error:
        rollback_failed = False
        for current_id, previous in reversed(applied):
            try:
                await tables.update(FOLDERS_TABLE, current_id, previous, scope=organization_id)
            except Exception:
                rollback_failed = True
        event_type = "document_folder.move_rollback_failed" if rollback_failed else "document_folder.move_reverted"
        try:
            await _write_audit(
                organization_id,
                event_type,
                normalized_folder_id,
                {"parent_id": normalized_parent_id, "updated_count": len(applied)},
            )
        except Exception:
            pass
        if rollback_failed:
            raise UserError(
                "Document folder move failed and the automatic hierarchy rollback could not be completed"
            ) from write_error
        raise UserError("Document folder move failed; hierarchy changes were rolled back") from write_error

    await _write_audit(
        organization_id,
        "document_folder.moved",
        normalized_folder_id,
        {"parent_id": normalized_parent_id, "updated_count": len(changes)},
    )
    return {
        "folder_id": normalized_folder_id,
        "organization_id": organization_id,
        "parent_id": normalized_parent_id,
        "updated_count": len(changes),
    }
