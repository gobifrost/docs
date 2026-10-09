import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BfAlert } from "@/components/bifrost/BfAlert";
import { BfButton } from "@/components/bifrost/BfButton";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocsOrganizations } from "@/components/layout/useDocsOrganizations";

/** Read-only organization directory. Management stays in Bifrost. */
export function OrganizationsPage() {
  const navigate = useNavigate();
  const { organizations, setOrganizationId, loading, error, retry } = useDocsOrganizations();
  const [search, setSearch] = useState("");

  const matches = organizations.filter((org) =>
    org.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <div className="docs-page">
      <section className="page-heading">
        <div>
          <p className="section-kicker">Directory</p>
          <h1>Organizations</h1>
          <p>Browse documentation for your organizations.</p>
        </div>
      </section>
      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search organizations..."
        aria-label="Search organizations"
        className="max-w-md"
      />
      {error ? <BfAlert tone="danger" title="Organizations could not load">{error}<BfButton variant="secondary" onClick={retry}>Retry</BfButton></BfAlert> : loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading organizations">
          {[0, 1, 2, 3, 4, 5].map((key) => (
            <Skeleton key={key} className="h-24 w-full" />
          ))}
        </div>
      ) : matches.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {organizations.length === 0
            ? "Your Bifrost scope covers everything visible to your account."
            : "No organizations match."}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {matches.map((org) => (
            <button
              key={org.id}
              type="button"
              onClick={() => {
                setOrganizationId(org.id);
                navigate(`/org/${org.id}`);
              }}
              className="rounded-[var(--bf-radius-surface)] text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--bf-primary)]"
            >
              <Card className="transition-colors hover:border-[var(--bf-primary)]">
                <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-2">
                  <Building2 className="h-5 w-5 text-[var(--bf-primary)]" aria-hidden="true" />
                  <CardTitle className="truncate text-base">{org.name}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">Open documentation</p>
                </CardContent>
              </Card>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
