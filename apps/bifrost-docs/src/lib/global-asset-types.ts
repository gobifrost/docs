import { queryAllPages, type PageQueryOptions, type TableDocument, type TableQuery } from "./table-query";

export type GlobalAssetTypeGroup = {
  /** A stable route representative. Imported copies use the first visible destination row. */
  id: string;
  name: string;
  typeIds: string[];
  fields: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Global IT Glue types are copied once per visible organization. Their source ID,
 * unlike their display name, identifies the shared source type. Native rows are
 * deliberately never merged because their IDs are independently authored.
 */
export function groupGlobalAssetTypes(rows: TableDocument[]): GlobalAssetTypeGroup[] {
  const grouped = new Map<string, GlobalAssetTypeGroup>();
  for (const row of rows) {
    if (!row || !text(row.id)) continue;
    const data = row.data ?? {};
    const sourceSystem = text(data.source_system).toLowerCase();
    const sourceId = text(data.source_id);
    const key = sourceSystem === "itglue" && sourceId ? `itglue:${sourceId}` : `destination:${row.id}`;
    const current = grouped.get(key);
    if (current) {
      current.typeIds.push(row.id);
      continue;
    }
    grouped.set(key, {
      id: row.id,
      name: text(data.name) || row.id,
      typeIds: [row.id],
      fields: data.fields,
    });
  }
  return [...grouped.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export async function loadGlobalAssetTypeGroups(
  query: TableQuery,
  organizationId: string,
  options: PageQueryOptions = {},
): Promise<GlobalAssetTypeGroup[] | null> {
  const rows = await queryAllPages(
    query,
    "docs-flexible-asset-types",
    {
      order_by: "name",
      order_dir: "asc",
      where: organizationId ? { organization_id: organizationId } : undefined,
    },
    options,
  );
  return rows === null ? null : groupGlobalAssetTypes(rows);
}

/** Keep an organization route pinned to its own copied type; global routes aggregate a source group. */
export function resolveGlobalAssetTypeIds(groups: GlobalAssetTypeGroup[], routeTypeId: string | undefined, organizationId: string): string[] {
  if (!routeTypeId) return [];
  if (organizationId) return [routeTypeId];
  return groups.find((group) => group.typeIds.includes(routeTypeId))?.typeIds ?? [];
}

export function globalAssetTypeGroup(groups: GlobalAssetTypeGroup[], routeTypeId: string | undefined): GlobalAssetTypeGroup | null {
  if (!routeTypeId) return null;
  return groups.find((group) => group.typeIds.includes(routeTypeId)) ?? null;
}
