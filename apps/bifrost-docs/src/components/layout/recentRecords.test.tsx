import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), mutate: vi.fn(), scope: "org-a" as string | null }));
vi.mock("bifrost", () => ({
  tables: { get: mocks.get },
  useBifrostContext: () => ({ orgScope: mocks.scope }),
  useWorkflowMutation: () => ({ mutate: mocks.mutate }),
}));
import { DocsOrganizationsProvider } from "./useDocsOrganizations";
import { readRecentRecords, trackRecentRecord, useRecentRecords } from "./recentRecords";

function Probe() {
  const records = useRecentRecords();
  return <output>{records.map((record) => record.name).join(",")}</output>;
}
function view(viewerId: string) {
  return render(<MemoryRouter><DocsOrganizationsProvider viewer={{ id: viewerId }}><Probe /></DocsOrganizationsProvider></MemoryRouter>);
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((next) => { resolve = next; }); return { promise, resolve }; }

afterEach(() => { cleanup(); mocks.get.mockReset(); mocks.mutate.mockReset(); mocks.scope = "org-a"; window.localStorage.clear(); });

describe("recent record isolation", () => {
  it("keeps local recent caches separate for different authenticated users", () => {
    window.localStorage.setItem("bifrost-docs-recent", JSON.stringify([{ id: "legacy", name: "Prior account" }]));
    trackRecentRecord("user-a", { id: "a", kind: "documents", name: "A", organizationId: "org-a" });
    trackRecentRecord("user-b", { id: "b", kind: "documents", name: "B", organizationId: "org-a" });
    expect(readRecentRecords("user-a").map((record) => record.id)).toEqual(["a"]);
    expect(readRecentRecords("user-b").map((record) => record.id)).toEqual(["b"]);
    expect(readRecentRecords()).toEqual([]);
    expect(window.localStorage.getItem("bifrost-docs-recent")).toBeNull();
  });

  it("does not display denied or deleted cached records", async () => {
    trackRecentRecord("user-a", { id: "allowed", kind: "documents", name: "Cached allowed", organizationId: "org-a" });
    trackRecentRecord("user-a", { id: "denied", kind: "documents", name: "Cached denied", organizationId: "org-a" });
    trackRecentRecord("user-a", { id: "deleted", kind: "documents", name: "Cached deleted", organizationId: "org-a" });
    mocks.get.mockImplementation(async (_table, id) => id === "allowed"
      ? { id, data: { organization_id: "org-a", name: "Authorized name" } }
      : id === "deleted" ? null : Promise.reject(new Error("denied")));
    view("user-a");
    expect(await screen.findByText("Authorized name")).toBeInTheDocument();
    expect(screen.queryByText("Cached denied")).toBeNull();
    expect(screen.queryByText("Cached deleted")).toBeNull();
  });

  it("drops delayed results after the authenticated user changes", async () => {
    trackRecentRecord("user-a", { id: "a", kind: "documents", name: "A", organizationId: "org-a" });
    trackRecentRecord("user-b", { id: "b", kind: "documents", name: "B", organizationId: "org-a" });
    const delayedA = deferred<{ id: string; data: { organization_id: string; name: string } }>();
    mocks.get.mockImplementation((_table, id) => id === "a" ? delayedA.promise : Promise.resolve({ id, data: { organization_id: "org-a", name: "User B record" } }));
    const rendered = view("user-a");
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith("docs-documents", "a", "org-a"));
    rendered.rerender(<MemoryRouter><DocsOrganizationsProvider viewer={{ id: "user-b" }}><Probe /></DocsOrganizationsProvider></MemoryRouter>);
    expect(await screen.findByText("User B record")).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith("docs-documents", "b", "org-a");
    delayedA.resolve({ id: "a", data: { organization_id: "org-a", name: "Leaked A record" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText("Leaked A record")).toBeNull();
  });

  it("resolves organization visits only from the verified provider directory without table reads", async () => {
    mocks.scope = null;
    mocks.mutate.mockResolvedValue({ caller_mode: "picker", own_organization_id: "provider-org", organizations: [{ id: "org-a", name: "Northern Star" }] });
    trackRecentRecord("user-a", { id: "org-a", kind: "organizations", name: "Cached organization", organizationId: "org-a" });
    trackRecentRecord("user-a", { id: "org-b", kind: "organizations", name: "Unauthorized organization", organizationId: "org-b" });

    view("user-a");

    expect(await screen.findByText("Northern Star")).toBeInTheDocument();
    expect(screen.queryByText("Cached organization")).toBeNull();
    expect(screen.queryByText("Unauthorized organization")).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
