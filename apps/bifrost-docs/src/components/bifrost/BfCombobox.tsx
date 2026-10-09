import "./components.css";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, LoaderCircle, Search, X } from "lucide-react";

export interface BfComboboxOption {
  value: string;
  label: string;
  description?: string;
  keywords?: string[];
  icon?: ReactNode;
  disabled?: boolean;
}

interface FieldChrome {
  label: string;
  hint?: string;
  error?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  id?: string;
  name?: string;
}

export interface BfComboboxProps extends FieldChrome {
  options: BfComboboxOption[];
  value?: string;
  onValueChange: (value: string) => void;
  clearable?: boolean;
}

export interface BfMultiSelectProps extends FieldChrome {
  options: BfComboboxOption[];
  value: string[];
  onValueChange: (value: string[]) => void;
  maxDisplayedItems?: number;
  maxSelections?: number;
  showBulkActions?: boolean;
}

function normalizedSearch(option: BfComboboxOption) {
  return [option.label, option.description, ...(option.keywords ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

function useFilteredOptions(options: BfComboboxOption[], query: string) {
  return useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return options;
    return options.filter((option) => {
      const text = normalizedSearch(option);
      return terms.every((term) => text.includes(term));
    });
  }, [options, query]);
}

function FieldMessage({ id, error, hint }: { id: string; error?: string; hint?: string }) {
  if (!error && !hint) return null;
  return <small id={id}>{error ?? hint}</small>;
}

function OptionContent({ option, selected }: { option: BfComboboxOption; selected: boolean }) {
  return (
    <>
      <span className="bds-combobox__check" aria-hidden="true">{selected && <Check size={14} />}</span>
      {option.icon && <span className="bds-combobox__option-icon" aria-hidden="true">{option.icon}</span>}
      <span className="bds-combobox__option-copy">
        <strong>{option.label}</strong>
        {option.description && <small>{option.description}</small>}
      </span>
    </>
  );
}

interface ViewportPopoverProps {
  anchorRef: RefObject<HTMLElement>;
  popoverRef: RefObject<HTMLDivElement>;
  children: ReactNode;
}

interface PopoverPosition {
  placement: "top" | "bottom";
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
}

function ViewportPopover({ anchorRef, popoverRef, children }: ViewportPopoverProps) {
  const [position, setPosition] = useState<PopoverPosition>();

  useLayoutEffect(() => {
    const positionPopover = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;

      const rect = anchor.getBoundingClientRect();
      const viewportMargin = 8;
      const gap = 6;
      const width = Math.min(Math.max(rect.width, 260), window.innerWidth - viewportMargin * 2);
      const left = Math.min(
        Math.max(rect.left, viewportMargin),
        Math.max(viewportMargin, window.innerWidth - width - viewportMargin),
      );
      const spaceBelow = window.innerHeight - rect.bottom - viewportMargin;
      const spaceAbove = rect.top - viewportMargin;
      const placement = spaceBelow >= 220 || spaceBelow >= spaceAbove ? "bottom" : "top";
      const availableHeight = Math.max(112, (placement === "bottom" ? spaceBelow : spaceAbove) - gap);

      setPosition({
        placement,
        left,
        top: placement === "bottom" ? rect.bottom + gap : undefined,
        bottom: placement === "top" ? window.innerHeight - rect.top + gap : undefined,
        width,
        maxHeight: availableHeight,
      });
    };

    positionPopover();
    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", positionPopover, true);
    return () => {
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionPopover, true);
    };
  }, [anchorRef]);

  if (typeof document === "undefined") return null;

  const style = position ? ({
    left: position.left,
    top: position.top,
    bottom: position.bottom,
    width: position.width,
    maxHeight: position.maxHeight,
    "--bds-popover-max-height": `${position.maxHeight}px`,
  } as CSSProperties) : undefined;

  // A native modal dialog occupies the browser top layer. Portaling to body
  // would place its option list behind that layer, even with a high z-index.
  const portalTarget = anchorRef.current?.closest("dialog") ?? document.body;

  return createPortal(
    <div
      ref={popoverRef}
      className="bds-combobox__popover"
      data-placement={position?.placement}
      style={style}
    >
      {children}
    </div>,
    portalTarget,
  );
}

export function BfCombobox({
  options,
  value,
  onValueChange,
  label,
  hint,
  error,
  placeholder = "Select an option",
  searchPlaceholder = "Search options",
  emptyText = "No options found.",
  disabled = false,
  loading = false,
  clearable = false,
  className = "",
  id: providedId,
  name,
}: BfComboboxProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const listboxId = `${id}-listbox`;
  const messageId = `${id}-message`;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const filteredOptions = useFilteredOptions(options, query);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!wrapperRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsidePress);
    return () => document.removeEventListener("mousedown", closeOnOutsidePress);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  const choose = (option: BfComboboxOption) => {
    if (option.disabled) return;
    onValueChange(option.value);
    setOpen(false);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => {
        if (!filteredOptions.length) return 0;
        return (current + direction + filteredOptions.length) % filteredOptions.length;
      });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = filteredOptions[activeIndex];
      if (option) choose(option);
    }
  };

  return (
    <div ref={wrapperRef} className={`bds-field bds-combobox ${error ? "bds-field--error" : ""} ${className}`.trim()}>
      <label className="bds-field__label" id={`${id}-label`} htmlFor={id}>{label}</label>
      {name && <input type="hidden" name={name} value={value ?? ""} />}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="bds-combobox__trigger"
        role="combobox"
        aria-labelledby={`${id}-label`}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-busy={loading || undefined}
        aria-invalid={Boolean(error)}
        aria-describedby={hint || error ? messageId : undefined}
        disabled={disabled || loading}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (["ArrowDown", "Enter", " "].includes(event.key) && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className={selected ? "" : "is-placeholder"}>
          {loading ? <><LoaderCircle className="bds-spin" size={15} /> Loading options…</> : selected?.label ?? placeholder}
        </span>
        <span className="bds-combobox__trigger-actions">
          <ChevronDown size={15} aria-hidden="true" />
        </span>
      </button>
      {clearable && selected && !disabled && !loading && (
        <button type="button" aria-label={`Clear ${label}`} className="bds-combobox__clear" onClick={() => onValueChange("")}><X size={14} /></button>
      )}
      {open && (
        <ViewportPopover anchorRef={triggerRef} popoverRef={popoverRef}>
          <div className="bds-combobox__search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-controls={listboxId}
              aria-activedescendant={filteredOptions[activeIndex] ? `${id}-option-${filteredOptions[activeIndex].value}` : undefined}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onSearchKeyDown}
            />
          </div>
          <div id={listboxId} className="bds-combobox__list" role="listbox" aria-labelledby={`${id}-label`}>
            {filteredOptions.length ? filteredOptions.map((option, index) => (
              <button
                id={`${id}-option-${option.value}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                disabled={option.disabled}
                data-active={index === activeIndex || undefined}
                key={option.value}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option)}
              ><OptionContent option={option} selected={option.value === value} /></button>
            )) : <p className="bds-combobox__empty">{emptyText}</p>}
          </div>
        </ViewportPopover>
      )}
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  );
}

export function BfMultiSelect({
  options,
  value,
  onValueChange,
  label,
  hint,
  error,
  placeholder = "Select options",
  searchPlaceholder = "Search options",
  emptyText = "No options found.",
  disabled = false,
  loading = false,
  className = "",
  id: providedId,
  name,
  maxDisplayedItems = 2,
  maxSelections,
  showBulkActions = true,
}: BfMultiSelectProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const listboxId = `${id}-listbox`;
  const messageId = `${id}-message`;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const filteredOptions = useFilteredOptions(options, query);
  const selectedSet = useMemo(() => new Set(value), [value]);
  const selectedOptions = value.map((selectedValue) => options.find((option) => option.value === selectedValue) ?? { value: selectedValue, label: selectedValue });
  const displayed = selectedOptions.slice(0, maxDisplayedItems);
  const overflow = Math.max(0, selectedOptions.length - displayed.length);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!wrapperRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsidePress);
    return () => document.removeEventListener("mousedown", closeOnOutsidePress);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  const toggle = (option: BfComboboxOption) => {
    if (option.disabled) return;
    if (selectedSet.has(option.value)) {
      onValueChange(value.filter((item) => item !== option.value));
      return;
    }
    if (maxSelections && value.length >= maxSelections) return;
    onValueChange([...value, option.value]);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => filteredOptions.length ? (current + direction + filteredOptions.length) % filteredOptions.length : 0);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = filteredOptions[activeIndex];
      if (option) toggle(option);
    }
  };

  const selectableValues = options.filter((option) => !option.disabled).map((option) => option.value);
  const bulkValues = maxSelections ? selectableValues.slice(0, maxSelections) : selectableValues;
  const allSelected = bulkValues.length > 0 && bulkValues.every((optionValue) => selectedSet.has(optionValue));

  return (
    <div ref={wrapperRef} className={`bds-field bds-combobox bds-multiselect ${error ? "bds-field--error" : ""} ${className}`.trim()}>
      <label className="bds-field__label" id={`${id}-label`} htmlFor={id}>{label}</label>
      {name && value.map((selectedValue) => <input key={selectedValue} type="hidden" name={name} value={selectedValue} />)}
      <div
        ref={triggerRef}
        id={id}
        className="bds-combobox__trigger"
        role="combobox"
        aria-labelledby={`${id}-label`}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-busy={loading || undefined}
        aria-invalid={Boolean(error)}
        aria-disabled={disabled || loading}
        aria-describedby={hint || error ? messageId : undefined}
        tabIndex={disabled || loading ? -1 : 0}
        onClick={() => {
          if (!disabled && !loading) setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (["ArrowDown", "Enter", " "].includes(event.key) && !open && !disabled && !loading) {
            event.preventDefault();
            setOpen(true);
          }
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <span className="bds-multiselect__values">
          {loading ? <span><LoaderCircle className="bds-spin" size={15} /> Loading options…</span> : displayed.length ? displayed.map((option) => (
            <span className="bds-multiselect__tag" key={option.value}>
              {option.label}
              <button
                type="button"
                aria-label={`Remove ${option.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onValueChange(value.filter((item) => item !== option.value));
                }}
              ><X size={12} /></button>
            </span>
          )) : <span className="is-placeholder">{placeholder}</span>}
          {overflow > 0 && <span className="bds-multiselect__overflow">+{overflow} more</span>}
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </div>
      {open && (
        <ViewportPopover anchorRef={triggerRef} popoverRef={popoverRef}>
          <div className="bds-combobox__search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-controls={listboxId}
              aria-activedescendant={filteredOptions[activeIndex] ? `${id}-option-${filteredOptions[activeIndex].value}` : undefined}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onSearchKeyDown}
            />
          </div>
          {showBulkActions && options.length > 1 && (
            <div className="bds-combobox__bulk">
              <button type="button" onClick={() => onValueChange(allSelected ? [] : bulkValues)}>{allSelected ? "Clear all" : "Select all"}</button>
              <span>{value.length} selected{maxSelections ? ` · ${maxSelections} maximum` : ""}</span>
            </div>
          )}
          <div id={listboxId} className="bds-combobox__list" role="listbox" aria-multiselectable="true" aria-labelledby={`${id}-label`}>
            {filteredOptions.length ? filteredOptions.map((option, index) => {
              const selected = selectedSet.has(option.value);
              const atLimit = Boolean(maxSelections && value.length >= maxSelections && !selected);
              return (
                <button
                  id={`${id}-option-${option.value}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={option.disabled || atLimit}
                  data-active={index === activeIndex || undefined}
                  key={option.value}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => toggle(option)}
                ><OptionContent option={option} selected={selected} /></button>
              );
            }) : <p className="bds-combobox__empty">{emptyText}</p>}
          </div>
        </ViewportPopover>
      )}
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  );
}
