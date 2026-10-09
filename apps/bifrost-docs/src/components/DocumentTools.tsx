import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Dialog, Popover } from "radix-ui";
import { X } from "lucide-react";
import { BfButton } from "./bifrost/BfButton";

export interface DocumentTool {
  id: string;
  title: string;
  icon: ReactNode;
  content: ReactNode;
  dock?: boolean;
}

/** Keep supporting cards beside a comfortable article; use drawers when space is constrained. */
export function DocumentTools({ tools, children, leadingAction }: { tools: DocumentTool[]; children?: ReactNode; leadingAction?: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const cards = useRef(new Map<string, HTMLElement>());
  const id = useId();
  const [width, setWidth] = useState<number | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [openCards, setOpenCards] = useState(() => new Set(tools.filter(tool => tool.dock).map(tool => tool.id)));
  const activeRef = useRef(active);
  activeRef.current = active;
  const [phone, setPhone] = useState(() => window.matchMedia?.("(max-width: 820px)").matches ?? false);
  // 648px for the article, a 24px gap, and a 288px supporting card.
  const docked = children !== undefined && (width ?? 0) >= 960;
  const compact = width === null ? phone : !docked;
  const visibleCards = docked ? tools.filter(tool => tool.dock && openCards.has(tool.id)) : [];

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const measured = node.getBoundingClientRect().width;
    if (measured > 0) setWidth(measured);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined && next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 820px)");
    if (!media) return;
    const update = () => setPhone(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => { setActive(null); }, [compact, docked]);

  function handleEscape(event: KeyboardEvent) {
    // Native Bifrost confirmations remain above the inspector.
    const confirmation = event.target instanceof Element ? event.target.closest("dialog[open]") : null;
    if (!confirmation) return;
    event.preventDefault();
    confirmation.dispatchEvent(new Event("cancel", { cancelable: true }));
  }
  function closeCard(toolId: string) {
    setOpenCards(current => { const next = new Set(current); next.delete(toolId); return next; });
    triggers.current.get(toolId)?.focus();
  }
  function toggleCard(toolId: string) {
    if (openCards.has(toolId)) closeCard(toolId);
    else {
      setOpenCards(current => new Set(current).add(toolId));
      requestAnimationFrame(() => cards.current.get(toolId)?.focus());
    }
  }
  const controls = <div className="document-tools" role="group" aria-label="Document tools">
    {tools.map(tool => {
      const isCard = docked && tool.dock;
      const trigger = <button ref={node => { if (node) triggers.current.set(tool.id, node); else triggers.current.delete(tool.id); }} type="button" className="bds-button bds-button--ghost document-tools__trigger" aria-label={tool.title} title={tool.title}
        {...(isCard ? { "aria-expanded": openCards.has(tool.id), "aria-controls": `${id}-${tool.id}`, "data-state": openCards.has(tool.id) ? "open" : "closed", onClick: () => toggleCard(tool.id) } : {})}>
        <span className="bds-button__icon" aria-hidden="true">{tool.icon}</span>
      </button>;
      if (isCard) return <span key={tool.id}>{trigger}</span>;
      const body = <>
        <BfButton variant="ghost" className="document-tools__close" aria-label={`Close ${tool.title}`} title="Close panel" icon={<X size={15} />} onClick={() => setActive(null)} />
        <div className="document-tools__body" onClick={event => {
          if (event.target instanceof Element && event.target.closest('a[href^="#"]')) setActive(null);
        }}>{tool.content}</div>
      </>;
      const onOpenChange = (open: boolean) => setActive(current => open ? tool.id : current === tool.id ? null : current);
      return compact ? <Dialog.Root key={tool.id} open={active === tool.id} onOpenChange={onOpenChange}>
        <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="document-tools__backdrop" />
          <Dialog.Content className="document-tools__panel document-tools__drawer" aria-describedby={undefined} onEscapeKeyDown={handleEscape}>
            <Dialog.Title className="sr-only">{tool.title}</Dialog.Title>
            {body}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root> : <Popover.Root key={tool.id} open={active === tool.id} onOpenChange={onOpenChange}>
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="document-tools__panel" aria-label={tool.title} align="end" sideOffset={8} collisionPadding={12} onEscapeKeyDown={handleEscape} onCloseAutoFocus={event => { if (activeRef.current !== null) event.preventDefault(); }}>
            {body}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>;
    })}
  </div>;
  return <div ref={root} data-layout={docked ? "docked" : compact ? "drawer" : "popover"} className={`document-tools-layout${visibleCards.length ? " has-gutter" : ""}`}>
    <div className="document-reader__toolbar">{leadingAction}{controls}</div>
    <div className="document-tools-layout__body">
      <div className="document-tools-layout__article">{children}</div>
      {visibleCards.length > 0 && <aside className="document-tools__gutter" aria-label="Document details">
        {visibleCards.map(tool => <section key={tool.id} id={`${id}-${tool.id}`} ref={node => { if (node) cards.current.set(tool.id, node); else cards.current.delete(tool.id); }} role="region" aria-label={tool.title} tabIndex={-1} className="document-tools__panel document-tools__card"
          onKeyDown={event => { if (event.key !== "Escape") return; handleEscape(event.nativeEvent); if (!event.nativeEvent.defaultPrevented) { event.preventDefault(); closeCard(tool.id); } }}>
          <BfButton variant="ghost" className="document-tools__close" aria-label={`Close ${tool.title}`} title="Close panel" icon={<X size={15} />} onClick={() => closeCard(tool.id)} />
          <div className="document-tools__body">{tool.content}</div>
        </section>)}
      </aside>}
    </div>
  </div>;
}
