export type MarkdownInline =
  | { type: "text"; value: string }
  | { type: "strong"; value: string; children: MarkdownInline[] }
  | { type: "emphasis"; value: string; children: MarkdownInline[] }
  | { type: "code"; value: string }
  | { type: "link"; url: string; value: string; children: MarkdownInline[] }
  | { type: "image"; url: string; value: string }
  | { type: "mention"; url: string; value: string };

export type MarkdownTableAlignment = "left" | "center" | "right" | null;

export type MarkdownBlock =
  | { type: "rule" }
  | { type: "paragraph"; inlines: MarkdownInline[] }
  | { type: "heading"; level: number; inlines: MarkdownInline[] }
  | { type: "quote"; inlines: MarkdownInline[] }
  | { type: "list"; ordered: boolean; start: number; items: MarkdownInline[][] }
  | { type: "code"; language: string | null; code: string; closed: boolean }
  | { type: "table"; alignments: MarkdownTableAlignment[]; header: MarkdownInline[][]; rows: MarkdownInline[][][] };

type InlineSpan = {
  start: number;
  end: number;
  content: string;
  kind: "strong" | "emphasis" | "link" | "code" | "image" | "mention";
  url?: string;
};

function isWordCharacter(value: string | undefined) {
  return value !== undefined && /[A-Za-z0-9]/.test(value);
}

function findInlineCode(value: string, startAt: number): InlineSpan | null {
  for (let index = startAt; index < value.length; index += 1) {
    if (value[index] !== "`" || value[index - 1] === "\\") continue;
    let openingEnd = index;
    while (value[openingEnd] === "`") openingEnd += 1;
    const runLength = openingEnd - index;
    let cursor = openingEnd;
    while (cursor < value.length) {
      if (value[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      let closingEnd = cursor;
      while (value[closingEnd] === "`") closingEnd += 1;
      if (closingEnd - cursor === runLength) {
        return { start: index, end: closingEnd, content: value.slice(openingEnd, cursor), kind: "code" };
      }
      cursor = closingEnd;
    }
    index = openingEnd - 1;
  }
  return null;
}

function findInlineLink(value: string, startAt: number): InlineSpan | null {
  let start = value.indexOf("[", startAt);
  while (start >= 0) {
    if (value[start - 1] === "\\") {
      start = value.indexOf("[", start + 1);
      continue;
    }
    const labelEnd = value.indexOf("](", start + 1);
    if (labelEnd < 0) return null;
    const urlStart = labelEnd + 2;
    let urlEnd = urlStart;
    let depth = 1;
    for (; urlEnd < value.length; urlEnd += 1) {
      if (value[urlEnd - 1] === "\\") continue;
      if (value[urlEnd] === "(") depth += 1;
      if (value[urlEnd] === ")") depth -= 1;
      if (depth === 0) break;
    }
    if (depth !== 0) return null;
    const url = value.slice(urlStart, urlEnd).trim();
    const content = value.slice(start + 1, labelEnd);
    // `@[label](cohub://…)` is a Space/Skill mention; `![alt](url)` is an image. Both share the link syntax.
    const prefix = value[start - 1];
    const isMention = prefix === "@" && url.startsWith("cohub://");
    const isImage = prefix === "!" && /^(https?:\/\/|\/|data:image\/)/.test(url);
    const isLink = /^(https?:\/\/|\/|cohub:\/\/)/.test(url);
    if (isMention) return { start: start - 1, end: urlEnd + 1, content, kind: "mention", url };
    if (isImage) return { start: start - 1, end: urlEnd + 1, content, kind: "image", url };
    if (isLink) return { start, end: urlEnd + 1, content, kind: "link", url };
    start = value.indexOf("[", start + 1);
  }
  return null;
}

function findInlineEmphasis(value: string, startAt: number): InlineSpan | null {
  for (let index = startAt; index < value.length; index += 1) {
    const marker = value[index];
    if (marker !== "*" && marker !== "_") continue;
    if (value[index - 1] === "\\") continue;

    const isBold = marker === "*" && value[index + 1] === "*";
    const markerLength = isBold ? 2 : 1;
    if (marker === "*" && !isBold && (value[index - 1] === "*" || value[index + 1] === "*")) continue;
    if (marker === "_" && (value[index - 1] === "_" || value[index + 1] === "_" || isWordCharacter(value[index - 1]))) continue;

    const contentStart = index + markerLength;
    if (!value[contentStart] || /\s/.test(value[contentStart])) continue;
    const closingMarker = marker.repeat(markerLength);
    let closing = value.indexOf(closingMarker, contentStart);
    while (closing >= 0) {
      if (value[closing - 1] === "\\") {
        closing = value.indexOf(closingMarker, closing + markerLength);
        continue;
      }
      const content = value.slice(contentStart, closing);
      const lastContentCharacter = content[content.length - 1];
      const closingAfter = value[closing + markerLength];
      const validEnd = Boolean(content) && !/\s/.test(lastContentCharacter ?? "") &&
        !(marker === "_" && (closingAfter === "_" || isWordCharacter(closingAfter))) &&
        !(marker === "*" && !isBold && (value[closing - 1] === "*" || closingAfter === "*"));
      if (validEnd) {
        return { start: index, end: closing + markerLength, content, kind: isBold ? "strong" : "emphasis" };
      }
      closing = value.indexOf(closingMarker, closing + markerLength);
    }
  }
  return null;
}

function findAutoLink(value: string, startAt: number): InlineSpan | null {
  const pattern = /https?:\/\/[^\s<>"`*\[\]，。！？；：、]+/gi;
  pattern.lastIndex = startAt;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    const start = match.index;
    if (start > 0 && /[\w/@]/.test(value[start - 1]!)) continue;
    let url = match[0].replace(/[.,!?;:]+$/, "");
    while (url.endsWith(")") && url.split(")").length > url.split("(").length) url = url.slice(0, -1);
    url = url.replace(/[.,!?;:]+$/, "");
    try {
      if (!new URL(url).hostname) continue;
    } catch {
      continue;
    }
    const bracketed = value[start - 1] === "<" && value[start + url.length] === ">";
    return { start: bracketed ? start - 1 : start, end: start + url.length + (bracketed ? 1 : 0), content: url, kind: "link", url };
  }
  return null;
}

function earliestSpan(spans: (InlineSpan | null)[]) {
  let next: InlineSpan | null = null;
  for (const span of spans) {
    if (!span) continue;
    if (!next || span.start < next.start) next = span;
  }
  return next;
}

export function parseInlineMarkdown(value: string, links = true): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let text = "";
  let cursor = 0;
  const flushText = () => {
    if (text) {
      nodes.push({ type: "text", value: text });
      text = "";
    }
  };

  while (cursor < value.length) {
    // Code spans win ties against emphasis/link markers starting at the same offset.
    const next = earliestSpan([findInlineCode(value, cursor), findInlineEmphasis(value, cursor), links ? findInlineLink(value, cursor) : null, links ? findAutoLink(value, cursor) : null]);
    if (!next) {
      text += value.slice(cursor);
      break;
    }
    if (next.start > cursor) text += value.slice(cursor, next.start);
    flushText();
    if (next.kind === "link") nodes.push({ type: "link", url: next.url!, value: next.content, children: next.content === next.url ? [{ type: "text", value: next.content }] : parseInlineMarkdown(next.content, false) });
    else if (next.kind === "image" || next.kind === "mention") nodes.push({ type: next.kind, url: next.url!, value: next.content });
    else if (next.kind === "strong" || next.kind === "emphasis") nodes.push({ type: next.kind, value: next.content, children: parseInlineMarkdown(next.content, links) });
    else nodes.push({ type: next.kind, value: next.content });
    cursor = next.end;
  }
  flushText();
  return nodes;
}

/** Split a GFM table row on unescaped pipes, dropping the optional outer pipes. */
export function splitMarkdownTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && value[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function parseTableDelimiterRow(line: string): MarkdownTableAlignment[] | null {
  const cells = splitMarkdownTableRow(line);
  if (cells.length === 0) return null;
  const alignments: MarkdownTableAlignment[] = [];
  for (const cell of cells) {
    const match = /^(:)?(-+)(:)?$/.exec(cell);
    if (!match) return null;
    alignments.push(match[1] && match[3] ? "center" : match[1] ? "left" : match[3] ? "right" : null);
  }
  return alignments;
}

export function parseMarkdown(value: string): MarkdownBlock[] {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;
  let codeLanguage = "";
  let list: { ordered: boolean; start: number; items: MarkdownInline[][] } | null = null;

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push({ type: "paragraph", inlines: parseInlineMarkdown(text) });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: "list", ordered: list.ordered, start: list.start, items: list.items });
    list = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = (code !== null ? /^\s*```\s*$/ : /^\s*```\s*([^\s`]*)?\s*$/).exec(line);
    if (fence) {
      if (code !== null) {
        blocks.push({ type: "code", language: codeLanguage || null, code: code.join("\n"), closed: true });
        code = null;
        codeLanguage = "";
      } else {
        flushParagraph();
        flushList();
        code = [];
        codeLanguage = fence[1] ?? "";
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }

    if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ type: "rule" });
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: heading[1]!.length, inlines: parseInlineMarkdown(heading[2]!) });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push({ type: "quote", inlines: parseInlineMarkdown(quote[1]!) });
      continue;
    }

    const alignments = index + 1 < lines.length ? parseTableDelimiterRow(lines[index + 1] ?? "") : null;
    if (alignments && line.includes("|")) {
      const headerCells = splitMarkdownTableRow(line);
      if (headerCells.length === alignments.length) {
        flushParagraph();
        flushList();
        const rows: MarkdownInline[][][] = [];
        let cursor = index + 2;
        while (cursor < lines.length) {
          const rowLine = lines[cursor] ?? "";
          if (!rowLine.trim() || !rowLine.includes("|")) break;
          const cells = splitMarkdownTableRow(rowLine);
          rows.push(alignments.map((_, cellIndex) => parseInlineMarkdown(cells[cellIndex] ?? "")));
          cursor += 1;
        }
        blocks.push({ type: "table", alignments, header: headerCells.map((cell) => parseInlineMarkdown(cell)), rows });
        index = cursor - 1;
        continue;
      }
    }

    const item = /^\s*(?:[-*+]\s+|([0-9]+)[.)]\s+)(.+)$/.exec(line);
    if (item) {
      const ordered = Boolean(item[1]);
      if (!list || list.ordered !== ordered) {
        flushParagraph();
        flushList();
        list = { ordered, start: ordered ? Number(item[1]) : 1, items: [] };
      }
      list.items.push(parseInlineMarkdown(item[2]!));
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }

  if (code !== null) blocks.push({ type: "code", language: codeLanguage || null, code: code.join("\n"), closed: false });
  flushParagraph();
  flushList();
  return blocks;
}

export type MarkdownMedia = { type: "image" | "video"; url: string };

export function markdownMedia(block: MarkdownBlock): MarkdownMedia[] {
  const media = new Map<string, MarkdownMedia>();
  const visit = (nodes: MarkdownInline[]) => {
    for (const node of nodes) {
      if (node.type === "strong" || node.type === "emphasis") {
        visit(node.children);
        continue;
      }
      if (node.type !== "link" && node.type !== "image") continue;
      let url: URL;
      try {
        url = new URL(node.url);
      } catch {
        continue;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      const extension = url.pathname.split(".").pop()?.toLowerCase();
      const type = ["m4v", "mov", "mp4", "ogv", "webm"].includes(extension ?? "") ? "video"
        : node.type === "image" || ["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(extension ?? "") ? "image" : null;
      if (type) media.set(node.url, { type, url: node.url });
    }
  };
  if ("inlines" in block) visit(block.inlines);
  else if (block.type === "list") block.items.forEach(visit);
  else if (block.type === "table") [block.header, ...block.rows].forEach((row) => row.forEach(visit));
  return [...media.values()];
}

export function markdownInlineText(node: MarkdownInline): string {
  return "children" in node ? node.children.map(markdownInlineText).join("") : node.value;
}

/** Stable identity lets streaming renderers memoize completed blocks. */
export function markdownBlockSignature(block: MarkdownBlock) {
  return JSON.stringify(block);
}
