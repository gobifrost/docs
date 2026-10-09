import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, FileText, KeyRound, Layers, MapPin, Server } from "lucide-react";
import { BfAlert } from "@/components/bifrost/BfAlert";
import { BfButton } from "@/components/bifrost/BfButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocsOrganizations } from "@/components/layout/useDocsOrganizations";
import { trackRecentRecord, useRecentRecords } from "@/components/layout/recentRecords";
const LINKS = [
  { kind: "passwords", label: "Passwords", description: "Password metadata and source links", icon: KeyRound },
  { kind: "configurations", label: "Configurations", description: "Devices and infrastructure", icon: Server },
  { kind: "locations", label: "Locations", description: "Offices and physical locations", icon: MapPin },
  { kind: "documents", label: "Documents", description: "Runbooks and documentation", icon: FileText },
  { kind: "assets", label: "Custom Assets", description: "Structured documentation by asset type", icon: Layers },
];
export function OrgHomePage() {
  const { organizationId, selected, loading, error, retry, viewerId, viewerSettled } = useDocsOrganizations();
  useEffect(() => {
    if (viewerSettled && viewerId && !loading && selected?.id === organizationId) {
      trackRecentRecord(viewerId, { id: selected.id, kind: "organizations", name: selected.name, organizationId: selected.id });
    }
  }, [viewerId, viewerSettled, loading, organizationId, selected?.id, selected?.name]);
  const recent = useRecentRecords().filter((record) => record.kind !== "organizations" && record.organizationId === organizationId).slice(0, 8);
  if (loading) return <div className="docs-page"><Skeleton className="h-10 w-64" /><div className="grid gap-4 md:grid-cols-3">{LINKS.map((item) => <Skeleton key={item.kind} className="h-36" />)}</div></div>;
  if (error) return <div className="docs-page"><BfAlert tone="danger" title="Organization could not load">{error}<BfButton variant="secondary" onClick={retry}>Retry</BfButton></BfAlert></div>;
  if (!selected) return <div className="docs-page"><BfAlert tone="warning" title="Organization unavailable">This organization is outside your Bifrost scope or no longer exists.</BfAlert><Link to="/organizations">Browse organizations</Link></div>;
  return <div className="docs-page"><section className="page-heading"><div><h1>{selected.name}</h1><p>Manage your organization’s documentation.</p></div></section>
    <section aria-label="Recently accessed"><h2 className="mb-4 text-lg font-semibold">Recently accessed</h2>{recent.length ? <div className="flex gap-4 overflow-x-auto pb-2">{recent.map((record) => <Link key={`${record.kind}:${record.id}`} to={`/org/${organizationId}/${record.kind}/${record.id}`} className="min-w-52 max-w-72"><Card><CardContent className="pt-4"><p className="truncate font-medium">{record.name}</p><p className="text-xs text-muted-foreground">{record.kind}</p></CardContent></Card></Link>)}</div> : <p className="text-sm text-muted-foreground">Records you open in this organization will appear here.</p>}</section>
    <section aria-label="Quick Links"><h2 className="mb-4 text-lg font-semibold">Quick Links</h2><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{LINKS.map((item) => <Link key={item.kind} to={`/org/${organizationId}/${item.kind}`} className="rounded-[var(--bf-radius-surface)] outline-none focus-visible:ring-2 focus-visible:ring-primary"><Card className="h-full transition-colors hover:border-primary"><CardHeader className="pb-3"><div className="flex items-center justify-between"><div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10"><item.icon className="h-5 w-5 text-primary" /></div><ArrowRight className="h-5 w-5 text-muted-foreground" /></div></CardHeader><CardContent><CardTitle className="mb-1 text-base">{item.label}</CardTitle><p className="text-sm text-muted-foreground">{item.description}</p></CardContent></Card></Link>)}</div></section></div>;
}
