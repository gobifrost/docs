import { describe, expect, it } from "vitest";
import { canPublishNativeDraft, documentMutationRefs, documentUpdatePayload, sourceSyncWarning } from "./editing";

describe("editable migrated-record contracts", () => {
  it("updates document fields without mutating IT Glue provenance", () => {
    expect(documentUpdatePayload({ title: "Network runbook", content: "Updated content", folderId: "folder-7" })).toEqual({
      name: "Network runbook",
      content: "Updated content",
      rendered_content: "Updated content",
      folder_id: "folder-7",
    });
  });

  it("warns users that mapped fields are overwritten only after a source change", () => {
    expect(sourceSyncWarning("itglue")).toContain("next IT Glue source change");
    expect(sourceSyncWarning("bifrost")).toBeNull();
  });

  it("routes document updates and deletions through cleanup-aware workflows", () => {
    expect(documentMutationRefs.update).toBe("functions/document_mutations.py::docs_update_document");
    expect(documentMutationRefs.delete).toBe("functions/document_mutations.py::docs_delete_document");
    expect(documentMutationRefs.bulkArchive).toBe("functions/document_mutations.py::docs_bulk_archive_documents");
  });

  it("shows native draft publishing only to Docs administrators", () => {
    expect(canPublishNativeDraft(true, "bifrost", "draft")).toBe(true);
    expect(canPublishNativeDraft(false, "bifrost", "draft")).toBe(false);
    expect(canPublishNativeDraft(true, "itglue", "draft")).toBe(false);
  });
});
