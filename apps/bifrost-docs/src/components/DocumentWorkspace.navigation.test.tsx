import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scope: { organizationId: "org-1", viewerId: "viewer-1", selected: { id: "org-1", name: "Northern Star" } },
  query: vi.fn(),
}));
vi.mock("bifrost", () => ({ tables: { query: mocks.query }, useWorkflowMutation: () => ({ mutate: vi.fn() }) }));
vi.mock("./layout/useDocsOrganizations", () => ({ useDocsOrganizations: () => mocks.scope }));
vi.mock("@/lib/table-realtime", () => ({ useTableInvalidations: vi.fn() }));
import { DocumentWorkspace } from "./DocumentWorkspace";

const folders = [
  { id: "runbooks", data: { name: "Runbooks", parent_id: "" } },
  { id: "network", data: { name: "Network", parent_id: "runbooks" } },
];
const documents = [
  { id: "wifi", data: { name: "Wi-Fi setup", folder_id: "network" } },
  { id: "audit", data: { name: "Audit checklist", folder_id: "" } },
];
const media = window.matchMedia;
const width = window.innerWidth;
let desktop = false;
let listeners = new Set<() => void>();
function resize(value: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value });
  desktop = value >= 1024;
  act(() => listeners.forEach(listener => listener()));
}
function workspace(path = "/org/org-1/documents") {
  return <MemoryRouter initialEntries={[path]}><DocumentWorkspace canWrite><input aria-label="Draft content" defaultValue="Unsaved content" /></DocumentWorkspace></MemoryRouter>;
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Browse folders" }));
  const drawer = await screen.findByRole("dialog", { name: "Document folders" });
  await within(drawer).findByRole("textbox", { name: "Filter documents" });
  await waitFor(() => expect(drawer.querySelector('[aria-label="Document tree"]')).toHaveAttribute("aria-busy", "false"));
  return drawer;
}
async function close(drawer: HTMLElement) {
  fireEvent.keyDown(drawer, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Document folders" })).not.toBeInTheDocument());
}
beforeEach(() => {
  listeners = new Set();
  mocks.scope = { organizationId: "org-1", viewerId: "viewer-1", selected: { id: "org-1", name: "Northern Star" } };
  mocks.query.mockReset().mockImplementation(async (table: string) => ({ documents: table === "docs-document-folders" ? folders : documents }));
  resize(390);
  window.matchMedia = vi.fn().mockImplementation(() => ({ get matches() { return desktop; }, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) }));
});
afterEach(() => { cleanup(); localStorage.clear(); window.matchMedia = media; Object.defineProperty(window, "innerWidth", { configurable: true, value: width }); });

describe("document navigation choices across responsive mounts", () => {
  it("keeps the filter when the phone drawer is dismissed and reopened", async () => {
    render(workspace());
    let drawer = await open();
    fireEvent.change(within(drawer).getByRole("textbox", { name: "Filter documents" }), { target: { value: "wi-fi" } });
    await close(drawer);
    drawer = await open();
    expect(within(drawer).getByRole("textbox", { name: "Filter documents" })).toHaveValue("wi-fi");
    expect(within(drawer).getByRole("button", { name: "Wi-Fi setup" })).toBeVisible();
    expect(within(drawer).queryByRole("button", { name: "Audit checklist" })).not.toBeInTheDocument();
  });

  it("keeps a manually collapsed selected-document ancestor when reopening", async () => {
    render(workspace("/org/org-1/documents/wifi"));
    let drawer = await open();
    fireEvent.click(within(drawer).getByRole("button", { name: "Collapse Network" }));
    await close(drawer);
    drawer = await open();
    expect(within(drawer).getByRole("button", { name: "Expand Network" })).toBeVisible();
    expect(within(drawer).queryByRole("button", { name: "Wi-Fi setup" })).not.toBeInTheDocument();
  });

  it("keeps filtering and the underlying collapse choices through phone and desktop transitions", async () => {
    resize(1440);
    render(workspace());
    await screen.findByRole("button", { name: "Wi-Fi setup" });
    fireEvent.click(screen.getByRole("button", { name: "Collapse Network" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse Runbooks" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Filter documents" }), { target: { value: "wi-fi" } });
    resize(390);
    const drawer = await open();
    expect(within(drawer).getByRole("textbox", { name: "Filter documents" })).toHaveValue("wi-fi");
    resize(1440);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Filter documents" })).toHaveValue("wi-fi");
    fireEvent.change(screen.getByRole("textbox", { name: "Filter documents" }), { target: { value: "" } });
    expect(await screen.findByRole("button", { name: "Expand Runbooks" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Expand Runbooks" }));
    expect(screen.getByRole("button", { name: "Expand Network" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Draft content" })).toHaveValue("Unsaved content");
  });

  it.each(["organizationId", "viewerId"] as const)("closes the drawer and resets private choices when %s changes", async key => {
    const view = render(workspace());
    const drawer = await open();
    fireEvent.change(within(drawer).getByRole("textbox", { name: "Filter documents" }), { target: { value: "audit" } });
    mocks.scope = { ...mocks.scope, [key]: "new-scope" };
    view.rerender(workspace());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const reopened = await open();
    expect(within(reopened).getByRole("textbox", { name: "Filter documents" })).toHaveValue("");
    expect(within(reopened).getByRole("button", { name: "Wi-Fi setup" })).toBeVisible();
  });
});
