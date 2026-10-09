import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refs = {
  start: "functions/export_recovery.py::docs_export_recovery_start",
  status: "functions/export_recovery.py::docs_export_recovery_status",
  resume: "functions/export_recovery.py::docs_export_recovery_resume",
  cancel: "functions/export_recovery.py::docs_export_recovery_cancel",
  discard: "functions/export_recovery.py::docs_export_recovery_discard",
};
const mocks = vi.hoisted(() => ({ mutate: new Map<string, ReturnType<typeof vi.fn>>() }));

vi.mock("bifrost", () => ({
  useWorkflowMutation: (reference: string) => ({ loading: false, mutate: mocks.mutate.get(reference) ?? vi.fn() }),
}));
vi.mock("./bifrost/BfDialog", () => ({
  BfDialog: ({ open, title, children, footer }: { open: boolean; title: string; children: React.ReactNode; footer?: React.ReactNode }) => open ? <section role="dialog" aria-label={title}><h2>{title}</h2>{children}{footer}</section> : null,
}));

import { ExportRecoveryPanel } from "./ExportRecoveryPanel";

type Recovery = Partial<{
  run_id: string; status: "idle" | "queued" | "waiting" | "running" | "cancelling" | "cancelled" | "interrupted" | "completed" | "completed_with_errors";
  phase: string; total_files: number; recovered_files: number; skipped_files: number; failed_files: number; bytes_transferred: number; export_index: number; export_count: number; updated_at: string | null; last_error: string | null;
}>;
function recovery(values: Recovery = {}) {
  return { run_id: "run-a", status: "idle" as const, phase: "ready", total_files: 0, recovered_files: 0, skipped_files: 0, failed_files: 0, bytes_transferred: 0, export_index: 0, export_count: 0, updated_at: null, last_error: null, ...values };
}
function setup(status: (args: { run_id: string }) => Promise<ReturnType<typeof recovery>>) {
  mocks.mutate.clear();
  mocks.mutate.set(refs.status, vi.fn(status));
  mocks.mutate.set(refs.start, vi.fn().mockResolvedValue({}));
  mocks.mutate.set(refs.resume, vi.fn().mockResolvedValue({}));
  mocks.mutate.set(refs.cancel, vi.fn().mockResolvedValue({}));
  mocks.mutate.set(refs.discard, vi.fn().mockResolvedValue({}));
}

describe("ExportRecoveryPanel", () => {
  beforeEach(() => setup(async () => recovery()));
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("requires confirmation before starting recovery for the current run", async () => {
    render(<ExportRecoveryPanel runId="run-a" migrationStatus="completed_with_errors" />);
    await screen.findByText("No file recovery is running.");
    expect(mocks.mutate.get(refs.status)).toHaveBeenCalledWith({ run_id: "run-a" });
    fireEvent.click(screen.getByRole("button", { name: "Recover files" }));
    expect(mocks.mutate.get(refs.start)).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Recover failed files?" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Recover failed files?" })).getByRole("button", { name: "Recover files" }));
    await waitFor(() => expect(mocks.mutate.get(refs.start)).toHaveBeenCalledWith({ run_id: "run-a" }));
  });

  it("disables recovery while the main migration is active", async () => {
    render(<ExportRecoveryPanel runId="run-a" migrationStatus="running" />);
    await screen.findByText("No file recovery is running.");
    expect(screen.getByRole("button", { name: "Recover files" })).toBeDisabled();
    expect(screen.getByText(/available after the migration reaches a terminal state/i)).toBeInTheDocument();
  });

  it("cancels an active recovery and resumes an interrupted one", async () => {
    setup(async () => recovery({ status: "running", total_files: 10, recovered_files: 3 }));
    const view = render(<ExportRecoveryPanel runId="run-a" migrationStatus="completed_with_errors" />);
    await screen.findByText("File recovery is running.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel file recovery" }));
    await waitFor(() => expect(mocks.mutate.get(refs.cancel)).toHaveBeenCalledWith({ run_id: "run-a" }));

    setup(async ({ run_id }) => recovery({ run_id, status: "interrupted", last_error: "Worker stopped" }));
    view.rerender(<ExportRecoveryPanel runId="run-b" migrationStatus="completed_with_errors" />);
    await screen.findByText("File recovery was interrupted.");
    fireEvent.click(screen.getByRole("button", { name: "Resume file recovery" }));
    await waitFor(() => expect(mocks.mutate.get(refs.resume)).toHaveBeenCalledWith({ run_id: "run-b" }));
  });

  it("confirms discard for a stopped recovery with the current run and disables resume while migration is active", async () => {
    setup(async ({ run_id }) => recovery({ run_id, status: "cancelled" }));
    const view = render(<ExportRecoveryPanel runId="run-a" migrationStatus="completed_with_errors" />);
    await screen.findByText("File recovery was cancelled.");
    fireEvent.click(screen.getByRole("button", { name: "Discard recovery" }));
    expect(mocks.mutate.get(refs.discard)).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Discard file recovery?" });
    expect(dialog).toHaveTextContent(/already recovered files are retained/i);
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard recovery" }));
    await waitFor(() => expect(mocks.mutate.get(refs.discard)).toHaveBeenCalledWith({ run_id: "run-a" }));

    setup(async ({ run_id }) => recovery({ run_id, status: "interrupted" }));
    view.rerender(<ExportRecoveryPanel runId="run-b" migrationStatus="running" />);
    await screen.findByText("File recovery was interrupted.");
    expect(screen.getByRole("button", { name: "Resume file recovery" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard recovery" })).toBeDisabled();
  });

  it("discards a stale status response after the migration run changes", async () => {
    let resolveOld!: (value: ReturnType<typeof recovery>) => void;
    setup(async ({ run_id }) => run_id === "run-a"
      ? new Promise((resolve) => { resolveOld = resolve; })
      : recovery({ run_id: "run-b", status: "completed", total_files: 2, recovered_files: 2 }));
    const view = render(<ExportRecoveryPanel runId="run-a" migrationStatus="completed" />);
    view.rerender(<ExportRecoveryPanel runId="run-b" migrationStatus="completed" />);
    await screen.findByText("File recovery complete.");
    resolveOld(recovery({ run_id: "run-a", status: "running" }));
    await waitFor(() => expect(screen.queryByText("File recovery is running.")).not.toBeInTheDocument());
    expect(screen.getByText("File recovery complete.")).toBeInTheDocument();
  });

  it("does not refresh a newly selected run when an older start finishes", async () => {
    let resolveStart!: () => void;
    setup(async ({ run_id }) => recovery({ run_id }));
    mocks.mutate.set(refs.start, vi.fn(() => new Promise<void>((resolve) => { resolveStart = resolve; })));
    const view = render(<ExportRecoveryPanel runId="run-a" migrationStatus="completed" />);
    await screen.findByText("No file recovery is running.");
    fireEvent.click(screen.getByRole("button", { name: "Recover files" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Recover failed files?" })).getByRole("button", { name: "Recover files" }));
    await waitFor(() => expect(mocks.mutate.get(refs.start)).toHaveBeenCalledWith({ run_id: "run-a" }));
    view.rerender(<ExportRecoveryPanel runId="run-b" migrationStatus="completed" />);
    await screen.findByText("No file recovery is running.");
    const statusCallsForB = mocks.mutate.get(refs.status)!.mock.calls.filter(([value]) => value.run_id === "run-b").length;
    resolveStart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.mutate.get(refs.status)!.mock.calls.filter(([value]) => value.run_id === "run-b")).toHaveLength(statusCallsForB);
  });

  it("shows retryable status failures and completed counts", async () => {
    let attempts = 0;
    setup(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Unavailable");
      return recovery({ status: "completed", total_files: 4, recovered_files: 3, skipped_files: 1, bytes_transferred: 2048 });
    });
    render(<ExportRecoveryPanel runId="run-a" migrationStatus="completed" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("File recovery status could not load");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("File recovery complete.")).toBeInTheDocument();
    expect(within(screen.getByLabelText("File recovery counts")).getByText("Recovered")).toBeInTheDocument();
    expect(within(screen.getByLabelText("File recovery counts")).getByText("3")).toBeInTheDocument();
    expect(screen.getByText(/retry migration failures to validate repaired files/i)).toBeInTheDocument();
  });
});
