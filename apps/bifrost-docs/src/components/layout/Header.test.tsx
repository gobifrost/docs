import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bifrost", () => ({
  BifrostHeader: ({ title, logo, action, className }: { title: string; logo?: string | null; action?: React.ReactNode; className?: string }) => (
    <header data-testid="bifrost-header" data-logo={logo === null ? "none" : "default"} className={className}>
      <span>{title}</span>
      {action}
    </header>
  ),
}));
vi.mock("./OrgSelector", () => ({ OrgSelector: () => <button type="button">Global View</button> }));
vi.mock("./SearchDialog", () => ({ SearchDialog: ({ open }: { open: boolean }) => <div data-testid="search-dialog" data-open={open} /> }));
vi.mock("./RecentDropdown", () => ({ RecentDropdown: () => <button type="button">Recently viewed</button> }));

import { Header } from "./Header";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Docs SDK header", () => {
  it("uses one Docs SDK header and keeps the organization scope available at narrow widths", () => {
    render(<MemoryRouter><Header onMobileMenuToggle={vi.fn()} searchOpen={false} onSearchOpenChange={vi.fn()} /></MemoryRouter>);

    expect(screen.getByTestId("bifrost-header")).toHaveTextContent("Docs");
    expect(screen.getByTestId("bifrost-header")).toHaveAttribute("data-logo", "none");
    expect(screen.getByRole("button", { name: "Global View" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
  });
});
