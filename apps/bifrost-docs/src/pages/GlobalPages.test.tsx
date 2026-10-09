import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), get: vi.fn(), subscribe: vi.fn(), organizationId: "" }));
vi.mock("bifrost", () => ({ tables: { query: mocks.query, get: mocks.get, subscribe: mocks.subscribe } }));
vi.mock("@/components/layout/useDocsOrganizations", () => ({ useDocsOrganizations: () => ({ organizationId: mocks.organizationId }) }));
vi.mock("@/components/layout/useOrgNameMap", () => ({ useOrgNameMap: () => ({ "org-a": "Organization A", "org-b": "Organization B" }) }));
vi.mock("@/components/bifrost/BfDataTable", () => ({ BfDataTable: ({ rows, caption }: { rows: Array<{ id: string }>; caption: string }) => <div aria-label="results">{caption}:{rows.map((row) => row.id).join(",")}</div> }));

import { GlobalKindPage, GlobalPage } from "./GlobalPages";

const importedA = { id: "destination-a", data: { name: "Endpoints", source_system: "itglue", source_id: "source-type-7", organization_id: "org-a", fields: [] } };
const importedB = { id: "destination-b", data: { name: "Endpoints", source_system: "itglue", source_id: "source-type-7", organization_id: "org-b", fields: [] } };

function response(table: string) {
  if (table === "docs-flexible-asset-types") return { table_id: "types-uuid", documents: [importedA, importedB], total: 2 };
  if (table === "docs-configuration-types") return { table_id: "configuration-types-uuid", documents: [{ id: "configuration-type", data: { name: "Firewall" } }], total: 1 };
  if (table === "docs-configurations") return { table_id: "configurations-uuid", documents: [{ id: "configuration", data: { configuration_type_name: "Firewall" } }], total: 1 };
  if (table === "docs-flexible-assets") return { table_id: "assets-uuid", documents: [{ id: "asset", data: { name: "Router", organization_id: "org-b" } }], total: 7 };
  return { table_id: `${table}-uuid`, documents: [], total: 2 };
}

beforeEach(() => {
  mocks.query.mockImplementation(async (table: string) => response(table));
  mocks.get.mockResolvedValue({ table_id: "types-uuid", data: { fields: [] } });
  mocks.subscribe.mockReturnValue(vi.fn());
});
afterEach(() => { cleanup(); mocks.query.mockReset(); mocks.get.mockReset(); mocks.subscribe.mockReset(); mocks.organizationId = ""; });

describe("Global pages", () => {
  it.each(["", "org-a"])("counts enabled overview records with legacy defaults in scope %s", async (organizationId) => {
    mocks.organizationId = organizationId;
    const tables = ["docs-passwords", "docs-locations", "docs-documents", "docs-configurations", "docs-flexible-assets"];
    const expected = organizationId ? 2 : 3;
    mocks.query.mockImplementation(async (table: string, options: { where?: Record<string, unknown>; limit: number }) => {
      if (table === "docs-flexible-asset-types") {
        const documents = [importedA, importedB].filter(row => !options.where?.organization_id || row.data.organization_id === options.where.organization_id);
        return { table_id: "types-uuid", documents, total: documents.length };
      }
      if (!tables.includes(table)) return response(table);
      const rows = [
        { id: "active", data: { organization_id: "org-a", is_enabled: true, configuration_type_name: "Firewall", flexible_asset_type_id: "destination-a" } },
        { id: "legacy", data: { organization_id: "org-a", configuration_type_name: "Firewall", flexible_asset_type_id: "destination-a" } },
        { id: "disabled", data: { organization_id: "org-a", is_enabled: false, configuration_type_name: "Firewall", flexible_asset_type_id: "destination-a" } },
        { id: "other", data: { organization_id: "org-b", is_enabled: true, configuration_type_name: "Firewall", flexible_asset_type_id: "destination-b" } },
      ].filter(row => (!options.where?.organization_id || row.data.organization_id === options.where.organization_id)
        && ((options.where?.is_enabled as { ne?: boolean })?.ne !== false || row.data.is_enabled !== false));
      return { table_id: `${table}-uuid`, documents: rows.slice(0, options.limit), total: rows.length };
    });
    render(<MemoryRouter><GlobalPage /></MemoryRouter>);
    for (const name of ["Passwords", "Locations", "Documents", "Firewall", "Endpoints"]) {
      await waitFor(() => expect(screen.getByRole("link", { name: new RegExp(name) }).querySelector(".tabular-nums")).toHaveTextContent(`${expected} enabled`));
    }
    for (const [table, options] of mocks.query.mock.calls.filter(([table]) => tables.includes(table))) {
      expect(options.limit).toBe(1);
      expect(options.where).toMatchObject({ is_enabled: { ne: false } });
      if (organizationId) expect(options.where).toMatchObject({ organization_id: organizationId });
      if (table === "docs-configurations") expect(options.where).toMatchObject({ configuration_type_name: "Firewall" });
      if (table === "docs-flexible-assets") expect(options.where).toMatchObject({ flexible_asset_type_id: { in: organizationId ? ["destination-a"] : ["destination-a", "destination-b"] } });
    }
  });

  it.each([
    ["/global/configurations", "docs-configurations"],
    ["/global/locations", "docs-locations"],
    ["/global/assets/destination-a", "docs-flexible-assets"],
  ])("preserves the original inclusive global listing at %s", async (path, targetTable) => {
    mocks.query.mockImplementation(async (table: string) => table === targetTable
      ? { documents: [{ id: "disabled-record", data: { name: "Disabled record", is_enabled: false, organization_id: "org-a" } }], total: 1 }
      : response(table));
    render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/global/assets/:typeId" element={<GlobalKindPage />} /><Route path="/global/:kind" element={<GlobalKindPage />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText("results")).toHaveTextContent("disabled-record"));
    for (const [, options] of mocks.query.mock.calls.filter(([table]) => table === targetTable)) expect(options.where?.is_enabled).toBeUndefined();
    expect(screen.queryByRole("switch", { name: "Show disabled" })).not.toBeInTheDocument();
  });

  it("keeps search, clear and compact refresh actions together without losing the query", async () => {
    render(<MemoryRouter initialEntries={["/global/documents"]}><Routes><Route path="/global/:kind" element={<GlobalKindPage />} /></Routes></MemoryRouter>);
    const search = await screen.findByRole("textbox", { name: "Search documents" });
    fireEvent.change(search, { target: { value: "runbook" } });
    await waitFor(() => expect(mocks.query).toHaveBeenCalledWith("docs-documents", expect.objectContaining({ where: expect.objectContaining({ name: { contains: "runbook" } }) })));
    const refresh = screen.getByRole("button", { name: "Refresh records" });
    expect(refresh).not.toHaveTextContent("Refresh");
    fireEvent.click(refresh);
    expect(search).toHaveValue("runbook");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search).toHaveValue("");
  });
  it("preserves the original descriptive card hierarchy with truthful password scope", async () => {
    render(<MemoryRouter><GlobalPage /></MemoryRouter>);

    expect(await screen.findByRole("link", { name: /Endpoints/ })).toHaveTextContent("Custom asset items");
    expect(screen.getByRole("link", { name: /Firewall/ })).toHaveTextContent("Configuration items");
    expect(screen.getByRole("link", { name: /Passwords/ })).toHaveTextContent("Metadata across organizations; values stay in IT Glue");
    expect(screen.getByRole("link", { name: /Locations/ })).toHaveTextContent("Physical and virtual locations");
    expect(screen.getByRole("link", { name: /Documents/ })).toHaveTextContent("Documentation across organizations");
  });

  it("renders the original typed sections and a single global card for two imported copies", async () => {
    render(<MemoryRouter><GlobalPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Core assets" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Configurations" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Custom assets" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link", { name: /Endpoints/ })).toHaveAttribute("href", "/global/assets/destination-a"));
    expect(screen.getByRole("link", { name: /Firewall/ })).toHaveAttribute("href", "/global/configurations?type=Firewall");
    expect(screen.getByRole("link", { name: /Endpoints/ })).toHaveTextContent("7");
  });

  it("loads typed configuration totals without downloading every configuration record", async () => {
    mocks.query.mockImplementation(async (table: string, options: Record<string, unknown>) => {
      if (table === "docs-configuration-types") return { table_id: "configuration-types-uuid", documents: [{ id: "configuration-type", data: { name: "Firewall" } }], total: 1 };
      if (table === "docs-configurations") {
        const where = options.where as Record<string, unknown> | undefined;
        if (options.limit === 1 && where?.configuration_type_name === "Firewall") return { table_id: "configurations-uuid", documents: [], total: 12500 };
        throw new Error("Detailed configuration payload exceeds the request budget");
      }
      return response(table);
    });
    render(<MemoryRouter><GlobalPage /></MemoryRouter>);

    expect(await screen.findByRole("link", { name: /Firewall/ })).toHaveTextContent("12,500");
    expect(screen.queryByText(/Detailed configuration payload/)).not.toBeInTheDocument();
  });

  it("keeps verified type card links usable while a realtime refresh is pending", async () => {
    render(<MemoryRouter><GlobalPage /></MemoryRouter>);
    expect(await screen.findByRole("link", { name: /Endpoints/ })).toBeInTheDocument();
    await waitFor(() => expect(mocks.subscribe.mock.calls.some(([id]) => id === "types-uuid")).toBe(true));
    let release: ((value: ReturnType<typeof response>) => void) | undefined;
    mocks.query.mockImplementation(async (table: string) => table === "docs-flexible-asset-types" ? new Promise((resolve) => { release = resolve; }) : response(table));
    const subscription = mocks.subscribe.mock.calls.find(([id]) => id === "types-uuid");
    act(() => subscription?.[2]({ type: "document_change" }));
    await waitFor(() => expect(release).toBeDefined());

    expect(screen.getByRole("link", { name: /Endpoints/ })).toBeInTheDocument();
    await act(async () => release?.(response("docs-flexible-asset-types")));
  });

  it("shows a pending state when retrying a failed type snapshot", async () => {
    mocks.query.mockImplementation(async (table: string) => {
      if (table === "docs-flexible-asset-types") throw new Error("Type directory unavailable");
      return response(table);
    });
    render(<MemoryRouter><GlobalPage /></MemoryRouter>);
    await screen.findByText("Type directory unavailable");
    let release: ((value: ReturnType<typeof response>) => void) | undefined;
    mocks.query.mockImplementation(async (table: string) => table === "docs-flexible-asset-types" ? new Promise((resolve) => { release = resolve; }) : response(table));
    act(() => screen.getByRole("button", { name: "Retry" }).click());
    await waitFor(() => expect(release).toBeDefined());

    expect(screen.queryByText("No custom asset types are available in this scope.")).not.toBeInTheDocument();
    await act(async () => release?.(response("docs-flexible-asset-types")));
    expect(await screen.findByRole("link", { name: /Endpoints/ })).toBeInTheDocument();
  });

  it("renders valid Global error alerts with retry controls", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.query.mockImplementation(async (table: string) => {
        if (table === "docs-flexible-asset-types") throw new Error("Type directory unavailable");
        return response(table);
      });
      render(<MemoryRouter><GlobalPage /></MemoryRouter>);
      await screen.findByText("Type directory unavailable");

      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("filters a global asset route across every matching imported destination type", async () => {
    render(<MemoryRouter initialEntries={["/global/assets/destination-b"]}><Routes><Route path="/global/assets/:typeId" element={<GlobalKindPage />} /></Routes></MemoryRouter>);

    await waitFor(() => expect(mocks.query).toHaveBeenCalledWith("docs-flexible-assets", expect.objectContaining({ where: expect.objectContaining({ flexible_asset_type_id: { in: ["destination-a", "destination-b"] } }) })));
  });

  it("filters global configurations by the clicked stored type name", async () => {
    render(<MemoryRouter initialEntries={["/global/configurations?type=Firewall"]}><Routes><Route path="/global/:kind" element={<GlobalKindPage />} /></Routes></MemoryRouter>);

    await waitFor(() => expect(mocks.query).toHaveBeenCalledWith("docs-configurations", expect.objectContaining({ where: expect.objectContaining({ configuration_type_name: "Firewall" }) })));
    expect(screen.getByRole("heading", { name: "Configurations — Firewall" })).toBeInTheDocument();
  });
});
