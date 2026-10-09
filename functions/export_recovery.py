"""Checkpointed recovery of source files from remotely retained IT Glue exports.

Only scoped, encrypted exports and uniquely reconciled non-password members are
read. No archive or extracted file is written to a worker's filesystem.
"""
from __future__ import annotations

import asyncio
import hashlib
import re
import secrets
import uuid
import zipfile
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import unquote, urlparse

import httpx
from bifrost import UserError, config, context, files, integrations, tables, tool, workflow, workflows

from functions.migration import (
    ACTIVE_STATUSES, ATTACHMENTS_TABLE, FILE_ORG_GRANTS_TABLE, ITEMS_TABLE,
    TRANSFER_VERSION, _absolute_platform_url, _attachment_storage_path, _data,
    _get_run, _hydrate_resource, _included_of_type, _now, _require_migration_operator,
    _update_run,
)
from modules.itglue_api import ITGlueClient, ITGlueError, _reject_unexpected_html, attributes, scrub_secrets
from modules.managed_files import complete_signed_upload
from modules.migration_core import RESOURCE_SPECS, attr, safe_file_name, stable_id
from modules.remote_zip import RemoteZipError, RemoteZipReader

STEP_REF = "functions/export_recovery.py::docs_export_recovery_step"
RECOVERY_ACTIVE = {"queued", "waiting", "running", "cancelling"}
FILE_KINDS = {"configurations", "documents", "locations", "flexible_assets"}
PUBLIC_FIELDS = {
    "status", "phase", "total_files", "recovered_files", "skipped_files", "failed_files",
    "bytes_transferred", "export_index", "export_count", "updated_at", "last_error",
}
PLAN_PAGE_SIZE = 5
MAX_PLANNED_FILES = 5000
MAX_FILE_BYTES = 5 * 1024**3  # S3 single PUT limit; larger members fail explicitly.
CHUNK_SIZE = 1024 * 1024
EXPORT_WAIT_SECONDS = 7200


def require_operator() -> None:
    """Retain the same provider/platform boundary as the migration controls."""
    if not (getattr(context, "is_platform_admin", False)
            or getattr(getattr(context, "organization", None), "is_provider", False)):
        raise UserError("Export recovery requires a provider or platform administrator")


def public_status(run_id: str, state: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"run_id": run_id, "status": "idle", "phase": "idle", "updated_at": None, "last_error": None}
    for name in PUBLIC_FIELDS - {"status", "phase", "updated_at", "last_error"}:
        result[name] = 0
    result.update({key: state[key] for key in PUBLIC_FIELDS if key in state})
    return result


def export_request(group: dict[str, Any], password: str) -> dict[str, Any]:
    kind = group["kind"]
    kinds = group.get("kinds") or [kind]
    if set(kinds) - FILE_KINDS:
        raise UserError("This source resource cannot be exported for file recovery")
    return {"data": {"type": "exports", "attributes": {
        "organization-id": int(group["source_org"]), "zip-password": password,
        "include-logs": False, "include-passwords": False, "all-flexible-assets": False,
        "core-assets-types": [value for value in kinds if value != "flexible_assets"],
        "flexible-assets-types": group.get("type_ids") or ([group["type_id"]] if kind == "flexible_assets" else []),
    }}}


def match_member(members: list[zipfile.ZipInfo], record: dict[str, Any], source_org: str, *, allow_size_mismatch: bool = False) -> zipfile.ZipInfo | None:
    """Match a unique source parent/type/name; prefer declared size when current."""
    if record["file_kind"] == "attachment" and record.get("size") is None:
        return None
    matches = []
    for member in members:
        path = PurePosixPath(member.filename.replace("\\", "/"))
        if member.is_dir() or path.is_absolute() or ".." in path.parts or not path.parts:
            continue
        if path.name != record["name"] or (not allow_size_mismatch and record.get("size") is not None and member.file_size != record["size"]):
            continue
        parts = tuple(part.casefold() for part in path.parts)
        if record["file_kind"] == "attachment":
            heads = {record["kind"]}
            if record["kind"] == "flexible_assets":
                heads |= {"flexible-assets", "flexibleassets"}
                type_name = record.get("export_type_name")
                if isinstance(type_name, str) and type_name.strip():
                    # IT Glue's exporter uses the selected type name as the
                    # folder, with spaces represented by hyphens. Retain only
                    # safe folder variants derived from verified source metadata.
                    variants = {type_name.strip(), re.sub(r"\s+", "-", type_name.strip()),
                                re.sub(r"[^A-Za-z0-9]+", "-", type_name).strip("-")}
                    heads |= {value.casefold() for value in variants
                              if value and value not in {".", ".."} and "/" not in value and "\\" not in value}
            if len(parts) >= 4 and parts[0] == "attachments" and parts[1] in heads and path.parts[2] == record["parent_source_id"]:
                matches.append(member)
        elif (record["file_kind"] == "document_image" and record["kind"] == "documents"
              and len(parts) >= 4 and parts[0] == "documents"
              and parts[-2] in {"original", "images"}):
            # Current exports place images under the owned DOC folder, with an
            # optional section folder and original/large/thumbnail variants.
            # Only original bytes (or the older direct images/ layout) qualify;
            # a stale source size must never select a preview instead.
            pattern = rf"^DOC-{re.escape(source_org)}-{re.escape(record['parent_source_id'])}(?:\s|$)"
            document_folders = [part for part in path.parts[1:-1]
                                if re.match(r"^DOC-\d+-\d+(?:\s|$)", part, re.IGNORECASE)]
            # Grouping folders may precede the DOC folder. A nested second DOC
            # folder cannot override a different parent's ownership evidence.
            if len(document_folders) == 1 and re.match(pattern, document_folders[0], re.IGNORECASE):
                matches.append(member)
    return matches[0] if len(matches) == 1 else None


async def _save(run_id: str, state: dict[str, Any]) -> None:
    _, run = await _get_run(run_id)
    current = run.get("recovery") or {}
    if current.get("generation") == state.get("generation") and current.get("cancel_requested"):
        state["cancel_requested"] = True
        if state.get("status") in {"queued", "waiting", "running"}:
            state["status"] = "cancelling"
    state["updated_at"] = _now()
    await _update_run(run_id, {"recovery": state})


async def _dispatch(run_id: str, state: dict[str, Any], *, delay: int | None = None) -> None:
    # Every checkpoint gets a new lease: late delivery of an older step cannot
    # replay export creation or overwrite a newer file checkpoint.
    _, run = await _get_run(run_id)
    previous = run.get("recovery") or {}
    if previous.get("generation") == state.get("generation") and previous.get("cancel_requested"):
        state.update(status="cancelled", cancel_requested=True)
        await _save(run_id, state)
        return
    state.update(generation=str(uuid.uuid4()), execution_id=None)
    await _save(run_id, state)
    try:
        execution_id = await workflows.execute(STEP_REF, input_data={"run_id": run_id, "generation": state["generation"]}, delay_seconds=delay)
    except Exception:
        _, run = await _get_run(run_id)
        latest = dict(run.get("recovery") or {})
        if latest.get("generation") == state["generation"]:
            latest.update(status="interrupted", last_error="Recovery scheduling was interrupted. Resume from the saved checkpoint.")
            await _save(run_id, latest)
        raise UserError("Recovery scheduling was interrupted; its checkpoint was retained") from None
    _, current = await _get_run(run_id)
    latest = dict(current.get("recovery") or {})
    if latest.get("generation") == state["generation"]:
        latest["execution_id"] = execution_id
        await _save(run_id, latest)


async def _reconcile_execution(run_id: str, state: dict[str, Any]) -> dict[str, Any]:
    if state.get("status") not in RECOVERY_ACTIVE or not state.get("execution_id"):
        return state
    execution = await workflows.get(str(state["execution_id"]))
    value = getattr(execution, "status", None)
    status = str(getattr(value, "value", value) or "").lower()
    if status in {"failed", "cancelled", "timeout", "timed_out", "success", "completed"}:
        _, current = await _get_run(run_id)
        latest = dict(current.get("recovery") or {})
        if latest.get("generation") == state.get("generation") and latest.get("status") in RECOVERY_ACTIVE:
            latest.update(status="cancelled" if latest.get("cancel_requested") else "interrupted",
                          last_error="The recovery worker stopped. Its source export and file checkpoint were retained.")
            await _save(run_id, latest)
            return latest
    return state


@tool(name="docs_export_recovery_status", description="Read safe progress for a migration's scoped export file recovery.")
async def docs_export_recovery_status(run_id: str) -> dict[str, Any]:
    _require_migration_operator()
    _, run = await _get_run(run_id)
    state = await _reconcile_execution(run_id, dict(run.get("recovery") or {}))
    return public_status(run_id, state)


def _require_idle_migration(run: dict[str, Any]) -> None:
    if run.get("status") in ACTIVE_STATUSES:
        raise UserError("Finish or cancel the active migration before recovering source files")


@tool(name="docs_export_recovery_start", description="Recover failed non-password files through encrypted scoped IT Glue exports.")
async def docs_export_recovery_start(run_id: str) -> dict[str, Any]:
    _require_migration_operator()
    _, run = await _get_run(run_id)
    _require_idle_migration(run)
    previous = run.get("recovery") or {}
    if previous.get("status") in RECOVERY_ACTIVE:
        raise UserError("Export recovery is already active")
    if previous.get("export_id"):
        raise UserError("Resume the existing recovery before starting another export")
    state = public_status(run_id, {})
    state.update(status="queued", phase="planning", generation=str(uuid.uuid4()), groups=[],
                 plan_offset=0, file_index=0, cancel_requested=False, export_id=None, secret_key=None)
    state.pop("run_id", None)
    await _dispatch(run_id, state)
    return public_status(run_id, state)


@tool(name="docs_export_recovery_resume", description="Resume export file recovery from its persisted file checkpoint.")
async def docs_export_recovery_resume(run_id: str) -> dict[str, Any]:
    _require_migration_operator()
    _, run = await _get_run(run_id)
    _require_idle_migration(run)
    state = await _reconcile_execution(run_id, dict(run.get("recovery") or {}))
    if state.get("status") not in {"cancelled", "interrupted"}:
        raise UserError("Only cancelled or interrupted export recovery can be resumed")
    state.update(status="queued", generation=str(uuid.uuid4()), cancel_requested=False, last_error=None)
    await _dispatch(run_id, state)
    return public_status(run_id, state)


@tool(name="docs_export_recovery_cancel", description="Stop export recovery at its next file checkpoint without losing progress.")
async def docs_export_recovery_cancel(run_id: str) -> dict[str, Any]:
    _require_migration_operator()
    _, run = await _get_run(run_id)
    state = dict(run.get("recovery") or {})
    if state.get("status") in RECOVERY_ACTIVE:
        state.update(status="cancelling", cancel_requested=True)
        await _save(run_id, state)
    return public_status(run_id, state)


@tool(name="docs_export_recovery_discard", description="Remove a stopped recovery's owned source export and encrypted password, retaining recovered files.")
async def docs_export_recovery_discard(run_id: str) -> dict[str, Any]:
    _require_migration_operator()
    _, run = await _get_run(run_id)
    state = await _reconcile_execution(run_id, dict(run.get("recovery") or {}))
    if state.get("status") in RECOVERY_ACTIVE:
        raise UserError("Cancel the active file recovery before discarding its source export")
    if state.get("export_id"):
        group = state["groups"][state["export_index"]]
        await _cleanup_export(await _connection(group), state)
    elif state.get("secret_key"):
        await config.delete(state["secret_key"], scope="global")
    state.update(status="idle", phase="discarded", generation=str(uuid.uuid4()), groups=[],
                 export_id=None, secret_key=None, creating_export=False, cancel_requested=False,
                 last_error=None)
    await _save(run_id, state)
    return public_status(run_id, state)


async def _connection(group: dict[str, Any]) -> Any:
    connection = await integrations.get("IT Glue", scope=group["target_org"])
    if connection is None or str(connection.entity_id) != group["source_org"]:
        raise UserError("The IT Glue organization mapping changed; recovery was stopped")
    if not connection.config.get("api_key"):
        raise UserError("The IT Glue integration has no API key")
    return connection


async def _source_api(connection: Any, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    base = str(connection.config.get("base_url") or "https://api.itglue.com").rstrip("/")
    origin = urlparse(base)
    if origin.scheme != "https" or not origin.hostname:
        raise UserError("The IT Glue API origin is invalid")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=20), follow_redirects=False) as client:
            response = await client.request(method, base + path, headers={"x-api-key": str(connection.config["api_key"])}, json=payload)
        if method == "DELETE" and response.status_code == 404:
            return {}  # Resume after deletion but before secret/checkpoint cleanup.
        if not response.is_success:
            raise UserError(f"IT Glue export operation returned HTTP {response.status_code}")
        if method == "DELETE":
            return {}
        result = response.json()
        if not isinstance(result, dict):
            raise ValueError
        return result
    except (httpx.HTTPError, ValueError):
        raise UserError("IT Glue export operation failed; no source response or URL was retained") from None


async def _plan_page(run_id: str, state: dict[str, Any]) -> None:
    page = await tables.query(ITEMS_TABLE, where={"run_id": run_id, "status": "failed"}, limit=PLAN_PAGE_SIZE, offset=state["plan_offset"])
    groups = state["groups"]
    for row in page.documents:
        item = _data(row)
        kind = str(item.get("resource_type") or "")
        if kind not in FILE_KINDS:
            continue
        target = str(item.get("organization_id") or "")
        source_org = str(item.get("source_organization_id") or "")
        parent_id = str(item.get("source_id") or "")
        spec = next(spec for spec in RESOURCE_SPECS if spec.name == kind)
        destination_id = stable_id(target, kind, parent_id)
        parent = _data(await tables.get(spec.table, destination_id))
        if parent.get("source_system") != "itglue" or parent.get("organization_id") != target or str(parent.get("source_id")) != parent_id:
            # A failed parent is not permission to attach bytes to a missing or
            # repointed destination. It remains an ordinary migration failure.
            continue
        group = {"source_org": source_org, "target_org": target, "kind": kind, "type_id": None, "files": []}
        connection = await _connection(group)
        base = connection.config.get("base_url") or "https://api.itglue.com"
        try:
            async with ITGlueClient(str(connection.config["api_key"]), base_url=str(base)) as client:
                hydrated, included, images = await _hydrate_resource(client, spec, {"id": parent_id}, source_org_id=source_org)
        except ITGlueError:
            state["last_error"] = "Some failed parents no longer expose file metadata in IT Glue. Their migration failures remain visible."
            continue
        if kind == "flexible_assets":
            group["type_id"] = str(attr(attributes(hydrated), "flexible_asset_type_id", default="") or "")
            if not group["type_id"].isdigit():
                raise UserError("A flexible asset has no verified source type for export recovery")
        type_id = group["type_id"]
        key = (source_org, target)
        existing = next((g for g in groups if (g["source_org"], g["target_org"]) == key), None)
        if existing is None:
            group.update(kinds=[], type_ids=[])
            groups.append(group)
        else:
            group = existing
        if kind not in group["kinds"]:
            group["kinds"].append(kind)
        if type_id and type_id not in group["type_ids"]:
            group["type_ids"].append(type_id)
        for source, file_kind in [(value, "attachment") for value in _included_of_type(included, "attachments")] + [(value, "document_image") for value in images]:
            if source.get("_source_missing"):
                state["total_files"] += 1
                state["failed_files"] += 1
                continue
            attrs = attributes(source)
            name = attr(attrs, "attachment_file_name", "name")
            if not name and file_kind == "document_image":
                name = PurePosixPath(unquote(urlparse(str(attr(attrs, "original_src") or "")).path)).name
            if not isinstance(name, str) or not name or not source.get("id"):
                state["total_files"] += 1
                state["failed_files"] += 1
                continue
            try:
                size = int(attr(attrs, "attachment_file_size", "size"))
            except (TypeError, ValueError):
                size = None
            record = {"kind": kind, "parent_source_id": parent_id, "parent_id": destination_id,
                      "source_id": str(source["id"]), "name": name, "size": size, "file_kind": file_kind,
                      "restricted": bool(parent.get("restricted")), "raw": scrub_secrets(source)}
            if any(f["source_id"] == record["source_id"] and f["file_kind"] == file_kind for f in group["files"]):
                continue
            if state["total_files"] >= MAX_PLANNED_FILES:
                raise UserError("This recovery exceeds 5,000 files; use separate migration scopes")
            group["files"].append(record)
            state["total_files"] += 1
    state["plan_offset"] += len(page.documents)
    if len(page.documents) < PLAN_PAGE_SIZE:
        state["groups"] = [group for group in groups if group["files"]]
        state["export_count"] = len(state["groups"])
        state["phase"] = "exports"


async def _prepare_export_type_name(connection: Any, group: dict[str, Any], record: dict[str, Any]) -> None:
    """Enrich old checkpoints using the exact selected source asset/type scope."""
    if record["kind"] != "flexible_assets" or record.get("export_type_name"):
        return
    result = await _source_api(connection, "GET", f"/flexible_assets/{record['parent_source_id']}")
    source = result.get("data") or {}
    attrs = attributes(source)
    type_id = str(attrs.get("flexible_asset_type_id") or "")
    if (str(source.get("id")) != record["parent_source_id"]
            or str(attrs.get("organization_id")) != group["source_org"]
            or type_id not in group.get("type_ids", [])):
        raise UserError("The flexible asset organization or type no longer matches its owned export scope")
    name = attrs.get("flexible_asset_type_name")
    if not isinstance(name, str) or not name.strip():
        result = await _source_api(connection, "GET", f"/flexible_asset_types/{type_id}")
        descriptor = result.get("data") or {}
        if str(descriptor.get("id")) != type_id:
            raise UserError("The selected source asset type could not be verified")
        name = attributes(descriptor).get("name")
    if not isinstance(name, str) or not name.strip():
        raise UserError("The selected source asset type has no export folder name")
    record["export_type_name"] = name


async def _owned_state(run_id: str, generation: str) -> dict[str, Any] | None:
    _, run = await _get_run(run_id)
    state = run.get("recovery") or {}
    if state.get("generation") != generation or state.get("status") not in RECOVERY_ACTIVE:
        return None
    _require_idle_migration(run)
    return dict(state)


async def _cleanup_export(connection: Any, state: dict[str, Any]) -> None:
    # Keep the ID/key in the checkpoint until both cleanup operations succeed.
    if state.get("export_id"):
        await _source_api(connection, "DELETE", f"/exports/{state['export_id']}")
    if state.get("secret_key"):
        await config.delete(state["secret_key"], scope="global")
    state.update(export_id=None, secret_key=None, export_etag=None, export_created_at=None)


async def _export_inventory(connection: Any) -> list[dict[str, Any]]:
    exports: list[dict[str, Any]] = []
    for page in range(1, 11):
        result = await _source_api(connection, "GET", f"/exports?page[size]=100&page[number]={page}")
        batch = result.get("data")
        if not isinstance(batch, list):
            raise UserError("IT Glue returned an invalid export inventory")
        exports.extend(batch)
        if len(batch) < 100:
            return exports
    raise UserError("Source export inventory exceeds its bounded recovery limit")


async def _prove_export_password(connection: Any, group: dict[str, Any], url: str, password: bytes) -> bool:
    """Prove ownership of a lost POST response without reading CSV/passwords.

    Knowing the selected scope alone cannot establish ownership: a concurrent
    IT Glue administrator may export the same organization. Fully decrypting a
    uniquely reconciled file and validating its CRC proves the generated key.
    """
    def prove() -> bool:
        reader, archive = _open_archive(url, connection)
        try:
            selections = []
            for record in group["files"]:
                member = match_member(archive.infolist(), record, group["source_org"])
                if member is not None and member.flag_bits & 1 and member.file_size <= MAX_FILE_BYTES:
                    selections.append(member)
            if not selections:
                return False
            member = min(selections, key=lambda entry: entry.file_size)
            with archive.open(member, pwd=password) as source:
                count = 0
                while chunk := source.read(CHUNK_SIZE):
                    count += len(chunk)
                    if count > member.file_size:
                        return False
                return count == member.file_size
        finally:
            archive.close()
            reader.close()
    try:
        return await asyncio.to_thread(prove)
    except Exception:
        return False


async def _reconcile_created_export(connection: Any, group: dict[str, Any], state: dict[str, Any]) -> str | None:
    previous = set(state.get("export_baseline_ids") or [])
    password = await config.get(state["secret_key"], scope="global")
    if not isinstance(password, str) or not password:
        raise UserError("The encrypted export creation key is unavailable")
    proven = []
    for record in await _export_inventory(connection):
        candidate_id = str(record.get("id") or "")
        attrs = attributes(record)
        if (not candidate_id or candidate_id in previous or str(attrs.get("organization_id")) != group["source_org"]
                or attrs.get("export_all") is not False or attrs.get("encrypted_status") is not True
                or not attrs.get("download_url")):
            continue
        if await _prove_export_password(connection, group, str(attrs["download_url"]), password.encode()):
            proven.append(candidate_id)
    if len(proven) > 1:
        raise UserError("More than one source export matched the recovery key; no job was adopted")
    return proven[0] if proven else None


def _open_archive(url: str, connection: Any) -> tuple[RemoteZipReader, zipfile.ZipFile]:
    reader = RemoteZipReader(url, api_origin=str(connection.config.get("base_url") or "https://api.itglue.com"), api_key=str(connection.config["api_key"]))
    try:
        archive = zipfile.ZipFile(reader)
        if len(archive.infolist()) > 100_000:
            raise UserError("Source archive has too many members; use a smaller export scope")
        return reader, archive
    except Exception:
        reader.close()
        raise


async def _verify_parent(group: dict[str, Any], record: dict[str, Any]) -> None:
    spec = next(spec for spec in RESOURCE_SPECS if spec.name == record["kind"])
    parent = _data(await tables.get(spec.table, record["parent_id"]))
    if (parent.get("source_system") != "itglue" or parent.get("organization_id") != group["target_org"]
            or str(parent.get("source_id")) != record["parent_source_id"]
            or bool(parent.get("restricted")) != record["restricted"]):
        raise UserError("The destination parent or its restriction changed; restart recovery to rebuild its file plan")


async def _transfer_member(run_id: str, generation: str, group: dict[str, Any], record: dict[str, Any], archive: zipfile.ZipFile, member: zipfile.ZipInfo, password: bytes) -> tuple[bool, int]:
    await _verify_parent(group, record)
    if not member.flag_bits & 1:
        raise UserError("Selected source export file is not encrypted")
    if member.file_size > MAX_FILE_BYTES or member.file_size < 0:
        raise UserError("Selected source file exceeds the supported 5-GiB transfer limit")
    target = group["target_org"]
    attachment_id = stable_id(target, record["file_kind"], record["source_id"])
    raw = record["raw"]
    attrs = attributes(raw)
    name = safe_file_name(record["name"])
    mime = str(attr(attrs, "attachment_content_type", "content_type", default="application/octet-stream"))
    location = ("docs-restricted-content" if record["file_kind"] == "document_image" else "docs-restricted-attachments") if record["restricted"] else ("docs-content" if record["file_kind"] == "document_image" else "docs-attachments")
    path = _attachment_storage_path(target, record["kind"], record["parent_id"], attachment_id, name, raw)
    prior = _data(await tables.get(ATTACHMENTS_TABLE, attachment_id))
    if (prior.get("storage_path") == path and prior.get("metadata_registered") is True
            and prior.get("transfer_version") == TRANSFER_VERSION and not prior.get("quarantined")
            and not prior.get("integrity_error") and re.fullmatch(r"[0-9a-f]{64}", str(prior.get("sha256") or ""))
            and await files.exists(path, location=location, scope=target)):
        return False, 0
    await tables.upsert(FILE_ORG_GRANTS_TABLE, stable_id(target, "file-org-grant", target), {"organization_id": target, "path_prefix": target})
    signed = await files.get_signed_url(path, method="PUT", content_type=mime, location=location, scope=target)
    url = _absolute_platform_url(signed["url"])
    source = await asyncio.to_thread(archive.open, member, "r", password)
    digest = hashlib.sha256()
    transferred = 0
    try:
        leading = await asyncio.to_thread(source.read, CHUNK_SIZE)
        _reject_unexpected_html(mime, None, [leading])

        async def chunks():
            nonlocal transferred
            chunk = leading
            while chunk:
                current = await _owned_state(run_id, generation)
                if current is None or current.get("cancel_requested"):
                    raise UserError("Source file transfer stopped at a recovery checkpoint")
                transferred += len(chunk)
                if transferred > member.file_size:
                    raise UserError("Source export member exceeds its declared size")
                digest.update(chunk)
                yield chunk
                chunk = await asyncio.to_thread(source.read, CHUNK_SIZE)

        async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=20), follow_redirects=False) as client:
            response = await client.put(url, headers={"Content-Type": mime, "Content-Length": str(member.file_size)}, content=chunks())
            if not response.is_success or transferred != member.file_size:
                raise UserError("Recovered file upload did not finish with the expected byte count")
            read_url = await files.get_signed_url(path, method="GET", location=location, scope=target)
            observed = hashlib.sha256()
            observed_size = 0
            async with client.stream("GET", _absolute_platform_url(read_url["url"])) as download:
                if not download.is_success:
                    raise UserError("Recovered file could not be verified in destination storage")
                async for chunk in download.aiter_bytes(CHUNK_SIZE):
                    observed_size += len(chunk)
                    if observed_size > transferred:
                        raise UserError("Recovered file verification exceeded the expected size")
                    observed.update(chunk)
            if observed_size != transferred or observed.hexdigest() != digest.hexdigest():
                raise UserError("Recovered file destination hash did not match its source bytes")
        current = await _owned_state(run_id, generation)
        if current is None or current.get("cancel_requested"):
            raise UserError("Source file transfer stopped before metadata registration")
        await _verify_parent(group, record)
        await complete_signed_upload(path=path, location=location, scope=target, content_type=mime, size_bytes=transferred, sha256=digest.hexdigest())
        await tables.upsert(ATTACHMENTS_TABLE, attachment_id, {
            "organization_id": target, "source_system": "itglue", "source_id": record["source_id"],
            "parent_type": record["kind"], "parent_id": record["parent_id"], "file_kind": record["file_kind"],
            "restricted": record["restricted"], "file_name": name, "content_type": mime,
            "size_bytes": transferred, "declared_size_bytes": record["size"], "size_verified": record["size"] == transferred,
            "transfer_version": TRANSFER_VERSION, "metadata_registered": True,
            "storage_location": location, "storage_path": path, "source_updated_at": attr(attrs, "updated_at"),
            "sha256": digest.hexdigest(), "quarantined": False, "integrity_error": None,
            "raw": raw, "recovered_from_export": True,
        })
        return True, transferred
    finally:
        await asyncio.to_thread(source.close)


@workflow(name="docs_export_recovery_step", description="Process one durable source export/file recovery checkpoint without local archive storage.")
async def docs_export_recovery_step(run_id: str, generation: str) -> dict[str, Any]:
    _require_migration_operator()
    state = await _owned_state(run_id, generation)
    if state is None:
        return {"run_id": run_id, "status": "superseded"}
    if state.get("cancel_requested"):
        state["status"] = "cancelled"
        await _save(run_id, state)
        return public_status(run_id, state)
    state["status"] = "running"
    execution_id = getattr(context, "execution_id", None)
    if execution_id:
        state["execution_id"] = str(execution_id)
    await _save(run_id, state)
    try:
        if state["phase"] == "planning":
            await _plan_page(run_id, state)
            await _dispatch(run_id, state)
            return public_status(run_id, state)
        if state["export_index"] >= len(state["groups"]):
            state.update(status="completed_with_errors" if state["failed_files"] else "completed", phase="complete")
            await _save(run_id, state)
            return public_status(run_id, state)
        group = state["groups"][state["export_index"]]
        connection = await _connection(group)
        if state["phase"] == "cleanup":
            await _cleanup_export(connection, state)
            state.update(export_index=state["export_index"] + 1, file_index=0, phase="exports")
            await _dispatch(run_id, state)
            return public_status(run_id, state)
        if not state.get("export_id"):
            if state.get("creating_export"):
                adopted = await _reconcile_created_export(connection, group, state)
                if adopted is None:
                    from datetime import datetime, timezone
                    age = (datetime.now(timezone.utc) - datetime.fromisoformat(state["export_created_at"])).total_seconds()
                    if age > EXPORT_WAIT_SECONDS:
                        raise UserError("The lost export creation response could not be reconciled within two hours; the recovery can be discarded without deleting unproven source jobs")
                    state.update(status="waiting", phase="exports")
                    await _dispatch(run_id, state, delay=30)
                    return public_status(run_id, state)
                state.update(export_id=adopted, creating_export=False)
            else:
                inventory = await _export_inventory(connection)
                if not state.get("secret_key"):
                    state["secret_key"] = f"bifrost_docs_export_recovery_{run_id}_{state['export_index']}_{generation}"
                    # Persist the owned secret reference before storing its
                    # value, so runner loss cannot orphan a global secret.
                    await _save(run_id, state)
                password = await config.get(state["secret_key"], scope="global")
                if not isinstance(password, str) or not password:
                    password = secrets.token_urlsafe(32)
                    await config.set(state["secret_key"], password, is_secret=True, scope="global")
                state.update(creating_export=True, export_baseline_ids=[str(row["id"]) for row in inventory],
                             export_created_at=_now(), export_passwords_excluded=True)
                await _save(run_id, state)
                created = await _source_api(connection, "POST", "/exports", export_request(group, password))
                export_id = (created.get("data") or {}).get("id")
                if not export_id:
                    raise UserError("IT Glue did not return the new scoped export ID")
                state.update(export_id=str(export_id), creating_export=False)
            await _save(run_id, state)
        metadata = await _source_api(connection, "GET", f"/exports/{state['export_id']}")
        attrs = attributes(metadata.get("data") or {})
        if (str(attrs.get("organization_id")) != group["source_org"] or attrs.get("export_all") is not False
                or state.get("export_passwords_excluded") is not True or attrs.get("include_passwords") is True):
            raise UserError("IT Glue export scope or password exclusion could not be verified")
        url = attrs.get("download_url")
        if not url:
            from datetime import datetime, timezone
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(state["export_created_at"])).total_seconds()
            if age > EXPORT_WAIT_SECONDS:
                raise UserError("IT Glue export generation exceeded two hours; resume after checking source availability")
            state.update(status="waiting", phase="exports")
            await _dispatch(run_id, state, delay=30)
            return public_status(run_id, state)
        if attrs.get("encrypted_status") is not True:
            raise UserError("IT Glue export encryption could not be verified")
        password = await config.get(state["secret_key"], scope="global")
        if not isinstance(password, str) or not password:
            raise UserError("The encrypted recovery password is unavailable; the existing source job was retained")
        reader, archive = await asyncio.to_thread(_open_archive, str(url), connection)
        try:
            if state.get("export_etag") and state["export_etag"] != reader.etag:
                raise UserError("The source export changed after a file checkpoint")
            state["export_etag"] = reader.etag
            state["phase"] = "files"
            await _save(run_id, state)
            record = group["files"][state["file_index"]]
            await _prepare_export_type_name(connection, group, record)
            member = match_member(archive.infolist(), record, group["source_org"])
            if member is None and record.get("size") is not None:
                # Source size metadata can be stale. A unique type/parent/name
                # match is still pinned to this owned encrypted export; its CRC,
                # exact byte count and destination SHA-256 must all verify.
                member = match_member(archive.infolist(), record, group["source_org"], allow_size_mismatch=True)
            if member is None:
                state["failed_files"] += 1
                state["last_error"] = "A selected file had no unique parent/name/size match in its scoped source export. Its migration failure remains visible."
            else:
                recovered, count = await _transfer_member(run_id, generation, group, record, archive, member, password.encode())
                state["recovered_files" if recovered else "skipped_files"] += 1
                state["bytes_transferred"] += count
            state["file_index"] += 1
        finally:
            await asyncio.to_thread(archive.close)
            await asyncio.to_thread(reader.close)
        current = await _owned_state(run_id, generation)
        if current is None:
            return {"run_id": run_id, "status": "superseded"}
        if current.get("cancel_requested"):
            state.update(status="cancelled", cancel_requested=True)
            await _save(run_id, state)
            return public_status(run_id, state)
        if state["file_index"] >= len(group["files"]):
            state["phase"] = "cleanup"
            await _save(run_id, state)
            await _cleanup_export(connection, state)
            state.update(export_index=state["export_index"] + 1, file_index=0, phase="exports")
        await _dispatch(run_id, state)
    except Exception as exc:
        current = await _owned_state(run_id, generation)
        if current is not None:
            # Source/ZIP/HTTP exceptions can include protected URLs, passwords,
            # or archive names. Only the phase is retained for operator status.
            state.update(status="cancelled" if current.get("cancel_requested") else "interrupted",
                         cancel_requested=bool(current.get("cancel_requested")),
                         last_error=(str(exc) if isinstance(exc, RemoteZipError) else
                                     f"File recovery stopped during {state.get('phase', 'recovery')}. Progress and the encrypted source job were retained; resume to retry."))
            await _save(run_id, state)
        else:
            return {"run_id": run_id, "status": "superseded"}
    return public_status(run_id, state)
