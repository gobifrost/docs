export type OrganizationTargetMode =
  | { kind: "fixed"; organizationId: string }
  | { kind: "picker" };

export function organizationTargetMode(orgScope: string | null | undefined): OrganizationTargetMode {
  const organizationId = String(orgScope ?? "").trim();
  return organizationId ? { kind: "fixed", organizationId } : { kind: "picker" };
}
