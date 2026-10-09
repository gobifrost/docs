import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationTaxonomyAdmin } from "./ConfigurationTaxonomy";

const mocks = vi.hoisted(() => ({ query: vi.fn(), subscribe: vi.fn(() => vi.fn()), update: vi.fn(), insert: vi.fn(), delete: vi.fn() }));
vi.mock("bifrost", () => ({ tables: mocks }));
vi.mock("./bifrost/BfDialog", () => ({ BfDialog: ({ children, title, footer }: { children: React.ReactNode; title: string; footer?: React.ReactNode }) => <div role="dialog" aria-label={title}>{children}{footer}</div> }));
afterEach(() => { cleanup(); mocks.query.mockReset(); mocks.subscribe.mockClear(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("ConfigurationTaxonomyAdmin", () => {
  it("dismisses the old delete confirmation when the standalone taxonomy kind changes", async () => {
    mocks.query.mockImplementation(async (table: string) => ({ table_id: table, documents: [{ id: table, data: { name: table === "docs-configuration-types" ? "Server" : "In service", source_system: "bifrost" } }] }));
    render(<ConfigurationTaxonomyAdmin organizationId="org-a" />);
    await screen.findByText("Server");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Configuration statuses" }));
    await screen.findByText("In service");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.delete).not.toHaveBeenCalled();
  });
  it("does not publish a delayed previous-organization response", async () => {
    const organizationA = deferred<{ table_id: string; documents: Array<{ id: string; data: { name: string } }> }>();
    mocks.query.mockImplementationOnce(() => organizationA.promise).mockResolvedValueOnce({ table_id: "table-b", documents: [{ id: "b", data: { name: "Organization B type" } }] });
    const view = render(<ConfigurationTaxonomyAdmin organizationId="org-a" hideHeader />);
    view.rerender(<ConfigurationTaxonomyAdmin organizationId="org-b" hideHeader />);
    expect(await screen.findByText("Organization B type")).toBeTruthy();

    organizationA.resolve({ table_id: "table-a", documents: [{ id: "a", data: { name: "Organization A type" } }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText("Organization A type")).toBeNull();
  });
});
