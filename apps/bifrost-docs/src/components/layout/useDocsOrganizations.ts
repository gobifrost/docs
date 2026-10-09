import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBifrostContext, useWorkflowMutation } from "bifrost";
import { useLocation } from "react-router-dom";
import { organizationTargetMode } from "@/lib/organization-target";

export type DocsOrganization = { id: string; name: string };
export type DocsOrganizationViewer = { id?: string; is_superuser?: boolean; organization_id?: string | null };
type DirectoryMode = "fixed" | "picker" | "missing";
type DocsOrganizationDirectory = { caller_mode: DirectoryMode; own_organization_id: string | null; organizations: DocsOrganization[] };
const STORAGE_KEY = "bifrost-docs-org";
const DIRECTORY_WORKFLOW = "functions/catalog.py::docs_list_organizations";
function readStored(): string {
  try { return window.localStorage.getItem(STORAGE_KEY) ?? ""; } catch { return ""; }
}
function normalizeDirectory(value: unknown): DocsOrganizationDirectory {
  if (!value || typeof value !== "object") throw new Error("Unable to load organization scope.");
  const record = value as Record<string, unknown>;
  const callerMode = record.caller_mode;
  if (callerMode !== "fixed" && callerMode !== "picker" && callerMode !== "missing") throw new Error("Unable to load organization scope.");
  const ownOrganizationId = typeof record.own_organization_id === "string" && record.own_organization_id ? record.own_organization_id : null;
  const organizations = Array.isArray(record.organizations) ? record.organizations.flatMap((item): DocsOrganization[] => {
    if (!item || typeof item !== "object") return [];
    const organization = item as Record<string, unknown>;
    if (typeof organization.id !== "string" || !organization.id) return [];
    return [{ id: organization.id, name: typeof organization.name === "string" && organization.name ? organization.name : organization.id }];
  }) : [];
  if (callerMode === "fixed") {
    if (!ownOrganizationId) throw new Error("Your Bifrost account has no assigned organization.");
    const ownOrganization = organizations.find((organization) => organization.id === ownOrganizationId);
    return { caller_mode: callerMode, own_organization_id: ownOrganizationId, organizations: [ownOrganization ?? { id: ownOrganizationId, name: ownOrganizationId }] };
  }
  return { caller_mode: callerMode, own_organization_id: ownOrganizationId, organizations: callerMode === "missing" ? [] : organizations };
}
function useOrganizationState(viewer?: DocsOrganizationViewer | null) {
  const { orgScope } = useBifrostContext();
  const { pathname } = useLocation();
  const hostScope = String(orgScope ?? "").trim();
  const awaitingViewer = viewer === null;
  const directoryWorkflow = useWorkflowMutation<DocsOrganizationDirectory>(DIRECTORY_WORKFLOW);
  const directoryMutationRef = useRef(directoryWorkflow.mutate);
  directoryMutationRef.current = directoryWorkflow.mutate;
  const requestRef = useRef(0);
  const [directory, setDirectory] = useState<DocsOrganizationDirectory | null>(null);
  const [selection, setSelection] = useState(readStored);
  const [loading, setLoading] = useState(() => !hostScope);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const request = ++requestRef.current;
    if (awaitingViewer) {
      setDirectory(null);
      setLoading(awaitingViewer);
      setError("");
      return;
    }
    if (hostScope) {
      setDirectory(null);
      setLoading(false);
      setError("");
      return;
    }
    let active = true;
    setDirectory(null); setLoading(true); setError("");
    Promise.resolve().then(() => directoryMutationRef.current({})).then((response) => {
      if (!active || request !== requestRef.current) return;
      const resolved = normalizeDirectory(response);
      setDirectory(resolved);
      setSelection((current) => current && resolved.organizations.some((org) => org.id === current) ? current : "");
      if (resolved.caller_mode === "missing") setError("Your Bifrost account has no assigned organization.");
      setLoading(false);
    }).catch((loadError: unknown) => {
      if (active && request === requestRef.current) { setError(loadError instanceof Error ? loadError.message : String(loadError)); setLoading(false); }
    });
    return () => { active = false; };
  }, [hostScope, attempt, awaitingViewer]);
  const fixedId = hostScope || (directory?.caller_mode === "fixed" ? directory.own_organization_id ?? "" : "");
  const mode = organizationTargetMode(fixedId);
  const canPick = !fixedId && directory?.caller_mode === "picker";
  const routeId = /^\/org\/([^/]+)/.exec(pathname)?.[1];
  const organizationId = fixedId || (canPick ? (routeId ? decodeURIComponent(routeId) : pathname.startsWith("/global") ? "" : selection) : "");
  const availableOrganizations = useMemo(
    () => hostScope ? [{ id: hostScope, name: "Your organization" }] : directory?.organizations ?? [],
    [hostScope, directory],
  );
  const setOrganizationId = useCallback((id: string) => {
    if (fixedId || !canPick) return;
    setSelection(id);
    try { if (id) window.localStorage.setItem(STORAGE_KEY, id); else window.localStorage.removeItem(STORAGE_KEY); } catch { /* best effort */ }
  }, [fixedId, canPick]);
  const selected = availableOrganizations.find((org) => org.id === organizationId) ?? null;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const viewerId = typeof viewer?.id === "string" && viewer.id ? viewer.id : null;
  const viewerSettled = viewer !== null && viewer !== undefined;
  return useMemo(() => ({ mode, organizations: availableOrganizations, organizationId, selected, setOrganizationId, loading, error, retry, viewerId, viewerSettled }), [mode, availableOrganizations, organizationId, selected, setOrganizationId, loading, error, retry, viewerId, viewerSettled]);
}
type OrganizationState = ReturnType<typeof useOrganizationState>;
const OrganizationContext = createContext<OrganizationState | null>(null);
export function DocsOrganizationsProvider({ children, viewer }: { children: ReactNode; viewer?: DocsOrganizationViewer | null }) {
  const state = useOrganizationState(viewer);
  return createElement(OrganizationContext.Provider, { value: state }, children);
}
export function useDocsOrganizations(): OrganizationState {
  const state = useContext(OrganizationContext);
  if (!state) throw new Error("Docs organization selection requires DocsOrganizationsProvider.");
  return state;
}
