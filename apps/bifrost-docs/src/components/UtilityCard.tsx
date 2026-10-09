import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

const compactQuery = "(max-width: 820px)";

export function UtilityCard({ title, icon, actions, children, className = "", presentation = "card" }: {
  title: string;
  icon: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  presentation?: "card" | "panel";
}) {
  const [expanded, setExpanded] = useState(() => !window.matchMedia?.(compactQuery).matches);
  useEffect(() => {
    const media = window.matchMedia?.(compactQuery);
    if (!media) return;
    const update = () => setExpanded(!media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  if (presentation === "panel") return <section className={`utility-card utility-card--panel ${className}`}>
    <header className="utility-card__heading"><h2>{icon}{title}</h2>{actions && <span className="utility-card__actions">{actions}</span>}</header>
    <div className="utility-card__body">{children}</div>
  </section>;

  return <details className={`record-content utility-card ${className}`} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="utility-card__heading">
      <h2>{icon}{title}</h2>
      {actions && <span className="utility-card__actions" onClick={event => event.preventDefault()}>{actions}</span>}
      <ChevronDown className="utility-card__chevron" size={14} aria-hidden="true" />
    </summary>
    <div className="utility-card__body">{children}</div>
  </details>;
}
