import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  organizations: [{ id: "org-a", name: "Northern Star" }],
  recent: [
    { id: "org-a", kind: "organizations", name: "Old name", organizationId: "org-a", visitedAt: 3 },
    { id: "doc-a", kind: "documents", name: "VPN runbook", organizationId: "org-a", visitedAt: 2 },
  ],
}));

vi.mock("@/components/layout/useDocsOrganizations", () => ({
  useDocsOrganizations: () => ({ organizations: mocks.organizations }),
}));
vi.mock("@/components/layout/recentRecords", () => ({ useRecentRecords: () => mocks.recent }));

import { DashboardPage } from "./DashboardPage";

beforeEach(() => {
  mocks.recent = [
    { id: "org-a", kind: "organizations", name: "Old name", organizationId: "org-a", visitedAt: 3 },
    { id: "doc-a", kind: "documents", name: "VPN runbook", organizationId: "org-a", visitedAt: 2 },
  ];
});
afterEach(cleanup);

describe("DashboardPage", () => {
  it("restores the original recent organization and item rails", () => {
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent Organizations" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent Items" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Old name Organization" })).toHaveAttribute("href", "/org/org-a");
    expect(screen.getByRole("link", { name: /VPN runbook/ })).toHaveAttribute("href", "/org/org-a/documents/doc-a");
    expect(screen.queryByRole("heading", { name: "Quick links" })).not.toBeInTheDocument();
  });

  it("guides an empty dashboard to browse organizations", () => {
    mocks.recent = [];
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    expect(screen.getByRole("link", { name: "Browse organizations" })).toHaveAttribute("href", "/organizations");
  });
});
