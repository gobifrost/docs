import { describe, expect, it } from "vitest";
import { extractHeadings, looksLikeHtml, splitDocumentContent } from "./document-content";

describe("document content blocks", () => {
  it("isolates fenced mermaid while preserving surrounding text", () => {
    expect(splitDocumentContent("Before\n```mermaid\ngraph TD\n  A --> B\n```\nAfter")).toEqual([
      { kind: "text", value: "Before\n" },
      { kind: "mermaid", value: "graph TD\n  A --> B" },
      { kind: "text", value: "\nAfter" },
    ]);
  });

  it("leaves unclosed and non-mermaid fences as plain text", () => {
    expect(splitDocumentContent("```mermaid\ngraph TD\nA --> B")).toEqual([{ kind: "text", value: "```mermaid\ngraph TD\nA --> B" }]);
    expect(splitDocumentContent("```html\n<script>alert(1)</script>\n```")).toEqual([{ kind: "text", value: "```html\n<script>alert(1)</script>\n```" }]);
  });

  it("detects rendered HTML and extracts headings with stable ids", () => {
    expect(looksLikeHtml("<h1>Title</h1><p>Body</p>")).toBe(true);
    expect(looksLikeHtml("Just plain text")).toBe(false);
    expect(extractHeadings("<h1>Title</h1><p>x</p><h2>Sub <em>section</em></h2>")).toEqual([
      { level: 1, text: "Title", id: "doc-heading-1-title" },
      { level: 2, text: "Sub section", id: "doc-heading-2-sub-section" },
    ]);
    expect(extractHeadings("No headings here")).toEqual([]);
  });
});
