import { describe, expect, it } from "vitest";
import { draftContentWithoutPendingImages, pendingAttachmentRef, resolvePendingImageRefs } from "./pending-images";

describe("pending draft images", () => {
  it("keeps temporary image references out of the initial draft and restores resolved attachments", () => {
    const pending = pendingAttachmentRef("image-1");
    const content = `<p>Before</p><img src="${pending}" alt="Network diagram"><p>After</p>`;
    expect(draftContentWithoutPendingImages(content)).toBe("<p>Before</p><p>After</p>");
    expect(resolvePendingImageRefs(content, new Map([[pending, "bifrost-attachment:image-1"]]))).toContain('src="bifrost-attachment:image-1"');
  });
});
