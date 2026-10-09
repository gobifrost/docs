from modules.indexing_core import (
    DOCUMENT_NAMESPACE,
    document_key,
    project_document,
)


def test_document_key_is_stable_and_scoped_to_its_bifrost_org() -> None:
    assert document_key("org-a", "document-1") == (
        "bifrost-docs:documents:org-a:document-1"
    )


def test_project_document_builds_a_citable_safe_knowledge_entry() -> None:
    decision = project_document(
        {
            "organization_id": "org-a",
            "source_system": "itglue",
            "source_id": "source-123",
            "source_updated_at": "2026-09-22T10:00:00Z",
            "name": "VPN setup",
            "rendered_content": "Use the managed VPN client to connect.",
            "archived": False,
            "restricted": False,
        },
        organization_id="org-a",
        document_id="document-1",
    )

    assert decision.reason is None
    assert decision.entry is not None
    assert decision.entry.namespace == DOCUMENT_NAMESPACE
    assert decision.entry.key == document_key("org-a", "document-1")
    assert decision.entry.content == "Use the managed VPN client to connect."
    assert decision.entry.metadata == {
        "product": "bifrost-docs",
        "resource_type": "document",
        "organization_id": "org-a",
        "document_id": "document-1",
        "source_system": "itglue",
        "source_id": "source-123",
        "source_updated_at": "2026-09-22T10:00:00Z",
        "title": "VPN setup",
        "citation": "IT Glue document source-123: VPN setup",
    }


def test_project_document_fails_closed_for_non_public_or_sensitive_data() -> None:
    eligible = {
        "organization_id": "org-a",
        "source_system": "itglue",
        "source_id": "source-123",
        "name": "Safe",
        "content": "Safe content",
    }

    for changes, reason in (
        ({"restricted": True}, "restricted"),
        ({"archived": True}, "archived"),
        ({"raw": {"nested": {"password_value": "must-not-index"}}}, "sensitive_data"),
        ({"content": "Authorization: Bearer abcdefghijklmnop"}, "sensitive_content"),
        ({"name": "Password is must-not-index"}, "sensitive_content"),
        ({"organization_id": "other-org"}, "organization_mismatch"),
        ({"source_id": ""}, "missing_source_id"),
    ):
        decision = project_document(
            {**eligible, **changes},
            organization_id="org-a",
            document_id="document-1",
        )
        assert decision.entry is None
        assert decision.reason == reason


def test_project_document_indexes_only_published_native_documents() -> None:
    eligible = {
        "organization_id": "org-a",
        "source_system": "bifrost",
        "source_id": "native-document-1",
        "name": "VPN recovery",
        "content": "Use the managed VPN client.",
        "status": "published",
        "source_refs": [
            {"ticket_id": "HD-123", "ticket_url": "https://halo.example/tickets/123"}
        ],
    }

    published = project_document(eligible, organization_id="org-a", document_id="document-1")
    assert published.entry is not None
    assert published.entry.metadata["citation"] == (
        "Bifrost document native-document-1: VPN recovery; "
        "ticket HD-123: https://halo.example/tickets/123"
    )

    for status in ("draft", "archived", "restricted", ""):
        decision = project_document(
            {**eligible, "status": status}, organization_id="org-a", document_id="document-1"
        )
        assert decision.entry is None
        assert decision.reason == "not_published"


def test_project_document_excludes_any_explicit_draft_status() -> None:
    decision = project_document(
        {
            "organization_id": "org-a",
            "source_system": "itglue",
            "source_id": "source-123",
            "name": "Unpublished import",
            "content": "This must remain out of knowledge.",
            "status": "draft",
        },
        organization_id="org-a",
        document_id="document-1",
    )

    assert decision.entry is None
    assert decision.reason == "not_published"
