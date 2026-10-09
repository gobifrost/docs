import { describe, expect, it } from "vitest";
import { activeTaxonomyOptions, taxonomyTable } from "./configuration-taxonomy";

describe("configuration taxonomy contracts", () => {
  it("uses tenant-scoped taxonomy tables and excludes inactive choices", () => {
    expect(taxonomyTable("type")).toBe("docs-configuration-types");
    expect(taxonomyTable("status")).toBe("docs-configuration-statuses");
    expect(activeTaxonomyOptions([
      { id: "type-1", name: "Switch", active: true },
      { id: "type-2", name: "Retired hardware", active: false },
    ])).toEqual([{ value: "Switch", label: "Switch" }]);
  });

  it("keeps the current configuration value selectable when its taxonomy is inactive", () => {
    expect(activeTaxonomyOptions([
      { id: "status-1", name: "Active", active: true },
      { id: "status-2", name: "Legacy", active: false },
    ], "Legacy")).toEqual([
      { value: "Active", label: "Active" },
      { value: "Legacy", label: "Legacy", description: "Inactive" },
    ]);
  });

  it("keeps a legacy name selectable until its taxonomy copy is available", () => {
    expect(activeTaxonomyOptions([
      { id: "type-1", name: "Switch", active: true },
    ], "Imported legacy type")).toContainEqual({
      value: "Imported legacy type",
      label: "Imported legacy type",
      description: "Not in current taxonomy",
    });
  });
});
