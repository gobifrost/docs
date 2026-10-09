import { useCallback, useEffect, useRef, useState } from "react";
import { Play, RefreshCw, RotateCcw, Trash2, XCircle } from "lucide-react";
import { useWorkflowMutation } from "bifrost";
import { BfAlert } from "./bifrost/BfAlert";
import { BfButton } from "./bifrost/BfButton";
import { BfDialog } from "./bifrost/BfDialog";

type RecoveryState = "idle" | "queued" | "waiting" | "running" | "cancelling" | "cancelled" | "interrupted" | "completed" | "completed_with_errors";
export type ExportRecoveryStatus = {
  run_id: string;
  status: RecoveryState;
  phase: string;
  total_files: number;
  recovered_files: number;
  skipped_files: number;
  failed_files: number;
  bytes_transferred: number;
  export_index: number;
  export_count: number;
  updated_at: string | null;
  last_error: string | null;
};

const START_REF = "functions/export_recovery.py::docs_export_recovery_start";
const STATUS_REF = "functions/export_recovery.py::docs_export_recovery_status";
const RESUME_REF = "functions/export_recovery.py::docs_export_recovery_resume";
const CANCEL_REF = "functions/export_recovery.py::docs_export_recovery_cancel";
const DISCARD_REF = "functions/export_recovery.py::docs_export_recovery_discard";
const ACTIVE_RECOVERY = new Set<RecoveryState>(["queued", "waiting", "running", "cancelling"]);
const MAIN_TERMINAL = new Set(["completed", "completed_with_errors", "failed", "interrupted", "cancelled"]);

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}
function statusLabel(status: RecoveryState) {
  if (status === "idle") return "No file recovery is running.";
  if (status === "queued") return "File recovery is queued.";
  if (status === "waiting") return "File recovery is waiting for its export.";
  if (status === "running") return "File recovery is running.";
  if (status === "cancelling") return "File recovery is cancelling.";
  if (status === "cancelled") return "File recovery was cancelled.";
  if (status === "interrupted") return "File recovery was interrupted.";
  if (status === "completed") return "File recovery complete.";
  return "File recovery completed with errors.";
}

/** Controls the bounded, server-authorized recovery of failed non-password exports. */
export function ExportRecoveryPanel({ runId, migrationStatus }: { runId: string; migrationStatus: string }) {
  const start = useWorkflowMutation(START_REF);
  const status = useWorkflowMutation<ExportRecoveryStatus>(STATUS_REF);
  const resume = useWorkflowMutation(RESUME_REF);
  const cancel = useWorkflowMutation(CANCEL_REF);
  const discard = useWorkflowMutation(DISCARD_REF);
  const statusMutation = useRef(status.mutate);
  const startMutation = useRef(start.mutate);
  const resumeMutation = useRef(resume.mutate);
  const cancelMutation = useRef(cancel.mutate);
  const discardMutation = useRef(discard.mutate);
  statusMutation.current = status.mutate;
  startMutation.current = start.mutate;
  resumeMutation.current = resume.mutate;
  cancelMutation.current = cancel.mutate;
  discardMutation.current = discard.mutate;
  const runRef = useRef(runId);
  runRef.current = runId;
  const requestRef = useRef(0);
  const [snapshot, setSnapshot] = useState<ExportRecoveryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<"start" | "discard" | null>(null);
  const [action, setAction] = useState<"start" | "resume" | "cancel" | "discard" | null>(null);

  const refresh = useCallback(async () => {
    const requestedRun = runId;
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const result = await statusMutation.current({ run_id: requestedRun });
      if (request !== requestRef.current || runRef.current !== requestedRun || result.run_id !== requestedRun) return;
      setSnapshot(result);
      setError("");
    } catch (failure) {
      if (request !== requestRef.current || runRef.current !== requestedRun) return;
      setSnapshot(null);
      setError(errorText(failure));
    } finally {
      if (request === requestRef.current && runRef.current === requestedRun) setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    requestRef.current += 1;
    setSnapshot(null); setError(""); setLoading(true); setConfirmation(null); setAction(null);
    void refresh();
  }, [runId, refresh]);

  const recoveryActive = snapshot ? ACTIVE_RECOVERY.has(snapshot.status) : false;
  useEffect(() => {
    if (!recoveryActive) return;
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [recoveryActive, refresh]);

  const mainTerminal = MAIN_TERMINAL.has(migrationStatus);
  const actionBusy = action !== null || start.loading || resume.loading || cancel.loading || discard.loading;
  const canStart = Boolean(snapshot && (snapshot.status === "idle" || snapshot.status === "completed_with_errors") && mainTerminal && !recoveryActive);
  const isRestart = snapshot?.status === "completed_with_errors";
  const stoppedRecovery = snapshot?.status === "cancelled" || snapshot?.status === "interrupted";
  const canResume = Boolean(stoppedRecovery && mainTerminal && !recoveryActive);
  const canDiscard = Boolean(stoppedRecovery && mainTerminal && !recoveryActive);
  const progress = snapshot && snapshot.total_files > 0 ? Math.min(snapshot.total_files, snapshot.recovered_files + snapshot.skipped_files + snapshot.failed_files) : 0;

  async function runAction(kind: "start" | "resume" | "cancel" | "discard") {
    const requestedRun = runId;
    setAction(kind); setError("");
    try {
      if (kind === "start") await startMutation.current({ run_id: requestedRun });
      if (kind === "resume") await resumeMutation.current({ run_id: requestedRun });
      if (kind === "cancel") await cancelMutation.current({ run_id: requestedRun });
      if (kind === "discard") await discardMutation.current({ run_id: requestedRun });
      if (runRef.current === requestedRun) await refresh();
    } catch (failure) {
      if (runRef.current === requestedRun) setError(errorText(failure));
    } finally {
      if (runRef.current === requestedRun) setAction(null);
    }
  }

  return (
    <section className="operation-panel min-w-0" aria-labelledby="file-recovery-heading">
      <div className="panel-heading">
        <div><p className="section-kicker">3. Recover failed exports</p><h2 id="file-recovery-heading">File recovery</h2></div>
        <BfButton variant="ghost" icon={<RefreshCw className={loading ? "spin" : ""} size={16} />} disabled={loading || actionBusy} onClick={() => void refresh()}>Refresh</BfButton>
      </div>
      {loading && !snapshot ? <p className="text-sm text-muted-foreground">Loading file recovery status…</p> : null}
      {error ? <BfAlert tone="danger" title="File recovery status could not load" action={<BfButton variant="secondary" disabled={loading || actionBusy} onClick={() => void refresh()}>Retry</BfButton>}>{error}</BfAlert> : null}
      {snapshot ? <div className="grid gap-3">
        <p className="text-sm font-medium" aria-live="polite">{statusLabel(snapshot.status)}</p>
        <p className="text-xs text-muted-foreground">Phase: {snapshot.phase || "pending"}</p>
        {snapshot.total_files > 0 ? <div className="grid gap-1"><progress className="w-full" max={snapshot.total_files} value={progress} aria-label="File recovery progress" /><p className="text-xs text-muted-foreground">{progress.toLocaleString()} of {snapshot.total_files.toLocaleString()} files processed · export {Math.max(0, snapshot.export_index).toLocaleString()} of {Math.max(0, snapshot.export_count).toLocaleString()}</p></div> : null}
        <div className="count-grid" aria-label="File recovery counts"><div><strong>{snapshot.recovered_files.toLocaleString()}</strong><span>Recovered</span></div><div><strong>{snapshot.skipped_files.toLocaleString()}</strong><span>Skipped</span></div><div><strong>{snapshot.failed_files.toLocaleString()}</strong><span>Failed</span></div><div><strong>{formatBytes(snapshot.bytes_transferred)}</strong><span>Transferred</span></div></div>
        {snapshot.last_error ? <BfAlert tone="warning" title="Latest recovery issue">{snapshot.last_error}</BfAlert> : null}
        {!mainTerminal ? <BfAlert tone="info" title="Waiting for migration">File recovery is available after the migration reaches a terminal state.</BfAlert> : null}
        {snapshot.status === "completed" ? <BfAlert tone="info" title="Next step">Retry migration failures to validate repaired files and finish their parent records.</BfAlert> : null}
        <div className="run-actions flex-wrap">
          <BfButton disabled={!canStart || actionBusy} icon={<Play size={15} />} onClick={() => setConfirmation("start")}>{isRestart ? "Restart file recovery" : "Recover files"}</BfButton>
          <BfButton variant="secondary" disabled={actionBusy || !canResume} icon={<RotateCcw size={15} />} onClick={() => void runAction("resume")}>Resume file recovery</BfButton>
          {stoppedRecovery ? <BfButton variant="danger" disabled={actionBusy || !canDiscard} icon={<Trash2 size={15} />} onClick={() => setConfirmation("discard")}>Discard recovery</BfButton> : null}
          <BfButton variant="danger" disabled={actionBusy || !recoveryActive || !mainTerminal} icon={<XCircle size={15} />} onClick={() => void runAction("cancel")}>Cancel file recovery</BfButton>
        </div>
      </div> : null}
      <BfDialog open={confirmation !== null} onOpenChange={(open) => { if (!open && !actionBusy) setConfirmation(null); }} title={confirmation === "discard" ? "Discard file recovery?" : "Recover failed files?"} description={confirmation === "discard" ? "Remove this stopped recovery state before starting again." : "Review this bounded recovery before it starts."} footer={<><BfButton variant="secondary" disabled={actionBusy} onClick={() => setConfirmation(null)}>Back</BfButton><BfButton variant={confirmation === "discard" ? "danger" : "primary"} disabled={actionBusy} icon={confirmation === "discard" ? <Trash2 size={15} /> : <Play size={15} />} onClick={() => { const kind = confirmation; setConfirmation(null); if (kind) void runAction(kind); }}>{confirmation === "discard" ? "Discard recovery" : isRestart ? "Restart recovery" : "Recover files"}</BfButton></>}><p>{confirmation === "discard" ? "Discard removes the stopped recovery’s held encrypted exports and recovery state. Already recovered files are retained." : "Recovery selects failed non-password files from this migration only. It uses remotely held, encrypted, organization-scoped exports; password values are never recovered or exposed."}</p></BfDialog>
    </section>
  );
}
