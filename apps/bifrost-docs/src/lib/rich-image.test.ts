import { describe, expect, it } from "vitest";
import { MAX_RICH_IMAGE_BYTES, richImageError } from "./rich-image";

describe("richImageError", () => {
  it("accepts supported image files within the editor limit", () => {
    expect(richImageError(new File(["png"], "diagram.png", { type: "image/png" }))).toBeNull();
  });

  it("rejects unsafe or over-limit image files before upload", () => {
    expect(richImageError(new File(["<svg onload='alert(1)' />"], "diagram.svg", { type: "image/svg+xml" }))).toMatch(/PNG, JPEG, GIF, WebP, or AVIF/);
    expect(richImageError(new File([new Uint8Array(MAX_RICH_IMAGE_BYTES + 1)], "large.png", { type: "image/png" }))).toMatch(/5 MB/);
  });
});
