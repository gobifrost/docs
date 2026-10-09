import { useRef, useState } from "react";
import { TableAccessDeniedError, tables } from "bifrost";
import { Loader2, Power } from "lucide-react";
import { BfAlert } from "./bifrost/BfAlert";
import { BfButton } from "./bifrost/BfButton";
import { BfDialog } from "./bifrost/BfDialog";

export function RecordEnabledAction({ table, recordId, organizationId, name, singular, enabled, imported, disabled, onUpdated }: {
  table: string;
  recordId: string;
  organizationId: string;
  name: string;
  singular: string;
  enabled: boolean;
  imported: boolean;
  disabled: boolean;
  onUpdated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [targetEnabled, setTargetEnabled] = useState(!enabled);
  const inFlight = useRef(false);
  const verb = targetEnabled ? "Enable" : "Disable";
  const label = `${enabled ? "Disable" : "Enable"} ${singular.toLowerCase()}`;
  const confirmationLabel = `${verb} ${singular.toLowerCase()}`;

  async function save() {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await tables.update(table, recordId, { is_enabled: targetEnabled }, organizationId || undefined);
      if (!result) throw new Error("This record is no longer available. Refresh the page before trying again.");
      setOpen(false);
      onUpdated();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setError(failure instanceof TableAccessDeniedError || /access denied|permission|\b403\b/i.test(message)
        ? "Your Bifrost role cannot change this record."
        : message);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return <>
    <BfButton variant="ghost" className="record-enabled-action" aria-label={label} title={label}
      icon={<Power size={15} />} disabled={disabled || saving}
      onClick={() => { setError(""); setTargetEnabled(!enabled); setOpen(true); }} />
    <BfDialog open={open} onOpenChange={value => { if (!inFlight.current) setOpen(value); }}
      title={`${confirmationLabel}?`} description="This changes only the record's enabled state."
      footer={<>
        <BfButton variant="secondary" disabled={saving} onClick={() => setOpen(false)}>Cancel</BfButton>
        <BfButton disabled={saving || disabled} icon={saving ? <Loader2 className="spin" size={15} /> : undefined}
          onClick={save}>{saving ? "Saving" : `${verb} record`}</BfButton>
      </>}>
      <p className="empty-copy">{verb} {name}?</p>
      {imported && <BfAlert tone="warning" title="Source synchronization">IT Glue may overwrite this change when the source next syncs.</BfAlert>}
      {error && <BfAlert tone="danger" title="Record action failed">{error}</BfAlert>}
    </BfDialog>
  </>;
}
