import { useEffect, useState } from "react";
import { tables } from "bifrost";
import { Bot, ChevronDown, User, Workflow } from "lucide-react";
import { BfAlert } from "@/components/bifrost/BfAlert";
import { useDocsOrganizations } from "@/components/layout/useDocsOrganizations";
import { CatalogToolbar } from "@/components/CatalogToolbar";
import { BfButton } from "@/components/bifrost/BfButton";
import { BfChip } from "@/components/bifrost/BfChip";
import { BfDataTable, type BfDataColumn } from "@/components/bifrost/BfDataTable";
import { useTableInvalidation } from "@/lib/table-realtime";
import { useOrgNameMap } from "@/components/layout/useOrgNameMap";
import { relatedRecordEntry } from "@/lib/catalog";

type Row = Record<string, unknown> & { id: string };

function asText(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function timeLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

const PAGE_SIZE = 50;

const eventLabels: Record<string, string> = {
  "document.draft_created": "Draft created",
  "document.draft_updated": "Draft updated",
  "document.updated": "Document updated",
  "document.published": "Document published",
  "document.archived": "Document archived",
  "document.bulk_archived": "Document archived",
  "document.deleted": "Document deleted",
  "document.moved": "Document moved",
  "document.bulk_moved": "Document moved",
  "document_folder.moved": "Folder moved",
  "attachment.registered": "Attachment added",
  "attachment.deleted": "Attachment deleted",
  "migration.organization.started": "Organization migration started",
  "migration.spec.incomplete": "Resource migration incomplete",
  "migration.source_removed": "Source record removed",
  "migration.restriction_resolution": "Access restriction review",
  "migration.restriction_resolution_failed": "Access restriction review failed",
};

function humanizeCode(value: unknown): string {
  const text = asText(value).replace(/[._-]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function eventLabel(row: Row): string {
  return eventLabels[asText(row.event_type)] ?? humanizeCode(row.event_type);
}

function eventFilter(search: string): { contains: string } | { in: string[] } {
  const query = search.trim();
  const normalized = query.toLowerCase().replace(/\s+/g, " ");
  const matches = Object.entries(eventLabels).filter(([code, label]) => label.toLowerCase().includes(normalized) || humanizeCode(code).toLowerCase().includes(normalized));
  if (matches.length && !matches.some(([code]) => code.toLowerCase().includes(normalized))) return { in: matches.map(([code]) => code) };
  return { contains: query };
}

function eventTone(row: Row): "neutral" | "success" | "warning" | "danger" | "info" {
  const event = asText(row.event_type);
  if (/failed|deleted|source_removed/.test(event)) return "danger";
  if (/incomplete/.test(event)) return "warning";
  if (/created|registered|published/.test(event)) return "success";
  if (/updated|moved|started|archived|restriction_resolution/.test(event)) return "info";
  return "neutral";
}

function actorPresentation(row: Row) {
  const actor = asText(row.actor, "");
  // The platform's automated execution account: api/src/core/constants.py.
  const system = actor === "00000000-0000-0000-0000-000000000001";
  const name = asText(row.actor_display_name, asText(row.actor_name, ""));
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(actor);
  return {
    label: name || (system ? "System" : actor === "workflow" ? "Workflow" : uuid ? "User" : actor || "Unknown actor"),
    Icon: system ? Bot : actor === "workflow" ? Workflow : User,
  };
}

function organizationLabel(row: Row, names: Record<string, string>): string {
  const id = asText(row.organization_id);
  const name = names[id];
  return name && name !== id ? name : "Organization unavailable";
}

function AuditActivity({ row, organizationName }: { row: Row; organizationName?: string }) {
  const actor = actorPresentation(row);
  const summary = asText(row.summary, "");
  const normalize = (value: string) => value.replace(/[._\s-]+/g, " ").trim().toLowerCase();
  const usefulSummary = summary && normalize(summary) !== normalize(asText(row.event_type)) && normalize(summary) !== normalize(eventLabel(row));
  return <details className="audit-event">
    <summary aria-label={`Details for ${eventLabel(row)}, ${actor.label}, ${timeLabel(row.occurred_at)}${organizationName ? `, ${organizationName}` : ""}`}>
      <span className="audit-event__content">
        <BfChip tone={eventTone(row)}>{eventLabel(row)}</BfChip>
        {usefulSummary && <span className="audit-event__summary">{summary}</span>}
        <span className="audit-event__mobile-meta">{organizationName && <span>{organizationName}</span>}<span>{actor.label}</span><time dateTime={asText(row.occurred_at, "")}>{timeLabel(row.occurred_at)}</time></span>
      </span>
      <ChevronDown size={16} aria-hidden="true" />
    </summary>
    <dl className="audit-event__details">
      {[["Record type", relatedRecordEntry(row.entity_type)?.singular ?? humanizeCode(row.entity_type)], ["Event code", row.event_type], ["Record ID", row.entity_id], ["Actor ID", row.actor], ["Event ID", row.id], ["Organization ID", row.organization_id]].map(([label, value]) => <div key={asText(label)}><dt>{asText(label)}</dt><dd>{asText(value)}</dd></div>)}
    </dl>
  </details>;
}

export function AuditTrailPage({ global = false }: { global?: boolean }) {
  const { organizationId, mode, loading: scopeLoading, error: scopeError, retry: retryScope } = useDocsOrganizations();
  const organizationNames = useOrgNameMap();
  const auditReady = !scopeLoading && !scopeError;
  const scope = global && mode.kind !== "fixed" ? "" : organizationId;
  const columns: Array<BfDataColumn<Row>> = [
    { id: "event", header: "Activity", accessor: (row) => <AuditActivity row={row} organizationName={global ? organizationLabel(row, organizationNames) : undefined} />, width: global ? "40%" : "55%" },
    ...(global ? [{ id: "organization", header: "Organization", accessor: (row: Row) => organizationLabel(row, organizationNames), width: "20%", className: "audit-secondary-column" }] : []),
    { id: "actor", header: "Actor", accessor: (row) => { const { label, Icon } = actorPresentation(row); return <span className="audit-actor"><Icon size={14} aria-hidden="true" />{label}</span>; }, width: "20%", className: "audit-secondary-column" },
    { id: "when", header: "Occurred", accessor: (row) => <time dateTime={asText(row.occurred_at, "")}>{timeLabel(row.occurred_at)}</time>, width: global ? "20%" : "25%", className: "audit-secondary-column" },
  ];
  const [search, setSearch] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<{ rows: Row[]; total: number; loading: boolean; error: Error | null }>({
    rows: [],
    total: 0,
    loading: true,
    error: null,
  });
  const [tableId, setTableId] = useState<string | null>(null);
  const [tableScope, setTableScope] = useState("");
  const scopeKey = `audit:${scope}`;
  useEffect(() => {
    setTableId(null); setTableScope("");
    setState({ rows: [], total: 0, loading: true, error: null });
  }, [scopeKey]);

  useEffect(() => {
    let active = true;
    if (!auditReady) {
      setTableId(null); setTableScope("");
      setState({ rows: [], total: 0, loading: Boolean(scopeLoading), error: null });
      return () => { active = false; };
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    tables
      .query("docs-audit-events", { where: { ...(scope ? { organization_id: scope } : {}), ...(search.trim() ? { event_type: eventFilter(search) } : {}) }, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, order_by: "occurred_at", order_dir: "desc" })
      .then((result) => {
        if (!active) return;
        setTableId(typeof result.table_id === "string" ? result.table_id : null); setTableScope(scopeKey);
        const documents = Array.isArray(result.documents) ? result.documents : [];
        setState({
          rows: documents.map((doc) => ({ ...(doc.data ?? {}), id: doc.id })),
          total: Number(result.total) || 0,
          loading: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (active) { setTableId(null); setTableScope(""); setState({ rows: [], total: 0, loading: false, error: error instanceof Error ? error : new Error(String(error)) }); }
      });
    return () => {
      active = false;
    };
  }, [page, scope, search, refresh, scopeKey, auditReady, scopeLoading]);
  useTableInvalidation(auditReady && tableScope === scopeKey ? tableId : null, scope || null, () => setRefresh((value) => value + 1), () => { setTableId(null); setTableScope(""); setState({ rows: [], total: 0, loading: false, error: null }); });

  return (
    <div className="docs-page">
      <section className="page-heading">
        <div>
          <h1>{global ? "Global audit trail" : "Audit trail"}</h1>
          <p>Migration runs, documentation changes, and attachment activity.</p>
        </div>
      </section>
      <CatalogToolbar label="Filter events" value={search} onValueChange={value => { setSearch(value); setPage(1); }} placeholder="Search event types…" onRefresh={() => setRefresh(value => value + 1)} refreshing={state.loading} />
      {scopeError || state.error ? (
        <BfAlert tone="danger" title="Audit trail could not load">{scopeError || state.error?.message}<BfButton variant="secondary" onClick={() => scopeError ? retryScope() : setRefresh((value) => value + 1)}>Retry</BfButton></BfAlert>
      ) : (
        <BfDataTable
          rows={auditReady ? state.rows : []}
          columns={columns}
          getRowId={(row) => row.id}
          ariaLabel="Audit trail"
          caption={scopeLoading || (state.loading && !state.rows.length) ? "Loading audit events…" : `${state.total} ${state.total === 1 ? "event" : "events"}`}
          className="audit-table"
          loading={scopeLoading || (state.loading && !state.rows.length)}
          emptyState={search.trim() ? { title: "No matching audit events", description: "Try another event or clear the filter." } : { title: "No audit events yet", description: "Migration runs and record changes will appear here." }}
          pagination={{ page, pageSize: PAGE_SIZE, total: state.total, onPageChange: setPage }}
        />
      )}
    </div>
  );
}
