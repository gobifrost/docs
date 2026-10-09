import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Loader2, Plus, Trash2 } from "lucide-react";
import { tables } from "bifrost";
import { BfAlert } from "./bifrost/BfAlert";
import { BfButton } from "./bifrost/BfButton";
import { BfCombobox, type BfComboboxOption } from "./bifrost/BfCombobox";
import { BfDataTable, type BfDataColumn } from "./bifrost/BfDataTable";
import { BfDialog } from "./bifrost/BfDialog";
import { BfSwitch } from "./bifrost/BfSelection";
import { BfTextField } from "./bifrost/BfField";
import {
  activeTaxonomyOptions,
  taxonomyTable,
  type ConfigurationTaxonomyKind,
  type TaxonomyRow,
} from "../lib/configuration-taxonomy";
import { useTableInvalidation } from "../lib/table-realtime";

type TableDocument = { id: string; data?: Record<string, unknown> };
type TaxonomyRecord = TaxonomyRow & Record<string, unknown>;

const labelFor = (kind: ConfigurationTaxonomyKind) => kind === "type" ? "Configuration type" : "Configuration status";
const pluralFor = (kind: ConfigurationTaxonomyKind) => `${labelFor(kind)}${kind === "status" ? "es" : "s"}`;

function flatten(document: TableDocument): TaxonomyRecord {
  return { ...(document.data ?? {}), id: document.id };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sourceLabel(row: TaxonomyRecord) {
  return row.source_system === "bifrost" ? "Bifrost authored" : "IT Glue source";
}

export function ConfigurationTaxonomySelect({
  kind,
  organizationId,
  value,
  onValueChange,
}: {
  kind: ConfigurationTaxonomyKind;
  organizationId: string;
  value: string;
  onValueChange: (value: string) => void;
}) {
  const [rows, setRows] = useState<TaxonomyRow[]>([]);
  const [loading, setLoading] = useState(Boolean(organizationId));
  const [error, setError] = useState("");
  const [tableId, setTableId] = useState<string | null>(null);
  const [tableScope, setTableScope] = useState("");
  const [refresh, setRefresh] = useState(0);
  const table = taxonomyTable(kind);
  const label = labelFor(kind);
  const scope = `${organizationId}:${table}`;

  useEffect(() => {
    setRows([]); setTableId(null); setTableScope(""); setLoading(Boolean(organizationId)); setError("");
  }, [scope, organizationId]);

  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    setLoading(true); setError("");
    tables.query(table, { where: { organization_id: organizationId }, limit: 500, order_by: "name", order_dir: "asc" })
      .then((result) => {
        if (!active) return;
        setTableId(typeof result.table_id === "string" ? result.table_id : null); setTableScope(scope);
        const documents = Array.isArray(result.documents) ? result.documents : [];
        setRows(documents.map(flatten));
        setLoading(false);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setRows([]); setTableId(null); setTableScope(""); setError(errorText(loadError)); setLoading(false);
      });
    return () => { active = false; };
  }, [organizationId, table, refresh, scope]);
  useTableInvalidation(tableScope === scope ? tableId : null, organizationId || null, () => setRefresh((value) => value + 1), () => { setTableId(null); setTableScope(""); setRows([]); setLoading(false); setError(""); });

  const options = useMemo(() => activeTaxonomyOptions(rows, value), [rows, value]);
  return <BfCombobox
    label={label}
    hint={error ? `Could not load ${pluralFor(kind).toLowerCase()}: ${error}` : "Only active choices are available."}
    options={options}
    value={value}
    onValueChange={onValueChange}
    loading={loading}
    disabled={Boolean(error) || !organizationId}
    clearable={kind === "status"}
    placeholder={rows.length ? `Select ${label.toLowerCase()}` : `No active ${pluralFor(kind).toLowerCase()} available`}
    emptyText={`No active ${pluralFor(kind).toLowerCase()} are available for this Bifrost organization.`}
  />;
}

function TaxonomyDialog({
  kind,
  organizationId,
  row,
  onClose,
  onSaved,
}: {
  kind: ConfigurationTaxonomyKind;
  organizationId: string;
  row?: TaxonomyRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(typeof row?.name === "string" ? row.name : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const label = labelFor(kind);

  async function save() {
    if (!name.trim()) { setError(`${label} name is required.`); return; }
    setSaving(true); setError("");
    try {
      if (row) {
        await tables.update(taxonomyTable(kind), row.id, { name: name.trim() });
      } else {
        await tables.insert(taxonomyTable(kind), {
          organization_id: organizationId,
          source_system: "bifrost",
          source_id: crypto.randomUUID(),
          source_updated_at: new Date().toISOString(),
          name: name.trim(),
          active: true,
          raw: null,
        });
      }
      onSaved();
    } catch (saveError) { setError(errorText(saveError)); } finally { setSaving(false); }
  }

  return <BfDialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }} title={row ? `Rename ${label.toLowerCase()}` : `New ${label.toLowerCase()}`} description="Native taxonomy is scoped to the selected Bifrost organization." footer={<><BfButton variant="secondary" disabled={saving} onClick={onClose}>Cancel</BfButton><BfButton disabled={saving} icon={saving ? <Loader2 className="spin" size={15} /> : <CheckCircle2 size={15} />} onClick={save}>{saving ? "Saving" : "Save"}</BfButton></>}><div className="editor-form"><BfTextField label="Name" value={name} onChange={(event) => setName(event.target.value)} autoFocus />{error && <BfAlert tone="danger" title={`Could not save ${label.toLowerCase()}`}>{error}</BfAlert>}</div></BfDialog>;
}

export function ConfigurationTaxonomyAdmin({ organizationId, kind: controlledKind, initialKind = "type", hideHeader = false }: { organizationId: string; kind?: ConfigurationTaxonomyKind; initialKind?: ConfigurationTaxonomyKind; hideHeader?: boolean }) {
  const [selectedKind, setKind] = useState<ConfigurationTaxonomyKind>(initialKind);
  const kind = controlledKind ?? selectedKind;
  const [rows, setRows] = useState<TaxonomyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<TaxonomyRecord | "new" | null>(null);
  const [removing, setRemoving] = useState<TaxonomyRecord | null>(null);
  const [workingId, setWorkingId] = useState("");
  const [tableId, setTableId] = useState<string | null>(null);
  const [tableScope, setTableScope] = useState("");
  const [realtimeRefresh, setRealtimeRefresh] = useState(0);
  const requestRef = useRef(0);
  const scopeRef = useRef("");
  const table = taxonomyTable(kind);
  const label = labelFor(kind);
  const scopeKey = `${organizationId}:${table}`;
  scopeRef.current = scopeKey;

  const refresh = () => {
    if (scopeRef.current !== scopeKey) return;
    const request = ++requestRef.current;
    const current = () => request === requestRef.current && scopeRef.current === scopeKey;
    if (!organizationId) { if (current()) { setRows([]); setTableId(null); setTableScope(""); setLoading(false); } return; }
    setLoading(true); setError("");
    tables.query(table, { where: { organization_id: organizationId }, limit: 500, order_by: "name", order_dir: "asc" })
      .then((result) => {
        if (!current()) return;
        setTableId(typeof result.table_id === "string" ? result.table_id : null); setTableScope(scopeKey);
        const documents = Array.isArray(result.documents) ? result.documents : [];
        setRows(documents.map(flatten)); setLoading(false);
      })
      .catch((loadError: unknown) => { if (current()) { setTableId(null); setTableScope(""); setRows([]); setError(errorText(loadError)); setLoading(false); } });
  };

  useEffect(() => {
    requestRef.current += 1;
    setRows([]); setTableId(null); setTableScope(""); setError(""); setEditing(null); setRemoving(null); setWorkingId("");
  }, [organizationId, table]);
  useEffect(() => {
    refresh();
  }, [organizationId, table, realtimeRefresh]);
  useTableInvalidation(editing || tableScope !== scopeKey ? null : tableId, organizationId || null, () => setRealtimeRefresh((value) => value + 1), () => { setTableId(null); setTableScope(""); setRows([]); setLoading(false); setError(""); });

  async function setActive(row: TaxonomyRecord, active: boolean) {
    const mutationScope = scopeKey;
    setWorkingId(row.id); setError("");
    try { await tables.update(table, row.id, { active }); if (scopeRef.current === mutationScope) refresh(); } catch (updateError) { if (scopeRef.current === mutationScope) setError(errorText(updateError)); } finally { if (scopeRef.current === mutationScope) setWorkingId(""); }
  }
  async function remove() {
    if (!removing) return;
    const mutationScope = scopeKey;
    setWorkingId(removing.id); setError("");
    try { await tables.delete(table, removing.id); if (scopeRef.current === mutationScope) { setRemoving(null); refresh(); } } catch (deleteError) { if (scopeRef.current === mutationScope) setError(errorText(deleteError)); } finally { if (scopeRef.current === mutationScope) setWorkingId(""); }
  }

  const closeEditor = () => {
    if (scopeRef.current !== scopeKey) return;
    setEditing(null);
    refresh();
  };

  const columns: BfDataColumn<TaxonomyRecord>[] = [
    { id: "name", header: "Name", accessor: (row) => typeof row.name === "string" && row.name ? row.name : "—", sortable: true, sortValue: (row) => String(row.name ?? "") },
    { id: "state", header: "State", accessor: (row) => row.active === false ? "Inactive" : "Active", width: "16%" },
    { id: "source", header: "Provenance", accessor: sourceLabel, width: "20%" },
    { id: "actions", header: "Actions", width: "28%", accessor: (row) => row.source_system === "bifrost" ? <div className="taxonomy-actions"><BfButton variant="ghost" disabled={workingId === row.id} onClick={() => setEditing(row)}>Rename</BfButton><BfSwitch checked={row.active !== false} label={row.active === false ? "Inactive" : "Active"} ariaLabel={`${row.active === false ? "Activate" : "Deactivate"} ${String(row.name ?? label)}`} onChange={(active) => setActive(row, active)} /><BfButton variant="danger" disabled={workingId === row.id} onClick={() => setRemoving(row)}>Delete</BfButton></div> : <span className="muted">Managed by IT Glue migration</span> },
  ];

  return <div className={hideHeader ? "grid gap-4" : "docs-page detail-page"}>{hideHeader ? null : <section className="page-heading"><div><p className="section-kicker">Administrator area</p><h1>Configuration taxonomy</h1><p>Manage Bifrost-authored types and statuses for this organization. IT Glue copies remain source-owned and refresh with migration.</p></div></section>}<section className={controlledKind === undefined ? "catalog-controls" : "flex flex-wrap items-center justify-between gap-3"} aria-label="Configuration taxonomy">{controlledKind === undefined ? <div className="catalog-tabs" role="tablist" aria-label="Taxonomy kind"><BfButton role="tab" aria-selected={kind === "type"} variant={kind === "type" ? "primary" : "secondary"} onClick={() => setKind("type")}>Configuration types</BfButton><BfButton role="tab" aria-selected={kind === "status"} variant={kind === "status" ? "primary" : "secondary"} onClick={() => setKind("status")}>Configuration statuses</BfButton></div> : <h2 className="text-xl font-semibold">{pluralFor(kind)}</h2>}<BfButton icon={<Plus size={15} />} onClick={() => setEditing("new")}>New {label}</BfButton></section>{error && <BfAlert tone="danger" title="Taxonomy action failed">{error}</BfAlert>}<BfDataTable rows={rows} columns={columns} getRowId={(row) => row.id} ariaLabel={pluralFor(kind)} loading={loading} emptyState={{ title: `No ${pluralFor(kind).toLowerCase()} yet`, description: "Create a native choice or run the IT Glue migration." }} />{editing && <TaxonomyDialog kind={kind} organizationId={organizationId} row={editing === "new" ? undefined : editing} onClose={closeEditor} onSaved={closeEditor} />}{removing && <BfDialog open onOpenChange={(open) => { if (!open && !workingId) setRemoving(null); }} title={`Delete ${label.toLowerCase()}?`} description="Configurations that still use this name retain their stored value, but it will no longer be selectable." footer={<><BfButton variant="secondary" disabled={Boolean(workingId)} onClick={() => setRemoving(null)}>Cancel</BfButton><BfButton variant="danger" disabled={Boolean(workingId)} icon={workingId ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />} onClick={remove}>{workingId ? "Deleting" : "Delete"}</BfButton></>}><p className="empty-copy">Delete {String(removing.name ?? label)}?</p></BfDialog>}</div>;
}
