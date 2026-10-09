import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronsUpDown, Globe } from "lucide-react";
import { cn } from "@/lib/ds-utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDocsOrganizations } from "./useDocsOrganizations";

export function OrgSelector() {
  const navigate = useNavigate();
  const { organizations, organizationId, selected, setOrganizationId, loading, mode, error, retry } = useDocsOrganizations();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const matches = organizations.filter((org) =>
    org.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className="docs-shell__org-trigger" disabled={loading}>
          <span className="truncate">{selected ? selected.name : organizationId ? "Organization" : "Global View"}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="docs-shell__org-popover p-2" align="end">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search organizations..."
          aria-label="Search organizations"
          className="mb-2 h-9 w-full rounded-[var(--bf-radius-control)] border border-[var(--bf-line)] bg-[var(--bf-paper)] px-3 text-sm outline-none placeholder:text-[var(--bf-muted)] focus:border-[var(--bf-primary)]"
        />
        <div className="max-h-64 overflow-y-auto" role="listbox">
          {mode.kind !== "fixed" && <button
            type="button"
            role="option"
            aria-selected={!organizationId}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              !organizationId ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent",
            )}
            onClick={() => {
              setOrganizationId("");
              setOpen(false);
              navigate("/global");
            }}
          >
            <Globe className="h-4 w-4 shrink-0" />
            <span className="truncate">Global View</span>
            {!organizationId && <Check className="ml-auto h-4 w-4 shrink-0" />}
          </button>}
          {error && <div role="alert" className="p-2 text-sm">{error}<Button variant="outline" onClick={retry}>Retry</Button></div>}
          {matches.map((org) => (
            <button
              key={org.id}
              type="button"
              role="option"
              aria-selected={org.id === organizationId}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                org.id === organizationId ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent",
              )}
              onClick={() => {
                setOrganizationId(org.id);
                setOpen(false);
                navigate(`/org/${org.id}`);
              }}
            >
              <span className="truncate">{org.name}</span>
              {org.id === organizationId && <Check className="ml-auto h-4 w-4 shrink-0" />}
            </button>
          ))}
          {matches.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">No organizations match.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
