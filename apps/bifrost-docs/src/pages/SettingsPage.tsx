import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ExternalLink, Layers, Plus, RefreshCw, Trash2 } from "lucide-react";
import { tables, useBifrostContext, useWorkflowMutation } from "bifrost";
import { AssetTypeEditor, assetTypeDefaults, normalizeAssetTypeFields, safeAssetTypeFields, type AssetTypeValues } from "@/components/AssetTypeEditor";
import { BfAlert } from "@/components/bifrost/BfAlert";
import { BfButton } from "@/components/bifrost/BfButton";
import { BfSelect } from "@/components/bifrost/BfField";
import { BfSwitch } from "@/components/bifrost/BfSelection";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfigurationTaxonomyAdmin } from "@/components/ConfigurationTaxonomy";
import { useDocsOrganizations } from "@/components/layout/useDocsOrganizations";
import { cn } from "@/lib/ds-utils";
import { useTableInvalidation } from "@/lib/table-realtime";

type Row = Record<string, unknown> & { id: string };
const SECTIONS = [{ path: "/settings/configuration-types", label: "Configuration types" }, { path: "/settings/configuration-statuses", label: "Configuration statuses" }, { path: "/settings/custom-asset-types", label: "Custom asset types" }, { path: "/settings/knowledge", label: "Knowledge & agent" }, { path: "/settings/backup", label: "Backup & recovery" }];
const aliases: Record<string, string> = { "/settings/ai": "/settings/knowledge", "/settings/exports": "/settings/backup" };
export const normalizeSettingsPath = (path: string) => aliases[path] ?? path;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function OrganizationPicker({ label = "Bifrost organization" }: { label?: string }) {
  const { organizations, organizationId, setOrganizationId, loading } = useDocsOrganizations();
  return <BfSelect label={label} value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} options={[{ value: "", label: loading ? "Loading organizations…" : "Choose an organization" }, ...organizations.map((organization) => ({ value: organization.id, label: organization.name }))]} disabled={loading} />;
}

function TaxonomySection({ kind }: { kind: "type" | "status" }) {
  const { organizationId } = useDocsOrganizations();
  return <div className="grid gap-4"><OrganizationPicker />{organizationId ? <ConfigurationTaxonomyAdmin organizationId={organizationId} kind={kind} hideHeader /> : <BfAlert tone="info" title="Choose a Bifrost organization">Select an organization whose taxonomy you want to manage.</BfAlert>}</div>;
}

function assetTypeRow(document: { id: string; data?: Record<string, unknown> }): Row {
  const data = document.data ?? {}; return { ...data, id: document.id, fields: safeAssetTypeFields(normalizeAssetTypeFields(data.fields)), active: data.active !== false };
}

function CustomAssetTypesSection() {
  const { organizationId } = useDocsOrganizations(); const [types, setTypes] = useState<Row[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [editing, setEditing] = useState<Row | "new" | null>(null); const [saving, setSaving] = useState(false); const [tableId, setTableId] = useState<string | null>(null); const [tableScope, setTableScope] = useState(""); const [realtimeRefresh, setRealtimeRefresh] = useState(0); const requestRef = useRef(0); const organizationRef = useRef(organizationId); organizationRef.current = organizationId;
  const scope = organizationId;
  const load = useCallback(async () => { if (organizationRef.current !== organizationId) return; const request = ++requestRef.current; const current = () => request === requestRef.current && organizationRef.current === organizationId; if (!organizationId) { if (current()) { setTypes([]); setTableId(null); setTableScope(""); setLoading(false); } return; } setLoading(true); setError(""); try { const result = await tables.query("docs-flexible-asset-types", { where: { organization_id: organizationId }, limit: 500, order_by: "name", order_dir: "asc" }); if (!current()) return; setTableId(typeof result.table_id === "string" ? result.table_id : null); setTableScope(scope); setTypes((Array.isArray(result.documents) ? result.documents : []).map(assetTypeRow)); } catch (failure) { if (current()) { setTableId(null); setTableScope(""); setTypes([]); setError(errorText(failure)); } } finally { if (current()) setLoading(false); } }, [organizationId, realtimeRefresh, scope]);
  useEffect(() => { requestRef.current += 1; setEditing(null); setTypes([]); setTableId(null); setTableScope(""); setError(""); }, [scope]);
  useEffect(() => { void load(); }, [load]);
  useTableInvalidation(editing || tableScope !== scope ? null : tableId, organizationId || null, () => setRealtimeRefresh((value) => value + 1), () => { setTableId(null); setTableScope(""); setTypes([]); setLoading(false); setError(""); });
  async function save(values: AssetTypeValues) { if (!organizationId) throw new Error("Choose an organization before saving an asset type."); const mutationOrganizationId = organizationId; setSaving(true); try { const payload = { name: values.name, icon: values.icon, active: values.active, fields: safeAssetTypeFields(values.fields), source_updated_at: new Date().toISOString() }; if (editing === "new") await tables.insert("docs-flexible-asset-types", { ...payload, organization_id: organizationId, source_system: "bifrost", source_id: crypto.randomUUID(), raw: null }); else if (editing) await tables.update("docs-flexible-asset-types", editing.id, payload, organizationId); if (organizationRef.current !== mutationOrganizationId) return; setEditing(null); await load(); } finally { if (organizationRef.current === mutationOrganizationId) setSaving(false); } }
  async function setActive(row: Row, active: boolean) { if (!organizationId) return; const mutationOrganizationId = organizationId; setError(""); try { await tables.update("docs-flexible-asset-types", row.id, { active }, organizationId); if (organizationRef.current === mutationOrganizationId) await load(); } catch (failure) { if (organizationRef.current === mutationOrganizationId) setError(errorText(failure)); } }
  async function remove(row: Row) { if (!organizationId || !window.confirm(`Delete ${String(row.name ?? "this asset type")}?`)) return; const mutationOrganizationId = organizationId; setError(""); try { const assets = await tables.query("docs-flexible-assets", { where: { organization_id: organizationId, flexible_asset_type_id: row.id }, limit: 1 }); if ((assets.total ?? assets.documents.length) > 0) throw new Error("This type has assets. Set it inactive to preserve their field definitions."); await tables.delete("docs-flexible-asset-types", row.id, organizationId); if (organizationRef.current !== mutationOrganizationId) return; if (editing && editing !== "new" && editing.id === row.id) setEditing(null); await load(); } catch (failure) { if (organizationRef.current === mutationOrganizationId) setError(errorText(failure)); } }
  const initial = editing === "new" ? assetTypeDefaults() : editing ? assetTypeDefaults({ name: typeof editing.name === "string" ? editing.name : "", icon: typeof editing.icon === "string" ? editing.icon : "", active: editing.active !== false, fields: normalizeAssetTypeFields(editing.fields) }) : undefined;
  return <div className="grid gap-4"><OrganizationPicker />{!organizationId ? <BfAlert tone="info" title="Choose a Bifrost organization">Custom asset types are scoped to one organization.</BfAlert> : editing ? <Card><CardHeader><CardTitle>{editing === "new" ? "New custom asset type" : `Edit ${String(editing.name ?? "custom asset type")}`}</CardTitle></CardHeader><CardContent><AssetTypeEditor initial={initial} saving={saving} sourceMapped={editing !== "new" && editing.source_system === "itglue"} onSave={save} onCancel={() => { setEditing(null); void load(); }} /></CardContent></Card> : <><div className="flex items-center justify-between"><div><h2 className="text-xl font-semibold">Custom asset types</h2><p className="text-sm text-muted-foreground">Manage names, icons, availability, and safe field schemas.</p></div><BfButton icon={<Plus size={15} />} onClick={() => setEditing("new")}>New asset type</BfButton></div>{error && <BfAlert tone="danger" title="Asset type action failed">{error}<div className="mt-2"><BfButton variant="secondary" icon={<RefreshCw size={15} />} onClick={() => void load()}>Retry</BfButton></div></BfAlert>}{loading ? <p className="text-sm text-muted-foreground">Loading asset types…</p> : types.length === 0 ? <BfAlert tone="info" title="No custom asset types">Create a native type or run the IT Glue migration.</BfAlert> : <div className="grid gap-2">{types.map((type) => <Card key={type.id}><CardContent className="flex flex-wrap items-center gap-3 py-3"><Layers size={18} aria-hidden="true" /><div className="min-w-40 flex-1"><strong>{String(type.name ?? type.id)}</strong><p className="text-xs text-muted-foreground">{Array.isArray(type.fields) ? type.fields.length : 0} fields{type.source_system === "itglue" ? " · mapped from IT Glue" : ""}</p></div><BfSwitch checked={type.active !== false} label={type.active === false ? "Inactive" : "Active"} ariaLabel={`Set ${String(type.name ?? "asset type")} active`} onChange={(active) => void setActive(type, active)} /><BfButton variant="secondary" onClick={() => setEditing(type)}>Edit</BfButton><BfButton variant="danger" icon={<Trash2 size={15} />} onClick={() => void remove(type)}>Delete</BfButton></CardContent></Card>)}</div>}</>}</div>;
}

function KnowledgeSection() {
  const { organizationId, loading: organizationsLoading } = useDocsOrganizations(); const sync = useWorkflowMutation("functions/indexing.py::docs_sync_knowledge_index"); const [result, setResult] = useState<Record<string, unknown> | null>(null); const [error, setError] = useState(""); const [offset, setOffset] = useState(0);
  useEffect(() => { setOffset(0); setResult(null); setError(""); }, [organizationId]);
  async function runSync(nextOffset = offset) { if (!organizationId) { setError("Choose a Bifrost organization first."); return; } setError(""); try { const outcome = await sync.mutate({ organization_id: organizationId, offset: nextOffset }) as Record<string, unknown>; setResult(outcome); setOffset(typeof outcome.next_offset === "number" ? outcome.next_offset : 0); } catch (failure) { setError(errorText(failure)); } }
  return <div className="grid gap-4"><Card><CardHeader><CardTitle>Knowledge index repair</CardTitle></CardHeader><CardContent className="grid gap-3"><p className="text-sm text-muted-foreground">Rebuild the safe search subset for one organization in bounded pages.</p><OrganizationPicker /><div className="flex flex-wrap gap-2"><BfButton disabled={sync.loading || organizationsLoading || !organizationId} onClick={() => void runSync(0)}>{sync.loading ? "Syncing…" : result?.next_offset != null ? "Restart sync" : "Sync knowledge page"}</BfButton>{result?.next_offset != null && <BfButton variant="secondary" disabled={sync.loading} onClick={() => void runSync(offset)}>Continue from {offset}</BfButton>}</div>{error && <BfAlert tone="danger" title="Knowledge sync failed">{error}</BfAlert>}{result && <BfAlert tone="success" title="Knowledge sync complete">Indexed {String(result.indexed ?? "?")}, removed {String(result.removed ?? "?")} of {String(result.processed ?? "?")} processed.{result.next_offset != null ? " More pages remain." : ""}</BfAlert>}</CardContent></Card></div>;
}

function BackupSection({ isPlatformAdmin }: { isPlatformAdmin: boolean }) {
  const { solutionId } = useBifrostContext();
  return <Card>
    <CardHeader><CardTitle>Bifrost Docs backup</CardTitle></CardHeader>
    <CardContent className="grid gap-4 text-sm">
      <p>Create encrypted backups and download completed exports from your Solution.</p>
      {isPlatformAdmin ? solutionId ? <>
        <a className="bds-button bds-button--primary justify-self-start" href={`/solutions/${encodeURIComponent(solutionId)}?tab=exports`}>
          <span>Manage backups</span><span className="bds-button__icon" aria-hidden="true"><ExternalLink size={15} /></span>
        </a>
        <p className="text-muted-foreground">Choose Backup under Export Solution. Include Table data and Solution-owned files for a full Docs backup.</p>
      </> : <p className="text-muted-foreground">Open Docs from its installed Solution to manage backups.</p> : <p className="text-muted-foreground">Backups are managed by a Bifrost platform administrator.</p>}
      <ul className="grid gap-2 list-disc pl-5 text-muted-foreground">
        <li>Includes Docs tables, record links, managed files, and Docs-wide configuration.</li>
        <li>The restore artifact is retained for seven days.</li>
        <li>Accounts, organizations, roles, and integration connections aren't included. Set them up in the destination and reconnect integrations before recovery.</li>
      </ul>
    </CardContent>
  </Card>;
}
function UnknownSettingsSection() { return <BfAlert tone="warning" title="Unknown settings section">Choose one of the settings sections in the navigation.</BfAlert>; }

function SettingsLayout({ isPlatformAdmin }: { isPlatformAdmin: boolean }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const selectedSection = SECTIONS.find((section) => section.path === normalizeSettingsPath(pathname))?.path ?? "";
  return <div className="docs-page">
    <section className="page-heading"><div><p className="section-kicker">Administration</p><h1>Settings</h1><p>Taxonomy, knowledge, and recovery for Bifrost Docs.</p></div></section>
    <div className="settings-layout">
      <nav aria-label="Settings sections" className="settings-nav">
        <div className="settings-nav__compact">
          <BfSelect label="Settings section" value={selectedSection} onChange={(event) => { if (event.target.value) navigate(event.target.value); }} options={[...(!selectedSection ? [{ value: "", label: "Choose a section" }] : []), ...SECTIONS.map((section) => ({ value: section.path, label: section.label }))]} />
        </div>
        <div className="settings-nav__links">{SECTIONS.map((section) => <NavLink key={section.path} to={section.path} className={({ isActive }) => cn("block rounded-md px-3 py-2 text-sm font-medium transition-colors", isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted")}>{section.label}</NavLink>)}</div>
      </nav>
      <div className="min-w-0"><Routes>
        <Route index element={<Navigate to="configuration-types" replace />} />
        <Route path="configuration-types" element={<TaxonomySection kind="type" />} />
        <Route path="configuration-statuses" element={<TaxonomySection kind="status" />} />
        <Route path="custom-asset-types" element={<CustomAssetTypesSection />} />
        <Route path="knowledge" element={<KnowledgeSection />} />
        <Route path="backup" element={<BackupSection isPlatformAdmin={isPlatformAdmin} />} />
        <Route path="ai" element={<Navigate to="../knowledge" replace />} />
        <Route path="exports" element={<Navigate to="../backup" replace />} />
        <Route path="*" element={<UnknownSettingsSection />} />
      </Routes></div>
    </div>
  </div>;
}
export function SettingsRoutes({ isAdmin, isPlatformAdmin = false }: { isAdmin: boolean; isPlatformAdmin?: boolean }) { return isAdmin ? <SettingsLayout isPlatformAdmin={isPlatformAdmin} /> : <div className="route-state"><BfAlert tone="warning" title="Settings require administration access">A Bifrost Docs Administrator can manage taxonomy, knowledge, and recovery.</BfAlert></div>; }
