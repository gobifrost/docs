"""Pure migration helpers shared by workflows and unit tests."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from typing import Any, Mapping

NAMESPACE = uuid.UUID("bc379242-26d8-5fc6-9986-b659b8ab71f4")


def stable_id(target_org_id: str, resource_type: str, source_id: str) -> str:
    material = f"bifrost-docs:{target_org_id}:{resource_type}:{source_id}"
    return str(uuid.uuid5(NAMESPACE, material))


def migration_item_id(
    run_id: str,
    target_org_id: str,
    resource_type: str,
    source_id: str,
) -> str:
    """Identify one source row inside one target-organization run ledger."""
    return str(
        uuid.uuid5(
            NAMESPACE,
            f"run:{run_id}:{target_org_id}:{resource_type}:{source_id}",
        )
    )


def migration_cursor_key(
    source_org_id: str, target_org_id: str, resource_type: str
) -> str:
    """Scope a durable pagination checkpoint to one source-to-target mapping."""
    return f"{source_org_id}:{target_org_id}:{resource_type}"


def flexible_asset_cursor_key(source_org_id: str, target_org_id: str, source_type_id: str) -> str:
    """Scope flexible-asset pagination to one source organization and source type."""
    return migration_cursor_key(source_org_id, target_org_id, f"flexible_assets:{source_type_id}")


def source_map_id(target_org_id: str, resource_type: str, source_id: str) -> str:
    return stable_id(target_org_id, f"map:{resource_type}", source_id)


def reconciliation_finding_id(
    run_id: str,
    target_org_id: str,
    resource_type: str,
    source_id: str,
    finding_type: str,
) -> str:
    return stable_id(
        target_org_id,
        f"reconciliation:{run_id}:{resource_type}:{finding_type}",
        source_id,
    )


def source_is_unchanged(
    source_updated_at: Any,
    mapped_updated_at: Any,
    destination_exists: bool,
    source_fingerprint: str | None = None,
    mapped_fingerprint: str | None = None,
) -> bool:
    """Compare source state without treating a missing watermark as unchanged."""
    if not destination_exists:
        return False
    if source_updated_at is not None or mapped_updated_at is not None:
        return (
            source_updated_at is not None
            and mapped_updated_at is not None
            and str(source_updated_at) == str(mapped_updated_at)
        )
    return bool(source_fingerprint and mapped_fingerprint and source_fingerprint == mapped_fingerprint)


def canonical_source_fingerprint(source: Any) -> str:
    """Hash a canonical source projection after redacting secret-shaped values."""
    secret_keys = {
        "password",
        "password_value",
        "password-value",
        "otp_secret",
        "otp-secret",
        "totp_secret",
        "totp-secret",
        "download_url",
        "download-url",
        "original_src",
        "original-src",
    }

    def redact(value: Any) -> Any:
        if isinstance(value, Mapping):
            return {
                str(key): "[REDACTED]" if str(key).casefold() in secret_keys else redact(item)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [redact(item) for item in value]
        return value

    canonical = json.dumps(
        redact(source),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def hydrated_document_content_fingerprint(source: Any) -> str:
    """Fingerprint document-owned source fields, excluding separately synced files.

    IT Glue may leave a document's ``updated_at`` unchanged when an attachment
    or image changes. Those child records must still be reconciled, but their
    metadata must not make a locally edited document body look source-changed.
    Section text and document attributes remain in this projection because they
    are the document's source-owned presentation.
    """
    if not isinstance(source, Mapping):
        return canonical_source_fingerprint(source)

    projection: dict[str, Any] = {}
    for key, value in source.items():
        normalized = str(key).replace("-", "_")
        if normalized == "_included":
            continue
        if normalized != "_sections" or not isinstance(value, list):
            projection[str(key)] = value
            continue
        sections: list[Any] = []
        for section in value:
            if not isinstance(section, Mapping):
                sections.append(section)
                continue
            section_copy = dict(section)
            section_attrs = section_copy.get("attributes")
            if isinstance(section_attrs, Mapping):
                section_copy["attributes"] = {
                    str(attr_key): attr_value
                    for attr_key, attr_value in section_attrs.items()
                    if str(attr_key).replace("-", "_") != "document_images"
                }
            sections.append(section_copy)
        projection[str(key)] = sections
    return canonical_source_fingerprint(projection)


def redact_named_fields(value: Any, field_names: list[str] | set[str]) -> Any:
    """Recursively redact arbitrary flexible-asset field names known to be secret."""
    sensitive = {str(name).strip().casefold() for name in field_names if str(name).strip()}
    if isinstance(value, Mapping):
        return {
            key: (
                "[REDACTED]"
                if str(key).strip().casefold() in sensitive
                else redact_named_fields(item, sensitive)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_named_fields(item, sensitive) for item in value]
    return value


def _normalized_trait_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").casefold())


def project_flexible_asset_traits(
    traits: Any,
    field_definitions: list[dict[str, Any]],
    included: list[dict[str, Any]],
    source_id: str,
) -> tuple[dict[str, Any], list[str]]:
    """Retain only trait values whose IT Glue field type safely identifies them.

    Flexible-asset traits are a schema-less JSON object.  Their keys are the
    field ``name-key`` values, so an unknown key or a rich value that does not
    fit its declared field kind is intentionally redacted rather than guessed.
    """
    declared_kinds: dict[str, str] = {}
    for field in field_definitions:
        if not isinstance(field, Mapping):
            continue
        raw = field.get("attributes")
        attrs = raw if isinstance(raw, Mapping) else field
        kind = str(attr(attrs, "kind", "field_type", default="") or "").casefold()
        for name in (attr(attrs, "name_key"), attr(attrs, "name")):
            normalized = _normalized_trait_key(name)
            if normalized:
                declared_kinds[normalized] = kind

    included_password_names: set[str] = set()
    for item in included:
        if not isinstance(item, Mapping) or str(item.get("type", "")).replace("-", "_") != "passwords":
            continue
        raw = item.get("attributes")
        attrs = raw if isinstance(raw, Mapping) else {}
        parent_id = str(attr(attrs, "resource_id", default="") or "")
        if parent_id and parent_id != source_id:
            continue
        for name in (attr(attrs, "name_key"), attr(attrs, "field_name"), attr(attrs, "name")):
            normalized = _normalized_trait_key(name)
            if normalized:
                included_password_names.add(normalized)

    if not isinstance(traits, Mapping):
        return {}, []

    safe_traits: dict[str, Any] = {}
    redacted_fields: list[str] = []
    rich_kinds = {"tag", "upload"}
    for name, value in traits.items():
        normalized = _normalized_trait_key(name)
        kind = declared_kinds.get(normalized, "")
        is_password = kind == "password" or normalized in included_password_names
        is_ambiguous = not kind or (
            isinstance(value, (Mapping, list)) and kind not in rich_kinds
        )
        key = str(name)
        if is_password or is_ambiguous:
            safe_traits[key] = "[REDACTED]"
            redacted_fields.append(key)
        else:
            safe_traits[key] = value
    return safe_traits, sorted(redacted_fields)


def safe_file_name(value: str | None) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", (value or "file").strip()).strip("._")
    return (cleaned or "file")[:180]


def attr(data: Mapping[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        alternatives = (name, name.replace("_", "-"), name.replace("-", "_"))
        for alternative in alternatives:
            if alternative in data:
                return data[alternative]
    return default


@dataclass(frozen=True)
class ResourceSpec:
    name: str
    endpoint: str
    table: str
    include: str | None = None


def source_detail_path(spec: ResourceSpec, source_id: str, source_org_id: str | None = None) -> str:
    """Return the supported IT Glue detail route, failing closed for scoped folders."""
    if spec.name in {"document_folders", "password_folders"}:
        organization_id = str(source_org_id or "").strip()
        if not organization_id:
            raise ValueError(f"{spec.name} detail requires a source organization")
        return f"/organizations/{organization_id}/relationships/{spec.name}/{source_id}"
    return f"/{spec.name}/{source_id}"


RESOURCE_SPECS: tuple[ResourceSpec, ...] = (
    # IT Glue exposes configuration taxonomy at account scope.  The migration
    # intentionally projects it into each mapped Bifrost organization.
    ResourceSpec("configuration_types", "/configuration_types", "docs-configuration-types"),
    ResourceSpec("configuration_statuses", "/configuration_statuses", "docs-configuration-statuses"),
    ResourceSpec("flexible_asset_types", "/flexible_asset_types", "docs-flexible-asset-types"),
    ResourceSpec("document_folders", "/organizations/{org}/relationships/document_folders", "docs-document-folders"),
    ResourceSpec("password_folders", "/organizations/{org}/relationships/password_folders", "docs-password-folders"),
    ResourceSpec("locations", "/organizations/{org}/relationships/locations", "docs-locations", "attachments,related_items"),
    ResourceSpec("configurations", "/organizations/{org}/relationships/configurations", "docs-configurations", "configuration_interfaces,attachments,related_items"),
    ResourceSpec("documents", "/organizations/{org}/relationships/documents", "docs-documents", "attachments,related_items"),
    ResourceSpec("flexible_assets", "/organizations/{org}/relationships/flexible_assets", "docs-flexible-assets", "attachments,passwords,related_items"),
    ResourceSpec("passwords", "/organizations/{org}/relationships/passwords", "docs-passwords", "attachments,related_items"),
)


DEFAULT_RESOURCE_TYPES = tuple(spec.name for spec in RESOURCE_SPECS)


_RELATED_ITEM_RESOURCE_KIND_ALIASES = {
    "configuration": "configurations",
    "configurations": "configurations",
    "location": "locations",
    "locations": "locations",
    "document": "documents",
    "documents": "documents",
    "document/folder": "document_folders",
    "document_folder": "document_folders",
    "document_folders": "document_folders",
    "flexible_asset": "flexible_assets",
    "flexible_assets": "flexible_assets",
    "password": "passwords",
    "passwords": "passwords",
}


def canonical_related_item_resource_kind(value: Any) -> str | None:
    """Map IT Glue related-item asset types to supported Docs resource kinds."""
    normalized = str(value or "").strip().casefold().replace("-", "_")
    canonical = _RELATED_ITEM_RESOURCE_KIND_ALIASES.get(normalized)
    if canonical in DEFAULT_RESOURCE_TYPES:
        return canonical
    return None
