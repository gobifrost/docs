import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RichEditor } from "./RichEditor";

const managedImageMocks = vi.hoisted(() => ({
  get: vi.fn(),
  download: vi.fn(),
}));

vi.mock("bifrost", () => ({
  tables: { get: managedImageMocks.get },
  files: { download: managedImageMocks.download },
}));

describe("RichEditor", () => {
  afterEach(cleanup);

  beforeEach(() => {
    managedImageMocks.get.mockReset();
    managedImageMocks.download.mockReset();
  });

  it("renders the toolbar and initial content", async () => {
    const onChange = vi.fn();
    render(<RichEditor label="Content" value="<p>Hello <strong>world</strong></p>" onChange={onChange} />);

    expect(await screen.findByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
    expect(await screen.findByText("world")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Insert table" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Insert image" })).not.toBeInTheDocument();
  });

  it("offers image upload only when an uploader is provided", async () => {
    const onChange = vi.fn();
    const onImageUpload = vi.fn().mockResolvedValue("bifrost-attachment:img-1");
    render(<RichEditor label="Content" value="<p>Hi</p>" onChange={onChange} onImageUpload={onImageUpload} />);

    expect(await screen.findByRole("button", { name: "Insert image" })).toBeInTheDocument();
  });

  it("uploads pasted image files through the uploader", async () => {
    const onChange = vi.fn();
    const onImageUpload = vi.fn().mockResolvedValue("bifrost-attachment:pasted-1");
    const createObjectURL = vi.fn(() => "blob:mock-preview");
    const original = URL.createObjectURL;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    try {
      const { container } = render(
        <RichEditor label="Content" value="<p>Paste target</p>" onChange={onChange} onImageUpload={onImageUpload} />,
      );

      const editable = await screen.findByText("Paste target");
      const file = new File(["fake-png-bytes"], "screenshot.png", { type: "image/png" });
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { files: [file], types: ["Files"], getData: () => "" },
      });
      fireEvent(editable.closest(".tiptap") ?? editable, paste);

      await waitFor(() => expect(onImageUpload).toHaveBeenCalledWith(file));
      expect(container.querySelector('img[src^="blob:"]')).not.toBeNull();
    } finally {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: original });
    }
  });

  it("keeps a local upload preview when the controlled parent rerenders while the editor is blurred", async () => {
    const onImageUpload = vi.fn().mockResolvedValue("bifrost-attachment:pasted-1");
    const createObjectURL = vi.fn(() => "blob:controlled-preview");
    const original = URL.createObjectURL;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    function ControlledEditor() {
      const [value, setValue] = useState("<p>Paste target</p>");
      return <RichEditor label="Content" value={value} onChange={setValue} onImageUpload={onImageUpload} />;
    }
    try {
      const { container } = render(<ControlledEditor />);
      const target = (await screen.findByText("Paste target")).closest(".tiptap")!;
      fireEvent.blur(target);
      const file = new File(["fake-png-bytes"], "screenshot.png", { type: "image/png" });
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", { value: { files: [file], types: ["Files"], getData: () => "" } });
      fireEvent(target, paste);

      await waitFor(() => expect(onImageUpload).toHaveBeenCalledWith(file));
      await waitFor(() => expect(container.querySelector('img[src="blob:controlled-preview"]')).not.toBeNull());
      expect(container.querySelector('img[src="bifrost-attachment:pasted-1"]')).toBeNull();
    } finally {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: original });
    }
  });

  it("hydrates managed images through scoped metadata and serializes the attachment reference", async () => {
    managedImageMocks.get.mockResolvedValue({ id: "image-1", data: { organization_id: "org-1", storage_path: "org-1/itglue/documents/doc-1/image-1/network.png", storage_location: "docs-attachments" } });
    managedImageMocks.download.mockResolvedValue(new Blob(["image-bytes"], { type: "image/png" }));
    const onChange = vi.fn();
    const createObjectURL = vi.fn(() => "blob:hydrated-preview");
    const revokeObjectURL = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    try {
      const { container, unmount } = render(<RichEditor label="Content" organizationId="org-1" value={'<p>Diagram</p><img src="bifrost-attachment:image-1" alt="Network map">'} onChange={onChange} />);
      await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
      const image = container.querySelector("img")!;
      expect(image).not.toHaveAttribute("src", "bifrost-attachment:image-1");

      await waitFor(() => expect(image).toHaveAttribute("src", "blob:hydrated-preview"));
      expect(managedImageMocks.get).toHaveBeenCalledWith("docs-attachments", "image-1", "org-1");
      expect(managedImageMocks.download).toHaveBeenCalledWith("org-1/itglue/documents/doc-1/image-1/network.png", { location: "docs-attachments", scope: "org-1" });

      fireEvent.click(screen.getByRole("button", { name: "Insert table" }));
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      const serialized = String(onChange.mock.calls.at(-1)?.[0]);
      expect(serialized).toContain('src="bifrost-attachment:image-1"');
      expect(serialized).not.toContain("blob:hydrated-preview");
      expect(serialized).not.toContain("data:image/");

      unmount();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:hydrated-preview");
    } finally {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate });
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevoke });
    }
  });

  it("keeps quarantined or foreign managed images unavailable without downloading them", async () => {
    managedImageMocks.get.mockResolvedValue({ id: "image-1", data: { organization_id: "org-2", quarantined: true, storage_path: "org-2/secret.png", storage_location: "docs-attachments" } });
    const { container } = render(<RichEditor label="Content" organizationId="org-1" value={'<p><img src="bifrost-attachment:image-1" alt="Network map"></p>'} onChange={vi.fn()} />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const image = container.querySelector("img")!;
    await waitFor(() => expect(image).toHaveAttribute("alt", "Network map — image unavailable"));
    expect(image).not.toHaveAttribute("src", "bifrost-attachment:image-1");
    expect(managedImageMocks.get).toHaveBeenCalledWith("docs-attachments", "image-1", "org-1");
    expect(managedImageMocks.download).not.toHaveBeenCalled();
    expect(container.querySelector('img[src^="bifrost-"]')).toBeNull();
  });

  it("uploads a dropped image once through the uploader", async () => {
    const onChange = vi.fn();
    const onImageUpload = vi.fn().mockResolvedValue("bifrost-attachment:dropped-1");
    const createObjectURL = vi.fn(() => "blob:dropped-preview");
    const original = URL.createObjectURL;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    try {
      const { container } = render(<RichEditor label="Content" value="<p>Drop target</p>" onChange={onChange} onImageUpload={onImageUpload} />);
      const target = (await screen.findByText("Drop target")).closest(".tiptap")!;
      const originalElementFromPoint = document.elementFromPoint;
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
      const file = new File(["fake-png-bytes"], "dropped.png", { type: "image/png" });
      const drop = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: { files: [file], types: ["Files"], getData: () => "" } });
      fireEvent(target, drop);

      await waitFor(() => expect(onImageUpload).toHaveBeenCalledTimes(1));
      expect(onImageUpload).toHaveBeenCalledWith(file);
      expect(container.querySelectorAll('img[src^="blob:"]')).toHaveLength(1);
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: originalElementFromPoint });
    } finally {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: original });
    }
  });

  it("rejects unsafe dropped images before upload", async () => {
    const onImageUpload = vi.fn().mockResolvedValue("bifrost-attachment:svg-1");
    render(<RichEditor label="Content" value="<p>Drop target</p>" onChange={vi.fn()} onImageUpload={onImageUpload} />);
    const target = (await screen.findByText("Drop target")).closest(".tiptap")!;
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    const file = new File(["<svg />"], "unsafe.svg", { type: "image/svg+xml" });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [file], types: ["Files"], getData: () => "" } });
    try {
      fireEvent(target, drop);
      expect(await screen.findByRole("alert")).toHaveTextContent("PNG, JPEG, GIF, WebP, or AVIF");
      expect(onImageUpload).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: originalElementFromPoint });
    }
  });

  it("ignores pastes without image files", async () => {
    const onChange = vi.fn();
    const onImageUpload = vi.fn().mockResolvedValue("bifrost-attachment:pasted-1");
    render(<RichEditor label="Content" value="<p>Hi</p>" onChange={onChange} onImageUpload={onImageUpload} />);

    const editable = await screen.findByText("Hi");
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [], types: [], getData: () => "" } });
    fireEvent(editable.closest(".tiptap") ?? editable, paste);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onImageUpload).not.toHaveBeenCalled();
  });
});
