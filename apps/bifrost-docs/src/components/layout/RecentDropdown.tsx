import { Link } from "react-router-dom";
import { FileText, History, KeyRound, Layers, MapPin, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useRecentRecords } from "./recentRecords";
import { useDocsOrganizations } from "./useDocsOrganizations";

const KIND_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  documents: FileText,
  passwords: KeyRound,
  configurations: Server,
  locations: MapPin,
  "flexible-assets": Layers,
};

const KIND_ROUTES: Record<string, string> = {
  documents: "documents",
  passwords: "passwords",
  configurations: "configurations",
  locations: "locations",
  "flexible-assets": "flexible-assets",
  "flexible-asset-types": "flexible-asset-types",
  "document-folders": "document-folders",
  "password-folders": "password-folders",
};

export function RecentDropdown({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const { organizationId, organizations } = useDocsOrganizations();
  const recent = useRecentRecords().filter((item) => KIND_ROUTES[item.kind]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" className="docs-shell__rail-control" title="Recently viewed" aria-label="Recently viewed">
          <History aria-hidden="true" />
          {!collapsed && <span>Recently viewed</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="end">
        <p className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recently viewed</p>
        {recent.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No recently viewed records.</p>}
        {recent.map((item) => {
          const Icon = KIND_ICONS[item.kind] ?? FileText;
          const organizationName = organizations.find((organization) => organization.id === item.organizationId)?.name;
          return (
            <Link
              key={`${item.kind}:${item.id}`}
              to={`/org/${encodeURIComponent(item.organizationId)}/${KIND_ROUTES[item.kind]}/${item.id}`}
              onClick={onNavigate}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent"
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1"><span className="block truncate">{item.name}</span>{!organizationId && organizationName && <span className="block truncate text-xs text-muted-foreground">{organizationName}</span>}</span>
            </Link>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
