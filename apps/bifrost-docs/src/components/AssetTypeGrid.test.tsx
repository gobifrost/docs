import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), get: vi.fn(), subscribe: vi.fn(), organizationId: "org-a" }));
vi.mock("bifrost", () => ({ tables: { query: mocks.query, get: mocks.get, subscribe: mocks.subscribe } }));
vi.mock("@/components/layout/useDocsOrganizations", () => ({ useDocsOrganizations: () => ({ organizationId: mocks.organizationId }) }));
import { AssetTypeGrid, AssetTypeLink } from "./AssetTypeGrid";

function queryResult(table: string, options: Record<string, unknown>) {
  if (table === "docs-flexible-asset-types") return { table_id: "types-uuid", documents: [{ id: "type-1", data: { name: "Endpoints", fields: [], organization_id: "org-a" } }], total: 1 };
  if (table === "docs-flexible-assets") return { table_id: "assets-uuid", documents: [], total: 3 };
  throw new Error(`unexpected ${table} ${JSON.stringify(options)}`);
}

afterEach(() => { cleanup(); mocks.query.mockReset(); mocks.get.mockReset(); mocks.subscribe.mockReset(); mocks.organizationId = "org-a"; });

describe("asset type realtime data", () => {
  it("preserves the original inclusive asset browse grid count", async () => {
    mocks.query.mockImplementation(async (table: string, options: { where?: Record<string, unknown> }) => table === "docs-flexible-assets"
      ? { table_id: "assets-uuid", documents: [], total: (options.where?.is_enabled as { ne?: boolean })?.ne === false ? 2 : 3 }
      : queryResult(table, options));
    mocks.subscribe.mockReturnValue(vi.fn());
    render(<AssetTypeGrid onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Endpoints/ }).querySelector(".tabular-nums")).toHaveTextContent(/^3$/));
    for (const [, options] of mocks.query.mock.calls.filter(([table]) => table === "docs-flexible-assets")) expect(options.where?.is_enabled).toBeUndefined();
  });

  it("counts each shared imported type once across a provider's organization copies", async () => {
    mocks.organizationId = "";
    const copies = Array.from({ length: 88 }, (_, index) => ({ id: `copy-${index}`, data: { name: "Endpoints", source_system: "itglue", source_id: "source-7", organization_id: `org-${index}`, fields: ["hostname"] } }));
    mocks.query.mockImplementation(async (table: string, options: Record<string, unknown>) => {
      if (table === "docs-flexible-asset-types") return { table_id: "types-uuid", documents: copies, total: copies.length };
      return { table_id: "assets-uuid", documents: [], total: 1537 };
    });
    mocks.subscribe.mockReturnValue(vi.fn());
    render(<AssetTypeGrid onSelect={vi.fn()} />);
    expect(await screen.findAllByRole("button", { name: /Endpoints/ })).toHaveLength(1);
    expect(screen.getByText("1,537")).toBeInTheDocument();
    expect(mocks.query.mock.calls.filter(([table]) => table === "docs-flexible-assets")).toHaveLength(1);
    expect(mocks.query).toHaveBeenCalledWith("docs-flexible-assets", expect.objectContaining({ where: { flexible_asset_type_id: { in: copies.map(row => row.id) } } }));
  });

  it("subscribes using canonical scoped type and asset UUIDs", async () => {
    mocks.query.mockImplementation(queryResult);
    mocks.subscribe.mockReturnValue(vi.fn());
    render(<AssetTypeGrid onSelect={vi.fn()} />);
    expect(await screen.findByText("Endpoints")).toBeInTheDocument();
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith("types-uuid", { eq: [{ row: "organization_id" }, "org-a"] }, expect.any(Function), expect.any(Function)));
    expect(mocks.subscribe).toHaveBeenCalledWith("assets-uuid", { eq: [{ row: "organization_id" }, "org-a"] }, expect.any(Function), expect.any(Function));
  });

  it("reloads a linked type name after its scoped metadata changes", async () => {
    let event!: (message: { type: string }) => void;
    mocks.get.mockResolvedValueOnce({ table_id: "types-uuid", id: "type-1", data: { name: "Original", organization_id: "org-a" } })
      .mockResolvedValueOnce({ table_id: "types-uuid", id: "type-1", data: { name: "Renamed externally", organization_id: "org-a" } });
    mocks.subscribe.mockImplementation((_tableId, _filter, onEvent) => { event = onEvent; return vi.fn(); });
    render(<MemoryRouter><AssetTypeLink typeId="type-1" fallback="Fallback" /></MemoryRouter>);
    expect(await screen.findByText("Original")).toBeInTheDocument();
    event({ type: "document_change" });
    expect(await screen.findByText("Renamed externally")).toBeInTheDocument();
  });
});
