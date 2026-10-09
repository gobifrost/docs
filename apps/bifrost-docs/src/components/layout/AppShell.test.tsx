import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./useDocsOrganizations", () => ({
  DocsOrganizationsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./Sidebar", () => ({
  Sidebar: ({ onSearchClick }: { onSearchClick: () => void }) => <button type="button" onClick={onSearchClick}>Search catalog</button>,
}));
vi.mock("./Header", () => ({
  Header: ({ searchOpen }: { searchOpen: boolean }) => <div data-testid="search-dialog" data-open={searchOpen} />,
}));

import { AppShell } from "./AppShell";

afterEach(cleanup);

describe("Docs shell search", () => {
  it("opens catalog search with Control or Command K", () => {
    render(<AppShell isAdmin={false}>Content</AppShell>);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(screen.getByTestId("search-dialog")).toHaveAttribute("data-open", "true");
  });
});
