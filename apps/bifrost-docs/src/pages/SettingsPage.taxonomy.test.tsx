import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), subscribe: vi.fn(() => vi.fn()) }));
vi.mock("bifrost", () => ({ tables: mocks, useWorkflowMutation: () => ({ loading: false, mutate: vi.fn() }) }));
vi.mock("@/components/layout/useDocsOrganizations", () => ({ useDocsOrganizations: () => ({ organizations: [{ id: "org-a", name: "Organization A" }], organizationId: "org-a", setOrganizationId: vi.fn(), loading: false }) }));

import { SettingsRoutes } from "./SettingsPage";
afterEach(() => { cleanup(); mocks.query.mockReset(); mocks.subscribe.mockClear(); });

function renderTaxonomy() {
  mocks.query.mockImplementation(async (table: string) => ({ table_id: table, documents: [{ id: table, data: { name: table === "docs-configuration-types" ? "Server" : "In service", source_system: "bifrost" } }] }));
  return render(<MemoryRouter initialEntries={["/settings/configuration-types"]}><Routes><Route path="/settings/*" element={<SettingsRoutes isAdmin />} /></Routes></MemoryRouter>);
}

describe("settings taxonomy navigation", () => {
  it("uses the settings navigation once instead of duplicating it inside the section", async () => {
    renderTaxonomy();
    await screen.findByText("Server");
    expect(screen.queryByRole("tablist", { name: "Taxonomy kind" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Configuration types" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Configuration type" })).toBeInTheDocument();
  });

  it("switches the queried table and creation action when the settings route changes", async () => {
    renderTaxonomy();
    await screen.findByText("Server");
    fireEvent.change(screen.getByRole("combobox", { name: "Settings section" }), { target: { value: "/settings/configuration-statuses" } });
    expect(await screen.findByText("In service")).toBeInTheDocument();
    expect(screen.queryByText("Server")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Configuration status" })).toBeInTheDocument();
    expect(mocks.query).toHaveBeenCalledWith("docs-configuration-statuses", expect.objectContaining({ where: { organization_id: "org-a" } }));
    fireEvent.change(screen.getByRole("combobox", { name: "Settings section" }), { target: { value: "/settings/configuration-types" } });
    expect(await screen.findByText("Server")).toBeInTheDocument();
    expect(screen.queryByText("In service")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Configuration type" })).toBeInTheDocument();
  });
});
