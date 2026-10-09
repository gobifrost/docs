import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOrgNameMap } from "./useOrgNameMap";

const mocks = vi.hoisted(() => ({ state: { organizations: [] as Array<{ id: string; name: string }>, loading: true } }));
vi.mock("./useDocsOrganizations", () => ({ useDocsOrganizations: () => mocks.state }));

function Consumer() {
  return <output aria-label="organization names">{JSON.stringify(useOrgNameMap())}</output>;
}

afterEach(() => { cleanup(); mocks.state = { organizations: [], loading: true }; });
beforeEach(() => { mocks.state = { organizations: [], loading: true }; });

describe("useOrgNameMap", () => {
  it("returns only the customer organization supplied by the shared Docs scope", () => {
    mocks.state = { organizations: [{ id: "customer-a", name: "Customer A" }], loading: false };

    render(<Consumer />);

    expect(screen.getByLabelText("organization names")).toHaveTextContent('{"customer-a":"Customer A"}');
  });

  it("clears old provider names while the shared directory is loading", () => {
    mocks.state = { organizations: [{ id: "org-a", name: "Old customer" }], loading: false };
    const view = render(<Consumer />);
    expect(screen.getByLabelText("organization names")).toHaveTextContent('{"org-a":"Old customer"}');

    mocks.state = { organizations: [{ id: "org-a", name: "Old customer" }], loading: true };
    view.rerender(<Consumer />);
    expect(screen.getByLabelText("organization names")).toHaveTextContent("{}");

    mocks.state = { organizations: [{ id: "org-b", name: "Current customer" }], loading: false };
    view.rerender(<Consumer />);
    expect(screen.getByLabelText("organization names")).toHaveTextContent('{"org-b":"Current customer"}');
  });
});
