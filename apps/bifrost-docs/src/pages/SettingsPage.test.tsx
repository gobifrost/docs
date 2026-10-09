import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({ solutionId: "solution-1" as string | null }));
vi.mock("bifrost", () => ({ useBifrostContext: () => context, tables: { query: vi.fn(), get: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() }, useWorkflowMutation: () => ({ loading: false, mutate: vi.fn() }) }));
vi.mock("@/components/ConfigurationTaxonomy", () => ({ ConfigurationTaxonomyAdmin: () => null }));
vi.mock("@/components/layout/useDocsOrganizations", () => ({ useDocsOrganizations: () => ({ organizations: [], organizationId: "", setOrganizationId: vi.fn(), loading: false }) }));
vi.mock("@/lib/table-realtime", () => ({ useTableInvalidation: vi.fn() }));

import { normalizeSettingsPath, SettingsRoutes } from "./SettingsPage";
afterEach(cleanup);
beforeEach(() => { context.solutionId = "solution-1"; });

function renderBackup(isPlatformAdmin = true) {
  return render(<MemoryRouter initialEntries={["/settings/backup"]}><Routes><Route path="/settings/*" element={<SettingsRoutes isAdmin isPlatformAdmin={isPlatformAdmin} />} /></Routes></MemoryRouter>);
}

describe("settings path aliases", () => {
  it("keeps legacy AI and exports routes available through current settings sections", () => {
    expect(normalizeSettingsPath("/settings/ai")).toBe("/settings/knowledge");
    expect(normalizeSettingsPath("/settings/exports")).toBe("/settings/backup");
    expect(normalizeSettingsPath("/settings/unknown")).toBe("/settings/unknown");
  });
});

describe("backup scope", () => {
  it("opens the host-supplied Solution's native export screen for platform administrators", () => {
    context.solutionId = "another-install";
    renderBackup();
    expect(screen.getByRole("link", { name: "Manage backups" })).toHaveAttribute("href", "/solutions/another-install?tab=exports");
    expect(screen.getByText(/Include Table data and Solution-owned files/i)).toBeInTheDocument();
  });

  it("keeps platform backup actions unavailable to Docs-only administrators", () => {
    renderBackup(false);
    expect(screen.queryByRole("link", { name: "Manage backups" })).not.toBeInTheDocument();
    expect(screen.getByText(/Backups are managed by a Bifrost platform administrator/i)).toBeInTheDocument();
  });

  it("shows an actionable unavailable state when the host has no owning Solution", () => {
    context.solutionId = null;
    renderBackup();
    expect(screen.queryByRole("link", { name: "Manage backups" })).not.toBeInTheDocument();
    expect(screen.getByText(/Open Docs from its installed Solution/i)).toBeInTheDocument();
  });

  it("explains what a Docs backup restores and what must be prepared in the destination", () => {
    renderBackup();

    expect(screen.getByText(/Docs tables, record links, managed files, and Docs-wide configuration/i)).toBeInTheDocument();
    expect(screen.getByText(/Accounts, organizations, roles, and integration connections aren't included/i)).toBeInTheDocument();
    expect(screen.getByText(/Set them up in the destination and reconnect integrations before recovery/i)).toBeInTheDocument();
  });
});

describe("compact settings navigation", () => {
  it("selects named sections, follows aliases and updates the displayed content", () => {
    function CurrentPath() { return <output aria-label="Settings path">{useLocation().pathname}</output>; }
    render(<MemoryRouter initialEntries={["/settings/exports"]}><CurrentPath /><Routes><Route path="/settings/*" element={<SettingsRoutes isAdmin />} /></Routes></MemoryRouter>);
    const sections = screen.getByRole("combobox", { name: "Settings section" });
    expect(sections).toHaveValue("/settings/backup");
    expect(screen.getByText("Bifrost Docs backup")).toBeInTheDocument();
    fireEvent.change(sections, { target: { value: "/settings/custom-asset-types" } });
    expect(screen.getByLabelText("Settings path")).toHaveTextContent("/settings/custom-asset-types");
    expect(screen.queryByText("Bifrost Docs backup")).not.toBeInTheDocument();
    expect(sections).toHaveValue("/settings/custom-asset-types");
    fireEvent.change(sections, { target: { value: "/settings/backup" } });
    expect(screen.getByText("Bifrost Docs backup")).toBeInTheDocument();
  });
});
