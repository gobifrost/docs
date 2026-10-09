import { useEffect, useState } from "react";

const STORAGE_KEY = "bifrost-docs-sidebar-collapsed";

function readStored(): boolean | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "1" ? true : stored === "0" ? false : null;
  } catch {
    return null;
  }
}

export function useSidebarCollapse(autoCollapse = false) {
  const [preference, setPreference] = useState(readStored);
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState<boolean | null>(null);
  useEffect(() => { if (!autoCollapse) setWorkspaceCollapsed(null); }, [autoCollapse]);
  useEffect(() => {
    if (preference === null) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, preference ? "1" : "0");
    } catch {
      /* persistence is best-effort */
    }
  }, [preference]);
  return {
    isCollapsed: autoCollapse ? workspaceCollapsed ?? true : preference ?? false,
    toggle: () => {
      if (autoCollapse) setWorkspaceCollapsed((value) => !(value ?? true));
      else setPreference((value) => !(value ?? false));
    },
  };
}
