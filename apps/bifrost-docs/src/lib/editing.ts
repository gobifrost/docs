export type DocumentEditorValues = { title: string; content: string; folderId: string };

export const documentMutationRefs = {
  update: "functions/document_mutations.py::docs_update_document",
  delete: "functions/document_mutations.py::docs_delete_document",
  bulkArchive: "functions/document_mutations.py::docs_bulk_archive_documents",
} as const;

export function canPublishNativeDraft(isAdmin: boolean, sourceSystem: unknown, status: unknown) {
  return isAdmin && String(sourceSystem).toLowerCase() === "bifrost" && String(status).toLowerCase() === "draft";
}

/** Keep imported-source metadata immutable during local edits. */
export function documentUpdatePayload({ title, content, folderId }: DocumentEditorValues) {
  return {
    name: title.trim(),
    content,
    rendered_content: content,
    folder_id: folderId.trim() || null,
  };
}

export function sourceSyncWarning(sourceSystem: unknown): string | null {
  return String(sourceSystem || "").toLowerCase() === "itglue"
    ? "Your edits remain available until the next IT Glue source change, which overwrites mapped fields."
    : null;
}
