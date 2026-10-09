import { describe, expect, it } from "vitest";
import { catalogEntry, catalogSearchWhere, relatedRecordPath } from "./catalog";

describe("catalog browse contracts", () => {
  it("uses a server-side contains filter against the resource's safe search field", () => {
    expect(catalogSearchWhere(catalogEntry("configurations"), "edge-01")).toEqual({
      name: { contains: "edge-01" },
    });
  });

  it("does not produce a search filter for blank terms", () => {
    expect(catalogSearchWhere(catalogEntry("documents"), "   ")).toBeUndefined();
  });

  it("routes known related records within the app and leaves unknown records external", () => {
    expect(relatedRecordPath("configurations", "config-123")).toBe("/configurations/config-123");
    expect(relatedRecordPath("unknown", "legacy-123")).toBeNull();
  });
});
