import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useLocation, useMatch, useNavigate } from "react-router-dom";
import { Check, ChevronDown, ChevronRight, FileText, Folder, FolderOpen, FolderPlus, Pencil, RefreshCw, X } from "lucide-react";
import { tables, useWorkflowMutation } from "bifrost";
import { BfAlert } from "@/components/bifrost/BfAlert";
import { BfActionMenu } from "@/components/bifrost/BfActionMenu";
import { BfButton } from "@/components/bifrost/BfButton";
import { BfSelect, BfTextField } from "@/components/bifrost/BfField";
import { useDocsOrganizations } from "@/components/layout/useDocsOrganizations";
import { documentMutationRefs } from "@/lib/editing";
import { cn } from "@/lib/ds-utils";
import { useTableInvalidations } from "@/lib/table-realtime";
import { documentNavigationScope, useDocumentNavigationState, type DocumentNavigationState } from "./useDocumentNavigationState";
import "./DocumentSidebar.css";

export type FolderRow = { id: string; name: string; parentId: string; sourceSystem?: string };
export type FolderNode = FolderRow & { children: FolderNode[] };
type DocumentRow = { id: string; name: string; folderId: string; sourceSystem?: string; status?: string };
type DraggedItem = { kind: "folder" | "document"; id: string };
const PAGE_SIZE = 200;
const DRAG_TYPE = "application/x-bifrost-docs-sidebar";
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function buildFolderTree(rows: FolderRow[]): FolderNode[] {
  const nodes = new Map(rows.map((row) => [row.id, { ...row, children: [] as FolderNode[] }]));
  const roots: FolderNode[] = [];
  for (const node of nodes.values()) {
    const ancestors = new Set<string>([node.id]); let current = node.parentId; let broken = false;
    while (current) { if (ancestors.has(current)) { broken = true; break; } ancestors.add(current); const parent = nodes.get(current); if (!parent) { broken = true; break; } current = parent.parentId; }
    const parent = nodes.get(node.parentId);
    if (parent && !broken) parent.children.push(node); else roots.push(node);
  }
  const sort = (items: FolderNode[]) => { items.sort((a, b) => a.name.localeCompare(b.name)); items.forEach((item) => sort(item.children)); };
  sort(roots); return roots;
}

export function canMoveFolder(rows: FolderRow[], folderId: string, parentId: string): boolean {
  if (!parentId) return true;
  const parents = new Map(rows.map((row) => [row.id, row.parentId])); const seen = new Set<string>(); let current = parentId;
  while (current) { if (current === folderId || seen.has(current)) return false; seen.add(current); current = parents.get(current) ?? ""; }
  return true;
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const docsFor = (documents: DocumentRow[], folderId: string) => documents.filter((document) => document.folderId === folderId);

async function queryAll(table: string, organizationId: string, isCurrent: () => boolean): Promise<{ rows: { id: string; data: Record<string, unknown> }[]; tableId: string | null } | null> {
  const found: { id: string; data: Record<string, unknown> }[] = []; const seen = new Set<string>(); let offset = 0;
  let tableId: string | null = null;
  while (true) {
    if (!isCurrent()) return null;
    const result = await tables.query(table, { ...(organizationId ? { where: { organization_id: organizationId } } : {}), limit: PAGE_SIZE, offset, order_by: "name", order_dir: "asc" });
    if (typeof result.table_id === "string") tableId = result.table_id;
    if (!isCurrent()) return null;
    const page = Array.isArray(result.documents) ? result.documents : []; let added = 0;
    for (const row of page) if (row && typeof row.id === "string" && row.id && !seen.has(row.id)) { seen.add(row.id); added += 1; found.push({ id: row.id, data: asRecord(row.data) }); }
    if (page.length < PAGE_SIZE) return { rows: found, tableId };
    if (!added) throw new Error(`Unable to finish loading ${table}; the next page repeated earlier records.`);
    offset += page.length;
  }
}

function parseDrag(event: DragEvent<HTMLElement>): DraggedItem | null {
  try { const value = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)) as Partial<DraggedItem>; return (value.kind === "folder" || value.kind === "document") && typeof value.id === "string" && value.id ? value as DraggedItem : null; } catch { return null; }
}
function beginDrag(event: DragEvent<HTMLElement>, value: DraggedItem) { event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(value)); event.dataTransfer.effectAllowed = "move"; }
function docPath(id: string, organizationId: string) { return organizationId ? `/org/${encodeURIComponent(organizationId)}/documents/${encodeURIComponent(id)}` : `/documents/${encodeURIComponent(id)}`; }

function DocumentItem({ document, depth, canWrite, folders, onMove, onOpen }: { document: DocumentRow; depth: number; canWrite: boolean; folders: FolderRow[]; onMove: (document: DocumentRow, folderId: string) => void; onOpen: (document: DocumentRow) => void }) {
  const current = useLocation().pathname.endsWith(`/documents/${encodeURIComponent(document.id)}`);
  const items = [{ value: "move:", label: "Move to top level", disabled: !document.folderId }, ...folders.map((folder) => ({ value: `move:${folder.id}`, label: `Move to ${folder.name}`, disabled: folder.id === document.folderId }))];
  return <li className="flex items-center gap-1" style={{ paddingLeft: `calc(32px + min(${depth * 16}px, 25%))` }}><button type="button" draggable={canWrite} title={canWrite ? "Drag to move" : undefined} onDragStart={(event) => beginDrag(event, { kind: "document", id: document.id })} onClick={() => onOpen(document)} aria-current={current ? "page" : undefined} className={cn("flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-sidebar-accent", current && "bg-sidebar-accent font-medium text-sidebar-accent-foreground")}><FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="truncate">{document.name}</span></button>{canWrite && <BfActionMenu label={`Actions for ${document.name}`} items={items} onSelect={(value) => onMove(document, value.slice(5))} />}</li>;
}

function FolderItem({ node, rows, documents, depth, selectedId, filter, collapsed, onToggle, ancestorMatched = false, canWrite, onSelect, onRename, onMove, onMoveDocument, onOpenDocument, onDrop }: {
  node: FolderNode; rows: FolderRow[]; documents: DocumentRow[]; depth: number; selectedId: string | null; filter: string; collapsed: Set<string>; onToggle: (id: string) => void; ancestorMatched?: boolean; canWrite: boolean; onSelect: (id: string | null) => void; onRename: (node: FolderNode, name: string) => Promise<void>; onMove: (node: FolderNode, parentId: string) => Promise<void>; onMoveDocument: (document: DocumentRow, folderId: string) => void; onOpenDocument: (document: DocumentRow) => void; onDrop: (event: DragEvent<HTMLElement>, parentId: string) => void;
}) {
  const [dropActive, setDropActive] = useState(false);
  const [editing, setEditing] = useState(false); const [moving, setMoving] = useState(false); const [name, setName] = useState(node.name); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => setName(node.name), [node.name]);
  const query = filter.trim().toLowerCase();
  const folderMatched = ancestorMatched || Boolean(query && node.name.toLowerCase().includes(query));
  const open = Boolean(query) || !collapsed.has(node.id);
  const shownDocuments = docsFor(documents, node.id).filter((document) => !query || folderMatched || document.name.toLowerCase().includes(query));
  const shownChildren = node.children.filter((child) => !query || folderMatched || folderMatches(child, documents, query));
  const options = [{ label: "Top level", value: "" }, ...rows.filter((row) => row.id !== node.id && canMoveFolder(rows, node.id, row.id)).map((row) => ({ label: row.name, value: row.id }))];
  async function saveName() { if (!name.trim()) { setError("Folder name is required."); return; } setBusy(true); setError(""); try { await onRename(node, name.trim()); setEditing(false); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }
  async function selectParent(parentId: string) { if (!canMoveFolder(rows, node.id, parentId)) { setError("A folder cannot be moved into itself or its descendants."); return; } setBusy(true); setError(""); try { await onMove(node, parentId); setMoving(false); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }
  return <li><div className="flex items-center gap-1 document-sidebar__folder-row" data-drop-active={dropActive || undefined} style={{ paddingLeft: `min(${depth * 16}px, 25%)` }} onDragOver={(event) => { if (canWrite && Array.from(event.dataTransfer.types || []).includes(DRAG_TYPE)) { event.preventDefault(); setDropActive(true); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }} onDrop={(event) => { setDropActive(false); onDrop(event, node.id); }}>{node.children.length > 0 || docsFor(documents, node.id).length > 0 ? <button type="button" aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`} aria-expanded={open} disabled={Boolean(query)} title={query ? "Folders are expanded while filtering" : undefined} onClick={() => onToggle(node.id)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-xs text-muted-foreground hover:text-foreground">{open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}</button> : <span className="h-8 w-8 shrink-0" aria-hidden="true" />}<button type="button" draggable={canWrite} title={canWrite ? "Drag to move" : undefined} onDragStart={(event) => beginDrag(event, { kind: "folder", id: node.id })} aria-current={selectedId === node.id ? "true" : undefined} onClick={() => onSelect(node.id)} className={cn("flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors", selectedId === node.id ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "hover:bg-sidebar-accent")}>{selectedId === node.id || open ? <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}<span className="truncate">{node.name}</span></button>{canWrite && <BfActionMenu label={`Actions for ${node.name}`} items={[{ value: "rename", label: "Rename folder", icon: <Pencil size={14} /> }, { value: "move", label: "Move folder" }]} onSelect={(value) => { setEditing(value === "rename"); setMoving(value === "move"); setError(""); }} />}</div>
    {editing && <div className="grid gap-2 px-2 py-2"><BfTextField label={`Rename ${node.name}`} value={name} onChange={(event) => setName(event.target.value)} /><div className="flex gap-2"><BfButton type="button" disabled={busy} icon={<Check size={14} />} onClick={() => void saveName()}>Save</BfButton><BfButton type="button" variant="secondary" disabled={busy} icon={<X size={14} />} onClick={() => { setName(node.name); setEditing(false); setError(""); }}>Cancel</BfButton></div></div>}
    {moving && <div className="grid gap-2 px-2 py-2"><BfSelect label={`Move ${node.name} to`} options={options} value={node.parentId} onChange={(event) => void selectParent(event.target.value)} /><p className="text-xs text-muted-foreground">Use this keyboard-accessible menu to move a folder.</p></div>}{error && <p role="alert" className="px-2 text-xs text-destructive">{error}</p>}
    {open && shownDocuments.length > 0 && <ul className="mt-0.5 space-y-0.5">{shownDocuments.map((document) => <DocumentItem key={document.id} document={document} depth={depth + 1} canWrite={canWrite} folders={rows} onMove={onMoveDocument} onOpen={onOpenDocument} />)}</ul>}
    {open && shownChildren.length > 0 && <ul className="mt-0.5 space-y-0.5">{shownChildren.map((child) => <FolderItem key={child.id} node={child} rows={rows} documents={documents} depth={depth + 1} selectedId={selectedId} filter={filter} collapsed={collapsed} onToggle={onToggle} ancestorMatched={folderMatched} canWrite={canWrite} onSelect={onSelect} onRename={onRename} onMove={onMove} onMoveDocument={onMoveDocument} onOpenDocument={onOpenDocument} onDrop={onDrop} />)}</ul>}</li>;
}

function folderMatches(node: FolderNode, documents: DocumentRow[], filter: string): boolean { return node.name.toLowerCase().includes(filter) || docsFor(documents, node.id).some((document) => document.name.toLowerCase().includes(filter)) || node.children.some((child) => folderMatches(child, documents, filter)); }

export function DocumentSidebar({ selectedFolderId, onSelect, canWrite = false, onNavigate, state }: { selectedFolderId: string | null; onSelect: (folderId: string | null) => void; canWrite?: boolean; onNavigate?: () => void; state?: DocumentNavigationState }) {
  const documentOpen = /\/documents\/[^/]+$/.test(useLocation().pathname);
  const scopedDocument = useMatch("/org/:orgId/documents/:id");
  const globalDocument = useMatch("/documents/:id");
  const activeDocumentId = scopedDocument?.params.id ?? globalDocument?.params.id ?? null;
  const navigate = useNavigate(); const folderMove = useWorkflowMutation("functions/folders.py::docs_move_document_folder"); const updateDocument = useWorkflowMutation(documentMutationRefs.update); const updateDraft = useWorkflowMutation("functions/authoring.py::docs_update_draft"); const { organizationId, selected, viewerId } = useDocsOrganizations();
  const localState = useDocumentNavigationState(organizationId, viewerId);
  const { filter, setFilter, collapsed, setCollapsed, revealSelection } = state ?? localState;
  const [rows, setRows] = useState<FolderRow[]>([]); const [documents, setDocuments] = useState<DocumentRow[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [adding, setAdding] = useState(false); const [newName, setNewName] = useState(""); const [saving, setSaving] = useState(false); const [tableIds, setTableIds] = useState<string[]>([]); const [tableScope, setTableScope] = useState(""); const [realtimeRefresh, setRealtimeRefresh] = useState(0);
  const requestGeneration = useRef(0);
  const treeRef = useRef<HTMLDivElement>(null);
  const scope = documentNavigationScope(organizationId, viewerId);
  useEffect(() => {
    requestGeneration.current += 1;
    setRows([]); setDocuments([]); setTableIds([]); setTableScope(""); setError(""); setNotice(""); setAdding(false); setNewName(""); setSaving(false); setLoading(Boolean(organizationId));
  }, [scope, organizationId]);
  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    const isCurrent = () => requestGeneration.current === generation;
    if (!organizationId) { if (isCurrent()) { setRows([]); setDocuments([]); setTableIds([]); setTableScope(""); setError(""); setLoading(false); } return; }
    setLoading(true); setError("");
    try {
      /* Table queries have no metadata projection; do not issue per-document body requests. */
      const [folderRows, documentRows] = await Promise.all([queryAll("docs-document-folders", organizationId, isCurrent), queryAll("docs-documents", organizationId, isCurrent)]);
      if (!isCurrent() || !folderRows || !documentRows) return;
      setTableIds([folderRows.tableId, documentRows.tableId].filter((id): id is string => Boolean(id))); setTableScope(scope);
      setRows(folderRows.rows.map(({ id, data }) => ({ id, name: typeof data.name === "string" && data.name ? data.name : id, parentId: typeof data.parent_id === "string" ? data.parent_id : "", sourceSystem: typeof data.source_system === "string" ? data.source_system.toLowerCase() : undefined })));
      setDocuments(documentRows.rows.flatMap(({ id, data }): DocumentRow[] => data.archived === true ? [] : [{ id, name: typeof data.name === "string" && data.name ? data.name : id, folderId: typeof data.folder_id === "string" ? data.folder_id : "", sourceSystem: typeof data.source_system === "string" ? data.source_system.toLowerCase() : undefined, status: typeof data.status === "string" ? data.status.toLowerCase() : undefined }]));
    } catch (failure) { if (isCurrent()) { setRows([]); setDocuments([]); setTableIds([]); setTableScope(""); setError(errorText(failure)); } } finally { if (isCurrent()) setLoading(false); }
  }, [organizationId, realtimeRefresh, scope]);
  useEffect(() => {
    void load();
    return () => { requestGeneration.current += 1; };
  }, [load]); const roots = useMemo(() => buildFolderTree(rows), [rows]); const query = filter.trim().toLowerCase(); const visibleRoots = useMemo(() => query ? roots.filter((node) => folderMatches(node, documents, query)) : roots, [roots, documents, query]); const unfiled = docsFor(documents, "").filter((document) => !query || document.name.toLowerCase().includes(query)); const selectedName = rows.find((row) => row.id === selectedFolderId)?.name;
  // Keep expansion choices outside recursively mounted rows. Closing a parent,
  // filtering, or refreshing data must not reset its children's choices.
  const activeFolderId = documents.find((document) => document.id === activeDocumentId)?.folderId ?? selectedFolderId;
  const revealPath = useMemo(() => {
    const parents = new Map(rows.map((row) => [row.id, row.parentId]));
    const path: string[] = []; const seen = new Set<string>();
    let current = activeFolderId;
    while (current && parents.has(current) && !seen.has(current)) {
      seen.add(current); path.push(current); current = parents.get(current) ?? null;
    }
    return JSON.stringify(path);
  }, [rows, activeFolderId]);
  useEffect(() => {
    if (tableScope !== scope) return;
    revealSelection(JSON.stringify([activeDocumentId, selectedFolderId, revealPath]), new Set<string>(JSON.parse(revealPath)));
  }, [revealPath, activeDocumentId, selectedFolderId, scope, tableScope, revealSelection]);
  function toggleFolder(id: string) {
    setCollapsed((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    function revealSelection() {
      if (!tree) return;
      const selected = tree.querySelector('button[aria-current="page"]') ?? tree.querySelector('button[aria-current="true"]');
      if (!selected) return;
      const viewport = tree.getBoundingClientRect();
      if (!viewport.height) return; // Mobile navigation is still closed.
      const row = selected.getBoundingClientRect();
      if (row.top < viewport.top) tree.scrollTop += row.top - viewport.top;
      else if (row.bottom > viewport.bottom) tree.scrollTop += row.bottom - viewport.bottom;
    }
    revealSelection();
    const navigation = tree.closest("details");
    navigation?.addEventListener("toggle", revealSelection);
    return () => navigation?.removeEventListener("toggle", revealSelection);
  }, [activeDocumentId, selectedFolderId, collapsed, filter, roots, documents]);
  useTableInvalidations(tableScope === scope ? tableIds : [], organizationId || null, () => setRealtimeRefresh((value) => value + 1), () => { requestGeneration.current += 1; setTableIds([]); setTableScope(""); setRows([]); setDocuments([]); setLoading(false); setError(""); });
  async function create() { if (!organizationId) { setError("Choose an organization before creating a folder."); return; } if (!newName.trim()) { setError("Folder name is required."); return; } setSaving(true); setError(""); try { await tables.insert("docs-document-folders", { organization_id: organizationId, source_system: "bifrost", source_id: crypto.randomUUID(), source_updated_at: new Date().toISOString(), name: newName.trim(), parent_id: "", ancestor_ids: [], restricted: false, raw: null }); setNewName(""); setAdding(false); await load(); } catch (failure) { setError(errorText(failure)); } finally { setSaving(false); } }
  async function rename(node: FolderNode, name: string) { if (!organizationId) throw new Error("Choose an organization before editing folders."); await tables.update("docs-document-folders", node.id, { name }, organizationId); await load(); if (node.sourceSystem && node.sourceSystem !== "bifrost") setNotice("This imported item may be updated by its source."); }
  async function move(node: FolderNode, parentId: string) { if (!organizationId) throw new Error("Choose an organization before editing folders."); if (!canMoveFolder(rows, node.id, parentId)) throw new Error("A folder cannot be moved into itself or its descendants."); await folderMove.mutate({ folder_id: node.id, parent_id: parentId || null }); await load(); if (node.sourceSystem && node.sourceSystem !== "bifrost") setNotice("This imported item may be updated by its source."); }
  async function moveDocument(document: DocumentRow, folderId: string) { if (!organizationId) throw new Error("Choose an organization before moving documents."); if (document.folderId === folderId) return; const values = { document_id: document.id, folder_id: folderId || null }; if (document.sourceSystem === "bifrost" && document.status === "draft") await updateDraft.mutate(values); else await updateDocument.mutate(values); await load(); if (document.sourceSystem && document.sourceSystem !== "bifrost") setNotice("This imported item may be updated by its source."); }
  function requestDocumentMove(document: DocumentRow, folderId: string) { void moveDocument(document, folderId).catch((failure) => setError(errorText(failure))); }
  function openDocument(document: DocumentRow) { navigate(docPath(document.id, organizationId)); onNavigate?.(); }
  function drop(event: DragEvent<HTMLElement>, parentId: string) { if (!canWrite) return; event.preventDefault(); const dragged = parseDrag(event); if (!dragged) return; if (dragged.kind === "folder") { const folder = rows.find((row) => row.id === dragged.id); if (folder && canMoveFolder(rows, folder.id, parentId)) void move(folder as FolderNode, parentId).catch((failure) => setError(errorText(failure))); } else { const document = documents.find((row) => row.id === dragged.id); if (document) requestDocumentMove(document, parentId); } }
  return <aside aria-label="Document folders" className="document-sidebar rounded-[var(--bf-radius-surface)] border border-[var(--bf-line)] bg-[var(--bf-paper)] p-3">
    <div className="document-sidebar__header">
      <div className="document-sidebar__filter">
        <BfTextField label="Filter documents" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter documents…" disabled={!organizationId} />
        {canWrite && <BfButton variant="ghost" className="document-sidebar__add" aria-label="New folder" title="New folder" icon={<FolderPlus size={15} />} disabled={!organizationId} onClick={() => setAdding(true)} />}
      </div>
      {adding && <div className="document-sidebar__create"><BfTextField label="New folder" value={newName} onChange={event => setNewName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void create(); if (event.key === "Escape") { setAdding(false); setNewName(""); } }} autoFocus /><div className="flex gap-1"><BfButton variant="ghost" aria-label="Create" title="Create folder" disabled={saving} icon={<Check size={14} />} onClick={() => void create()} /><BfButton variant="ghost" aria-label="Cancel" title="Cancel" disabled={saving} icon={<X size={14} />} onClick={() => { setAdding(false); setNewName(""); }} /></div></div>}
      <button type="button" onDragOver={(event) => { if (canWrite && organizationId) event.preventDefault(); }} onDrop={(event) => drop(event, "")} onClick={() => onSelect(null)} aria-current={!selectedFolderId && !documentOpen ? "true" : undefined} className={cn("mb-1 mt-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors", !selectedFolderId && !documentOpen ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "hover:bg-sidebar-accent")}><FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="truncate">All documents</span></button>
      {notice && <BfAlert tone="warning" title="Imported item updated">{notice}</BfAlert>}
      {error && <BfAlert tone="danger" title="Document navigation could not load">{error}<div className="mt-2"><BfButton variant="secondary" icon={<RefreshCw size={15} />} onClick={() => void load()}>Retry</BfButton></div></BfAlert>}
    </div>
    <div ref={treeRef} className="document-sidebar__tree" aria-label="Document tree" aria-busy={loading}>
      {!loading && !error && query && !visibleRoots.length && !unfiled.length && <p role="status" className="px-2 py-1.5 text-sm text-muted-foreground">No folders or documents match.</p>}
      {!organizationId ? <p className="px-2 py-1.5 text-sm text-muted-foreground">Choose an organization to browse its document tree.</p> : loading && tableScope !== scope ? <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading documents…</p> : !error && roots.length === 0 && documents.length === 0 ? <p className="px-2 py-1.5 text-sm text-muted-foreground">No documents are available for {selected?.name ?? "this scope"}.</p> : !error ? <><ul className="space-y-0.5">{visibleRoots.map((node) => <FolderItem key={node.id} node={node} rows={rows} documents={documents} depth={0} selectedId={selectedFolderId} filter={filter} collapsed={collapsed} onToggle={toggleFolder} canWrite={canWrite} onSelect={onSelect} onRename={rename} onMove={move} onMoveDocument={requestDocumentMove} onOpenDocument={openDocument} onDrop={drop} />)}</ul>{unfiled.length > 0 && <ul className="mt-1 space-y-0.5">{unfiled.map((document) => <DocumentItem key={document.id} document={document} depth={0} canWrite={canWrite} folders={rows} onMove={requestDocumentMove} onOpen={openDocument} />)}</ul>}</> : null}
    </div>
    <div className="document-sidebar__footer">

      {selectedName && <p className="mt-2 truncate border-t border-[var(--bf-line)] px-2 pt-2 text-xs text-muted-foreground">Filtered to {selectedName}</p>}
    </div>
  </aside>;
}
