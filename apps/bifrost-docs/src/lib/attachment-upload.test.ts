import { describe, expect, it } from "vitest";
import { attachmentLocation, attachmentWorkflowRefs, nativeAttachmentPath, safeAttachmentFileName } from "./attachment-upload";

describe("native document attachment uploads", () => {
  it("uses the document's restriction level and a canonical organization path", () => {
    expect(attachmentLocation(false)).toBe("docs-attachments");
    expect(attachmentLocation(true)).toBe("docs-restricted-attachments");
    expect(safeAttachmentFileName(" ../../unsafe invoice?.pdf ")).toBe("unsafe_invoice_.pdf");
    expect(nativeAttachmentPath("org-1", "doc-7", "cc1e9bc7-5f15-4c98-bb65-c1dc6a610b6f", "unsafe_invoice_.pdf")).toBe(
      "org-1/bifrost/documents/doc-7/cc1e9bc7-5f15-4c98-bb65-c1dc6a610b6f/unsafe_invoice_.pdf",
    );
  });

  it("keeps native attachments within their supported parent-type paths", () => {
    expect(nativeAttachmentPath("org-1", "config-7", "cc1e9bc7-5f15-4c98-bb65-c1dc6a610b6f", "guide.pdf", "configurations")).toBe(
      "org-1/bifrost/configurations/config-7/cc1e9bc7-5f15-4c98-bb65-c1dc6a610b6f/guide.pdf",
    );
  });

  it("uses cleanup-aware workflows to register and delete attachment metadata", () => {
    expect(attachmentWorkflowRefs.ensureGrant).toBe("functions/file_grants.py::docs_ensure_file_grant");
    expect(attachmentWorkflowRefs.register).toBe("functions/attachments.py::docs_register_attachment");
    expect(attachmentWorkflowRefs.delete).toBe("functions/attachments.py::docs_delete_attachment");
  });
});
