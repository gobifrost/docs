import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

const scope = vi.hoisted(() => ({ organizationId: "" }));
vi.mock("./layout/useDocsOrganizations", () => ({ useDocsOrganizations: () => scope }));
vi.mock("./DocumentSidebar", () => ({ DocumentSidebar: ({ onSelect, onNavigate }: { onSelect: (id: string | null) => void; onNavigate?: () => void }) => <nav aria-label="Document folders"><button onClick={() => onSelect("folder-1")}>Runbooks</button><button onClick={onNavigate}>Current document</button></nav> }));
import { DocumentWorkspace } from "./DocumentWorkspace";

function Draft() {
  const [value, setValue] = useState("");
  return <input aria-label="Draft content" value={value} onChange={event => setValue(event.target.value)} />;
}
const workspace = () => <MemoryRouter><DocumentWorkspace canWrite><Draft /></DocumentWorkspace></MemoryRouter>;
const originalMedia = window.matchMedia;
const originalWidth = window.innerWidth;
let desktop = true;
let mediaListeners = new Set<() => void>();
function resizeTo(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  desktop = width >= 1024;
  act(() => { mediaListeners.forEach(listener => listener()); });
}
beforeEach(() => {
  mediaListeners = new Set();
  resizeTo(1440);
  window.matchMedia = vi.fn().mockImplementation(() => ({
    get matches() { return desktop; },
    addEventListener: (_: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => mediaListeners.delete(listener),
  }));
});
afterEach(() => { cleanup(); scope.organizationId = ""; localStorage.clear(); window.matchMedia = originalMedia; Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth }); });

describe("document workspace", () => {
  it("preserves an unsaved draft when verified organization navigation becomes available", () => {
    const view = render(workspace());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsaved runbook" } });
    scope.organizationId = "org-1";
    view.rerender(workspace());
    expect(screen.getByRole("navigation", { name: "Document folders" })).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Unsaved runbook");
  });

  it("resizes with the keyboard within readable bounds and retains the chosen width on return", () => {
    scope.organizationId = "org-1";
    const view = render(workspace());
    const resize = screen.getByRole("separator", { name: "Resize document navigation" });
    fireEvent.keyDown(resize, { key: "End" });
    fireEvent.keyDown(resize, { key: "ArrowRight" });
    expect(resize).toHaveAttribute("aria-valuenow", "480");
    fireEvent.keyDown(resize, { key: "Home" });
    fireEvent.keyDown(resize, { key: "ArrowLeft" });
    expect(resize).toHaveAttribute("aria-valuenow", "180");
    fireEvent.keyDown(resize, { key: "ArrowRight" });
    view.unmount();
    render(workspace());
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "200");
  });

  it("opens folders in a mobile dialog, restores trigger focus on dismissal, and keeps the draft", async () => {
    scope.organizationId = "org-1";
    resizeTo(390);
    render(workspace());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsaved runbook" } });
    expect(screen.queryByRole("navigation", { name: "Document folders" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Browse folders" });
    trigger.focus();
    fireEvent.click(trigger);
    const drawer = await screen.findByRole("dialog", { name: "Document folders" });
    expect(within(drawer).getByRole("navigation", { name: "Document folders" })).toBeInTheDocument();
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByRole("textbox")).toHaveValue("Unsaved runbook");
  });

  it("dismisses the drawer after selecting a folder even when the route does not change", async () => {
    scope.organizationId = "org-1";
    resizeTo(768);
    const select = vi.fn();
    render(<MemoryRouter><DocumentWorkspace canWrite selectedFolderId="folder-1" onSelect={select}><Draft /></DocumentWorkspace></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Browse folders" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Runbooks" }));
    expect(select).toHaveBeenCalledWith("folder-1");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("dismisses the drawer when the already selected document is opened", async () => {
    scope.organizationId = "org-1";
    resizeTo(320);
    render(workspace());
    fireEvent.click(screen.getByRole("button", { name: "Browse folders" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Current document" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("reflows an open drawer to desktop navigation without remounting the draft", async () => {
    scope.organizationId = "org-1";
    resizeTo(390);
    render(workspace());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsaved runbook" } });
    fireEvent.click(screen.getByRole("button", { name: "Browse folders" }));
    await screen.findByRole("dialog");
    resizeTo(1440);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("navigation", { name: "Document folders" })).toBeInTheDocument();
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Unsaved runbook");
    resizeTo(390);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Unsaved runbook");
  });

  it("closes the drawer when organization scope changes", async () => {
    scope.organizationId = "org-1";
    resizeTo(390);
    const view = render(workspace());
    fireEvent.click(screen.getByRole("button", { name: "Browse folders" }));
    await screen.findByRole("dialog");
    scope.organizationId = "org-2";
    view.rerender(workspace());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
