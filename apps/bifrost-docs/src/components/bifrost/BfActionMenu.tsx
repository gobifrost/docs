import "./components.css";
import { MoreVertical } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface BfActionMenuItem {
  value: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  tone?: "default" | "danger";
  separatorBefore?: boolean;
}

export interface BfActionMenuProps {
  label: string;
  items: BfActionMenuItem[];
  onSelect: (value: string) => void;
  disabled?: boolean;
}

interface MenuPosition {
  left: number;
  top?: number;
  bottom?: number;
  placement: "top" | "bottom";
}

export function BfActionMenu({ label, items, onSelect, disabled = false }: BfActionMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition>();

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const bounds = trigger.getBoundingClientRect();
      const menuWidth = Math.min(196, window.innerWidth - 16);
      const spaceBelow = window.innerHeight - bounds.bottom - 8;
      const placement = spaceBelow >= 180 || spaceBelow >= bounds.top - 8 ? "bottom" : "top";
      setPosition({
        left: Math.max(8, Math.min(bounds.right - menuWidth, window.innerWidth - menuWidth - 8)),
        top: placement === "bottom" ? bounds.bottom + 5 : undefined,
        bottom: placement === "top" ? window.innerHeight - bounds.top + 5 : undefined,
        placement,
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsidePress);
    menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    return () => document.removeEventListener("mousedown", closeOnOutsidePress);
  }, [open]);

  const closeAndReturnFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabledItems = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? []);
    const current = enabledItems.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (current + 1) % enabledItems.length : event.key === "ArrowUp" ? (current - 1 + enabledItems.length) % enabledItems.length : event.key === "Home" ? 0 : event.key === "End" ? enabledItems.length - 1 : null;
    if (next !== null && enabledItems[next]) {
      event.preventDefault();
      enabledItems[next].focus();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndReturnFocus();
    }
    if (event.key === "Tab") setOpen(false);
  };

  return <>
    <button
      ref={triggerRef}
      type="button"
      className="bds-action-menu__trigger"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => {
        if (!open && (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          setOpen(true);
        }
      }}
    ><MoreVertical size={16} aria-hidden="true" /></button>
    {open && typeof document !== "undefined" && createPortal(
      <div
        ref={menuRef}
        className="bds-action-menu__popover"
        role="menu"
        aria-label={label}
        data-placement={position?.placement}
        style={{ left: position?.left, top: position?.top, bottom: position?.bottom }}
        onKeyDown={onMenuKeyDown}
      >
        {items.map((item) => <button
          key={item.value}
          type="button"
          role="menuitem"
          className={item.separatorBefore ? "has-separator" : undefined}
          data-tone={item.tone ?? "default"}
          disabled={item.disabled}
          onClick={() => {
            onSelect(item.value);
            closeAndReturnFocus();
          }}
        >
          {item.icon && <span aria-hidden="true">{item.icon}</span>}
          {item.label}
        </button>)}
      </div>,
      triggerRef.current?.closest('[role="dialog"], dialog') ?? document.body,
    )}
  </>;
}
