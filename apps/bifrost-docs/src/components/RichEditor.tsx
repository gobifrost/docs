import { useEffect, useRef, useState } from "react";
import { Link as TiptapLink } from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import Image from "@tiptap/extension-image";
import StarterKit from "@tiptap/starter-kit";
import { files, tables } from "bifrost";
import {
  Bold,
  Code,
  Columns3,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo,
  Rows3,
  Strikethrough,
  Table as TableIcon,
  Trash2,
  Undo,
  Unlink,
} from "lucide-react";
import { cn } from "@/lib/ds-utils";
import { richImageError } from "@/lib/rich-image";

const MANAGED_IMAGE_REFERENCE = /^bifrost-(?:attachment|pending):[^\s"'<>]+$/;
const MANAGED_ATTACHMENT_REFERENCE = /^bifrost-attachment:([^\s"'<>]+)$/;
const MANAGED_IMAGE_ATTRIBUTE = /\b(?:src|data-src)\s*=\s*(["'])(bifrost-(?:attachment|pending):[^\s"'<>]+)\1/gi;
const MANAGED_IMAGE_PLACEHOLDER = "about:blank#bifrost-image-";

function imagePlaceholder(reference: string) {
  return `${MANAGED_IMAGE_PLACEHOLDER}${encodeURIComponent(reference)}`;
}

function managedImageReferences(html: string) {
  const references = new Set<string>();
  for (const match of html.matchAll(MANAGED_IMAGE_ATTRIBUTE)) references.add(match[2]);
  return references;
}

function editorHtmlForManagedImages(html: string, previews: Map<string, string>) {
  return html.replace(MANAGED_IMAGE_ATTRIBUTE, (_match, quote: string, reference: string) => {
    const preview = previews.get(reference) ?? imagePlaceholder(reference);
    previews.set(reference, preview);
    return `src=${quote}${preview}${quote}`;
  });
}

function serializedManagedImageHtml(html: string, previews: ReadonlyMap<string, string>) {
  let serialized = html;
  for (const [reference, preview] of previews) serialized = serialized.split(preview).join(reference);
  return serialized;
}

function unavailableImageAlt(alt: string | null | undefined) {
  const label = alt?.trim() || "Image";
  return label.endsWith(" — image unavailable") ? label : `${label} — image unavailable`;
}

function revokeObjectUrl(url: string) {
  if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

function replaceEditorImageSource(editor: Editor, previousSource: string, source: string, markUnavailable = false) {
  let transaction = editor.state.tr;
  editor.state.doc.descendants((node, position) => {
    if (node.type.name !== "image" || node.attrs.src !== previousSource) return;
    transaction = transaction.setNodeMarkup(position, node.type, {
      ...node.attrs,
      src: source,
      ...(markUnavailable ? { alt: unavailableImageAlt(node.attrs.alt) } : {}),
    }, node.marks);
  });
  if (transaction.docChanged) editor.view.dispatch(transaction);
}

function ToolButton({
  editor,
  label,
  icon: Icon,
  active,
  disabled,
  onRun,
}: {
  editor: Editor;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active?: boolean;
  disabled?: boolean;
  onRun: () => void;
}) {
  void editor;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active ? "true" : undefined}
      disabled={disabled}
      onClick={onRun}
      className={cn("rich-toolbar-button", active && "is-active")}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function Toolbar({ editor, onImageUpload, imageBusy, imageError, onInsertFile }: { editor: Editor; onImageUpload?: (file: File) => Promise<string>; imageBusy: boolean; imageError: string; onInsertFile: (file: File) => void }) {
  function pickImage() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = (input.files ?? [])[0];
      if (!file || !onImageUpload) return;
      onInsertFile(file);
    };
    input.click();
  }
  function setLink() {
    const previous = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", previous ?? "https://");
    if (url === null) return;
    if (url.trim() === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  }

  return (
    <>
    <div className="rich-toolbar" role="toolbar" aria-label="Formatting">
      <ToolButton editor={editor} label="Undo" icon={Undo} disabled={!editor.can().undo()} onRun={() => editor.chain().focus().undo().run()} />
      <ToolButton editor={editor} label="Redo" icon={Redo} disabled={!editor.can().redo()} onRun={() => editor.chain().focus().redo().run()} />
      <span className="rich-toolbar-separator" aria-hidden="true" />
      <ToolButton editor={editor} label="Heading 1" icon={Heading1} active={editor.isActive("heading", { level: 1 })} onRun={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} />
      <ToolButton editor={editor} label="Heading 2" icon={Heading2} active={editor.isActive("heading", { level: 2 })} onRun={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
      <ToolButton editor={editor} label="Heading 3" icon={Heading3} active={editor.isActive("heading", { level: 3 })} onRun={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} />
      <span className="rich-toolbar-separator" aria-hidden="true" />
      <ToolButton editor={editor} label="Bold" icon={Bold} active={editor.isActive("bold")} onRun={() => editor.chain().focus().toggleBold().run()} />
      <ToolButton editor={editor} label="Italic" icon={Italic} active={editor.isActive("italic")} onRun={() => editor.chain().focus().toggleItalic().run()} />
      <ToolButton editor={editor} label="Strikethrough" icon={Strikethrough} active={editor.isActive("strike")} onRun={() => editor.chain().focus().toggleStrike().run()} />
      <ToolButton editor={editor} label="Inline code" icon={Code} active={editor.isActive("code")} onRun={() => editor.chain().focus().toggleCode().run()} />
      <span className="rich-toolbar-separator" aria-hidden="true" />
      <ToolButton editor={editor} label="Bulleted list" icon={List} active={editor.isActive("bulletList")} onRun={() => editor.chain().focus().toggleBulletList().run()} />
      <ToolButton editor={editor} label="Numbered list" icon={ListOrdered} active={editor.isActive("orderedList")} onRun={() => editor.chain().focus().toggleOrderedList().run()} />
      <ToolButton editor={editor} label="Quote" icon={Quote} active={editor.isActive("blockquote")} onRun={() => editor.chain().focus().toggleBlockquote().run()} />
      <span className="rich-toolbar-separator" aria-hidden="true" />
      <ToolButton editor={editor} label="Set link" icon={Link2} active={editor.isActive("link")} onRun={setLink} />
      <ToolButton editor={editor} label="Remove link" icon={Unlink} onRun={() => editor.chain().focus().unsetLink().run()} />
      <span className="rich-toolbar-separator" aria-hidden="true" />
      <ToolButton editor={editor} label="Insert table" icon={TableIcon} onRun={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} />
      <ToolButton editor={editor} label="Add row" icon={Rows3} onRun={() => editor.chain().focus().addRowAfter().run()} />
      <ToolButton editor={editor} label="Add column" icon={Columns3} onRun={() => editor.chain().focus().addColumnAfter().run()} />
      <ToolButton editor={editor} label="Delete table" icon={Trash2} onRun={() => editor.chain().focus().deleteTable().run()} />
      {onImageUpload && (
        <ToolButton editor={editor} label={imageBusy ? "Uploading image…" : "Insert image"} icon={ImageIcon} onRun={pickImage} />
      )}
    </div>
    {imageError && <p className="rich-image-error" role="alert">{imageError}</p>}
    </>
  );
}

export function RichEditor({
  label,
  value,
  onChange,
  placeholder = "Start writing...",
  onImageUpload,
  organizationId,
}: {
  label: string;
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  onImageUpload?: (file: File) => Promise<string>;
  organizationId?: string;
}) {
  const previewMap = useRef(new Map<string, string>());
  const objectUrls = useRef(new Set<string>());
  const hydrationVersion = useRef(0);
  const previousOrganizationId = useRef(organizationId);
  const suppressUpdate = useRef(false);
  const uploadRef = useRef(onImageUpload);
  const [imageError, setImageError] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  uploadRef.current = onImageUpload;
  const rememberPreview = (reference: string, preview: string) => {
    const previous = previewMap.current.get(reference);
    if (previous && objectUrls.current.delete(previous)) revokeObjectUrl(previous);
    previewMap.current.set(reference, preview);
    objectUrls.current.add(preview);
  };
  const releasePreview = (reference: string) => {
    const preview = previewMap.current.get(reference);
    if (preview && objectUrls.current.delete(preview)) revokeObjectUrl(preview);
    previewMap.current.delete(reference);
  };
  const initialContent = editorHtmlForManagedImages(value, previewMap.current);
  const insertImageFiles = async (view: Editor["view"], files: File[]) => {
    const upload = uploadRef.current;
    if (!upload || !files.length) return;
    const validationError = files.map(richImageError).find((error): error is string => Boolean(error));
    if (validationError) { setImageError(validationError); return; }
    setImageError(""); setImageBusy(true);
    try {
      for (const file of files) {
        const src = await upload(file);
        if (!MANAGED_IMAGE_REFERENCE.test(src)) throw new Error("The image upload did not return a managed attachment reference.");
        // The DOM renders a local preview; onUpdate replaces it with the
        // attachment reference before draft content is persisted.
        const preview = URL.createObjectURL(file);
        rememberPreview(src, preview);
        view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodes.image.create({ src: preview })));
      }
    } catch (uploadError) {
      setImageError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setImageBusy(false);
    }
  };
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
        TiptapLink.configure({ openOnClick: false }),
        Image.configure({ inline: false }),
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        Placeholder.configure({ placeholder }),
      ],
      content: initialContent,
      editable: true,
      immediatelyRender: false,
      onUpdate: ({ editor: updated }) => {
        if (!suppressUpdate.current) onChange(serializedManagedImageHtml(updated.getHTML(), previewMap.current));
      },
      editorProps: {
        attributes: { "aria-label": label },
        handlePaste: (view, event) => {
          if (!uploadRef.current) return false;
          const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
          if (files.length === 0) return false;
          event.preventDefault();
          void insertImageFiles(view, files);
          return true;
        },
      },
    },
    [],
  );

  useEffect(() => {
    if (!editor) return;
    if (previousOrganizationId.current !== organizationId) {
      for (const reference of [...previewMap.current.keys()]) releasePreview(reference);
      previousOrganizationId.current = organizationId;
    }
    if (serializedManagedImageHtml(editor.getHTML(), previewMap.current) !== value && !editor.isFocused) {
      suppressUpdate.current = true;
      editor.commands.setContent(editorHtmlForManagedImages(value, previewMap.current), { emitUpdate: false });
      suppressUpdate.current = false;
    }
    const currentReferences = managedImageReferences(value);
    for (const reference of [...previewMap.current.keys()]) {
      if (!currentReferences.has(reference)) releasePreview(reference);
    }
  }, [editor, organizationId, value]);

  useEffect(() => {
    if (!editor) return;
    const version = hydrationVersion.current + 1;
    hydrationVersion.current = version;
    let active = true;
    const attachmentReferences = [...managedImageReferences(value)].flatMap((reference) => {
      const match = reference.match(MANAGED_ATTACHMENT_REFERENCE);
      return match ? [{ reference, attachmentId: match[1] }] : [];
    });
    const canApply = () => active && hydrationVersion.current === version;
    const unavailable = (reference: string) => {
      if (!canApply()) return;
      const preview = previewMap.current.get(reference);
      if (!preview) return;
      suppressUpdate.current = true;
      replaceEditorImageSource(editor, preview, preview, true);
      suppressUpdate.current = false;
    };
    if (!organizationId) {
      attachmentReferences.forEach(({ reference }) => unavailable(reference));
      return () => { active = false; };
    }
    attachmentReferences.forEach(({ reference, attachmentId }) => {
      const existing = previewMap.current.get(reference);
      if (existing && objectUrls.current.has(existing)) return;
      tables.get("docs-attachments", attachmentId, organizationId).then((row) => {
        const data = row?.data ?? {};
        const path = typeof data.storage_path === "string" ? data.storage_path : "";
        const location = typeof data.storage_location === "string" ? data.storage_location : "";
        if (data.quarantined === true || data.organization_id !== organizationId || !path.startsWith(`${organizationId}/`) || !location) {
          unavailable(reference);
          return undefined;
        }
        return files.download(path, { location, scope: organizationId });
      }).then((blob) => {
        if (!blob || !canApply()) return;
        const previous = previewMap.current.get(reference);
        if (!previous) return;
        const preview = URL.createObjectURL(blob);
        if (!canApply()) { revokeObjectUrl(preview); return; }
        rememberPreview(reference, preview);
        suppressUpdate.current = true;
        replaceEditorImageSource(editor, previous, preview);
        suppressUpdate.current = false;
      }).catch(() => unavailable(reference));
    });
    return () => { active = false; };
  }, [editor, organizationId, value]);

  useEffect(() => {
    if (!editor) return;
    const handleImageDrop = (event: DragEvent) => {
      if (!uploadRef.current) return;
      const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith("image/"));
      if (!files.length) return;
      // Capture before ProseMirror parses the transfer so a local file never
      // becomes a second browser-inserted image alongside the upload result.
      event.preventDefault();
      event.stopImmediatePropagation();
      void insertImageFiles(editor.view, files);
    };
    const dom = editor.view.dom;
    dom.addEventListener("drop", handleImageDrop, true);
    return () => dom.removeEventListener("drop", handleImageDrop, true);
  }, [editor]);

  useEffect(() => {
    return () => {
      hydrationVersion.current += 1;
      objectUrls.current.forEach(revokeObjectUrl);
      objectUrls.current.clear();
      previewMap.current.clear();
    };
  }, []);

  if (!editor) return null;
  return (
    <div className="rich-editor">
      <span className="rich-editor-label" id="rich-editor-label">
        {label}
      </span>
      <Toolbar editor={editor} onImageUpload={onImageUpload} imageBusy={imageBusy} imageError={imageError} onInsertFile={(file) => { void insertImageFiles(editor.view, [file]); }} />
      <EditorContent editor={editor} aria-labelledby="rich-editor-label" />
    </div>
  );
}
