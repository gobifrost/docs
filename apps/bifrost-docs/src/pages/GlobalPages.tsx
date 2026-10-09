import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { tables } from "bifrost";
import { ArrowRight, FileText, KeyRound, Layers, MapPin, Server, type LucideIcon } from "lucide-react";
import { CatalogToolbar } from "@/components/CatalogToolbar";
import { BfButton } from "@/components/bifrost/BfButton";
import { BfAlert } from "@/components/bifrost/BfAlert";
import { BfDataTable, type BfDataColumn, type BfDataTableSort } from "@/components/bifrost/BfDataTable";
import { displayAssetValue, safeAssetFields, type AssetField } from "@/components/AssetFields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { catalogEntry, catalogSearchWhere, enabledRecordWhere, isCatalogKind, type CatalogKind } from "@/lib/catalog";
import { globalAssetTypeGroup, loadGlobalAssetTypeGroups, resolveGlobalAssetTypeIds, type GlobalAssetTypeGroup } from "@/lib/global-asset-types";
import { useOrgNameMap } from "@/components/layout/useOrgNameMap";
import { useDocsOrganizations } from "@/components/layout/useDocsOrganizations";
import { loadTableCountsSnapshot, queryAllPages, type TableQuery } from "@/lib/table-query";
import { useTableInvalidation, useTableInvalidations } from "@/lib/table-realtime";

type Row = Record<string, unknown> & { id: string };
type TypeCard = GlobalAssetTypeGroup & { count: number };
type ConfigurationCard = { name: string; count: number };

function asText(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function optionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timeLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

const PAGE_SIZE = 25;
const PRIMARY_GLOBAL_KINDS: CatalogKind[] = ["passwords", "locations", "documents"];

function useGlobalCounts(organizationId: string) {
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [tableIds, setTableIds] = useState<string[]>([]);
  const scope = `global-core:${organizationId}`;
  useEffect(() => { setTotals({}); setTableIds([]); setLoading(true); setError(""); }, [scope]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    loadTableCountsSnapshot(
      tables.query as TableQuery,
      PRIMARY_GLOBAL_KINDS.map((kind) => ({ key: kind, table: catalogEntry(kind).table })),
      { ...enabledRecordWhere(), ...(organizationId ? { organization_id: organizationId } : {}) },
      { isCurrent: () => active },
    ).then((next) => {
      if (active) { setTotals(next.counts); setTableIds(next.tableIds); setLoading(false); }
    }).catch((failure: unknown) => {
      if (active) { setTotals({}); setTableIds([]); setError(failure instanceof Error ? failure.message : String(failure)); setLoading(false); }
    });
    return () => { active = false; };
  }, [refresh, organizationId, scope]);
  useTableInvalidations(tableIds, organizationId || null, () => setRefresh((value) => value + 1), () => { setTotals({}); setTableIds([]); setLoading(false); setError(""); });
  return { totals, loading, error, retry: () => setRefresh((value) => value + 1) };
}

type TypedCardsSnapshot = {
  scope: string;
  assetTypes: TypeCard[];
  configurationTypes: ConfigurationCard[];
  loading: boolean;
  error: string;
  hasSnapshot: boolean;
};

function emptyTypedCards(scope: string, loading = true, error = ""): TypedCardsSnapshot {
  return { scope, assetTypes: [], configurationTypes: [], loading, error, hasSnapshot: false };
}

function useGlobalTypedCards(organizationId: string) {
  const scope = `global-typed-cards:${organizationId}`;
  const [state, setState] = useState<TypedCardsSnapshot>(() => emptyTypedCards(scope));
  const [refresh, setRefresh] = useState(0);
  const [tableIds, setTableIds] = useState<string[]>([]);
  useEffect(() => { setState(emptyTypedCards(scope)); setTableIds([]); }, [scope]);
  useEffect(() => {
    let active = true;
    const resolvedTableIds = new Set<string>();
    const pageOptions = {
      isCurrent: () => active,
      onTableResolved: (tableId: string) => resolvedTableIds.add(tableId),
    };
    // Keep controls from a verified snapshot usable during same-scope refreshes.
    setState((current) => current.scope === scope && current.hasSnapshot
      ? { ...current, loading: false, error: "" }
      : emptyTypedCards(scope));
    Promise.all([
      loadGlobalAssetTypeGroups(tables.query as TableQuery, organizationId, pageOptions),
      queryAllPages(tables.query as TableQuery, "docs-configuration-types", { order_by: "name", order_dir: "asc", where: organizationId ? { organization_id: organizationId } : undefined }, pageOptions),
    ]).then(async ([groups, configurationRows]) => {
      if (!active || groups === null || configurationRows === null) return;
      const configurationNames = [...new Set(configurationRows.map((row) => optionalText(row.data?.name)).filter(Boolean))].sort((left, right) => left.localeCompare(right));
      const counts = await loadTableCountsSnapshot(
        tables.query as TableQuery,
        [
          ...groups.map((group) => ({ key: group.id, table: "docs-flexible-assets", where: { flexible_asset_type_id: { in: group.typeIds } } })),
          ...configurationNames.map((name) => ({ key: `configuration:${name}`, table: "docs-configurations", where: { configuration_type_name: name } })),
        ],
        { ...enabledRecordWhere(), ...(organizationId ? { organization_id: organizationId } : {}) },
        { isCurrent: () => active },
      );
      if (!active) return;
      setState({
        scope,
        assetTypes: groups.map((group) => ({ ...group, count: counts.counts[group.id] ?? 0 })),
        configurationTypes: configurationNames.map((name) => ({ name, count: counts.counts[`configuration:${name}`] ?? 0 })),
        loading: false,
        error: "",
        hasSnapshot: true,
      });
      setTableIds([...new Set([...resolvedTableIds, ...counts.tableIds])]);
    }).catch((failure: unknown) => {
      if (active) { setState(emptyTypedCards(scope, false, failure instanceof Error ? failure.message : String(failure))); setTableIds([]); }
    });
    return () => { active = false; };
  }, [organizationId, refresh, scope]);
  useTableInvalidations(tableIds, organizationId || null, () => setRefresh((value) => value + 1), () => { setState(emptyTypedCards(scope, false)); setTableIds([]); });
  const visible = state.scope === scope ? state : emptyTypedCards(scope);
  return { assetTypes: visible.assetTypes, configurationTypes: visible.configurationTypes, loading: visible.loading, error: visible.error, retry: () => setRefresh((value) => value + 1) };
}

function useGlobalAssetTypeRoute(typeId: string | undefined, organizationId: string) {
  const [groups, setGroups] = useState<GlobalAssetTypeGroup[]>([]);
  const [loading, setLoading] = useState(Boolean(typeId));
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [tableId, setTableId] = useState<string | null>(null);
  const scope = `global-asset-route:${organizationId}:${typeId ?? ""}`;
  useEffect(() => { setGroups([]); setTableId(null); setLoading(Boolean(typeId)); setError(""); }, [scope, typeId]);
  useEffect(() => {
    if (!typeId) return;
    let active = true;
    let resolvedTableId: string | null = null;
    setLoading(true); setError("");
    loadGlobalAssetTypeGroups(tables.query as TableQuery, organizationId, {
      isCurrent: () => active,
      onTableResolved: (table) => { resolvedTableId = table; },
    }).then((next) => {
      if (!active || next === null) return;
      setGroups(next); setTableId(resolvedTableId); setLoading(false);
    }).catch((failure: unknown) => {
      if (active) { setGroups([]); setTableId(null); setError(failure instanceof Error ? failure.message : String(failure)); setLoading(false); }
    });
    return () => { active = false; };
  }, [organizationId, refresh, scope, typeId]);
  useTableInvalidation(tableId, organizationId || null, () => setRefresh((value) => value + 1), () => { setGroups([]); setTableId(null); setLoading(false); setError(""); });
  const group = globalAssetTypeGroup(groups, typeId);
  const typeIds = useMemo(() => resolveGlobalAssetTypeIds(groups, typeId, organizationId), [groups, organizationId, typeId]);
  return { group, typeIds, loading, error, retry: () => setRefresh((value) => value + 1) };
}

function useListedAssetFields(typeId: string | undefined, organizationId: string) {
  const [fields, setFields] = useState<AssetField[]>([]);
  const [loading, setLoading] = useState(Boolean(typeId));
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [tableId, setTableId] = useState<string | null>(null);
  const [tableScope, setTableScope] = useState("");
  const scope = `${organizationId}:${typeId ?? ""}`;
  useEffect(() => { setFields([]); setTableId(null); setTableScope(""); setLoading(Boolean(typeId)); setError(""); }, [scope, typeId]);
  useEffect(() => {
    if (!typeId) return;
    let active = true;
    setLoading(true); setError("");
    tables.get("docs-flexible-asset-types", typeId).then((type) => {
      if (!active) return;
      setTableId(typeof type?.table_id === "string" ? type.table_id : null); setTableScope(scope);
      setFields(safeAssetFields(type?.data?.fields).filter((field) => field.showInList));
      setLoading(false);
    }).catch((failure: unknown) => {
      if (active) { setFields([]); setTableId(null); setTableScope(""); setError(failure instanceof Error ? failure.message : String(failure)); setLoading(false); }
    });
    return () => { active = false; };
  }, [typeId, refresh, scope]);
  useTableInvalidation(tableScope === scope ? tableId : null, organizationId || null, () => setRefresh((value) => value + 1), () => { setFields([]); setTableId(null); setTableScope(""); setLoading(false); setError(""); });
  return { fields, loading, error, retry: () => setRefresh((value) => value + 1) };
}

const CORE_CARD_DETAILS: Record<string, { icon: LucideIcon; description: string }> = {
  passwords: { icon: KeyRound, description: "Metadata across organizations; values stay in IT Glue" },
  locations: { icon: MapPin, description: "Physical and virtual locations" },
  documents: { icon: FileText, description: "Documentation across organizations" },
};

function GlobalCard({ to, title, description, icon: Icon, count, loading, unavailable }: { to: string; title: string; description: string; icon: LucideIcon; count: number | undefined; loading: boolean; unavailable: boolean }) {
  return (
    <Link to={to} className="rounded-[var(--bf-radius-surface)] no-underline outline-none focus-visible:ring-2 focus-visible:ring-[var(--bf-primary)]">
      <Card className="h-full transition-colors hover:border-[var(--bf-primary)]">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-lg"><Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-primary" />{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-2">
          {loading ? <Skeleton className="h-7 w-20" /> : unavailable ? <p className="text-sm font-medium text-muted-foreground">Unavailable</p> : <p className="text-2xl font-semibold tabular-nums">{(count ?? 0).toLocaleString()}<span className="ml-2 text-xs font-normal text-muted-foreground"> enabled</span></p>}
          <ArrowRight aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
        </CardContent>
      </Card>
    </Link>
  );
}

export function GlobalPage() {
  const { organizationId } = useDocsOrganizations();
  const core = useGlobalCounts(organizationId);
  const typed = useGlobalTypedCards(organizationId);
  const error = core.error || typed.error;
  return (
    <div className="docs-page">
      <section className="page-heading"><div><p className="section-kicker">Cross-organization</p><h1>Global view</h1><p>Every organization in your Bifrost scope, side by side.</p></div></section>
      {error && <BfAlert tone="danger" title="Global records could not load">{error}<span className="mt-2 block"><BfButton variant="secondary" onClick={() => { core.retry(); typed.retry(); }}>Retry</BfButton></span></BfAlert>}
      <section aria-labelledby="global-core-heading"><h2 id="global-core-heading" className="mb-4 text-lg font-semibold">Core assets</h2><div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{PRIMARY_GLOBAL_KINDS.map((kind) => { const entry = catalogEntry(kind); return <GlobalCard key={kind} to={`/global/${kind}`} title={kind === "passwords" ? "Passwords" : entry.label} icon={CORE_CARD_DETAILS[kind].icon} description={CORE_CARD_DETAILS[kind].description} count={core.totals[kind]} loading={core.loading} unavailable={Boolean(core.error)} />; })}</div></section>
      <section aria-labelledby="global-configurations-heading" className="mt-8"><h2 id="global-configurations-heading" className="mb-4 text-lg font-semibold">Configurations</h2>{typed.loading ? <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div> : typed.configurationTypes.length === 0 ? <p className="text-sm text-muted-foreground">No configuration types are available in this scope.</p> : <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{typed.configurationTypes.map((type) => <GlobalCard key={type.name} to={`/global/configurations?type=${encodeURIComponent(type.name)}`} title={type.name} icon={Server} description="Configuration items" count={type.count} loading={false} unavailable={Boolean(typed.error)} />)}</div>}</section>
      <section aria-labelledby="global-custom-assets-heading" className="mt-8"><h2 id="global-custom-assets-heading" className="mb-4 text-lg font-semibold">Custom assets</h2>{typed.loading ? <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div> : typed.assetTypes.length === 0 ? <p className="text-sm text-muted-foreground">No custom asset types are available in this scope.</p> : <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{typed.assetTypes.map((type) => <GlobalCard key={type.id} to={`/global/assets/${type.id}`} title={type.name} icon={Layers} description="Custom asset items" count={type.count} loading={false} unavailable={Boolean(typed.error)} />)}</div>}</section>
    </div>
  );
}

export function GlobalKindPage() {
  const { kind, typeId } = useParams<{ kind: string; typeId?: string }>();
  const navigate = useNavigate();
  const names = useOrgNameMap();
  const { organizationId } = useDocsOrganizations();
  const [page, setPage] = useState(1);
  const [searchParams] = useSearchParams();
  const initialSearch = searchParams.get("q") ?? "";
  const configurationType = kind === "configurations" ? optionalText(searchParams.get("type")) : "";
  const [search, setSearch] = useState(() => initialSearch);
  const [refresh, setRefresh] = useState(0);
  const [sort, setSort] = useState<BfDataTableSort>({ columnId: "updated", direction: "descending" });
  useEffect(() => { setPage(1); setSearch(initialSearch); }, [kind, typeId, initialSearch, configurationType]);
  const [state, setState] = useState<{ rows: Row[]; total: number; loading: boolean; error: Error | null }>({ rows: [], total: 0, loading: true, error: null });
  const [tableId, setTableId] = useState<string | null>(null);
  const normalizedKind = typeId || kind === "assets" ? "flexible-assets" : kind;
  const validKind = normalizedKind && isCatalogKind(normalizedKind) && normalizedKind !== "document-folders" && normalizedKind !== "password-folders" && normalizedKind !== "flexible-asset-types" ? normalizedKind as CatalogKind : null;
  const entry = validKind ? catalogEntry(validKind) : null;
  const assetTypeRoute = useGlobalAssetTypeRoute(validKind === "flexible-assets" ? typeId : undefined, organizationId);
  const assetTypeIdsKey = assetTypeRoute.typeIds.join(",");
  const tableScope = `${entry?.table ?? ""}:${organizationId}:${assetTypeIdsKey}:${configurationType}`;
  const [resolvedTableScope, setResolvedTableScope] = useState("");
  const assetFields = useListedAssetFields(validKind === "flexible-assets" ? assetTypeRoute.group?.id : undefined, organizationId);
  useEffect(() => { setTableId(null); setResolvedTableScope(""); setState({ rows: [], total: 0, loading: Boolean(entry), error: null }); }, [tableScope, entry]);

  const columns: Array<BfDataColumn<Row>> = useMemo(() => {
    if (!entry) return [];
    return [
      { id: "name", header: entry.singular, accessor: (row) => asText(row.name), sortable: true, sortValue: (row) => asText(row.name) },
      { id: "organization", header: "Organization", accessor: (row) => names[String(row.organization_id ?? "")] ?? asText(row.organization_id), width: "24%" },
      ...(validKind === "passwords" ? [{ id: "username", header: "Username", accessor: (row: Row) => asText(row.username) }, { id: "category", header: "Category", accessor: (row: Row) => asText(row.category_name) }] : validKind === "configurations" ? [{ id: "type", header: "Type", accessor: (row: Row) => asText(row.configuration_type_name) }, { id: "status", header: "Status", accessor: (row: Row) => asText(row.configuration_status_name) }, { id: "hostname", header: "Hostname", accessor: (row: Row) => asText(row.hostname) }] : validKind === "locations" ? [{ id: "address", header: "Address", accessor: (row: Row) => [row.address_1, row.city, row.region].filter(Boolean).join(", ") || "—" }] : validKind === "flexible-assets" ? assetFields.fields.map((field) => ({ id: `trait:${field.key}`, header: field.name, accessor: (row: Row) => displayAssetValue(field, row.traits && typeof row.traits === "object" ? (row.traits as Record<string, unknown>)[field.key] : undefined) })) : []),
      { id: "updated", header: "Source updated", accessor: (row) => timeLabel(row.source_updated_at ?? row.updated_at), width: "20%", sortable: true, sortValue: (row) => String(row.source_updated_at ?? row.updated_at ?? "") },
    ];
  }, [assetFields.fields, entry, names, validKind]);

  useEffect(() => {
    if (!entry) { setTableId(null); setResolvedTableScope(""); setState({ rows: [], total: 0, loading: false, error: null }); return; }
    if (validKind === "flexible-assets" && typeId && assetTypeRoute.loading) return;
    if (validKind === "flexible-assets" && typeId && assetTypeRoute.typeIds.length === 0) { setTableId(null); setResolvedTableScope(tableScope); setState({ rows: [], total: 0, loading: false, error: null }); return; }
    let active = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    const where: Record<string, unknown> = {
      ...(catalogSearchWhere(entry, search) ?? {}),
      ...(organizationId ? { organization_id: organizationId } : {}),
      ...(validKind === "configurations" && configurationType ? { configuration_type_name: configurationType } : {}),
      ...(validKind === "flexible-assets" && typeId ? { flexible_asset_type_id: { in: assetTypeRoute.typeIds } } : {}),
    };
    tables.query(entry.table, { where: Object.keys(where).length ? where : undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, order_by: sort.columnId === "name" ? "name" : sort.columnId === "updated" ? "updated_at" : "name", order_dir: sort.direction === "ascending" ? "asc" : "desc" }).then((result) => {
      if (!active) return;
      setTableId(typeof result.table_id === "string" ? result.table_id : null); setResolvedTableScope(tableScope);
      const documents = Array.isArray(result.documents) ? result.documents : [];
      setState({ rows: documents.map((doc) => ({ ...(doc.data ?? {}), id: doc.id })), total: Number(result.total) || 0, loading: false, error: null });
    }).catch((error: unknown) => { if (active) { setTableId(null); setResolvedTableScope(""); setState({ rows: [], total: 0, loading: false, error: error instanceof Error ? error : new Error(String(error)) }); } });
    return () => { active = false; };
  }, [assetTypeIdsKey, assetTypeRoute.loading, configurationType, entry, page, typeId, validKind, search, refresh, sort, organizationId, tableScope]);
  useTableInvalidation(resolvedTableScope === tableScope ? tableId : null, organizationId || null, () => setRefresh((value) => value + 1), () => { setTableId(null); setResolvedTableScope(""); setState({ rows: [], total: 0, loading: false, error: null }); });

  if (!entry || !validKind) return <div className="route-state"><BfAlert tone="warning" title="Unknown global view">Choose a record type from the Global view.</BfAlert></div>;
  const title = configurationType ? `${entry.label} — ${configurationType}` : assetTypeRoute.group ? assetTypeRoute.group.name : entry.label;
  return <div className="docs-page"><section className="page-heading"><div><p className="section-kicker">Global view</p><h1>{title}</h1><p>{entry.description}</p></div></section>{assetTypeRoute.error && <BfAlert tone="danger" title="Asset type could not load">{assetTypeRoute.error}<span className="mt-2 block"><BfButton variant="secondary" onClick={assetTypeRoute.retry}>Retry</BfButton></span></BfAlert>}{assetFields.error && <BfAlert tone="danger" title="Asset type fields could not load">{assetFields.error}<span className="mt-2 block"><BfButton variant="secondary" onClick={assetFields.retry}>Retry</BfButton></span></BfAlert>}<CatalogToolbar label={`Search ${entry.label.toLowerCase()}`} value={search} onValueChange={value => { setSearch(value); setPage(1); }} onRefresh={() => setRefresh(value => value + 1)} refreshing={state.loading} /><BfDataTable rows={state.rows} minWidth={`${Math.max(640, columns.length * 145)}px`} columns={columns} getRowId={(row) => row.id} ariaLabel={`Global ${entry.label}`} caption={`${state.total} records across organizations`} loading={state.loading} sort={sort} onSortChange={(next) => { setSort(next); setPage(1); }} error={state.error ? { title: "Global view could not load", description: state.error.message, onRetry: () => setRefresh((value) => value + 1) } : undefined} emptyState={{ title: "No records yet", description: "Run an IT Glue migration to make records available here." }} pagination={{ page, pageSize: PAGE_SIZE, total: state.total, onPageChange: setPage }} getRowHref={(row) => `/${validKind}/${row.id}`} onRowActivate={(row) => navigate(`/${validKind}/${row.id}`)} /></div>;
}
