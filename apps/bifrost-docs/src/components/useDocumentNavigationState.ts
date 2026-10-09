import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";

export function documentNavigationScope(organizationId: string, viewerId?: string | null) {
  return JSON.stringify([viewerId ?? null, organizationId]);
}

type NavigationChoices = { scope: string; filter: string; collapsed: Set<string>; revealedSelection: string };
const initialChoices = (scope: string): NavigationChoices => ({ scope, filter: "", collapsed: new Set(), revealedSelection: "" });

/** Keep navigation choices above temporary drawers, isolated to the current caller and organization. */
export function useDocumentNavigationState(organizationId: string, viewerId?: string | null) {
  const scope = documentNavigationScope(organizationId, viewerId);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const defaults = useMemo(() => initialChoices(scope), [scope]);
  const [stored, setStored] = useState(() => initialChoices(scope));
  const choices = stored.scope === scope ? stored : defaults;
  useEffect(() => { setStored(previous => previous.scope === scope ? previous : initialChoices(scope)); }, [scope]);
  const update = useCallback((change: (previous: NavigationChoices) => NavigationChoices) => {
    setStored(previous => {
      if (currentScope.current !== scope) return previous;
      return change(previous.scope === scope ? previous : initialChoices(scope));
    });
  }, [scope]);
  const setFilter = useCallback((value: SetStateAction<string>) => update(previous => ({ ...previous, filter: typeof value === "function" ? value(previous.filter) : value })), [update]);
  const setCollapsed = useCallback((value: SetStateAction<Set<string>>) => update(previous => ({ ...previous, collapsed: typeof value === "function" ? value(previous.collapsed) : value })), [update]);
  const revealSelection = useCallback((selection: string, ancestors: Set<string>) => update(previous => {
    if (previous.revealedSelection === selection) return previous;
    return { ...previous, revealedSelection: selection, collapsed: new Set([...previous.collapsed].filter(id => !ancestors.has(id))) };
  }), [update]);
  return { filter: choices.filter, setFilter, collapsed: choices.collapsed, setCollapsed, revealSelection };
}

export type DocumentNavigationState = ReturnType<typeof useDocumentNavigationState>;
