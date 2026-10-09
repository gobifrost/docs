import "./components.css";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { useId } from "react";

type FieldChrome = {
  label: string;
  hint?: string;
  error?: string;
  leadingIcon?: ReactNode;
};

type TextFieldProps = FieldChrome & InputHTMLAttributes<HTMLInputElement>;

export function BfTextField({ label, hint, error, leadingIcon, className = "", id: providedId, ...props }: TextFieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const messageId = `${id}-message`;

  return (
    <div className={`bds-field ${error ? "bds-field--error" : ""} ${className}`.trim()}>
      <label className="bds-field__label" htmlFor={id}>{label}</label>
      <span className={`bds-field__control ${leadingIcon ? "bds-field__control--icon" : ""}`}>
        {leadingIcon && <span className="bds-field__icon" aria-hidden="true">{leadingIcon}</span>}
        <input id={id} aria-invalid={Boolean(error)} aria-describedby={hint || error ? messageId : undefined} {...props} />
      </span>
      {(error || hint) && <small id={messageId}>{error ?? hint}</small>}
    </div>
  );
}

type SelectFieldProps = FieldChrome & SelectHTMLAttributes<HTMLSelectElement> & {
  options: Array<{ label: string; value: string }>;
};

export function BfSelect({ label, hint, error, options, className = "", id: providedId, ...props }: SelectFieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const messageId = `${id}-message`;

  return (
    <div className={`bds-field ${error ? "bds-field--error" : ""} ${className}`.trim()}>
      <label className="bds-field__label" htmlFor={id}>{label}</label>
      <select id={id} aria-invalid={Boolean(error)} aria-describedby={hint || error ? messageId : undefined} {...props}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {(error || hint) && <small id={messageId}>{error ?? hint}</small>}
    </div>
  );
}

type TextareaFieldProps = FieldChrome & TextareaHTMLAttributes<HTMLTextAreaElement>;

export function BfTextarea({ label, hint, error, className = "", id: providedId, ...props }: TextareaFieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const messageId = `${id}-message`;

  return (
    <div className={`bds-field ${error ? "bds-field--error" : ""} ${className}`.trim()}>
      <label className="bds-field__label" htmlFor={id}>{label}</label>
      <textarea id={id} aria-invalid={Boolean(error)} aria-describedby={hint || error ? messageId : undefined} {...props} />
      {(error || hint) && <small id={messageId}>{error ?? hint}</small>}
    </div>
  );
}
