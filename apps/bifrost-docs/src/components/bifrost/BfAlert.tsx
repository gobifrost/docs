import "./components.css";
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import type { ReactNode } from "react";

type AlertTone = "info" | "success" | "warning" | "danger";

const icons = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle,
};

export function BfAlert({ tone = "info", title, children, action }: { tone?: AlertTone; title: string; children: ReactNode; action?: ReactNode }) {
  const Icon = icons[tone];
  return (
    <div className={`bds-alert bds-alert--${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon size={18} aria-hidden="true" />
      <div><strong>{title}</strong><p>{children}</p></div>
      {action && <div className="bds-alert__action">{action}</div>}
    </div>
  );
}
