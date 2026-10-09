import { BfSelect, BfTextField, BfTextarea } from "./bifrost/BfField";

export type AssetFieldType = "text" | "textbox" | "number" | "date" | "checkbox" | "select" | "header" | "url" | "tag" | "upload";

export type AssetField = {
  key: string;
  name: string;
  type: AssetFieldType;
  required: boolean;
  showInList: boolean;
  defaultValue: string | null;
  options: Array<{ label: string; value: string }>;
  /** Upload references are displayed but require the attachment workflow to change. */
  editable: boolean;
};

type RawAssetField = Record<string, unknown>;
type AssetTraits = Record<string, unknown>;

const safeTypes = new Set<AssetFieldType>(["text", "textbox", "number", "date", "checkbox", "select", "header", "url", "tag", "upload"]);
const protectedTypes = new Set(["password", "totp"]);

function optionValues(value: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    if (typeof option === "string" && option) return [{ label: option, value: option }];
    if (option && typeof option === "object") {
      const item = option as Record<string, unknown>;
      const optionValue = typeof item.value === "string" ? item.value : typeof item.name === "string" ? item.name : "";
      const label = typeof item.label === "string" ? item.label : typeof item.name === "string" ? item.name : optionValue;
      return optionValue ? [{ label, value: optionValue }] : [];
    }
    return [];
  });
}

function rawDefinition(raw: unknown): RawAssetField | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as RawAssetField;
  return source.attributes && typeof source.attributes === "object" ? source.attributes as RawAssetField : source;
}

function rawKey(field: RawAssetField): string {
  const value = field.key ?? field["name-key"] ?? field.name_key;
  return typeof value === "string" ? value.trim() : "";
}

function normalizedType(field: RawAssetField): string {
  const value = typeof field.type === "string" ? field.type : typeof field.kind === "string" ? field.kind : "";
  const type = value.toLowerCase().trim().replace(/[ _-]+/g, "_");
  if (["textarea", "multiline"].includes(type)) return "textbox";
  if (["boolean", "bool"].includes(type)) return "checkbox";
  if (["dropdown", "choice"].includes(type)) return "select";
  if (type === "percent") return "number";
  if (["link", "website"].includes(type)) return "url";
  if (type === "tags") return "tag";
  if (["file", "attachment"].includes(type)) return "upload";
  if (["secret", "credential"].includes(type)) return "password";
  return type;
}

function protectedTraitKeys(rawFields: unknown): Set<string> {
  if (!Array.isArray(rawFields)) return new Set();
  return new Set(rawFields.flatMap((raw) => {
    const definition = rawDefinition(raw);
    if (!definition || !protectedTypes.has(normalizedType(definition))) return [];
    const key = rawKey(definition);
    return key ? [key] : [];
  }));
}

/** Normalizes safe source definitions. Password and TOTP fields are never rendered or written. */
export function safeAssetFields(fields: unknown): AssetField[] {
  if (!Array.isArray(fields)) return [];
  const seen = new Set<string>();
  return fields.flatMap((raw, index): AssetField[] => {
    const field = rawDefinition(raw);
    if (!field) return [];
    const type = normalizedType(field);
    if (!safeTypes.has(type as AssetFieldType)) return [];
    const sourceKey = rawKey(field);
    // IT Glue section headers are sometimes display-only and have no trait key.
    const key = sourceKey || (type === "header" ? `header_${index + 1}` : "");
    if (!key || seen.has(key)) return [];
    seen.add(key);
    const name = typeof field.name === "string" && field.name.trim() ? field.name.trim() : key;
    const defaultValue = field.default_value ?? field["default-value"];
    return [{
      key,
      name,
      type: type as AssetFieldType,
      required: field.required === true,
      showInList: (field.show_in_list ?? field["show-in-list"]) === true,
      defaultValue: typeof defaultValue === "string" ? defaultValue : null,
      options: optionValues(field.options ?? (type === "select" && typeof field["default-value"] === "string" ? field["default-value"].split("\n") : undefined)),
      editable: type !== "header" && type !== "upload",
    }];
  });
}

/**
 * Keeps existing values for every non-secret trait. Editable safe fields are then
 * supplied with source defaults; unsupported source fields remain untouched.
 */
export function assetFieldDefaults(rawFields: unknown, traits: AssetTraits = {}): AssetTraits {
  const protectedKeys = protectedTraitKeys(rawFields);
  const values: AssetTraits = Object.fromEntries(Object.entries(traits).filter(([key, value]) => !protectedKeys.has(key) && value !== undefined));
  for (const field of safeAssetFields(rawFields)) {
    if (!field.editable || values[field.key] !== undefined) continue;
    if (field.type === "checkbox") values[field.key] = field.defaultValue === "true";
    else if (field.type === "number") values[field.key] = field.defaultValue === null || field.defaultValue === "" ? "" : field.defaultValue;
    else values[field.key] = field.defaultValue ?? "";
  }
  return values;
}

export function validateAssetTraits(fields: AssetField[], traits: AssetTraits): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (!field.editable) continue;
    const value = traits[field.key];
    const empty = value === undefined || value === null || value === "";
    if (field.required && empty) errors[field.key] = `${field.name} is required.`;
    if (!empty && field.type === "select" && field.options.length && !field.options.some((option) => option.value === value)) {
      errors[field.key] = `${field.name} must be one of the configured options.`;
    }
    if (!empty && field.type === "number" && Number.isNaN(Number(value))) errors[field.key] = `${field.name} must be a number.`;
  }
  return errors;
}

/**
 * Removes known protected values and honors an explicit clear only for editable
 * fields. Values for source fields we cannot safely edit are retained unchanged.
 */
export function safeAssetTraits(fields: AssetField[], traits: AssetTraits, rawFields?: unknown): AssetTraits {
  const protectedKeys = protectedTraitKeys(rawFields);
  const fieldByKey = new Map(fields.map((field) => [field.key, field]));
  return Object.fromEntries(Object.entries(traits).flatMap(([key, value]) => {
    const field = fieldByKey.get(key);
    if (protectedKeys.has(key) || field?.type === "header" || value === undefined) return [];
    if (field?.editable && (value === "" || value === null)) return [];
    return [[key, value]];
  }));
}

export function assetTagLabels(value: unknown): string {
  const references = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).values
    : value;
  const items = Array.isArray(references) ? references : [references];
  return items.flatMap(item => {
    if (typeof item === "string" || typeof item === "number") return [String(item)];
    if (item && typeof item === "object" && typeof (item as Record<string, unknown>).name === "string") {
      return [(item as { name: string }).name];
    }
    return [];
  }).filter(label => label.trim()).join(", ");
}

export function displayAssetValue(field: Pick<AssetField, "type">, value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (field.type === "checkbox") return value === true || value === "true" ? "Yes" : "No";
  if (field.type === "textbox") return String(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "—";
  if (field.type === "tag") return assetTagLabels(value).slice(0, 100) || "—";
  return String(value).slice(0, 100);
}

export function AssetFields({ fields, values, errors = {}, onChange }: { fields: AssetField[]; values: AssetTraits; errors?: Record<string, string>; onChange: (key: string, value: unknown) => void }) {
  return <div className="editor-grid">
    {fields.map((field) => {
      const label = `${field.name}${field.required ? " *" : ""}`;
      const value = values[field.key];
      if (field.type === "header") return <div key={field.key} className="col-span-full border-b border-[var(--bf-line)] pb-2 pt-3"><h3 className="text-sm font-semibold text-muted-foreground">{field.name}</h3></div>;
      if (field.type === "upload") return <div key={field.key} className="bds-field"><span className="bds-field__label">{label}</span><output className="text-sm">{displayAssetValue(field, value)}</output><small>Upload references are managed with attachments.</small></div>;
      if (field.type === "textbox") return <BfTextarea key={field.key} label={label} value={typeof value === "string" ? value : ""} error={errors[field.key]} onChange={(event) => onChange(field.key, event.target.value)} />;
      if (field.type === "select") return <BfSelect key={field.key} label={label} value={typeof value === "string" ? value : ""} error={errors[field.key]} options={[{ label: "Select an option", value: "" }, ...field.options]} onChange={(event) => onChange(field.key, event.target.value)} />;
      if (field.type === "checkbox") return <label key={field.key} className="bds-field"><input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(field.key, event.target.checked)} /> {label}</label>;
      if (field.type === "tag") return <BfTextField key={field.key} label={label} hint="Separate tags with commas." value={assetTagLabels(value)} error={errors[field.key]} onChange={(event) => onChange(field.key, event.target.value)} />;
      return <BfTextField key={field.key} label={label} type={field.type === "number" || field.type === "date" || field.type === "url" ? field.type : "text"} value={typeof value === "string" || typeof value === "number" ? String(value) : ""} error={errors[field.key]} onChange={(event) => onChange(field.key, event.target.value)} />;
    })}
  </div>;
}
