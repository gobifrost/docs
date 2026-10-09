import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  subscribe: vi.fn(),
  organizationId: "org-a",
}));
vi.mock("bifrost", () => ({ tables: { query: mocks.query, subscribe: mocks.subscribe } }));
vi.mock("./useDocsOrganizations", () => ({ useDocsOrganizations: () => ({ organizationId: mocks.organizationId }) }));

import { Sidebar } from "./Sidebar";

function response(table: string) {
  return table === "docs-flexible-asset-types"
    ? { table_id: "asset-types-uuid", documents: [{ id: "type-1", data: { name: "Endpoints" } }], total: 1 }
    : { table_id: `${table}-uuid`, documents: [], total: 2 };
}

afterEach(() => {
  cleanup();
  mocks.query.mockReset();
  mocks.subscribe.mockReset();
  mocks.organizationId = "org-a";
  localStorage.clear();
});

describe("Sidebar realtime data", () => {
  it.each(["org-a", ""])("counts enabled records and legacy native rows in sidebar scope %s", async (organizationId) => {
    mocks.organizationId = organizationId;
    const expected = organizationId ? 2 : 3;
    const countTables = ["docs-passwords", "docs-locations", "docs-documents", "docs-configurations"];
    mocks.query.mockImplementation(async (table: string, options: { where?: Record<string, unknown>; limit: number }) => {
      if (!countTables.includes(table)) return response(table);
      const rows = [
        { id: "active", data: { organization_id: "org-a", is_enabled: true } },
        { id: "legacy", data: { organization_id: "org-a" } },
        { id: "disabled", data: { organization_id: "org-a", is_enabled: false } },
        { id: "other", data: { organization_id: "org-b", is_enabled: true } },
      ].filter(row => (!options.where?.organization_id || row.data.organization_id === options.where.organization_id)
        && ((options.where?.is_enabled as { ne?: boolean })?.ne !== false || row.data.is_enabled !== false));
      return { table_id: `${table}-uuid`, documents: rows.slice(0, options.limit), total: rows.length };
    });
    mocks.subscribe.mockReturnValue(vi.fn());
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
    try {
      render(<MemoryRouter initialEntries={[organizationId ? "/org/org-a/configurations" : "/global"]}><Sidebar isMobileMenuOpen={false} setIsMobileMenuOpen={vi.fn()} isAdmin={false} onSearchClick={vi.fn()} /></MemoryRouter>);
      for (const name of ["Passwords", "Locations", "Documents", "Configurations"]) {
        await waitFor(() => expect(screen.getByRole("link", { name }).querySelector(".tabular-nums")).toHaveTextContent(String(expected)));
        expect(screen.getByRole("link", { name }).querySelector(".tabular-nums")).toHaveAttribute("title", `${expected} enabled records`);
      }
      for (const [, options] of mocks.query.mock.calls.filter(([table]) => countTables.includes(table))) {
        expect(options.limit).toBe(1);
        expect(options.where).toEqual({ is_enabled: { ne: false }, ...(organizationId ? { organization_id: organizationId } : {}) });
      }
    } finally { Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia }); }
  });

  it("collapses the application navigation for scoped document workspaces and allows expansion", async () => {
    mocks.query.mockImplementation(async (table: string) => response(table));
    mocks.subscribe.mockReturnValue(vi.fn());
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
    try {
      render(<MemoryRouter initialEntries={["/org/org-a/documents/doc-1"]}><Sidebar isMobileMenuOpen={false} setIsMobileMenuOpen={vi.fn()} isAdmin={false} onSearchClick={vi.fn()} /></MemoryRouter>);
      await screen.findByRole("link", { name: "Documents" });
      expect(document.querySelector("aside")).toHaveAttribute("data-collapsed", "true");
      fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
      expect(document.querySelector("aside")).not.toHaveAttribute("data-collapsed");
      expect(localStorage.getItem("bifrost-docs-sidebar-collapsed")).toBeNull();
    } finally { Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia }); }
  });

  it.each([
    ["/org/org-a/browse", true],
    ["/org/org-a/browse?type=documents", true],
    ["/org/org-a/browse?type=unknown", true],
    ["/browse?type=documents", true],
    ["/org/org-a/browse?type=passwords", false],
    ["/org/org-a/browse?type=document-folders", false],
  ])("matches the folder workspace navigation on %s", async (route, collapsed) => {
    mocks.query.mockImplementation(async (table: string) => response(table));
    mocks.subscribe.mockReturnValue(vi.fn());
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
    try {
      render(<MemoryRouter initialEntries={[route]}><Sidebar isMobileMenuOpen={false} setIsMobileMenuOpen={vi.fn()} isAdmin={false} onSearchClick={vi.fn()} /></MemoryRouter>);
      await screen.findByRole("link", { name: "Documents" });
      expect(document.querySelector("aside")?.getAttribute("data-collapsed") === "true").toBe(collapsed);
      if (collapsed) {
        fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
        expect(document.querySelector("aside")).not.toHaveAttribute("data-collapsed");
        expect(localStorage.getItem("bifrost-docs-sidebar-collapsed")).toBeNull();
      }
    } finally { Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia }); }
  });

  it("keeps mobile application navigation labelled even in a document workspace", async () => {
    mocks.query.mockImplementation(async (table: string) => response(table));
    mocks.subscribe.mockReturnValue(vi.fn());
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
    try {
      render(<MemoryRouter initialEntries={["/org/org-a/documents/doc-1"]}><Sidebar isMobileMenuOpen setIsMobileMenuOpen={vi.fn()} isAdmin={false} onSearchClick={vi.fn()} /></MemoryRouter>);
      await screen.findByRole("link", { name: "Documents" });
      expect(document.querySelector("aside")).not.toHaveAttribute("data-collapsed");
      expect(screen.getByRole("link", { name: "Documents" })).toHaveTextContent("Documents");
    } finally { Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia }); }
  });

  it.each([
    ["/org/org-a/browse", "org-a"],
    ["/org/org-a/browse?type=documents&q=guide", "org-a"],
    ["/org/org-a/browse?type=unknown", "org-a"],
    ["/browse?type=documents", "org-a"],
    ["/browse", ""],
  ])("marks Documents current when the catalog displays documents on %s", async (route, organizationId) => {
    mocks.organizationId = organizationId;
    mocks.query.mockImplementation(async (table: string) => response(table));
    mocks.subscribe.mockReturnValue(vi.fn());
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
    try {
      render(<MemoryRouter initialEntries={[route]}><Sidebar isMobileMenuOpen={false} setIsMobileMenuOpen={vi.fn()} isAdmin={false} onSearchClick={vi.fn()} /></MemoryRouter>);
      const documents = await screen.findByRole("link", { name: "Documents" });
      expect(documents).toHaveAttribute("aria-current", "page");
      expect(documents).toHaveAttribute("data-active", "true");
      expect(document.querySelectorAll('[data-sidebar-nav-item][aria-current="page"]')).toHaveLength(1);
    } finally { Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia }); }
  });

  it("marks Documents current in the mobile catalog navigation without highlighting other catalogs", async () => {
    mocks.query.mockImplementation(async (table: string) => response(table));
    mocks.subscribe.mockReturnValue(vi.fn());
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
    try {
      const view = render(<MemoryRouter initialEntries={["/org/org-a/browse"]}><Sidebar isMobileMenuOpen setIsMobileMenuOpen={vi.fn()} isAdmin={false} onSearchClick={vi.fn()} /></MemoryRouter>);
      expect(await screen.findByRole("link", { name: "Documents" })).toHaveAttribute("aria-current", "page");
      view.unmount();
      render(<MemoryRouter initialEntries={["/org/org-a/browse?type=passwords"]}><Sidebar isMobileMenuOpen setIsMobileMenuOpen={vi.fn()} isAdmin={false} onSearchClick={vi.fn()} /></MemoryRouter>);
      expect(await screen.findByRole("link", { name: "Documents" })).not.toHaveAttribute("aria-current");
      expect(screen.getByRole("link", { name: "Documents" })).not.toHaveAttribute("data-active");
    } finally { Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia }); }
  });

  it("subscribes by canonical scoped UUIDs and refetches after an external change", async () => {
    let assetEvent!: (event: { type: string }) => void;
    mocks.query.mockImplementation(async (table: string) => response(table));
    mocks.subscribe.mockImplementation((tableId, _filter, onEvent) => {
      if (tableId === "asset-types-uuid") assetEvent = onEvent;
      return vi.fn();
    });
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
    render(<MemoryRouter><Sidebar isMobileMenuOpen={false} setIsMobileMenuOpen={vi.fn()} isAdmin={false} onSearchClick={vi.fn()} /></MemoryRouter>);

    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith("asset-types-uuid", { eq: [{ row: "organization_id" }, "org-a"] }, expect.any(Function), expect.any(Function)));
    const initialCalls = mocks.query.mock.calls.length;
    assetEvent({ type: "document_change" });
    await waitFor(() => expect(mocks.query.mock.calls.length).toBeGreaterThan(initialCalls));
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  });
  it("lists one global navigation item for visible copies of the same imported type", async () => {
    mocks.organizationId = "";
    mocks.query.mockImplementation(async (table: string) => table === "docs-flexible-asset-types"
      ? { table_id: "asset-types-uuid", documents: [
        { id: "type-a", data: { name: "Endpoints", source_system: "itglue", source_id: "source-type", organization_id: "org-a" } },
        { id: "type-b", data: { name: "Endpoints", source_system: "itglue", source_id: "source-type", organization_id: "org-b" } },
      ], total: 2 }
      : response(table));
    mocks.subscribe.mockReturnValue(vi.fn());
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
    render(<MemoryRouter><Sidebar isMobileMenuOpen={false} setIsMobileMenuOpen={vi.fn()} isAdmin={false} onSearchClick={vi.fn()} /></MemoryRouter>);

    await waitFor(() => expect(screen.getAllByRole("link", { name: "Endpoints" })).toHaveLength(1));
    expect(screen.getByRole("link", { name: "Endpoints" })).toHaveAttribute("href", "/global/assets/type-a");
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  });

  it("uses an in-flow full-width sidebar inside the mobile dialog", async () => {
    mocks.query.mockImplementation(async (table: string) => response(table));
    mocks.subscribe.mockReturnValue(vi.fn());
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    render(<MemoryRouter><Sidebar isMobileMenuOpen setIsMobileMenuOpen={vi.fn()} isAdmin={false} onSearchClick={vi.fn()} /></MemoryRouter>);

    await waitFor(() => expect(document.querySelector("aside")).not.toBeNull());
    const sidebar = document.querySelector("aside") as HTMLElement;
    expect(sidebar).toHaveClass("docs-shell__sidebar", "docs-shell__sidebar--dialog");
    expect(sidebar).not.toHaveClass("fixed", "w-64");
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  });

  it("keeps verified navigation usable while a same-scope realtime refresh is pending", async () => {
    let assetEvent!: (event: { type: string }) => void;
    let deferTypeRefresh = false;
    let resolveTypeRefresh!: (value: ReturnType<typeof response>) => void;
    mocks.query.mockImplementation((table: string) => {
      if (table === "docs-flexible-asset-types" && deferTypeRefresh) {
        return new Promise((resolve) => { resolveTypeRefresh = resolve; });
      }
      return Promise.resolve(response(table));
    });
    mocks.subscribe.mockImplementation((tableId, _filter, onEvent) => {
      if (tableId === "asset-types-uuid") assetEvent = onEvent;
      return vi.fn();
    });
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
    render(<MemoryRouter><Sidebar isMobileMenuOpen={false} setIsMobileMenuOpen={vi.fn()} isAdmin={false} onSearchClick={vi.fn()} /></MemoryRouter>);

    await screen.findByRole("link", { name: "Endpoints" });
    deferTypeRefresh = true;
    assetEvent({ type: "document_change" });
    await waitFor(() => expect(resolveTypeRefresh).toBeTypeOf("function"), { timeout: 1000 });
    expect(screen.getByRole("link", { name: "Endpoints" })).toBeVisible();
    resolveTypeRefresh(response("docs-flexible-asset-types"));
    Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  });

});
