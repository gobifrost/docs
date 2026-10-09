import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Layers } from "lucide-react";
import { tables } from "bifrost";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDocsOrganizations } from "@/components/layout/useDocsOrganizations";
import { BfAlert } from "@/components/bifrost/BfAlert";
import { BfButton } from "@/components/bifrost/BfButton";
import { Skeleton } from "@/components/ui/skeleton";
import { loadTableCountsSnapshot, type TableQuery } from "@/lib/table-query";
import { loadGlobalAssetTypeGroups } from "@/lib/global-asset-types";
import { useTableInvalidations, useTableInvalidation } from "@/lib/table-realtime";

export type AssetTypeSummary = { id: string; name: string; fields: number; assets: number };

function fieldCount(fields: unknown): number {
  return Array.isArray(fields) ? fields.length : 0;
}

/** Card grid of flexible asset types, mirroring the original assets index. */
export function AssetTypeGrid({ onSelect }: { onSelect: (typeId: string) => void }) {
  const { organizationId } = useDocsOrganizations();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [types, setTypes] = useState<AssetTypeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [tableIds, setTableIds] = useState<string[]>([]);
  const [tableScope, setTableScope] = useState("");
  const scope = `asset-type-grid:${organizationId}`;

  useEffect(() => {
    setTypes([]); setTableIds([]); setTableScope(""); setError(""); setLoading(true);
  }, [scope]);

  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    let typeTableId: string | null = null;
    const queryTypes: TableQuery = async (table, options) => {
      const result = await tables.query(table, options);
      if (typeof result.table_id === "string") typeTableId = result.table_id;
      return result;
    };
    loadGlobalAssetTypeGroups(
      queryTypes,
      organizationId,
      { isCurrent: () => active },
    )
      .then(async (documents) => {
        if (!active || documents === null) return;
        const rows = documents.map((group) => ({
          id: group.id,
          name: group.name,
          fields: fieldCount(group.fields),
          typeIds: group.typeIds,
        }));
        const counts = await loadTableCountsSnapshot(
          tables.query as TableQuery,
          rows.map((row) => ({
            key: row.id,
            table: "docs-flexible-assets",
            where: { flexible_asset_type_id: organizationId ? row.id : { in: row.typeIds }, ...(organizationId ? { organization_id: organizationId } : {}) },
          })),
          undefined,
          { isCurrent: () => active },
        );
        if (!active) return;
        setTableIds([typeTableId, ...counts.tableIds].filter((id): id is string => Boolean(id)));
        setTableScope(scope);
        setTypes(rows.map((row) => ({ ...row, assets: counts.counts[row.id] })));
        setLoading(false);
      })
      .catch((failure) => {
        if (active) { setTypes([]); setTableIds([]); setTableScope(""); setError(failure instanceof Error ? failure.message : String(failure)); setLoading(false); }
      });
    return () => {
      active = false;
    };
  }, [organizationId, refresh, scope]);
  useTableInvalidations(tableScope === scope ? tableIds : [], organizationId || null, () => setRefresh((value) => value + 1), () => { setTypes([]); setTableIds([]); setTableScope(""); setLoading(false); setError(""); });

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading asset types">
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-28 w-full" />
        ))}
      </div>
    );
  }

  if (error) return <BfAlert tone="danger" title="Asset types could not load">{error}<BfButton variant="secondary" onClick={() => setRefresh((value) => value + 1)}>Retry</BfButton></BfAlert>;
  if (types.length === 0) {
    return <p className="text-sm text-muted-foreground">No flexible asset types were imported for this scope.</p>;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {types.map((type) => (
        <button
          key={type.id}
          type="button"
          onClick={() => onSelect(type.id)}
          className="rounded-[var(--bf-radius-surface)] text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--bf-primary)]"
        >
          <Card className="transition-colors hover:border-[var(--bf-primary)]">
            <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-2">
              <Layers className="h-5 w-5 text-[var(--bf-primary)]" aria-hidden="true" />
              <CardTitle className="text-base">{type.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold tabular-nums">{type.assets.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">
                {type.assets === 1 ? "record" : "records"} · {type.fields} {type.fields === 1 ? "field" : "fields"}
              </p>
            </CardContent>
          </Card>
        </button>
      ))}
    </div>
  );
}

export function AssetTypeLink({ typeId, fallback }: { typeId: string; fallback: string }) {
  const [name, setName] = useState<string | null>(null);
  const [tableId, setTableId] = useState<string | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [tableScope, setTableScope] = useState("");
  const [refresh, setRefresh] = useState(0);
  const scope = typeId;
  useEffect(() => {
    setName(null); setTableId(null); setOrganizationId(null); setTableScope("");
  }, [scope]);
  useEffect(() => {
    let active = true;
    tables
      .get("docs-flexible-asset-types", typeId)
      .then((doc) => {
        if (!active) return;
        setTableId(typeof doc?.table_id === "string" ? doc.table_id : null);
        setTableScope(scope);
        setOrganizationId(typeof doc?.data?.organization_id === "string" ? doc.data.organization_id : null);
        if (doc && typeof doc.data?.name === "string") setName(doc.data.name);
      })
      .catch(() => {
        if (active) { setName(null); setTableId(null); setOrganizationId(null); setTableScope(""); }
      });
    return () => {
      active = false;
    };
  }, [typeId, refresh, scope]);
  useTableInvalidation(tableScope === scope ? tableId : null, organizationId, () => setRefresh((value) => value + 1), () => { setName(null); setTableId(null); setOrganizationId(null); setTableScope(""); });
  return <Link to={`/flexible-asset-types/${typeId}`}>{name ?? fallback}</Link>;
}
