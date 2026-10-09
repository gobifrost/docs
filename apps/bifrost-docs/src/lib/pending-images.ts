const PENDING_PREFIX = "bifrost-pending:";

export function pendingAttachmentRef(id: string) {
  return `${PENDING_PREFIX}${id}`;
}

/** The create-draft request never persists a temporary object or pending-image URL. */
export function draftContentWithoutPendingImages(content: string) {
  return content.replace(/<img\b[^>]*\bsrc\s*=\s*(["'])bifrost-pending:[^"']*\1[^>]*>/gi, "");
}

export function resolvePendingImageRefs(content: string, refs: ReadonlyMap<string, string>) {
  let resolved = content;
  for (const [pending, attachment] of refs) resolved = resolved.split(pending).join(attachment);
  return resolved;
}
