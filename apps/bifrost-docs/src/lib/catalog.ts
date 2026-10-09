export type CatalogKind =
  | "documents"
  | "passwords"
  | "configurations"
  | "locations"
  | "flexible-asset-types"
  | "flexible-assets"
  | "document-folders"
  | "password-folders";

export type CatalogEntry = {
  kind: CatalogKind;
  label: string;
  singular: string;
  table: string;
  description: string;
  searchField: string;
  searchLabel: string;
  sourceUrl?: boolean;
  folder?: boolean;
};

export const catalogEntries: CatalogEntry[] = [
  { kind: "documents", label: "Documents", singular: "Document", table: "docs-documents", description: "Runbooks, guides, and organization documentation.", searchField: "name", searchLabel: "document name", sourceUrl: true },
  { kind: "passwords", label: "Password metadata", singular: "Password metadata", table: "docs-passwords", description: "Usernames, categories, and source links. Secret values stay in the source vault.", searchField: "name", searchLabel: "record name", sourceUrl: true },
  { kind: "configurations", label: "Configurations", singular: "Configuration", table: "docs-configurations", description: "Systems and asset configuration records.", searchField: "name", searchLabel: "configuration name" },
  { kind: "locations", label: "Locations", singular: "Location", table: "docs-locations", description: "Physical and virtual location records.", searchField: "name", searchLabel: "location name" },
  { kind: "flexible-asset-types", label: "Flexible asset types", singular: "Flexible asset type", table: "docs-flexible-asset-types", description: "Custom asset types and field definitions.", searchField: "name", searchLabel: "asset type name" },
  { kind: "flexible-assets", label: "Flexible assets", singular: "Flexible asset", table: "docs-flexible-assets", description: "Structured documentation organized by asset type.", searchField: "name", searchLabel: "asset name" },
  { kind: "document-folders", label: "Document folders", singular: "Document folder", table: "docs-document-folders", description: "Folders for organizing documents.", searchField: "name", searchLabel: "folder name", folder: true },
  { kind: "password-folders", label: "Password folders", singular: "Password folder", table: "docs-password-folders", description: "Folders for organizing password metadata.", searchField: "name", searchLabel: "folder name", folder: true },
];

export function catalogEntry(kind: CatalogKind): CatalogEntry {
  const entry = catalogEntries.find((candidate) => candidate.kind === kind);
  if (!entry) throw new Error(`Unknown catalog kind: ${kind}`);
  return entry;
}

export function isCatalogKind(value: string | null): value is CatalogKind {
  return catalogEntries.some((entry) => entry.kind === value);
}

export function catalogSearchWhere(entry: CatalogEntry, term: string): Record<string, { contains: string }> | undefined {
  const normalized = term.trim();
  return normalized ? { [entry.searchField]: { contains: normalized } } : undefined;
}

/** Legacy native rows without this field are enabled; exclude only explicit false. */
export function enabledRecordWhere(): Record<string, unknown> {
  return { is_enabled: { ne: false } };
}

export function catalogEnabledWhere(kind: CatalogKind, showDisabled = false): Record<string, unknown> {
  return !showDisabled && ["configurations", "locations", "flexible-assets"].includes(kind)
    ? enabledRecordWhere()
    : {};
}

const relationshipRoutes: Record<string, CatalogKind> = {
  documents: "documents",
  document: "documents",
  passwords: "passwords",
  password: "passwords",
  configurations: "configurations",
  configuration: "configurations",
  locations: "locations",
  location: "locations",
  flexible_assets: "flexible-assets",
  flexible_asset: "flexible-assets",
  "flexible-assets": "flexible-assets",
  flexible_asset_types: "flexible-asset-types",
  flexible_asset_type: "flexible-asset-types",
  document_folders: "document-folders",
  password_folders: "password-folders",
};

export function relatedRecordEntry(type: unknown): CatalogEntry | null {
  const normalizedType = typeof type === "string" ? type.trim().toLowerCase() : "";
  const kind = relationshipRoutes[normalizedType];
  return kind ? catalogEntry(kind) : null;
}

export function relatedRecordPath(type: unknown, id: unknown): string | null {
  const entry = relatedRecordEntry(type);
  const normalizedId = typeof id === "string" ? id.trim() : "";
  return entry && normalizedId ? `/${entry.kind}/${encodeURIComponent(normalizedId)}` : null;
}
