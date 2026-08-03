/**
 * A purpose-built CLAUDE.md scanner.
 *
 * We hand-roll rather than pulling in remark/unified because we need exactly
 * three things — headings, directive-bearing blocks, and `@path` imports — and
 * a line scanner gives us byte-exact positions with zero dependency surface.
 * The one thing we must not get wrong is fenced code blocks: content inside
 * ``` fences is example code, not instructions to Claude, and treating it as a
 * rule is a false-positive factory.
 */

import type { MemoryRule, Position } from "../model/types.js";

const FENCE = /^(\s*)(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/;
/** `@path/to/file.md` import, at the start of a line (optionally in a list). */
const IMPORT = /^\s*(?:[-*+]\s+)?@([^\s`]+)\s*$/;

export interface ScannedMarkdown {
  headings: { text: string; depth: number; position: Position }[];
  blocks: DirectiveBlock[];
  imports: { target: string; position: Position }[];
}

export interface DirectiveBlock {
  text: string;
  position: Position;
  headings: string[];
  kind: "listItem" | "paragraph";
}

export function scanMarkdown(text: string): ScannedMarkdown {
  const lines = text.split(/\r?\n/);
  const headings: ScannedMarkdown["headings"] = [];
  const blocks: DirectiveBlock[] = [];
  const imports: ScannedMarkdown["imports"] = [];

  let fence: string | undefined;
  const headingStack: { depth: number; text: string }[] = [];

  // Paragraph accumulator — consecutive non-blank, non-list lines.
  let paraLines: string[] = [];
  let paraStart = 0;

  const flushParagraph = () => {
    if (paraLines.length === 0) return;
    const joined = paraLines.join(" ").trim();
    if (joined.length > 0) {
      blocks.push({
        text: joined,
        position: { line: paraStart + 1, column: 1, endLine: paraStart + paraLines.length },
        headings: headingStack.map((h) => h.text),
        kind: "paragraph",
      });
    }
    paraLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";

    // --- fenced code blocks: everything inside is inert -----------------
    const fenceMatch = FENCE.exec(raw);
    if (fenceMatch) {
      const marker = fenceMatch[2] ?? "";
      if (fence === undefined) {
        flushParagraph();
        fence = marker[0];
      } else if (marker[0] === fence) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) continue;

    // --- imports --------------------------------------------------------
    const importMatch = IMPORT.exec(raw);
    if (importMatch?.[1]) {
      flushParagraph();
      imports.push({
        target: importMatch[1],
        position: { line: i + 1, column: raw.indexOf("@") + 1 },
      });
      continue;
    }

    // --- headings -------------------------------------------------------
    const headingMatch = HEADING.exec(raw);
    if (headingMatch) {
      flushParagraph();
      const depth = (headingMatch[1] ?? "#").length;
      const htext = stripInline(headingMatch[2] ?? "");
      headings.push({ text: htext, depth, position: { line: i + 1, column: 1 } });
      while (headingStack.length > 0 && (headingStack.at(-1)?.depth ?? 0) >= depth) {
        headingStack.pop();
      }
      headingStack.push({ depth, text: htext });
      continue;
    }

    // --- list items -----------------------------------------------------
    const listMatch = LIST_ITEM.exec(raw);
    if (listMatch?.[2]) {
      flushParagraph();
      const indent = (listMatch[1] ?? "").length;
      blocks.push({
        text: stripInline(listMatch[2]),
        position: { line: i + 1, column: indent + 1 },
        headings: headingStack.map((h) => h.text),
        kind: "listItem",
      });
      continue;
    }

    // --- blank line ends a paragraph ------------------------------------
    if (raw.trim().length === 0) {
      flushParagraph();
      continue;
    }

    if (paraLines.length === 0) paraStart = i;
    paraLines.push(stripInline(raw.trim()));
  }
  flushParagraph();

  return { headings, blocks, imports };
}

/** Strip inline markdown so normalization and display are stable. */
export function stripInline(s: string): string {
  return s
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/__([^_]*)__/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

/**
 * Canonical form used for duplicate/near-duplicate detection.
 * Aggressive on purpose — we want "Always use tabs." and "always use tabs"
 * to collide, because that IS the redundancy we're reporting.
 */
export function normalizeRule(s: string): string {
  return stripInline(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does this block read like an instruction to the model, rather than prose
 * describing the project? Deliberately conservative: a false negative costs us
 * one missed duplicate, a false positive puts noise in front of the user.
 */
const DIRECTIVE_HINT =
  /\b(always|never|must|should|do not|don't|avoid|prefer|use|run|write|ensure|make sure|required|forbidden|only|first|before|after|instead)\b/i;

export function looksDirective(text: string): boolean {
  if (text.length < 8) return false;
  return DIRECTIVE_HINT.test(text);
}

export function toRules(
  scanned: ScannedMarkdown,
  file: string,
  layer: MemoryRule["layer"],
): MemoryRule[] {
  const rules: MemoryRule[] = [];
  for (const block of scanned.blocks) {
    if (!looksDirective(block.text)) continue;
    rules.push({
      text: block.text,
      normalized: normalizeRule(block.text),
      file,
      layer,
      position: block.position,
      headings: block.headings,
    });
  }
  return rules;
}
