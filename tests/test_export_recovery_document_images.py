"""Match exported document originals without selecting previews or foreign parents."""

import zipfile

import pytest

from functions.export_recovery import match_member


def image_record(**changes):
    return {
        "kind": "documents",
        "parent_source_id": "42",
        "source_id": "73",
        "name": "image.png",
        "size": 64,
        "file_kind": "document_image",
        **changes,
    }


def member(path, size=64):
    result = zipfile.ZipInfo(path)
    result.file_size = size
    return result


@pytest.mark.parametrize("group", ["", "Synthetic grouping/"])
@pytest.mark.parametrize("section", ["", "Synthetic section/"])
def test_exported_original_matches_verified_document_without_images_folder(group, section):
    prefix = f"documents/{group}DOC-1774800-42 Synthetic document/{section}"
    original = member(prefix + "original/image.png")
    candidates = [member(prefix + "large/image.png", 32), original,
                  member(prefix + "thumbnail/image.png", 8)]
    assert match_member(candidates, image_record(), "1774800") is original


def test_stale_image_size_fallback_selects_original_and_never_equal_size_preview():
    prefix = "documents/DOC-1774800-42 Synthetic document/Synthetic section/"
    original = member(prefix + "original/image.png")
    candidates = [member(prefix + "large/image.png", 32), original,
                  member(prefix + "thumbnail/image.png", 8)]
    record = image_record(size=32)
    assert match_member(candidates, record, "1774800") is None
    assert match_member(candidates, record, "1774800", allow_size_mismatch=True) is original


def test_legacy_images_folder_remains_supported():
    original = member("documents/DOC-1774800-42 Synthetic document/images/image.png")
    assert match_member([original], image_record(), "1774800") is original


@pytest.mark.parametrize("path", [
    "documents/DOC-1774801-42 Synthetic document/original/image.png",
    "documents/DOC-1774800-43 Synthetic document/original/image.png",
    "documents/DOC-1774800-420 Synthetic document/original/image.png",
    "documents/DOC-1774800-99 Foreign/DOC-1774800-42 Synthetic document/original/image.png",
    "documents/DOC-1774800-42 Synthetic document/large/image.png",
    "documents/DOC-1774800-42 Synthetic document/thumbnail/image.png",
    "documents/DOC-1774800-42 Synthetic document/images/thumbnail/image.png",
    "passwords/DOC-1774800-42 Synthetic document/original/image.png",
    "../documents/DOC-1774800-42 Synthetic document/original/image.png",
    "/documents/DOC-1774800-42 Synthetic document/original/image.png",
])
def test_image_match_rejects_previews_foreign_parent_and_unsafe_paths(path):
    candidate = member(path)
    assert match_member([candidate], image_record(), "1774800") is None
    assert match_member([candidate], image_record(), "1774800", allow_size_mismatch=True) is None


def test_document_image_match_requires_document_resource_kind():
    candidate = member("documents/DOC-1774800-42 Synthetic document/images/image.png")
    assert match_member([candidate], image_record(kind="passwords"), "1774800") is None


def test_ambiguous_originals_remain_unmatched_even_with_stale_size():
    candidates = [member(f"documents/DOC-1774800-42 Synthetic document/{section}/original/image.png")
                  for section in ("First section", "Second section")]
    assert match_member(candidates, image_record(), "1774800") is None
    assert match_member(candidates, image_record(size=99), "1774800", allow_size_mismatch=True) is None
