export type DocumentContentBlock =
  | { kind: "text"; value: string }
  | { kind: "mermaid"; value: string };
export type DocumentHeading = { level: number; text: string; id: string };

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "section";
}

/** Extract h1–h3 headings from rendered HTML for the table of contents. */
export function extractHeadings(html: string): DocumentHeading[] {
  const headings: DocumentHeading[] = [];
  const matcher = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = matcher.exec(html)) !== null) {
    index += 1;
    headings.push({
      level: Number(match[1]),
      text: match[2].replace(/<[^>]*>/g, "").trim().slice(0, 120) || `Section ${index}`,
      id: `doc-heading-${index}-${slugify(match[2])}`,
    });
  }
  return headings;
}

/** True when the stored content is HTML rather than plain text. */
export function looksLikeHtml(content: string): boolean {
  return /<(p|div|h[1-6]|ul|ol|li|table|blockquote|pre|br|hr)[\s>]/.test(content);
}

/**
 * Extract only complete, language-tagged Mermaid fences. All other content
 * remains literal text and is rendered by React without HTML interpretation.
 */
export function splitDocumentContent(content: string): DocumentContentBlock[] {
  const blocks: DocumentContentBlock[] = [];
  const matcher = /```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n```/gi;
  let offset = 0;
  for (const match of content.matchAll(matcher)) {
    const start = match.index ?? 0;
    if (start > offset) blocks.push({ kind: "text", value: content.slice(offset, start) });
    blocks.push({ kind: "mermaid", value: match[1] });
    offset = start + match[0].length;
  }
  if (offset < content.length || !blocks.length) blocks.push({ kind: "text", value: content.slice(offset) });
  return blocks.filter((block) => block.value.length > 0);
}
