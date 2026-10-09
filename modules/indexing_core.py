"""Safe, deterministic projection of Bifrost Docs rows into knowledge entries.

Knowledge has organization scoping but no document-row ACL.  This module is
therefore deliberately conservative: only non-restricted, non-archived document
rows with a stable source citation can be indexed, and an indication of secret
material rejects the entire row rather than attempting to redact it.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any


DOCUMENT_NAMESPACE = "bifrost-docs-documents"
KEY_PREFIX = "bifrost-docs:documents"

_SENSITIVE_KEY_PARTS = frozenset(
    {
        "access_token",
        "api_key",
        "authorization",
        "bearer_token",
        "client_secret",
        "credential",
        "encrypted_client_secret",
        "password",
        "private_key",
        "refresh_token",
        "secret",
        "secret_ciphertext",
        "secret_nonce",
        "token",
        "totp",
        "totp_secret",
    }
)
_SENSITIVE_KEY_FRAGMENTS = (
    "api_key",
    "authorization",
    "credential",
    "password",
    "private_key",
    "secret",
    "token",
    "totp",
)
_SENSITIVE_CONTENT = re.compile(
    r"(?:"
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"
    r"|\b(?:api[ _-]?key|client[ _-]?secret|password|refresh[ _-]?token|"
    r"access[ _-]?token|totp(?:[ _-]?secret)?)\s*(?::|=|is)\s*\S{6,}"
    r"|\b(?:authorization\s*:\s*bearer|bearer)\s+[A-Za-z0-9._~+/-]{12,}"
    r")",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class KnowledgeEntry:
    """The only safe data shape passed to the Bifrost knowledge SDK."""

    namespace: str
    key: str
    content: str
    metadata: dict[str, str]


@dataclass(frozen=True)
class IndexDecision:
    """A projected entry, or a non-sensitive reason it was rejected."""

    entry: KnowledgeEntry | None
    reason: str | None = None


def contains_secret_like_text(value: Any) -> bool:
    """Return whether plain text has a credential-shaped value."""
    return bool(_SENSITIVE_CONTENT.search(str(value or "")))


def document_key(organization_id: str, document_id: str) -> str:
    """Return the durable key for one ``docs-documents`` row.

    ``document_id`` is the solution's stable destination ID, so migration
    upserts and deletes can address the exact same knowledge document without
    relying on mutable titles or source metadata.
    """
    org = str(organization_id or "").strip()
    document = str(document_id or "").strip()
    if not org or not document:
        raise ValueError("organization_id and document_id are required")
    return f"{KEY_PREFIX}:{org}:{document}"


def _is_truthy(value: Any) -> bool:
    return value is True or (
        isinstance(value, str) and value.strip().casefold() in {"true", "1", "yes"}
    )


def _contains_sensitive_data(value: Any, depth: int = 0) -> bool:
    """Reject nested row data containing a secret-shaped key or value.

    A deep/unexpected payload is rejected rather than trusted. ``raw`` is not
    indexed, but is still inspected so a future projection change cannot make a
    known sensitive source row indexable by accident.
    """
    if depth > 12:
        return True
    if isinstance(value, Mapping):
        for key, nested in value.items():
            normalized = str(key).casefold().replace("-", "_").replace(" ", "_")
            if (
                normalized in _SENSITIVE_KEY_PARTS
                or any(fragment in normalized for fragment in _SENSITIVE_KEY_FRAGMENTS)
            ):
                return True
            if _contains_sensitive_data(nested, depth + 1):
                return True
        return False
    if isinstance(value, (list, tuple, set)):
        return any(_contains_sensitive_data(item, depth + 1) for item in value)
    return False


def _display_source_system(source_system: str) -> str:
    if source_system.casefold() == "itglue":
        return "IT Glue"
    if source_system.casefold() == "bifrost":
        return "Bifrost"
    return source_system


def _native_ticket_citation(source_refs: Any) -> str:
    """Return a bounded, citation-only rendering of trusted native ticket refs."""
    if not isinstance(source_refs, (list, tuple)):
        return ""
    citations: list[str] = []
    for ref in source_refs[:3]:
        if not isinstance(ref, Mapping):
            continue
        ticket_id = str(ref.get("ticket_id") or "").strip()
        ticket_url = str(ref.get("ticket_url") or "").strip()
        if (
            not ticket_id
            or not ticket_url
            or contains_secret_like_text(ticket_id)
            or contains_secret_like_text(ticket_url)
        ):
            continue
        citations.append(f"ticket {ticket_id[:200]}: {ticket_url[:500]}")
    return "; ".join(citations)


def project_document(
    data: Mapping[str, Any], *, organization_id: str, document_id: str
) -> IndexDecision:
    """Return a safe index entry for one scoped document row, or reject it."""
    target_org = str(organization_id or "").strip()
    row_org = str(data.get("organization_id") or "").strip()
    if not target_org or row_org != target_org:
        return IndexDecision(None, "organization_mismatch")
    if _is_truthy(data.get("restricted")):
        return IndexDecision(None, "restricted")
    if _is_truthy(data.get("archived")):
        return IndexDecision(None, "archived")
    source_system = str(data.get("source_system") or "itglue").strip() or "itglue"
    status = str(data.get("status") or "").casefold()
    if status in {"draft", "archived", "restricted"}:
        return IndexDecision(None, "not_published")
    # Native material stays outside knowledge until a Docs Admin explicitly
    # publishes it.  Imported rows predate native publication lifecycle and
    # retain their established eligibility behavior.
    if source_system.casefold() == "bifrost" and status != "published":
        return IndexDecision(None, "not_published")
    source_id = str(data.get("source_id") or "").strip()
    if not source_id:
        return IndexDecision(None, "missing_source_id")
    if _contains_sensitive_data(data):
        return IndexDecision(None, "sensitive_data")

    content = str(data.get("rendered_content") or data.get("content") or "").strip()
    if not content:
        return IndexDecision(None, "missing_content")
    title = str(data.get("name") or "Untitled document").strip() or "Untitled document"
    if contains_secret_like_text(content) or contains_secret_like_text(title):
        return IndexDecision(None, "sensitive_content")
    citation = f"{_display_source_system(source_system)} document {source_id}: {title}"
    if source_system.casefold() == "bifrost":
        ticket_citation = _native_ticket_citation(data.get("source_refs"))
        if ticket_citation:
            citation = f"{citation}; {ticket_citation}"
    metadata = {
        "product": "bifrost-docs",
        "resource_type": "document",
        "organization_id": target_org,
        "document_id": str(document_id),
        "source_system": source_system,
        "source_id": source_id,
        "source_updated_at": str(data.get("source_updated_at") or ""),
        "title": title,
        "citation": citation,
    }
    return IndexDecision(
        KnowledgeEntry(
            namespace=DOCUMENT_NAMESPACE,
            key=document_key(target_org, document_id),
            content=content,
            metadata=metadata,
        )
    )
