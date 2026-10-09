import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import {
  FileText,
  History,
  Home,
  KeyRound,
  Layers,
  MapPin,
  PanelLeft,
  PanelLeftClose,
  Search,
  Server,
  X,
} from "lucide-react";
import { tables } from "bifrost";
import { cn } from "@/lib/ds-utils";
import { enabledRecordWhere, isCatalogKind } from "@/lib/catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { BfAlert } from "@/components/bifrost/BfAlert";
import { BfButton } from "@/components/bifrost/BfButton";
import { loadTableCountsSnapshot, type TableQuery } from "@/lib/table-query";
import { loadGlobalAssetTypeGroups } from "@/lib/global-asset-types";
import { useTableInvalidations } from "@/lib/table-realtime";
import { useDocsOrganizations } from "./useDocsOrganizations";
import { useSidebarCollapse } from "./useSidebarCollapse";
import { BifrostSignature } from "./BifrostSignature";
import { RecentDropdown } from "./RecentDropdown";
import { ChevronDown } from "lucide-react";

type SidebarCounts = Record<string, number>;

const CORE_TABLES: Array<{ kind: string; table: string }> = [
  { kind: "passwords", table: "docs-passwords" },
  { kind: "locations", table: "docs-locations" },
  { kind: "documents", table: "docs-documents" },
  { kind: "configurations", table: "docs-configurations" },
];

function useCoreCounts(organizationId: string) {
  const [counts, setCounts] = useState<SidebarCounts>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [tableIds, setTableIds] = useState<string[]>([]);
  const [tableScope, setTableScope] = useState("");
  const [snapshotScope, setSnapshotScope] = useState("");
  const scope = `core-counts:${organizationId}`;
  useEffect(() => { setCounts({}); setTableIds([]); setTableScope(""); setSnapshotScope(""); setLoading(true); setError(""); }, [scope]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    loadTableCountsSnapshot(
      tables.query as TableQuery,
      CORE_TABLES.map(({ kind, table }) => ({ key: kind, table })),
      { ...enabledRecordWhere(), ...(organizationId ? { organization_id: organizationId } : {}) },
      { isCurrent: () => active },
    )
      .then((next) => { if (active) { setCounts(next.counts); setTableIds(next.tableIds); setTableScope(scope); setSnapshotScope(scope); setLoading(false); } })
      .catch((failure: unknown) => { if (active) { setCounts({}); setTableIds([]); setTableScope(""); setSnapshotScope(""); setError(failure instanceof Error ? failure.message : String(failure)); setLoading(false); } });
    return () => {
      active = false;
    };
  }, [organizationId, refresh, scope]);
  useTableInvalidations(tableScope === scope ? tableIds : [], organizationId || null, () => setRefresh((value) => value + 1), () => { setCounts({}); setTableIds([]); setTableScope(""); setSnapshotScope(""); setLoading(false); setError(""); });
  return { counts, loading, error, hasSnapshot: snapshotScope === scope, retry: () => setRefresh((value) => value + 1) };
}

function useAssetTypes(organizationId: string) {
  const [types, setTypes] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [tableIds, setTableIds] = useState<string[]>([]);
  const [tableScope, setTableScope] = useState("");
  const [snapshotScope, setSnapshotScope] = useState("");
  const scope = `asset-types:${organizationId}`;
  useEffect(() => { setTypes([]); setTableIds([]); setTableScope(""); setSnapshotScope(""); setLoading(true); setError(""); }, [scope]);
  useEffect(() => {
    let active = true;
    let tableId: string | null = null;
    setLoading(true); setError("");
    loadGlobalAssetTypeGroups(tables.query as TableQuery, organizationId, {
      isCurrent: () => active,
      onTableResolved: (id) => { tableId = id; },
    }).then((groups) => {
      if (!active || groups === null) return;
      setTableIds(tableId ? [tableId] : []);
      setTableScope(scope);
      setSnapshotScope(scope);
      setTypes(groups.map((group) => ({ id: group.id, name: group.name })));
      setLoading(false);
    }).catch((failure: unknown) => {
      if (active) { setTypes([]); setTableIds([]); setTableScope(""); setSnapshotScope(""); setError(failure instanceof Error ? failure.message : String(failure)); setLoading(false); }
    });
    return () => { active = false; };
  }, [organizationId, refresh, scope]);
  useTableInvalidations(tableScope === scope ? tableIds : [], organizationId || null, () => setRefresh((value) => value + 1), () => { setTypes([]); setTableIds([]); setTableScope(""); setSnapshotScope(""); setLoading(false); setError(""); });
  return { types, loading, error, hasSnapshot: snapshotScope === scope, retry: () => setRefresh((value) => value + 1) };
}

function NavItem({
  name,
  href,
  icon: Icon,
  count,
  onClick,
  isCollapsed,
  isCurrent,
}: {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  count?: number;
  onClick?: () => void;
  isCollapsed?: boolean;
  isCurrent?: boolean;
}) {
  const { pathname, search } = useLocation();
  const active = isCurrent ?? (href.includes("?") ? `${pathname}${search}` === href : pathname === href || (href !== "/" && !/^\/org\/[^/]+$/.test(href) && pathname.startsWith(`${href}/`)));
  const linkContent = (
    <Link
      to={href}
      data-sidebar-nav-item
      data-active={active || undefined}
      aria-current={active ? "page" : undefined}
      aria-label={name}
      onClick={onClick}
      className={cn(
        "flex items-center rounded-md text-sm font-medium transition-colors",
        isCollapsed ? "justify-center px-2 py-2" : "justify-between gap-3 px-3 py-2",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
    >
      <span className={cn("flex items-center", isCollapsed ? "" : "gap-3")}>
        <Icon className="h-4 w-4" />
        {!isCollapsed && <span>{name}</span>}
      </span>
      {!isCollapsed && count !== undefined && (
        <Badge variant="secondary" className="tabular-nums" title={`${count.toLocaleString()} enabled records`}>
          {count.toLocaleString()}
        </Badge>
      )}
    </Link>
  );

  if (!isCollapsed) return linkContent;
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <span className="flex items-center gap-2">
          <span>{name}</span>
          {count !== undefined && (
            <Badge variant="secondary" className="tabular-nums text-xs">
              {count.toLocaleString()} enabled
            </Badge>
          )}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

function NavSection({
  title,
  children,
  isCollapsed,
}: {
  title: string;
  children: React.ReactNode;
  isCollapsed?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(true);
  if (isCollapsed) return <div className="space-y-0.5">{children}</div>;
  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger data-sidebar-section className="flex items-center justify-between w-full text-xs font-semibold uppercase hover:text-sidebar-foreground transition-colors">
        <span>{title}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", isOpen ? "rotate-0" : "-rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-0.5 mt-1">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function SidebarSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-9 w-full rounded-md" />
      <div className="space-y-2">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-9 w-full rounded-md" />
      </div>
    </div>
  );
}

export function Sidebar({
  isMobileMenuOpen,
  setIsMobileMenuOpen,
  isAdmin,
  onSearchClick,
}: {
  isMobileMenuOpen: boolean;
  setIsMobileMenuOpen: (open: boolean) => void;
  isAdmin: boolean;
  onSearchClick: () => void;
}) {
  const { organizationId } = useDocsOrganizations();
  const { pathname, search } = useLocation();
  const catalogKind = new URLSearchParams(search).get("type");
  const documentCatalog = /^(?:\/org\/[^/]+)?\/browse$/.test(pathname) && (!isCatalogKind(catalogKind) || catalogKind === "documents");
  const documentWorkspace = Boolean(organizationId) && (documentCatalog || /^(?:\/org\/[^/]+)?\/documents(?:\/|$)/.test(pathname));
  const { isCollapsed: desktopCollapsed, toggle } = useSidebarCollapse(documentWorkspace);
  const [isMobile, setIsMobile] = useState(() => typeof window.matchMedia === "function" ? !window.matchMedia("(min-width: 1024px)").matches : false);
  const isCollapsed = desktopCollapsed && !isMobile;
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(min-width: 1024px)");
    const update = () => { setIsMobile(!media.matches); if (media.matches) setIsMobileMenuOpen(false); };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [setIsMobileMenuOpen]);
  const href = (kind: string) => organizationId ? `/org/${organizationId}/${kind === "flexible-assets" ? "assets" : kind}` : `/global/${kind}`;
  const { counts, hasSnapshot: hasCountsSnapshot, error: countsError, retry: retryCounts } = useCoreCounts(organizationId);
  const { types, hasSnapshot: hasTypesSnapshot, error: typesError, retry: retryTypes } = useAssetTypes(organizationId);
  const closeMobileMenu = () => setIsMobileMenuOpen(false);
  const loading = (!hasCountsSnapshot && !countsError) || (!hasTypesSnapshot && !typesError);

  const navigation = (
      <aside
        className={cn(
          "docs-shell__sidebar",
          isMobile
            ? "docs-shell__sidebar--dialog"
            : undefined,
        )}
        data-collapsed={isCollapsed || undefined}
      >
        <div className="docs-shell__rail-top">
          <NavLink to="/" className="docs-shell__rail-brand" aria-label="Bifrost Docs home" onClick={closeMobileMenu}>
            <BifrostSignature product="Docs" />
          </NavLink>
          <div className="docs-shell__rail-controls" aria-label="Catalog tools">
            <Button variant="ghost" className="docs-shell__rail-control" onClick={() => { closeMobileMenu(); onSearchClick(); }} aria-label="Search catalog">
              <Search aria-hidden="true" />
              {!isCollapsed && <span>Search catalog</span>}
            </Button>
            <RecentDropdown collapsed={isCollapsed} onNavigate={closeMobileMenu} />
          </div>
        </div>
        <div className="docs-shell__rail-actions">
          <Button variant="ghost" size="icon" className="docs-shell__rail-close lg:hidden" onClick={closeMobileMenu} aria-label="Close navigation">
            <X className="h-5 w-5" />
          </Button>
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="docs-shell__rail-toggle hidden lg:flex" onClick={toggle} aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!isCollapsed}>
                {isCollapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>{isCollapsed ? "Expand sidebar" : "Collapse sidebar"}</TooltipContent>
          </Tooltip>
        </div>
        <nav className="docs-shell__sidebar-nav" aria-label="Documentation navigation">
          {loading ? (
            <SidebarSkeleton />
          ) : (
            <div className="space-y-6">
              {countsError && <BfAlert tone="danger" title="Navigation counts could not load">{countsError}<div className="mt-2"><BfButton variant="secondary" onClick={retryCounts}>Retry</BfButton></div></BfAlert>}
              <NavItem name="Home" href={organizationId ? `/org/${organizationId}` : "/"} icon={Home} onClick={closeMobileMenu} isCollapsed={isCollapsed} />
              <NavSection title="Core" isCollapsed={isCollapsed}>
                <NavItem name="Passwords" href={href("passwords")} icon={KeyRound} count={counts.passwords} onClick={closeMobileMenu} isCollapsed={isCollapsed} />
                <NavItem name="Locations" href={href("locations")} icon={MapPin} count={counts.locations} onClick={closeMobileMenu} isCollapsed={isCollapsed} />
                <NavItem name="Documents" href={href("documents")} icon={FileText} count={counts.documents} onClick={closeMobileMenu} isCollapsed={isCollapsed} isCurrent={documentCatalog || undefined} />
                <NavItem name="Configurations" href={href("configurations")} icon={Server} count={counts.configurations} onClick={closeMobileMenu} isCollapsed={isCollapsed} />
                <NavItem name="Audit Trail" href={organizationId ? `/org/${organizationId}/audit-trail` : "/global/audit-trail"} icon={History} onClick={closeMobileMenu} isCollapsed={isCollapsed} />
              </NavSection>
              {isAdmin && (
                <NavSection title="Administration" isCollapsed={isCollapsed}>
                  <NavItem name="Data operations" href="/migration" icon={History} onClick={closeMobileMenu} isCollapsed={isCollapsed} />
                  <NavItem name="Configuration taxonomy" href="/configuration-taxonomy" icon={Server} onClick={closeMobileMenu} isCollapsed={isCollapsed} />
                  <NavItem name="Settings" href="/settings" icon={Layers} onClick={closeMobileMenu} isCollapsed={isCollapsed} />
                </NavSection>
              )}
              <NavSection title="Custom Assets" isCollapsed={isCollapsed}>
                {typesError ? (
                  !isCollapsed && <BfAlert tone="danger" title="Custom asset types could not load">{typesError}<div className="mt-2"><BfButton variant="secondary" onClick={retryTypes}>Retry</BfButton></div></BfAlert>
                ) : types.length === 0 ? (
                  !isCollapsed && <div className="px-3 py-2 text-sm text-muted-foreground">No custom asset types</div>
                ) : (
                  types.map((item) => (
                    <NavItem key={item.id} name={item.name} href={organizationId ? `/org/${organizationId}/assets/${item.id}` : `/global/assets/${item.id}`} icon={Layers} onClick={closeMobileMenu} isCollapsed={isCollapsed} />
                  ))
                )}
              </NavSection>
            </div>
          )}
        </nav>
      </aside>
  );
  if (isMobile) return <TooltipProvider><Dialog open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}><DialogContent showCloseButton={false} aria-describedby={undefined} className="left-0 top-0 h-full max-h-none w-64 max-w-[calc(100vw-3rem)] translate-x-0 translate-y-0 gap-0 p-0"><DialogTitle className="sr-only">Documentation navigation</DialogTitle>{navigation}</DialogContent></Dialog></TooltipProvider>;
  return <TooltipProvider>{navigation}</TooltipProvider>;
}
