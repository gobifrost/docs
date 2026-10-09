import { describe, expect, it, vi } from "vitest";
import { groupGlobalAssetTypes, loadGlobalAssetTypeGroups, resolveGlobalAssetTypeIds } from "./global-asset-types";

const importedA = { id: "destination-a", data: { name: "Endpoints", source_system: "itglue", source_id: "source-type-7", organization_id: "org-a" } };
const importedB = { id: "destination-b", data: { name: "Endpoints", source_system: "itglue", source_id: "source-type-7", organization_id: "org-b" } };

 describe("global asset type groups", () => {
  it("combines imported copies by their exact IT Glue source identity while native same-name types remain distinct", () => {
    const groups = groupGlobalAssetTypes([
      importedA,
      importedB,
      { id: "native-a", data: { name: "Endpoints", source_system: "bifrost", source_id: "native-a" } },
      { id: "native-b", data: { name: "Endpoints", source_system: "bifrost", source_id: "native-b" } },
    ]);

    expect(groups).toEqual([
      expect.objectContaining({ id: "destination-a", name: "Endpoints", typeIds: ["destination-a", "destination-b"] }),
      expect.objectContaining({ id: "native-a", name: "Endpoints", typeIds: ["native-a"] }),
      expect.objectContaining({ id: "native-b", name: "Endpoints", typeIds: ["native-b"] }),
    ]);
  });

  it("resolves a global route to every visible imported copy but preserves a scoped route's one type ID", () => {
    const groups = groupGlobalAssetTypes([importedA, importedB]);

    expect(resolveGlobalAssetTypeIds(groups, "destination-b", "")).toEqual(["destination-a", "destination-b"]);
    expect(resolveGlobalAssetTypeIds(groups, "destination-b", "org-b")).toEqual(["destination-b"]);
  });

  it("loads every type page before grouping", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ documents: [importedA], table_id: "types-uuid" })
      .mockResolvedValueOnce({ documents: [importedB], table_id: "types-uuid" })
      .mockResolvedValueOnce({ documents: [], table_id: "types-uuid" });

    const groups = await loadGlobalAssetTypeGroups(query, "", { pageSize: 1 });

    expect(groups).toHaveLength(1);
    expect(groups?.[0]?.typeIds).toEqual(["destination-a", "destination-b"]);
    expect(query).toHaveBeenNthCalledWith(3, "docs-flexible-asset-types", expect.objectContaining({ offset: 2, limit: 1 }));
  });
  it("keeps the organization constraint while loading a scoped type directory", async () => {
    const query = vi.fn().mockResolvedValue({ documents: [importedB], table_id: "types-uuid" });
    await loadGlobalAssetTypeGroups(query, "org-b");
    expect(query).toHaveBeenCalledWith("docs-flexible-asset-types", expect.objectContaining({ where: { organization_id: "org-b" } }));
  });

});
