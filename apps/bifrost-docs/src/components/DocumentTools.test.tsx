import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentTools } from "./DocumentTools";
import { Dialog } from "radix-ui";

type ResizeCallback = (entries: Array<{ contentRect: { width: number } }>) => void;
let resize: ResizeCallback | undefined;
class Observer {
  constructor(callback: ResizeCallback) { resize = callback; }
  observe() {}
  disconnect() {}
}
const tools = [
  { id: "attachments", title: "Attachments", icon: null, dock: true, content: <p>guide.pdf</p> },
  { id: "related", title: "Related items", icon: null, dock: true, content: <p>Edge firewall</p> },
  { id: "contents", title: "On this page", icon: null, content: <a href="#setup">Setup</a> },
];
const renderReader = () => {
  vi.stubGlobal("ResizeObserver", Observer);
  return render(<DocumentTools tools={tools} leadingAction={<button>Back to documents</button>}><input aria-label="Unsaved document" defaultValue="Local draft" /></DocumentTools>);
};
const width = (value: number) => act(() => resize?.([{ contentRect: { width: value } }]));
afterEach(() => { cleanup(); resize = undefined; vi.unstubAllGlobals(); });

describe("document supporting cards", () => {
  it("shows both supporting cards in a wide gutter, with contents kept optional", () => {
    renderReader(); width(960);
    const gutter = screen.getByRole("complementary", { name: "Document details" });
    expect(within(gutter).getByRole("region", { name: "Attachments" })).toHaveTextContent("guide.pdf");
    expect(within(gutter).getByRole("region", { name: "Related items" })).toHaveTextContent("Edge firewall");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "On this page" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to documents" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Unsaved document" })).toHaveValue("Local draft");
  });

  it("lets readers hide and reopen a card, restoring focus to its compact control", async () => {
    renderReader(); width(960);
    fireEvent.click(screen.getByRole("button", { name: "Close Attachments" }));
    expect(screen.queryByRole("region", { name: "Attachments" })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Attachments" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    const card = await screen.findByRole("region", { name: "Attachments" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(card).toHaveFocus());
    fireEvent.keyDown(card, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Attachments" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(screen.getByRole("region", { name: "Related items" })).toBeVisible();
  });

  it("uses the actual reader width to replace cards with one drawer while preserving document edits", async () => {
    renderReader(); width(960);
    const input = screen.getByRole("textbox", { name: "Unsaved document" });
    fireEvent.change(input, { target: { value: "Keep these changes" } });
    width(959);
    expect(screen.queryByRole("complementary", { name: "Document details" })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Attachments" });
    trigger.focus(); fireEvent.click(trigger);
    const drawer = await screen.findByRole("dialog", { name: "Attachments" });
    expect(drawer).toHaveClass("document-tools__drawer");
    expect(screen.getByRole("textbox", { name: "Unsaved document", hidden: true })).toBe(input);
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    width(960);
    expect(screen.getByRole("textbox", { name: "Unsaved document" })).toBe(input);
    expect(input).toHaveValue("Keep these changes");
    expect(screen.getAllByText("guide.pdf")).toHaveLength(1);
  });

  it("keeps a dismissed card dismissed after the layout adapts", () => {
    renderReader(); width(960);
    fireEvent.click(screen.getByRole("button", { name: "Close Attachments" }));
    width(800); width(960);
    expect(screen.queryByRole("region", { name: "Attachments" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Related items" })).toBeVisible();
  });

  it("routes Escape to a confirmation above a card without dismissing that card", () => {
    vi.stubGlobal("ResizeObserver", Observer);
    const cancel = vi.fn(event => event.preventDefault());
    render(<DocumentTools tools={[{ ...tools[0], content: <dialog open onCancel={cancel}><button>Cancel deletion</button></dialog> }]}><p>Article</p></DocumentTools>);
    width(960);
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel deletion" }), { key: "Escape" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "Attachments" })).toBeVisible();
  });

  it("lets a nested relationship dialog handle Escape while its supporting card stays open", async () => {
    vi.stubGlobal("ResizeObserver", Observer);
    render(<DocumentTools tools={[{ ...tools[1], content: <Dialog.Root defaultOpen><Dialog.Portal><Dialog.Content aria-describedby={undefined}><Dialog.Title>Add related item</Dialog.Title><button>Choose record</button></Dialog.Content></Dialog.Portal></Dialog.Root> }]}><p>Article</p></DocumentTools>);
    width(960);
    const dialog = await screen.findByRole("dialog", { name: "Add related item" });
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Choose record" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add related item" })).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "Related items" })).toBeVisible();
  });
});
