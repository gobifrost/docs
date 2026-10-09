const FILE_NAME_PATTERN = /[^A-Za-z0-9._-]+/g;

export type NativeAttachmentParentType = "documents" | "configurations" | "locations" | "flexible_assets";

export const attachmentWorkflowRefs = {
  ensureGrant: "functions/file_grants.py::docs_ensure_file_grant",
  register: "functions/attachments.py::docs_register_attachment",
  delete: "functions/attachments.py::docs_delete_attachment",
} as const;

export function safeAttachmentFileName(value: string): string {
  const cleaned = value.trim().replace(FILE_NAME_PATTERN, "_").replace(/^[._]+|[._]+$/g, "");
  return (cleaned || "file").slice(0, 180);
}

export function attachmentLocation(restricted: boolean): "docs-attachments" | "docs-restricted-attachments" {
  return restricted ? "docs-restricted-attachments" : "docs-attachments";
}

export function nativeAttachmentPath(organizationId: string, parentId: string, attachmentId: string, fileName: string, parentType: NativeAttachmentParentType = "documents"): string {
  return `${organizationId}/bifrost/${parentType}/${parentId}/${attachmentId}/${fileName}`;
}
