import "@testing-library/jest-dom/vitest";
import { createElement, Fragment } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFolderTree, canMoveFolder, DocumentSidebar } from "./DocumentSidebar";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutate: vi.fn(),
  invalidate: () => {},
  accessLost: () => {},
  organization: { organizationId: "org-acme", selected: { id: "org-acme", name: "Acme" } as { id: string; name: string } | null },
}));

vi.mock("bifrost", () => ({
  tables: { query: mocks.query },
  useWorkflowMutation: (reference: string) => ({
    mutate: (values: unknown) => mocks.mutate(reference, values),
  }),
}));

vi.mock("@/components/layout/useDocsOrganizations", () => ({
  useDocsOrganizations: () => mocks.organization,
}));

vi.mock("@/lib/table-realtime", () => ({
  useTableInvalidations: (_ids: string[], _scope: string | null, invalidate: () => void, accessLost: () => void) => {
    mocks.invalidate = invalidate;
    mocks.accessLost = accessLost;
  },
}));

const folders = [
  { id: "folder-runbooks", data: { name: "Runbooks", parent_id: "" } },
  { id: "folder-network", data: { name: "Network", parent_id: "folder-runbooks" } },
  { id: "folder-operations", data: { name: "Operations", parent_id: "" } },
];
const documents = [
  { id: "document-network", data: { name: "Network runbook", folder_id: "folder-runbooks", source_system: "bifrost", status: "draft" } },
  { id: "document-wifi", data: { name: "Wi-Fi setup", folder_id: "folder-network", source_system: "bifrost", status: "draft" } },
  { id: "document-audit", data: { name: "Audit checklist", folder_id: "", source_system: "bifrost", status: "draft" } },
];

function renderSidebar() {
  return render(createElement(
    MemoryRouter,
    { initialEntries: ["/org/org-acme/documents"] },
    createElement(Fragment, null,
      createElement(DocumentSidebar, { selectedFolderId: null, onSelect: vi.fn(), canWrite: true }),
      createElement(LocationProbe),
    ),
  ));
}

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return createElement(Fragment, null,
    createElement("output", { "data-testid": "location" }, location.pathname),
    createElement("button", { onClick: () => navigate("/org/org-acme/documents/document-wifi") }, "Open nested document directly"),
  );
}

afterEach(() => {
  cleanup();
  mocks.query.mockReset();
  mocks.mutate.mockReset();
  mocks.organization = { organizationId: "org-acme", selected: { id: "org-acme", name: "Acme" } };
});

describe("document folder tree helpers", () => {
  it("keeps cyclic and orphaned folders reachable without creating recursive children", () => {
    const roots = buildFolderTree([
      { id: "a", name: "Alpha", parentId: "b" },
      { id: "b", name: "Beta", parentId: "a" },
      { id: "orphan", name: "Orphan", parentId: "missing" },
      { id: "root", name: "Root", parentId: "" },
      { id: "child", name: "Child", parentId: "root" },
    ]);

    expect(roots.map((node) => node.id)).toEqual(["a", "b", "orphan", "root"]);
    expect(roots.find((node) => node.id === "root")?.children.map((node) => node.id)).toEqual(["child"]);
  });

  it("does not allow a folder to move into itself or one of its descendants", () => {
    const rows = [
      { id: "parent", name: "Parent", parentId: "" },
      { id: "child", name: "Child", parentId: "parent" },
      { id: "other", name: "Other", parentId: "" },
    ];

    expect(canMoveFolder(rows, "parent", "parent")).toBe(false);
    expect(canMoveFolder(rows, "parent", "child")).toBe(false);
    expect(canMoveFolder(rows, "parent", "other")).toBe(true);
  });
});

describe("DocumentSidebar document navigation", () => {
  function mockDocumentTree() {
    mocks.query.mockImplementation((table: string) => Promise.resolve({
      documents: table === "docs-document-folders" ? folders : documents,
    }));
  }

  it("shows scoped documents in folders and filters by document title", async () => {
    mockDocumentTree();
    renderSidebar();

    expect(await screen.findByRole("button", { name: "Network runbook" })).toBeInTheDocument();
    expect(mocks.query).toHaveBeenCalledWith("docs-documents", expect.objectContaining({
      where: { organization_id: "org-acme" },
    }));

    fireEvent.change(screen.getByLabelText("Filter documents"), { target: { value: "audit" } });

    expect(screen.getByRole("button", { name: "Audit checklist" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Network runbook" })).not.toBeInTheDocument();
  });

  it("does not query folders or documents until an organization is selected", async () => {
    mocks.organization = { organizationId: "", selected: null };
    renderSidebar();

    expect(await screen.findByText("Choose an organization to browse its document tree.")).toBeInTheDocument();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("ignores an old organization response after the selected organization changes", async () => {
    type QueryResult = { documents: Array<{ id: string; data: Record<string, unknown> }> };
    const oldResolvers: Array<(value: QueryResult) => void> = [];
    mocks.organization = { organizationId: "org-old", selected: { id: "org-old", name: "Old" } };
    mocks.query.mockImplementation((_table: string, params: { where?: { organization_id?: string } }) => {
      if (params.where?.organization_id === "org-old") return new Promise((resolve) => oldResolvers.push(resolve));
      return Promise.resolve({ documents: _table === "docs-document-folders" ? [{ id: "folder-new", data: { name: "New folder", parent_id: "" } }] : [{ id: "document-new", data: { name: "New document", folder_id: "folder-new" } }] });
    });
    const view = renderSidebar();

    mocks.organization = { organizationId: "org-new", selected: { id: "org-new", name: "New" } };
    view.rerender(createElement(MemoryRouter, { initialEntries: ["/org/org-new/documents"] }, createElement(DocumentSidebar, { selectedFolderId: null, onSelect: vi.fn(), canWrite: true })));
    expect(await screen.findByRole("button", { name: "New document" })).toBeInTheDocument();

    const oldFolderPage = Array.from({ length: 200 }, (_, index) => ({ id: `old-folder-${index}`, data: { name: `Old folder ${index}`, parent_id: "" } }));
    const oldDocumentPage = Array.from({ length: 200 }, (_, index) => ({ id: `old-document-${index}`, data: { name: `Old document ${index}`, folder_id: "" } }));
    oldResolvers.forEach((resolve, index) => resolve({ documents: index === 0 ? oldFolderPage : oldDocumentPage }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Network runbook" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "New document" })).toBeInTheDocument();
    expect(mocks.query.mock.calls.filter(([, params]) => params.where?.organization_id === "org-old")).toHaveLength(2);
  });

  it("keeps documents in nested folders instead of flattening them into their parent", async () => {
    mockDocumentTree();
    renderSidebar();

    expect(await screen.findByRole("button", { name: "Wi-Fi setup" })).toBeInTheDocument();
  });

  it("reveals matching documents through collapsed ancestors and restores the previous collapse after filtering", async () => {
    mockDocumentTree();
    renderSidebar();
    fireEvent.click(await screen.findByRole("button", { name: "Collapse Runbooks" }));

    fireEvent.change(screen.getByLabelText("Filter documents"), { target: { value: "wi-fi" } });
    expect(screen.getByRole("button", { name: "Wi-Fi setup" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Network runbook" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter documents"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Expand Runbooks" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Wi-Fi setup" })).not.toBeInTheDocument();
  });

  it("filters unrelated nested branches while keeping a matching folder's entire subtree available", async () => {
    mocks.query.mockImplementation((table: string) => Promise.resolve({
      documents: table === "docs-document-folders"
        ? [...folders, { id: "folder-archive", data: { name: "Archive", parent_id: "folder-runbooks" } }]
        : documents,
    }));
    renderSidebar();
    await screen.findByRole("button", { name: "Archive" });

    fireEvent.change(screen.getByLabelText("Filter documents"), { target: { value: "wi-fi" } });
    expect(screen.getByRole("button", { name: "Network" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter documents"), { target: { value: "runbooks" } });
    expect(screen.getByRole("button", { name: "Network runbook" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Wi-Fi setup" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
  });

  it("preserves a child's collapsed state when its parent closes and reopens", async () => {
    mockDocumentTree();
    renderSidebar();
    fireEvent.click(await screen.findByRole("button", { name: "Collapse Network" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse Runbooks" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand Runbooks" }));

    expect(screen.getByRole("button", { name: "Expand Network" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Wi-Fi setup" })).not.toBeInTheDocument();
  });

  it("reveals the active document's ancestors after navigation outside the tree", async () => {
    mockDocumentTree();
    renderSidebar();
    fireEvent.click(await screen.findByRole("button", { name: "Collapse Network" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse Runbooks" }));
    fireEvent.click(screen.getByRole("button", { name: "Open nested document directly" }));

    expect(await screen.findByRole("button", { name: "Wi-Fi setup" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Collapse Runbooks" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Collapse Network" })).toHaveAttribute("aria-expanded", "true");
    // Manual collapse still works while that document remains active.
    fireEvent.click(screen.getByRole("button", { name: "Collapse Runbooks" }));
    expect(screen.queryByRole("button", { name: "Wi-Fi setup" })).not.toBeInTheDocument();
  });

  it("scrolls the selected document inside the tree without scrolling the page", async () => {
    mockDocumentTree();
    const rectangle = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = this.getAttribute("aria-current") === "page" ? 300 : 0;
      const height = this.classList.contains("document-sidebar__tree") ? 100 : 32;
      return { x: 0, y: top, top, bottom: top + height, left: 0, right: 240, width: 240, height, toJSON: () => ({}) };
    });
    const pageScroll = vi.spyOn(window, "scrollTo");
    try {
      renderSidebar();
      await screen.findByRole("button", { name: "Wi-Fi setup" });
      fireEvent.click(screen.getByRole("button", { name: "Open nested document directly" }));

      await waitFor(() => expect(screen.getByLabelText("Document tree").scrollTop).toBeGreaterThan(0));
      expect(pageScroll).not.toHaveBeenCalled();
    } finally { rectangle.mockRestore(); pageScroll.mockRestore(); }
  });

  it("shows an explicit empty result when no folder or document matches the filter", async () => {
    mockDocumentTree();
    renderSidebar();
    await screen.findByRole("button", { name: "Runbooks" });
    fireEvent.change(screen.getByLabelText("Filter documents"), { target: { value: "no matching title" } });

    const tree = within(screen.getByLabelText("Document tree"));
    expect(tree.getByRole("status")).toHaveTextContent("No folders or documents match.");
    fireEvent.change(screen.getByLabelText("Filter documents"), { target: { value: "" } });
    expect(tree.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Wi-Fi setup" })).toBeInTheDocument();
  });

  it("opens an organization-scoped document route from the sidebar", async () => {
    mockDocumentTree();
    renderSidebar();

    fireEvent.click(await screen.findByRole("button", { name: "Network runbook" }));

    expect(screen.getByTestId("location")).toHaveTextContent("/org/org-acme/documents/document-network");
  });

  it("moves a document with an accessible menu without loading its body separately", async () => {
    mockDocumentTree();
    renderSidebar();

    await screen.findByRole("button", { name: "Network runbook" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for Network runbook" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Operations" }));

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith(
      "functions/authoring.py::docs_update_draft",
      { document_id: "document-network", folder_id: "folder-operations" },
    ));
  });

  it("keeps imported-item provenance quiet until the item is moved", async () => {
    mocks.query.mockImplementation((table: string) => Promise.resolve({
      documents: table === "docs-document-folders" ? folders : documents.map((document) => document.id === "document-network"
        ? { ...document, data: { ...document.data, source_system: "itglue" } }
        : document),
    }));
    renderSidebar();

    await screen.findByRole("button", { name: "Network runbook" });
    expect(screen.queryByText("This imported item may be updated by its source.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Actions for Network runbook" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Operations" }));

    expect(await screen.findByText("This imported item may be updated by its source.")).toBeInTheDocument();
  });

  it("puts folder rename and move actions in an accessible compact menu", async () => {
    mockDocumentTree();
    renderSidebar();

    await screen.findByRole("button", { name: "Runbooks" });
    expect(screen.queryByRole("button", { name: "Rename Runbooks" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move Runbooks" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Actions for Runbooks" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename folder" }));

    expect(screen.getByLabelText("Rename Runbooks")).toBeInTheDocument();
  });

  it("preserves an unsaved folder rename through pending and completed background refresh", async () => {
    mockDocumentTree();
    renderSidebar();
    await screen.findByRole("button", { name: "Runbooks" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for Runbooks" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename folder" }));
    const editor = screen.getByRole("textbox", { name: "Rename Runbooks" });
    fireEvent.change(editor, { target: { value: "Unsaved folder name" } });
    const pending: Array<() => void> = [];
    mocks.query.mockImplementation((table: string) => new Promise(resolve => pending.push(() => resolve({ documents: table === "docs-document-folders" ? folders : documents }))));

    act(() => mocks.invalidate());
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(screen.getByLabelText("Document tree")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("textbox", { name: "Rename Runbooks" })).toBe(editor);
    expect(editor).toHaveValue("Unsaved folder name");
    expect(screen.getByRole("button", { name: "Wi-Fi setup" })).toBeInTheDocument();
    await act(async () => { pending.forEach(resolve => resolve()); });
    expect(screen.getByLabelText("Document tree")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("textbox", { name: "Rename Runbooks" })).toBe(editor);
    expect(editor).toHaveValue("Unsaved folder name");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "Rename Runbooks" })).not.toBeInTheDocument();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("clears loaded folder names and editors on access loss, including a late refresh response", async () => {
    mockDocumentTree();
    renderSidebar();
    await screen.findByRole("button", { name: "Runbooks" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for Runbooks" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename folder" }));
    const pending: Array<() => void> = [];
    mocks.query.mockImplementation((table: string) => new Promise(resolve => pending.push(() => resolve({ documents: table === "docs-document-folders" ? folders : documents }))));
    act(() => mocks.invalidate());
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => mocks.accessLost());
    expect(screen.queryByRole("textbox", { name: "Rename Runbooks" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Runbooks" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Wi-Fi setup" })).not.toBeInTheDocument();
    await act(async () => { pending.forEach(resolve => resolve()); });
    expect(screen.queryByRole("button", { name: "Runbooks" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Wi-Fi setup" })).not.toBeInTheDocument();
  });

  it("keeps folder creation in the compact top toolbar", async () => {
    mockDocumentTree();
    renderSidebar();
    await screen.findByRole("button", { name: "Runbooks" });
    const create = screen.getByRole("button", { name: "New folder" });
    expect(create.closest(".document-sidebar__header")).not.toBeNull();
    expect(create.textContent).toBe("");
    fireEvent.click(create);
    expect(screen.getByRole("textbox", { name: "New folder" }).closest(".document-sidebar__header")).not.toBeNull();
  });

  it("keeps the document tree in its own scroll region", async () => {
    mockDocumentTree();
    renderSidebar();

    await screen.findByRole("button", { name: "Network runbook" });
    expect(screen.getByLabelText("Document tree")).toContainElement(screen.getByRole("button", { name: "Network runbook" }));
  });

  it("moves a dragged folder through the existing scoped folder workflow", async () => {
    mockDocumentTree();
    renderSidebar();

    const source = await screen.findByRole("button", { name: "Runbooks" });
    const destination = screen.getByRole("button", { name: "Operations" });
    const transfer = {
      types: ["application/x-bifrost-docs-sidebar"],
      effectAllowed: "",
      setData: vi.fn(),
      getData: vi.fn(() => JSON.stringify({ kind: "folder", id: "folder-runbooks" })),
    };
    fireEvent.dragStart(source, { dataTransfer: transfer });
    fireEvent.dragOver(destination, { dataTransfer: transfer });
    expect(destination.parentElement).toHaveAttribute("data-drop-active", "true");
    fireEvent.drop(destination, { dataTransfer: transfer });

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith(
      "functions/folders.py::docs_move_document_folder",
      { folder_id: "folder-runbooks", parent_id: "folder-operations" },
    ));
  });
});
