import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { FolderTree, X } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "./ui/dialog";
import { DocumentSidebar } from "./DocumentSidebar";
import { useDocsOrganizations } from "./layout/useDocsOrganizations";
import { useDocumentNavigationState } from "./useDocumentNavigationState";
import "./DocumentWorkspace.css";

const WIDTH_KEY = "bifrost-docs-document-pane-width";
const clampWidth = (width: number) => Math.min(480, Math.max(180, width));

export function DocumentWorkspace({ children, canWrite, enabled = true, selectedFolderId = null, onSelect }: {
  children: ReactNode;
  canWrite: boolean;
  enabled?: boolean;
  selectedFolderId?: string | null;
  onSelect?: (folderId: string | null) => void;
}) {
  const { organizationId, viewerId } = useDocsOrganizations();
  const navigationState = useDocumentNavigationState(organizationId, viewerId);
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.innerWidth < 1024);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [width, setWidth] = useState(() => {
    try { const stored = Number(localStorage.getItem(WIDTH_KEY)); return stored ? clampWidth(stored) : 256; }
    catch { return 256; }
  });
  const drag = useRef<{ start: number; width: number } | null>(null);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(min-width: 1024px)");
    const sync = () => { setCompact(!media.matches); setDrawerOpen(false); };
    sync(); media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => { setDrawerOpen(false); }, [organizationId, viewerId, pathname, search, enabled]);
  useEffect(() => { try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* optional layout preference */ } }, [width]);

  const hasNavigation = enabled && Boolean(organizationId);
  function chooseFolder(folderId: string | null) {
    if (onSelect) onSelect(folderId);
    else navigate(`/org/${encodeURIComponent(organizationId)}/documents${folderId ? `?folder=${encodeURIComponent(folderId)}` : ""}`);
    setDrawerOpen(false);
  }
  const folders = <DocumentSidebar canWrite={canWrite} selectedFolderId={selectedFolderId} onSelect={chooseFolder} onNavigate={() => setDrawerOpen(false)} state={navigationState} />;
  return <div className={`document-workspace${hasNavigation && !compact ? " has-navigation" : ""}`} style={{ "--docs-document-pane-width": `${width}px` } as React.CSSProperties}>
    {hasNavigation && (compact ? <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
      <DialogTrigger asChild><Button variant="ghost" className="document-workspace__browse"><FolderTree size={16} aria-hidden="true" />Browse folders</Button></DialogTrigger>
      <DialogContent showCloseButton={false} aria-describedby={undefined} className="document-workspace__drawer left-0 top-0 translate-x-0 translate-y-0">
        <header className="document-workspace__drawer-header"><DialogTitle>Document folders</DialogTitle><DialogClose asChild><Button variant="ghost" size="icon" aria-label="Close folders"><X size={18} aria-hidden="true" /></Button></DialogClose></header>
        {folders}
      </DialogContent>
    </Dialog> : <div className="document-workspace__navigation">{folders}</div>)}
    {hasNavigation && !compact && <div className="document-workspace__resize" role="separator" aria-label="Resize document navigation" aria-orientation="vertical" aria-valuemin={180} aria-valuemax={480} aria-valuenow={width} tabIndex={0}
      onKeyDown={event => {
        const next = event.key === "ArrowLeft" ? width - 20 : event.key === "ArrowRight" ? width + 20 : event.key === "Home" ? 180 : event.key === "End" ? 480 : null;
        if (next !== null) { event.preventDefault(); setWidth(clampWidth(next)); }
      }}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = {start: event.clientX, width}; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (drag.current) setWidth(clampWidth(drag.current.width + event.clientX - drag.current.start)); }}
      onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onLostPointerCapture={() => { drag.current = null; }}
    />}
    <div className="document-workspace__content">{children}</div>
  </div>;
}
