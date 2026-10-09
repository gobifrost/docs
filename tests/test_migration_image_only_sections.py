"""Keep structured IT Glue image sections in their original document position."""
from unittest.mock import AsyncMock

import pytest

from functions import migration
from modules.migration_core import stable_id


def image(image_id="77"):
    return {"id": image_id, "type": "document_images", "attributes": {"attachment-file-name": "Synthetic image.png"}}


def source():
    return {"id": "42", "attributes": {}, "_sections": [
        {"attributes": {"content": "<p>Before</p>", "rendered-content": "<p>Before</p>"}},
        {"attributes": {"document-images": [image()]}},
        {"attributes": {"content": "<p>After</p>", "rendered-content": "<p>After</p>"}},
    ]}


def reference(image_id="77"):
    return "bifrost-attachment:" + stable_id("org-a", "document_image", image_id)


def test_image_only_section_renders_between_neighboring_sections():
    content, rendered = migration._document_presentation(source(), "org-a", [image()])
    for html in (content, rendered):
        assert html.index("Before") < html.index(reference()) < html.index("After")
        assert html.count("<img") == 1
        assert 'alt="Synthetic image.png"' in html
    # Keep the unmodified source baseline available for local-edit detection.
    assert migration._document_source_presentation(source()) == ("<p>Before</p>\n\n<p>After</p>",) * 2


def test_duplicates_in_one_image_section_render_once_but_repeated_sections_remain():
    value = source()
    value["_sections"][1]["attributes"]["document-images"] *= 2
    value["_sections"].insert(2, value["_sections"][1])
    content, rendered = migration._document_presentation(value, "org-a", [image()])
    assert content.count(reference()) == rendered.count(reference()) == 2


def test_existing_section_html_is_preserved_without_an_extra_gallery():
    value = source()
    value["_sections"][1]["attributes"].update(content='<img src="/developer/images/77">', **{"rendered-content": '<img src="/developer/images/77">'})
    content, rendered = migration._document_presentation(value, "org-a", [image()])
    assert content.count(reference()) == rendered.count(reference()) == 1


@pytest.mark.parametrize("unavailable", [[], [image("99")]])
def test_unhydrated_image_metadata_cannot_create_a_managed_reference(unavailable):
    assert migration._document_presentation(source(), "org-a", unavailable) == migration._document_source_presentation(source())


def test_image_alt_text_is_escaped_without_creating_attributes():
    value = source()
    img = image()
    img["attributes"]["attachment-file-name"] = 'x" onerror="alert(1)'
    value["_sections"][1]["attributes"]["document-images"] = [img]
    content, _ = migration._document_presentation(value, "org-a", [img])
    assert 'alt="x&quot; onerror=&quot;alert(1)"' in content
    assert ' onerror="' not in content


@pytest.mark.asyncio
@pytest.mark.parametrize("already_managed", [False, True])
async def test_backfill_adds_image_sections_to_unchanged_raw_or_managed_source(monkeypatch, already_managed):
    value = source()
    value["_sections"][0]["attributes"].update(content='<img src="/developer/images/99">', **{"rendered-content": '<img src="/developer/images/99">'})
    images = [image(), image("99")]
    content, rendered = migration._document_source_presentation(value)
    if already_managed:
        content = migration.normalize_document_image_references(content, images, "org-a")
        rendered = migration.normalize_document_image_references(rendered, images, "org-a")
    update = AsyncMock()
    monkeypatch.setattr(migration.tables, "update", update)
    await migration._backfill_document_image_references("org-a", "doc-a", {"raw": value, "content": content, "rendered_content": rendered}, value, images)
    update.assert_awaited_once()
    assert reference() in update.call_args.args[2]["content"]
    assert reference("99") in update.call_args.args[2]["rendered_content"]


@pytest.mark.asyncio
async def test_image_section_backfill_preserves_local_content_edits(monkeypatch):
    value = source()
    content, rendered = migration._document_source_presentation(value)
    update = AsyncMock()
    monkeypatch.setattr(migration.tables, "update", update)
    await migration._backfill_document_image_references("org-a", "doc-a", {"raw": value, "content": content + "<p>Local edit</p>", "rendered_content": rendered}, value, [image()])
    update.assert_not_awaited()
