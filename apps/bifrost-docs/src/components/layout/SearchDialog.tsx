import { useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { tables } from "bifrost";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { BfButton } from "@/components/bifrost/BfButton";
import { BfAlert } from "@/components/bifrost/BfAlert";
import { useDocsOrganizations } from "./useDocsOrganizations";

const KINDS = [{ kind: "documents", label: "Documents" }, { kind: "passwords", label: "Passwords" }, { kind: "configurations", label: "Configurations" }, { kind: "locations", label: "Locations" }, { kind: "flexible-assets", label: "Assets" }] as const;
type SearchKind = typeof KINDS[number]["kind"];
export type CatalogSearchResult = { id: string; kind: SearchKind; name: string; organizationId: string; preview: string; sourceId: string };
type Result = CatalogSearchResult;
export const searchSnippet = (value: unknown) => String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);

type SearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  organizationScope?: string;
  excludedRecord?: { id: string; kind: string };
  onSelect?: (result: CatalogSearchResult) => void | Promise<void>;
};

export function SearchDialog({ open, onOpenChange, title = "Search the catalog", description, organizationScope, excludedRecord, onSelect }: SearchDialogProps) {
  const navigate = useNavigate();
  const descriptionId = useId();
  const { organizationId, mode, organizations } = useDocsOrganizations();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<SearchKind | "all">("all");
  const [global, setGlobal] = useState(!organizationId);
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  const [preview, setPreview] = useState<Result | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { if (open) { setGlobal(!organizationId); setPreview(null); } }, [open, organizationId]);
  const scope = organizationScope ?? (mode.kind === "fixed" || !global ? organizationId : "");
  useEffect(() => {
    let active = true;
    if (!open || query.trim().length < 2) { setResults([]); setLoading(false); setError(""); return; }
    setLoading(true); setError("");
    const timer = window.setTimeout(async () => {
      const targets = KINDS.filter((item) => kind === "all" || item.kind === kind);
      const failures: string[] = [];
      const groups = await Promise.all(targets.map(async (target) => {
        const found = new Map<string, Result>();
        const fields = target.kind === "documents" ? ["name", "content", "rendered_content"] : target.kind === "configurations" ? ["name", "hostname", "ip_address"] : target.kind === "locations" ? ["name", "address_1", "notes"] : target.kind === "passwords" ? ["name", "username"] : ["name"];
        try {
          for (const field of fields) {
            let offset = 0;
            while (found.size < 8) {
              const response = await tables.query(`docs-${target.kind}`, { where: { ...(scope ? { organization_id: scope } : {}), [field]: { contains: query.trim() } }, limit: 50, offset, order_by: "name", order_dir: "asc" });
              const rows = response.documents ?? [];
              for (const row of rows) {
                const data = row.data ?? {};
                if (organizationScope !== undefined && data.organization_id !== organizationScope) continue;
                if (row.id === excludedRecord?.id && target.kind === excludedRecord.kind) continue;
                if (!includeDisabled && (data.is_enabled === false || data.archived === true)) continue;
                found.set(row.id, { id: row.id, kind: target.kind, name: String(data.name ?? row.id), organizationId: String(data.organization_id ?? scope), sourceId: typeof data.source_id === "string" && data.source_id ? data.source_id : row.id, preview: searchSnippet(target.kind === "documents" ? data.rendered_content || data.content : target.kind === "passwords" ? data.username : data.notes || data.address_1 || data.hostname) });
                if (found.size === 8) break;
              }
              offset += rows.length;
              if (!active || rows.length < 50 || offset >= (response.total ?? offset)) break;
            }
            if (found.size >= 8 || !active) break;
          }
        } catch (failure) { failures.push(`${target.label}: ${failure instanceof Error ? failure.message : String(failure)}`); }
        return [...found.values()];
      }));
      if (active) { setResults(groups.flat()); setError(failures.join(" · ")); setLoading(false); }
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [open, query, kind, scope, includeDisabled, attempt, organizationScope, excludedRecord?.id, excludedRecord?.kind]);
  async function selectResult(result: Result) {
    if (!onSelect || selecting) return;
    setSelecting(true); setSelectionError("");
    try { await onSelect(result); } catch (failure) { setSelectionError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setSelecting(false); }
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (kind === "all" || onSelect) {
      const first = results[0];
      if (first && !loading) { if (onSelect) { void selectResult(first); return; } navigate(first.organizationId ? `/org/${first.organizationId}/${first.kind}/${first.id}` : `/${first.kind}/${first.id}`); onOpenChange(false); }
      return;
    }
    const params = new URLSearchParams({ q: query.trim() });
    navigate(`${scope ? `/org/${scope}/${kind === "flexible-assets" ? "assets" : kind}` : `/global/${kind}`}?${params}`);
    onOpenChange(false);
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className={onSelect ? "sm:max-w-md" : "sm:max-w-3xl"} aria-describedby={description ? descriptionId : undefined}><DialogHeader><DialogTitle>{title}</DialogTitle>{description && <DialogDescription id={descriptionId}>{description}</DialogDescription>}</DialogHeader>
    <form onSubmit={submit} className="grid gap-4" aria-busy={selecting || loading || undefined}>{!onSelect && <div className="flex flex-wrap gap-2" role="group" aria-label="Record type"><Button size="sm" type="button" variant={kind === "all" ? "default" : "outline"} onClick={() => setKind("all")}>All records</Button>{KINDS.map((item) => <Button key={item.kind} size="sm" type="button" variant={kind === item.kind ? "default" : "outline"} onClick={() => setKind(item.kind)}>{item.label}</Button>)}</div>}
      <Input autoFocus aria-label="Search query" placeholder="Search records and document content…" value={query} onChange={(event) => setQuery(event.target.value)} />
      {!onSelect && <div className="flex flex-wrap items-center justify-between gap-3">{mode.kind === "picker" && organizationId ? <Button type="button" variant="outline" size="sm" onClick={() => setGlobal((value) => !value)}>{global ? "All organizations" : organizations.find((org) => org.id === organizationId)?.name ?? "Current organization"}</Button> : <span className="text-sm text-muted-foreground">{scope ? "Current organization" : "All organizations"}</span>}<label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={includeDisabled} onChange={(event) => setIncludeDisabled(event.target.checked)} />Include disabled records</label></div>}
      {error && <BfAlert tone="danger" title="Some results could not load">{error}<Button variant="outline" type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</Button></BfAlert>}
      {selectionError && <BfAlert tone="danger" title="Could not link record">{selectionError}</BfAlert>}
      <div aria-live="polite">{selecting ? <p className="text-sm text-muted-foreground">Linking record…</p> : loading ? <p className="text-sm text-muted-foreground">Searching…</p> : query.trim().length < 2 ? <p className="text-sm text-muted-foreground">Type at least two characters to search.</p> : !results.length && !error ? <p className="text-sm text-muted-foreground">No matching records.</p> : null}</div>
      {!loading && results.length > 0 && <div className={onSelect ? "grid gap-4" : "grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"}><div className="grid max-h-72 gap-3 overflow-auto" aria-label="Search results">{KINDS.map((item) => { const group = results.filter((result) => result.kind === item.kind); return group.length ? <section key={item.kind}><h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{item.label}</h3>{group.map((result) => <div key={result.id} className="flex items-center gap-2">{onSelect ? <BfButton className="search-result-select" variant="ghost" type="button" disabled={selecting} aria-label={`Link ${result.name}`} onClick={() => { void selectResult(result); }}><span className="block truncate text-sm font-medium">{result.name}</span></BfButton> : <Link to={result.organizationId ? `/org/${result.organizationId}/${result.kind}/${result.id}` : `/${result.kind}/${result.id}`} className="flex min-h-10 min-w-0 flex-1 flex-col rounded px-2 py-1 hover:bg-muted" onFocus={() => setPreview(result)} onMouseEnter={() => setPreview(result)} onClick={() => onOpenChange(false)}><span className="truncate text-sm font-medium">{result.name}</span><span className="truncate text-xs text-muted-foreground">{organizations.find((org) => org.id === result.organizationId)?.name ?? ""}</span></Link>}{!onSelect && <Button size="sm" variant="ghost" type="button" aria-label={`Preview ${result.name}`} onClick={() => setPreview(result)}>Preview</Button>}</div>)}</section> : null; })}</div>{!onSelect && <aside className="h-48 overflow-y-auto rounded border border-border p-3 text-sm" aria-label="Record preview">{preview ? <><h3 className="mb-2 font-semibold">{preview.name}</h3><p className="break-words text-muted-foreground">{preview.preview || "Open the record to view its details."}</p></> : <p className="text-muted-foreground">Focus a result or choose Preview to see its details.</p>}</aside>}</div>}
      <div className="flex justify-end gap-2">{onSelect ? <BfButton variant="secondary" type="button" disabled={selecting} onClick={() => onOpenChange(false)}>Cancel</BfButton> : <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>}{kind !== "all" && !onSelect && <Button type="submit">Search</Button>}</div>
    </form></DialogContent></Dialog>;
}
