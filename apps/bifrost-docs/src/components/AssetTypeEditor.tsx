import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { BfAlert } from "@/components/bifrost/BfAlert";
import { BfButton } from "@/components/bifrost/BfButton";
import { BfCheckbox } from "@/components/bifrost/BfSelection";
import { BfSelect, BfTextField, BfTextarea } from "@/components/bifrost/BfField";

export type AssetFieldType = "text" | "textbox" | "number" | "date" | "checkbox" | "select" | "header" | "url" | "tag" | "upload" | "password" | "totp" | "unknown";
type SourceState = Pick<AssetTypeField, "key" | "name" | "type" | "required" | "show_in_list" | "default_value" | "options">;

export type AssetTypeField = {
  key: string;
  name: string;
  type: AssetFieldType;
  required: boolean;
  show_in_list: boolean;
  default_value: string | null;
  options: string[] | null;
  /** Original source type, retained for diagnostics and exact serialization. */
  sourceType?: string;
  /** Unsupported and protected source definitions must not be changed in this UI. */
  readOnly?: boolean;
  /** The exact imported schema object, including attributes that this UI does not model. */
  source?: Record<string, unknown>;
  sourceState?: SourceState;
};

export type AssetTypeValues = {
  name: string;
  icon: string;
  active: boolean;
  fields: AssetTypeField[];
};

const FIELD_TYPES: Array<{ value: AssetFieldType; label: string }> = [
  { value: "text", label: "Text" }, { value: "textbox", label: "Text area" },
  { value: "number", label: "Number" }, { value: "date", label: "Date" },
  { value: "checkbox", label: "Checkbox" }, { value: "select", label: "Dropdown" },
  { value: "url", label: "URL" }, { value: "tag", label: "Tags" },
  { value: "upload", label: "Upload reference" }, { value: "header", label: "Section header" },
];
const PROTECTED_TYPES = new Set<AssetFieldType>(["password", "totp"]);
const KNOWN_TYPES = new Set<AssetFieldType>(FIELD_TYPES.map((field) => field.value));

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function keyFor(name: string): string { return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }
function cloneSource(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
function sourceAttributes(source: Record<string, unknown>): Record<string, unknown> {
  return source.attributes && typeof source.attributes === "object" ? source.attributes as Record<string, unknown> : source;
}
function fieldType(value: unknown): { type: AssetFieldType; sourceType: string } {
  const sourceType = text(value).toLowerCase().replace(/[ _-]+/g, "_");
  if (["text", "textbox", "number", "date", "checkbox", "select", "header", "url", "tag", "upload", "password", "totp"].includes(sourceType)) return { type: sourceType as AssetFieldType, sourceType };
  if (["textarea", "multiline"].includes(sourceType)) return { type: "textbox", sourceType };
  if (["boolean", "bool"].includes(sourceType)) return { type: "checkbox", sourceType };
  if (["dropdown", "choice"].includes(sourceType)) return { type: "select", sourceType };
  if (sourceType === "percent") return { type: "number", sourceType };
  if (["link", "website"].includes(sourceType)) return { type: "url", sourceType };
  if (sourceType === "tags") return { type: "tag", sourceType };
  if (["file", "attachment"].includes(sourceType)) return { type: "upload", sourceType };
  if (["secret", "credential"].includes(sourceType)) return { type: "password", sourceType };
  return { type: "unknown", sourceType: sourceType || "unknown" };
}

function optionsFrom(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const options = value.flatMap((option) => {
    if (typeof option === "string" && option.trim()) return [option.trim()];
    if (option && typeof option === "object") {
      const item = option as Record<string, unknown>;
      const label = text(item.value ?? item.label ?? item.name);
      return label ? [label] : [];
    }
    return [];
  });
  return options.length ? options : null;
}

function stateFor(field: AssetTypeField): SourceState {
  return {
    key: field.key,
    name: field.name,
    type: field.type,
    required: field.required,
    show_in_list: field.show_in_list,
    default_value: field.default_value,
    options: field.options ? [...field.options] : null,
  };
}

function sameState(field: AssetTypeField): boolean {
  return Boolean(field.sourceState) && JSON.stringify(stateFor(field)) === JSON.stringify(field.sourceState);
}

function setAliased(target: Record<string, unknown>, aliases: string[], value: unknown, fallback: string) {
  const alias = aliases.find((key) => key in target) ?? fallback;
  target[alias] = value;
}

function serializedField(field: AssetTypeField): Record<string, unknown> {
  if (field.source && (field.readOnly || sameState(field))) return cloneSource(field.source);
  const source = field.source ? cloneSource(field.source) : {};
  const attrs = sourceAttributes(source);
  setAliased(attrs, ["key", "name-key", "name_key"], field.key, "key");
  setAliased(attrs, ["name"], field.name, "name");
  setAliased(attrs, ["type", "kind"], field.type, "type");
  setAliased(attrs, ["required"], field.required, "required");
  setAliased(attrs, ["show_in_list", "show-in-list"], field.show_in_list, "show_in_list");
  setAliased(attrs, ["default_value", "default-value"], field.default_value, "default_value");
  setAliased(attrs, ["options"], field.type === "select" ? field.options?.filter(Boolean) ?? [] : null, "options");
  return source;
}

/**
 * Parses both native and IT Glue schemas without replacing unknown definitions
 * with text fields. The source object is retained for a lossless save.
 */
export function normalizeAssetTypeFields(raw: unknown): AssetTypeField[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const source = cloneSource(item as Record<string, unknown>);
    const attrs = sourceAttributes(source);
    const name = text(attrs.name) || `Field ${index + 1}`;
    const kind = fieldType(attrs.type ?? attrs.kind);
    const field: AssetTypeField = {
      key: text(attrs.key ?? attrs["name-key"] ?? attrs.name_key) || keyFor(name) || `field_${index + 1}`,
      name,
      type: kind.type,
      required: Boolean(attrs.required),
      show_in_list: Boolean(attrs.show_in_list ?? attrs["show-in-list"]),
      default_value: (attrs.default_value ?? attrs["default-value"]) == null ? null : String(attrs.default_value ?? attrs["default-value"]),
      options: optionsFrom(attrs.options),
      sourceType: kind.sourceType,
      readOnly: PROTECTED_TYPES.has(kind.type) || kind.type === "unknown",
      source,
    };
    return [{ ...field, sourceState: stateFor(field) }];
  });
}

/**
 * Compatibility export used by the settings page. It now serializes all
 * definitions, including protected and unsupported source schema rows.
 */
export function safeAssetTypeFields(fields: AssetTypeField[]): Array<Record<string, unknown>> {
  return serializeAssetTypeFields(fields);
}

/** Produces the table payload without leaking editor-only source metadata. */
export function serializeAssetTypeFields(fields: AssetTypeField[]): Array<Record<string, unknown>> {
  return fields.map(serializedField);
}

export function assetTypeDefaults(values?: Partial<AssetTypeValues>): AssetTypeValues {
  return { name: values?.name ?? "", icon: values?.icon ?? "", active: values?.active ?? true, fields: values?.fields ?? [] };
}

function emptyField(index: number): AssetTypeField {
  return { key: `field_${index + 1}`, name: "", type: "text", required: false, show_in_list: false, default_value: null, options: null };
}

function isReadOnly(field: AssetTypeField): boolean {
  return Boolean(field.readOnly);
}

export function AssetTypeEditor({ initial, onSave, onCancel, saving = false, sourceMapped = false }: {
  initial?: Partial<AssetTypeValues>;
  onSave: (values: AssetTypeValues) => Promise<void>;
  onCancel: () => void;
  saving?: boolean;
  sourceMapped?: boolean;
}) {
  const [values, setValues] = useState<AssetTypeValues>(() => assetTypeDefaults(initial));
  const [error, setError] = useState("");
  const initialKey = JSON.stringify(assetTypeDefaults(initial));
  useEffect(() => { setValues(JSON.parse(initialKey) as AssetTypeValues); setError(""); }, [initialKey]);
  const update = (changes: Partial<AssetTypeValues>) => setValues((current) => ({ ...current, ...changes }));
  const updateField = (index: number, changes: Partial<AssetTypeField>) => update({ fields: values.fields.map((field, position) => position === index ? { ...field, ...changes } : field) });
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= values.fields.length || isReadOnly(values.fields[index]) || isReadOnly(values.fields[target])) return;
    const fields = [...values.fields]; [fields[index], fields[target]] = [fields[target], fields[index]];
    update({ fields });
  };
  async function save() {
    const name = values.name.trim();
    const fields = values.fields.map((field) => isReadOnly(field) ? field : {
      ...field,
      key: field.key.trim() || keyFor(field.name),
      name: field.name.trim(),
      options: field.type === "select" ? field.options?.filter(Boolean) ?? [] : null,
    });
    if (!name) { setError("Type name is required."); return; }
    if (fields.some((field) => !field.name || !field.key)) { setError("Every field needs a display name and key."); return; }
    if (fields.some((field) => !/^[a-zA-Z0-9_-]+$/.test(field.key))) { setError("Field keys may contain letters, numbers, hyphens, and underscores."); return; }
    if (new Set(fields.map((field) => field.key)).size !== fields.length) { setError("Field keys must be unique."); return; }
    setError("");
    try { await onSave({ ...values, name, fields }); } catch (saveError) { setError(saveError instanceof Error ? saveError.message : String(saveError)); }
  }
  return <div className="grid gap-4">
    {sourceMapped && <BfAlert tone="warning" title="Mapped type">IT Glue may overwrite source-schema edits when the source changes.</BfAlert>}
    {error && <BfAlert tone="danger" title="Could not save asset type">{error}</BfAlert>}
    <div className="grid gap-3 sm:grid-cols-2"><BfTextField label="Type name" value={values.name} onChange={(event) => update({ name: event.target.value })} /><BfTextField label="Icon" hint="Optional icon name." value={values.icon} onChange={(event) => update({ icon: event.target.value })} /></div>
    <BfCheckbox checked={values.active} onChange={(active) => update({ active })}>Active and available for new assets</BfCheckbox>
    <section className="grid gap-3" aria-label="Asset type fields"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">Fields</h3><BfButton variant="secondary" type="button" icon={<Plus size={15} />} onClick={() => update({ fields: [...values.fields, emptyField(values.fields.length)] })}>Add field</BfButton></div>
      {values.fields.length === 0 && <p className="text-sm text-muted-foreground">Add fields to define the asset schema.</p>}
      {values.fields.map((field, index) => {
        const readOnly = isReadOnly(field);
        const readOnlyReason = PROTECTED_TYPES.has(field.type) ? "Protected source field. Its definition is retained but cannot be edited here." : "Unsupported source field. Its definition is retained unchanged.";
        return <div key={`${field.key}-${index}`} className="grid gap-3 rounded border border-[var(--bf-line)] p-3">
          {readOnly ? <div className="rounded bg-muted p-3 text-sm"><strong>{field.name}</strong><p className="mt-1 text-muted-foreground">{readOnlyReason} Type: {field.sourceType ?? field.type}.</p></div> : <><div className="grid gap-3 sm:grid-cols-3"><BfTextField label="Field name" value={field.name} onChange={(event) => { const name = event.target.value; updateField(index, { name, key: field.key.startsWith("field_") ? keyFor(name) : field.key }); }} /><BfTextField label="Key" value={field.key} onChange={(event) => updateField(index, { key: event.target.value })} /><BfSelect label="Type" value={field.type} options={FIELD_TYPES} onChange={(event) => updateField(index, { type: event.target.value as AssetFieldType, options: event.target.value === "select" ? field.options ?? [] : null })} /></div>
          {field.type === "select" && <BfTextarea label="Options" hint="One option per line." value={(field.options ?? []).join("\n")} onChange={(event) => updateField(index, { options: event.target.value.split("\n").map((option) => option.trim()).filter(Boolean) })} />}
          {field.type !== "header" && field.type !== "upload" && <BfTextField label="Default value" value={field.default_value ?? ""} onChange={(event) => updateField(index, { default_value: event.target.value || null })} />}
          {field.type === "upload" && <p className="text-sm text-muted-foreground">Upload references are managed with attachments.</p>}
          <div className="flex flex-wrap gap-3"><BfCheckbox checked={field.required} onChange={(required) => updateField(index, { required })}>Required</BfCheckbox><BfCheckbox checked={field.show_in_list} onChange={(show_in_list) => updateField(index, { show_in_list })}>Show in list</BfCheckbox></div></>}
          <div className="flex flex-wrap gap-3"><BfButton type="button" variant="ghost" aria-label={`Move ${field.name || `field ${index + 1}`} up`} disabled={index === 0 || readOnly || isReadOnly(values.fields[index - 1])} icon={<ChevronUp size={15} />} onClick={() => move(index, -1)}>Up</BfButton><BfButton type="button" variant="ghost" aria-label={`Move ${field.name || `field ${index + 1}`} down`} disabled={index === values.fields.length - 1 || readOnly || isReadOnly(values.fields[index + 1])} icon={<ChevronDown size={15} />} onClick={() => move(index, 1)}>Down</BfButton><BfButton type="button" variant="danger" disabled={readOnly} icon={<Trash2 size={15} />} onClick={() => update({ fields: values.fields.filter((_, position) => position !== index) })}>Remove</BfButton></div>
        </div>;
      })}</section>
    <div className="flex justify-end gap-2"><BfButton type="button" variant="secondary" disabled={saving} onClick={onCancel}>Cancel</BfButton><BfButton type="button" disabled={saving} onClick={save}>{saving ? "Saving" : "Save asset type"}</BfButton></div>
  </div>;
}
