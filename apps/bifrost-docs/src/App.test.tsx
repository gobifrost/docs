import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  viewer: { is_superuser: false, roles: [] as string[] },
  mutate: vi.fn(),
  query: vi.fn(),
  get: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  download: vi.fn(),
  upload: vi.fn(),
  workflowQuery: vi.fn(),
}));

vi.mock("bifrost", () => ({
  BifrostHeader: ({ title, action, logo }: { title: string; action: React.ReactNode; logo?: string | null }) => <header data-logo={logo === null ? "none" : "default"}><h1>{title}</h1>{action}</header>,
  FileAccessDeniedError: class FileAccessDeniedError extends Error {},
  FilePolicyError: class FilePolicyError extends Error {},
  TableAccessDeniedError: class TableAccessDeniedError extends Error {},
  files: { download: mocks.download, upload: mocks.upload, delete: vi.fn() },
  tables: { query: mocks.query, get: mocks.get, insert: mocks.insert, update: mocks.update, delete: mocks.delete, subscribe: mocks.subscribe },
  useBifrostContext: () => ({ authedFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => mocks.viewer }) }),
  useWorkflowMutation: (reference: string) => ({ loading: false, mutate: reference === "functions/catalog.py::docs_list_organizations"
    ? async () => ({ caller_mode: "picker", own_organization_id: null, organizations: [{ id: "org-1", name: "Northern Star" }] })
    : (values: unknown) => mocks.mutate(reference, values) }),
  useWorkflowQuery: (reference: string, params: unknown) => mocks.workflowQuery(reference, params),
}));

vi.mock("./components/bifrost/BfDialog", () => ({
  BfDialog: ({ open, onOpenChange, title, description, children, footer }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: React.ReactNode; footer?: React.ReactNode }) => open ? <dialog open aria-label={title} onCancel={event => { event.preventDefault(); onOpenChange(false); }}><h2>{title}</h2>{description ? <p>{description}</p> : null}{children}{footer}</dialog> : null,
}));

import App from "./App";

const draft = { id: "document-1", data: { name: "Draft runbook", content: "Draft content", source_system: "bifrost", status: "draft", organization_id: "org-1", restricted: false } };

function renderApp(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

function RouteChange({ to }: { to: string | null }) {
  const navigate = useNavigate();
  useEffect(() => { if (to) navigate(to); }, [navigate, to]);
  return null;
}

function readerResize() {
  const observers = new Map<Element, (entries: Array<{ contentRect: { width: number } }>) => void>();
  vi.stubGlobal("ResizeObserver", class {
    private nodes = new Set<Element>();
    constructor(private callback: (entries: Array<{ contentRect: { width: number } }>) => void) {}
    observe(node: Element) { this.nodes.add(node); observers.set(node, this.callback); }
    disconnect() { this.nodes.forEach(node => observers.delete(node)); }
  });
  return (width: number) => act(() => {
    for (const [node, callback] of observers) {
      if (node.classList.contains("document-tools-layout")) callback([{ contentRect: { width } }]);
    }
  });
}

describe("Bifrost Docs write access and confirmations", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mocks.viewer = { is_superuser: false, roles: [] };
    mocks.mutate.mockReset().mockResolvedValue({});
    mocks.query.mockReset().mockResolvedValue({ documents: [], total: 0 });
    mocks.get.mockReset().mockResolvedValue(draft);
    mocks.insert.mockReset().mockResolvedValue({ id: "new-record" });
    mocks.update.mockReset().mockResolvedValue({});
    mocks.delete.mockReset().mockResolvedValue({});
    mocks.subscribe.mockReset().mockReturnValue(mocks.unsubscribe);
    mocks.unsubscribe.mockReset();
    mocks.download.mockReset();
    mocks.upload.mockReset().mockResolvedValue({});
    mocks.workflowQuery.mockReset().mockReturnValue({ data: undefined, loading: false, error: null, refresh: vi.fn() });
  });

  it("explains checkpoint validation instead of showing a running retry as complete", async () => {
    mocks.viewer = { is_superuser: true, roles: [] };
    mocks.workflowQuery.mockImplementation((reference: string) => ({
      loading: false, error: null, refresh: vi.fn(),
      data: reference.endsWith("::docs_migration_status") ? {
        run: { id: "retry-run", status: "running", mode: "bulk", phase: "complete" },
        runs: [], counts: { succeeded: 10, pending: 1 }, failures: [], findings: [],
      } : undefined,
    }));
    renderApp("/migration");
    expect(await screen.findByText("Checking saved progress", { exact: true })).toBeVisible();
    expect(screen.queryByText("complete", { exact: true })).not.toBeInTheDocument();
  });

  it("lets administrators select a migration by scope and date without entering a run ID", async () => {
    mocks.viewer = { is_superuser: true, roles: [] };
    const refresh = vi.fn();
    mocks.workflowQuery.mockImplementation((reference: string) => ({
      loading: false, error: null, refresh,
      data: reference.endsWith("::docs_migration_status") ? {
        run: { id: "bulk-run", status: "completed_with_errors", mode: "bulk", phase: "complete" },
        runs: [
          { id: "verification-run", status: "completed", mode: "bulk", organization_count: 1, resource_count: 1, started_at: "2026-10-02T21:25:00Z", recovery_status: null },
          { id: "bulk-run", status: "completed_with_errors", mode: "bulk", organization_count: 87, resource_count: 10, started_at: "2026-10-02T12:00:00Z", recovery_status: "running" },
        ], counts: {}, failures: [], findings: [],
      } : undefined,
    }));
    renderApp("/migration");
    const picker = await screen.findByRole("combobox", { name: "Migration run" });
    expect(picker).toHaveTextContent("87 organizations");
    expect(screen.queryByLabelText("Run ID")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load run" })).not.toBeInTheDocument();
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: /1 organization ·/ }));
    expect(refresh).toHaveBeenCalledWith({ run_id: "verification-run" });
  });

  it("opts out of the optional deployed app-logo request when no Docs logo is configured", async () => {
    renderApp("/");
    await screen.findByRole("heading", { name: "Dashboard" });
    expect(document.querySelector("header[data-logo]")).toHaveAttribute("data-logo", "none");
    expect(document.querySelectorAll("header[data-logo]")).toHaveLength(1);
  });

  it("opens organization documentation from a named card without displaying its internal identifier", async () => {
    renderApp("/organizations");
    const card = await screen.findByRole("button", { name: /^Northern Star/ });
    expect(card).not.toHaveTextContent("org-1");
    expect(card).toHaveTextContent("Open documentation");
    fireEvent.click(card);
    await screen.findByRole("heading", { name: "Northern Star" });
  });

  it("keeps the catalog focused on records without platform-access boilerplate or duplicate descriptions", async () => {
    renderApp("/org/org-1/documents");
    await screen.findByRole("heading", { name: "Documents" });
    expect(screen.queryByText("Tenant access is enforced by Bifrost.")).not.toBeInTheDocument();
    expect(screen.queryByText("Source documentation imported from IT Glue.")).not.toBeInTheDocument();
    expect(screen.getAllByText("Runbooks, guides, and organization documentation.")).toHaveLength(1);
  });

  it("shows grouped bulk actions only after selecting records", async () => {
    mocks.viewer = { is_superuser: true, roles: [] };
    mocks.query.mockImplementation(async (table: string) => table === "docs-documents"
      ? { documents: [{ id: "native-document", data: { name: "Native runbook", source_system: "bifrost", archived: false } }], total: 1 }
      : { documents: [], total: 0 });
    renderApp("/org/org-1/documents");
    await screen.findByRole("checkbox", { name: "Select row native-document" });
    expect(screen.queryByRole("button", { name: "Archive selected" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move selected" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row native-document" }));
    const actions = screen.getByRole("group", { name: "Selected record actions" });
    expect(within(actions).getByRole("button", { name: "Archive selected" })).toBeEnabled();
    expect(within(actions).getByRole("button", { name: "Move selected" })).toBeEnabled();
  });

  it("warns about imported-field replacement when editing rather than while reading", async () => {
    mocks.viewer = { is_superuser: true, roles: [] };
    mocks.get.mockResolvedValue({ id: "config-1", data: { name: "Edge firewall", source_system: "itglue", organization_id: "org-1" } });
    renderApp("/org/org-1/configurations/config-1");
    await screen.findByRole("heading", { name: "Edge firewall" });
    expect(screen.queryByText(/Your edits remain available until/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(within(screen.getByRole("dialog", { name: "Edit Configuration" })).getByText(/Your edits remain available until/)).toBeInTheDocument();
  });

  it.each([
    ["configurations", "configuration", "docs-configurations"],
    ["locations", "location", "docs-locations"],
    ["flexible-assets", "flexible asset", "docs-flexible-assets"],
  ])("changes %s enabled state from its detail with explicit record scope", async (kind, singular, table) => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    mocks.get.mockResolvedValue({ id: "record-1", data: { name: "Native record", source_system: "bifrost", organization_id: "org-1", is_enabled: true, restricted: false } });
    renderApp(`/org/org-1/${kind}/record-1`);
    fireEvent.click(await screen.findByRole("button", { name: `Disable ${singular}` }));
    const confirmation = screen.getByRole("dialog", { name: `Disable ${singular}?` });
    expect(within(confirmation).queryByText(/IT Glue/)).not.toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: `Disable ${singular}` }));
    mocks.get.mockResolvedValue({ id: "record-1", data: { name: "Native record", source_system: "bifrost", organization_id: "org-1", is_enabled: false, restricted: false } });
    fireEvent.click(within(screen.getByRole("dialog", { name: `Disable ${singular}?` })).getByRole("button", { name: "Disable record" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(table, "record-1", { is_enabled: false }, "org-1"));
    expect(await screen.findByRole("button", { name: `Enable ${singular}` })).toBeEnabled();
    expect(screen.getByText("Disabled")).toBeVisible();
  });

  it("warns about source overwrite only when confirming an imported enabled-state change", async () => {
    mocks.viewer = { is_superuser: true, roles: [] };
    mocks.get.mockResolvedValue({ id: "config-1", data: { name: "Imported firewall", source_system: "itglue", organization_id: "org-1", is_enabled: false } });
    renderApp("/configurations/config-1");
    fireEvent.click(await screen.findByRole("button", { name: "Enable configuration" }));
    const confirmation = screen.getByRole("dialog", { name: "Enable configuration?" });
    expect(within(confirmation).getByText(/IT Glue may overwrite/)).toBeVisible();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Enable record" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("docs-configurations", "config-1", { is_enabled: true }, "org-1"));
  });

  it.each([
    ["configurations", [], false],
    ["configurations", ["Bifrost Docs Editor"], true],
    ["passwords", ["Bifrost Docs Administrator"], false],
    ["documents", ["Bifrost Docs Administrator"], false],
  ])("hides enabled-state actions for unsupported or unauthorized %s details", async (kind, roles, restricted) => {
    mocks.viewer = { is_superuser: false, roles };
    mocks.get.mockResolvedValue({ id: "record-1", data: { name: "Read-only record", source_system: "bifrost", organization_id: "org-1", is_enabled: false, restricted } });
    renderApp(`/org/org-1/${kind}/record-1`);
    await screen.findByRole("heading", { name: "Read-only record" });
    expect(screen.queryByRole("button", { name: /^(Enable|Disable) / })).not.toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([new Error("permission denied"), null])("preserves enabled state after failed or missing-record updates: %s", async (failure) => {
    mocks.viewer = { is_superuser: true, roles: [] };
    mocks.get.mockResolvedValue({ id: "config-1", data: { name: "Native firewall", source_system: "bifrost", organization_id: "org-1", is_enabled: true } });
    if (failure) mocks.update.mockRejectedValue(failure); else mocks.update.mockResolvedValue(null);
    renderApp("/org/org-1/configurations/config-1");
    fireEvent.click(await screen.findByRole("button", { name: "Disable configuration" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Disable configuration?" })).getByRole("button", { name: "Disable record" }));
    expect(await screen.findByText(failure ? "Your Bifrost role cannot change this record." : "This record is no longer available. Refresh the page before trying again.")).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Disable configuration?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable configuration" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Enable configuration" })).not.toBeInTheDocument();
  });

  it("prevents duplicate enabled-state writes while saving and disables the action during editing", async () => {
    let complete: ((value: unknown) => void) | undefined;
    mocks.viewer = { is_superuser: true, roles: [] };
    mocks.get.mockResolvedValue({ id: "config-1", data: { name: "Native firewall", source_system: "bifrost", organization_id: "org-1", is_enabled: true } });
    mocks.update.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    renderApp("/org/org-1/configurations/config-1");
    const action = await screen.findByRole("button", { name: "Disable configuration" });
    fireEvent.click(action);
    const confirmation = screen.getByRole("dialog", { name: "Disable configuration?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Disable record" }));
    expect(action).toBeDisabled();
    const saving = within(confirmation).getByRole("button", { name: "Saving" });
    expect(saving).toBeDisabled();
    fireEvent.click(saving);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    act(() => { complete!({ id: "config-1" }); });
    await waitFor(() => expect(action).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(action).toBeDisabled();
  });

  it("keeps the confirmed enabled-state action stable through a realtime record change", async () => {
    mocks.viewer = { is_superuser: true, roles: [] };
    mocks.get.mockResolvedValue({ id: "config-1", table_id: "configuration-table", data: { name: "Native firewall", source_system: "bifrost", organization_id: "org-1", is_enabled: true } });
    renderApp("/org/org-1/configurations/config-1");
    fireEvent.click(await screen.findByRole("button", { name: "Disable configuration" }));
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith("configuration-table", expect.anything(), expect.any(Function), expect.any(Function)));
    mocks.get.mockResolvedValue({ id: "config-1", table_id: "configuration-table", data: { name: "Native firewall", source_system: "bifrost", organization_id: "org-1", is_enabled: false } });
    const onEvent = mocks.subscribe.mock.calls.find(([table]) => table === "configuration-table")![2];
    act(() => onEvent({ type: "subscribed" }));
    await screen.findByRole("button", { name: "Enable configuration" });
    const confirmation = screen.getByRole("dialog", { name: "Disable configuration?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Disable record" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("docs-configurations", "config-1", { is_enabled: false }, "org-1"));
  });

  it("keeps the enabled-state trigger available for focus restoration during a background read", async () => {
    mocks.viewer = { is_superuser: true, roles: [] };
    mocks.get.mockResolvedValue({ id: "config-1", table_id: "configuration-table", data: { name: "Native firewall", source_system: "bifrost", organization_id: "org-1", is_enabled: true } });
    renderApp("/org/org-1/configurations/config-1");
    const action = await screen.findByRole("button", { name: "Disable configuration" });
    fireEvent.click(action);
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith("configuration-table", expect.anything(), expect.any(Function), expect.any(Function)));
    mocks.get.mockImplementation(() => new Promise(() => {}));
    const onEvent = mocks.subscribe.mock.calls.find(([table]) => table === "configuration-table")![2];
    act(() => onEvent({ type: "subscribed" }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("dialog", { name: "Disable configuration?" })).toBeInTheDocument();
    expect(action).toBeEnabled();
  });

  it("keeps imported record details focused on the record and its source link", async () => {
    mocks.viewer = { is_superuser: true, roles: [] };
    mocks.get.mockResolvedValue({ id: "config-1", data: { name: "Edge firewall", source_system: "itglue", source_id: "source-42", source_url: "https://example.invalid/configuration", organization_id: "org-1" } });
    renderApp("/org/org-1/configurations/config-1");
    await screen.findByRole("heading", { name: "Edge firewall" });
    expect(screen.queryByText("IT Glue source")).not.toBeInTheDocument();
    expect(screen.queryByText("Source provenance")).not.toBeInTheDocument();
    expect(screen.queryByText(/Bifrost record config-1/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open source" })).toHaveAttribute("href", "https://example.invalid/configuration");
    expect(screen.getByText("No related items yet.")).toBeInTheDocument();
  });

  it("describes a native record deletion without an unrelated source-sync warning", async () => {
    mocks.viewer = { is_superuser: true, roles: [] };
    mocks.get.mockResolvedValue({ id: "config-1", data: { name: "Native firewall", source_system: "bifrost", organization_id: "org-1" } });
    renderApp("/org/org-1/configurations/config-1");
    await screen.findByRole("heading", { name: "Native firewall" });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Configuration?" });
    expect(within(dialog).getByText("This removes the record from Bifrost Docs.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/IT Glue/)).not.toBeInTheDocument();
  });

  it.each(["/org/org-1/documents/document-1", "/org/org-1/documents/new"])("preserves document navigation while working at %s", async (path) => {
    mocks.viewer = { is_superuser: true, roles: [] };
    renderApp(path);
    await screen.findByRole("heading", { name: path.endsWith("new") ? "New draft" : "Draft runbook" });
    expect(screen.getByRole("complementary", { name: "Document folders" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize document navigation" })).toBeInTheDocument();
  });

  it("offers a compact record-type picker that changes the queried catalog", async () => {
    renderApp("/browse");
    const picker = await screen.findByRole("combobox", { name: "Record type" });
    fireEvent.change(picker, { target: { value: "configurations" } });
    await screen.findByRole("table", { name: "Configurations" });
    expect(mocks.query).toHaveBeenCalledWith("docs-configurations", expect.any(Object));
  });

  it("keeps browsing available to readers while hiding write controls", async () => {
    mocks.query.mockImplementation(async (table: string) => table === "docs-attachments"
      ? { documents: [{ id: "attachment-1", data: { file_name: "evidence.pdf", content_type: "application/pdf", size_bytes: 1024 } }], total: 1 }
      : table === "docs-relationships"
        ? { documents: [{ id: "relationship-1", data: { target_type: "documents", target_source_id: "related-1", relationship_type: "related" } }], total: 1 }
        : { documents: [], total: 0 });
    renderApp("/documents/document-1");

    await screen.findByRole("heading", { name: "Draft runbook" });
    fireEvent.click(screen.getByRole("button", { name: "Related items" }));
    await screen.findByText("Document unavailable");

    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add related item" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attachments" })).toBeInTheDocument();
  });

  it("keeps the reader and open inspector mounted during background record refresh", async () => {
    let finishRefresh: ((result: unknown) => void) | undefined;
    mocks.get.mockResolvedValueOnce({ ...draft, table_id: "documents-canonical-uuid" })
      .mockImplementation(() => new Promise(resolve => { finishRefresh = resolve; }));
    renderApp("/org/org-1/documents/document-1");
    await screen.findByRole("heading", { name: "Draft runbook" });
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith("documents-canonical-uuid", expect.anything(), expect.any(Function), expect.any(Function)));
    fireEvent.click(screen.getByRole("button", { name: "Attachments" }));
    const inspector = await screen.findByRole("dialog", { name: "Attachments" });
    const onEvent = mocks.subscribe.mock.calls.find(([table]) => table === "documents-canonical-uuid")![2];
    act(() => onEvent({ type: "subscribed" }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));

    expect(screen.getByRole("heading", { name: "Draft runbook" })).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Attachments" })).toBe(inspector);
    await act(async () => finishRefresh!({ ...draft, table_id: "documents-canonical-uuid", data: { ...draft.data, name: "Updated runbook" } }));
    expect(await screen.findByRole("heading", { name: "Updated runbook" })).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Attachments" })).toBe(inspector);
  });

  it("clears the reader and inspector when record subscription access is revoked", async () => {
    let rejectRefresh: ((error: Error) => void) | undefined;
    mocks.get.mockResolvedValueOnce({ ...draft, table_id: "documents-canonical-uuid" })
      .mockImplementation(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }));
    renderApp("/org/org-1/documents/document-1");
    await screen.findByRole("heading", { name: "Draft runbook" });
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith("documents-canonical-uuid", expect.anything(), expect.any(Function), expect.any(Function)));
    fireEvent.click(screen.getByRole("button", { name: "Attachments" }));
    await screen.findByRole("dialog", { name: "Attachments" });
    const onEvent = mocks.subscribe.mock.calls.find(([table]) => table === "documents-canonical-uuid")![2];
    act(() => onEvent({ type: "subscription_revoked" }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));

    expect(screen.queryByRole("heading", { name: "Draft runbook" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Attachments" })).not.toBeInTheDocument();
    await act(async () => rejectRefresh!(new Error("403 access denied")));
    expect(await screen.findByText("Record access denied")).toBeVisible();
  });

  it("clears the previous reader before the next record snapshot resolves", async () => {
    let finishNext: ((result: unknown) => void) | undefined;
    mocks.get.mockResolvedValueOnce(draft)
      .mockImplementation(() => new Promise(resolve => { finishNext = resolve; }));
    const view = render(<MemoryRouter initialEntries={["/org/org-1/documents/document-1"]}><RouteChange to={null} /><App /></MemoryRouter>);
    await screen.findByRole("heading", { name: "Draft runbook" });
    fireEvent.click(screen.getByRole("button", { name: "Attachments" }));
    await screen.findByRole("dialog", { name: "Attachments" });
    view.rerender(<MemoryRouter initialEntries={["/org/org-1/documents/document-1"]}><RouteChange to="/org/org-1/documents/document-2" /><App /></MemoryRouter>);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith("docs-documents", "document-2", "org-1"));

    expect(screen.queryByRole("heading", { name: "Draft runbook" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Attachments" })).not.toBeInTheDocument();
    await act(async () => finishNext!({ id: "document-2", data: { ...draft.data, name: "Second runbook" } }));
    expect(await screen.findByRole("heading", { name: "Second runbook" })).toBeVisible();
  });

  it("refreshes the authoritative record after cancelling a dirty editor without writing the draft", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    mocks.get.mockResolvedValueOnce({ id: "document-1", data: { ...draft.data, name: "Original runbook" } })
      .mockResolvedValueOnce({ id: "document-1", data: { ...draft.data, name: "External server update" } });
    renderApp("/org/org-1/documents/document-1");

    expect(await screen.findByRole("heading", { name: "Original runbook" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Unsaved local draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(await screen.findByRole("heading", { name: "External server update" })).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("offers the same attachment upload control for supported non-document records", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    mocks.get.mockResolvedValue({ id: "config-1", data: { name: "NETBIRD", source_system: "itglue", organization_id: "org-1", restricted: false } });
    mocks.query.mockImplementation(async (table: string) => table === "docs-attachments"
      ? { documents: [{ id: "attachment-9", data: { file_name: "gonorthern-star.pem", content_type: "application/x-pem", size_bytes: 19419 } }], total: 1 }
      : { documents: [], total: 0 });
    renderApp("/configurations/config-1");

    await screen.findByRole("heading", { name: "NETBIRD" });
    expect(await screen.findByText("gonorthern-star.pem")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Download / })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload attachment" })).toBeInTheDocument();
  });

  it("opens document utilities in a dismissible phone drawer with restored focus", async () => {
    const previous = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: query === "(max-width: 820px)", addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    try {
      renderApp("/org/org-1/documents/document-1");
      const trigger = await screen.findByRole("button", { name: "Attachments" });
      expect(screen.queryByRole("dialog", { name: "Attachments" })).not.toBeInTheDocument();
      trigger.focus();
      fireEvent.click(trigger);
      const panel = await screen.findByRole("dialog", { name: "Attachments" });
      expect(panel).toHaveClass("document-tools__drawer");
      fireEvent.keyDown(panel, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Attachments" })).not.toBeInTheDocument());
      await waitFor(() => expect(trigger).toHaveFocus());
    } finally { window.matchMedia = previous; }
  });

  it("keeps embedded image registry entries out of the file attachment list", async () => {
    mocks.query.mockImplementation(async (table: string) => table === "docs-attachments" ? { documents: [
      { id: "file-1", data: { file_name: "guide.pdf", file_kind: "attachment", size_bytes: 1024 } },
      { id: "image-1", data: { file_name: "23cf0b1842ce5499", file_kind: "document_image", size_bytes: 2048 } },
    ], total: 2 } : { documents: [], total: 0 });
    renderApp("/org/org-1/documents/document-1");
    fireEvent.click(await screen.findByRole("button", { name: "Attachments" }));
    expect(await screen.findByRole("button", { name: "Download guide.pdf" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download 23cf0b1842ce5499" })).not.toBeInTheDocument();
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("uses the attachment filename as its download action rather than a file heading", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    mocks.query.mockImplementation(async (table: string) => table === "docs-attachments" ? { documents: [{ id: "attachment-1", data: { file_name: "evidence.pdf", content_type: "application/pdf", size_bytes: 1024 } }], total: 1 } : { documents: [], total: 0 });
    renderApp("/org/org-1/documents/document-1");
    fireEvent.click(await screen.findByRole("button", { name: "Attachments" }));
    const download = await screen.findByRole("button", { name: "Download evidence.pdf" });
    expect(download.textContent).toBe("evidence.pdf");
    expect(download.closest("li")!.querySelector("strong")).toBeNull();
  });

  it("uses compact document and attachment actions and stages a dropped file without uploading it", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    mocks.query.mockImplementation(async (table: string) => table === "docs-attachments"
      ? { documents: [{ id: "attachment-1", data: { file_name: "evidence.pdf", content_type: "application/pdf", size_bytes: 1024 } }], total: 1 }
      : { documents: [], total: 0 });
    renderApp("/org/org-1/documents/document-1");
    fireEvent.click(await screen.findByRole("button", { name: "Attachments" }));
    await screen.findByRole("heading", { name: "Draft runbook" });
    const article = screen.getByRole("article", { name: "Document content" });
    expect(within(article).getByRole("button", { name: "Edit" }).textContent).toBe("");
    const attachment = (await screen.findByText("evidence.pdf")).closest("li")!;
    expect(within(attachment).getByRole("button", { name: /^Download / }).textContent).toBe("evidence.pdf");
    const drop = screen.getByRole("button", { name: "Drop a file or browse" });
    fireEvent.drop(drop, { dataTransfer: { files: [new File(["hello"], "guide.pdf", { type: "application/pdf" })] } });
    expect(screen.getByRole("button", { name: "Upload attachment" })).not.toBeDisabled();
    expect(screen.getByText("guide.pdf")).toBeInTheDocument();
    expect(mocks.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Upload attachment" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("functions/attachments.py::docs_register_attachment", expect.objectContaining({ file_name: "guide.pdf", parent_document_id: "document-1", parent_type: "documents" })));
  });

  it("registers a configuration attachment with its normalized parent type and canonical path", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    mocks.get.mockResolvedValue({ id: "config-1", data: { name: "NETBIRD", source_system: "itglue", organization_id: "org-1", restricted: false } });
    mocks.query.mockResolvedValue({ documents: [], total: 0 });
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockReturnValue("cc1e9bc7-5f15-4c98-bb65-c1dc6a610b6f");
    renderApp("/configurations/config-1");

    await screen.findByRole("heading", { name: "NETBIRD" });
    fireEvent.change(screen.getByLabelText("Choose attachment"), {
      target: { files: [new File(["configuration notes"], "network guide.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload attachment" }));

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith(
      "functions/attachments.py::docs_register_attachment",
      expect.objectContaining({
        parent_document_id: "config-1",
        parent_type: "configurations",
        storage_path: "org-1/bifrost/configurations/config-1/cc1e9bc7-5f15-4c98-bb65-c1dc6a610b6f/network_guide.pdf",
      }),
    ));
    randomUUID.mockRestore();
  });

  it("provides a phone-friendly document section jump", async () => {
    mocks.get.mockResolvedValue({ id: "document-1", data: { name: "Runbook", content: "<h2>Install agent</h2><p>Steps</p>", source_system: "bifrost", status: "draft", organization_id: "org-1", restricted: false } });
    renderApp("/org/org-1/documents/document-1");

    fireEvent.click(await screen.findByRole("button", { name: "On this page" }));
    const mobileNav = screen.getByRole("navigation", { name: "Document sections" });
    expect(within(mobileNav).getByRole("link", { name: "Install agent" })).toHaveAttribute("href", "#doc-heading-1-install-agent");
  });

  it("keeps imported document table semantics inside keyboard-accessible scrolling regions", async () => {
    mocks.get.mockResolvedValue({ id: "document-1", data: { name: "Process", organization_id: "org-1", source_system: "itglue", content: '<table><caption>Service tasks</caption><colgroup><col span="2"></colgroup><thead><tr><th scope="col">Board</th><th scope="col">Description</th></tr></thead><tbody><tr><td rowspan="2">Implementation</td><td><a href="https://example.com/runbook">Runbook</a></td></tr><tr><td>Configure the solution</td></tr></tbody></table><p>After the first table.</p><table><tr><td colspan="2">Second table</td></tr></table>' } });
    renderApp("/org/org-1/documents/document-1");
    const first = await screen.findByRole("region", { name: "Service tasks" });
    expect(first).toHaveAttribute("tabindex", "0");
    expect(within(first).getByRole("table", { name: "Service tasks" })).toBeInTheDocument();
    expect(within(first).getByRole("cell", { name: "Implementation" })).toHaveAttribute("rowspan", "2");
    expect(within(first).getByRole("link", { name: "Runbook" })).toHaveAttribute("href", "https://example.com/runbook");
    expect(first.querySelector("colgroup col")).toHaveAttribute("span", "2");
    const second = screen.getByRole("region", { name: "Table 2" });
    expect(within(second).getByRole("cell", { name: "Second table" })).toHaveAttribute("colspan", "2");
    expect(screen.getByText("After the first table.").closest('[role="region"]')).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("contains nested imported tables within their outer notes scroller", async () => {
    mocks.get.mockResolvedValue({ id: "config-1", data: { name: "NETBIRD", organization_id: "org-1", notes: '<table><tr><td>Outer cell<table><tr><td>Nested cell</td></tr></table></td></tr></table><script>window.tableExecuted=true</script>' } });
    renderApp("/configurations/config-1");
    const region = await screen.findByRole("region", { name: "Table 1" });
    expect(within(region).getAllByRole("table")).toHaveLength(2);
    expect(region.querySelector('[role="region"]')).toBeNull();
    expect(region.parentElement?.querySelector("script")).toBeNull();
  });

  it("renders imported notes as sanitized rich text", async () => {
    mocks.get.mockResolvedValue({ id: "config-1", data: { name: "NETBIRD", organization_id: "org-1", notes: '<p><strong>Restart gateway</strong></p><script>window.notesExecuted=true</script><img src="x" onerror="alert(1)">' } });
    renderApp("/configurations/config-1");
    expect(await screen.findByText("Restart gateway")).toHaveProperty("tagName", "STRONG");
    const notes = screen.getByRole("heading", { name: "Notes" }).closest("section")!;
    expect(notes.querySelector("script")).toBeNull();
    expect(notes.querySelector("[onerror]")).toBeNull();
  });

  it("quarantines unverifiable attachments instead of offering a download", async () => {
    mocks.query.mockImplementation(async (table: string) => table === "docs-attachments"
      ? { documents: [{ id: "attachment-bad", data: { file_name: "gonorthern-star.pem", content_type: "application/x-pem", size_bytes: 19419, quarantined: true, integrity_error: "Stored content is HTML, not a PEM file." } }], total: 1 }
      : { documents: [], total: 0 });
    renderApp("/documents/document-1");
    fireEvent.click(await screen.findByRole("button", { name: "Attachments" }));

    expect(await screen.findByText(/Quarantined: Stored content is HTML/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Download / })).not.toBeInTheDocument();
  });

  it("shows quarantined managed lazy images as unavailable without requesting source URLs", async () => {
    mocks.get.mockImplementation(async (table: string) => table === "docs-attachments"
      ? { id: "image-1", data: { organization_id: "org-1", quarantined: true } }
      : { ...draft, data: { ...draft.data, content: '<p><img alt="Network map" data-src="bifrost-attachment:image-1"></p>' } });
    renderApp("/documents/document-1");
    const image = await screen.findByAltText("Network map — image unavailable");
    expect(image).not.toHaveAttribute("src");
    expect(image).not.toHaveAttribute("data-src");
    expect(mocks.get).toHaveBeenCalledWith("docs-attachments", "image-1");
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("hides catalog creation from readers", async () => {
    renderApp("/browse?type=documents");

    await screen.findByRole("heading", { name: "Records" });
    expect(screen.queryByRole("button", { name: "New Document" })).not.toBeInTheDocument();
  });

  it("uses an organization-scoped folder picker for a new document draft", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    mocks.query.mockImplementation(async (table: string) => table === "docs-document-folders"
      ? { documents: [{ id: "folder-1", data: { name: "Runbooks", organization_id: "org-1" } }], total: 1 }
      : { documents: [], total: 0 });
    renderApp("/org/org-1/documents/new");

    const picker = await screen.findByRole("combobox", { name: "Document folder" });
    expect(screen.queryByLabelText("Folder ID")).not.toBeInTheDocument();
    await waitFor(() => expect(picker).toBeEnabled());
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: "Runbooks" }));
    expect(picker).toHaveTextContent("Runbooks");
  });

  it("keeps the canonical folder subscription through the first acknowledgement refresh", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    const events: Array<(event: { type: string }) => void> = [];
    mocks.subscribe.mockImplementation((_tableId: string, _filter: unknown, onEvent: (event: { type: string }) => void) => {
      events.push(onEvent);
      return mocks.unsubscribe;
    });
    mocks.query.mockImplementation(async (table: string) => table === "docs-document-folders"
      ? { table_id: "folders-canonical-uuid", documents: [{ id: "folder-1", data: { name: "Runbooks", organization_id: "org-1" } }], total: 1 }
      : { documents: [], total: 0 });

    renderApp("/org/org-1/documents/new");
    await screen.findByRole("combobox", { name: "Document folder" });
    await waitFor(() => expect(events).toHaveLength(2));
    events[0]({ type: "subscribed" });

    await waitFor(() => expect(mocks.query.mock.calls.filter(([table]) => table === "docs-document-folders")).toHaveLength(3));
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
  });

  it("clears a prior organization table ID before the replacement scope snapshot resolves", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    const resolveSecondScope: Array<(result: unknown) => void> = [];
    mocks.query.mockImplementation((table: string, options?: { where?: { organization_id?: string } }) => {
      if (table !== "docs-document-folders") return Promise.resolve({ documents: [], total: 0 });
      if (options?.where?.organization_id === "org-b") return new Promise((resolve) => { resolveSecondScope.push(resolve); });
      return Promise.resolve({ table_id: "folders-canonical-uuid", documents: [{ id: "folder-a", data: { name: "A runbooks", organization_id: "org-a" } }], total: 1 });
    });
    const view = render(<MemoryRouter initialEntries={["/org/org-a/documents/new"]}><RouteChange to={null} /><App /></MemoryRouter>);
    await screen.findByRole("combobox", { name: "Document folder" });
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith("folders-canonical-uuid", { eq: [{ row: "organization_id" }, "org-a"] }, expect.any(Function), expect.any(Function)));

    view.rerender(<MemoryRouter initialEntries={["/org/org-a/documents/new"]}><RouteChange to="/org/org-b/documents/new" /><App /></MemoryRouter>);
    await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(2));
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);

    resolveSecondScope.forEach(resolve => resolve({ table_id: "folders-canonical-uuid", documents: [{ id: "folder-b", data: { name: "B runbooks", organization_id: "org-b" } }], total: 1 }));
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith("folders-canonical-uuid", { eq: [{ row: "organization_id" }, "org-b"] }, expect.any(Function), expect.any(Function)));
  });

  it("renders the original dashboard guidance before any recent visits", async () => {
    renderApp("/");
    await screen.findByRole("heading", { name: "Dashboard" });
    const main = screen.getByRole("main");
    expect(within(main).getByText("Welcome to Bifrost Docs.")).toBeInTheDocument();
    expect(within(main).getByRole("link", { name: "Browse organizations" })).toBeInTheDocument();
    expect(within(main).queryByText("Total documents")).not.toBeInTheDocument();
  });

  it("filters documents by folder from the folder tree", async () => {    mocks.query.mockImplementation(async (table: string) => {
      if (table === "docs-document-folders") {
        return { documents: [{ id: "folder-1", data: { name: "Runbooks", parent_id: "" } }], total: 1 };
      }
      return { documents: [{ id: "doc-1", data: { name: "Network runbook", folder_id: "folder-1", source_system: "itglue" } }], total: 1 };
    });
    renderApp("/org/org-1/documents");

    await screen.findByRole("button", { name: "Runbooks" });
    expect(screen.getByRole("button", { name: "All documents" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Runbooks" }));
    await waitFor(() => {
      expect(mocks.query).toHaveBeenCalledWith(
        "docs-documents",
        expect.objectContaining({ where: expect.objectContaining({ folder_id: "folder-1" }) }),
      );
    });
  });

  it("scopes an organization configuration list and exposes named taxonomy filters", async () => {
    mocks.query.mockImplementation(async (table: string) => {
      if (table === "docs-configurations") return { documents: [{ id: "config-1", data: { name: "Edge firewall", configuration_type_name: "Firewall", configuration_status_name: "Active", organization_id: "org-1" } }], total: 1 };
      if (table === "docs-configuration-types") return { documents: [{ id: "type-1", data: { name: "Firewall", active: true } }], total: 1 };
      if (table === "docs-configuration-statuses") return { documents: [{ id: "status-1", data: { name: "Active", active: true } }], total: 1 };
      return { documents: [], total: 0 };
    });
    renderApp("/org/org-1/configurations");

    expect(await screen.findByRole("heading", { name: "Configurations" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent("Firewall");
    await waitFor(() => expect(mocks.query).toHaveBeenCalledWith(
      "docs-configurations",
      expect.objectContaining({ where: expect.objectContaining({ organization_id: "org-1" }) }),
    ));
  });

  it("sorts catalog pages through the table query before changing pages", async () => {
    mocks.query.mockImplementation(async (table: string) => table === "docs-configurations"
      ? { documents: [{ id: "config-1", data: { name: "Edge firewall", organization_id: "org-1" } }], total: 1 }
      : { documents: [], total: 0 });
    renderApp("/org/org-1/configurations");

    await screen.findByText("Edge firewall");
    mocks.query.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    await waitFor(() => expect(mocks.query).toHaveBeenCalledWith(
      "docs-configurations",
      expect.objectContaining({ order_by: "name", order_dir: "asc" }),
    ));
  });

  it("persists the legacy configuration metadata fields on creation", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    renderApp("/org/org-1/configurations");

    fireEvent.click(await screen.findByRole("button", { name: "New configuration" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Edge firewall" } });
    fireEvent.change(screen.getByLabelText("Asset tag"), { target: { value: "IT-99" } });
    fireEvent.change(screen.getByLabelText("IP address"), { target: { value: "10.0.0.1" } });
    fireEvent.change(screen.getByLabelText("MAC address"), { target: { value: "00:11:22:33:44:55" } });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Perimeter device" } });
    fireEvent.click(screen.getByRole("button", { name: "Create record" }));

    await waitFor(() => expect(mocks.insert).toHaveBeenCalledWith(
      "docs-configurations",
      expect.objectContaining({
        organization_id: "org-1",
        asset_tag: "IT-99",
        ip_address: "10.0.0.1",
        mac_address: "00:11:22:33:44:55",
        notes: "Perimeter device",
      }),
    ));
  });

  it("opens every visible imported copy when choosing a global flexible asset type", async () => {
    mocks.query.mockImplementation(async (table: string) => {
      if (table === "docs-flexible-asset-types") {
        return { documents: [
          { id: "type-1", data: { name: "Active Directory", fields: [], source_system: "itglue", source_id: "shared-1", organization_id: "org-1" } },
          { id: "type-2", data: { name: "Active Directory", fields: [], source_system: "itglue", source_id: "shared-1", organization_id: "org-2" } },
        ], total: 2 };
      }
      return { documents: [], total: 0 };
    });
    renderApp("/browse?type=flexible-assets");

    await screen.findByText("Active Directory");
    expect(screen.getAllByRole("button", { name: /Active Directory/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Active Directory/ }));
    await screen.findByRole("table", { name: "Global Flexible assets" });
    await waitFor(() => {
      expect(mocks.query).toHaveBeenCalledWith(
        "docs-flexible-assets",
        expect.objectContaining({ where: expect.objectContaining({ flexible_asset_type_id: { in: ["type-1", "type-2"] } }) }),
      );
    });
  });

  it("shows matching records when searching from the flexible asset type grid", async () => {
    mocks.query.mockImplementation(async (table: string) => {
      if (table === "docs-flexible-asset-types") return { documents: [{ id: "type-1", data: { name: "Endpoints", fields: [] } }], total: 1 };
      if (table === "docs-flexible-assets") return { documents: [{ id: "router-1", data: { name: "Matching Router", organization_id: "org-1", flexible_asset_type_id: "type-1" } }], total: 1 };
      return { documents: [], total: 0 };
    });
    renderApp("/browse?type=flexible-assets");
    await screen.findByRole("button", { name: /Endpoints/ });
    fireEvent.change(screen.getByLabelText("Search flexible assets"), { target: { value: "Router" } });
    const results = await screen.findByRole("table", { name: "Flexible assets" });
    expect(within(results).getByText("Matching Router")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await screen.findByRole("button", { name: /Endpoints/ });
    expect(screen.queryByRole("table", { name: "Flexible assets" })).not.toBeInTheDocument();
  });

  it("confirms a selected document archive before invoking the native-only bulk workflow", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Administrator"] };
    mocks.query.mockImplementation(async (table: string) => table === "docs-documents"
      ? { documents: [
        { id: "native-document", data: { name: "Native runbook", source_system: "bifrost", archived: false } },
        { id: "source-document", data: { name: "Imported runbook", source_system: "itglue", archived: false } },
      ], total: 2 }
      : { documents: [], total: 0 });
    renderApp("/browse?type=documents");

    await screen.findByText("Native runbook");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row native-document" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row source-document" }));
    expect(screen.getByRole("button", { name: "Archive selected" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row source-document" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive selected" }));

    const confirmation = await screen.findByRole("dialog", { name: "Archive selected documents?" });
    expect(mocks.mutate).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Archive 1 document" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      "functions/document_mutations.py::docs_bulk_archive_documents",
      { document_ids: ["native-document"] },
    );
  });

  it("moves selected native drafts through the scoped folder picker", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    mocks.query.mockImplementation(async (table: string) => {
      if (table === "docs-documents") return { documents: [{ id: "native-document", data: { name: "Native runbook", content: "Draft content", source_system: "bifrost", status: "draft", organization_id: "org-1", archived: false } }], total: 1 };
      if (table === "docs-document-folders") return { documents: [{ id: "folder-2", data: { name: "Network", organization_id: "org-1" } }], total: 1 };
      return { documents: [], total: 0 };
    });
    renderApp("/org/org-1/documents");

    await screen.findByText("Native runbook");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row native-document" }));
    fireEvent.click(screen.getByRole("button", { name: "Move selected" }));
    const confirmation = await screen.findByRole("dialog", { name: "Move selected documents?" });
    fireEvent.click(within(confirmation).getByRole("combobox", { name: "Destination folder" }));
    fireEvent.click(await screen.findByRole("option", { name: "Network" }));
    fireEvent.click(within(confirmation).getByRole("button", { name: "Move 1 document" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith(
      "functions/authoring.py::docs_update_draft",
      { document_id: "native-document", folder_id: "folder-2" },
    ));
  });

  it("does not expose bulk actions for password metadata", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Administrator"] };
    mocks.query.mockImplementation(async (table: string) => table === "docs-passwords"
      ? { documents: [
        { id: "password-metadata", data: { name: "VPN account", username: "operator" } },
      ], total: 1 }
      : { documents: [], total: 0 });
    renderApp("/browse?type=passwords");

    await screen.findByText("VPN account");
    expect(screen.queryByRole("button", { name: "Archive selected" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Select row password-metadata" })).not.toBeInTheDocument();
  });

  it.each([
    ["configurations", "docs-configurations"],
    ["locations", "docs-locations"],
    ["assets/asset-type-1", "docs-flexible-assets"],
  ])("hides disabled %s records by default without hiding legacy native records", async (route, table) => {
    const rows = [
      { id: "active-record", data: { name: "Active record", is_enabled: true } },
      { id: "legacy-record", data: { name: "Legacy record" } },
      { id: "disabled-record", data: { name: "Disabled record", is_enabled: false } },
    ];
    mocks.query.mockImplementation(async (name: string, options: { where?: { is_enabled?: { ne?: boolean } } }) => {
      if (name !== table) return { documents: [], total: 0 };
      const selected = options.where?.is_enabled?.ne === false ? rows.filter(row => row.data.is_enabled !== false) : rows;
      return { documents: selected, total: selected.length };
    });
    renderApp(`/org/org-1/${route}`);
    await screen.findByText("Legacy record");
    expect(screen.queryByText("Disabled record")).not.toBeInTheDocument();
    expect(mocks.query).toHaveBeenCalledWith(table, expect.objectContaining({ where: expect.objectContaining({ organization_id: "org-1", is_enabled: { ne: false } }) }));
    const toggle = screen.getByRole("switch", { name: "Show disabled" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(await screen.findByText("Disabled record")).toBeVisible();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByText("Disabled record")).not.toBeInTheDocument());
    expect(screen.getByText("Legacy record")).toBeVisible();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("restores a bookmarked disabled view and resets pagination while preserving search and taxonomy filters", async () => {
    mocks.query.mockImplementation(async (table: string) => table === "docs-configurations"
      ? { documents: [{ id: "record-1", data: { name: "Edge firewall", organization_id: "org-1" } }], total: 60 }
      : { documents: [], total: 0 });
    renderApp("/org/org-1/configurations?q=Edge&page=3&configurationType=Firewall&configurationStatus=Active&showDisabled=1");
    const toggle = await screen.findByRole("switch", { name: "Show disabled" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(mocks.query).toHaveBeenCalledWith("docs-configurations", expect.objectContaining({ offset: 50, where: { organization_id: "org-1", name: { contains: "Edge" }, configuration_type_name: "Firewall", configuration_status_name: "Active" } })));
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.query).toHaveBeenCalledWith("docs-configurations", expect.objectContaining({ offset: 0, where: { organization_id: "org-1", name: { contains: "Edge" }, configuration_type_name: "Firewall", configuration_status_name: "Active", is_enabled: { ne: false } } })));
    expect(screen.getByRole("textbox", { name: "Search configurations" })).toHaveValue("Edge");
  });

  it("clears selected record actions when the disabled filter changes", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    mocks.query.mockImplementation(async (table: string) => table === "docs-configurations"
      ? { documents: [{ id: "config-1", data: { name: "Edge firewall", organization_id: "org-1", is_enabled: true } }], total: 1 }
      : { documents: [], total: 0 });
    renderApp("/org/org-1/configurations");
    await screen.findByText("Edge firewall");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row config-1" }));
    expect(screen.getByRole("button", { name: "Disable selected" })).toBeVisible();
    fireEvent.click(screen.getByRole("switch", { name: "Show disabled" }));
    expect(screen.queryByRole("button", { name: "Disable selected" })).not.toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each(["documents", "passwords", "flexible-asset-types"])("does not reinterpret %s lifecycle through the disabled filter", async kind => {
    renderApp(`/org/org-1/${kind}?showDisabled=1`);
    await screen.findByRole("heading", { name: kind === "passwords" ? "Password metadata" : kind === "documents" ? "Documents" : "Flexible asset types" });
    expect(screen.queryByRole("switch", { name: "Show disabled" })).not.toBeInTheDocument();
    const listingCalls = mocks.query.mock.calls.filter(([table, options]) => table === `docs-${kind}` && options.limit === 25);
    expect(listingCalls.length).toBeGreaterThan(0);
    for (const [, options] of listingCalls) expect(options.where?.is_enabled).toBeUndefined();
  });

  it("confirms a bounded configuration disable before table updates", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    mocks.query.mockImplementation(async (table: string) => table === "docs-configurations"
      ? { documents: [{ id: "config-1", data: { name: "Edge firewall", organization_id: "org-1", is_enabled: true, source_system: "itglue" } }], total: 1 }
      : { documents: [], total: 0 });
    renderApp("/org/org-1/configurations");

    await screen.findByText("Edge firewall");
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row config-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Disable selected" }));
    const confirmation = await screen.findByRole("dialog", { name: "Disable selected configurations?" });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(within(confirmation).getByText(/IT Glue may overwrite/)).toBeInTheDocument();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Disable 1 configuration" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("docs-configurations", "config-1", { is_enabled: false }));
  });

  it("requires an explicit confirmation before publishing a native draft", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Administrator"] };
    renderApp("/documents/document-1");

    await screen.findByRole("button", { name: "Publish draft" });
    fireEvent.click(screen.getByRole("button", { name: "Publish draft" }));

    const confirmation = await screen.findByRole("dialog", { name: "Publish draft?" });
    expect(mocks.mutate).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Publish draft" }));
    expect(mocks.mutate).toHaveBeenCalledWith("functions/authoring.py::docs_publish_draft", { document_id: "document-1", confirmed: true });
  });

  it("retains a selected attachment through drawer/gutter transitions and dismissal", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    const resize = readerResize();
    renderApp("/org/org-1/documents/document-1");
    await screen.findByRole("button", { name: "Attachments" });
    resize(960);
    const file = new File(["runbook"], "selected-runbook.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Choose attachment"), { target: { files: [file] } });
    resize(800);
    fireEvent.click(screen.getByRole("button", { name: "Attachments" }));
    const drawer = await screen.findByRole("dialog", { name: "Attachments" });
    expect(within(drawer).getByRole("button", { name: "Drop a file or browse" })).toHaveTextContent(file.name);
    fireEvent.click(within(drawer).getByRole("button", { name: "Close Attachments" }));
    resize(960);
    expect(screen.getByRole("button", { name: "Drop a file or browse" })).toHaveTextContent(file.name);
    expect(screen.getByRole("button", { name: "Upload attachment" })).toBeEnabled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("keeps an upload busy across layout transitions and completes it once", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    let finishGrant!: () => void;
    mocks.mutate.mockImplementation((reference: string) => reference.endsWith("::docs_ensure_file_grant")
      ? new Promise<void>(resolve => { finishGrant = resolve; }) : Promise.resolve({}));
    const resize = readerResize();
    renderApp("/org/org-1/documents/document-1");
    await screen.findByRole("button", { name: "Attachments" });
    resize(960);
    const file = new File(["runbook"], "selected-runbook.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Choose attachment"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload attachment" }));
    expect(screen.getByRole("button", { name: "Uploading attachment" })).toBeDisabled();
    resize(800);
    fireEvent.click(screen.getByRole("button", { name: "Attachments" }));
    const drawer = await screen.findByRole("dialog", { name: "Attachments" });
    expect(within(drawer).getByRole("button", { name: "Uploading attachment" })).toBeDisabled();
    await act(async () => finishGrant());
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(drawer).getByRole("button", { name: "Upload attachment" })).toBeDisabled());
    resize(960);
    expect(screen.getByRole("button", { name: "Drop a file or browse" })).not.toHaveTextContent(file.name);
  });

  it("preserves the relationship picker and query through a docking transition", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    const resize = readerResize();
    renderApp("/org/org-1/documents/document-1");
    await screen.findByRole("button", { name: "Related items" });
    resize(960);
    fireEvent.click(screen.getByRole("button", { name: "Add related item" }));
    const picker = await screen.findByRole("dialog", { name: "Add related item" });
    fireEvent.change(within(picker).getByLabelText("Search query"), { target: { value: "Recovery" } });
    resize(800);
    expect(screen.getByRole("dialog", { name: "Add related item" })).toBe(picker);
    expect(within(picker).getByLabelText("Search query")).toHaveValue("Recovery");
    resize(960);
    expect(screen.getByRole("dialog", { name: "Add related item" })).toBe(picker);
    fireEvent.keyDown(picker, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add related item" })).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "Related items" })).toBeVisible();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("clears supporting drafts when navigating to a different document", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    mocks.get.mockImplementation(async (_table: string, id: string) => id === "document-2"
      ? { ...draft, id, data: { ...draft.data, name: "Other runbook" } } : draft);
    const resize = readerResize();
    const view = render(<MemoryRouter initialEntries={["/org/org-1/documents/document-1"]}><RouteChange to={null} /><App /></MemoryRouter>);
    await screen.findByRole("button", { name: "Attachments" });
    resize(960);
    fireEvent.change(screen.getByLabelText("Choose attachment"), { target: { files: [new File(["draft"], "private-draft.txt")] } });
    fireEvent.click(screen.getByRole("button", { name: "Add related item" }));
    fireEvent.change(within(await screen.findByRole("dialog", { name: "Add related item" })).getByLabelText("Search query"), { target: { value: "Recovery" } });
    view.rerender(<MemoryRouter initialEntries={["/org/org-1/documents/document-1"]}><RouteChange to="/org/org-1/documents/document-2" /><App /></MemoryRouter>);
    await screen.findByRole("heading", { name: "Other runbook" });
    resize(960);
    expect(screen.queryByRole("dialog", { name: "Add related item" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Drop a file or browse" })).not.toHaveTextContent("private-draft.txt");
    expect(screen.getByRole("button", { name: "Upload attachment" })).toBeDisabled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("confirms attachment deletion before invoking its cleanup workflow", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    mocks.query.mockImplementation(async (table: string) => table === "docs-attachments"
      ? { documents: [{ id: "attachment-1", data: { file_name: "evidence.pdf", content_type: "application/pdf", size_bytes: 1024 } }], total: 1 }
      : { documents: [], total: 0 });
    renderApp("/documents/document-1");
    fireEvent.click(await screen.findByRole("button", { name: "Attachments" }));

    const attachment = (await screen.findByText("evidence.pdf")).closest("li");
    expect(attachment).not.toBeNull();
    fireEvent.click(within(attachment!).getByRole("button", { name: "Delete evidence.pdf" }));

    const confirmation = await screen.findByRole("dialog", { name: "Delete attachment?" });
    expect(mocks.mutate).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete attachment" }));
    expect(mocks.mutate).toHaveBeenCalledWith("functions/attachments.py::docs_delete_attachment", { attachment_id: "attachment-1" });
  });

  it.each([
    ["documents", "docs-documents", "/org/org-1/documents/document-1"],
    ["configurations", "docs-configurations", "/org/org-1/configurations/document-1"],
    ["locations", "docs-locations", "/org/org-1/locations/document-1"],
    ["flexible_assets", "docs-flexible-assets", "/org/org-1/assets/type-1/document-1"],
  ])("loads attachments beyond the first page for %s with unchanged parent and organization filters", async (parentType, parentTable, route) => {
    const attachments = Array.from({ length: 205 }, (_, index) => ({ id: `file-${index}`, data: { organization_id: "org-1", parent_id: draft.id, parent_type: parentType, file_name: `Evidence ${index}.txt`, size_bytes: 20 } }));
    mocks.get.mockImplementation(async (table: string) => table === parentTable ? draft : { id: "type-1", data: { name: "Runbook type" } });
    mocks.query.mockImplementation(async (table: string, options) => table === "docs-attachments"
      ? { documents: attachments.slice(options.offset ?? 0, (options.offset ?? 0) + options.limit), total: attachments.length, table_id: "canonical-attachments" }
      : { documents: [], total: 0 });
    renderApp(route);
    if (parentType === "documents") fireEvent.click(await screen.findByRole("button", { name: "Attachments" }));
    expect(await screen.findByRole("button", { name: "Download Evidence 204.txt" })).toBeVisible();
    const pages = mocks.query.mock.calls.filter(([table]) => table === "docs-attachments");
    expect(pages.map(([, options]) => options.offset)).toEqual([0, 100, 200]);
    for (const [, options] of pages) expect(options.where).toEqual({ parent_id: draft.id, parent_type: parentType, organization_id: "org-1" });
    expect(mocks.subscribe).toHaveBeenCalledWith("canonical-attachments", { eq: [{ row: "organization_id" }, "org-1"] }, expect.any(Function), expect.any(Function));
  });

  it("finds real attachments after an entire page of document images", async () => {
    const attachments = Array.from({ length: 105 }, (_, index) => ({ id: `image-${index}`, data: { file_kind: "document_image", file_name: `inline-${index}.png` } }));
    attachments.push({ id: "real-file", data: { file_kind: "attachment", file_name: "Recovery notes.txt" } });
    mocks.query.mockImplementation(async (table: string, options) => table === "docs-attachments"
      ? { documents: attachments.slice(options.offset ?? 0, (options.offset ?? 0) + options.limit), total: attachments.length }
      : { documents: [], total: 0 });
    renderApp("/org/org-1/documents/document-1");
    fireEvent.click(await screen.findByRole("button", { name: "Attachments" }));
    expect(await screen.findByRole("button", { name: "Download Recovery notes.txt" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Download inline-/ })).not.toBeInTheDocument();
    expect(screen.queryByText("No files attached.")).not.toBeInTheDocument();
  });

  it("loads named relationship targets beyond the first page with the parent scope retained", async () => {
    const relationships = Array.from({ length: 205 }, (_, index) => ({ id: `related-${index}`, data: { organization_id: "org-1", source_destination_id: draft.id, target_type: "documents", target_destination_id: index === 204 ? "last-target" : "" } }));
    mocks.get.mockImplementation(async (_table: string, id: string) => id === "last-target"
      ? { id, data: { name: "Last linked runbook", organization_id: "org-1" } } : draft);
    mocks.query.mockImplementation(async (table: string, options) => table === "docs-relationships"
      ? { documents: relationships.slice(options.offset ?? 0, (options.offset ?? 0) + options.limit), total: relationships.length }
      : { documents: [], total: 0 });
    renderApp("/org/org-1/documents/document-1");
    fireEvent.click(await screen.findByRole("button", { name: "Related items" }));
    expect(await screen.findByRole("link", { name: "Last linked runbook" })).toHaveAttribute("href", "/documents/last-target");
    const pages = mocks.query.mock.calls.filter(([table]) => table === "docs-relationships");
    expect(pages.map(([, options]) => options.offset)).toEqual([0, 100, 200]);
    for (const [, options] of pages) expect(options.where).toEqual({ source_destination_id: draft.id, organization_id: "org-1" });
  });

  it.each([
    ["docs-attachments", "Attachments", "Attachments unavailable"],
    ["docs-relationships", "Related items", "Related items are restricted"],
  ])("surfaces a denied later %s page instead of treating the first page as complete", async (tableName, title, errorTitle) => {
    mocks.query.mockImplementation(async (table: string, options) => {
      if (table !== tableName) return { documents: [], total: 0 };
      if (options.offset >= 100) throw new Error("403 access denied");
      return { documents: Array.from({ length: 100 }, (_, index) => ({ id: `partial-${index}`, data: { file_name: "Partial proof.txt", target_type: "documents", target_destination_id: "" } })), total: 150 };
    });
    renderApp("/org/org-1/documents/document-1");
    fireEvent.click(await screen.findByRole("button", { name: title }));
    expect(await screen.findByText(errorTitle, { exact: true })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Download Partial proof.txt" })).not.toBeInTheDocument();
    expect(screen.queryByText("Document unavailable")).not.toBeInTheDocument();
  });

  it("discards a pending supporting page after document navigation without querying another stale page", async () => {
    const oldPage = Array.from({ length: 100 }, (_, index) => ({ id: `old-file-${index}`, data: { file_name: "Old document proof.txt" } }));
    let completePage!: (result: { documents: typeof oldPage; total: number }) => void;
    mocks.get.mockImplementation(async (_table: string, id: string) => id === "document-2"
      ? { ...draft, id, data: { ...draft.data, name: "Other runbook" } } : draft);
    mocks.query.mockImplementation(async (table: string, options) => {
      if (table !== "docs-attachments" || options.where.parent_id !== draft.id) return { documents: [], total: 0 };
      if (options.offset === 100) return new Promise(resolve => { completePage = resolve; });
      return { documents: oldPage, total: 300 };
    });
    const view = render(<MemoryRouter initialEntries={["/org/org-1/documents/document-1"]}><RouteChange to={null} /><App /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Attachments" }));
    await waitFor(() => expect(completePage).toBeTypeOf("function"));
    view.rerender(<MemoryRouter initialEntries={["/org/org-1/documents/document-1"]}><RouteChange to="/org/org-1/documents/document-2" /><App /></MemoryRouter>);
    await screen.findByRole("heading", { name: "Other runbook" });
    fireEvent.click(screen.getByRole("button", { name: "Attachments" }));
    await act(async () => completePage({ documents: oldPage, total: 300 }));
    expect(await screen.findByText("No files attached.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Download Old document proof.txt" })).not.toBeInTheDocument();
    const oldQueries = mocks.query.mock.calls.filter(([table, options]) => table === "docs-attachments" && options.where.parent_id === draft.id);
    expect(oldQueries.map(([, options]) => options.offset)).toEqual([0, 100]);
  });

  it.each([
    ["docs-attachments", ".attachments"],
    ["docs-relationships", ".related-items"],
  ])("keeps the %s list and scroll position mounted during a background refresh", async (tableName, selector) => {
    const documents = Array.from({ length: 20 }, (_, index) => ({ id: `proof-${index}`, data: { file_name: `Proof ${index}.txt`, target_type: "documents", target_destination_id: "" } }));
    let refreshing = false;
    let completeRefresh!: (result: { documents: typeof documents; total: number; table_id: string }) => void;
    const tableId = `canonical-${tableName}`;
    mocks.query.mockImplementation(async (table: string) => {
      if (table !== tableName) return { documents: [], total: 0 };
      if (refreshing) return new Promise(resolve => { completeRefresh = resolve; });
      return { documents, total: documents.length, table_id: tableId };
    });
    const view = renderApp("/org/org-1/configurations/document-1");
    await waitFor(() => expect(view.container.querySelector(`${selector} li`)).toBeInTheDocument());
    const list = view.container.querySelector(`${selector} ul`)!;
    list.scrollTop = 128;
    const subscription = mocks.subscribe.mock.calls.find(([id]) => id === tableId);
    expect(subscription).toBeDefined();
    refreshing = true;
    act(() => subscription![2]({ type: "document_change" }));
    await waitFor(() => expect(completeRefresh).toBeTypeOf("function"));
    expect(view.container.querySelector(`${selector} ul`)).toBe(list);
    expect(list.scrollTop).toBe(128);
    expect(list).toHaveAttribute("aria-busy", "true");
    await act(async () => completeRefresh({ documents, total: documents.length, table_id: tableId }));
    expect(view.container.querySelector(`${selector} ul`)).toBe(list);
    expect(list.scrollTop).toBe(128);
    expect(list).toHaveAttribute("aria-busy", "false");
    act(() => subscription![2]({ type: "subscription_revoked" }));
    expect(view.container.querySelector(`${selector} ul`)).not.toBeInTheDocument();
  });

  it("creates assets by choosing a named type from the selected organization", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    mocks.query.mockImplementation(async (table: string) => table === "docs-flexible-asset-types"
      ? { documents: [{ id: "type-1", data: { name: "Network devices", organization_id: "org-1" } }], total: 1 }
      : { documents: [], total: 0 });
    mocks.get.mockResolvedValue({ id: "type-1", data: { organization_id: "org-1", fields: [{ key: "hostname", name: "Hostname", type: "text" }] } });
    renderApp("/org/org-1/assets");
    fireEvent.click(await screen.findByRole("button", { name: "New flexible asset" }));
    const dialog = await screen.findByRole("dialog", { name: "Create Flexible asset" });
    const picker = within(dialog).getByRole("combobox", { name: "Asset type" });
    expect(within(dialog).queryByLabelText("Flexible asset type ID")).not.toBeInTheDocument();
    await waitFor(() => expect(picker).toBeEnabled());
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: "Network devices" }));
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Edge router" } });
    fireEvent.change(await within(dialog).findByLabelText("Hostname"), { target: { value: "edge-01" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create record" }));
    await waitFor(() => expect(mocks.insert).toHaveBeenCalledWith("docs-flexible-assets", expect.objectContaining({ organization_id: "org-1", flexible_asset_type_id: "type-1", traits: { hostname: "edge-01" } })));
    expect(mocks.query).toHaveBeenCalledWith("docs-flexible-asset-types", expect.objectContaining({ where: { organization_id: "org-1" } }));
  });

  it("uses one record type selector and clears the previous search when switching kinds", async () => {
    renderApp("/browse?type=documents&q=runbook");
    const selector = await screen.findByRole("combobox", { name: "Record type" });
    expect(screen.queryByRole("tablist", { name: "Record type" })).not.toBeInTheDocument();
    fireEvent.change(selector, { target: { value: "locations" } });
    expect(await screen.findByRole("textbox", { name: "Search locations" })).toHaveValue("");
    await waitFor(() => expect(mocks.query).toHaveBeenCalledWith("docs-locations", expect.objectContaining({ where: expect.not.objectContaining({ name: { contains: "runbook" } }) })));
  });

  it("shows visible folder names in the all-organization document catalog", async () => {
    mocks.query.mockImplementation(async (table: string) => table === "docs-document-folders"
      ? { documents: [{ id: "folder-1", data: { name: "Runbooks", organization_id: "org-1" } }], total: 1 }
      : table === "docs-documents" ? { documents: [{ ...draft, data: { ...draft.data, folder_id: "folder-1" } }], total: 1 }
      : { documents: [], total: 0 });
    renderApp("/browse?type=documents");
    const table = await screen.findByRole("table", { name: "Documents" });
    expect(await within(table).findByText("Runbooks")).toBeVisible();
    expect(within(table).queryByText("Folder unavailable")).not.toBeInTheDocument();
  });

  it("presents document content as a named reader without a redundant Content heading", async () => {
    renderApp("/org/org-1/documents/document-1");
    const content = await screen.findByRole("article", { name: "Document content" });
    expect(within(content).getByText("Draft content")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Content" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attachments" })).toBeInTheDocument();
  });

  it("gives the document the page and opens one dismissible utility panel at a time", async () => {
    mocks.get.mockResolvedValue({ ...draft, data: { ...draft.data, content: "<h2>Install agent</h2><p>Steps</p>" } });
    mocks.query.mockImplementation(async (table: string) => table === "docs-attachments"
      ? { documents: [{ id: "attachment-1", data: { file_name: "guide.pdf", file_kind: "attachment", size_bytes: 1024 } }], total: 1 }
      : { documents: [], total: 0 });
    renderApp("/org/org-1/documents/document-1");
    const article = await screen.findByRole("article", { name: "Document content" });
    expect(article.closest(".document-reader")!.querySelector(".detail-rail")).toBeNull();
    expect(screen.queryByRole("region", { name: "Table of contents" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download guide.pdf" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Attachments" }));
    const filesPanel = await screen.findByRole("dialog", { name: "Attachments" });
    expect(await within(filesPanel).findByRole("button", { name: "Download guide.pdf" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Related items" }));
    expect(await screen.findByRole("dialog", { name: "Related items" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Attachments" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close Related items" }));
    fireEvent.click(screen.getByRole("button", { name: "On this page" }));
    const contents = await screen.findByRole("dialog", { name: "On this page" });
    fireEvent.click(within(contents).getByRole("link", { name: "Install agent" }));
    expect(screen.queryByRole("dialog", { name: "On this page" })).not.toBeInTheDocument();
  });

  it("marks the open document in its folder tree and lets its folder collapse", async () => {
    mocks.query.mockImplementation(async (table: string) => table === "docs-document-folders"
      ? { documents: [{ id: "folder-1", data: { name: "Runbooks", organization_id: "org-1" } }], total: 1 }
      : table === "docs-documents" ? { documents: [{ ...draft, data: { ...draft.data, folder_id: "folder-1" } }], total: 1 }
      : { documents: [], total: 0 });
    renderApp("/org/org-1/documents/document-1");
    const tree = await screen.findByRole("complementary", { name: "Document folders" });
    const current = await within(tree).findByRole("button", { name: "Draft runbook" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(within(tree).getByRole("button", { name: "All documents" })).not.toHaveAttribute("aria-current");
    fireEvent.click(within(tree).getByRole("button", { name: "Collapse Runbooks" }));
    expect(within(tree).queryByRole("button", { name: "Draft runbook" })).not.toBeInTheDocument();
  });

  it("renders imported asset references as readable names rather than source JSON", async () => {
    mocks.get.mockImplementation(async (table: string) => table === "docs-flexible-assets"
      ? { id: "asset-1", data: { name: "Directory", organization_id: "org-1", flexible_asset_type_id: "type-1", traits: { servers: { type: "Configurations", values: [{ id: 12, name: "Domain controller" }, { id: 13, name: "Backup server" }] } } } }
      : { id: "type-1", data: { name: "Active Directory" } });
    renderApp("/org/org-1/assets/type-1/asset-1");
    expect(await screen.findByText("Domain controller, Backup server", { exact: true })).toBeVisible();
    expect(screen.queryByText(/"resource-url"|"values":/)).not.toBeInTheDocument();
  });

  it("links a named search result in the parent organization without requiring internal IDs", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    mocks.get.mockResolvedValue({ id: "config-1", data: { organization_id: "org-1", source_system: "bifrost", name: "Edge firewall" } });
    mocks.query.mockImplementation(async (table: string) => table === "docs-documents"
      ? { documents: [{ id: "doc-target", data: { organization_id: "org-1", source_id: "source-target", name: "Recovery runbook" } }], total: 1 }
      : { documents: [], total: 0 });
    renderApp("/org/org-1/configurations/config-1");
    fireEvent.click(await screen.findByRole("button", { name: "Add related item" }));
    expect(screen.queryByLabelText("Target source ID")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Target Bifrost record ID")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "Recovery" } });
    fireEvent.click(await screen.findByRole("button", { name: "Link Recovery runbook" }));
    await waitFor(() => expect(mocks.insert).toHaveBeenCalledWith("docs-relationships", expect.objectContaining({
      organization_id: "org-1", source_type: "configurations", source_destination_id: "config-1",
      target_type: "documents", target_source_id: "source-target", target_destination_id: "doc-target",
    })));
    const searchCalls = mocks.query.mock.calls.filter(([, options]) => options.where?.name?.contains === "Recovery");
    expect(searchCalls.length).toBeGreaterThan(0);
    expect(searchCalls.every(([, options]) => options.where.organization_id === "org-1")).toBe(true);
  });

  it("shows a related record's authorized name and links it without exposing source IDs", async () => {
    mocks.query.mockImplementation(async (table: string) => table === "docs-relationships"
      ? { documents: [{ id: "relationship-1", data: { target_type: "documents", target_source_id: "private-source-123", target_destination_id: "target-1", relationship_type: "related" } }], total: 1 }
      : { documents: [], total: 0 });
    mocks.get.mockImplementation(async (_table: string, id: string) => id === "target-1"
      ? { id, data: { organization_id: "org-other", name: "Disaster recovery runbook" } }
      : draft);
    renderApp("/org/org-1/documents/document-1");
    fireEvent.click(await screen.findByRole("button", { name: "Related items" }));
    const link = await screen.findByRole("link", { name: "Disaster recovery runbook" });
    expect(link).toHaveAttribute("href", "/documents/target-1");
    expect(mocks.get).toHaveBeenCalledWith("docs-documents", "target-1", undefined);
    expect(screen.queryByText(/private-source-123/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open record" })).not.toBeInTheDocument();
  });

  it.each(["missing", "denied", "wrong-record"])("keeps a %s related target unavailable without using raw source names", async (state) => {
    mocks.query.mockImplementation(async (table: string) => table === "docs-relationships"
      ? { documents: [{ id: "relationship-1", data: { target_type: "documents", target_source_id: "private-source-123", target_destination_id: "target-1", raw: { attributes: { name: "Private source name" } } } }], total: 1 }
      : { documents: [], total: 0 });
    mocks.get.mockImplementation(async (_table: string, id: string) => {
      if (id !== "target-1") return draft;
      if (state === "denied") throw new Error("403 access denied");
      return state === "missing" ? null : { id: "other-record", data: { organization_id: "org-other", name: "Wrong record name" } };
    });
    renderApp("/org/org-1/documents/document-1");
    fireEvent.click(await screen.findByRole("button", { name: "Related items" }));
    const panel = await screen.findByRole("dialog", { name: "Related items" });
    expect(await within(panel).findByText(state === "denied" ? "Restricted document" : "Document unavailable")).toBeVisible();
    expect(within(panel).queryByRole("link")).not.toBeInTheDocument();
    expect(within(panel).queryByText(/private-source-123|Private source name|Wrong record name/)).not.toBeInTheDocument();
  });

  it("shows parent folder names in the folder catalog without a raw-ID column", async () => {
    mocks.query.mockImplementation(async (table: string) => table === "docs-document-folders"
      ? { documents: [{ id: "folder-1", data: { organization_id: "org-1", name: "Runbooks", parent_id: "parent-folder-123" } }], total: 1 }
      : { documents: [], total: 0 });
    mocks.get.mockResolvedValue({ id: "parent-folder-123", data: { organization_id: "org-1", name: "Operations" } });
    renderApp("/org/org-1/document-folders");
    const table = await screen.findByRole("table", { name: "Document folders" });
    expect(await within(table).findByRole("link", { name: "Operations" })).toHaveAttribute("href", "/document-folders/parent-folder-123");
    expect(within(table).queryByText("parent-folder-123")).not.toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Parent folder" })).toBeVisible();
  });

  it("shows the named parent folder from a read scoped to the folder's organization", async () => {
    mocks.get.mockImplementation(async (_table: string, id: string) => id === "folder-1"
      ? { id, data: { organization_id: "org-1", name: "Runbooks", parent_id: "parent-folder-123" } }
      : { id, data: { organization_id: "org-1", name: "Operations" } });
    renderApp("/org/org-1/document-folders/folder-1");
    const link = await screen.findByRole("link", { name: "Operations" });
    expect(link).toHaveAttribute("href", "/document-folders/parent-folder-123");
    expect(mocks.get).toHaveBeenCalledWith("docs-document-folders", "parent-folder-123", "org-1");
    expect(screen.queryByText("parent-folder-123")).not.toBeInTheDocument();
    expect(screen.queryByText("Parent folder ID")).not.toBeInTheDocument();
  });

  it.each(["missing", "denied", "wrong-organization"])("keeps a %s parent folder unavailable", async (state) => {
    mocks.get.mockImplementation(async (_table: string, id: string) => {
      if (id === "folder-1") return { id, data: { organization_id: "org-1", name: "Runbooks", parent_id: "private-parent-123" } };
      if (state === "denied") throw new Error("403 access denied");
      return state === "missing" ? null : { id, data: { organization_id: "org-other", name: "Foreign private folder" } };
    });
    renderApp("/org/org-1/document-folders/folder-1");
    expect(await screen.findByText(state === "denied" ? "Restricted folder" : "Folder unavailable")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Foreign private folder" })).not.toBeInTheDocument();
    expect(screen.queryByText("private-parent-123")).not.toBeInTheDocument();
  });

  it("confirms relationship removal before deleting the mapping", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Editor"] };
    mocks.query.mockImplementation(async (table: string) => table === "docs-relationships"
      ? { documents: [{ id: "relationship-1", data: { target_type: "documents", target_source_id: "related-1", relationship_type: "related" } }], total: 1 }
      : { documents: [], total: 0 });
    renderApp("/documents/document-1");
    fireEvent.click(await screen.findByRole("button", { name: "Related items" }));

    const relationship = (await screen.findByText("Document unavailable")).closest("li");
    expect(relationship).not.toBeNull();
    fireEvent.click(within(relationship!).getByRole("button", { name: "Remove" }));

    let confirmation = await screen.findByRole("dialog", { name: "Remove related item?" });
    expect(mocks.delete).not.toHaveBeenCalled();
    fireEvent.keyDown(confirmation, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove related item?" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Related items" })).toBeVisible();
    expect(mocks.delete).not.toHaveBeenCalled();
    fireEvent.click(within(relationship!).getByRole("button", { name: "Remove" }));
    confirmation = await screen.findByRole("dialog", { name: "Remove related item?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Remove relationship" }));
    expect(mocks.delete).toHaveBeenCalledWith("docs-relationships", "relationship-1");
  });

  it("renders the global view with cross-organization cards", async () => {
    mocks.query.mockImplementation(async () => ({ documents: [], total: 4 }));
    renderApp("/global");

    await screen.findByRole("heading", { name: "Global view" });
    expect(screen.getAllByText("4")[0]).toBeInTheDocument();
  });

  it("renders the organization directory", async () => {
    renderApp("/organizations");

    await screen.findByRole("heading", { name: "Organizations" });
    expect(screen.getByPlaceholderText("Search organizations...")).toBeInTheDocument();
  });

  it("renders settings sections for administrators", async () => {
    mocks.viewer = { is_superuser: false, roles: ["Bifrost Docs Administrator"] };
    renderApp("/settings");

    await screen.findByRole("heading", { name: "Settings" });
    expect(screen.getByRole("link", { name: "Knowledge & agent" })).toHaveAttribute("href", "/settings/knowledge");
  });
});

describe("document folder catalog status", () => {
  afterEach(cleanup);
  it("labels a retained document's missing folder as unavailable once the catalog settles", async () => {
    mocks.query.mockImplementation(async (table: string) => table === "docs-document-folders"
      ? { documents: [], total: 0 }
      : { documents: [{ id: "document-with-missing-folder", data: { name: "Retained document", folder_id: "missing-folder", organization_id: "org-1", source_system: "itglue" } }], total: 1 });

    renderApp("/org/org-1/documents");

    expect(await screen.findByText("Retained document")).toBeInTheDocument();
    expect(await screen.findByText("Folder unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Loading folder…")).not.toBeInTheDocument();
    expect(mocks.query.mock.calls.some(([table, options]) => table === "docs-documents"
      && options?.limit === 25
      && JSON.stringify(options.where) === JSON.stringify({ organization_id: "org-1" }))).toBe(true);
  });

  it("keeps the folder cell loading while its scoped catalog request is pending", async () => {
    let resolveFolders!: (value: { documents: never[]; total: number }) => void;
    const folders = new Promise<{ documents: never[]; total: number }>((resolve) => { resolveFolders = resolve; });
    mocks.query.mockImplementation((table: string) => table === "docs-document-folders"
      ? folders
      : Promise.resolve({ documents: [{ id: "document-with-pending-folder", data: { name: "Pending document", folder_id: "pending-folder", organization_id: "org-1", source_system: "itglue" } }], total: 1 }));

    renderApp("/org/org-1/documents");

    expect(await screen.findByText("Pending document")).toBeInTheDocument();
    expect(screen.getByText("Loading folder…")).toBeInTheDocument();
    resolveFolders({ documents: [], total: 0 });
    expect(await screen.findByText("Folder unavailable")).toBeInTheDocument();
  });
});
