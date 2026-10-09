import { useMemo } from "react";
import { useDocsOrganizations } from "./useDocsOrganizations";

/** Organization id → display name from the trusted Docs organization directory. */
export function useOrgNameMap() {
  const { organizations, loading } = useDocsOrganizations();
  return useMemo(() => {
    if (loading) return {};
    return Object.fromEntries(organizations.map((organization) => [organization.id, organization.name]));
  }, [organizations, loading]);
}
