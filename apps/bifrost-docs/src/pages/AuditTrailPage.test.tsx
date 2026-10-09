import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), subscribe: vi.fn(), retryScope: vi.fn(), organizationId: "org-a", mode: { kind: "picker" }, organizations: [{ id: "org-a", name: "Northern Star" }], loading: false, scopeError: "" }));
vi.mock("bifrost", () => ({ tables: { query: mocks.query, subscribe: mocks.subscribe } }));
vi.mock("@/components/layout/useDocsOrganizations", () => ({ useDocsOrganizations: () => ({ organizationId: mocks.organizationId, mode: mocks.mode, organizations: mocks.organizations, loading: mocks.loading, error: mocks.scopeError, retry: mocks.retryScope }) }));

import { AuditTrailPage } from "./AuditTrailPage";

const eventId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const recordId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const userId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const record = { id: eventId, data: { organization_id: "org-a", event_type: "document.draft_updated", entity_type: "document", entity_id: recordId, summary: "document draft_updated", actor: userId, occurred_at: "2026-10-01T10:00:00Z" } };

beforeEach(() => {
  mocks.organizationId = "org-a";
  mocks.mode = { kind: "picker" };
  mocks.organizations = [{ id: "org-a", name: "Northern Star" }];
  mocks.loading = false;
  mocks.scopeError = "";
  mocks.query.mockResolvedValue({ table_id: "audit-table", documents: [record], total: 1 });
  mocks.subscribe.mockReturnValue(vi.fn());
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Audit trail presentation", () => {
  it("waits for organization scope before issuing the first audit query", async () => {
    mocks.organizationId = "";
    mocks.loading = true;
    const view = render(<AuditTrailPage />);
    await act(async () => {});
    expect(mocks.query).not.toHaveBeenCalled();
    mocks.loading = false;
    mocks.organizationId = "org-a";
    view.rerender(<AuditTrailPage />);
    await screen.findByText("Draft updated");
    expect(mocks.query.mock.calls.every(([, options]) => options.where.organization_id === "org-a")).toBe(true);
  });

  it("stops querying after a scope error and retries the organization directory", async () => {
    const view = render(<AuditTrailPage />);
    await screen.findByText("Draft updated");
    mocks.scopeError = "Organization directory unavailable";
    const calls = mocks.query.mock.calls.length;
    view.rerender(<AuditTrailPage />);
    expect(await screen.findByText("Organization directory unavailable")).toBeVisible();
    expect(screen.queryByText("Draft updated")).not.toBeInTheDocument();
    expect(mocks.query).toHaveBeenCalledTimes(calls);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.retryScope).toHaveBeenCalledOnce();
  });

  it("shows readable activity with technical identifiers hidden until expanded", async () => {
    render(<AuditTrailPage />);
    const activity = await screen.findByText("Draft updated");
    const disclosure = activity.closest("details");
    expect(disclosure).not.toBeNull();
    expect(screen.queryByText("Policy-scoped")).not.toBeInTheDocument();
    expect(screen.getByText("document.draft_updated")).not.toBeVisible();
    expect(screen.getByText(recordId)).not.toBeVisible();
    expect(screen.getByText(userId)).not.toBeVisible();
    fireEvent.click(disclosure!.querySelector("summary")!);
    expect(screen.getByText("document.draft_updated")).toBeVisible();
    expect(screen.getByText(recordId)).toBeVisible();
    expect(screen.getByText(userId)).toBeVisible();
    expect(mocks.query).toHaveBeenCalledWith("docs-audit-events", expect.objectContaining({ where: { organization_id: "org-a" } }));
  });

  it.each([
    ["00000000-0000-0000-0000-000000000001", "System"],
    [userId, "User"],
    ["workflow", "Workflow"],
    ["", "Unknown actor"],
  ])("uses the honest label for actor %s", async (actor, expected) => {
    mocks.query.mockResolvedValue({ table_id: "audit-table", documents: [{ ...record, data: { ...record.data, actor } }], total: 1 });
    render(<AuditTrailPage />);
    const table = await screen.findByRole("table", { name: "Audit trail" });
    await waitFor(() => expect(within(table).getByRole("cell", { name: expected })).toBeVisible());
  });

  it("preserves a provided actor name and useful summary while formatting an unknown event", async () => {
    mocks.query.mockResolvedValue({ table_id: "audit-table", documents: [{ ...record, data: { ...record.data, event_type: "configuration.safety_check_completed", actor_name: "Alex Example", summary: "Reviewed the network configuration" } }], total: 1 });
    render(<AuditTrailPage />);
    expect(await screen.findByText("Configuration safety check completed")).toBeVisible();
    expect(screen.getAllByText("Alex Example").some(node => node.closest("td") && !node.closest("details"))).toBe(true);
    expect(screen.getByText("Reviewed the network configuration")).toBeVisible();
    expect(screen.getByText("configuration.safety_check_completed")).not.toBeVisible();
  });

  it("keeps organization names in the global audit list without showing raw organization IDs", async () => {
    render(<AuditTrailPage global />);
    const table = await screen.findByRole("table", { name: "Audit trail" });
    await waitFor(() => expect(within(table).getByRole("cell", { name: "Northern Star" })).toBeVisible());
    expect(within(table).getByRole("columnheader", { name: "Organization" })).toBeVisible();
    expect(mocks.query).toHaveBeenCalledWith("docs-audit-events", expect.objectContaining({ where: {} }));
  });

  it.each(["missing", "identifier-fallback"])("labels an organization as unavailable when its directory name is %s", async (state) => {
    mocks.organizations = state === "missing" ? [] : [{ id: "org-a", name: "org-a" }];
    render(<AuditTrailPage global />);
    const table = await screen.findByRole("table", { name: "Audit trail" });
    await waitFor(() => expect(within(table).getByRole("cell", { name: "Organization unavailable" })).toBeVisible());
  });

  it("accepts human event words and resets pagination while retaining organization scope", async () => {
    mocks.query.mockResolvedValue({ table_id: "audit-table", documents: [record], total: 100 });
    render(<AuditTrailPage />);
    await screen.findByText("document.draft_updated");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(mocks.query).toHaveBeenLastCalledWith("docs-audit-events", expect.objectContaining({ offset: 50 })));
    fireEvent.change(screen.getByRole("textbox", { name: "Filter events" }), { target: { value: "draft updated" } });
    await waitFor(() => expect(mocks.query).toHaveBeenLastCalledWith("docs-audit-events", expect.objectContaining({ where: { organization_id: "org-a", event_type: { in: ["document.draft_updated"] } }, offset: 0 })));
  });

  it("uses the SDK's supported substring filter for partial event names", async () => {
    render(<AuditTrailPage />);
    await screen.findByText("document.draft_updated");
    fireEvent.change(screen.getByRole("textbox", { name: "Filter events" }), { target: { value: "updated" } });
    await waitFor(() => expect(mocks.query).toHaveBeenLastCalledWith("docs-audit-events", expect.objectContaining({ where: { organization_id: "org-a", event_type: { contains: "updated" } } })));
  });

  it("distinguishes a filter with no matches from an organization with no activity", async () => {
    mocks.query.mockImplementation(async (_table: string, options: { where: Record<string, unknown> }) => ({ table_id: "audit-table", documents: options.where.event_type ? [] : [record], total: options.where.event_type ? 0 : 1 }));
    render(<AuditTrailPage />);
    await screen.findByText("Draft updated");
    fireEvent.change(screen.getByRole("textbox", { name: "Filter events" }), { target: { value: "no matching event" } });
    expect(await screen.findByText("No matching audit events")).toBeVisible();
    expect(screen.queryByText("No audit events yet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(await screen.findByText("Draft updated")).toBeVisible();
  });

  it("removes expanded identifiers when the audit subscription loses access", async () => {
    render(<AuditTrailPage />);
    const activity = await screen.findByText("Draft updated");
    fireEvent.click(activity.closest("summary")!);
    expect(screen.getByText(recordId)).toBeVisible();
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalled());
    mocks.query.mockRejectedValue(new Error("403 access denied"));
    act(() => mocks.subscribe.mock.calls[0][2]({ type: "subscription_revoked" }));
    expect(screen.queryByText(recordId)).not.toBeInTheDocument();
    await screen.findByRole("alert");
    expect(screen.queryByText("Draft updated")).not.toBeInTheDocument();
  });

  it("keeps an expanded event readable while a realtime refresh is pending", async () => {
    render(<AuditTrailPage />);
    const activity = await screen.findByText("Draft updated");
    fireEvent.click(activity.closest("summary")!);
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalled());
    let release: ((value: { table_id: string; documents: typeof record[]; total: number }) => void) | undefined;
    mocks.query.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    act(() => mocks.subscribe.mock.calls[0][2]({ type: "document_change" }));
    await waitFor(() => expect(release).toBeDefined());
    expect(screen.getByText(recordId)).toBeVisible();
    await act(async () => release?.({ table_id: "audit-table", documents: [record], total: 1 }));
    expect(screen.getByText(recordId)).toBeVisible();
  });
});
