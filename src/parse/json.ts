/**
 * Position-preserving JSON(C) parsing.
 *
 * We deliberately do NOT use JSON.parse: it discards positions (so findings
 * can't be anchored to a line, and GitHub Action annotations are impossible)
 * and it rejects comments and trailing commas, which people genuinely do put
 * in settings.local.json and .mcp.json.
 */

import {
  findNodeAtLocation,
  parseTree,
  parse as parseJsonc,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser";

import type { Diagnostic, Position } from "../model/types.js";

export interface ParsedJson {
  file: string;
  text: string;
  value: Record<string, unknown> | undefined;
  root: Node | undefined;
  errors: Diagnostic[];
  /** Cached newline offsets for O(log n) offset → line/col conversion. */
  lineStarts: number[];
}

export function parseJsonFile(file: string, text: string): ParsedJson {
  const parseErrors: ParseError[] = [];
  const value = parseJsonc(text, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as Record<string, unknown> | undefined;

  const root = parseTree(text, [], {
    allowTrailingComma: true,
    disallowComments: false,
  });

  const lineStarts = computeLineStarts(text);

  const errors: Diagnostic[] = parseErrors.map((e) => ({
    ruleId: "json/parse-error",
    severity: "error" as const,
    message: `Malformed JSON: ${printParseErrorCode(e.error)}.`,
    file,
    position: offsetToPosition(lineStarts, e.offset, e.length),
  }));

  return { file, text, value, root, errors, lineStarts };
}

/**
 * Find the source position of a dotted path within a parsed file.
 * Returns undefined when the path is absent — callers fall back to the file
 * position rather than inventing a line number.
 */
export function positionOf(parsed: ParsedJson, path: string): Position | undefined {
  if (!parsed.root) return undefined;
  const segments = toSegments(path);
  const node = findNodeAtLocation(parsed.root, segments);
  if (!node) return undefined;
  return offsetToPosition(parsed.lineStarts, node.offset, node.length);
}

/** Position of the *key* rather than the value — nicer for annotations. */
export function keyPositionOf(parsed: ParsedJson, path: string): Position | undefined {
  if (!parsed.root) return undefined;
  const segments = toSegments(path);
  const node = findNodeAtLocation(parsed.root, segments);
  if (!node) return undefined;
  const property = node.parent;
  if (property?.type === "property" && property.children?.[0]) {
    const keyNode = property.children[0];
    return offsetToPosition(parsed.lineStarts, keyNode.offset, keyNode.length);
  }
  return offsetToPosition(parsed.lineStarts, node.offset, node.length);
}

function toSegments(path: string): (string | number)[] {
  return path
    .split(".")
    .filter((s) => s.length > 0)
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

export function offsetToPosition(
  lineStarts: number[],
  offset: number,
  length = 0,
): Position {
  const start = locate(lineStarts, offset);
  const end = locate(lineStarts, offset + length);
  return {
    line: start.line,
    column: start.column,
    offset,
    endLine: end.line,
    endColumn: end.column,
  };
}

function locate(lineStarts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - (lineStarts[lo] ?? 0) + 1 };
}
