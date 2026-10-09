import type { ReactNode } from "react";
import { RefreshCw, Search, X } from "lucide-react";
import { BfButton } from "./bifrost/BfButton";
import { BfTextField } from "./bifrost/BfField";

export function CatalogToolbar({ label, value, onValueChange, placeholder, onRefresh, refreshing = false, children }: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  children?: ReactNode;
}) {
  return <section className="catalog-toolbar" aria-label="Catalog filters">
    <div className={`catalog-toolbar__search${value ? " has-query" : ""}`}>
      <BfTextField label={label} leadingIcon={<Search size={16} />} value={value} onChange={event => onValueChange(event.target.value)} placeholder={placeholder ?? label} />
      {value && <BfButton type="button" variant="ghost" className="catalog-toolbar__clear" aria-label="Clear search" title="Clear search" icon={<X size={14} />} onClick={() => onValueChange("")} />}
    </div>
    {children && <div className="catalog-toolbar__filters">{children}</div>}
    {onRefresh && <BfButton type="button" variant="ghost" className="catalog-toolbar__refresh" aria-label="Refresh records" title="Refresh records" disabled={refreshing} icon={<RefreshCw size={16} className={refreshing ? "spin" : undefined} />} onClick={onRefresh} />}
  </section>;
}
