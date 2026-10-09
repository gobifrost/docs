import "./components.css";
import type { ReactNode } from "react";

export function BfCheckbox({ checked, onChange, children, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className="bds-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span aria-hidden="true" />
      <span>{children}</span>
    </label>
  );
}

export function BfRadioGroup({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ label: string; value: string }> }) {
  return (
    <fieldset className="bds-radio-group">
      <legend>{label}</legend>
      {options.map((option) => (
        <label className="bds-radio" key={option.value}>
          <input type="radio" name={label} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
          <span aria-hidden="true" />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function BfSwitch({ checked, onChange, label, description, ariaLabel }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string; ariaLabel?: string }) {
  return (
    <div className="bds-switch-row">
      <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <button className="bds-switch" type="button" role="switch" aria-checked={checked} aria-label={ariaLabel ?? label} onClick={() => onChange(!checked)}><span /></button>
    </div>
  );
}
