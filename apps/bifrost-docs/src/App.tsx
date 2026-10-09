import { FormEvent, useEffect, useId, useMemo, useRef, useState, isValidElement, type ReactNode } from "react";
import { FileAccessDeniedError, FilePolicyError, TableAccessDeniedError, files, tables, useBifrostContext, useWorkflowMutation, useWorkflowQuery } from "bifrost";
import { ArrowLeft, CheckCircle2, Download, ExternalLink, FileText, FolderOpen, KeyRound, Layers, Layers3, Link2, List, Loader2, MapPin, Network, Paperclip, Pencil, Play, Plus, RefreshCw, RotateCcw, Server, ShieldCheck, Trash2, Upload, XCircle } from "lucide-react";
import { Link, Navigate, NavLink, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { BfAlert } from "./components/bifrost/BfAlert";
import { BfButton } from "./components/bifrost/BfButton";
import { BfDataTable, type BfDataColumn, type BfDataTableSort } from "./components/bifrost/BfDataTable";
import { BfDialog } from "./components/bifrost/BfDialog";
import { BfCombobox, BfMultiSelect, type BfComboboxOption } from "./components/bifrost/BfCombobox";
import { BfRadioGroup, BfSwitch } from "./components/bifrost/BfSelection";
import { BfChip } from "./components/bifrost/BfChip";
import { BfSelect, BfTextField, BfTextarea } from "./components/bifrost/BfField";
import { catalogEntries, catalogEntry, catalogSearchWhere, catalogEnabledWhere, isCatalogKind, relatedRecordEntry, relatedRecordPath, type CatalogEntry, type CatalogKind } from "./lib/catalog";
import { AppShell } from "./components/layout/AppShell";
import { trackRecentRecord } from "./components/layout/recentRecords";
import { AuditTrailPage } from "./pages/AuditTrailPage";
import { DocumentWorkspace } from "./components/DocumentWorkspace";
import { RichEditor } from "./components/RichEditor";
import { AssetTypeGrid, AssetTypeLink } from "./components/AssetTypeGrid";
import { UtilityCard } from "./components/UtilityCard";
import { RecordEnabledAction } from "./components/RecordEnabledAction";
import { DocumentTools, type DocumentTool } from "./components/DocumentTools";
import { CatalogToolbar } from "./components/CatalogToolbar";
import { DashboardPage } from "./pages/DashboardPage";
import { GlobalKindPage, GlobalPage } from "./pages/GlobalPages";
import { OrganizationsPage } from "./pages/OrganizationsPage";
import { SettingsRoutes } from "./pages/SettingsPage";
import { canPublishNativeDraft, documentMutationRefs, documentUpdatePayload, sourceSyncWarning } from "./lib/editing";
import { extractHeadings, looksLikeHtml, splitDocumentContent, type DocumentHeading } from "./lib/document-content";
import { attachmentLocation, attachmentWorkflowRefs, nativeAttachmentPath, safeAttachmentFileName, type NativeAttachmentParentType } from "./lib/attachment-upload";
import { draftContentWithoutPendingImages, pendingAttachmentRef, resolvePendingImageRefs } from "./lib/pending-images";
import { ConfigurationTaxonomyAdmin, ConfigurationTaxonomySelect } from "./components/ConfigurationTaxonomy";
import { ExportRecoveryPanel } from "./components/ExportRecoveryPanel";
import { AssetFields, assetFieldDefaults, safeAssetFields, safeAssetTraits, validateAssetTraits, displayAssetValue, assetTagLabels } from "./components/AssetFields";
import { useDocsOrganizations } from "./components/layout/useDocsOrganizations";
import { SearchDialog, type CatalogSearchResult } from "./components/layout/SearchDialog";
import { OrgHomePage } from "./pages/OrgHomePage";
import { queryAllPages } from "./lib/table-query";
import { useTableInvalidation } from "./lib/table-realtime";

type Row = Record<string, unknown> & { id: string };
type TableDocument = { id: string; data?: Record<string, unknown>; created_at?: string; updated_at?: string };
type MigrationMode = "proof" | "bulk" | "delta" | "reconcile";
type Viewer = { id?: string; organization_id?: string | null; is_superuser: boolean; roles: string[] };
type PreflightOrganization = { bifrost_organization_id: string; bifrost_organization_name: string; itglue_organization_name: string };
type MigrationPreflight = { organizations: PreflightOrganization[]; resource_types: string[]; count: number };
type MigrationRunSummary = { id: string; status: string; mode: string; started_at?: string | null; organization_count: number; resource_count: number; recovery_status?: string | null };
type MigrationStatus = { runs?: MigrationRunSummary[]; run: null | { id: string; status: string; mode: string; phase: string; started_at?: string | null; last_checkpoint_at?: string | null; last_error?: string | null }; counts: Record<string, number>; failures: Array<{ id: string; resource_type?: string; source_id?: string; error_message?: string }>; findings: Array<{ id: string; resource_type?: string; source_id?: string; detail?: string }> };

const PAGE_SIZE = 25;
const ADMIN_ROLE = "Bifrost Docs Administrator";
const EDITOR_ROLE = "Bifrost Docs Editor";
const PREFLIGHT_REF = "functions/migration.py::docs_migration_preflight";
const STATUS_REF = "functions/migration.py::docs_migration_status";
const START_REF = "functions/migration.py::docs_migration_start";
const RESUME_REF = "functions/migration.py::docs_migration_resume";
const RETRY_REF = "functions/migration.py::docs_migration_retry_failures";
const CANCEL_REF = "functions/migration.py::docs_migration_cancel";
const resourceLabels: Record<string, string> = { documents: "Documents", document_folders: "Document folders", configurations: "Configurations", configuration_types: "Configuration types", configuration_statuses: "Configuration statuses", locations: "Locations", passwords: "Password metadata", password_folders: "Password folders", flexible_asset_types: "Flexible asset types", flexible_assets: "Flexible assets" };
const attachmentParentTypes: Partial<Record<CatalogKind, NativeAttachmentParentType>> = { documents: "documents", configurations: "configurations", locations: "locations", "flexible-assets": "flexible_assets" };

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function isDenied(error: unknown) { return error instanceof TableAccessDeniedError || error instanceof FileAccessDeniedError || error instanceof FilePolicyError || /access denied|permission|\b403\b/i.test(errorText(error)); }
function asText(value: unknown, fallback = "—") { return typeof value === "string" && value.trim() ? value : fallback; }
function timeLabel(value: unknown) { if (typeof value !== "string" || !value) return "—"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date); }
function sourceUrl(row: Row) { return typeof row.source_url === "string" && /^https?:\/\//.test(row.source_url) ? row.source_url : null; }
function flatten(document: TableDocument | null): Row | null { return document ? { ...(document.data ?? {}), id: document.id, created_at: document.created_at, updated_at: document.updated_at } : null; }
function statusTone(status?: string): "neutral" | "success" | "warning" | "danger" | "info" { if (status === "completed") return "success"; if (["failed", "interrupted", "completed_with_errors"].includes(status ?? "")) return "danger"; if (["awaiting_mapping", "cancelling", "cancelled"].includes(status ?? "")) return "warning"; return ["running", "queued"].includes(status ?? "") ? "info" : "neutral"; }
function formatBytes(value: unknown) { if (typeof value !== "number" || value < 0) return "Size unavailable"; if (value < 1024) return `${value} B`; return value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`; }

function useCreationOrganization() {
  return useDocsOrganizations();
}
function CreationOrganizationField({ target }: { target: ReturnType<typeof useCreationOrganization> }) {
  if (target.mode.kind === "fixed") return <BfAlert tone="info" title="Bifrost organization">This record will be created in your current Bifrost organization.</BfAlert>;
  const options: BfComboboxOption[] = target.organizations.map((organization) => ({ value: organization.id, label: organization.name }));
  return <BfCombobox label="Bifrost organization" hint="Choose the Bifrost organization that should own this record." error={target.error || undefined} loading={target.loading} disabled={target.loading || Boolean(target.error)} options={options} value={target.organizationId} onValueChange={target.setOrganizationId} placeholder="Choose a Bifrost organization" emptyText="No Bifrost organizations are available to your account." />;
}

function useCatalogPage(entry: CatalogEntry, search: string, page: number, organizationId: string, sort: BfDataTableSort, refreshKey = 0, folderId: string | null = null, assetTypeId: string | null = null, configurationType: string | null = null, configurationStatus: string | null = null, showDisabled = false) {
  const [state, setState] = useState<{ rows: Row[]; total: number; loading: boolean; error: Error | null }>({ rows: [], total: 0, loading: true, error: null });
  const [tableId, setTableId] = useState<string | null>(null);
  const [tableScope, setTableScope] = useState("");
  const [realtimeRefresh, setRealtimeRefresh] = useState(0);
  const scope = `${entry.table}:${organizationId}`;
  const where = useMemo(() => {
    const base = catalogSearchWhere(entry, search) as Record<string, unknown> | undefined;
    const extra: Record<string, unknown> = catalogEnabledWhere(entry.kind, showDisabled);
    if (organizationId) extra.organization_id = organizationId;
    if (folderId) extra.folder_id = folderId;
    if (assetTypeId) extra.flexible_asset_type_id = assetTypeId;
    if (configurationType) extra.configuration_type_name = configurationType;
    if (configurationStatus) extra.configuration_status_name = configurationStatus;
    if (Object.keys(extra).length) return { ...(base ?? {}), ...extra };
    return base;
  }, [entry, search, organizationId, folderId, assetTypeId, configurationType, configurationStatus, showDisabled]);
  useEffect(() => {
    setTableId(null); setTableScope(""); setState({ rows: [], total: 0, loading: true, error: null });
  }, [scope]);
  useEffect(() => {
    let active = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    const orderBy = sort.columnId === "name" ? "name" : "source_updated_at";
    tables.query(entry.table, { where, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, order_by: orderBy, order_dir: sort.direction === "ascending" ? "asc" : "desc" })
      .then((result) => { if (!active) return; setTableId(typeof result.table_id === "string" ? result.table_id : null); setTableScope(scope); const documents = Array.isArray(result.documents) ? result.documents : []; setState({ rows: documents.map((document: TableDocument) => flatten(document)).filter((row): row is Row => row !== null), total: Number(result.total) || 0, loading: false, error: null }); })
      .catch((error: unknown) => { if (active) { setTableId(null); setTableScope(""); setState({ rows: [], total: 0, loading: false, error: error instanceof Error ? error : new Error(String(error)) }); } });
    return () => { active = false; };
  }, [entry.table, page, refreshKey, realtimeRefresh, sort, where, scope]);
  useTableInvalidation(tableScope === scope ? tableId : null, organizationId || null, () => setRealtimeRefresh((value) => value + 1), () => { setTableId(null); setTableScope(""); setState({ rows: [], total: 0, loading: false, error: null }); });
  return state;
}

function useNamedRecordOptions(table: string, organizationId: string, allowVisibleGlobal = false) {
  const enabled = Boolean(organizationId) || allowVisibleGlobal;
  const [state, setState] = useState<{ options: BfComboboxOption[]; loading: boolean; error: string }>({ options: [], loading: enabled, error: "" });
  const [tableId, setTableId] = useState<string | null>(null);
  const [tableScope, setTableScope] = useState("");
  const [refresh, setRefresh] = useState(0);
  const scope = `${table}:${organizationId}:${allowVisibleGlobal}`;
  useEffect(() => {
    setTableId(null); setTableScope("");
    setState({ options: [], loading: enabled, error: "" });
  }, [scope, enabled]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setState((current) => ({ ...current, loading: true, error: "" }));
    queryAllPages(tables.query, table, { where: organizationId ? { organization_id: organizationId } : {}, order_by: "name", order_dir: "asc" }, { isCurrent: () => active, onTableResolved: (id) => { if (active) { setTableId(id); setTableScope(scope); } } }).then((documents) => {
      if (!active) return;
      const options = (documents ?? []).flatMap((document: TableDocument): BfComboboxOption[] => {
        const name = typeof document.data?.name === "string" ? document.data.name.trim() : "";
        return name ? [{ value: document.id, label: name }] : [];
      });
      setState({ options, loading: false, error: "" });
    }).catch((error: unknown) => { if (active) { setTableId(null); setTableScope(""); setState({ options: [], loading: false, error: errorText(error) }); } });
    return () => { active = false; };
  }, [table, organizationId, refresh, scope, enabled]);
  useTableInvalidation(tableScope === scope ? tableId : null, organizationId || null, () => setRefresh((value) => value + 1), () => { setTableId(null); setTableScope(""); setState({ options: [], loading: false, error: "" }); });
  return state;
}

function useDocumentFolderOptions(organizationId: string, allowVisibleGlobal = false) {
  return useNamedRecordOptions("docs-document-folders", organizationId, allowVisibleGlobal);
}

function DocumentFolderField({ organizationId, value, onValueChange, label = "Document folder" }: { organizationId: string; value: string; onValueChange: (value: string) => void; label?: string }) {
  const folders = useDocumentFolderOptions(organizationId);
  return <BfCombobox label={label} hint={folders.error ? `Folders could not load: ${folders.error}` : "Leave blank for no folder."} options={folders.options} value={value} onValueChange={onValueChange} loading={folders.loading} disabled={Boolean(folders.error) || !organizationId} clearable placeholder="No folder" emptyText="No document folders are available in this organization." />;
}

function useRecord(table: string, id: string | undefined, refreshKey = 0, realtimeEnabled = true, organizationId?: string) {
  const [state, setState] = useState<{ row: Row | null; loading: boolean; error: Error | null }>({ row: null, loading: true, error: null });
  const [tableId, setTableId] = useState<string | null>(null);
  const [tableScope, setTableScope] = useState("");
  const [realtimeRefresh, setRealtimeRefresh] = useState(0);
  const scope = `${table}:${id ?? ""}:${organizationId ?? ""}`;
  useEffect(() => { setTableId(null); setTableScope(""); setState({ row: null, loading: Boolean(id), error: id ? null : new Error("A record ID is required.") }); }, [scope, id]);
  useEffect(() => {
    let active = true;
    if (!id) return () => { active = false; };
    setState((current) => ({ ...current, loading: true, error: null }));
    tables.get(table, id, organizationId || undefined).then((result: (TableDocument & { table_id?: string }) | null) => { if (active) { setTableId(typeof result?.table_id === "string" ? result.table_id : null); setTableScope(scope); setState({ row: flatten(result), loading: false, error: null }); } }).catch((error: unknown) => { if (active) { setTableId(null); setTableScope(""); setState({ row: null, loading: false, error: error instanceof Error ? error : new Error(String(error)) }); } });
    return () => { active = false; };
  }, [id, organizationId, refreshKey, realtimeRefresh, table, scope]);
  const rowOrganizationId = typeof state.row?.organization_id === "string" ? state.row.organization_id : null;
  useTableInvalidation(realtimeEnabled && tableScope === scope ? tableId : null, organizationId || rowOrganizationId, () => setRealtimeRefresh((value) => value + 1), () => { setTableId(null); setTableScope(""); setState({ row: null, loading: false, error: null }); });
  return state;
}

function useRelatedRows(table: string, where: Record<string, unknown>, refreshKey = 0, organizationId?: string) {
  const [state, setState] = useState<{ rows: Row[]; loading: boolean; error: Error | null }>({ rows: [], loading: true, error: null });
  const [tableId, setTableId] = useState<string | null>(null);
  const [tableScope, setTableScope] = useState("");
  const [realtimeRefresh, setRealtimeRefresh] = useState(0);
  const scopedWhere = organizationId ? { ...where, organization_id: organizationId } : where;
  const key = JSON.stringify(scopedWhere);
  const scope = `${table}:${key}`;
  useEffect(() => { setTableId(null); setTableScope(""); setState({ rows: [], loading: true, error: null }); }, [scope]);
  useEffect(() => {
    let active = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    queryAllPages(tables.query, table, { where: scopedWhere, order_by: "updated_at", order_dir: "desc" }, {
      pageSize: 100,
      isCurrent: () => active,
      onTableResolved: id => { if (active) { setTableId(id); setTableScope(scope); } },
    }).then(documents => {
      if (!active || documents === null) return;
      setState({ rows: documents.map(document => flatten(document)).filter((row): row is Row => row !== null), loading: false, error: null });
    }).catch((error: unknown) => {
      if (active) { setTableId(null); setTableScope(""); setState({ rows: [], loading: false, error: error instanceof Error ? error : new Error(String(error)) }); }
    });
    return () => { active = false; };
  }, [key, refreshKey, realtimeRefresh, table, scope]);
  const rowOrganizationId = typeof where.organization_id === "string" ? where.organization_id : null;
  useTableInvalidation(tableScope === scope ? tableId : null, organizationId || rowOrganizationId, () => setRealtimeRefresh((value) => value + 1), () => { setTableId(null); setTableScope(""); setState({ rows: [], loading: false, error: null }); });
  return state;
}

function kindIcon(kind: CatalogKind) { return kind === "documents" ? FileText : kind === "passwords" ? KeyRound : kind === "configurations" ? Server : kind === "locations" ? MapPin : kind === "flexible-assets" || kind === "flexible-asset-types" ? Layers3 : FolderOpen; }

type EditValues = { name: string; content: string; folderId: string; hostname: string; serial: string; assetTag: string; manufacturer: string; model: string; ipAddress: string; macAddress: string; notes: string; type: string; status: string; address1: string; address2: string; city: string; region: string; postal: string; country: string; phone: string; traits: string; parentId: string; icon: string; fields: string };
function initialValues(row: Row): EditValues {
  return { name: asText(row.name, ""), content: asText(row.content, asText(row.rendered_content, "")), folderId: asText(row.folder_id, ""), hostname: asText(row.hostname, ""), serial: asText(row.serial_number, ""), assetTag: asText(row.asset_tag, ""), manufacturer: asText(row.manufacturer_name ?? row.manufacturer, ""), model: asText(row.model_name ?? row.model, ""), ipAddress: asText(row.ip_address ?? row.primary_ip, ""), macAddress: asText(row.mac_address, ""), notes: asText(row.notes, ""), type: asText(row.configuration_type_name ?? row.flexible_asset_type_id, ""), status: asText(row.configuration_status_name, ""), address1: asText(row.address_1, ""), address2: asText(row.address_2, ""), city: asText(row.city, ""), region: asText(row.region, ""), postal: asText(row.postal_code, ""), country: asText(row.country, ""), phone: asText(row.phone, ""), traits: row.traits && typeof row.traits === "object" ? JSON.stringify(row.traits, null, 2) : "", parentId: asText(row.parent_id, ""), icon: asText(row.icon, ""), fields: row.fields && typeof row.fields === "object" ? JSON.stringify(row.fields, null, 2) : "" };
}
function editablePayload(entry: CatalogEntry, values: EditValues) {
  if (entry.kind === "documents") return documentUpdatePayload({ title: values.name, content: values.content, folderId: values.folderId });
  if (entry.kind === "configurations") return { name: values.name.trim(), hostname: values.hostname.trim(), serial_number: values.serial.trim(), asset_tag: values.assetTag.trim(), manufacturer_name: values.manufacturer.trim(), model_name: values.model.trim(), ip_address: values.ipAddress.trim(), mac_address: values.macAddress.trim(), notes: values.notes.trim(), configuration_type_name: values.type.trim(), configuration_status_name: values.status.trim() };
  if (entry.kind === "locations") return { name: values.name.trim(), notes: values.notes.trim(), address_1: values.address1.trim(), address_2: values.address2.trim(), city: values.city.trim(), region: values.region.trim(), postal_code: values.postal.trim(), country: values.country.trim(), phone: values.phone.trim() };
  if (entry.kind === "flexible-asset-types") return { name: values.name.trim(), icon: values.icon.trim(), fields: values.fields.trim() ? JSON.parse(values.fields) : [] };
  if (entry.kind === "flexible-assets") return { name: values.name.trim(), flexible_asset_type_id: values.type.trim(), traits: values.traits.trim() ? JSON.parse(values.traits) : {} };
  return { name: values.name.trim(), parent_id: values.parentId.trim() || null };
}
function FlexibleAssetEditor({ values, organizationId, onChange, onValidationChange }: { values: EditValues; organizationId: string; onChange: (changes: Partial<EditValues>) => void; onValidationChange?: (errors: Record<string, string>) => void }) {
  const types = useNamedRecordOptions("docs-flexible-asset-types", organizationId);
  const validType = types.options.some((option) => option.value === values.type);
  const [definitions, setDefinitions] = useState<unknown>([]);
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!values.type.trim() || types.loading || !validType) { setDefinitions([]); setLoading(false); return; }
    let active = true;
    setLoading(true);
    tables.get("docs-flexible-asset-types", values.type.trim()).then((document) => {
      if (active) setDefinitions(document?.data?.fields ?? []);
    }).catch(() => { if (active) setDefinitions([]); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [values.type, types.loading, validType]);
  const fields = useMemo(() => safeAssetFields(definitions), [definitions]);
  const traits = useMemo(() => {
    try { return values.traits.trim() ? JSON.parse(values.traits) as Record<string, unknown> : {}; } catch { return {}; }
  }, [values.traits]);
  const defaults = useMemo(() => assetFieldDefaults(definitions, traits), [definitions, traits]);
  useEffect(() => {
    const errors = validateAssetTraits(fields, defaults);
    if (types.loading || loading) errors.asset_type = "Wait for the asset type and field definitions to load.";
    else if (types.error || (values.type && !validType)) errors.asset_type = "Choose an available asset type in this organization.";
    onValidationChange?.(errors);
  }, [fields, defaults, onValidationChange, types.loading, types.error, loading, values.type, validType]);
  const setTrait = (key: string, value: unknown) => {
    const next = { ...defaults, [key]: value };
    setFieldErrors(validateAssetTraits(fields, next));
    onChange({ traits: JSON.stringify(safeAssetTraits(fields, next, definitions)) });
  };
  return <>
    <BfCombobox label="Asset type" options={types.options} value={values.type} onValueChange={(type) => onChange({ type, traits: "" })} loading={types.loading} disabled={!organizationId || Boolean(types.error)} error={types.error || (values.type && !types.loading && !validType ? "Choose an available asset type in this organization." : undefined)} placeholder="Choose an asset type" emptyText="No asset types are available in this organization." />
    {loading ? <p className="muted">Loading asset field definitions…</p> : fields.length ? <AssetFields fields={fields} values={defaults} errors={fieldErrors} onChange={setTrait} /> : values.type.trim() ? <BfAlert tone="warning" title="No editable field definitions">This asset type has no supported non-secret fields.</BfAlert> : null}
  </>;
}
function EditorFields({ entry, values, organizationId, documentId, restricted, onChange, onAssetValidationChange }: { entry: CatalogEntry; values: EditValues; organizationId: string; documentId?: string; restricted?: boolean; onChange: (changes: Partial<EditValues>) => void; onAssetValidationChange?: (errors: Record<string, string>) => void }) {
  const uploadImage = useImageUploader(organizationId, entry.kind === "documents" ? documentId : undefined, Boolean(restricted));
  const input = (label: string, key: keyof EditValues, hint?: string) => <BfTextField label={label} hint={hint} value={values[key]} onChange={(event) => onChange({ [key]: event.target.value })} />;
  if (entry.kind === "documents") return <>{input("Title", "name")}<DocumentFolderField organizationId={organizationId} value={values.folderId} onValueChange={(folderId) => onChange({ folderId })} /><RichEditor label="Content" organizationId={organizationId} value={values.content} onChange={(content) => onChange({ content })} onImageUpload={documentId ? uploadImage : undefined} /></>;
  if (entry.kind === "configurations") return <div className="editor-grid">{input("Name", "name")}{input("Hostname", "hostname")}{input("Serial number", "serial")}{input("Asset tag", "assetTag")}{input("Manufacturer", "manufacturer")}{input("Model", "model")}{input("IP address", "ipAddress")}{input("MAC address", "macAddress")}<ConfigurationTaxonomySelect kind="type" organizationId={organizationId} value={values.type} onValueChange={(type) => onChange({ type })} /><ConfigurationTaxonomySelect kind="status" organizationId={organizationId} value={values.status} onValueChange={(status) => onChange({ status })} /><BfTextarea label="Notes" value={values.notes} onChange={(event) => onChange({ notes: event.target.value })} /></div>;
  if (entry.kind === "locations") return <div className="editor-grid">{input("Name", "name")}{input("Address line 1", "address1")}{input("Address line 2", "address2")}{input("City", "city")}{input("Region", "region")}{input("Postal code", "postal")}{input("Country", "country")}{input("Phone", "phone")}<BfTextarea label="Notes" value={values.notes} onChange={(event) => onChange({ notes: event.target.value })} /></div>;
  if (entry.kind === "flexible-assets") return <>{input("Name", "name")}<FlexibleAssetEditor values={values} organizationId={organizationId} onChange={onChange} onValidationChange={onAssetValidationChange} /></>;
  if (entry.kind === "flexible-asset-types") return <>{input("Name", "name")}{input("Icon", "icon")}<BfTextarea label="Field definitions (JSON)" value={values.fields} onChange={(event) => onChange({ fields: event.target.value })} /></>;
  return <>{input("Name", "name")}{input("Parent folder ID", "parentId", "Leave blank for a top-level folder.")}</>;
}
function RecordEditor({ entry, row, onClose, onSaved }: { entry: CatalogEntry; row: Row; onClose: () => void; onSaved: () => void }) {
  const [values, setValues] = useState(() => initialValues(row)); const [error, setError] = useState(""); const [assetErrors, setAssetErrors] = useState<Record<string, string>>({}); const [saving, setSaving] = useState(false);
  const updateDraft = useWorkflowMutation("functions/authoring.py::docs_update_draft");
  const updateDocument = useWorkflowMutation(documentMutationRefs.update);
  const warning = sourceSyncWarning(row.source_system);
  async function save() {
    if (!values.name.trim()) { setError("A name is required."); return; }
    if (entry.kind === "flexible-assets" && !values.type.trim()) { setError("A flexible asset type is required."); return; }
    if (entry.kind === "flexible-assets" && Object.keys(assetErrors).length) { setError("Complete the required asset fields before saving."); return; }
    setSaving(true); setError("");
    try { if (entry.kind === "documents" && String(row.source_system) === "bifrost" && String(row.status) === "draft") await updateDraft.mutate({ document_id: row.id, title: values.name, content: values.content, folder_id: values.folderId.trim() || null }); else if (entry.kind === "documents") await updateDocument.mutate({ document_id: row.id, title: values.name, content: values.content, folder_id: values.folderId.trim() || null }); else await tables.update(entry.table, row.id, editablePayload(entry, values)); onSaved(); onClose(); } catch (saveError) { setError(isDenied(saveError) ? "Your Bifrost role cannot edit this record." : errorText(saveError)); } finally { setSaving(false); }
  }
  return <BfDialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }} title={`Edit ${entry.singular}`} description="Changes are saved in Bifrost immediately." footer={<><BfButton variant="secondary" disabled={saving} onClick={onClose}>Cancel</BfButton><BfButton disabled={saving} icon={saving ? <Loader2 className="spin" size={15} /> : <CheckCircle2 size={15} />} onClick={save}>{saving ? "Saving" : "Save changes"}</BfButton></>}><div className="editor-form">{warning && <BfAlert tone="warning" title="Source-mapped record">{warning}</BfAlert>}<EditorFields entry={entry} values={values} organizationId={asText(row.organization_id, "")} documentId={row.id} restricted={Boolean(row.restricted)} onChange={(changes) => setValues((current) => ({ ...current, ...changes }))} onAssetValidationChange={setAssetErrors} />{error && <BfAlert tone="danger" title="Could not save">{error}</BfAlert>}</div></BfDialog>;
}
function CreateRecordDialog({ entry, initialAssetTypeId = "", onClose, onCreated }: { entry: CatalogEntry; initialAssetTypeId?: string; onClose: () => void; onCreated: (id: string) => void }) {
  const target = useCreationOrganization(); const [values, setValues] = useState<EditValues>(() => ({ ...initialValues({ id: "" }), type: initialAssetTypeId })); const [error, setError] = useState(""); const [assetErrors, setAssetErrors] = useState<Record<string, string>>({}); const [saving, setSaving] = useState(false);
  async function create() {
    if (!values.name.trim()) { setError("A name is required."); return; }
    if (entry.kind === "flexible-assets" && !values.type.trim()) { setError("A flexible asset type is required."); return; }
    if (entry.kind === "flexible-assets" && Object.keys(assetErrors).length) { setError("Complete the required asset fields before creating the record."); return; }
    if (!target.organizationId) { setError("Choose a Bifrost organization for this record."); return; }
    setSaving(true); setError("");
    try {
      const record = await tables.insert(entry.table, { organization_id: target.organizationId, source_system: "bifrost", source_id: crypto.randomUUID(), source_updated_at: new Date().toISOString(), archived: false, restricted: false, ...editablePayload(entry, values) });
      onCreated(record.id);
    } catch (createError) { setError(isDenied(createError) ? "Your Bifrost role cannot create this record type." : errorText(createError)); } finally { setSaving(false); }
  }
  return <BfDialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }} title={`Create ${entry.singular}`} description="Add a record to this organization." footer={<><BfButton variant="secondary" disabled={saving} onClick={onClose}>Cancel</BfButton><BfButton disabled={saving || !target.organizationId} icon={saving ? <Loader2 className="spin" size={15} /> : <Plus size={15} />} onClick={create}>{saving ? "Creating" : "Create record"}</BfButton></>}><div className="editor-form"><CreationOrganizationField target={target} /><EditorFields entry={entry} values={values} organizationId={target.organizationId} onChange={(changes) => setValues((current) => ({ ...current, ...changes }))} onAssetValidationChange={setAssetErrors} />{error && <BfAlert tone="danger" title="Could not create">{error}</BfAlert>}</div></BfDialog>;
}
function NewDocument() {
  const target = useCreationOrganization();
  const { orgId } = useParams<{ orgId: string }>();
  const navigate = useNavigate();
  const create = useWorkflowMutation<{ document_id: string }>("functions/authoring.py::docs_create_draft");
  const updateDraft = useWorkflowMutation("functions/authoring.py::docs_update_draft");
  const ensureGrant = useWorkflowMutation(attachmentWorkflowRefs.ensureGrant);
  const registerAttachment = useWorkflowMutation(attachmentWorkflowRefs.register);
  const deleteAttachment = useWorkflowMutation(attachmentWorkflowRefs.delete);
  const pendingImages = useRef(new Map<string, File>());
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [folderId, setFolderId] = useState("");
  const [error, setError] = useState("");

  async function stageImage(file: File) {
    const reference = pendingAttachmentRef(crypto.randomUUID());
    pendingImages.current.set(reference, file);
    return reference;
  }
  async function uploadStagedImage(documentId: string, pendingReference: string, file: File) {
    const attachmentId = pendingReference.slice("bifrost-pending:".length);
    const fileName = safeAttachmentFileName(file.name);
    const location = attachmentLocation(false);
    const path = nativeAttachmentPath(target.organizationId, documentId, attachmentId, fileName);
    let uploaded = false;
    try {
      await ensureGrant.mutate({ organization_id: target.organizationId });
      await files.upload(path, file, { location, scope: target.organizationId, contentType: file.type || "application/octet-stream" });
      uploaded = true;
      await registerAttachment.mutate({ parent_document_id: documentId, storage_path: path, file_name: fileName, content_type: file.type || "application/octet-stream", size_bytes: file.size });
    } catch (uploadError) {
      if (uploaded) await files.delete(path, { location, scope: target.organizationId }).catch(() => undefined);
      throw uploadError;
    }
    return { attachmentId, reference: `bifrost-attachment:${attachmentId}` };
  }
  async function saveDraft() {
    if (!title.trim() || !content.trim()) { setError("A title and content are required."); return; }
    if (!target.organizationId) { setError("Choose a Bifrost organization for this draft."); return; }
    setError("");
    let documentId = "";
    const uploadedAttachmentIds: string[] = [];
    try {
      const result = await create.mutate({ organization_id: target.organizationId, title, content: draftContentWithoutPendingImages(content), folder_id: folderId.trim() || null });
      documentId = result.document_id;
      const resolvedReferences = new Map<string, string>();
      for (const [pendingReference, file] of pendingImages.current) {
        const upload = await uploadStagedImage(documentId, pendingReference, file);
        uploadedAttachmentIds.push(upload.attachmentId);
        resolvedReferences.set(pendingReference, upload.reference);
      }
      if (resolvedReferences.size) await updateDraft.mutate({ document_id: documentId, title, content: resolvePendingImageRefs(content, resolvedReferences) });
      pendingImages.current.clear();
      navigate(recordPath("documents", documentId, orgId ?? target.organizationId), { replace: true });
    } catch (createError) {
      await Promise.all(uploadedAttachmentIds.map((attachmentId) => deleteAttachment.mutate({ attachment_id: attachmentId }).catch(() => undefined)));
      setError(documentId ? "The draft was created without its staged images. Open it to continue editing, then try those images again." : errorText(createError));
    }
  }
  const creating = create.loading || updateDraft.loading || ensureGrant.loading || registerAttachment.loading;
  return <div className="docs-page detail-page"><BfButton variant="ghost" className="back-button" icon={<ArrowLeft size={16} />} onClick={() => navigate(catalogPath("documents", orgId ?? target.organizationId))}>Back to documents</BfButton><section className="record-heading"><div><p className="section-kicker">Bifrost-authored document</p><h1>New draft</h1><p className="muted">Drafts stay within their selected Bifrost organization until an authorized publisher publishes them.</p></div></section><section className="record-content"><div className="editor-form"><CreationOrganizationField target={target} /><DocumentFolderField organizationId={target.organizationId} value={folderId} onValueChange={setFolderId} /><BfTextField label="Title" value={title} onChange={(event) => setTitle(event.target.value)} /><RichEditor label="Content" value={content} onChange={setContent} onImageUpload={stageImage} organizationId={target.organizationId} />{error && <BfAlert tone="danger" title="Could not create draft">{error}</BfAlert>}<BfButton disabled={creating || !target.organizationId} icon={creating ? <Loader2 className="spin" size={15} /> : <Plus size={15} />} onClick={saveDraft}>{creating ? "Creating draft" : "Create draft"}</BfButton></div></section></div>;
}

type BulkArchiveResult = {
  archived_document_ids?: string[];
  already_archived_document_ids?: string[];
  skipped_source_owned_document_ids?: string[];
  pending_index_cleanup_document_ids?: string[];
};

function catalogPath(kind: CatalogKind, organizationId = "") {
  const base = organizationId ? `/org/${encodeURIComponent(organizationId)}/browse` : "/browse";
  return `${base}?type=${encodeURIComponent(kind)}`;
}
function recordPath(kind: CatalogKind, id: string, organizationId = "", assetTypeId = "") {
  if (organizationId && kind === "flexible-assets" && assetTypeId) return `/org/${encodeURIComponent(organizationId)}/assets/${encodeURIComponent(assetTypeId)}/${encodeURIComponent(id)}`;
  const base = organizationId ? `/org/${encodeURIComponent(organizationId)}` : "";
  return `${base}/${kind}/${encodeURIComponent(id)}`;
}
function useTaxonomyFilterOptions(organizationId: string, table: string) {
  const [options, setOptions] = useState<Array<{ label: string; value: string }>>([]);
  const [tableId, setTableId] = useState<string | null>(null);
  const [tableScope, setTableScope] = useState("");
  const [refresh, setRefresh] = useState(0);
  const scope = `${table}:${organizationId}`;
  useEffect(() => {
    setTableId(null); setTableScope(""); setOptions([]);
  }, [scope]);
  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    queryAllPages(tables.query, table, { where: { organization_id: organizationId }, order_by: "name", order_dir: "asc" }, { isCurrent: () => active, onTableResolved: (id) => { if (active) { setTableId(id); setTableScope(scope); } } }).then((documents) => {
      if (!active) return;
      setOptions((documents ?? []).flatMap((document: TableDocument) => {
        const name = typeof document.data?.name === "string" ? document.data.name.trim() : "";
        return name && document.data?.active !== false ? [{ label: name, value: name }] : [];
      }));
    }).catch(() => { if (active) { setTableId(null); setTableScope(""); setOptions([]); } });
    return () => { active = false; };
  }, [organizationId, table, refresh, scope]);
  useTableInvalidation(tableScope === scope ? tableId : null, organizationId || null, () => setRefresh((value) => value + 1), () => { setTableId(null); setTableScope(""); setOptions([]); });
  return options;
}
function BrowseCatalog({ canWrite, isAdmin, forcedKind, forcedAssetTypeId }: { canWrite: boolean; isAdmin: boolean; forcedKind?: CatalogKind; forcedAssetTypeId?: string }) {
  const [params, setParams] = useSearchParams();
  const { organizationId, viewerId } = useDocsOrganizations();
  const { orgId: routeOrganizationId, typeId: routeAssetTypeId } = useParams<{ orgId: string; typeId: string }>();
  const scopedOrganizationId = routeOrganizationId ?? organizationId;
  const isScopedRoute = Boolean(routeOrganizationId);
  const selected = forcedKind ?? (isCatalogKind(params.get("type")) ? params.get("type") : "documents");
  const kind = selected as CatalogKind;
  const entry = catalogEntry(kind);
  const search = params.get("q") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const folder = kind === "documents" ? params.get("folder") : null;
  const [catalogRefreshKey, setCatalogRefreshKey] = useState(0);
  const [catalogSort, setCatalogSort] = useState<BfDataTableSort>({ columnId: "updated", direction: "descending" });
  const assetType = kind === "flexible-assets" ? forcedAssetTypeId ?? routeAssetTypeId ?? params.get("assetType") : null;
  const configurationType = kind === "configurations" ? params.get("configurationType") : null;
  const configurationStatus = kind === "configurations" ? params.get("configurationStatus") : null;
  const supportsEnabledState = ["configurations", "locations", "flexible-assets"].includes(kind);
  const showDisabled = supportsEnabledState && ["1", "true"].includes(params.get("showDisabled") ?? "");
  const data = useCatalogPage(entry, search, page, scopedOrganizationId, catalogSort, catalogRefreshKey, folder, assetType, configurationType, configurationStatus, showDisabled);
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [bulkArchiveOpen, setBulkArchiveOpen] = useState(false);
  const [bulkArchiveError, setBulkArchiveError] = useState("");
  const [bulkArchiveNotice, setBulkArchiveNotice] = useState("");
  const [bulkArchiving, setBulkArchiving] = useState(false);
  const [bulkToggleOpen, setBulkToggleOpen] = useState(false);
  const [bulkToggleEnabled, setBulkToggleEnabled] = useState(true);
  const [bulkToggleError, setBulkToggleError] = useState("");
  const [bulkToggleNotice, setBulkToggleNotice] = useState("");
  const [bulkToggling, setBulkToggling] = useState(false);
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [bulkMoveFolderId, setBulkMoveFolderId] = useState("");
  const [bulkMoveError, setBulkMoveError] = useState("");
  const [bulkMoveNotice, setBulkMoveNotice] = useState("");
  const [bulkMoving, setBulkMoving] = useState(false);
  const bulkArchive = useWorkflowMutation<BulkArchiveResult>(documentMutationRefs.bulkArchive);
  const updateDocument = useWorkflowMutation(documentMutationRefs.update);
  const updateDraft = useWorkflowMutation("functions/authoring.py::docs_update_draft");

  const documentFolders = useDocumentFolderOptions(kind === "documents" ? scopedOrganizationId : "", kind === "documents" && !scopedOrganizationId);
  const documentFolderNames = useMemo(() => Object.fromEntries(documentFolders.options.map((folder) => [folder.value, folder.label])), [documentFolders.options]);
  const configurationTypeOptions = useTaxonomyFilterOptions(scopedOrganizationId, "docs-configuration-types");
  const configurationStatusOptions = useTaxonomyFilterOptions(scopedOrganizationId, "docs-configuration-statuses");
  const change = (next: Partial<{ type: CatalogKind; q: string; page: number; folder: string | null; assetType: string | null; configurationType: string | null; configurationStatus: string | null; showDisabled: boolean }>) => {
    const value = new URLSearchParams(params); const nextType = next.type ?? kind; const nextQuery = next.q ?? search; const nextPage = next.page ?? page;
    value.set("type", nextType); if (nextQuery.trim()) value.set("q", nextQuery); else value.delete("q"); if (nextPage > 1) value.set("page", String(nextPage)); else value.delete("page");
    if (next.type && next.type !== "documents") value.delete("folder");
    if (next.type && next.type !== "flexible-assets") value.delete("assetType");
    if (next.assetType !== undefined) { if (next.assetType) value.set("assetType", next.assetType); else value.delete("assetType"); }
    if (next.folder !== undefined) { if (next.folder) value.set("folder", next.folder); else value.delete("folder"); }
    if (next.configurationType !== undefined) { if (next.configurationType) value.set("configurationType", next.configurationType); else value.delete("configurationType"); }
    if (next.configurationStatus !== undefined) { if (next.configurationStatus) value.set("configurationStatus", next.configurationStatus); else value.delete("configurationStatus"); }
    if (next.type && next.type !== kind) value.delete("showDisabled");
    if (next.showDisabled !== undefined) { if (next.showDisabled) value.set("showDisabled", "1"); else value.delete("showDisabled"); }
    setParams(value, { replace: true });
  };
  const [assetTypeNames, setAssetTypeNames] = useState<Record<string, string>>({});
  const [assetFields, setAssetFields] = useState<ReturnType<typeof safeAssetFields>>([]);
  const [assetTypeNamesTableId, setAssetTypeNamesTableId] = useState<string | null>(null);
  const [assetFieldsTableId, setAssetFieldsTableId] = useState<string | null>(null);
  const [assetTypeNamesTableScope, setAssetTypeNamesTableScope] = useState("");
  const [assetFieldsTableScope, setAssetFieldsTableScope] = useState("");
  const [assetTypeNamesRefresh, setAssetTypeNamesRefresh] = useState(0);
  const [assetFieldsRefresh, setAssetFieldsRefresh] = useState(0);
  useEffect(() => {
    const scope = `asset-types:${scopedOrganizationId}`;
    if (kind !== "flexible-assets") { setAssetTypeNames({}); setAssetTypeNamesTableId(null); setAssetTypeNamesTableScope(""); return; }
    let active = true;
    if (assetTypeNamesTableScope && assetTypeNamesTableScope !== scope) { setAssetTypeNames({}); setAssetTypeNamesTableId(null); setAssetTypeNamesTableScope(""); }
    queryAllPages(tables.query, "docs-flexible-asset-types", { where: scopedOrganizationId ? { organization_id: scopedOrganizationId } : undefined, order_by: "name", order_dir: "asc" }, { isCurrent: () => active, onTableResolved: (id) => { if (active) { setAssetTypeNamesTableId(id); setAssetTypeNamesTableScope(scope); } } }).then((documents) => {
      if (!active) return;
      const map: Record<string, string> = {};
      for (const doc of documents ?? []) {
        if (typeof doc.data?.name === "string" && doc.data.name) map[doc.id] = doc.data.name;
      }
      setAssetTypeNames((current) => (JSON.stringify(current) === JSON.stringify(map) ? current : map));
    }).catch(() => { if (active) { setAssetTypeNames({}); setAssetTypeNamesTableId(null); setAssetTypeNamesTableScope(""); } });
    return () => { active = false; };
  }, [kind, scopedOrganizationId, assetTypeNamesRefresh]);
  useEffect(() => {
    const scope = `asset-fields:${scopedOrganizationId}:${assetType ?? ""}`;
    if (kind !== "flexible-assets" || !assetType) { setAssetFields([]); setAssetFieldsTableId(null); setAssetFieldsTableScope(""); return; }
    let active = true;
    if (assetFieldsTableScope && assetFieldsTableScope !== scope) { setAssetFields([]); setAssetFieldsTableId(null); setAssetFieldsTableScope(""); }
    tables.get("docs-flexible-asset-types", assetType, scopedOrganizationId || undefined).then((document) => {
      if (active) { setAssetFieldsTableId(typeof document?.table_id === "string" ? document.table_id : null); setAssetFieldsTableScope(scope); setAssetFields(safeAssetFields(document?.data?.fields)); }
    }).catch(() => { if (active) { setAssetFields([]); setAssetFieldsTableId(null); setAssetFieldsTableScope(""); } });
    return () => { active = false; };
  }, [assetType, kind, scopedOrganizationId, assetFieldsRefresh]);
  const assetTypeNamesScope = `asset-types:${scopedOrganizationId}`;
  const assetFieldsScope = `asset-fields:${scopedOrganizationId}:${assetType ?? ""}`;
  useTableInvalidation(kind === "flexible-assets" && assetTypeNamesTableScope === assetTypeNamesScope ? assetTypeNamesTableId : null, scopedOrganizationId || null, () => setAssetTypeNamesRefresh((value) => value + 1), () => { setAssetTypeNames({}); setAssetTypeNamesTableId(null); setAssetTypeNamesTableScope(""); });
  useTableInvalidation(kind === "flexible-assets" && assetType && assetFieldsTableScope === assetFieldsScope ? assetFieldsTableId : null, scopedOrganizationId || null, () => setAssetFieldsRefresh((value) => value + 1), () => { setAssetFields([]); setAssetFieldsTableId(null); setAssetFieldsTableScope(""); });
  const columns: BfDataColumn<Row>[] = useMemo(() => {
    const supportsEnabledState = ["configurations", "locations", "flexible-assets"].includes(kind);
    const shared: BfDataColumn<Row>[] = [{ id: "name", header: supportsEnabledState ? "Name" : entry.singular, accessor: (row) => supportsEnabledState && row.is_enabled === false ? <span className="inline-flex items-center gap-2 opacity-60"><span className="line-through">{asText(row.name)}</span><BfChip tone="warning">Disabled</BfChip></span> : asText(row.name), sortable: true, sortValue: (row) => asText(row.name, "") }];
    if (kind === "documents") shared.push({ id: "folder", header: "Folder", accessor: (row) => {
      if (!row.folder_id) return "Unfiled";
      const folderName = documentFolderNames[String(row.folder_id)];
      if (folderName) return folderName;
      return documentFolders.loading ? "Loading folder…" : "Folder unavailable";
    }, width: "20%" });
    if (kind === "passwords") shared.push({ id: "username", header: "Username", accessor: (row) => asText(row.username), width: "22%" }, { id: "category", header: "Category", accessor: (row) => asText(row.category_name), width: "18%" });
    if (kind === "configurations") shared.push({ id: "type", header: "Type", accessor: (row) => asText(row.configuration_type_name), width: "15%" }, { id: "status", header: "Status", accessor: (row) => asText(row.configuration_status_name), width: "14%" }, { id: "manufacturer", header: "Manufacturer", accessor: (row) => asText(row.manufacturer_name ?? row.manufacturer), width: "15%" }, { id: "ip", header: "IP Address", accessor: (row) => asText(row.ip_address ?? row.primary_ip), width: "15%" });
    if (kind === "locations") shared.push({ id: "address", header: "Address", accessor: (row) => [asText(row.address_1, ""), asText(row.city, ""), asText(row.region, ""), asText(row.postal_code, "")].filter(Boolean).join(", ") || "—", width: "25%" }, { id: "notes", header: "Notes", accessor: (row) => asText(row.notes).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 100), width: "20%" });
    if (kind === "flexible-assets") {
      shared.push({ id: "type", header: "Asset type", accessor: (row) => assetTypeNames[String(row.flexible_asset_type_id ?? "")] ?? asText(row.flexible_asset_type_id), width: "20%" });
      for (const field of assetFields.filter((field) => field.showInList)) {
        shared.push({ id: `trait-${field.key}`, header: field.name, accessor: (row) => displayAssetValue(field, typeof row.traits === "object" && row.traits !== null ? (row.traits as Record<string, unknown>)[field.key] : undefined), width: "18%" });
      }
    }
    if (entry.folder) shared.push({ id: "parent", header: "Parent folder", accessor: (row) => <FolderReference key={`${viewerId}:${entry.kind}:${row.parent_id}:${row.organization_id}`} kind={entry.kind === "password-folders" ? "password-folders" : "document-folders"} folderId={row.parent_id} organizationId={row.organization_id} emptyLabel="Top-level folder" />, width: "28%" });
    shared.push({ id: "updated", header: "Updated", accessor: (row) => timeLabel(row.source_updated_at ?? row.updated_at), sortable: true, sortValue: (row) => asText(row.source_updated_at ?? row.updated_at, ""), width: "18%" });
    return shared;
  }, [entry.folder, entry.singular, kind, assetTypeNames, assetFields, documentFolderNames, documentFolders.loading, viewerId]);
  const canBulkArchive = isAdmin && kind === "documents";
  const canBulkMove = canWrite && kind === "documents" && Boolean(scopedOrganizationId);
  const canBulkToggle = canWrite && ["configurations", "locations", "flexible-assets"].includes(kind);
  const canSelectRows = canBulkArchive || canBulkMove || canBulkToggle;
  const selectedRows = useMemo(() => data.rows.filter((row) => selectedDocumentIds.includes(row.id)), [data.rows, selectedDocumentIds]);
  const selectionSourceWarning = selectedRows.some((row) => String(row.source_system).toLowerCase() === "itglue");
  const selectedDocumentsAreNative = selectedRows.every((row) => String(row.source_system).toLowerCase() === "bifrost");
  useEffect(() => { setSelectedDocumentIds([]); setBulkArchiveOpen(false); setBulkArchiveError(""); setBulkMoveOpen(false); setBulkMoveError(""); setBulkToggleOpen(false); setBulkToggleError(""); }, [kind, page, search, scopedOrganizationId, folder, assetType, configurationType, configurationStatus, showDisabled]);
  async function archiveSelectedDocuments() {
    if (!selectedDocumentIds.length || bulkArchiving) return;
    if (!selectedDocumentsAreNative) { setBulkArchiveError("Only Bifrost-authored documents can be archived in bulk."); return; }
    setBulkArchiving(true); setBulkArchiveError("");
    try {
      const result = await bulkArchive.mutate({ document_ids: selectedDocumentIds });
      const archived = result.archived_document_ids?.length ?? 0;
      const skipped = result.skipped_source_owned_document_ids?.length ?? 0;
      const pending = result.pending_index_cleanup_document_ids?.length ?? 0;
      setBulkArchiveNotice(`${archived} document${archived === 1 ? "" : "s"} archived${skipped ? `; ${skipped} IT Glue source-owned document${skipped === 1 ? " was" : "s were"} left unchanged` : ""}${pending ? `; knowledge cleanup is pending for ${pending}` : ""}.`);
      setSelectedDocumentIds([]); setBulkArchiveOpen(false); setCatalogRefreshKey((value) => value + 1);
    } catch (archiveError) { setBulkArchiveError(isDenied(archiveError) ? "Your Bifrost role cannot archive this document selection." : errorText(archiveError)); }
    finally { setBulkArchiving(false); }
  }
  async function toggleSelectedRecords() {
    if (!selectedDocumentIds.length || bulkToggling) return;
    if (selectedDocumentIds.length > 100) { setBulkToggleError("Select at most 100 records at a time."); return; }
    setBulkToggling(true); setBulkToggleError("");
    const results = await Promise.allSettled(selectedDocumentIds.map((id) => tables.update(entry.table, id, { is_enabled: bulkToggleEnabled })));
    const succeeded = results.filter((result) => result.status === "fulfilled").length;
    const failed = results.length - succeeded;
    if (failed) setBulkToggleError(`${failed} record${failed === 1 ? " could" : "s could"} not be ${bulkToggleEnabled ? "enabled" : "disabled"}. ${succeeded ? `${succeeded} record${succeeded === 1 ? " was" : "s were"} updated.` : ""}`);
    if (succeeded) setBulkToggleNotice(`${succeeded} ${entry.singular.toLowerCase()}${succeeded === 1 ? " was" : "s were"} ${bulkToggleEnabled ? "enabled" : "disabled"}.${selectionSourceWarning ? " IT Glue may overwrite source-mapped fields when it next syncs." : ""}`);
    setSelectedDocumentIds([]); setBulkToggleOpen(false); setCatalogRefreshKey((value) => value + 1); setBulkToggling(false);
  }
  async function moveSelectedDocuments() {
    if (!selectedDocumentIds.length || bulkMoving) return;
    if (selectedDocumentIds.length > 100) { setBulkMoveError("Select at most 100 documents at a time."); return; }
    if (!bulkMoveFolderId) { setBulkMoveError("Choose a destination folder."); return; }
    setBulkMoving(true); setBulkMoveError("");
    const results = await Promise.allSettled(selectedRows.map((row) => {
      const values = { document_id: row.id, folder_id: bulkMoveFolderId };
      return String(row.source_system) === "bifrost" && String(row.status) === "draft" ? updateDraft.mutate(values) : updateDocument.mutate(values);
    }));
    const succeeded = results.filter((result) => result.status === "fulfilled").length;
    const failed = results.length - succeeded;
    if (failed) setBulkMoveError(`${failed} document${failed === 1 ? " could" : "s could"} not be moved.${succeeded ? ` ${succeeded} document${succeeded === 1 ? " was" : "s were"} moved.` : ""}`);
    if (succeeded) setBulkMoveNotice(`${succeeded} document${succeeded === 1 ? " was" : "s were"} moved to the selected folder.`);
    setSelectedDocumentIds([]); setBulkMoveOpen(false); setBulkMoveFolderId(""); setCatalogRefreshKey((value) => value + 1); setBulkMoving(false);
  }
  const tableMinWidth = kind === "configurations" ? "56rem" : kind === "locations" ? "48rem" : kind === "flexible-assets" ? "52rem" : kind === "documents" ? "46rem" : "40rem";
  return <DocumentWorkspace canWrite={canWrite} enabled={kind === "documents"} selectedFolderId={folder} onSelect={(folderId) => change({ folder: folderId, page: 1 })}><div className="docs-page">
    <section className="page-heading catalog-heading"><div><h1>{isScopedRoute ? entry.label : "Records"}</h1>{isScopedRoute && <p>{entry.description}</p>}</div><div className="page-heading__actions">{canWrite && kind !== "passwords" && <BfButton aria-label={`New ${entry.singular.toLowerCase()}`} icon={<Plus size={15} />} onClick={() => kind === "documents" ? navigate(scopedOrganizationId ? `/org/${encodeURIComponent(scopedOrganizationId)}/documents/new` : "/documents/new") : setCreateOpen(true)}><span className="catalog-create-label">New {entry.singular.toLowerCase()}</span><span className="catalog-create-short">New</span></BfButton>}</div></section>
    <CatalogToolbar label={`Search ${entry.label.toLowerCase()}`} value={search} onValueChange={value => change({ q: value, page: 1 })} placeholder={`Search by ${entry.searchLabel}`}>
      {!isScopedRoute && !forcedKind ? <BfSelect label="Record type" value={kind} options={catalogEntries.map(item => ({ value: item.kind, label: item.label }))} onChange={event => { if (isCatalogKind(event.target.value)) change({ type: event.target.value, page: 1, q: "" }); }} /> : null}
      {kind === "configurations" ? <><BfSelect label="Type" options={[{ label: "All types", value: "" }, ...configurationTypeOptions]} value={configurationType ?? ""} onChange={event => change({ configurationType: event.target.value || null, page: 1 })} /><BfSelect label="Status" options={[{ label: "All statuses", value: "" }, ...configurationStatusOptions]} value={configurationStatus ?? ""} onChange={event => change({ configurationStatus: event.target.value || null, page: 1 })} /></> : null}
      {supportsEnabledState && !(kind === "flexible-assets" && !assetType && !search.trim()) && <div className="catalog-visibility-filter"><BfSwitch label="Show disabled" checked={showDisabled} onChange={checked => change({ showDisabled: checked, page: 1 })} /></div>}
    </CatalogToolbar>

    <div className="min-w-0">{kind === "flexible-assets" && assetType && !forcedAssetTypeId ? <p className="muted"><BfButton variant="ghost" onClick={() => change({ assetType: null, page: 1 })}>← All asset types</BfButton></p> : null}{kind === "flexible-assets" && !assetType && !search.trim() ? <AssetTypeGrid onSelect={(typeId) => scopedOrganizationId ? change({ assetType: typeId, page: 1 }) : navigate(`/global/assets/${encodeURIComponent(typeId)}`)} /> : <BfDataTable rows={data.rows} columns={columns} getRowId={(row) => row.id} ariaLabel={entry.label} caption={`${data.total} ${data.total === 1 ? entry.singular.toLowerCase() : entry.label.toLowerCase()}`} loading={data.loading} error={data.error ? { title: isDenied(data.error) ? "Catalog access denied" : "Catalog could not load", description: isDenied(data.error) ? "Your Bifrost role cannot read this record type." : errorText(data.error), onRetry: () => change({ page }) } : undefined} emptyState={{ title: search.trim() ? "No matching records" : "No records yet", description: search.trim() ? "Try a different name." : "Records appear here as documentation is added." }} pagination={{ page, pageSize: PAGE_SIZE, total: data.total, onPageChange: (nextPage) => change({ page: nextPage }) }} sort={catalogSort} onSortChange={(nextSort) => { setCatalogSort(nextSort); change({ page: 1 }); }} minWidth={tableMinWidth} selection={canSelectRows ? "multiple" : "none"} selectedRowIds={selectedDocumentIds} onSelectionChange={canSelectRows ? setSelectedDocumentIds : undefined} isRowSelectable={kind === "documents" ? (row) => !row.archived : undefined} toolbar={canSelectRows && selectedDocumentIds.length > 0 ? <><span>{`${selectedDocumentIds.length} selected`}</span><div className="catalog-bulk-actions" role="group" aria-label="Selected record actions">{canBulkMove ? <BfButton variant="secondary" disabled={!selectedDocumentIds.length || bulkMoving} onClick={() => setBulkMoveOpen(true)}>{bulkMoving ? "Moving" : "Move selected"}</BfButton> : null}{canBulkArchive ? <BfButton variant="danger" disabled={!selectedDocumentIds.length || !selectedDocumentsAreNative || bulkArchiving} icon={bulkArchiving ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />} onClick={() => setBulkArchiveOpen(true)}>{bulkArchiving ? "Archiving" : "Archive selected"}</BfButton> : null}{canBulkToggle ? <><BfButton variant="secondary" disabled={!selectedDocumentIds.length || bulkToggling} onClick={() => { setBulkToggleEnabled(true); setBulkToggleOpen(true); }}>Enable selected</BfButton><BfButton variant="danger" disabled={!selectedDocumentIds.length || bulkToggling} onClick={() => { setBulkToggleEnabled(false); setBulkToggleOpen(true); }}>Disable selected</BfButton></> : null}</div></> : undefined} onRowActivate={(row) => navigate(recordPath(kind, row.id, scopedOrganizationId, assetType ?? ""))} />}</div>
    {bulkArchiveNotice && <BfAlert tone="success" title="Document archive complete">{bulkArchiveNotice}</BfAlert>}
    {bulkArchiveError && <BfAlert tone="danger" title="Document archive failed">{bulkArchiveError}</BfAlert>}
    {bulkMoveNotice && <BfAlert tone="success" title="Documents moved">{bulkMoveNotice}</BfAlert>}
    {bulkMoveError && <BfAlert tone="danger" title="Document move incomplete">{bulkMoveError}</BfAlert>}
    {bulkToggleNotice && <BfAlert tone="success" title="Bulk update complete">{bulkToggleNotice}</BfAlert>}
    {bulkToggleError && <BfAlert tone="danger" title="Bulk update incomplete">{bulkToggleError}</BfAlert>}
    {canWrite && createOpen && <CreateRecordDialog entry={entry} initialAssetTypeId={assetType ?? ""} onClose={() => setCreateOpen(false)} onCreated={(id) => navigate(recordPath(kind, id, scopedOrganizationId, assetType ?? ""))} />}
    {canBulkArchive && <BfDialog open={bulkArchiveOpen} onOpenChange={(open) => { if (!bulkArchiving) setBulkArchiveOpen(open); }} title="Archive selected documents?" description="Only Bifrost-authored documents are archived. IT Glue source-owned documents in this selection stay unchanged." footer={<><BfButton variant="secondary" disabled={bulkArchiving} onClick={() => setBulkArchiveOpen(false)}>Cancel</BfButton><BfButton variant="danger" disabled={bulkArchiving} onClick={archiveSelectedDocuments}>{`Archive ${selectedDocumentIds.length} document${selectedDocumentIds.length === 1 ? "" : "s"}`}</BfButton></>}><p className="muted">Archiving removes native documents from normal discovery but retains their Bifrost audit trail.</p></BfDialog>}
    {canBulkMove && <BfDialog open={bulkMoveOpen} onOpenChange={(open) => { if (!bulkMoving) setBulkMoveOpen(open); }} title="Move selected documents?" description="Move up to 100 documents to a folder in this organization. Drafts and published records retain their current publication state." footer={<><BfButton variant="secondary" disabled={bulkMoving} onClick={() => setBulkMoveOpen(false)}>Cancel</BfButton><BfButton disabled={bulkMoving || !bulkMoveFolderId} onClick={moveSelectedDocuments}>{`${bulkMoving ? "Moving" : "Move"} ${selectedDocumentIds.length} document${selectedDocumentIds.length === 1 ? "" : "s"}`}</BfButton></>}>{selectionSourceWarning && <BfAlert tone="warning" title="Source-mapped documents">Moving an IT Glue document changes its Bifrost folder until the next source update overwrites mapped fields.</BfAlert>}<DocumentFolderField organizationId={scopedOrganizationId} value={bulkMoveFolderId} onValueChange={setBulkMoveFolderId} label="Destination folder" />{bulkMoveError && <BfAlert tone="danger" title="Could not move documents">{bulkMoveError}</BfAlert>}</BfDialog>}
    {canBulkToggle && <BfDialog open={bulkToggleOpen} onOpenChange={(open) => { if (!bulkToggling) setBulkToggleOpen(open); }} title={`${bulkToggleEnabled ? "Enable" : "Disable"} selected ${entry.label.toLowerCase()}?`} description={`This updates the enabled state of the selected ${entry.label.toLowerCase()}.`} footer={<><BfButton variant="secondary" disabled={bulkToggling} onClick={() => setBulkToggleOpen(false)}>Cancel</BfButton><BfButton variant={bulkToggleEnabled ? "primary" : "danger"} disabled={bulkToggling} onClick={toggleSelectedRecords}>{`${bulkToggleEnabled ? "Enable" : "Disable"} ${selectedDocumentIds.length} ${entry.singular.toLowerCase()}${selectedDocumentIds.length === 1 ? "" : "s"}`}</BfButton></>}>{selectionSourceWarning ? <BfAlert tone="warning" title="Source-mapped records">IT Glue may overwrite these changes when the source next syncs.</BfAlert> : <p className="muted">This action changes only the enabled state; password metadata is excluded.</p>}</BfDialog>}
  </div></DocumentWorkspace>;
}

function MermaidDiagram({ source }: { source: string }) {
  const diagramId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setSvg(""); setError(false);
    Promise.all([import("mermaid"), import("dompurify")]).then(([mermaidModule, purifierModule]) => {
      const renderer = mermaidModule.default;
      const purifier = purifierModule.default;
      renderer.initialize({ startOnLoad: false, securityLevel: "strict" });
      return renderer.render(`bifrost-docs-${diagramId}`, source).then(({ svg: rendered }) => {
      if (!active) return;
      const sanitized = purifier.sanitize(rendered, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ["script", "foreignObject"],
        RETURN_TRUSTED_TYPE: false,
      });
      if (!sanitized.includes("<svg")) { setError(true); return; }
      setSvg(sanitized);
      });
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [diagramId, source]);
  if (error) return <pre className="document-code-fallback" aria-label="Mermaid source (diagram could not render)"><code>{`\`\`\`mermaid\n${source}\n\`\`\``}</code></pre>;
  if (!svg) return <div className="diagram-loading" role="status"><Loader2 className="spin" size={16} />Rendering diagram…</div>;
  return <div className="mermaid-diagram" role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
function DocumentBody({ content }: { content: string }) {
  return <div className="document-body">{splitDocumentContent(content).map((block, index) => block.kind === "mermaid" ? <MermaidDiagram key={`${index}-${block.value}`} source={block.value} /> : <span key={`${index}-${block.value}`} className="document-text">{block.value}</span>)}</div>;
}
function useImageUploader(organizationId: string, documentId: string | undefined, restricted: boolean) {
  const ensureGrant = useWorkflowMutation(attachmentWorkflowRefs.ensureGrant);
  const registerAttachment = useWorkflowMutation(attachmentWorkflowRefs.register);
  return async (file: File): Promise<string> => {
    if (!documentId) throw new Error("Save the document before inserting images.");
    if (!organizationId) throw new Error("This document has no Bifrost organization for image storage.");
    const attachmentId = crypto.randomUUID();
    const fileName = safeAttachmentFileName(file.name);
    const location = attachmentLocation(restricted);
    const path = nativeAttachmentPath(organizationId, documentId, attachmentId, fileName);
    const contentType = file.type || "application/octet-stream";
    let uploaded = false;
    try {
      await ensureGrant.mutate({ organization_id: organizationId });
      uploaded = true;
      await files.upload(path, file, { location, scope: organizationId, contentType });
      await registerAttachment.mutate({ parent_document_id: documentId, storage_path: path, file_name: fileName, content_type: contentType, size_bytes: file.size });
      return `bifrost-attachment:${attachmentId}`;
    } catch (uploadError) {
      if (uploaded) {
        try { await files.delete(path, { location, scope: organizationId }); } catch { /* surface the primary failure */ }
      }
      throw uploadError instanceof Error ? uploadError : new Error(String(uploadError));
    }
  };
}
function RichContent({ html, headings, organizationId }: { html: string; headings: DocumentHeading[]; organizationId: string }) {
  const [state, setState] = useState<{ clean: string; ready: boolean }>({ clean: "", ready: false });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    setState({ clean: "", ready: false });
    import("dompurify").then((purifierModule) => {
      if (!active) return;
      const clean = purifierModule.default.sanitize(html, { FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "link", "meta"], ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|bifrost-attachment):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i });
      const template = document.createElement("template");
      template.innerHTML = clean;
      template.content.querySelectorAll("img").forEach((image) => {
        const source = [image.getAttribute("src"), image.getAttribute("data-src")].find((value) => value?.startsWith("bifrost-attachment:"));
        if (!source) return;
        image.setAttribute("data-bifrost-attachment", source.slice("bifrost-attachment:".length));
        image.removeAttribute("src");
        image.removeAttribute("data-src");
      });
      // Preserve sanitized table markup and merged cells. Only outer tables
      // receive a scroll region, so nested tables stay within their parent.
      const outerTables = Array.from(template.content.querySelectorAll("table"))
        .filter((table) => !table.parentElement?.closest("table"));
      outerTables.forEach((table, index) => {
        const scroller = document.createElement("div");
        scroller.className = "rich-table-scroll";
        scroller.setAttribute("role", "region");
        scroller.setAttribute("aria-label", table.querySelector(":scope > caption")?.textContent?.trim() || `Table ${index + 1}`);
        scroller.tabIndex = 0;
        table.replaceWith(scroller);
        scroller.append(table);
      });
      setState({ clean: template.innerHTML, ready: true });
    }).catch(() => { if (active) setState({ clean: "", ready: true }); });
    return () => { active = false; };
  }, [html]);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const elements = root.querySelectorAll("h1, h2, h3");
    elements.forEach((element, index) => {
      const heading = headings[index];
      if (heading) element.id = heading.id;
    });
    let active = true;
    const images = root.querySelectorAll<HTMLImageElement>("img[data-bifrost-attachment]");
    const urls: string[] = [];
    images.forEach((image) => {
      const attachmentId = image.getAttribute("data-bifrost-attachment") ?? "";
      if (!attachmentId) return;
      const unavailable = () => {
        if (!active) return;
        image.removeAttribute("src");
        image.alt = image.alt ? `${image.alt} — image unavailable` : "Image unavailable";
      };
      tables.get("docs-attachments", attachmentId).then((row) => {
        const data = row?.data ?? {};
        const path = typeof data.storage_path === "string" ? data.storage_path : "";
        const location = typeof data.storage_location === "string" ? data.storage_location : "";
        if (data.quarantined === true || !path || !location || data.organization_id !== organizationId) { unavailable(); return; }
        return files.download(path, { location, scope: organizationId }).then((blob) => {
          if (!active) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          if (root.isConnected) image.src = url;
        });
      }).catch(unavailable);
    });
    return () => {
      active = false;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [state.clean, headings, organizationId]);
  if (!state.ready) return <div className="route-state" role="status"><Loader2 className="spin" />Preparing document…</div>;
  if (!state.clean) return <p className="muted">Document content could not be prepared.</p>;
  return <div ref={ref} className="document-body rich-content" dangerouslySetInnerHTML={{ __html: state.clean }} />;
}
function useNamedRecordReference(entry: CatalogEntry | null, id: string | undefined, organizationId?: string) {
  const record = useRecord(entry?.table ?? "docs-documents", entry ? id : undefined, 0, true, organizationId);
  const matches = Boolean(entry && id && record.row?.id === id && (!organizationId || record.row.organization_id === organizationId));
  return {
    name: matches && !record.error ? asText(record.row!.name, `Untitled ${entry!.singular.toLowerCase()}`) : null,
    loading: Boolean(entry && id && record.loading && !matches),
    denied: Boolean(record.error && isDenied(record.error)),
  };
}

function FolderReference({ kind, folderId, organizationId, emptyLabel = "No folder" }: { kind: "document-folders" | "password-folders"; folderId: unknown; organizationId: unknown; emptyLabel?: string }) {
  const id = typeof folderId === "string" ? folderId.trim() : "";
  const scope = typeof organizationId === "string" ? organizationId.trim() : "";
  const target = useNamedRecordReference(catalogEntry(kind), scope && id ? id : undefined, scope);
  if (!id) return <span>{emptyLabel}</span>;
  if (target.loading) return <span className="muted">Loading folder…</span>;
  return target.name ? <Link className="record-reference-link" to={`/${kind}/${encodeURIComponent(id)}`} title={target.name}>{target.name}</Link>
    : <span className="muted">{target.denied ? "Restricted folder" : "Folder unavailable"}</span>;
}

function MetadataCard({ icon: Icon, title, fields }: { icon: React.ComponentType<{ size?: number | string; className?: string; ["aria-hidden"]?: boolean | "true" | "false" }>; title: string; fields: Array<[string, unknown]> }) {
  return <section className="record-content"><h2><Icon size={18} aria-hidden="true" />{title}</h2><div className="metadata-grid">{fields.map(([label, value]) => <dl key={label}><dt>{label}</dt><dd>{isValidElement(value) ? value : asText(value)}</dd></dl>)}</div></section>;
}
function RecordNotes({ row }: { row: Row }) {
  const notes = asText(row.notes, "");
  return <section className="record-content"><h2><FileText size={18} aria-hidden="true" />Notes</h2>{!notes ? <p className="muted">No notes</p> : looksLikeHtml(notes) ? <RichContent html={notes} headings={[]} organizationId={asText(row.organization_id, "")} /> : <p className="whitespace-pre-wrap break-words">{notes}</p>}</section>;
}
function TraitValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <>—</>;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return <>{String(value)}</>;
  if (Array.isArray(value) || (typeof value === "object" && Array.isArray((value as Record<string, unknown>).values))) {
    const labels = assetTagLabels(value);
    if (labels) return <>{labels}</>;
  }
  return <>{JSON.stringify(value)}</>;
}
function Metadata({ entry, row, heading }: { entry: CatalogEntry; row: Row; heading?: React.ReactNode }) {
  const { viewerId } = useDocsOrganizations();
  if (entry.kind === "documents") {
    const content = asText(row.rendered_content, asText(row.content, ""));
    return <article className="document-content" aria-label="Document content">{heading}{!content ? <p className="muted">No document content was returned by the source.</p> : looksLikeHtml(content) ? <RichContent html={content} headings={extractHeadings(content)} organizationId={asText(row.organization_id, "")} /> : <DocumentBody content={content} />}</article>;
  }
  if (entry.kind === "passwords") return <><MetadataCard icon={KeyRound} title="Credentials" fields={[["Username", row.username], ["Category", row.category_name], ["Folder", <FolderReference key={`${viewerId}:${row.folder_id}:${row.organization_id}`} kind="password-folders" folderId={row.folder_id} organizationId={row.organization_id} />]]} /><MetadataCard icon={Link2} title="Website" fields={[["URL", row.url]]} /><MetadataCard icon={ShieldCheck} title="Protected value" fields={[["Value", "Open this record in IT Glue to view protected values. They are not stored or revealed in Bifrost Docs."]]} /><RecordNotes row={row} /></>;
  if (entry.kind === "configurations") return <><MetadataCard icon={Server} title="Hardware" fields={[["Hostname", row.hostname], ["Serial number", row.serial_number], ["Asset tag", row.asset_tag], ["Manufacturer", row.manufacturer_name ?? row.manufacturer], ["Model", row.model_name ?? row.model], ["Type", row.configuration_type_name], ["Status", row.configuration_status_name]]} /><MetadataCard icon={Network} title="Network" fields={[["IP address", row.ip_address ?? row.primary_ip], ["MAC address", row.mac_address], ["Interfaces", Array.isArray(row.interfaces) ? `${row.interfaces.length} imported interface${row.interfaces.length === 1 ? "" : "s"}` : "No interface data"]]} /><RecordNotes row={row} /></>;
  if (entry.kind === "locations") return <><MetadataCard icon={MapPin} title="Address" fields={[["Street", [asText(row.address_1, ""), asText(row.address_2, "")].filter(Boolean).join(", ")], ["City", row.city], ["Region", row.region], ["Postal code", row.postal_code], ["Country", row.country]]} /><MetadataCard icon={FileText} title="Contact" fields={[["Phone", row.phone]]} /><RecordNotes row={row} /></>;
  if (entry.kind === "flexible-assets") {
    const traits = typeof row.traits === "object" && row.traits !== null ? row.traits as Record<string, unknown> : {};
    const names = Object.keys(traits);
    return <>
      <MetadataCard icon={Layers} title="Asset" fields={[["Type", row.flexible_asset_type_id ? <AssetTypeLink typeId={String(row.flexible_asset_type_id)} fallback={asText(row.flexible_asset_type_id)} /> : "—"], ["Protected fields", Array.isArray(row.secret_fields) && row.secret_fields.length ? "Protected fields remain in IT Glue." : "None recorded"], ["Source updated", timeLabel(row.source_updated_at)]]} />
      <section className="record-content"><h2><FileText size={18} aria-hidden="true" />Traits</h2>{names.length ? <div className="metadata-grid">{names.map((name) => <dl key={name}><dt>{name}</dt><dd><TraitValue value={traits[name]} /></dd></dl>)}</div> : <p className="muted">No safe traits returned.</p>}</section>
    </>;
  }
  if (entry.kind === "flexible-asset-types") {
    const fields = Array.isArray(row.fields) ? row.fields as Array<Record<string, unknown>> : [];
    const sections: Array<{ title: string; fields: Array<Record<string, unknown>> }> = [];
    let current: Array<Record<string, unknown>> = [];
    let untitled = 0;
    const flush = (title?: string) => {
      if (current.length) sections.push({ title: title ?? `Section ${++untitled}`, fields: current });
      current = [];
    };
    for (const field of fields) {
      const attrs = (field.attributes ?? field) as Record<string, unknown>;
      if (String(attrs.kind ?? "") === "Header") {
        flush(typeof attrs.name === "string" && attrs.name ? attrs.name : undefined);
        continue;
      }
      current.push(attrs);
    }
    flush();
    return <>
      <MetadataCard icon={Layers} title="Asset type" fields={[["Icon", row.icon], ["Fields", `${fields.length} field definition${fields.length === 1 ? "" : "s"}`]]} />
      {sections.length ? sections.map((section) => (
        <section key={section.title} className="record-content"><h2>{section.title}</h2><div className="metadata-grid">{section.fields.map((field, index) => {
          const name = typeof field.name === "string" && field.name ? field.name : `Field ${index + 1}`;
          const detail = [String(field.kind ?? "field"), field.required ? "required" : null, typeof field.hint === "string" && field.hint ? field.hint : null].filter(Boolean).join(" · ");
          return <dl key={`${name}-${index}`}><dt>{name}</dt><dd>{detail || "—"}</dd></dl>;
        })}</div></section>
      )) : <p className="muted">No field definitions returned.</p>}
    </>;
  }
  const fields: Array<[string, unknown]> = [["Parent folder", <FolderReference key={`${viewerId}:${entry.kind}:${row.parent_id}:${row.organization_id}`} kind={entry.kind === "password-folders" ? "password-folders" : "document-folders"} folderId={row.parent_id} organizationId={row.organization_id} emptyLabel="Top-level folder" />], ["Hierarchy", Array.isArray(row.ancestor_ids) ? `${row.ancestor_ids.length} ancestor${row.ancestor_ids.length === 1 ? "" : "s"}` : "Top-level folder"], ["Restricted", row.restricted ? "Yes" : "No"]];
  return <section className="metadata-grid" aria-label={`${entry.singular} metadata`}>{fields.map(([label, value]) => <dl key={label}><dt>{label}</dt><dd>{isValidElement(value) ? value : asText(value)}</dd></dl>)}</section>;
}

function useAttachmentPanelState() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(""); const [downloading, setDownloading] = useState(""); const [uploading, setUploading] = useState(false); const [removing, setRemoving] = useState(""); const [removalCandidate, setRemovalCandidate] = useState<Row | null>(null);
  return { refreshKey, setRefreshKey, selectedFile, setSelectedFile, dragging, setDragging, error, setError, downloading, setDownloading, uploading, setUploading, removing, setRemoving, removalCandidate, setRemovalCandidate };
}

function Attachments({ record: parentRecord, parentType, canAttach, canManage, isAdmin, presentation, state }: { record?: Row; parentType: NativeAttachmentParentType; canAttach: boolean; canManage: boolean; isAdmin: boolean; presentation?: "card" | "panel"; state?: ReturnType<typeof useAttachmentPanelState> }) {
  const localState = useAttachmentPanelState();
  const { refreshKey, setRefreshKey, selectedFile, setSelectedFile, dragging, setDragging, error, setError, downloading, setDownloading, uploading, setUploading, removing, setRemoving, removalCandidate, setRemovalCandidate } = state ?? localState;
  const parentId = parentRecord?.id ?? "";
  const attachmentRows = useRelatedRows("docs-attachments", { parent_id: parentId, parent_type: parentType }, refreshKey, typeof parentRecord?.organization_id === "string" ? parentRecord.organization_id : undefined);
  const visibleAttachments = attachmentRows.rows.filter(file => file.file_kind !== "document_image");
  const ensureFileGrant = useWorkflowMutation(attachmentWorkflowRefs.ensureGrant);
  const registerAttachment = useWorkflowMutation(attachmentWorkflowRefs.register);
  const deleteAttachment = useWorkflowMutation(attachmentWorkflowRefs.delete);
  const inputRef = useRef<HTMLInputElement>(null);
  const isRestricted = Boolean(parentRecord?.restricted);
  const mayManage = Boolean(parentRecord && canManage && (!isRestricted || isAdmin));
  async function download(file: Row) {
    const path = typeof file.storage_path === "string" ? file.storage_path : ""; const location = typeof file.storage_location === "string" ? file.storage_location : "";
    if (file.quarantined) { setError(asText(file.integrity_error, "This attachment is quarantined because its stored content could not be verified.")); return; }
    if (!path || !location) { setError("This attachment has no available managed-file path."); return; }
    setError(""); setDownloading(file.id);
    try { const blob = await files.download(path, { location, scope: asText(parentRecord?.organization_id, "") }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = asText(file.file_name, "attachment"); document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch (downloadError) { setError(isDenied(downloadError) ? "You do not have permission to download this attachment." : "The attachment could not be downloaded. Try again or open the source record."); }
    finally { setDownloading(""); }
  }
  async function upload() {
    if (!parentRecord || !canAttach || !selectedFile || !mayManage) return;
    const organizationId = typeof parentRecord.organization_id === "string" ? parentRecord.organization_id.trim() : "";
    if (!organizationId) { setError("This record has no Bifrost organization for attachment storage."); return; }
    const attachmentId = crypto.randomUUID(); const fileName = safeAttachmentFileName(selectedFile.name); const location = attachmentLocation(isRestricted); const path = nativeAttachmentPath(organizationId, parentRecord.id, attachmentId, fileName, parentType); const contentType = selectedFile.type || "application/octet-stream";
    let uploadStarted = false;
    setUploading(true); setError("");
    try {
      await ensureFileGrant.mutate({ organization_id: organizationId });
      uploadStarted = true;
      await files.upload(path, selectedFile, { location, scope: organizationId, contentType });
      await registerAttachment.mutate({ parent_document_id: parentRecord.id, parent_type: parentType, storage_path: path, file_name: fileName, content_type: contentType, size_bytes: selectedFile.size });
      setSelectedFile(null); if (inputRef.current) inputRef.current.value = "";
      setRefreshKey((value) => value + 1);
    } catch (uploadError) {
      if (uploadStarted) {
        try { await files.delete(path, { location, scope: organizationId }); } catch { /* The registration workflow remains the source of truth; surface the primary failure. */ }
      }
      setError(isDenied(uploadError) ? "Your Bifrost role cannot upload attachments for this record." : `The attachment could not be uploaded: ${errorText(uploadError)}`);
    } finally { setUploading(false); }
  }
  async function remove(file: Row) {
    setRemoving(file.id); setError("");
    try { await deleteAttachment.mutate({ attachment_id: file.id }); setRefreshKey((value) => value + 1); return true; }
    catch (removeError) { setError(isDenied(removeError) ? "Your Bifrost role cannot delete this attachment." : `The attachment could not be deleted: ${errorText(removeError)}`); return false; }
    finally { setRemoving(""); }
  }
  const errorTitle = error.startsWith("Your Bifrost role") ? "Attachment access denied" : "Attachment action failed";
  return <UtilityCard presentation={presentation} className="attachments" title="Attachments" icon={<Download size={16} aria-hidden="true" />} actions={canAttach && mayManage ? <BfButton variant="ghost" aria-label={uploading ? "Uploading attachment" : "Upload attachment"} title={uploading ? "Uploading attachment" : "Upload attachment"} disabled={!selectedFile || uploading} icon={uploading ? <Loader2 className="spin" size={15} /> : <Upload size={15} />} onClick={upload} /> : undefined}>{canAttach && mayManage ? <div className="attachment-upload">
    <input ref={inputRef} type="file" aria-label="Choose attachment" disabled={uploading} hidden onChange={event => setSelectedFile(event.target.files?.[0] ?? null)} />
    <button type="button" className={`attachment-drop-zone${dragging ? " is-dragging" : ""}`} aria-label="Drop a file or browse" disabled={uploading} onClick={() => inputRef.current?.click()} onDragOver={event => { event.preventDefault(); if (!uploading) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (!uploading && event.dataTransfer.files[0]) setSelectedFile(event.dataTransfer.files[0]); }}><Upload size={16} aria-hidden="true" /><span>{selectedFile ? selectedFile.name : "Drop a file or browse"}</span></button>
  </div> : null}{parentRecord && canManage && isRestricted && !isAdmin ? <p className="muted">Restricted-record attachments require Bifrost Docs Administrator access.</p> : parentRecord && !canManage ? <p className="muted">Attachment uploads and deletion require Bifrost Docs Editor or Administrator access.</p> : null}{attachmentRows.loading && !attachmentRows.rows.length ? <p className="muted">Loading attachments…</p> : attachmentRows.error ? <BfAlert tone={isDenied(attachmentRows.error) ? "warning" : "danger"} title={isDenied(attachmentRows.error) ? "Attachments unavailable" : "Attachments could not load"}>{isDenied(attachmentRows.error) ? "Your Bifrost role cannot view attachment metadata for this record." : errorText(attachmentRows.error)}</BfAlert> : visibleAttachments.length ? <ul aria-busy={attachmentRows.loading}>{visibleAttachments.map((file) => <li key={file.id}>
    {file.quarantined ? <span className="attachment-file-name">{asText(file.file_name)}</span> : <button type="button" className="attachment-file-link" aria-label={`Download ${asText(file.file_name)}`} title={`${asText(file.file_name)} · ${asText(file.content_type)}`} disabled={downloading === file.id} onClick={() => download(file)}>{asText(file.file_name)}</button>}
    <small className="attachment-size">{formatBytes(file.size_bytes)}</small>
    <div className="attachment-actions">{mayManage ? <BfButton variant="ghost" className="attachment-delete is-destructive" aria-label={`Delete ${asText(file.file_name)}`} title={`Delete ${asText(file.file_name)}`} disabled={removing === file.id} icon={removing === file.id ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />} onClick={() => setRemovalCandidate(file)} /> : null}</div>
    {file.quarantined ? <small className="attachment-quarantine">Quarantined: {asText(file.integrity_error, "stored content could not be verified")}</small> : null}
  </li>)}</ul> : <p className="muted">No files attached.</p>}{error && <BfAlert tone="warning" title={errorTitle}>{error}</BfAlert>}{removalCandidate && <BfDialog open onOpenChange={(open) => { if (!open && removing !== removalCandidate.id) setRemovalCandidate(null); }} title="Delete attachment?" description="This permanently removes the attachment from Bifrost storage." footer={<><BfButton variant="secondary" disabled={removing === removalCandidate.id} onClick={() => setRemovalCandidate(null)}>Cancel</BfButton><BfButton variant="danger" disabled={removing === removalCandidate.id} onClick={async () => { if (await remove(removalCandidate)) setRemovalCandidate(null); }}>{removing === removalCandidate.id ? "Deleting" : "Delete attachment"}</BfButton></>}><p className="empty-copy">Delete {asText(removalCandidate.file_name, "this attachment")}?</p></BfDialog>}</UtilityCard>;
}

function RelationshipEditor({ item, parentId, parentOrganizationId, sourceType, onClose, onSaved }: { item?: Row; parentId: string; parentOrganizationId: string; sourceType: string; onClose: () => void; onSaved: () => void }) {
  async function save(result: CatalogSearchResult) {
    if (!parentOrganizationId || result.organizationId !== parentOrganizationId) throw new Error("Choose a record in this organization.");
    if (result.id === parentId && result.kind.replaceAll("-", "_") === sourceType.replaceAll("-", "_")) throw new Error("Choose a different record.");
    const values = {
      organization_id: parentOrganizationId, source_system: "bifrost",
      source_id: item?.source_id || crypto.randomUUID(), source_type: sourceType,
      source_destination_id: parentId, target_type: result.kind.replaceAll("-", "_"),
      target_source_id: result.sourceId, target_destination_id: result.id,
      relationship_type: asText(item?.relationship_type, "related"),
    };
    try {
      if (item) await tables.update("docs-relationships", item.id, values);
      else await tables.insert("docs-relationships", values);
    } catch (saveError) {
      throw new Error(isDenied(saveError) ? "Your Bifrost role cannot manage related items." : errorText(saveError));
    }
    onSaved(); onClose();
  }
  return <SearchDialog open onOpenChange={(open) => { if (!open) onClose(); }} title={item ? "Edit related item" : "Add related item"} description="Search for an item to link to this record." organizationScope={parentOrganizationId} excludedRecord={{ id: parentId, kind: sourceType.replaceAll("_", "-") }} onSelect={save} />;
}

function RelatedItem({ item, canManage, removing, onEdit, onRemove }: { item: Row; canManage: boolean; removing: boolean; onEdit: () => void; onRemove: () => void }) {
  const entry = relatedRecordEntry(item.target_type);
  const id = typeof item.target_destination_id === "string" ? item.target_destination_id.trim() : "";
  const target = useNamedRecordReference(entry, id || undefined);
  const path = target.name ? relatedRecordPath(item.target_type, id) : null;
  const kind = entry?.singular ?? "Related record";
  const label = target.name ?? (target.loading ? `Loading ${kind.toLowerCase()}…` : target.denied ? `Restricted ${kind.toLowerCase()}` : `${kind} unavailable`);
  return <li aria-busy={target.loading}><Network size={16} aria-hidden="true" /><div><strong>{path ? <Link className="related-item__name" to={path} title={label}>{label}</Link> : label}</strong><small>{[kind, asText(item.relationship_type, "related")].join(" · ")}</small></div>{canManage ? <><BfButton variant="ghost" aria-label="Edit" title="Edit relationship" icon={<Pencil size={15} />} onClick={onEdit} /><BfButton variant="ghost" className="is-destructive" aria-label="Remove" title="Remove relationship" disabled={removing} icon={<Trash2 size={15} />} onClick={onRemove} /></> : null}</li>;
}

function useRelationshipPanelState() {
  const [refreshKey, setRefreshKey] = useState(0); const [editor, setEditor] = useState<Row | "new" | null>(null); const [error, setError] = useState(""); const [removing, setRemoving] = useState(""); const [removalCandidate, setRemovalCandidate] = useState<Row | null>(null);
  return { refreshKey, setRefreshKey, editor, setEditor, error, setError, removing, setRemoving, removalCandidate, setRemovalCandidate };
}

function RelatedItems({ parentId, parentOrganizationId, sourceType, canManage, presentation, state, externalEditor = false }: { parentId: string; parentOrganizationId: string; sourceType: string; canManage: boolean; presentation?: "card" | "panel"; state?: ReturnType<typeof useRelationshipPanelState>; externalEditor?: boolean }) {
  const { viewerId } = useDocsOrganizations();
  const localState = useRelationshipPanelState();
  const { refreshKey, setRefreshKey, editor, setEditor, error, setError, removing, setRemoving, removalCandidate, setRemovalCandidate } = state ?? localState;
  const related = useRelatedRows("docs-relationships", { source_destination_id: parentId }, refreshKey, parentOrganizationId);
  async function remove(item: Row) { setRemoving(item.id); setError(""); try { await tables.delete("docs-relationships", item.id); setRefreshKey((value) => value + 1); return true; } catch (removeError) { setError(isDenied(removeError) ? "Your Bifrost role cannot remove related items." : errorText(removeError)); return false; } finally { setRemoving(""); } }
  return <UtilityCard presentation={presentation} className="related-items" title="Related items" icon={<Link2 size={16} aria-hidden="true" />} actions={canManage ? <BfButton variant="ghost" aria-label="Add related item" title="Add related item" icon={<Plus size={15} />} onClick={() => setEditor("new")} /> : undefined}>{related.loading && !related.rows.length ? <p className="muted">Loading related items…</p> : related.error ? <BfAlert tone={isDenied(related.error) ? "warning" : "danger"} title={isDenied(related.error) ? "Related items are restricted" : "Related items could not load"}>{isDenied(related.error) ? "Your Bifrost role cannot view related-item mappings." : errorText(related.error)}</BfAlert> : related.rows.length ? <ul aria-busy={related.loading}>{related.rows.map((item) => <RelatedItem key={`${viewerId}:${item.id}:${item.target_type}:${item.target_destination_id}`} item={item} canManage={canManage} removing={removing === item.id} onEdit={() => setEditor(item)} onRemove={() => setRemovalCandidate(item)} />)}</ul> : <p className="muted">No related items yet.</p>}{error && <BfAlert tone="danger" title="Relationship action failed">{error}</BfAlert>}{editor && canManage && !externalEditor && <RelationshipEditor item={editor === "new" ? undefined : editor} parentId={parentId} parentOrganizationId={parentOrganizationId} sourceType={sourceType} onClose={() => setEditor(null)} onSaved={() => setRefreshKey((value) => value + 1)} />}{removalCandidate && <BfDialog open onOpenChange={(open) => { if (!open && removing !== removalCandidate.id) setRemovalCandidate(null); }} title="Remove related item?" description="This removes the relationship from Bifrost. Neither related record will be deleted." footer={<><BfButton variant="secondary" disabled={removing === removalCandidate.id} onClick={() => setRemovalCandidate(null)}>Cancel</BfButton><BfButton variant="danger" disabled={removing === removalCandidate.id} onClick={async () => { if (await remove(removalCandidate)) setRemovalCandidate(null); }}>{removing === removalCandidate.id ? "Removing" : "Remove relationship"}</BfButton></>}><p className="empty-copy">Remove the link to this {(relatedRecordEntry(removalCandidate.target_type)?.singular ?? "related item").toLowerCase()}?</p></BfDialog>}</UtilityCard>;
}

/** Own temporary supporting state for the reader, rather than its responsive panels. */
function DocumentReaderTools({ record, canWrite, isAdmin, canManageRecord, outlineTools, leadingAction, children }: {
  record: Row; canWrite: boolean; isAdmin: boolean; canManageRecord: boolean;
  outlineTools: DocumentTool[]; leadingAction: ReactNode; children: ReactNode;
}) {
  const attachmentState = useAttachmentPanelState();
  const relationshipState = useRelationshipPanelState();
  const organizationId = asText(record.organization_id, "");
  const tools: DocumentTool[] = [
    { id: "attachments", title: "Attachments", dock: true, icon: <Paperclip size={16} />,
      content: <Attachments presentation="panel" record={record} parentType="documents" canAttach canManage={canWrite} isAdmin={isAdmin} state={attachmentState} /> },
    { id: "related", title: "Related items", dock: true, icon: <Link2 size={16} />,
      content: <RelatedItems presentation="panel" parentId={record.id} parentOrganizationId={organizationId} sourceType="documents" canManage={canManageRecord} state={relationshipState} externalEditor /> },
    ...outlineTools,
  ];
  return <>
    <DocumentTools tools={tools} leadingAction={leadingAction}>{children}</DocumentTools>
    {canManageRecord && relationshipState.editor && <RelationshipEditor item={relationshipState.editor === "new" ? undefined : relationshipState.editor} parentId={record.id} parentOrganizationId={organizationId} sourceType="documents" onClose={() => relationshipState.setEditor(null)} onSaved={() => relationshipState.setRefreshKey(value => value + 1)} />}
  </>;
}

function ResourceDetail({ kind, isAdmin, canWrite }: { kind: CatalogKind; isAdmin: boolean; canWrite: boolean }) {
  const { viewerId } = useDocsOrganizations();
  const { id, orgId, typeId } = useParams<{ id: string; orgId: string; typeId: string }>(); const navigate = useNavigate(); const entry = catalogEntry(kind); const [refreshKey, setRefreshKey] = useState(0); const [editOpen, setEditOpen] = useState(false); const [deleteOpen, setDeleteOpen] = useState(false); const [publishOpen, setPublishOpen] = useState(false); const [actionError, setActionError] = useState(""); const [deleting, setDeleting] = useState(false); const record = useRecord(entry.table, id, refreshKey, !editOpen, orgId); useEffect(() => { if (record.row && id && (!orgId || record.row.organization_id === orgId)) trackRecentRecord(viewerId, { id, kind, name: asText(record.row.name, `Untitled ${kind}`), organizationId: asText(record.row.organization_id, "") }); }, [record.row, id, kind, orgId, viewerId]); const publish = useWorkflowMutation("functions/authoring.py::docs_publish_draft"); const deleteDocument = useWorkflowMutation(documentMutationRefs.delete);
  if (record.loading && !record.row) return <div className="route-state"><Loader2 className="spin" />Loading {entry.singular.toLowerCase()}…</div>;
  if (record.error) return <div className="route-state"><BfAlert tone={isDenied(record.error) ? "warning" : "danger"} title={isDenied(record.error) ? "Record access denied" : "Record could not load"}>{isDenied(record.error) ? "Your Bifrost role cannot view this record." : errorText(record.error)}</BfAlert></div>;
  if (!record.row) return <div className="route-state"><BfAlert tone="warning" title="Record not found">It may no longer be in your Bifrost scope or has not been migrated.</BfAlert></div>;
  if (orgId && record.row.organization_id !== orgId) return <div className="route-state"><BfAlert tone="warning" title="Record not found">This record is not in the selected Bifrost organization.</BfAlert></div>;
  const href = sourceUrl(record.row); const isNativeDraft = kind === "documents" && String(record.row.source_system) === "bifrost" && String(record.row.status) === "draft"; const mayPublish = canPublishNativeDraft(isAdmin, record.row.source_system, record.row.status);
  async function remove() { setDeleting(true); setActionError(""); try { if (kind === "documents") await deleteDocument.mutate({ document_id: record.row!.id }); else await tables.delete(entry.table, record.row!.id); navigate(catalogPath(kind, orgId ?? parentOrganizationId), { replace: true }); } catch (deleteError) { setActionError(isDenied(deleteError) ? "Your Bifrost role cannot delete this record." : errorText(deleteError)); setDeleting(false); } }
  async function publishDraft() { setActionError(""); try { await publish.mutate({ document_id: record.row!.id, confirmed: true }); setRefreshKey((value) => value + 1); setPublishOpen(false); } catch (publishError) { setActionError(errorText(publishError)); } }
  const parentOrganizationId = typeof record.row.organization_id === "string" ? record.row.organization_id.trim() : "";
  const canManageRecord = canWrite && (!record.row.restricted || isAdmin);
  const supportsEnabledState = ["configurations", "locations", "flexible-assets"].includes(kind);
  const documentHeadings = kind === "documents" ? extractHeadings(asText(record.row.rendered_content, asText(record.row.content, ""))) : [];
  const recordHeading = <section className="record-heading"><div>{kind !== "documents" && <p className="section-kicker">{entry.singular}</p>}<h1>{asText(record.row.name, `Untitled ${entry.singular.toLowerCase()}`)}</h1><div className="record-meta"><BfChip>{String(record.row.source_system) === "bifrost" ? "Bifrost authored" : "Imported"}</BfChip><span>Updated {timeLabel(record.row.source_updated_at ?? record.row.updated_at)}</span>{supportsEnabledState && record.row.is_enabled === false ? <BfChip tone="warning">Disabled</BfChip> : null}{record.row.archived ? <BfChip tone="warning">Archived</BfChip> : null}{isNativeDraft ? <BfChip tone="info">Draft</BfChip> : null}</div></div><div className="detail-actions">{canManageRecord && supportsEnabledState && <RecordEnabledAction key={`${kind}:${record.row.id}`} table={entry.table} recordId={record.row.id} organizationId={parentOrganizationId} name={asText(record.row.name, entry.singular)} singular={entry.singular} enabled={record.row.is_enabled !== false} imported={record.row.source_system === "itglue"} disabled={editOpen || deleting} onUpdated={() => setRefreshKey(value => value + 1)} />}{href ? <a className={`bds-button bds-button--${kind === "documents" ? "ghost" : "secondary"}`} aria-label={entry.kind === "passwords" ? "Open in IT Glue" : "Open source"} title="Open source" href={href} target="_blank" rel="noreferrer"><span className="bds-button__icon" aria-hidden="true"><ExternalLink size={15} /></span><span>{kind === "documents" ? null : entry.kind === "passwords" ? "Open in IT Glue" : "Open source"}</span></a> : entry.kind === "passwords" ? <span className="source-unavailable">IT Glue link unavailable</span> : null}{canManageRecord && kind !== "passwords" && <BfButton variant={kind === "documents" ? "ghost" : "secondary"} aria-label="Edit" title="Edit" icon={<Pencil size={15} />} onClick={() => setEditOpen(true)}>{kind === "documents" ? null : "Edit"}</BfButton>}{mayPublish && <BfButton variant="ghost" aria-label="Publish draft" title="Publish draft" disabled={publish.loading} icon={publish.loading ? <Loader2 className="spin" size={15} /> : <Upload size={15} />} onClick={() => setPublishOpen(true)} />}{canManageRecord && kind !== "passwords" && <BfButton variant={kind === "documents" ? "ghost" : "danger"} className={kind === "documents" ? "is-destructive" : undefined} aria-label="Delete" title="Delete" icon={<Trash2 size={15} />} onClick={() => setDeleteOpen(true)}>{kind === "documents" ? null : "Delete"}</BfButton>}</div></section>;
  const outlineTools = [
    ...(documentHeadings.length ? [{
      id: "contents", title: "On this page", icon: <List size={16} />,
      content: <UtilityCard presentation="panel" title="On this page" icon={<List size={16} />} className="toc">
        <nav aria-label="Document sections"><ul>{documentHeadings.map(heading =>
          <li key={heading.id} data-level={heading.level}><a href={`#${heading.id}`}>{heading.text}</a></li>,
        )}</ul></nav>
      </UtilityCard>,
    }] : []),
  ];
  const backAction = <BfButton variant="ghost" className="back-button" icon={<ArrowLeft size={16} />} onClick={() => navigate(catalogPath(kind, orgId ?? parentOrganizationId))}>Back to browse</BfButton>;
  const readerBody = <>{kind !== "documents" ? recordHeading : null}{isNativeDraft && !mayPublish && <BfAlert tone="info" title="Draft publication requires Bifrost Docs Administrator access">You can continue editing this draft, but an authorized provider or platform administrator must publish it.</BfAlert>}{actionError && <BfAlert tone="danger" title="Record action failed">{actionError}</BfAlert>}<div className="detail-layout"><div className="detail-main"><Metadata entry={entry} row={record.row} heading={kind === "documents" ? recordHeading : undefined} /></div>{kind !== "documents" && <div className="detail-rail"><Attachments record={record.row} parentType={attachmentParentTypes[kind] ?? "documents"} canAttach={Boolean(attachmentParentTypes[kind])} canManage={canWrite} isAdmin={isAdmin} /><RelatedItems parentId={record.row.id} parentOrganizationId={parentOrganizationId} sourceType={kind.replace(/-/g, "_")} canManage={canManageRecord} /></div>}</div></>;
  return <div className={`docs-page detail-page${kind === "documents" ? " document-reader" : ""}`}>
    {kind === "documents" ? <DocumentReaderTools key={`${viewerId}:${record.row.id}`} record={record.row} canWrite={canWrite} isAdmin={isAdmin} canManageRecord={canManageRecord} outlineTools={outlineTools} leadingAction={backAction}>{readerBody}</DocumentReaderTools> : <><div className="document-reader__toolbar">{backAction}</div>{readerBody}</>}
    {canManageRecord && editOpen && <RecordEditor entry={entry} row={record.row} onClose={() => { setEditOpen(false); setRefreshKey((value) => value + 1); }} onSaved={() => setRefreshKey((value) => value + 1)} />}{deleteOpen && <BfDialog open onOpenChange={(open) => { if (!open && !deleting) setDeleteOpen(false); }} title={`Delete ${entry.singular}?`} description={record.row.source_system === "itglue" ? "This removes the Bifrost record. The next successful source migration may recreate a mapped record if it still exists in IT Glue." : "This removes the record from Bifrost Docs."} footer={<><BfButton variant="secondary" disabled={deleting} onClick={() => setDeleteOpen(false)}>Cancel</BfButton><BfButton variant="danger" disabled={deleting} onClick={remove}>{deleting ? "Deleting" : "Delete record"}</BfButton></>}><p className="empty-copy">Delete {asText(record.row.name, entry.singular)}?</p></BfDialog>}{publishOpen && <BfDialog open onOpenChange={(open) => { if (!open && !publish.loading) setPublishOpen(false); }} title="Publish draft?" description="Publishing makes this Bifrost-authored draft available as a document in Bifrost." footer={<><BfButton variant="secondary" disabled={publish.loading} onClick={() => setPublishOpen(false)}>Cancel</BfButton><BfButton disabled={publish.loading} icon={publish.loading ? <Loader2 className="spin" size={15} /> : <Upload size={15} />} onClick={publishDraft}>{publish.loading ? "Publishing" : "Publish draft"}</BfButton></>}><p className="empty-copy">Publish {asText(record.row.name, "this draft")}?</p></BfDialog>}</div>;
}

function AdminMigration() {
  const [mode, setMode] = useState<MigrationMode>("proof"); const [organizationIds, setOrganizationIds] = useState<string[]>([]); const [resourceTypes, setResourceTypes] = useState<string[]>([]); const [confirmOpen, setConfirmOpen] = useState(false); const [runId, setRunId] = useState(""); const [notice, setNotice] = useState(""); const [failure, setFailure] = useState("");
  const preflight = useWorkflowQuery<MigrationPreflight>(PREFLIGHT_REF); const status = useWorkflowQuery<MigrationStatus>(STATUS_REF, { run_id: runId || null }); const start = useWorkflowMutation<{ run_id: string }>(START_REF); const resume = useWorkflowMutation(RESUME_REF); const retry = useWorkflowMutation(RETRY_REF); const cancel = useWorkflowMutation(CANCEL_REF);
  const organizations = preflight.data?.organizations ?? []; const organizationOptions: BfComboboxOption[] = organizations.map((item) => ({ value: item.bifrost_organization_id, label: item.bifrost_organization_name || item.bifrost_organization_id, description: item.itglue_organization_name || "Mapped IT Glue organization" })); const resourceOptions = (preflight.data?.resource_types ?? []).map((value) => ({ value, label: resourceLabels[value] ?? value })); const selectionError = mode === "proof" && organizationIds.length !== 1 ? "A proof run requires exactly one mapped Bifrost organization." : ""; const ready = organizationIds.length > 0 && resourceTypes.length > 0 && !selectionError && !preflight.loading && !preflight.error; const run = status.data?.run; const currentRunId = run?.id || runId; const working = start.loading || resume.loading || retry.loading || cancel.loading;
  const runOptions: BfComboboxOption[] = (status.data?.runs ?? []).map((item) => ({
    value: item.id,
    label: `${item.mode[0].toUpperCase() + item.mode.slice(1)} · ${item.organization_count} organization${item.organization_count === 1 ? "" : "s"} · ${timeLabel(item.started_at)}`,
    description: `${item.resource_count} resource type${item.resource_count === 1 ? "" : "s"} · ${item.recovery_status && item.recovery_status !== "idle" ? `File recovery ${item.recovery_status.replaceAll("_", " ")}` : item.status.replaceAll("_", " ")}`,
    keywords: [item.id],
  }));
  function begin(event: FormEvent) { event.preventDefault(); setFailure(""); setNotice(""); if (ready) setConfirmOpen(true); }
  async function startRun() { setConfirmOpen(false); try { const result = await start.mutate({ bifrost_organization_ids: organizationIds, resource_types: resourceTypes, mode }); setRunId(result.run_id); setNotice(`${mode === "proof" ? "Proof" : "Migration"} run queued. Password values are never included.`); await status.refresh({ run_id: result.run_id }); } catch (error) { setFailure(errorText(error)); } }
  async function runAction(action: "resume" | "retry" | "cancel") { if (!currentRunId) return; setFailure(""); try { const mutation = action === "resume" ? resume : action === "retry" ? retry : cancel; await mutation.mutate({ run_id: currentRunId }); setNotice(`${action[0].toUpperCase() + action.slice(1)} requested.`); await status.refresh({ run_id: currentRunId }); } catch (error) { setFailure(errorText(error)); } }
  const failureColumns: BfDataColumn<MigrationStatus["failures"][number]>[] = [{ id: "resource", header: "Resource", accessor: (row) => `${asText(row.resource_type)} · ${asText(row.source_id)}` }, { id: "error", header: "Error", accessor: (row) => asText(row.error_message) }]; const findingColumns: BfDataColumn<MigrationStatus["findings"][number]>[] = [{ id: "resource", header: "Resource", accessor: (row) => `${asText(row.resource_type)} · ${asText(row.source_id)}` }, { id: "finding", header: "Finding", accessor: (row) => asText(row.detail) }];
  return <div className="docs-page"><section className="page-heading"><div><p className="section-kicker">Administrator area</p><h1>IT Glue migration</h1><p>Move mapped IT Glue documentation into Bifrost. This is a one-way import; Bifrost never writes back to IT Glue.</p></div></section>{preflight.error ? <BfAlert tone="danger" title="Migration setup is unavailable">{errorText(preflight.error)}</BfAlert> : null}{!preflight.loading && !preflight.error && !organizations.length ? <BfAlert tone="warning" title="No mapped organizations">Create IT Glue Integration mappings before starting a migration.</BfAlert> : null}<div className="migration-layout"><section className="operation-panel"><div className="panel-heading"><div><p className="section-kicker">1. Define scope</p><h2>Start a migration</h2></div><RefreshCw size={19} aria-hidden="true" /></div><form onSubmit={begin}><BfRadioGroup label="Migration mode" value={mode} onChange={(value) => { setMode(value as MigrationMode); if (value === "proof" && organizationIds.length > 1) setOrganizationIds(organizationIds.slice(0, 1)); }} options={[{ value: "proof", label: "Proof — import one mapped organization to validate the path" }, { value: "bulk", label: "Bulk — sync selected source records and confirmed deletions" }, { value: "delta", label: "Delta — upsert records changed or missing since the prior migration" }, { value: "reconcile", label: "Reconcile — run delta and report destination drift" }]} /><BfMultiSelect label="Mapped Bifrost organizations" hint="Only organizations with an IT Glue Integration mapping are shown." error={selectionError || undefined} options={organizationOptions} value={organizationIds} onValueChange={setOrganizationIds} loading={preflight.loading} disabled={Boolean(preflight.error) || !organizations.length} maxSelections={mode === "proof" ? 1 : undefined} showBulkActions={mode !== "proof"} emptyText="No mapped Bifrost organizations are available." /><BfMultiSelect label="Resource types" hint="Password values are excluded in every migration mode." options={resourceOptions} value={resourceTypes} onValueChange={setResourceTypes} loading={preflight.loading} disabled={Boolean(preflight.error)} showBulkActions /><BfButton type="submit" disabled={!ready || working} icon={start.loading ? <Loader2 className="spin" size={16} /> : <Play size={16} />}>Review and start</BfButton></form></section><section className="operation-panel run-panel"><div className="panel-heading"><div><p className="section-kicker">2. Observe and recover</p><h2>Current run</h2></div><BfButton variant="ghost" icon={<RefreshCw className={status.loading ? "spin" : ""} size={16} />} onClick={() => status.refresh({ run_id: currentRunId || null })}>Refresh</BfButton></div><BfCombobox label="Migration run" hint="Active migration or file recovery is shown first by default. Select a recent run to view its progress." options={runOptions} value={currentRunId} loading={status.loading && !run} disabled={!runOptions.length} emptyText="No recent migration runs." onValueChange={(value) => { setRunId(value); setNotice(""); setFailure(""); void status.refresh({ run_id: value }); }} />{status.error ? <BfAlert tone="danger" title="Run status could not load">{errorText(status.error)}</BfAlert> : null}{!status.loading && !run ? <p className="empty-copy">No migration run exists yet.</p> : null}{run ? <div className="run-summary"><div className="run-status"><BfChip tone={statusTone(run.status)}>{run.status}</BfChip><code>{run.id}</code></div><dl className="run-facts"><div><dt>Mode</dt><dd>{run.mode}</dd></div><div><dt>Phase</dt><dd>{run.status === "running" && run.phase === "complete" ? "Checking saved progress" : resourceLabels[run.phase] ?? run.phase}</dd></div><div><dt>Started</dt><dd>{timeLabel(run.started_at)}</dd></div><div><dt>Checkpoint</dt><dd>{timeLabel(run.last_checkpoint_at)}</dd></div></dl><div className="count-grid">{Object.entries(status.data?.counts ?? {}).map(([key, value]) => <div key={key}><strong>{value}</strong><span>{key}</span></div>)}</div>{run.last_error ? <BfAlert tone="danger" title="Run interrupted">{run.last_error}</BfAlert> : null}<div className="run-actions"><BfButton variant="secondary" disabled={working || !["interrupted", "cancelled"].includes(run.status)} icon={<Play size={15} />} onClick={() => runAction("resume")}>Resume</BfButton><BfButton variant="secondary" disabled={working || run.status !== "completed_with_errors"} icon={<RotateCcw size={15} />} onClick={() => runAction("retry")}>Retry failures</BfButton><BfButton variant="danger" disabled={working || !["queued", "running"].includes(run.status)} icon={<XCircle size={15} />} onClick={() => runAction("cancel")}>Cancel</BfButton></div></div> : null}{run ? <ExportRecoveryPanel runId={run.id} migrationStatus={run.status} /> : null}</section></div>{notice ? <BfAlert tone="success" title="Migration update">{notice}</BfAlert> : null}{failure ? <BfAlert tone="danger" title="Migration action failed">{failure}</BfAlert> : null}{status.data?.failures.length ? <section className="operation-panel findings"><h2>Recent failures</h2><BfDataTable rows={status.data.failures} columns={failureColumns} getRowId={(row) => row.id} ariaLabel="Recent migration failures" /></section> : null}{status.data?.findings.length ? <section className="operation-panel findings"><h2>Reconciliation findings</h2><BfDataTable rows={status.data.findings} columns={findingColumns} getRowId={(row) => row.id} ariaLabel="Reconciliation findings" /></section> : null}<BfDialog open={confirmOpen} onOpenChange={setConfirmOpen} title="Start this migration?" description="Review the scope before Bifrost queues the one-way IT Glue import." footer={<><BfButton variant="secondary" onClick={() => setConfirmOpen(false)}>Back</BfButton><BfButton onClick={startRun} icon={<CheckCircle2 size={16} />}>Start {mode} run</BfButton></>}><dl className="confirmation-list"><div><dt>Organizations</dt><dd>{organizationIds.length}</dd></div><div><dt>Resources</dt><dd>{resourceTypes.map((item) => resourceLabels[item] ?? item).join(", ")}</dd></div><div><dt>Write behavior</dt><dd>Creates and updates Bifrost copies, then removes source-owned records confirmed deleted from IT Glue. IT Glue remains unchanged.</dd></div><div><dt>Password values</dt><dd>Never included</dd></div></dl></BfDialog></div>;
}

function AccessDenied() { return <div className="route-state"><BfAlert tone="warning" title="Administrator access required">Migration controls are unavailable for your role. You can still browse documentation.</BfAlert></div>; }
function WriteAccessDenied() { return <div className="route-state"><BfAlert tone="warning" title="Editor access required">Creating and editing records requires Bifrost Docs Editor or Administrator access. You can still browse documentation.</BfAlert></div>; }

function TaxonomyAdministration() {
  const target = useCreationOrganization();
  return <div className="taxonomy-administration"><div className="docs-page detail-page"><CreationOrganizationField target={target} /></div>{target.organizationId ? <ConfigurationTaxonomyAdmin organizationId={target.organizationId} /> : !target.loading && !target.error ? <div className="docs-page"><BfAlert tone="info" title="Choose a Bifrost organization">Select the Bifrost organization whose configuration taxonomy you want to manage.</BfAlert></div> : null}</div>;
}

export default function App() {
  const { authedFetch } = useBifrostContext(); const [viewer, setViewer] = useState<Viewer | null>(null); const [viewerError, setViewerError] = useState("");
  useEffect(() => { let active = true; authedFetch("/api/auth/me").then(async (response) => { if (!response.ok) throw new Error(`Unable to verify administrator access (${response.status}).`); return response.json() as Promise<Viewer>; }).then((value) => { if (active) setViewer(value); }).catch((error) => { if (active) setViewerError(errorText(error)); }); return () => { active = false; }; }, [authedFetch]);
  const isAdmin = Boolean(viewer?.is_superuser || viewer?.roles?.includes(ADMIN_ROLE)); const canWrite = Boolean(isAdmin || viewer?.roles?.includes(EDITOR_ROLE));
  return <AppShell isAdmin={isAdmin} viewer={viewer}><Routes><Route path="/" element={<DashboardPage />} /><Route path="/browse" element={<BrowseCatalog canWrite={canWrite} isAdmin={isAdmin} />} /><Route path="/documents/new" element={canWrite ? <DocumentWorkspace canWrite={canWrite}><NewDocument /></DocumentWorkspace> : <WriteAccessDenied />} />{catalogEntries.map((entry) => <Route key={entry.kind} path={`/${entry.kind}/:id`} element={entry.kind === "documents" ? <DocumentWorkspace canWrite={canWrite}><ResourceDetail kind={entry.kind} isAdmin={isAdmin} canWrite={canWrite} /></DocumentWorkspace> : <ResourceDetail kind={entry.kind} isAdmin={isAdmin} canWrite={canWrite} />} />)}<Route path="/org/:orgId" element={<OrgHomePage />} /><Route path="/org/:orgId/browse" element={<BrowseCatalog canWrite={canWrite} isAdmin={isAdmin} />} /><Route path="/org/:orgId/documents/new" element={canWrite ? <DocumentWorkspace canWrite={canWrite}><NewDocument /></DocumentWorkspace> : <WriteAccessDenied />} />{catalogEntries.filter((entry) => entry.kind !== "flexible-assets").map((entry) => <Route key={`scoped-list-${entry.kind}`} path={`/org/:orgId/${entry.kind}`} element={<BrowseCatalog canWrite={canWrite} isAdmin={isAdmin} forcedKind={entry.kind} />} />)}{catalogEntries.map((entry) => <Route key={`scoped-${entry.kind}`} path={`/org/:orgId/${entry.kind}/:id`} element={entry.kind === "documents" ? <DocumentWorkspace canWrite={canWrite}><ResourceDetail kind={entry.kind} isAdmin={isAdmin} canWrite={canWrite} /></DocumentWorkspace> : <ResourceDetail kind={entry.kind} isAdmin={isAdmin} canWrite={canWrite} />} />)}<Route path="/org/:orgId/assets" element={<BrowseCatalog canWrite={canWrite} isAdmin={isAdmin} forcedKind="flexible-assets" />} /><Route path="/org/:orgId/assets/:typeId" element={<BrowseCatalog canWrite={canWrite} isAdmin={isAdmin} forcedKind="flexible-assets" />} /><Route path="/org/:orgId/assets/:typeId/:id" element={<ResourceDetail kind="flexible-assets" isAdmin={isAdmin} canWrite={canWrite} />} /><Route path="/migration" element={viewerError ? <div className="route-state"><BfAlert tone="danger" title="Administrator access could not be verified">{viewerError}</BfAlert></div> : viewer === null ? <div className="route-state"><Loader2 className="spin" />Verifying administrator access…</div> : isAdmin ? <AdminMigration /> : <AccessDenied />} /><Route path="/audit-trail" element={<AuditTrailPage />} /><Route path="/org/:orgId/audit-trail" element={<AuditTrailPage />} /><Route path="/global/audit-trail" element={<AuditTrailPage global />} /><Route path="/global" element={<GlobalPage />} /><Route path="/global/:kind" element={<GlobalKindPage />} /><Route path="/global/assets/:typeId" element={<GlobalKindPage />} /><Route path="/organizations" element={<OrganizationsPage />} /><Route path="/settings/*" element={<SettingsRoutes isAdmin={isAdmin} isPlatformAdmin={Boolean(viewer?.is_superuser)} />} /><Route path="/configuration-taxonomy" element={viewerError ? <div className="route-state"><BfAlert tone="danger" title="Administrator access could not be verified">{viewerError}</BfAlert></div> : viewer === null ? <div className="route-state"><Loader2 className="spin" />Verifying administrator access…</div> : isAdmin ? <TaxonomyAdministration /> : <AccessDenied />} /><Route path="*" element={<Navigate replace to="/" />} /></Routes></AppShell>;
}
