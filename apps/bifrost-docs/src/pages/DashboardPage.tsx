import { Link } from "react-router-dom";
import { Building2, FileText, KeyRound, Layers, MapPin, Server, type LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useDocsOrganizations } from "@/components/layout/useDocsOrganizations";
import { useRecentRecords, type RecentRecord } from "@/components/layout/recentRecords";

const RECORD_TYPES: Record<string, { icon: LucideIcon; label: string; route: string }> = {
  documents: { icon: FileText, label: "Document", route: "documents" },
  passwords: { icon: KeyRound, label: "Password", route: "passwords" },
  configurations: { icon: Server, label: "Configuration", route: "configurations" },
  locations: { icon: MapPin, label: "Location", route: "locations" },
  "flexible-assets": { icon: Layers, label: "Asset", route: "assets" },
};

function RecentCard({ record, organizationName }: { record: RecentRecord; organizationName?: string }) {
  const config = record.kind === "organizations"
    ? { icon: Building2, label: "Organization", route: "" }
    : RECORD_TYPES[record.kind];
  if (!config) return null;
  const Icon = config.icon;
  const to = record.kind === "organizations"
    ? `/org/${encodeURIComponent(record.id)}`
    : `/org/${encodeURIComponent(record.organizationId)}/${config.route}/${encodeURIComponent(record.id)}`;

  return (
    <Link to={to} className="min-w-[180px] no-underline outline-none focus-visible:ring-2 focus-visible:ring-[var(--bf-primary)]">
      <Card className="h-full min-w-[180px] transition-colors hover:border-[var(--bf-primary)]">
        <CardContent className="flex items-center gap-3 pt-[var(--card-spacing)]">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--bf-radius-control)] bg-[color-mix(in_srgb,var(--bf-primary)_10%,transparent)] text-[var(--bf-primary)]"><Icon className="h-4 w-4" aria-hidden="true" /></span>
          <span className="min-w-0"><span className="block truncate text-sm font-medium text-[var(--bf-ink)]">{record.name}</span><span className="block truncate text-xs text-[var(--bf-muted)]">{record.kind === "organizations" ? config.label : organizationName ?? config.label}</span></span>
        </CardContent>
      </Card>
    </Link>
  );
}

export function DashboardPage() {
  const { organizations } = useDocsOrganizations();
  const recent = useRecentRecords();
  const organizationNames = new Map(organizations.map((organization) => [organization.id, organization.name]));
  const recentOrganizations = recent.filter((record) => record.kind === "organizations").slice(0, 6);
  const recentItems = recent.filter((record) => record.kind !== "organizations" && RECORD_TYPES[record.kind]).slice(0, 6);

  return (
    <div className="docs-page">
      <section className="page-heading"><div><h1>Dashboard</h1><p>Welcome to Bifrost Docs.</p></div></section>
      {recentOrganizations.length > 0 && <section aria-label="Recent organizations"><h2 className="mb-4 text-lg font-semibold">Recent Organizations</h2><div className="flex gap-4 overflow-x-auto pb-2">{recentOrganizations.map((record) => <RecentCard key={`${record.kind}:${record.id}`} record={record} />)}</div></section>}
      {recentItems.length > 0 && <section aria-label="Recent items"><h2 className="mb-4 text-lg font-semibold">Recent Items</h2><div className="flex gap-4 overflow-x-auto pb-2">{recentItems.map((record) => <RecentCard key={`${record.kind}:${record.id}`} record={record} organizationName={organizationNames.get(record.organizationId)} />)}</div></section>}
      <section className="text-[var(--bf-muted)]"><p>Select an organization from the header to get started, or <Link to="/organizations" className="inline-flex min-h-6 items-center font-medium text-[var(--bf-primary)] underline underline-offset-3">Browse organizations</Link>.</p></section>
    </div>
  );
}
