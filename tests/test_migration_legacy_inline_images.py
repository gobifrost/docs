from __future__ import annotations

import pytest

from functions import migration
from modules.itglue_api import ITGlueError, ITGluePage
from modules.migration_core import RESOURCE_SPECS, stable_id


def _spec(name: str):
    return next(item for item in RESOURCE_SPECS if item.name == name)


class _DocumentClient:
    def __init__(self, sections: list[dict]):
        self.sections = sections
        self.requested: list[str] = []

    async def get_document(self, path, params=None):
        self.requested.append(path)
        if path == "/documents/741856":
            return {
                "data": {
                    "id": "741856",
                    "attributes": {"updated-at": "2026-10-02T00:00:00Z"},
                }
            }
        if path == "/document_images/55":
            return {
                "data": {
                    "id": "55",
                    "attributes": {
                        "original-src": "https://source.example/developer.png"
                    },
                }
            }
        raise AssertionError(path)

    async def iter_pages(self, path, params=None):
        self.requested.append(path)
        assert path == "/documents/741856/relationships/sections"
        yield ITGluePage(
            number=1,
            records=self.sections,
            included=[],
            total_pages=1,
            total_count=len(self.sections),
        )


def _paired_section(
    *, root_id: str = "123456", s3_chunks: tuple[str, str, str] = ("1", "23", "456")
) -> dict:
    return {
        "id": "section-1",
        "attributes": {
            "updated-at": "2026-10-02T01:02:03Z",
            "content": f'<img src="/1774800/docs/741856/images/{root_id}">',
            "rendered-content": (
                '<img src="https://bucket.s3.amazonaws.com/archive/images/images/'
                f'{s3_chunks[0]}/{s3_chunks[1]}/{s3_chunks[2]}/original/diagram.png?temporary=redacted">'
            ),
        },
    }


@pytest.mark.asyncio
async def test_hydrates_verified_legacy_root_and_s3_pair_and_rewrites_both_presentations() -> (
    None
):
    client = _DocumentClient([_paired_section()])

    source, _, images = await migration._hydrate_resource(
        client, _spec("documents"), {"id": "741856"}, source_org_id="1774800"
    )

    assert client.requested == [
        "/documents/741856",
        "/documents/741856/relationships/sections",
    ]
    assert len(images) == 1
    legacy = images[0]
    assert legacy["id"] == "legacy-image:741856:123456"
    assert legacy["attributes"]["legacy-image-aliases"] == [
        "/1774800/docs/741856/images/123456"
    ]
    assert legacy["attributes"]["attachment-file-name"] == "diagram.png"
    assert legacy["attributes"]["attachment-content-type"] == "image/png"
    assert legacy["attributes"]["updated-at"] == "2026-10-02T01:02:03Z"
    content, rendered = migration._document_presentation(source, "org-a", images)
    reference = f"bifrost-attachment:{stable_id('org-a', 'document_image', 'legacy-image:741856:123456')}"
    assert content == f'<img src="{reference}">'
    assert rendered == f'<img src="{reference}">'


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("foreign_path", "expected_missing"),
    [
        ("/1774800/docs/741857/images/123456", True),
        ("/1774801/docs/741856/images/123456", False),
    ],
)
async def test_rejects_foreign_org_or_document_root_path_and_does_not_auto_import_it(
    foreign_path: str, expected_missing: bool
) -> None:
    section = _paired_section()
    section["attributes"]["content"] = f'<img src="{foreign_path}">'
    client = _DocumentClient([section])

    source, _, images = await migration._hydrate_resource(
        client, _spec("documents"), {"id": "741856"}, source_org_id="1774800"
    )

    assert bool(images) is expected_missing
    if expected_missing:
        assert images[0]["_source_missing"] is True
        assert "original-src" not in images[0]["attributes"]
    assert (
        migration._document_presentation(source, "org-a", images)[0]
        == section["attributes"]["content"]
    )


@pytest.mark.asyncio
async def test_rejects_ambiguous_legacy_id_and_retains_strong_missing_url_as_actionable_child() -> (
    None
):
    ambiguous = _paired_section()
    ambiguous["attributes"]["rendered-content"] += (
        '<img src="https://bucket.s3.amazonaws.com/archive/images/images/12/34/56/original/other.png">'
    )
    missing = _paired_section(root_id="987")
    missing["attributes"]["rendered-content"] = "<p>No source media URL</p>"
    client = _DocumentClient([ambiguous, missing])

    _source, _, images = await migration._hydrate_resource(
        client, _spec("documents"), {"id": "741856"}, source_org_id="1774800"
    )

    assert {image["id"] for image in images} == {
        "legacy-image:741856:123456",
        "legacy-image:741856:987",
    }
    assert all(image["_source_missing"] is True for image in images)
    assert all("original-src" not in image["attributes"] for image in images)
    assert next(image for image in images if image["id"] == "legacy-image:741856:987")[
        "attributes"
    ]["legacy-image-aliases"] == ["/1774800/docs/741856/images/987"]


@pytest.mark.asyncio
async def test_legacy_namespace_cannot_collide_with_supported_developer_images() -> (
    None
):
    section = _paired_section()
    section["attributes"]["content"] += '<img src="/developer/images/55">'
    client = _DocumentClient([section])

    source, _, images = await migration._hydrate_resource(
        client, _spec("documents"), {"id": "741856"}, source_org_id="1774800"
    )

    assert {image["id"] for image in images} == {"legacy-image:741856:123456", "55"}
    content, _rendered = migration._document_presentation(source, "org-a", images)
    legacy_reference = stable_id("org-a", "document_image", "legacy-image:741856:123456")
    developer_reference = stable_id("org-a", "document_image", "55")
    assert legacy_reference != developer_reference
    assert f"bifrost-attachment:{legacy_reference}" in content
    assert f"bifrost-attachment:{developer_reference}" in content


@pytest.mark.asyncio
async def test_zero_padded_legacy_ids_and_identical_s3_urls_remain_one_verified_child() -> (
    None
):
    section = _paired_section(root_id="123456", s3_chunks=("000", "123", "456"))
    section["attributes"]["rendered-content"] *= 2
    client = _DocumentClient([section])

    _source, _, images = await migration._hydrate_resource(
        client, _spec("documents"), {"id": "741856"}, source_org_id="1774800"
    )

    assert [image["id"] for image in images] == ["legacy-image:741856:123456"]
    assert images[0].get("_source_missing") is None


@pytest.mark.asyncio
async def test_non_s3_or_malformed_rendered_urls_never_become_download_urls() -> None:
    section = _paired_section()
    section["attributes"]["rendered-content"] = (
        '<img src="https://s3.attacker.example/images/images/1/23/456/original/file.png">'
    )
    client = _DocumentClient([section])

    _source, _, images = await migration._hydrate_resource(
        client, _spec("documents"), {"id": "741856"}, source_org_id="1774800"
    )

    assert images[0]["_source_missing"] is True
    assert "original-src" not in images[0]["attributes"]

    with pytest.raises(ITGlueError) as error:
        await migration._transfer_file(
            object(),
            "org-a",
            "documents",
            "destination-document",
            images[0],
            file_kind="document_image",
        )
    assert error.value.status_code == 404
    assert "https://" not in str(error.value)
    assert "s3.attacker.example" not in str(error.value)


def test_forged_legacy_alias_cannot_rewrite_a_different_synthetic_image() -> None:
    images = [
        {
            "id": "legacy-image:123456",
            "attributes": {
                "legacy-image-aliases": ["/1774800/docs/741856/images/654321"]
            },
        }
    ]

    content = migration.normalize_document_image_references(
        '<img src="/1774800/docs/741856/images/654321">', images, "org-a"
    )

    assert content == '<img src="/1774800/docs/741856/images/654321">'


class _CrossDocumentClient(_DocumentClient):
    def __init__(self, sections: list[dict], *, owner_restricted: bool = False):
        super().__init__(sections)
        self.owner_restricted = owner_restricted

    async def get_document(self, path, params=None):
        if path == "/documents/7268735":
            self.requested.append(path)
            return {"data": {"id": "7268735", "attributes": {
                "organization-id": "1774800", "restricted": self.owner_restricted,
            }}}
        return await super().get_document(path, params)


def _cross_document_section(*, host: str = "app.itglue.com") -> dict:
    section = _paired_section()
    section["attributes"]["content"] = f'<img src="https://{host}/1774800/docs/7268735/images/123456">'
    return section


@pytest.mark.asyncio
async def test_hydrates_verified_same_org_cross_document_absolute_reference() -> None:
    client = _CrossDocumentClient([_cross_document_section()])

    source, _, images = await migration._hydrate_resource(
        client, _spec("documents"), {"id": "741856"}, source_org_id="1774800"
    )

    assert [image["id"] for image in images] == ["legacy-image:741856:123456"]
    assert images[0]["attributes"]["legacy-image-owner-document-id"] == "7268735"
    assert images[0]["attributes"]["legacy-image-owner-validated"] is True
    content, _ = migration._document_presentation(source, "org-a", images)
    assert "bifrost-attachment:" in content


@pytest.mark.asyncio
async def test_restricted_cross_document_owner_becomes_unresolved_without_a_download_url() -> None:
    client = _CrossDocumentClient([_cross_document_section()], owner_restricted=True)

    source, _, images = await migration._hydrate_resource(
        client, _spec("documents"), {"id": "741856"}, source_org_id="1774800"
    )

    assert images[0]["_source_missing"] is True
    assert images[0]["attributes"]["legacy-image-owner-validated"] is False
    assert "original-src" not in images[0]["attributes"]
    assert migration._document_presentation(source, "org-a", images)[0] == _cross_document_section()["attributes"]["content"]


@pytest.mark.asyncio
async def test_untrusted_absolute_host_is_not_a_legacy_root_reference() -> None:
    client = _CrossDocumentClient([_cross_document_section(host="app.itglue.attacker.example")])

    _source, _, images = await migration._hydrate_resource(
        client, _spec("documents"), {"id": "741856"}, source_org_id="1774800"
    )

    assert images == []


@pytest.mark.asyncio
async def test_same_image_id_in_two_current_documents_has_distinct_attachment_ids() -> None:
    first = _DocumentClient([_paired_section()])
    second_section = _paired_section()
    second_section["attributes"]["content"] = '<img src="/1774800/docs/741857/images/123456">'

    class SecondClient(_DocumentClient):
        async def get_document(self, path, params=None):
            if path == "/documents/741857":
                return {"data": {"id": "741857", "attributes": {}}}
            return await super().get_document(path, params)

        async def iter_pages(self, path, params=None):
            assert path == "/documents/741857/relationships/sections"
            yield ITGluePage(number=1, records=[second_section], included=[], total_pages=1, total_count=1)

    second = SecondClient([second_section])
    _source_one, _, first_images = await migration._hydrate_resource(
        first, _spec("documents"), {"id": "741856"}, source_org_id="1774800"
    )
    _source_two, _, second_images = await migration._hydrate_resource(
        second, _spec("documents"), {"id": "741857"}, source_org_id="1774800"
    )

    assert first_images[0]["id"] != second_images[0]["id"]
    assert stable_id("org-a", "document_image", first_images[0]["id"]) != stable_id(
        "org-a", "document_image", second_images[0]["id"]
    )


def _unpaired_duplicate_section() -> dict:
    section = _paired_section()
    section["id"] = "section-unpaired"
    section["attributes"] = {
        **section["attributes"],
        "rendered-content": "<p>No source media URL</p>",
    }
    return section


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "unpaired_first",
    [False, True],
    ids=["verified-then-unpaired", "unpaired-then-verified"],
)
async def test_verified_legacy_pair_survives_an_unpaired_duplicate_occurrence(
    unpaired_first: bool,
) -> None:
    verified = _paired_section()
    unpaired = _unpaired_duplicate_section()
    client = _DocumentClient(
        [unpaired, verified] if unpaired_first else [verified, unpaired]
    )

    _source, _, images = await migration._hydrate_resource(
        client, _spec("documents"), {"id": "741856"}, source_org_id="1774800"
    )

    assert [image["id"] for image in images] == ["legacy-image:741856:123456"]
    assert images[0].get("_source_missing") is None
    assert images[0]["attributes"]["legacy-image-aliases"] == [
        "/1774800/docs/741856/images/123456"
    ]
    assert "original-src" in images[0]["attributes"]


@pytest.mark.asyncio
async def test_conflicting_independently_verified_legacy_pairs_fail_closed() -> None:
    conflicting = _paired_section()
    conflicting["id"] = "section-conflicting"
    conflicting["attributes"] = {
        **conflicting["attributes"],
        "rendered-content": conflicting["attributes"]["rendered-content"].replace(
            "diagram.png", "other.png"
        ),
    }
    client = _DocumentClient([_paired_section(), conflicting])

    _source, _, images = await migration._hydrate_resource(
        client, _spec("documents"), {"id": "741856"}, source_org_id="1774800"
    )

    assert [image["id"] for image in images] == ["legacy-image:741856:123456"]
    assert images[0]["_source_missing"] is True
    assert "original-src" not in images[0]["attributes"]


@pytest.mark.asyncio
async def test_identical_verified_legacy_pair_with_different_section_metadata_remains_verified() -> None:
    repeated = _paired_section()
    repeated["id"] = "section-repeat"
    repeated["attributes"] = {
        **repeated["attributes"],
        "updated-at": "2026-10-02T01:02:04Z",
    }
    client = _DocumentClient([_paired_section(), repeated])

    _source, _, images = await migration._hydrate_resource(
        client, _spec("documents"), {"id": "741856"}, source_org_id="1774800"
    )

    assert [image["id"] for image in images] == ["legacy-image:741856:123456"]
    assert images[0].get("_source_missing") is None
    assert "original-src" in images[0]["attributes"]


def _live_duplicate_identity_section(section_id: str, updated_at: str) -> dict:
    return {
        "id": section_id,
        "attributes": {
            "updated-at": updated_at,
            "content": '<img src="/1774800/docs/7268735/images/10161979">',
            "rendered-content": (
                '<img src="https://bucket.s3.amazonaws.com/archive/images/images/'
                '10/161/979/original/diagram.png?temporary=redacted">'
            ),
        },
    }


@pytest.mark.asyncio
async def test_live_duplicate_identity_with_different_section_timestamps_remains_verified() -> None:
    client = _DocumentClient([])
    sections = [
        _live_duplicate_identity_section("16452890", "2021-04-13T19:15:24.000Z"),
        _live_duplicate_identity_section("16454565", "2021-04-13T20:02:50.000Z"),
    ]

    images = await migration._legacy_inline_images(
        client, sections, "1774800", "7268735", "2021-04-13T20:02:50.000Z"
    )

    assert [image["id"] for image in images] == ["legacy-image:7268735:10161979"]
    assert images[0].get("_source_missing") is None
    assert images[0]["attributes"]["updated-at"] == "2021-04-13T20:02:50.000Z"
    assert "original-src" in images[0]["attributes"]
