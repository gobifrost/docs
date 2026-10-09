import { useEffect, useRef, useState } from "react";
import { tables } from "bifrost";
import { catalogEntry, isCatalogKind, type CatalogKind } from "@/lib/catalog";
import { type DocsOrganization, useDocsOrganizations } from "./useDocsOrganizations";

export type RecentRecord = { id: string; kind: string; name: string; organizationId: string; visitedAt: number };

const LEGACY_STORAGE_KEY = "bifrost-docs-recent";
const STORAGE_PREFIX = "bifrost-docs-recent:";
const STORAGE_EVENT = "bifrost-docs-recent-updated";
const MAX_ITEMS = 10;
const EMPTY_ORGANIZATIONS: DocsOrganization[] = [];
type ResolvableRecentRecord = RecentRecord & { kind: CatalogKind };
type OrganizationRecentRecord = RecentRecord & { kind: "organizations" };

function storageKey(viewerId: string) { return `${STORAGE_PREFIX}${viewerId}`; }

function belongsToScope(item: RecentRecord, organizationId: string): item is ResolvableRecentRecord {
  return isCatalogKind(item.kind) && (!organizationId || item.organizationId === organizationId);
}

function isOrganizationRecent(item: RecentRecord, organizationId: string): item is OrganizationRecentRecord {
  return item.kind === "organizations" && item.id === item.organizationId && (!organizationId || item.id === organizationId);
}

function readStored(viewerId: string | null | undefined): RecentRecord[] {
  try {
    // The pre-account cache has no trustworthy owner. Remove it rather than
    // trying to infer one from a record or reusing a cached display name.
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    if (!viewerId) return [];
    const raw = window.localStorage.getItem(storageKey(viewerId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RecentRecord =>
        !!item && typeof item === "object" &&
        typeof (item as RecentRecord).id === "string" &&
        typeof (item as RecentRecord).kind === "string" &&
        typeof (item as RecentRecord).organizationId === "string" &&
        typeof (item as RecentRecord).visitedAt === "number",
    );
  } catch {
    return [];
  }
}

export function readRecentRecords(viewerId?: string | null): RecentRecord[] {
  return readStored(viewerId);
}

export function trackRecentRecord(viewerId: string | null | undefined, record: Omit<RecentRecord, "visitedAt">) {
  if (!viewerId || !record.organizationId) return;
  try {
    const next = [
      { ...record, visitedAt: Date.now() },
      ...readStored(viewerId).filter((item) => !(item.id === record.id && item.kind === record.kind && item.organizationId === record.organizationId)),
    ].slice(0, MAX_ITEMS);
    window.localStorage.setItem(storageKey(viewerId), JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(STORAGE_EVENT, { detail: viewerId }));
  } catch {
    /* persistence is best-effort */
  }
}

/** Resolve cached IDs against the active account and current organization before displaying them. */
export function useRecentRecords() {
  const organizationState = useDocsOrganizations();
  const { viewerId, viewerSettled, organizationId, loading: organizationsLoading } = organizationState;
  const organizations = organizationState.organizations ?? EMPTY_ORGANIZATIONS;
  const [records, setRecords] = useState<RecentRecord[]>([]);
  const [resolvedScope, setResolvedScope] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const requestRef = useRef(0);
  // Keep the active identity available before effects run. A resolved request can
  // otherwise publish between React rendering a new account and its old effect's
  // cleanup.
  const directoryKey = organizations.map((organization) => `${organization.id}:${organization.name}`).join("|");
  const scopeKey = `${viewerSettled ? "settled" : "pending"}:${viewerId ?? ""}:${organizationId}:${organizationsLoading ? "loading" : "ready"}:${directoryKey}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;

  useEffect(() => {
    const onStorage = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      if (detail === viewerId) setRevision((value) => value + 1);
    };
    window.addEventListener(STORAGE_EVENT, onStorage);
    return () => window.removeEventListener(STORAGE_EVENT, onStorage);
  }, [viewerId]);

  useEffect(() => {
    const request = ++requestRef.current;
    const current = () => request === requestRef.current && scopeRef.current === scopeKey;
    if (!viewerSettled || !viewerId || organizationsLoading) {
      setRecords([]);
      setResolvedScope(null);
      return;
    }
    const candidates = readStored(viewerId)
      .filter((item) => belongsToScope(item, organizationId) || isOrganizationRecent(item, organizationId))
      .slice(0, MAX_ITEMS);
    if (!candidates.length) { setRecords([]); setResolvedScope(scopeKey); return; }
    setRecords([]);
    setResolvedScope(null);
    Promise.all(candidates.map(async (item): Promise<RecentRecord | null> => {
      if (isOrganizationRecent(item, organizationId)) {
        const organization = organizations.find((candidate) => candidate.id === item.id);
        return organization ? { ...item, name: organization.name } : null;
      }
      try {
        if (!belongsToScope(item, organizationId)) return null;
        const document = await tables.get(catalogEntry(item.kind).table, item.id, item.organizationId);
        if (!document || !current() || document.data?.organization_id !== item.organizationId) return null;
        const name = typeof document.data?.name === "string" && document.data.name.trim() ? document.data.name : null;
        return name ? { ...item, name } : null;
      } catch {
        return null;
      }
    })).then((resolved) => {
      if (current()) {
        setRecords(resolved.filter((item): item is RecentRecord => item !== null));
        setResolvedScope(scopeKey);
      }
    });
    return () => { requestRef.current += 1; };
  }, [viewerId, viewerSettled, organizationId, organizations, organizationsLoading, revision, scopeKey]);

  // Never paint results from a previous account or organization while React is
  // waiting for the next effect to clear or revalidate them.
  return resolvedScope === scopeKey ? records : [];
}
