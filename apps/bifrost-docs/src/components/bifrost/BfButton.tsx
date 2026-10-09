import "./components.css";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { ButtonVariant } from "./types";

interface BfButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: ReactNode;
  trailingIcon?: ReactNode;
}

export function BfButton({ variant = "primary", icon, trailingIcon, className = "", children, ...props }: BfButtonProps) {
  return (
    <button className={`bds-button bds-button--${variant} ${className}`.trim()} {...props}>
      {icon && <span className="bds-button__icon" aria-hidden="true">{icon}</span>}
      <span>{children}</span>
      {trailingIcon && <span className="bds-button__icon" aria-hidden="true">{trailingIcon}</span>}
    </button>
  );
}
