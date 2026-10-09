import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchDialog } from "./SearchDialog";
const mocks = vi.hoisted(() => ({ query: vi.fn(), scope: { organizationId: "org-1", mode: { kind: "fixed" as "fixed" | "picker" }, organizations: [{ id: "org-1", name: "Northern Star" }] } }));
vi.mock("bifrost", () => ({ tables: { query: mocks.query } }));
vi.mock("./useDocsOrganizations", () => ({ useDocsOrganizations: () => mocks.scope }));
afterEach(cleanup);
beforeEach(() => { mocks.scope.mode.kind = "fixed"; mocks.query.mockReset().mockImplementation(async (table, params) => table === "docs-documents" && params.where.content ? { documents: [{ id: "doc-1", data: { name: "Runbook", organization_id: "org-1", content: "<p>Find printer setup</p>" } }], total: 1 } : { documents: [], total: 0 }); });
function openSearch() { render(<MemoryRouter><SearchDialog open onOpenChange={vi.fn()} /></MemoryRouter>); fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "printer" } }); }
describe("catalog search", () => {
 it("finds body-only matches, groups them, and scopes every fixed-tenant query", async () => {
  openSearch(); const link = await screen.findByRole("link", { name: "Runbook Northern Star" });
  expect(link).toHaveAttribute("href", "/org/org-1/documents/doc-1");
  expect(mocks.query.mock.calls.every(([, params]) => params.where.organization_id === "org-1")).toBe(true);
  expect(mocks.query.mock.calls.filter(([table]) => table === "docs-passwords").every(([, params]) => !params.where.password && !params.where.value)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Preview Runbook" }));
  expect(screen.getByText("Find printer setup")).toBeInTheDocument();
 });
 it("allows provider global search without carrying the prior tenant filter", async () => {
  mocks.scope.mode.kind = "picker"; openSearch();
  fireEvent.click(screen.getByRole("button", { name: "Northern Star" }));
  await waitFor(() => expect(mocks.query).toHaveBeenCalled());
  expect(mocks.query.mock.calls.every(([, params]) => params.where.organization_id === undefined)).toBe(true);
 });
 it("reports a failed resource query without pretending there are no records", async () => {
  mocks.query.mockRejectedValue(new Error("Disconnected")); openSearch();
  expect(await screen.findByText("Some results could not load")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(screen.queryByText("No matching records.")).not.toBeInTheDocument();
 });
});

it("uses a fixed relationship scope and excludes the source and foreign records", async () => {
  mocks.scope.mode.kind = "picker";
  mocks.query.mockImplementation(async (table: string) => table === "docs-documents" ? { documents: [
    { id: "source", data: { name: "Source record", organization_id: "org-1" } },
    { id: "allowed", data: { name: "Named target", organization_id: "org-1", source_id: "source-allowed" } },
    { id: "foreign", data: { name: "Other organization", organization_id: "org-2" } },
  ], total: 3 } : { documents: [], total: 0 });
  const select = vi.fn();
  render(<MemoryRouter><SearchDialog open onOpenChange={vi.fn()} organizationScope="org-1" excludedRecord={{ id: "source", kind: "documents" }} onSelect={select} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "Named" } });
  const target = await screen.findByRole("button", { name: "Link Named target" });
  expect(screen.queryByRole("button", { name: "Link Source record" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Link Other organization" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "All organizations" })).not.toBeInTheDocument();
  fireEvent.click(target);
  await waitFor(() => expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "allowed", sourceId: "source-allowed", organizationId: "org-1" })));
  expect(mocks.query.mock.calls.every(([, params]) => params.where.organization_id === "org-1")).toBe(true);
});

it("keeps a failed link selection open and available for retry", async () => {
  const select = vi.fn().mockRejectedValue(new Error("Disconnected"));
  const close = vi.fn();
  render(<MemoryRouter><SearchDialog open onOpenChange={close} organizationScope="org-1" onSelect={select} /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "printer" } });
  fireEvent.click(await screen.findByRole("button", { name: "Link Runbook" }));
  expect(await screen.findByText("Could not link record")).toBeVisible();
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Link Runbook" })).toBeEnabled();
});
