import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocsOrganizationsProvider, useDocsOrganizations, type DocsOrganizationViewer } from "./useDocsOrganizations";
const mocks = vi.hoisted(() => ({ scope: null as string | null, mutate: vi.fn() }));
vi.mock("bifrost", () => ({ useBifrostContext: () => ({ orgScope: mocks.scope }), useWorkflowMutation: () => ({ mutate: mocks.mutate }) }));
function Consumer({ name }: { name: string }) {
 const state = useDocsOrganizations(); const navigate = useNavigate();
 return <div><output aria-label={name}>{state.organizationId}:{state.selected?.name ?? "none"}</output><output aria-label={`${name} load`}>{state.loading ? "loading" : "settled"}:{state.error}</output><button onClick={() => state.setOrganizationId("org-2")}>Select {name}</button><button onClick={() => navigate("/org/org-1/documents")}>Route {name}</button><button onClick={() => navigate("/global/documents")}>Global {name}</button><button onClick={state.retry}>Retry {name}</button></div>;
}
function app(path = "/", viewer?: DocsOrganizationViewer | null) { return render(<MemoryRouter initialEntries={[path]}><DocsOrganizationsProvider viewer={viewer}><Consumer name="header" /><Consumer name="catalog" /></DocsOrganizationsProvider></MemoryRouter>); }
afterEach(cleanup);
beforeEach(() => { localStorage.clear(); mocks.scope = null; mocks.mutate.mockReset().mockResolvedValue({ caller_mode: "picker", own_organization_id: "provider-org", organizations: [{ id: "org-1", name: "Northern Star" }, { id: "org-2", name: "Other" }] }); });
describe("shared Docs organization state", () => {
 it("waits for authenticated identity before requesting the Docs directory", () => {
  app("/", null);
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(screen.getByLabelText("header load")).toHaveTextContent("loading:");
 });
 it("uses the workflow's customer scope when the SDK scope is null", async () => {
  mocks.mutate.mockResolvedValue({ caller_mode: "fixed", own_organization_id: "org-1", organizations: [{ id: "org-1", name: "Northern Star" }] });
  app("/org/org-2/documents", { is_superuser: false, organization_id: "org-1" });
  await waitFor(() => expect(screen.getByLabelText("header")).toHaveTextContent("org-1:Northern Star"));
  expect(mocks.mutate).toHaveBeenCalledWith({});
  fireEvent.click(screen.getByText("Select header"));
  expect(screen.getByLabelText("catalog")).toHaveTextContent("org-1:Northern Star");
 });
 it("reports a missing organization without falling back to the platform endpoint", async () => {
  mocks.mutate.mockResolvedValue({ caller_mode: "missing", own_organization_id: null, organizations: [] });
  app("/", { is_superuser: false, organization_id: null });
  await waitFor(() => expect(screen.getByLabelText("header load")).toHaveTextContent("no assigned organization"));
  expect(mocks.mutate).toHaveBeenCalledWith({});
 });
 it("loads once for all consumers and shares selection, route scope, and global scope", async () => {
  app(); await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
  expect(mocks.mutate).toHaveBeenCalledWith({});
  fireEvent.click(screen.getByText("Select header"));
  await waitFor(() => expect(screen.getByLabelText("catalog")).toHaveTextContent("org-2:Other"));
  fireEvent.click(screen.getByText("Route catalog"));
  expect(screen.getByLabelText("header")).toHaveTextContent("org-1:Northern Star");
  fireEvent.click(screen.getByText("Global header"));
  expect(screen.getByLabelText("catalog")).toHaveTextContent(":none");
  expect(mocks.mutate).toHaveBeenCalledTimes(1);
 });
 it("keeps the host scope authoritative without requesting a directory", () => {
  mocks.scope = "org-1"; app("/org/org-2/documents");
  expect(screen.getByLabelText("header")).toHaveTextContent("org-1:Your organization");
  expect(screen.getByLabelText("header load")).toHaveTextContent("settled:");
  expect(mocks.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Select header"));
  fireEvent.click(screen.getByText("Global header"));
  expect(screen.getByLabelText("catalog")).toHaveTextContent("org-1:Your organization");
  expect(mocks.mutate).not.toHaveBeenCalled();
 });
 it("ignores a stale directory result after retry", async () => {
  let first!: (value: unknown) => void; let second!: (value: unknown) => void;
  mocks.mutate.mockImplementationOnce(() => new Promise((resolve) => { first = resolve; })).mockImplementationOnce(() => new Promise((resolve) => { second = resolve; }));
  app("/", { is_superuser: true });
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText("Retry header"));
  await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2));
  second({ caller_mode: "picker", own_organization_id: "provider-org", organizations: [{ id: "org-2", name: "New" }] });
  await waitFor(() => expect(screen.getByLabelText("header")).toHaveTextContent(":none"));
  fireEvent.click(screen.getByText("Select header"));
  expect(screen.getByLabelText("catalog")).toHaveTextContent("org-2:New");
  first({ caller_mode: "picker", own_organization_id: "provider-org", organizations: [{ id: "org-1", name: "Stale" }] });
  await waitFor(() => expect(screen.getByLabelText("catalog")).toHaveTextContent("org-2:New"));
 });
});
